/* db: SQLite (node:sqlite, Node 22.5+/24 内置) + migration system
 * 规则九: schema 必须有版本; 迁移失败恢复原版本 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import type { HelperConfig } from "./config.js";

export const SCHEMA_VERSION = 2;

const MIGRATIONS: Array<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    INSERT OR IGNORE INTO settings (key, value) VALUES ('schema_version', '1');

    CREATE TABLE IF NOT EXISTS providers (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,                -- comfyui | openai-compatible | gemini | volcengine | bailian | runninghub | modelscope
      name TEXT NOT NULL,
      base_url TEXT,
      enabled INTEGER NOT NULL DEFAULT 0,
      is_default INTEGER NOT NULL DEFAULT 0,
      config_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS provider_credentials_meta (
      provider_id TEXT PRIMARY KEY,
      credential_kind TEXT NOT NULL,     -- dpapi | keychain | file-encrypted
      key_ref TEXT,                      -- 凭据存储引用 (不存明文)
      has_credential INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (provider_id) REFERENCES providers(id)
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      document_persistent_id TEXT,
      document_path TEXT,
      document_name TEXT,
      last_workflow_id TEXT,
      last_preset_id TEXT,
      last_prompt_id TEXT,
      default_writeback TEXT NOT NULL DEFAULT 'smartObject',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workflows (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      version TEXT NOT NULL DEFAULT '1.0.0',
      category TEXT,
      description TEXT,
      provider TEXT,
      source_json_hash TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workflow_versions (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      version TEXT NOT NULL,
      workflow_json_hash TEXT,
      bindings_hash TEXT,
      lockfile_hash TEXT,
      changelog TEXT,
      author TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (workflow_id) REFERENCES workflows(id)
    );

    CREATE TABLE IF NOT EXISTS workflow_bindings (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      field_key TEXT NOT NULL,
      node_id TEXT NOT NULL,
      input_key TEXT NOT NULL,
      field_type TEXT,
      label TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      group_name TEXT,
      default_value TEXT,
      display_condition TEXT,
      FOREIGN KEY (workflow_id) REFERENCES workflows(id)
    );

    CREATE TABLE IF NOT EXISTS workflow_dependencies (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      kind TEXT NOT NULL,                -- comfyui | custom_node | checkpoint | lora | vae | controlnet | upscaler
      name TEXT NOT NULL,
      min_version TEXT,
      status TEXT,                       -- matched | outdated | missing | unknown
      detail TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      provider_id TEXT,
      provider_type TEXT,
      remote_job_id TEXT,
      workflow_id TEXT,
      workflow_version TEXT,
      model_id TEXT,
      inputs_json TEXT NOT NULL DEFAULT '{}',
      parameters_json TEXT NOT NULL DEFAULT '{}',
      snapshot_json TEXT NOT NULL DEFAULT '{}',
      project_id TEXT,
      source_document_id TEXT,
      source_document_name TEXT,
      source_document_path TEXT,
      source_layer_ids_json TEXT NOT NULL DEFAULT '[]',
      selection_bounds_json TEXT,
      canvas_width INTEGER,
      canvas_height INTEGER,
      color_mode TEXT,
      bit_depth INTEGER,
      snapshot_id TEXT,
      result_assets_json TEXT NOT NULL DEFAULT '[]',
      error_json TEXT,
      estimated_cost REAL,
      actual_cost REAL,
      currency TEXT,
      duration_ms INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS job_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT,
      detail TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (job_id) REFERENCES jobs(id)
    );

    CREATE TABLE IF NOT EXISTS job_outputs (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      asset_id TEXT,
      label TEXT,
      seed INTEGER,
      width INTEGER,
      height INTEGER,
      favorite INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS assets (
      id TEXT PRIMARY KEY,
      job_id TEXT,
      mime_type TEXT NOT NULL,
      width INTEGER,
      height INTEGER,
      size INTEGER NOT NULL DEFAULT 0,
      hash TEXT,
      storage_path TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'result',  -- result | input | reference | snapshot | mask
      role TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS snapshots (
      id TEXT PRIMARY KEY,
      document_id TEXT,
      document_path TEXT,
      layer_ids_json TEXT NOT NULL DEFAULT '[]',
      selection_bounds_json TEXT,
      width INTEGER,
      height INTEGER,
      color_mode TEXT,
      bit_depth INTEGER,
      input_asset_ids_json TEXT NOT NULL DEFAULT '[]',
      workflow_id TEXT,
      workflow_version TEXT,
      provider_id TEXT,
      model_id TEXT,
      parameters_json TEXT NOT NULL DEFAULT '{}',
      prompt_version TEXT,
      temp_file TEXT,
      content_hash TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS prompt_templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS prompt_versions (
      id TEXT PRIMARY KEY,
      template_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS presets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      config_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS worker_nodes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      endpoint TEXT,
      gpu TEXT,
      vram_mb INTEGER,
      status TEXT NOT NULL DEFAULT 'offline',
      latency_ms REAL,
      capabilities_json TEXT NOT NULL DEFAULT '{}',
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS usage_records (
      id TEXT PRIMARY KEY,
      job_id TEXT,
      provider_id TEXT,
      provider_type TEXT,
      model_id TEXT,
      estimated_cost REAL,
      actual_cost REAL,
      currency TEXT,
      duration_ms INTEGER,
      gpu_duration_ms INTEGER,
      tokens_in INTEGER,
      tokens_out INTEGER,
      images_count INTEGER,
      created_at INTEGER NOT NULL
    );
    `
  },
  {
    version: 2,
    sql: `
    CREATE TABLE IF NOT EXISTS agent_audit (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,                -- requested | planned | approved | executing | completed | rejected | failed
      agent_request_json TEXT NOT NULL DEFAULT '{}',
      agent_plan_json TEXT NOT NULL DEFAULT '{}',
      approved_plan_json TEXT NOT NULL DEFAULT '{}',
      tools_executed_json TEXT NOT NULL DEFAULT '[]',
      tool_results_json TEXT NOT NULL DEFAULT '[]',
      writeback_result_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    UPDATE settings SET value='2' WHERE key='schema_version';
    `
  }
];

export class Store {
  private db: DatabaseSync;

  constructor(cfg: HelperConfig) {
    const existed = fs.existsSync(cfg.dbPath);
    if (existed) this.backupBeforeMigrate(cfg.dbPath);
    this.db = new DatabaseSync(cfg.dbPath);
    this.db.exec("PRAGMA journal_mode=WAL;");
    this.db.exec("PRAGMA foreign_keys=ON;");
    this.migrate(existed);
  }

  private backupBeforeMigrate(dbPath: string) {
    try {
      const bak = dbPath + ".bak-" + new Date().toISOString().replace(/[:.]/g, "-");
      fs.copyFileSync(dbPath, bak);
    } catch (e) { /* noop */ }
  }

  private migrate(existed: boolean) {
    let current = 0;
    if (existed) {
      try {
        const row = this.db.prepare("SELECT value FROM settings WHERE key='schema_version'").get() as { value: string } | undefined;
        current = row ? Number(row.value) : 0;
      } catch (e) { current = 0; }
    }
    if (current === SCHEMA_VERSION) return;
    try {
      this.db.exec("BEGIN;");
      for (const m of MIGRATIONS) {
        if (m.version <= current) continue;
        this.db.exec(m.sql);
        this.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version', ?)").run(String(m.version));
        current = m.version;
      }
      this.db.exec("COMMIT;");
    } catch (e) {
      this.db.exec("ROLLBACK;");
      throw new Error("DB migration failed: " + String(e));
    }
  }

  get schemaVersion(): number {
    const row = this.db.prepare("SELECT value FROM settings WHERE key='schema_version'").get() as { value: string } | undefined;
    return row ? Number(row.value) : 0;
  }

  get raw(): DatabaseSync { return this.db; }

  close() {
    try { this.db.close(); } catch (e) { /* noop */ }
  }
}
