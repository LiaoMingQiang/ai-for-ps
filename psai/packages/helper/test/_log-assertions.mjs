/**
 * 集成测试的收尾断言：翻这个数据目录的日志，看有没有不该出现的东西。
 *
 * 为什么要单独抽出来、并且**每个**集成测试文件都调一次：
 * 这两类问题都不会让任何用例变红。非法转移只是被 transition() 拒绝 +
 * 记一条 warn；唯一约束冲突会被事务吞掉然后走别的分支。
 * 它们会一直积着，直到某天某条路径真的因为被拒而卡死 ——
 * 而那时候现场早就没了。所以要在每个套件跑完时主动查一遍。
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

function logsOf(dataDir) {
  const dir = join(dataDir, 'logs');
  if (!existsSync(dir)) return '';
  return readdirSync(dir)
    .filter((f) => f.endsWith('.log') || f.endsWith('.old'))
    .map((f) => readFileSync(join(dir, f), 'utf8'))
    .join('\n');
}

/**
 * 断言这一轮跑下来没有非法状态转移、也没有撞唯一约束。
 *
 * @param dataDir Helper 的数据目录
 * @param opts.allow 明确允许的片段（用例故意造的现场），传进来的每一条
 *                   都应该在调用处写清楚为什么它是预期的
 */
export function assertCleanLog(dataDir, opts = {}) {
  const allow = opts.allow ?? [];
  const text = logsOf(dataDir);
  const lines = text.split('\n');

  /*
   * 先确认这份日志**能**记下我们要找的东西。
   *
   * 非法转移记在 warn 级别。跑测试时如果把 PSAI_LOG_LEVEL 设成 error，
   * warn 根本不会落盘 —— 这个检查就变成了一句永远为真的空话，
   * 而且是安静地变空：套件全绿，问题一条也查不出来。
   * 宁可在这里明确报出来，也不要留一个看起来在守、其实什么都不守的断言。
   */
  const level = process.env['PSAI_LOG_LEVEL'] ?? 'info';
  assert.ok(
    !['error'].includes(level),
    `PSAI_LOG_LEVEL=${level} 会把 warn 级别的日志全部丢掉，` +
      '而非法状态转移正是记在 warn 上的 —— 这个检查会变成一句空话。' +
      '集成测试请用默认级别（info）或更低。'
  );
  assert.ok(text.length > 0, `${dataDir} 下没有任何日志，这个检查无从谈起`);

  const bad = lines.filter(
    (l) =>
      (l.includes('非法状态转移') || /UNIQUE constraint failed/.test(l)) && !allow.some((a) => l.includes(a))
  );
  assert.deepEqual(
    bad,
    [],
    `日志里出现了不该有的东西（非法状态转移 / 唯一约束冲突）：\n${bad.slice(0, 10).join('\n')}`
  );
}
