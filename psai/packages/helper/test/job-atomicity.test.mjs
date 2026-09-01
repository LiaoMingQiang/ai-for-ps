/**
 * 事务原语（withTransaction）的行为。
 *
 * 这一组守的是一句话：**创建失败 == 什么都没发生**。
 *
 * 以前不是这样。create() 顺序裸写 jobs → job_inputs → 资产引用计数 →
 * 文档记录 → 事件流，中间任何一步抛异常，前面写进去的就留在库里了。
 * 最容易触发的是 job_inputs 的主键 (job_id, param_id, idx)：
 * 同一个位置提交两张图，第一张写进去、引用计数也加了，第二张才撞 UNIQUE。
 * 留下的残骸有三种，每一种都有独立的坏处：
 *   - created 状态的孤儿任务：Helper 重启后 recover() 会看到它并尝试执行
 *     —— 一次失败的创建请求，最后变成一次真的提交（云端还会计费）
 *   - 半份 job_inputs：任务看起来"少了一张输入图"
 *   - 多加的资产引用计数：没人会再减回来，那个资产从此永远删不掉
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb, withTransaction, inTransaction } from '../dist/db.js';
import { Logger } from '../dist/log.js';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'psai-tx-'));
  const { db } = openDb(join(dir, 'psai.sqlite'), join(dir, 'backup'), new Logger(dir, 'error'));
  return { db, dir, cleanup: () => { try { db.close(); rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ } } };
}

/* ---------------- 事务原语 ---------------- */

test('提交成功的写入留得下来', () => {
  const { db, cleanup } = freshDb();
  try {
    withTransaction(db, () => {
      db.prepare("INSERT INTO meta(key, value) VALUES('a', '1')").run();
    });
    assert.equal(db.prepare("SELECT value FROM meta WHERE key='a'").get()?.value, '1');
  } finally { cleanup(); }
});

test('抛异常时整段回滚，一行都不留', () => {
  const { db, cleanup } = freshDb();
  try {
    assert.throws(() =>
      withTransaction(db, () => {
        db.prepare("INSERT INTO meta(key, value) VALUES('b', '1')").run();
        db.prepare("INSERT INTO meta(key, value) VALUES('c', '2')").run();
        throw new Error('boom');
      })
    );
    assert.equal(db.prepare("SELECT COUNT(*) n FROM meta WHERE key IN ('b','c')").get().n, 0);
  } finally { cleanup(); }
});

test('原始异常不会被回滚过程盖掉', () => {
  // 回滚失败时如果再抛一次，排查现场只剩 "cannot rollback"，看不到真正的原因
  const { db, cleanup } = freshDb();
  try {
    assert.throws(
      () => withTransaction(db, () => { throw new Error('真正的原因'); }),
      /真正的原因/
    );
  } finally { cleanup(); }
});

test('嵌套事务用 SAVEPOINT，内层回滚不影响外层', () => {
  // SQLite 不允许嵌套 BEGIN（会报 cannot start a transaction within a transaction）。
  // 内层必须走 SAVEPOINT，否则任何一个"顺手包一层事务"的调用都会炸。
  const { db, cleanup } = freshDb();
  try {
    withTransaction(db, () => {
      db.prepare("INSERT INTO meta(key, value) VALUES('outer', '1')").run();
      try {
        withTransaction(db, () => {
          db.prepare("INSERT INTO meta(key, value) VALUES('inner', '1')").run();
          throw new Error('内层失败');
        });
      } catch { /* 内层的失败不该带走外层 */ }
    });
    assert.equal(db.prepare("SELECT COUNT(*) n FROM meta WHERE key='outer'").get().n, 1, '外层应保留');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM meta WHERE key='inner'").get().n, 0, '内层应回滚');
  } finally { cleanup(); }
});

test('嵌套全部成功时一起提交', () => {
  const { db, cleanup } = freshDb();
  try {
    withTransaction(db, () => {
      db.prepare("INSERT INTO meta(key, value) VALUES('o', '1')").run();
      withTransaction(db, () => {
        db.prepare("INSERT INTO meta(key, value) VALUES('i', '1')").run();
      });
    });
    assert.equal(db.prepare("SELECT COUNT(*) n FROM meta WHERE key IN ('o','i')").get().n, 2);
  } finally { cleanup(); }
});

