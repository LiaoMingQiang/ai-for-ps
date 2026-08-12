/* pairing: 配对 (规则六/八/十六)
 * - UXP 只保存 pairing token (SecureStorage)
 * - PHASE 16: one-time challenge — 首次配对走 /v1/pair/request -> /v1/pair/confirm
 *   只有配对窗口内拿到 nonce 的客户端才能换取长期 token; 配对完成后公开通道关闭。
 * - API 请求需 Bearer token (除 /v1/health, /v1/pair/request 等公开端点) */
import crypto from "node:crypto";
import type { Store } from "./db.js";

const TOKEN_KEY = "pairing.token";
const NONCE_KEY = "pairing.nonce";
const PAIRED_KEY = "pairing.pairedAt";
const NONCE_TTL_MS = 120_000;      /* 配对窗口: 120 秒 */
const PAIR_WINDOW_MS = 10 * 60_000; /* Helper 启动后 10 分钟内允许首次配对 */

export function getToken(store: Store): string | null {
  const row = store.raw.prepare("SELECT value FROM settings WHERE key=?").get(TOKEN_KEY) as { value: string } | undefined;
  return row ? row.value : null;
}

export function isPaired(store: Store): boolean {
  const row = store.raw.prepare("SELECT value FROM settings WHERE key=?").get(PAIRED_KEY) as { value: string } | undefined;
  return !!row && Number(row.value) > 0;
}

/* 启动时生成配对 nonce (窗口内有效) */
export function ensureNonce(store: Store, now = Date.now()): string {
  const row = store.raw.prepare("SELECT value FROM settings WHERE key=?").get(NONCE_KEY) as { value: string } | undefined;
  if (row) {
    try {
      const j = JSON.parse(row.value) as { nonce: string; expiresAt: number };
      if (j.expiresAt > now) return j.nonce;
    } catch (e) { /* corrupt: regenerate */ }
  }
  const nonce = crypto.randomBytes(24).toString("hex");
  store.raw.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(NONCE_KEY, JSON.stringify({ nonce, expiresAt: now + NONCE_TTL_MS }));
  return nonce;
}

/* request 阶段: 已配对 -> {paired:true}; 未配对且在启动窗口 -> {challenge} */
export function pairRequest(store: Store, startedAt: number, now = Date.now()): { paired: boolean; challenge?: string; expiresInMs?: number; pairedAt?: number } {
  if (isPaired(store)) return { paired: true, pairedAt: Number((store.raw.prepare("SELECT value FROM settings WHERE key=?").get(PAIRED_KEY) as { value: string }).value) };
  if (now - startedAt > PAIR_WINDOW_MS) return { paired: false, expiresInMs: 0 };
  const nonce = ensureNonce(store, now);
  return { paired: false, challenge: nonce, expiresInMs: NONCE_TTL_MS };
}

/* confirm 阶段: nonce 匹配且未过期 -> 生成长期 token + 关闭公开配对 */
export function pairConfirm(store: Store, challenge: string | undefined, now = Date.now()): { ok: boolean; token?: string; code?: string; message?: string } {
  if (isPaired(store)) return { ok: false, code: "PAIRING_ALREADY_PAIRED", message: "已配对，公开配对通道已关闭" };
  if (!challenge || typeof challenge !== "string") return { ok: false, code: "PAIRING_CHALLENGE_MISSING", message: "缺少 challenge" };
  const row = store.raw.prepare("SELECT value FROM settings WHERE key=?").get(NONCE_KEY) as { value: string } | undefined;
  if (!row) return { ok: false, code: "PAIRING_NO_CHALLENGE", message: "配对窗口已过期，请重启 Helper 后重试" };
  let stored: { nonce: string; expiresAt: number };
  try { stored = JSON.parse(row.value) as { nonce: string; expiresAt: number }; } catch (e) { return { ok: false, code: "PAIRING_NO_CHALLENGE", message: "配对状态损坏" }; }
  if (stored.expiresAt < now) return { ok: false, code: "PAIRING_CHALLENGE_EXPIRED", message: "配对窗口已过期，请重启 Helper 后重试" };
  if (challenge !== stored.nonce) return { ok: false, code: "PAIRING_CHALLENGE_INVALID", message: "challenge 不匹配" };
  const tok = "a4p_" + crypto.randomBytes(24).toString("hex");
  store.raw.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(TOKEN_KEY, tok);
  store.raw.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(PAIRED_KEY, String(now));
  store.raw.prepare("DELETE FROM settings WHERE key=?").run(NONCE_KEY);
  return { ok: true, token: tok };
}

export function rotateToken(store: Store): string {
  const tok = "a4p_" + crypto.randomBytes(24).toString("hex");
  store.raw.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(TOKEN_KEY, tok);
  return tok;
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
