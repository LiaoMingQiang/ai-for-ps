/**
 * SQLite 持久层（node:sqlite，无原生依赖，可被 Node SEA 打包）。
 *
 * 迁移纪律：备份 → 迁移 → 失败回滚到备份并拒绝启动。
 * 数据库是用户几个月的生成历史，宁可不启动也不能迁坏。
 */

import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { PSAI_SCHEMA_VERSION } from '@psai/shared';
import type { Logger } from './log.js';

export type Db = DatabaseSync;

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  json       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pairing (
  token_hash   TEXT PRIMARY KEY,
  client       TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  revoked      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS credentials (
  provider_id TEXT NOT NULL,
  field       TEXT NOT NULL,
  cipher      TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (provider_id, field)
);

CREATE TABLE IF NOT EXISTS providers (
  id              TEXT PRIMARY KEY,
  enabled         INTEGER NOT NULL DEFAULT 0,
  base_url        TEXT NOT NULL DEFAULT '',
  default_model   TEXT NOT NULL DEFAULT '',
  models_json     TEXT NOT NULL DEFAULT '[]',
  last_status_json TEXT NOT NULL DEFAULT '{}',
  last_checked_at INTEGER
);

CREATE TABLE IF NOT EXISTS workflows (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  version             TEXT NOT NULL,
  source              TEXT NOT NULL,
  format              TEXT NOT NULL,
  graph_json          TEXT NOT NULL,
  bindings_json       TEXT NOT NULL DEFAULT '[]',
  output_nodes_json   TEXT NOT NULL DEFAULT '[]',
  required_nodes_json TEXT NOT NULL DEFAULT '[]',
  required_models_json TEXT NOT NULL DEFAULT '[]',
  hash                TEXT NOT NULL,
  feature_id          TEXT,
  notes               TEXT NOT NULL DEFAULT '',
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workflows_name ON workflows(name);
CREATE INDEX IF NOT EXISTS idx_workflows_feature ON workflows(feature_id);

CREATE TABLE IF NOT EXISTS feature_bindings (
  feature_id         TEXT PRIMARY KEY,
  provider_id        TEXT NOT NULL,
  workflow_id        TEXT,
  remote_workflow_id TEXT,
  model              TEXT,
  enabled            INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS assets (
  id         TEXT PRIMARY KEY,
  sha256     TEXT NOT NULL,
  mime       TEXT NOT NULL,
  bytes      INTEGER NOT NULL,
  width      INTEGER NOT NULL DEFAULT 0,
  height     INTEGER NOT NULL DEFAULT 0,
  rel_path   TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'input',
  created_at INTEGER NOT NULL,
  ref_count  INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_assets_sha ON assets(sha256);

CREATE TABLE IF NOT EXISTS jobs (
  id                   TEXT PRIMARY KEY,
  feature_id           TEXT NOT NULL,
  provider_id          TEXT NOT NULL,
  workflow_id          TEXT,
  workflow_version     TEXT,
  state                TEXT NOT NULL,
  progress_json        TEXT NOT NULL DEFAULT '{}',
  params_json          TEXT NOT NULL DEFAULT '{}',
  resolved_params_json TEXT NOT NULL DEFAULT '{}',
  target_json          TEXT,
  writeback_json       TEXT,
  error_json           TEXT,
  remote_id            TEXT,
  parent_job_id        TEXT,
  document_id          INTEGER,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  started_at           INTEGER,
  finished_at          INTEGER,
  gpu_ms               INTEGER
);
CREATE INDEX IF NOT EXISTS idx_jobs_state ON jobs(state);
CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_feature ON jobs(feature_id);
CREATE INDEX IF NOT EXISTS idx_jobs_document ON jobs(document_id);

CREATE TABLE IF NOT EXISTS job_inputs (
  job_id   TEXT NOT NULL,
  param_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  idx      INTEGER NOT NULL DEFAULT 0,
  source   TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (job_id, param_id, idx)
);

CREATE TABLE IF NOT EXISTS job_results (
  job_id   TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  idx      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (job_id, idx)
);

CREATE TABLE IF NOT EXISTS job_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id     TEXT NOT NULL,
  at         INTEGER NOT NULL,
  from_state TEXT,
  to_state   TEXT NOT NULL,
  note       TEXT NOT NULL DEFAULT '',
  error_code TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_job ON job_events(job_id, at);

CREATE TABLE IF NOT EXISTS prompt_presets (
  id              TEXT PRIMARY KEY,
  label           TEXT NOT NULL,
  kind            TEXT NOT NULL,
  scope_json      TEXT NOT NULL DEFAULT '[]',
  prompt          TEXT NOT NULL,
  negative_prompt TEXT NOT NULL DEFAULT '',
  builtin         INTEGER NOT NULL DEFAULT 0,
  description     TEXT NOT NULL DEFAULT '',
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
  document_id  INTEGER PRIMARY KEY,
  name         TEXT NOT NULL,
  path         TEXT NOT NULL DEFAULT '',
  last_seen_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS usage (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id      TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  at          INTEGER NOT NULL,
  gpu_ms      INTEGER,
  note        TEXT NOT NULL DEFAULT ''
);
`;

/** 迁移函数表：从版本 N 迁到 N+1。v1 是初始 schema，没有前置迁移。 */
const MIGRATIONS: Record<number, (db: Db) => void> = {
  // 例：2: (db) => { db.exec('ALTER TABLE jobs ADD COLUMN ...'); }
};

export interface OpenDbResult {
  db: Db;
  fromVersion: number;
  toVersion: number;
  backupPath: string | null;
}

export function openDb(dbPath: string, backupsDir: string, log: Logger): OpenDbResult {
  const fresh = !existsSync(dbPath);
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');

  db.exec(SCHEMA_V1);

  const current = readVersion(db);
  const target = PSAI_SCHEMA_VERSION;

  if (fresh || current === 0) {
    writeVersion(db, target);
    log.info(`数据库已初始化 schema v${target}`, { dbPath });
    return { db, fromVersion: target, toVersion: target, backupPath: null };
  }

  if (current === target) {
    return { db, fromVersion: current, toVersion: target, backupPath: null };
  }

  if (current > target) {
    db.close();
    throw new Error(
      `数据库 schema v${current} 高于本版本支持的 v${target}，请升级 Helper 后再启动（拒绝降级写入）`
    );
  }

  // 备份 → 迁移 → 失败回滚
  const backupPath = join(backupsDir, `db-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`);
  db.close();
  copyFileSync(dbPath, backupPath);
  log.info(`迁移前已备份数据库`, { backupPath });

  const db2 = new DatabaseSync(dbPath);
  try {
    db2.exec('BEGIN');
    for (let v = current + 1; v <= target; v++) {
      const fn = MIGRATIONS[v];
      if (!fn) throw new Error(`缺少 v${v} 的迁移脚本`);
      fn(db2);
      log.info(`已迁移到 schema v${v}`);
    }
    writeVersion(db2, target);
    db2.exec('COMMIT');
    return { db: db2, fromVersion: current, toVersion: target, backupPath };
  } catch (e) {
    try {
      db2.exec('ROLLBACK');
    } catch {
      /* noop */
    }
    db2.close();
    copyFileSync(backupPath, dbPath);
    log.error('数据库迁移失败，已回滚到备份', { backupPath, error: String(e) });
    throw new Error(`数据库迁移失败并已回滚：${String(e)}`);
  }
}

function readVersion(db: Db): number {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as
    | { value: string }
    | undefined;
  return row ? Number(row.value) : 0;
}

function writeVersion(db: Db, v: number): void {
  db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    'schema_version',
    String(v)
  );
}

/* ---------------- 小工具 ---------------- */

export function getMeta(db: Db, key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? row.value : null;
}

export function setMeta(db: Db, key: string, value: string): void {
  db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    value
  );
}
