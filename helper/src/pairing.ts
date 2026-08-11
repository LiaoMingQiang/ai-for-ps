/* pairing: 配对 token (规则六/八)
 * - UXP 只保存 pairing token (SecureStorage/local settings)
 * - Helper 生成随机 token, 存 SQLite settings
 * - API 请求需 Bearer token (除 /v1/health, /v1/pair, /v1/system 等公开端点) */
import crypto from "node:crypto";
import type { Store } from "./db.js";

const TOKEN_KEY = "pairing.token";

export function getToken(store: Store): string | null {
  const row = store.raw.prepare("SELECT value FROM settings WHERE key=?").get(TOKEN_KEY) as { value: string } | undefined;
  return row ? row.value : null;
}

export function generateToken(store: Store): string {
  const tok = "a4p_" + crypto.randomBytes(24).toString("hex");
  store.raw.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(TOKEN_KEY, tok);
  return tok;
}

export function rotateToken(store: Store): string {
  return generateToken(store);
}

export function verifyToken(store: Store, header: string | undefined): boolean {
  const tok = getToken(store);
  if (!tok) return false;
  if (!header) return false;
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m) return false;
  /* 常数时间比较 */
  const a = Buffer.from(m[1]);
  const b = Buffer.from(tok);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
