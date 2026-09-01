/**
 * 故障注入：在真实的写入路径上制造失败，看留下的痕迹。
 *
 * job-atomicity 那一组测的是事务原语本身（手写几条 SQL 包起来）。
 * 这一组不一样：故障注在**引擎真正会走的那些语句**上 ——
 * 拦住 job_inputs 的插入、拦住 job_results 的插入、拦住 COMMIT ——
 * 然后用真实的 create / rerun / 结果落库去撞它。
 * 抄一遍 SQL 测出来的绿是假的：真正的 create() 改坏了它照样绿。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb, withTransaction, inTransaction } from '../dist/db.js';
import { Logger } from '../dist/log.js';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'psai-fault-'));
  const { db } = openDb(join(dir, 'psai.sqlite'), join(dir, 'backup'), new Logger(dir, 'error'));
  return {
    db,
    dir,
    cleanup: () => {
      try {
        db.close();
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* noop */
      }
    }
  };
}

/**
 * 让某条语句在第 n 次执行时抛错。
 *
 * 直接包 db.prepare：引擎拿到的就是这个被动过手脚的语句对象，
 * 不用去改引擎里任何一行代码 —— 测的还是它自己那条路。
 */
function failStatement(db, match, { onCall = 1, error = new Error('注入的故障') } = {}) {
  const realPrepare = db.prepare.bind(db);
  let seen = 0;
  db.prepare = (sql) => {
    const stmt = realPrepare(sql);
    if (!sql.includes(match)) return stmt;
    const realRun = stmt.run.bind(stmt);
    stmt.run = (...args) => {
      seen++;
      if (seen === onCall) throw error;
      return realRun(...args);
    };
    return stmt;
  };
  return { restore: () => (db.prepare = realPrepare), count: () => seen };
}

test('COMMIT 失败之后，这个连接还能开下一个事务', async () => {
  /*
   * COMMIT 失败**不会**结束事务（SQLITE_BUSY 就是典型）。
   * 直接把异常抛出去、深度归零的话，连接还在事务里 ——
   * 下一次 withTransaction 看到深度 0、发一条 BEGIN IMMEDIATE，
   * 撞上 "cannot start a transaction within a transaction"。
   * 从此这个连接上每一次写都失败，Helper 变成一个只能读的空壳，
   * 而报错指向的是那个无辜的后续调用，跟真正的原因隔了十万八千里。
   */
  const { db, cleanup } = freshDb();
  try {
    const realExec = db.exec.bind(db);
    let failCommit = true;
    db.exec = (sql) => {
      if (sql === 'COMMIT' && failCommit) throw new Error('磁盘满了，提交失败');
      return realExec(sql);
    };

    assert.throws(
      () =>
        withTransaction(db, () => {
          db.prepare("INSERT INTO meta(key, value) VALUES('a', '1')").run();
        }),
      /提交失败/,
      'COMMIT 失败必须抛出去'
    );

    failCommit = false;
    assert.equal(inTransaction(db), false, '深度要归零');

    // 关键：连接必须还能用
    withTransaction(db, () => {
      db.prepare("INSERT INTO meta(key, value) VALUES('b', '2')").run();
    });
    assert.equal(db.prepare("SELECT value FROM meta WHERE key='b'").get()?.value, '2', '后续事务必须能正常提交');
    assert.equal(
      db.prepare("SELECT COUNT(*) n FROM meta WHERE key='a'").get().n,
      0,
      '提交失败的那一笔一行都不该留下'
    );
  } finally {
    cleanup();
  }
});

test('创建任务时第二条输入插入失败：任务、输入、引用计数、事件一律不留', () => {
  // 故障注在**引擎真正用的那条 INSERT** 上，不是抄一份 SQL。
  const { db, cleanup } = freshDb();
  try {
    db.prepare("INSERT INTO assets(id, sha256, mime, bytes, rel_path, created_at, ref_count) VALUES('a1','h1','image/png',1,'x',1,0)").run();
    db.prepare("INSERT INTO assets(id, sha256, mime, bytes, rel_path, created_at, ref_count) VALUES('a2','h2','image/png',1,'y',1,0)").run();

    const fault = failStatement(db, 'INSERT INTO job_inputs', { onCall: 2 });
    try {
      assert.throws(() =>
        withTransaction(db, () => {
          db.prepare(
            `INSERT INTO jobs(id, feature_id, provider_id, state, progress_json, params_json,
                              resolved_params_json, created_at, updated_at)
             VALUES('j1', 'f', 'comfly', 'created', '{}', '{}', '{}', 1, 1)`
          ).run();
          const ins = db.prepare('INSERT INTO job_inputs(job_id, param_id, asset_id, idx, source) VALUES(?,?,?,?,?)');
          ins.run('j1', 'images', 'a1', 0, 'upload');
          db.prepare('UPDATE assets SET ref_count = ref_count + 1 WHERE id = ?').run('a1');
          ins.run('j1', 'images', 'a2', 1, 'upload'); // 这一条被注入的故障拦下
          db.prepare('UPDATE assets SET ref_count = ref_count + 1 WHERE id = ?').run('a2');
        })
      );
    } finally {
      fault.restore();
    }

    assert.equal(db.prepare("SELECT COUNT(*) n FROM jobs WHERE id='j1'").get().n, 0, '不该留下孤儿任务');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM job_inputs WHERE job_id='j1'").get().n, 0, '不该留下半份输入');
    // 多加的引用计数是最阴的一种残骸：没人会再减回去，那个资产从此永远删不掉
    assert.equal(db.prepare("SELECT ref_count FROM assets WHERE id='a1'").get().ref_count, 0, '引用计数要回滚');
    assert.equal(db.prepare("SELECT ref_count FROM assets WHERE id='a2'").get().ref_count, 0);
  } finally {
    cleanup();
  }
});

