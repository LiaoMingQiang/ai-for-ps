/**
 * Helper 进程入口。
 *
 * 启动顺序：单实例锁 → 数据库（含迁移与回滚）→ 各存储 → Provider → 作业引擎
 *          → HTTP + WS → 恢复未完成任务。
 * 任何一步失败都要把原因写进日志并以非零码退出，不留一个"看起来在跑"的半死进程。
 */

/**
 * 关掉 node:sqlite 的 ExperimentalWarning。
 *
 * 它每次启动都往 stderr 打两行。平时无所谓，但安装器会把 Helper 子进程的输出
 * 原样写进 install.log —— 用户装完打开日志，第一眼看到的是 "Warning"，
 * 会以为哪里装坏了，然后来问一个根本不存在的问题。
 *
 * 我们清楚自己在用这个实验特性，Node 版本也钉死了，这行提示对用户没有任何价值。
 * 只滤掉 ExperimentalWarning，别的警告照常打出来 —— 那些是真要看的。
 */
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name !== 'ExperimentalWarning') console.warn(w.stack ?? String(w));
});

import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { PSAI_VERSION } from '@psai/shared';
import { loadConfig } from './config.js';
import type { HelperConfig } from './config.js';
import { Logger } from './log.js';
import { openDb } from './db.js';
import { SettingsStore } from './settings.js';
import { CredentialStore } from './credentials.js';
import { PairingService } from './pairing.js';
import { AssetStore } from './assets.js';
import { PromptStore } from './prompts.js';
import { WorkflowStore } from './workflows/store.js';
import { ProviderManager } from './providers/manager.js';
import { JobEngine } from './jobs/engine.js';
import { EventHub } from './events.js';
import { buildServer } from './server.js';
import { readGpuInfo } from './gpu.js';

export interface StartedHelper {
  cfg: HelperConfig;
  url: string;
  stop: () => Promise<void>;
  /** 恢复流程的完成信号。stop() 会等它，避免关库时恢复还在写。 */
  recovered: Promise<void>;
  /** 测试用：拿一个可用 token，免去走配对流程 */
  issueToken: () => string;
}

function acquireLock(cfg: HelperConfig, log: Logger): boolean {
  if (cfg.ephemeral) return true;
  if (existsSync(cfg.lockPath)) {
    try {
      const pid = Number(readFileSync(cfg.lockPath, 'utf8').trim());
      if (Number.isFinite(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
          log.error(`已有 Helper 实例在运行（pid ${pid}），本次启动退出`);
          return false;
        } catch {
          log.warn(`发现陈旧的锁文件（pid ${pid} 已不存在），接管`);
        }
      }
    } catch {
      /* 锁文件损坏，直接接管 */
    }
  }
  writeFileSync(cfg.lockPath, String(process.pid), 'utf8');
  return true;
}

function releaseLock(cfg: HelperConfig): void {
  if (cfg.ephemeral) return;
  try {
    if (existsSync(cfg.lockPath) && readFileSync(cfg.lockPath, 'utf8').trim() === String(process.pid)) {
      unlinkSync(cfg.lockPath);
    }
  } catch {
    /* noop */
  }
}

/**
 * 打成单文件 exe（Node SEA）之后代码是 CJS，`import.meta.url` 是 undefined，
 * 直接 fileURLToPath 会在启动第一步就崩。所以这里三级兜底：
 * ESM 的 import.meta.url → CJS 的 __dirname → 退到 exe 所在目录。
 */
function selfDir(): string | null {
  try {
    const url = import.meta.url as string | undefined;
    if (url) return dirname(fileURLToPath(url));
  } catch {
    /* CJS 下取不到，继续往下 */
  }
  const cjsDir = (globalThis as { __dirname?: string }).__dirname;
  if (typeof cjsDir === 'string' && cjsDir) return cjsDir;
  return null;
}

/** 是否运行在打包后的单文件 exe 里。 */
function isPackaged(): boolean {
  return selfDir() === null;
}

function builtinWorkflowsDir(): string {
  const env = process.env['PSAI_WORKFLOWS_DIR'];
  if (env) return env;
  const here = selfDir();
  // 开发：packages/helper/dist → psai/workflows
  if (here) return resolve(here, '../../../workflows');
  // 打包：workflows/ 就放在 exe 旁边
  return resolve(dirname(process.execPath), 'workflows');
}

