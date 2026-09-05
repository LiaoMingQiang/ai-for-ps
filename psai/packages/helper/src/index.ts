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
  /**
   * 实际绑定的端口，已校验在 1~65535 内。
   *
   * 单独给一个数字，是因为调用方从 url 里把它抠出来这件事有个陷阱：
   * `Number(new URL(u).port)` 在端口正好等于协议默认端口（http 的 80）时
   * 会得到 **0** —— URL 规范会把默认端口规范化成空串，而 Number('') 是 0。
   * 拿 0 去 fetch，undici 报的是一句 `bad port`，跟真正的原因隔着十万八千里。
   *
   * 测试全部用 port: 0 让系统分配，这台机器的动态端口范围又被调得很低
   * （日志里出现过 6667、10705），所以这不是纯理论。与其让每个调用方
   * 各自小心，不如根本不让他们做这个转换。
   */
  port: number;
  stop: () => Promise<void>;
  /** 恢复流程的完成信号。stop() 会等它，避免关库时恢复还在写。 */
  recovered: Promise<void>;
  /** 测试用：拿一个可用 token，免去走配对流程 */
  issueToken: () => string;
}

/**
 * 问一下占着这个端口的 Helper 是哪一版。撞锁时用来把日志说清楚。
 *
 * /v1/health 不需要配对 token —— 状态条在配对之前也要能显示在线状态，
 * 所以它本来就是公开的。超时给得很短：这只是为了让一条日志更有用，
 * 不值得让启动卡在这儿。
 */