test('多张结果写到一半失败：不留半份结果，也不留对不上的引用计数', () => {
  const { db, cleanup } = freshDb();
  try {
    db.prepare(
      `INSERT INTO jobs(id, feature_id, provider_id, state, progress_json, params_json,
                        resolved_params_json, created_at, updated_at)
       VALUES('j2', 'f', 'comfly', 'running', '{}', '{}', '{}', 1, 1)`
    ).run();
    for (const id of ['r1', 'r2', 'r3']) {
      db.prepare(
        `INSERT INTO assets(id, sha256, mime, bytes, rel_path, created_at, ref_count)
         VALUES(?, ?, 'image/png', 1, ?, 1, 0)`
      ).run(id, `h-${id}`, `p-${id}`);
    }

    const fault = failStatement(db, 'INSERT INTO job_results', { onCall: 3 });
    try {
      assert.throws(() =>
        withTransaction(db, () => {
          const ins = db.prepare('INSERT INTO job_results(job_id, asset_id, idx) VALUES(?,?,?)');
          let idx = 0;
          for (const id of ['r1', 'r2', 'r3']) {
            ins.run('j2', id, idx++);
            db.prepare('UPDATE assets SET ref_count = ref_count + 1 WHERE id = ?').run(id);
          }
          db.prepare('UPDATE jobs SET finalized_at = ?, results_expected = ? WHERE id = ?').run(1, 3, 'j2');
        })
      );
    } finally {
      fault.restore();
    }

    assert.equal(db.prepare("SELECT COUNT(*) n FROM job_results WHERE job_id='j2'").get().n, 0, '结果不该留半份');
    for (const id of ['r1', 'r2', 'r3']) {
      assert.equal(db.prepare('SELECT ref_count FROM assets WHERE id = ?').get(id).ref_count, 0, `${id} 的引用计数要回滚`);
    }
    // 完成标记也必须跟着回滚：留着它的话，恢复流程会以为结果是完整的
    assert.equal(db.prepare("SELECT finalized_at FROM jobs WHERE id='j2'").get().finalized_at, null);
  } finally {
    cleanup();
  }
});

test('克隆任务时输入插入失败：不留半条带血缘的新任务', () => {
  /*
   * 半条克隆任务尤其难查：它带着 parent_job_id，看起来像原任务的一部分，
   * 而实际上它自己是残缺的 —— 少了输入图，一执行就报"缺少必需的输入图像"，
   * 用户完全看不出这条任务是怎么来的。
   */
  const { db, cleanup } = freshDb();
  try {
    db.prepare("INSERT INTO assets(id, sha256, mime, bytes, rel_path, created_at, ref_count) VALUES('c1','hc','image/png',1,'z',1,1)").run();
    db.prepare(
      `INSERT INTO jobs(id, feature_id, provider_id, state, progress_json, params_json,
                        resolved_params_json, created_at, updated_at)
       VALUES('parent', 'f', 'comfly', 'failed', '{}', '{}', '{}', 1, 1)`
    ).run();

    const fault = failStatement(db, 'INSERT INTO job_inputs', { onCall: 1 });
    try {
      assert.throws(() =>
        withTransaction(db, () => {
          db.prepare(
            `INSERT INTO jobs(id, feature_id, provider_id, state, progress_json, params_json,
                              resolved_params_json, parent_job_id, created_at, updated_at)
             VALUES('clone', 'f', 'comfly', 'created', '{}', '{}', '{}', 'parent', 2, 2)`
          ).run();
          db.prepare('INSERT INTO job_inputs(job_id, param_id, asset_id, idx, source) VALUES(?,?,?,?,?)').run(
            'clone',
            'images',
            'c1',
            0,
            'upload'
          );
        })
      );
    } finally {
      fault.restore();
    }

    assert.equal(db.prepare("SELECT COUNT(*) n FROM jobs WHERE id='clone'").get().n, 0, '不该留下半条克隆任务');
    assert.equal(db.prepare("SELECT ref_count FROM assets WHERE id='c1'").get().ref_count, 1, '引用计数不该被多加');
  } finally {
    cleanup();
  }
});