test('事务结束后深度归零，不会把后续写入一直挂在事务里', () => {
  const { db, cleanup } = freshDb();
  try {
    assert.equal(inTransaction(db), false);
    withTransaction(db, () => { assert.equal(inTransaction(db), true); });
    assert.equal(inTransaction(db), false, '正常提交后要归零');
    try { withTransaction(db, () => { throw new Error('x'); }); } catch { /* 预期 */ }
    assert.equal(inTransaction(db), false, '异常回滚后也要归零');
  } finally { cleanup(); }
});

test('嵌套深度按连接记，不同连接互不干扰', () => {
  // 用一个模块级计数器的话：A 开着事务时 B 会以为自己也在事务里，
  // 于是该 BEGIN 的地方发了 SAVEPOINT，直接报 "no such savepoint"。
  const a = freshDb();
  const b = freshDb();
  try {
    withTransaction(a.db, () => {
      assert.equal(inTransaction(a.db), true);
      assert.equal(inTransaction(b.db), false, 'A 的事务不该让 B 也算在事务里');
      // B 此时必须还能正常开自己的事务
      withTransaction(b.db, () => {
        b.db.prepare("INSERT INTO meta(key, value) VALUES('bkey', '1')").run();
      });
    });
    assert.equal(b.db.prepare("SELECT value FROM meta WHERE key='bkey'").get()?.value, '1');
  } finally { a.cleanup(); b.cleanup(); }
});

test('COMMIT 失败必须抛出去，不能报成成功', () => {
  // 这是最危险的一种假成功：调用方拿到"创建成功"，
  // 面板上出现一个任务，而数据库里什么都没有。
  const { db, cleanup } = freshDb();
  try {
    const realExec = db.exec.bind(db);
    db.exec = (sql) => {
      if (sql === 'COMMIT') throw new Error('磁盘满了，提交失败');
      return realExec(sql);
    };
    assert.throws(
      () => withTransaction(db, () => { db.prepare("INSERT INTO meta(key,value) VALUES('x','1')").run(); }),
      /提交失败/,
      'COMMIT 失败必须一路抛给调用方'
    );
  } finally { cleanup(); }
});

test('回滚也失败时保留原始业务异常，把回滚错误挂在上面', () => {
  // 原始异常说明了业务为什么失败，是更有价值的那个。
  // 用回滚错误覆盖它的话，排查现场只剩一句 "cannot rollback"。
  const { db, cleanup } = freshDb();
  try {
    const realExec = db.exec.bind(db);
    db.exec = (sql) => {
      if (sql === 'ROLLBACK') throw new Error('回滚也炸了');
      return realExec(sql);
    };
    try {
      withTransaction(db, () => { throw new Error('真正的业务失败'); });
      assert.fail('应该抛出');
    } catch (e) {
      assert.match(String(e.message), /真正的业务失败/, '必须保留原始异常');
      assert.ok(e.rollbackError, '回滚错误要挂在原始异常上，不能丢');
      assert.match(String(e.rollbackError.message), /回滚也炸了/);
    }
  } finally { cleanup(); }
});

test('嵌套失败时 ROLLBACK TO 之后要 RELEASE，保存点不能留在栈上', () => {
  // ROLLBACK TO 只回退数据，保存点本身还在。不配对 RELEASE 的话，
  // 同名保存点会越堆越多，外层再 ROLLBACK TO 会退到错误的位置。
  const { db, cleanup } = freshDb();
  const seen = [];
  try {
    const realExec = db.exec.bind(db);
    db.exec = (sql) => { seen.push(sql); return realExec(sql); };
    withTransaction(db, () => {
      try {
        withTransaction(db, () => { throw new Error('内层失败'); });
      } catch { /* 预期 */ }
    });
    const idxRollback = seen.findIndex((s) => s.startsWith('ROLLBACK TO'));
    const idxRelease = seen.findIndex((s, i) => i > idxRollback && s.startsWith('RELEASE'));
    assert.ok(idxRollback >= 0, '应该有 ROLLBACK TO');
    assert.ok(idxRelease > idxRollback, 'ROLLBACK TO 之后必须紧跟 RELEASE');
  } finally { cleanup(); }
});

/*
 * 任务创建 / 结果落库的原子性**不在这个文件里**测。
 *
 * 这里只测事务原语本身。用手写 SQL 复刻一遍 create() 的写入序列，
 * 测到的只是"我抄的那几行 SQL 会回滚"—— 真正的 create() 改坏了它照样绿。
 * 那部分放在 submission-safety.test.mjs：真起 Helper、
 * 打真实的 POST /v1/jobs、比对库里的 jobs / job_inputs / job_events /
 * documents / assets.ref_count，以及重启后 recover() 看不看得到孤儿任务。
 */