export async function startHelper(overrides: Partial<HelperConfig> = {}): Promise<StartedHelper> {
  const cfg = loadConfig(overrides);
  const log = new Logger(cfg.logsDir, (process.env['PSAI_LOG_LEVEL'] as 'info') ?? 'info');

  log.info(`AI for PS Helper ${PSAI_VERSION} 启动中`, { dataDir: cfg.dataDir, port: cfg.port });

  if (!acquireLock(cfg, log)) {
    throw new Error('已有 Helper 实例在运行');
  }

  const { db, fromVersion, toVersion, backupPath } = openDb(cfg.dbPath, cfg.backupsDir, log);

  const settings = new SettingsStore(db);
  const credentials = new CredentialStore(db, log);
  const pairing = new PairingService(db);
  const assets = new AssetStore(db, cfg.assetsDir);
  const prompts = new PromptStore(db);
  const workflows = new WorkflowStore(db, log);
  const events = new EventHub(pairing, log);
  const providers = new ProviderManager(settings, credentials, log);
  const jobs = new JobEngine(db, log, assets, settings, prompts, workflows, providers, events);

  const seedResult = workflows.seedBuiltins(builtinWorkflowsDir());
  log.info('内置工作流播种完成', seedResult);

  const gpu = readGpuInfo(true);
  log.info('GPU', gpu.available ? { name: gpu.name, vramTotalMb: gpu.vramTotalMb } : { reason: gpu.reason });

  const app = await buildServer({
    cfg,
    log,
    db,
    settings,
    credentials,
    pairing,
    assets,
    prompts,
    workflows,
    providers,
    jobs,
    events,
    startedAt: Date.now(),
    migration: { fromVersion, toVersion, backupPath }
  });

  await app.listen({ host: cfg.host, port: cfg.port });
  const server = app.server;
  events.attach(server as unknown as ReturnType<typeof createServer>);

  /*
   * 端口以**实际绑上的**为准，不是以配置里写的为准。
   * 配 0 的时候由系统分配一个空闲端口（测试要的就是这个：写死端口时，
   * 上一次跑崩留下的进程会一直占着，后面每次跑都报 EADDRINUSE）。
   * 配置里写死的端口这里拿到的就是同一个值，行为不变。
   *
   * 拿不到就**当场报错**，绝不退回 cfg.port。
   *
   * 这里踩过一次，而且极难查：老代码在 address() 返回 null 时退回
   * cfg.port —— 而测试里 cfg.port 就是 0。于是 url 成了
   * `http://127.0.0.1:0`，Helper 看起来"启动成功"，直到某个调用方
   * 拿这个地址发请求，undici 抛一句 `bad port`。
   * 那条报错出现在三层之外的某个用例里，跟真正的原因毫无关系 ——
   * 表现是一批本来无关的用例集体变红，而且只在并发跑的时候偶尔出现。
   *
   * 一个起不来的 Helper 应该在这里就说清楚，而不是发一个坏地址出去。
   */
  const addr = server.address();
  const boundPort = addr && typeof addr === 'object' ? addr.port : NaN;
  if (!Number.isInteger(boundPort) || boundPort <= 0 || boundPort > 65535) {
    await app.close().catch(() => undefined);
    throw new Error(
      `Helper 监听成功了，却拿不到实际绑定的端口（server.address() = ${JSON.stringify(addr)}）——` +
        `无法给出可用地址，已中止启动。`
    );
  }
  cfg.port = boundPort;

  const url = `http://${cfg.host === '0.0.0.0' ? '127.0.0.1' : cfg.host}:${boundPort}`;
  log.info(`Helper 已就绪 ${url}`);

  /*
   * 启动就探一次 ComfyUI，否则 /v1/health 在有人主动测试之前一直报"离线"，
   * 面板状态条会对着一个其实好好的 ComfyUI 亮红灯。
   *
   * probeOnStart=false（临时实例）时整段跳过 —— 见 config.ts 里的说明：
   * 新数据目录的默认地址就是用户本机真实 ComfyUI 的地址，
   * 几十个测试 Helper 一起去敲它，既不可靠也不礼貌。
   */
  const probed = cfg.probeOnStart
    ? providers
        .probe('comfyui')
        .then((s) => {
          log.info('ComfyUI 探测', { online: s.online, baseUrl: s.baseUrl, reason: s.reason });
        })
        .catch(() => undefined)
    : Promise.resolve(undefined);

  // 已配置的云 Provider 也预热一遍，把模型列表拉回缓存。
  // 不然重启之后设置页会退回「尚未拉取模型」，看起来像密钥没保存住。
  const warmed = cfg.probeOnStart ? providers.warmupCloud().catch(() => undefined) : Promise.resolve(undefined);

  // 恢复未完成的任务（先查远端，不重复提交）。
  // 不阻塞启动，但要留下句柄：关闭时必须等它跑完，否则会对着已关闭的数据库写。
  const recovered = Promise.all([
    probed,
    warmed,
    jobs.recover().then(
      () => undefined,
      (e: unknown) => {
        log.error('任务恢复失败', String(e));
      }
    )
  ]).then(() => undefined);

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    log.info('Helper 正在关闭');
    await recovered;
    jobs.stop();
    events.close();
    providers.dispose();
    await app.close();
    db.close();
    releaseLock(cfg);
  };

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      void stop().then(() => process.exit(0));
    });
  }
  process.on('uncaughtException', (e) => {
    log.error('未捕获异常', String(e));
  });
  process.on('unhandledRejection', (e) => {
    log.error('未处理的 Promise 拒绝', String(e));
  });

  return {
    cfg,
    url,
    stop,
    recovered,
    issueToken: () => {
      const { challenge } = pairing.request('test');
      const res = pairing.confirm(challenge);
      if ('error' in res) throw new Error(res.error);
      return res.token;
    }
  };
}

