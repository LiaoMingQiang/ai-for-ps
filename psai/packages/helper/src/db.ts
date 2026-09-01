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
  ref_count  INTEGER NOT NULL DEFAULT 0,
  /*
   * 这张图的 alpha 通道**是不是**一次明确的选区遮罩。
   *
   * 一张图有 alpha 通道，不等于它带着用户的选区。透明背景的图层、
   * 抠过图的素材、带透明边的 PNG —— 全都天生有 alpha。
   * 靠遮罩工作的工作流（局部重绘那一族）拿这种"天然透明"当选区用的话，
   * 会去改一片用户完全没圈过的区域，而钱已经花掉了。
   * 所以要记下这个事实：只有真的合成过选区灰度的那一次才算数。
   */
  has_selection_mask INTEGER NOT NULL DEFAULT 0
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
  gpu_ms               INTEGER,
  /*
   * 结果落库的**完成标记**。
   *
   * 光看 COUNT(job_results) > 0 分不清"全都写完了"和"写了一半"。
   * 新代码里结果是在一个事务里整体落库的，理论上不会有一半 ——
   * 但老版本（非原子那一版）留下的库还躺在用户机器上，里面确实会有半份结果。
   * 恢复时把半份当成完整收尾，用户就永远少了几张图，而且没有任何提示。
   *
   * finalized_at 非空 = 这条任务的结果已经完整落库，可以放心跳过重下。
   * results_expected 记下当时一共该有几张，用来复核。
   */
  finalized_at         INTEGER,
  results_expected     INTEGER
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