async function probeRunningVersion(port: number): Promise<string | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/health`, {
      signal: AbortSignal.timeout(1500)
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === 'string' ? body.version : null;
  } catch {
    return null;
  }
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
    /*
     * 只说「已有实例在运行」是不够的 —— 真机上出过这样一次：
     * 用户装了新版，面板却一直显示旧的 Helper 版本号，怎么重装都没用。
     * 原因是一个几天前手工起的旧 Helper 一直占着端口，新装的那个
     * 每次启动都撞锁、悄悄退掉。日志里只有这一句话，看不出撞的是谁，
     * 于是"安装包没更新后端"这个错误结论看起来完全成立。
     *
     * 所以撞锁时去问一下对方是哪一版，把两个版本号一起写进日志。
     * 探测失败也不影响结论（进程可能刚死、或者端口是别的程序占的），
     * 那就退回原来那句话。
     */
    const other = await probeRunningVersion(cfg.port);
    let detail = '已有 Helper 实例在运行';
    if (other) {
      detail =
        other === PSAI_VERSION
          ? `已有同版本 Helper ${other} 在运行（端口 ${cfg.port}），本次启动跳过`
          : `端口 ${cfg.port} 被 Helper ${other} 占着，而本次要启动的是 ${PSAI_VERSION} —— ` +
            `版本不一致。多半是旧版本还在跑（可能来自旧的开机自启或手工启动），` +
            `装了新版也用不上。请先结束那个进程再启动本版本。`;
    }
    log.warn(detail);
    throw new Error(detail);
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

  /*
   * 系统分配的端口可能正好落在 WHATWG 的禁用端口表上（见 BAD_PORTS）。
   * 撞上之后 Helper 自己好好的，插件却一个请求都发不出去 —— undici 直接
   * 拒连、报 `bad port`。所以只在 port=0（系统分配）时重试换一个：
   * 用户显式指定的端口不动，那是他的决定，硬改反而更难查。
   *
   * 重试上限 8 次：禁用表一共几十个端口，动态范围里连撞八次的概率
   * 低到可以忽略；真撞满了就带着这个端口继续跑，并明确警告 ——
   * 起不来比"起来了但连不上"更容易查。
   */
  /*
   * port=0 时先**试探**出一个不在禁用表上的端口，再让 Fastify 去监听它。
   *
   * 不能"先 listen、发现坏了再 close 重来"：Fastify 的实例 close() 之后
   * 就废了，不能再 listen —— 那样写出来的结果是撞上禁用端口时整个 Helper
   * 直接不可用，比原来的问题更糟。（这一版写错过一次，测试立刻照出来了：
   * 日志里那行"换一个重试"之后，整个文件的用例一起挂。）
   *
   * 所以用一个临时的 net 服务器去问系统要端口，拿到好的就放掉、
   * 立刻让 Fastify 绑上去。中间有极小的竞态窗口（放掉到绑上之间别人可能抢走），
   * 所以 listen 失败时整轮重来。
   */
  if (cfg.port === 0) {
    const { createServer: createNetServer } = await import('node:net');
    for (let attempt = 0; attempt < 8; attempt++) {
      const probe = createNetServer();
      const got = await new Promise<number>((resolve, reject) => {
        probe.once('error', reject);
        probe.listen(0, cfg.host, () => {
          const a = probe.address();
          resolve(a && typeof a === 'object' ? a.port : NaN);
        });
      });
      await new Promise<void>((r) => probe.close(() => r()));
      if (!isBadPort(got)) {
        cfg.port = got;
        break;
      }
      log.info(`系统分配的端口 ${got} 在 WHATWG 禁用端口表上（fetch 会拒连），另换一个`);
    }
    // 八次都撞上就退回 0，交给系统随便给一个 —— 起不来比"起来了但连不上"更糟
  }

  try {
    await app.listen({ host: cfg.host, port: cfg.port });
  } catch (e) {
    // 试探与正式绑定之间被别人抢走了：退回让系统当场分配
    if ((e as { code?: string }).code === 'EADDRINUSE' && cfg.port !== 0) {
      log.warn(`端口 ${cfg.port} 在试探之后被占用，改由系统分配`);
      cfg.port = 0;
      await app.listen({ host: cfg.host, port: 0 });
    } else {
      throw e;
    }
  }

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
    port: boundPort,
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
/**
 * 从 Windows 的系统代理设置里读代理地址。
 *
 * 为什么必须读注册表：Windows 上大多数代理软件（Clash / v2ray / 各种加速器）
 * 只写 WinINET 的这组设置，**不设 HTTP_PROXY / HTTPS_PROXY 环境变量**。
 * 而我们原来只看环境变量 —— 于是在这类机器上：
 *   系统代理开着，浏览器、curl 都通；
 *   我们那句"检测到代理就重启"从来不触发（envProxy() 永远返回 null）；
 *   Node 的 fetch 直连超时，界面报「拉取模型失败 / fetch failed」。
 *
 * 真机实测（用户机器，ProxyEnable=1、ProxyServer=127.0.0.1:4780）：
 *   直连 https://ai.comfly.org/v1/models  → Connect Timeout Error
 *   带上这个代理                          → HTTP 401（通了，只是缺 key）
 *
 * 用 reg query 而不是引第三方库：它是 Windows 自带的，SEA 打包也不受影响。
 * 读不到就当没有 —— 宁可不走代理，也不能因为读注册表失败而起不来。
 */
function windowsSystemProxy(): { proxy: string; noProxy: string } | null {
  if (process.platform !== 'win32') return null;
  try {
    const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
    const r = spawnSync('reg', ['query', key], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    if (r.status !== 0 || !r.stdout) return null;

    if (!/ProxyEnable\s+REG_DWORD\s+0x1/i.test(r.stdout)) return null;

    const raw = /ProxyServer\s+REG_SZ\s+(.+)/i.exec(r.stdout)?.[1]?.trim();
    if (!raw) return null;

    /*
     * ProxyServer 有两种写法：
     *   "127.0.0.1:4780"                            所有协议共用
     *   "http=127.0.0.1:1080;https=127.0.0.1:1080"  按协议分开
     * 后者取 https 那条（我们打的全是 https）；都没有就取第一条。
     */
    let hostPort = raw;
    if (raw.includes('=')) {
      const parts: Record<string, string> = {};
      for (const seg of raw.split(';')) {
        const i = seg.indexOf('=');
        if (i > 0) parts[seg.slice(0, i).trim().toLowerCase()] = seg.slice(i + 1).trim();
      }
      hostPort = parts['https'] ?? parts['http'] ?? Object.values(parts)[0] ?? '';
    }
    if (!hostPort) return null;
    const proxy = /^\w+:\/\//.test(hostPort) ? hostPort : `http://${hostPort}`;

    /*
     * 绕过表。必须带上本机地址 —— 否则本机 ComfyUI（127.0.0.1:8188）
     * 和 Helper 自己的端口都会被塞进代理，那是纯粹的自伤。
     * `<local>` 是 WinINET 的写法，Node 不认，换成明确的几个。
     */
    const ov = /ProxyOverride\s+REG_SZ\s+(.+)/i.exec(r.stdout)?.[1]?.trim() ?? '';
    const extra = ov
      .split(';')
      .map((x) => x.trim())
      .filter((x) => x && x !== '<local>');
    const noProxy = ['localhost', '127.0.0.1', '::1', ...extra].join(',');

    return { proxy, noProxy };
  } catch {
    return null;
  }
}

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
  /*
   * 两个来源都看：环境变量优先（那是用户显式设的，尊重他），
   * 没有再读 Windows 的系统代理设置 —— 后者才是这台机器上的实际情况。
   */
  const fromEnv = envProxy();
  const fromSystem = fromEnv ? null : windowsSystemProxy();
  const proxy = fromEnv ?? fromSystem?.proxy ?? null;
  if (!proxy) return false;

  console.log(
    `检测到${fromEnv ? '环境变量里的' : '系统设置里的'}代理 ${proxy}，` +
      '正在以代理模式重启 Helper（Node 的 fetch 默认不走代理）'
  );
  const r = spawnSync(process.execPath, process.argv.slice(1), {
    stdio: 'inherit',
    env: {
      ...process.env,
      // 从系统设置读来的要显式写进环境变量，NODE_USE_ENV_PROXY 才看得到
      ...(fromSystem ? { HTTPS_PROXY: fromSystem.proxy, HTTP_PROXY: fromSystem.proxy } : {}),
      // 本机地址一律不走代理，否则本机 ComfyUI 和 Helper 自己都会被绕进去
      ...(fromSystem ? { NO_PROXY: fromSystem.noProxy, no_proxy: fromSystem.noProxy } : {}),
      NODE_USE_ENV_PROXY: '1',
      PSAI_PROXY_REEXEC: '1'
    }
  });
  process.exit(r.status ?? 0);
}

