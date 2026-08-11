/* config: 路径 / 端口 / 单实例锁
 * 安全规则 (规则八): 默认只监听 127.0.0.1; 局域网模式必须显式开启 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

export const VERSION = "0.9.0";

export const DEFAULT_PORT = 33057; /* 与 UXP 默认 helperUrl 一致 */

export interface HelperConfig {
  port: number;
  host: string;            /* 127.0.0.1 默认; 0.0.0.0 仅当 LAN_MODE=1 */
  dataDir: string;
  dbPath: string;
  assetsDir: string;
  tempDir: string;
  logDir: string;
  pairingToken: string | null;
}

function envBool(name: string): boolean {
  return ["1", "true", "yes", "on"].includes((process.env[name] || "").toLowerCase());
}

export function loadConfig(): HelperConfig {
  const base = process.env.A4P_HELPER_DIR
    || path.join(process.env.LOCALAPPDATA || os.homedir(), "AI-for-PS-Helper");
  fs.mkdirSync(base, { recursive: true });
  const assetsDir = path.join(base, "assets");
  const tempDir = path.join(base, "tmp");
  const logDir = path.join(base, "logs");
  for (const d of [assetsDir, tempDir, logDir]) fs.mkdirSync(d, { recursive: true });

  const lanMode = envBool("A4P_LAN_MODE");
  return {
    port: Number(process.env.A4P_PORT || DEFAULT_PORT),
    host: lanMode ? "0.0.0.0" : "127.0.0.1",
    dataDir: base,
    dbPath: path.join(base, "helper.db"),
    assetsDir,
    tempDir,
    logDir,
    pairingToken: null
  };
}

/* 单实例: 端口绑定冲突即视为已有实例; 另以 lockfile 记录 PID 供诊断 */
export function acquireSingleInstance(cfg: HelperConfig): { ok: boolean; existingPid?: number; reason?: string } {
  const lockPath = path.join(cfg.dataDir, "helper.lock");
  try {
    if (fs.existsSync(lockPath)) {
      const pid = Number(fs.readFileSync(lockPath, "utf8").trim());
      if (pid && pid !== process.pid) {
        let alive = false;
        try { process.kill(pid, 0); alive = true; } catch (e) { alive = false; }
        if (alive) return { ok: false, existingPid: pid, reason: `已有 Helper 实例运行中 (PID ${pid})` };
      }
    }
    fs.writeFileSync(lockPath, String(process.pid));
  } catch (e) { /* lockfile 失败不阻塞 (端口冲突仍会拦截) */ }
  return { ok: true };
}

export function releaseSingleInstance(cfg: HelperConfig) {
  try { fs.rmSync(path.join(cfg.dataDir, "helper.lock"), { force: true }); } catch (e) { /* noop */ }
}