CREATE TABLE IF NOT EXISTS submission_attempts (
  attempt_id      TEXT PRIMARY KEY,
  job_id          TEXT NOT NULL,
  provider_id     TEXT NOT NULL,
  -- 是否会产生费用。决定崩溃恢复时敢不敢自动重来。
  chargeable      INTEGER NOT NULL DEFAULT 0,
  -- 发给上游的幂等键（上游支持时）。同一个键重复提交，上游只会计一次费。
  idempotency_key TEXT,
  -- pending：已经发出去但还不知道结果（崩在这里最危险）
  -- accepted：上游确认收下了，remote_id 已拿到
  -- failed：上游明确拒绝，没有产生费用
  outcome         TEXT NOT NULL DEFAULT 'pending',
  remote_id       TEXT,
  detail          TEXT,
  started_at      INTEGER NOT NULL,
  finished_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_attempts_job ON submission_attempts(job_id);
CREATE INDEX IF NOT EXISTS idx_attempts_outcome ON submission_attempts(outcome);

/*
 * 写回尝试。
 *
 * 存在的理由是"最多写回一次"这句承诺需要一个能落盘的凭据。
 * 写回真正发生在插件里（只有它能碰 Photoshop），Helper 只能授权和记账。
 * 没有这张表的话，两个面板实例、或者一次手抖的双击，会各自写一遍 ——
 * 用户的文档里凭空多出一个图层，而两次都会回报"写回成功"。
 *
 * attempt_id 由 Helper 发放，插件回报时必须带上：
 * 带着过期凭据回来的那次会被丢掉，不会去动任务状态。
 */
CREATE TABLE IF NOT EXISTS writeback_attempts (
  attempt_id  TEXT PRIMARY KEY,
  job_id      TEXT NOT NULL,
  mode        TEXT NOT NULL,
  layer_name  TEXT NOT NULL DEFAULT '',
  asset_id    TEXT,
  -- 是不是自动写回触发的。排查"我没点它怎么自己写回了"时要看这一列。
  auto        INTEGER NOT NULL DEFAULT 0,
  -- running：凭据已发放，插件正在写
  -- succeeded / failed：插件回报了结果
  -- superseded：超时没等到回报，被后来的一次尝试顶替
  outcome     TEXT NOT NULL DEFAULT 'running',
  detail      TEXT,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_wb_attempts_job ON writeback_attempts(job_id);
CREATE INDEX IF NOT EXISTS idx_wb_attempts_outcome ON writeback_attempts(outcome);

/*
 * 文本类调用（反推提示词 / 优化提示词）的尝试与结果缓存。
 *
 * 这两步跑在**图像提交之前**，而且在付费平台上是真金白银的一次模型调用。
 * 没有这张表的时候有两个漏洞：
 *
 *  一、崩在反推中途，重启后任务重新入队，反推再跑一遍 —— 又付一次钱，
 *      而且没有任何地方记得上一次可能已经扣过了。
 *  二、图像提交失败、用户点重试，反推和优化会跟着重跑一遍。
 *      用户以为自己重试的是"生图"，实际上把前面那两次调用也重新买了一遍。
 *
 * cache_key 是 (功能 + 预设 + 输入内容) 的哈希：同样的输入必然得到同样的结果，
 * 所以命中就直接复用，一分钱都不用再花。
 */
CREATE TABLE IF NOT EXISTS text_tasks (
  attempt_id  TEXT PRIMARY KEY,
  job_id      TEXT NOT NULL,
  preset_id   TEXT NOT NULL,
  cache_key   TEXT NOT NULL,
  chargeable  INTEGER NOT NULL DEFAULT 0,
  -- pending：发出去了但还不知道结果（崩在这里 = 钱可能已经花了）
  -- succeeded：拿到文本，text 列可复用
  -- failed：明确失败，没有产生费用
  outcome     TEXT NOT NULL DEFAULT 'pending',
  text        TEXT,
  detail      TEXT,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_text_tasks_job ON text_tasks(job_id);
CREATE INDEX IF NOT EXISTS idx_text_tasks_cache ON text_tasks(cache_key, outcome);

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

/**
 * 补一列（已经有就什么也不做）。
 *
 * 纯追加的可空列不值得走一次版本迁移：迁移要备份整个库、要停机、
 * 失败还要回滚，而这里加的列老代码根本不看。
 * CREATE TABLE IF NOT EXISTS 对**已存在**的表不会补列，所以只能显式 ALTER。
 */
function ensureColumn(db: Db, table: string, column: string, decl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}

export function openDb(dbPath: string, backupsDir: string, log: Logger): OpenDbResult {
  const fresh = !existsSync(dbPath);
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');

  db.exec(SCHEMA_V1);
  // 老库里这两列不会因为 CREATE TABLE IF NOT EXISTS 而出现，得显式补
  ensureColumn(db, 'jobs', 'finalized_at', 'INTEGER');
  ensureColumn(db, 'jobs', 'results_expected', 'INTEGER');
  ensureColumn(db, 'assets', 'has_selection_mask', 'INTEGER NOT NULL DEFAULT 0');

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

/* ---------------- 事务 ---------------- */

/**
 * 每个连接各自的事务嵌套深度。
 *
 * 有它才能支持嵌套：外层已经开了事务时，内层用 SAVEPOINT 而不是再 BEGIN 一次
 * （SQLite 不允许嵌套 BEGIN，会直接报 "cannot start a transaction within a transaction"）。
 *
 * **按连接记，不能用一个模块级计数器。** 生产环境确实只有一个连接，
 * 但测试会同时开好几个库，迁移流程里也会临时开第二个连接 ——
 * 共用一个计数器的话，A 连接开着事务时 B 连接会误以为自己也在事务里，
 * 于是该 BEGIN 的地方发了 SAVEPOINT，直接报 "no such savepoint"。
 * 用 WeakMap 挂在连接上，连接关掉自然回收。
 */
const txDepth = new WeakMap<Db, number>();

/**
 * 把一组写操作变成一个原子单元。
 *
 * 为什么需要它：创建任务要连着写 jobs、job_inputs、资产引用计数、文档记录、
 * 事件流五张表。以前是顺序裸写 —— 中间任何一步抛异常，前面写进去的就留在库里了。
 * 最容易触发的是 job_inputs 的主键 (job_id, param_id, idx)：
 * 同一个位置提交两张图会在循环中途撞 UNIQUE，于是留下
 * 一个 created 状态的任务、半份输入、以及**已经加上去的资产引用计数**
 * —— 那个计数没人会再减回去，资产从此永远删不掉。
 *
 * 失败一律整体回滚，让"创建失败"真的等于"什么都没发生"。
 */
export function withTransaction<T>(db: Db, fn: () => T): T {
  const depth = txDepth.get(db) ?? 0;
  const savepoint = `psai_sp_${depth}`;
  const nested = depth > 0;

  // BEGIN IMMEDIATE 而不是 BEGIN：立刻拿写锁，避免升级锁时才发现冲突。
  db.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
  txDepth.set(db, depth + 1);

  let out: T;
  try {
    out = fn();
  } catch (appError) {
    // 业务代码失败：回滚。
    txDepth.set(db, depth);
    try {
      if (nested) {
        // ROLLBACK TO 只是把数据回退到保存点，**保存点本身还在栈上**。
        // 不配对 RELEASE 的话它会一直留着，外层再想 ROLLBACK TO 同名保存点
        // 会退到错误的位置。两句必须成对。
        db.exec(`ROLLBACK TO ${savepoint}`);
        db.exec(`RELEASE ${savepoint}`);
      } else {
        db.exec('ROLLBACK');
      }
    } catch (rollbackError) {
      // 回滚也失败了 —— 连接多半已经坏了。
      // 这时候原始异常才是更有价值的那个（它说明了业务为什么失败），
      // 所以把回滚错误挂在它身上带出去，而不是覆盖掉它。
      (appError as { rollbackError?: unknown }).rollbackError = rollbackError;
    }
    throw appError;
  }

  /*
   * 业务代码成功：提交。
   *
   * 两条铁律：
   *
   * 一、**绝不能吞异常**。COMMIT 失败意味着数据根本没落盘，
   *     而调用方会以为成功了 —— 任务创建返回 200、面板上出现一个任务，
   *     而数据库里什么都没有。宁可把失败如实抛出去。
   *
   * 二、抛之前必须先把事务收干净。这一条是补票补的：
   *     以前 COMMIT 一失败就直接抛，深度也归了零，可**连接还在事务里**
   *     （COMMIT 失败不会结束事务，SQLITE_BUSY 就是典型）。
   *     于是下一次 withTransaction 看到深度 0、发一条 BEGIN IMMEDIATE，
   *     撞上 "cannot start a transaction within a transaction"——
   *     从此这个连接上每一次写都失败，Helper 变成一个只能读的空壳，
   *     而报错指向的是那个无辜的后续调用，跟真正的原因隔了十万八千里。
   */
  try {
    if (nested) db.exec(`RELEASE ${savepoint}`);
    else db.exec('COMMIT');
  } catch (commitError) {
    try {
      if (nested) {
        db.exec(`ROLLBACK TO ${savepoint}`);
        db.exec(`RELEASE ${savepoint}`);
      } else {
        db.exec('ROLLBACK');
      }
    } catch (rollbackError) {
      // 回滚也失败：连接多半已经废了。把它挂在原始异常上带出去，
      // 至少让日志里能看出是"提交失败之后连回滚都没成功"。
      (commitError as { rollbackError?: unknown }).rollbackError = rollbackError;
    }
    txDepth.set(db, depth);
    throw commitError;
  }
  txDepth.set(db, depth);
  return out;
}

/** 这个连接当前是否在事务里。测试用来确认某段写操作确实被包住了。 */
export function inTransaction(db: Db): boolean {
  return (txDepth.get(db) ?? 0) > 0;
}