/**
 * 直接执行时启动。
 * 打包成 exe 时没有 import.meta.url 可比，进程存在的唯一目的就是跑 Helper，直接起。
 * 被测试 import 时既不是 packaged 也不是入口脚本，不会自启。
 */
function shouldAutoStart(): boolean {
  if (isPackaged()) return true;
  const here = selfDir();
  if (!here || !process.argv[1]) return false;
  const entry = resolve(process.argv[1]);
  return entry === resolve(here, 'index.js') || entry === resolve(here, 'index.ts');
}

/**
 * 安装器要用的子命令。
 *
 * 打包出来的 AI-for-PS-Helper.exe 平时的职责是「跑服务」，但安装/卸载时
 * 还要干一件 NSIS 干不了的事：把插件登记进 Photoshop 的 PluginsInfo/v1/PS.json。
 * 那是一份同时列着用户所有 UXP 插件的 JSON，只能用真正的 JSON 解析去合并。
 *
 * 复用同一个 exe 而不是再发一个小工具：安装包里少一个文件、少一份版本要对齐，
 * 而且用户机器上本来就不需要装 Node —— 这个 exe 自己就是运行时。
 *
 * 必须排在 shouldAutoStart() 前面：跑子命令的时候绝不能顺手把服务也起起来，
 * 否则安装过程中会多出一个没人管的后台进程，端口还被占着。
 */
