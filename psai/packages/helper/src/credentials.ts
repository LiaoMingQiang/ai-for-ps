/**
 * API Key 保管。
 *
 * Windows：DPAPI（CurrentUser 作用域）—— 密文只有当前 Windows 用户能解开。
 * 其他平台：以机器绑定的派生密钥做 AES-256-GCM，强度低于 Keychain，
 *          启动时会明确告警，不假装安全。
 *
 * 无论哪个平台，明文都不落盘，也永远不发给插件。
 */

import { execFileSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import { hostname, userInfo } from 'node:os';
import type { Db } from './db.js';
import type { Logger } from './log.js';

const IS_WIN = process.platform === 'win32';

/* ---------------- Windows DPAPI ---------------- */

function psRun(script: string): string {
  return execFileSync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8', windowsHide: true, timeout: 15000 }
  ).trim();
}

function dpapiProtect(plain: string): string {
  const b64 = Buffer.from(plain, 'utf8').toString('base64');
  const script = [
    'Add-Type -AssemblyName System.Security;',
    `$b=[Convert]::FromBase64String('${b64}');`,
    "$p=[System.Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser');",
    '[Convert]::ToBase64String($p)'
  ].join(' ');
  return psRun(script);
}

function dpapiUnprotect(cipher: string): string {
  const script = [
    'Add-Type -AssemblyName System.Security;',
    `$b=[Convert]::FromBase64String('${cipher}');`,
    "$u=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser');",
    '[Convert]::ToBase64String($u)'
  ].join(' ');
  return Buffer.from(psRun(script), 'base64').toString('utf8');
}

/* ---------------- 非 Windows 回退 ---------------- */

function fallbackKey(): Buffer {
  const seed = `${hostname()}::${userInfo().username}::psai-v1`;
  return scryptSync(seed, createHash('sha256').update(seed).digest(), 32);
}

function fallbackEncrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', fallbackKey(), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join('.');
}

function fallbackDecrypt(cipher: string): string {
  const [v, ivB, tagB, dataB] = cipher.split('.');
  if (v !== 'v1' || !ivB || !tagB || !dataB) throw new Error('密文格式不正确');
  const d = createDecipheriv('aes-256-gcm', fallbackKey(), Buffer.from(ivB, 'base64'));
  d.setAuthTag(Buffer.from(tagB, 'base64'));
  return Buffer.concat([d.update(Buffer.from(dataB, 'base64')), d.final()]).toString('utf8');
}

/* ---------------- 存储 ---------------- */

export class CredentialStore {
  constructor(
    private readonly db: Db,
    private readonly log: Logger
  ) {
    if (!IS_WIN) {
      this.log.warn('当前平台没有 DPAPI，API Key 使用机器绑定密钥加密，安全强度低于系统钥匙串');
    }
  }

  private encrypt(plain: string): string {
    return IS_WIN ? dpapiProtect(plain) : fallbackEncrypt(plain);
  }

  private decrypt(cipher: string): string {
    return IS_WIN ? dpapiUnprotect(cipher) : fallbackDecrypt(cipher);
  }

  set(providerId: string, field: string, plain: string): void {
    const now = Date.now();
    const cipher = this.encrypt(plain);
    this.db
      .prepare(
        `INSERT INTO credentials(provider_id, field, cipher, created_at, updated_at)
         VALUES(?, ?, ?, ?, ?)
         ON CONFLICT(provider_id, field) DO UPDATE SET cipher = excluded.cipher, updated_at = excluded.updated_at`
      )
      .run(providerId, field, cipher, now, now);
  }

  /** 取明文。只在 Helper 内部调用，绝不返回给插件。 */
  get(providerId: string, field: string): string | null {
    const row = this.db
      .prepare('SELECT cipher FROM credentials WHERE provider_id = ? AND field = ?')
      .get(providerId, field) as { cipher: string } | undefined;
    if (!row) return null;
    try {
      return this.decrypt(row.cipher);
    } catch (e) {
      this.log.error('凭据解密失败（可能是换了 Windows 用户或换了机器）', {
        providerId,
        field,
        error: String(e)
      });
      return null;
    }
  }

  has(providerId: string, field: string): boolean {
    const row = this.db
      .prepare('SELECT 1 AS ok FROM credentials WHERE provider_id = ? AND field = ?')
      .get(providerId, field) as { ok: number } | undefined;
    return !!row;
  }

  /** 给 UI 显示用的掩码，例 sk-••••••1234。永远不返回明文。 */
  mask(providerId: string, field: string): string | null {
    const plain = this.get(providerId, field);
    if (!plain) return null;
    if (plain.length <= 8) return '••••••';
    return plain.slice(0, 3) + '••••••' + plain.slice(-4);
  }

  clear(providerId: string, field?: string): void {
    if (field) {
      this.db.prepare('DELETE FROM credentials WHERE provider_id = ? AND field = ?').run(providerId, field);
    } else {
      this.db.prepare('DELETE FROM credentials WHERE provider_id = ?').run(providerId);
    }
  }

  fieldsOf(providerId: string): string[] {
    const rows = this.db
      .prepare('SELECT field FROM credentials WHERE provider_id = ?')
      .all(providerId) as Array<{ field: string }>;
    return rows.map((r) => r.field);
  }
}
