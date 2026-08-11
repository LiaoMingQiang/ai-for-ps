/* credentials: Provider API Key 安全存储 (规则六)
 * Windows: DPAPI (CurrentUser) via .NET ProtectedData
 * macOS/Linux fallback: 加密文件 + 0600 (文档标注强度低于 DPAPI/Keychain)
 * 永不写入: localStorage / 明文 JSON / 配置文件 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { Store } from "./db.js";

export type CredentialKind = "dpapi" | "file-0600";

/* src/credential.js (dev: src/credential.ts) -> helper/scripts/dpapi.ps1 */
const DPAPI_SCRIPT = path.resolve(import.meta.dirname, "..", "scripts", "dpapi.ps1");

function runPowerShell(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", DPAPI_SCRIPT, ...args], { timeout: 15000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });
}

export async function protectWithDpapi(plainB64: string): Promise<string> {
  return runPowerShell(["-Mode", "protect", "-Base64Data", plainB64]);
}
export async function unprotectWithDpapi(encB64: string): Promise<string> {
  return runPowerShell(["-Mode", "unprotect", "-Base64Data", encB64]);
}

/* ---- fallback: 文件加密 (AES-256-GCM, 密钥 = 机器级 DPAPI blob, 双保险) ---- */
function vaultPath(cfg: { dataDir: string }): string {
  return path.join(cfg.dataDir, "credentials.vault");
}

/* 文件密钥: 首次生成随机密钥 -> DPAPI 保护后存 key 文件 */
async function ensureVaultKey(cfg: { dataDir: string }): Promise<Buffer> {
  const keyPath = path.join(cfg.dataDir, "vault.key.dpapi");
  if (fs.existsSync(keyPath)) {
    const enc = fs.readFileSync(keyPath, "utf8").trim();
    const keyB64 = await unprotectWithDpapi(enc);
    return Buffer.from(keyB64, "base64");
  }
  const key = crypto.randomBytes(32);
  const enc = await protectWithDpapi(key.toString("base64"));
  fs.writeFileSync(keyPath, enc, { mode: 0o600 });
  return key;
}

export class CredentialService {
  constructor(private store: Store, private cfg: { dataDir: string }) {}

  async kind(): Promise<CredentialKind> {
    return process.platform === "win32" ? "dpapi" : "file-0600";
  }

  async set(providerId: string, secret: string): Promise<void> {
    const kind = await this.kind();
    const now = Date.now();
    if (kind === "dpapi") {
      const enc = await protectWithDpapi(Buffer.from(secret, "utf8").toString("base64"));
      const ref = `dpapi:v1:${providerId}`;
      this.store.raw.prepare(
        "INSERT OR REPLACE INTO provider_credentials_meta (provider_id, credential_kind, key_ref, has_credential, updated_at) VALUES (?,?,?,1,?)"
      ).run(providerId, kind, ref, now);
      /* 密文存 vault 文件, 不落明文 */
      const vault = vaultPath(this.cfg);
      const db = new Map<string, string>();
      if (fs.existsSync(vault)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(vault, "utf8")) as Record<string, string>;
          for (const k of Object.keys(parsed)) db.set(k, parsed[k]);
        } catch (e) { /* corrupt vault: reset */ }
      }
      db.set(providerId, enc);
      fs.writeFileSync(vault, JSON.stringify(Object.fromEntries(db)), { mode: 0o600 });
    } else {
      const key = await ensureVaultKey(this.cfg);
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      const enc = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      const blob = Buffer.concat([iv, tag, enc]).toString("base64");
      const vault = vaultPath(this.cfg);
      const db = new Map<string, string>();
      if (fs.existsSync(vault)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(vault, "utf8")) as Record<string, string>;
          for (const k of Object.keys(parsed)) db.set(k, parsed[k]);
        } catch (e) { /* reset */ }
      }
      db.set(providerId, blob);
      fs.writeFileSync(vault, JSON.stringify(Object.fromEntries(db)), { mode: 0o600 });
      this.store.raw.prepare(
        "INSERT OR REPLACE INTO provider_credentials_meta (provider_id, credential_kind, key_ref, has_credential, updated_at) VALUES (?,?,?,1,?)"
      ).run(providerId, kind, `file:v1:${providerId}`, now);
    }
  }

  async get(providerId: string): Promise<string | null> {
    const row = this.store.raw.prepare("SELECT credential_kind, has_credential FROM provider_credentials_meta WHERE provider_id=?").get(providerId) as { credential_kind: string; has_credential: number } | undefined;
    if (!row || row.has_credential !== 1) return null;
    const vault = vaultPath(this.cfg);
    if (!fs.existsSync(vault)) return null;
    let blob: string | null = null;
    try {
      const parsed = JSON.parse(fs.readFileSync(vault, "utf8")) as Record<string, string>;
      blob = parsed[providerId] || null;
    } catch (e) { return null; }
    if (!blob) return null;
    if (row.credential_kind === "dpapi") {
      const plainB64 = await unprotectWithDpapi(blob);
      return Buffer.from(plainB64, "base64").toString("utf8");
    }
    const key = await ensureVaultKey(this.cfg);
    const buf = Buffer.from(blob, "base64");
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const data = buf.subarray(28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  }

  async delete(providerId: string): Promise<void> {
    this.store.raw.prepare("UPDATE provider_credentials_meta SET has_credential=0, updated_at=? WHERE provider_id=?").run(Date.now(), providerId);
    const vault = vaultPath(this.cfg);
    if (fs.existsSync(vault)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(vault, "utf8")) as Record<string, string>;
        delete parsed[providerId];
        fs.writeFileSync(vault, JSON.stringify(parsed), { mode: 0o600 });
      } catch (e) { /* noop */ }
    }
  }
}
