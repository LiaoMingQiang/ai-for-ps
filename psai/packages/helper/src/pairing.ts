/**
 * 两段式配对。
 *
 * /v1/pair/request  → 返回一次性 challenge（60 秒有效、用后即焚）
 * /v1/pair/confirm  → 用 challenge 换长期 token
 *
 * Helper 只存 token 的 sha256，插件把 token 存进 UXP secureStorage。
 * 这样即使数据库泄露，也拿不到能直接用的 token。
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Db } from './db.js';

const CHALLENGE_TTL_MS = 60_000;

export function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

interface Challenge {
  value: string;
  expiresAt: number;
  client: string;
}

export class PairingService {
  private challenges = new Map<string, Challenge>();

  constructor(private readonly db: Db) {}

  /** 第一步：发一次性 challenge。 */
  request(client: string): { challenge: string; expiresInMs: number } {
    this.pruneChallenges();
    const value = randomBytes(24).toString('base64url');
    this.challenges.set(value, { value, expiresAt: Date.now() + CHALLENGE_TTL_MS, client });
    return { challenge: value, expiresInMs: CHALLENGE_TTL_MS };
  }

  /** 第二步：用 challenge 换长期 token。challenge 用后立即失效。 */
  confirm(challenge: string): { token: string } | { error: string } {
    this.pruneChallenges();
    const rec = this.challenges.get(challenge);
    if (!rec) return { error: 'challenge 无效或已过期，请重新发起配对' };
    this.challenges.delete(challenge);

    const token = randomBytes(32).toString('base64url');
    const now = Date.now();
    this.db
      .prepare(
        'INSERT INTO pairing(token_hash, client, created_at, last_seen_at, revoked) VALUES(?, ?, ?, ?, 0)'
      )
      .run(sha256(token), rec.client, now, now);
    return { token };
  }

  /** 校验 Bearer token。命中则顺手刷新 last_seen_at。 */
  verify(token: string | null | undefined): boolean {
    if (!token) return false;
    const hash = sha256(token);
    const rows = this.db
      .prepare('SELECT token_hash FROM pairing WHERE revoked = 0')
      .all() as Array<{ token_hash: string }>;
    const target = Buffer.from(hash, 'utf8');
    let hit = false;
    for (const r of rows) {
      const cand = Buffer.from(r.token_hash, 'utf8');
      if (cand.length === target.length && timingSafeEqual(cand, target)) {
        hit = true;
        break;
      }
    }
    if (hit) {
      this.db.prepare('UPDATE pairing SET last_seen_at = ? WHERE token_hash = ?').run(Date.now(), hash);
    }
    return hit;
  }

  hasAnyPairing(): boolean {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM pairing WHERE revoked = 0').get() as { n: number };
    return row.n > 0;
  }

  revokeAll(): void {
    this.db.prepare('UPDATE pairing SET revoked = 1').run();
    this.challenges.clear();
  }

  private pruneChallenges(): void {
    const now = Date.now();
    for (const [k, v] of this.challenges) {
      if (v.expiresAt <= now) this.challenges.delete(k);
    }
  }
}
