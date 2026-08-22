/**
 * Helper 进程入口。
 *
 * 启动顺序：单实例锁 → 数据库（含迁移与回滚）→ 各存储 → Provider → 作业引擎
 *          → HTTP + WS → 恢复未完成任务。
 * 任何一步失败都要把原因写进日志并以非零码退出，不留一个"看起来在跑"的半死进程。
 */

import { createServer } from 'node:http';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
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

function builtinWorkflowsDir(): string {
  // 开发：packages/helper/dist -> psai/workflows；打包后由 PSAI_WORKFLOWS_DIR 指定
  const env = process.env['PSAI_WORKFLOWS_DIR'];
  if (env) return env;
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '../../../workflows');
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

  const url = `http://${cfg.host === '0.0.0.0' ? '127.0.0.1' : cfg.host}:${cfg.port}`;
  log.info(`Helper 已就绪 ${url}`);

  // 恢复未完成的任务（先查远端，不重复提交）。
  // 不阻塞启动，但要留下句柄：关闭时必须等它跑完，否则会对着已关闭的数据库写。
  const recovered = jobs.recover().then(
    () => undefined,
    (e: unknown) => {
      log.error('任务恢复失败', String(e));
    }
  );

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

// 直接执行时启动
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  startHelper().catch((e) => {
    console.error('Helper 启动失败:', e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