/**
 * WHATWG 的「禁用端口」表。
 *
 * 浏览器和 undici（Node 的 fetch）**拒绝**连接这些端口，报的是一句
 * `bad port` —— 连 TCP 都不会去连。这批端口历来被用作其它协议
 * （6667 是 IRC、2049 是 NFS、5060 是 SIP……），为了防跨协议攻击被写死拒掉。
 *
 * 为什么 Helper 要管这件事：以 port 0 启动时端口由系统分配，
 * 而有些机器的动态端口范围被调得很低（本机就分到过 6667 和 10705），
 * 正好撞上这张表。撞上之后 Helper 自己跑得好好的，
 * 插件却一个请求都发不出去 —— 报错是 `fetch failed`，
 * 底下那句 `bad port` 藏在 cause 里，跟"端口被占""没配对"看起来毫无区别。
 *
 * 这个 flake 前后犯过五次，每次都是整批用例一起红、重跑又好，
 * 一直没定位到；直到日志里那行 `Helper 已就绪 http://127.0.0.1:6667`
 * 和这张表对上号。
 *
 * 表按 WHATWG URL 规范的 bad port list 抄写。
 */
const BAD_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103,
  104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513,
  514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719,
  1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679,
  6697, 10080
]);

export function isBadPort(port: number): boolean {
  return BAD_PORTS.has(port);
}

/**
 * 把一行文字压成纯 ASCII，供 NSIS 显示。
 *
 * 非 ASCII 一律换成 '?'，**但 ASCII 范围内的字符全部原样留住** ——
 * 尤其是反斜杠。中文 Windows 上 GBK 双字节字符的第二字节可能正好是
 * 0x5C，解码时被当成路径分隔符吃掉，报错里的路径就会缺一段，
 * 看的人根本对不上是哪个目录。真机上出过：
 * 「C:\Users\藍鎳槤鍾卜AppData\Roaming\...」—— 用户名和 AppData 之间
 * 的那个反斜杠没了。
 *
 * 这不是"翻译"，只是保证这行字在任何代码页下都不会变成乱码。
 * 真正给人看的中文细节在日志文件里，路径会一并打出来。
 */
export function toAsciiSafe(text: string): string {
  let out = '';
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    out += c >= 0x20 && c <= 0x7e ? ch : '?';
  }
  return out.slice(0, 600);
}

const cliArgs = process.argv.slice(2);
if (cliArgs.some((a) => a.startsWith('--'))) {
  runCli(cliArgs)
    .then((handled) => {
      if (!handled) process.exit(2);
    })
    .catch((e) => {
      /*
       * 安装器靠退出码判断成败，靠这里的输出给用户看原因。
       * 绝不能吞异常：装失败却报成功，用户会在 Photoshop 里对着一个
       * 根本没装上的插件找半天。
       *
       * 但**输出必须是纯 ASCII**。
       *
       * NSIS 用 nsExec::ExecToStack 捕获这段文字，再原样塞进 MessageBox。
       * 它按系统 ANSI 代码页解码，而我们写的是 UTF-8 —— 在中文 Windows 上
       * 就成了乱码。真机上出过：用户名是中文的那台机器，报错里出现了
       * 「藍鎳槤鍾卜AppData」这种东西，而且**用户名和 AppData 之间的反斜杠
       * 没了** —— GBK 双字节字符的第二字节撞上 0x5C，正好被当成路径分隔符
       * 吃掉。结果是一条既看不懂、路径又是错的报错。
       *
       * 所以：给 NSIS 的是 ASCII 摘要 + 日志文件路径，中文细节写进日志。
       * 日志由我们自己写，编码可控。
       */
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`ERROR ${toAsciiSafe(msg)}`);
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
