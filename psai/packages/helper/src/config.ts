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
  /**
   * 启动时要不要去探一次 ComfyUI / 预热云端 Provider。
   *
   * 正常启动要探：不探的话状态条会一直显示"离线"，直到用户主动去点一次测试，
   * 而 ComfyUI 明明好好地跑着。
   *
   * 但**测试里必须关掉**。一个新数据目录的默认地址是 http://127.0.0.1:8188 ——
   * 那是用户本机真实 ComfyUI 的地址。几十个临时 Helper 一起启动，
   * 就会一起去敲用户那台真的 ComfyUI：轻则把它压出超时（我们这边表现为
   * 一批用例卡在 15 秒整数上失败），重则在别人正干活的时候插一脚。
   * 测试不该依赖、更不该打扰宿主机上的任何服务。
   */
  probeOnStart: boolean;
  /**
   * 开发预览用：给 127.0.0.1 / localhost 来源加 CORS 头。
   * 默认关闭 —— 正式运行时插件跑在 UXP 里，同源，不需要 CORS。
   * 只有在浏览器里预览面板样式时才需要打开。
   */
  devCors: boolean;
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
    ephemeral: overrides.ephemeral ?? false,
    // 默认跟随 ephemeral 取反：临时实例（测试、预览）一律不探宿主机
    probeOnStart: overrides.probeOnStart ?? !(overrides.ephemeral ?? false),
    devCors: overrides.devCors ?? process.env['PSAI_DEV_CORS'] === '1'
  };

  ensureDir(cfg.dataDir);
  ensureDir(cfg.assetsDir);
  ensureDir(cfg.logsDir);
  ensureDir(cfg.backupsDir);
  return cfg;
}