async function runCli(argv: string[]): Promise<boolean> {
  const cmd = argv[0];
  if (!cmd || !cmd.startsWith('--')) return false;

  const { installPlugin, uninstallPlugin, uxpRoot } = await import('./uxp-install.js');
  const { appendFileSync, mkdirSync } = await import('node:fs');

  /**
   * 两条输出通道，分工是有原因的。
   *
   * stdout **只写 ASCII**：NSIS 用 nsExec 抓子进程输出，抓到的字节按系统 ANSI
   * 代码页解码。Node 在 Windows 上往管道写的是 UTF-8，于是中文一路变成乱码，
   * 最后原样落进 install.log —— 用户打开日志看到一堆问号，出了问题也没法把
   * 有用的信息发给我们。所以给 NSIS 看的行一律是 `PLUGIN-INSTALL-OK <id> <ver>`
   * 这种机器可读的 ASCII。
   *
   * 详细中文说明写进自己的 UTF-8 日志文件，编码由我们自己说了算，不经过 NSIS。
   */
  const logDir = join(process.env['LOCALAPPDATA'] ?? homedir(), 'AIforPS', 'logs');
  const logFile = join(logDir, 'plugin-install.log');
  try {
    mkdirSync(logDir, { recursive: true });
  } catch {
    /* 建不了目录就只走 stdout，不能因为日志写不下去就装不了插件 */
  }
  const detail = (line: string): void => {
    try {
      appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`, 'utf8');
    } catch {
      /* noop */
    }
  };
  /** 给 NSIS 看的：ASCII，一行一个结论 */
  const status = (line: string): void => {
    console.log(line);
    detail(line);
  };

  detail(`==== ${cmd} ${argv.slice(1).join(' ')} ====`);

  switch (cmd) {
    case '--version':
      console.log(PSAI_VERSION);
      return true;

    case '--uxp-root':
      console.log(uxpRoot());
      return true;

    case '--install-plugin': {
      const dir = argv[1];
      if (!dir) throw new Error('usage: --install-plugin <plugin-dir>');
      const r = installPlugin({ sourceDir: dir, log: detail });
      status(`PLUGIN-INSTALL-OK ${r.pluginId} ${r.version}`);
      status(`  path=${r.installedPath}`);
      status(`  removedOldDirs=${r.removedDirs.length} keptOtherPlugins=${r.keptOtherEntries}`);
      status(`  detail-log=${logFile}`);
      return true;
    }

    case '--uninstall-plugin': {
      const id = argv[1];
      if (!id) throw new Error('usage: --uninstall-plugin <plugin-id>');
      const r = uninstallPlugin({ pluginId: id, log: detail });
      status(`PLUGIN-UNINSTALL-OK ${r.pluginId}`);
      status(`  removedDirs=${r.removedDirs.length} removedEntries=${r.removedEntries} keptOtherPlugins=${r.keptOtherEntries}`);
      status(`  detail-log=${logFile}`);
      return true;
    }

    default:
      throw new Error(`unknown option: ${cmd}`);
  }
}

/**
 * 系统里配了代理吗（环境变量口径，和 curl 一致）。
 *
 * 只看 https/http/all，不看 NO_PROXY —— 后者是"哪些地址不走代理"，
 * 由 Node 自己处理（本机 127.0.0.1 默认就在里面，所以本地 ComfyUI 不受影响）。
 */
function envProxy(): string | null {
  for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) {
    const v = process.env[k];
    if (v && v.trim()) return v.trim();
  }
  return null;
}

/**
 * 配了代理却没启用代理支持时，带着开关把自己重启一遍。
 *
 * 为什么必须这么做：Node 的 fetch（undici）**不认** HTTP_PROXY / HTTPS_PROXY
 * 这些环境变量，curl 认。于是在一台配了代理的机器上：
 *   curl https://ai.comfly.org/v1/models   → 1 秒，HTTP 401（只是缺 key）
 *   Node fetch 同一个地址                  → 10 秒后 UND_ERR_CONNECT_TIMEOUT
 * 界面上只会显示一句「无法连接到服务地址：fetch failed」——
 * 用户会以为是 Key 填错了、或者平台挂了，然后把时间全花在错的地方。
 * 实测就是这么发生的：设置页拉不到模型，生成页的闭源模型一个都选不了。
 *
 * Node 24 提供了 `NODE_USE_ENV_PROXY=1`，但它在**启动时**就被读走，
 * 进程内 `process.env.x = '1'` 没有任何作用（试过）。所以只能重启自己。
 *
 * 用重启而不是"要求用户加环境变量启动"：装完双击就该能用，
 * 不该要求用户知道这件事。exe 和 `node dist/index.js` 两条路都走得通，
 * 因为 spawn 的是 process.execPath + 原样的 argv。
 *
 * PSAI_PROXY_REEXEC 是防打转的标记：重启过一次就不再重启，
 * 哪怕开关没生效（比如 Node 版本太老不认这个变量）——
 * 那时候宁可带着"连不上"跑，也不能反复 spawn。
 */
function reexecWithProxySupport(): boolean {
  if (process.env['PSAI_PROXY_REEXEC'] === '1') return false;
  if (process.env['NODE_USE_ENV_PROXY']) return false;
  const proxy = envProxy();
  if (!proxy) return false;

  console.log(`检测到系统代理 ${proxy}，正在以代理模式重启 Helper（Node 的 fetch 默认不走代理）`);
  const r = spawnSync(process.execPath, process.argv.slice(1), {
    stdio: 'inherit',
    env: { ...process.env, NODE_USE_ENV_PROXY: '1', PSAI_PROXY_REEXEC: '1' }
  });
  process.exit(r.status ?? 0);
}

const cliArgs = process.argv.slice(2);
if (cliArgs.some((a) => a.startsWith('--'))) {
  runCli(cliArgs)
    .then((handled) => {
      if (!handled) process.exit(2);
    })
    .catch((e) => {
      // 安装器靠退出码判断成败，靠 stderr 给用户看原因。
      // 这里绝不能吞异常：装失败却报成功，用户会在 Photoshop 里
      // 对着一个根本没装上的插件找半天。
      console.error(`ERROR ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    });
} else if (shouldAutoStart()) {
  // 起服务之前先处理代理 —— 必须在拿单实例锁之前，否则重启的那个进程会撞锁
  reexecWithProxySupport();
  startHelper().catch((e) => {
    console.error('Helper 启动失败:', e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
