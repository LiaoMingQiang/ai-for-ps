/**
 * Helper 运行时配置与路径。
 *
 * 安全默认：只监听 127.0.0.1。局域网模式必须由用户显式开启且必须设访问口令，
 * 否则同网段任何人都能拿到本机的生图能力与密钥代理。
 */

import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';
import { HELPER_DEFAULT_PORT } from '@psai/shared';

export interface HelperConfig {
  host: string;
  port: number;
  dataDir: string;
  dbPath: string;
  assetsDir: string;
  logsDir: string;
  backupsDir: string;
  lockPath: string;
  /** 局域网模式：只有显式开启才会绑到 0.0.0.0 */
  lanMode: boolean;
  lanPassword: string | null;
  /** 测试用：跳过单实例锁与自启动检查 */
  ephemeral: boolean;
}

function defaultDataDir(): string {
  const local = process.env['LOCALAPPDATA'];
  if (local) return join(local, 'AIforPS');
  return join(homedir(), '.aiforps');
}

export function ensureDir(p: string): string {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
  return p;
}

export function loadConfig(overrides: Partial<HelperConfig> = {}): HelperConfig {
  const dataDir = resolve(overrides.dataDir ?? process.env['PSAI_DATA_DIR'] ?? defaultDataDir());
  const lanMode = overrides.lanMode ?? process.env['PSAI_LAN'] === '1';
  const lanPassword = overrides.lanPassword ?? process.env['PSAI_LAN_PASSWORD'] ?? null;

  if (lanMode && !lanPassword) {
    throw new Error('局域网模式必须设置访问口令（PSAI_LAN_PASSWORD），否则拒绝启动');
  }

  const cfg: HelperConfig = {
    host: lanMode ? '0.0.0.0' : '127.0.0.1',
    port: overrides.port ?? Number(process.env['PSAI_PORT'] ?? HELPER_DEFAULT_PORT),
    dataDir,
    dbPath: join(dataDir, 'psai.sqlite'),
    assetsDir: join(dataDir, 'assets'),
    logsDir: join(dataDir, 'logs'),
    backupsDir: join(dataDir, 'backup'),
    lockPath: join(dataDir, 'helper.lock'),
    lanMode,
    lanPassword,
    ephemeral: overrides.ephemeral ?? false
  };

  ensureDir(cfg.dataDir);
  ensureDir(cfg.assetsDir);
  ensureDir(cfg.logsDir);
  ensureDir(cfg.backupsDir);
  return cfg;
}
