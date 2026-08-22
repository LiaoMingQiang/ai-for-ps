/**
 * 日志抗洪测试。
 *
 * 起因：一个卡在重试循环里的客户端，几分钟就往日志写了 2.9MB 同一句
 * "拒绝跨域来源"，把 Helper 拖到面板都点不动。
 * 日志没有上限，等于任何行为不端的客户端都能写满用户磁盘。
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Logger } from '../dist/log.js';

let dir;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'psai-log-'));
});

after(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* noop */
  }
});

function logFiles() {
  return readdirSync(dir).filter((n) => n.startsWith('helper-'));
}

function totalBytes() {
  return logFiles().reduce((s, n) => s + statSync(join(dir, n)).size, 0);
}

test('同一条重复告警只写一次，其余只计数', () => {
  const log = new Logger(dir, 'info', false);
  for (let i = 0; i < 5000; i++) {
    log.throttled('warn', 'cors:http://evil.example', '拒绝跨域来源', { origin: 'http://evil.example' });
  }
  const bytes = totalBytes();
  assert.ok(bytes < 4000, `5000 次重复告警只该写极少量日志，实际 ${bytes} 字节`);

  const content = readFileSync(join(dir, logFiles()[0]), 'utf8');
  const lines = content.trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 1, `应该只落一行，实际 ${lines.length} 行`);
});

test('不同 key 各自独立限流，不会互相盖掉', () => {
  const log = new Logger(dir, 'info', false);
  const before = totalBytes();
  for (let i = 0; i < 100; i++) {
    log.throttled('warn', `origin-${i % 4}`, '拒绝跨域来源', { i });
  }
  const content = readFileSync(join(dir, logFiles()[0]), 'utf8');
  const lines = content.trim().split('\n').filter(Boolean);
  // 之前那条测试已经写了 1 行，这里 4 个不同 key 各写 1 行
  assert.equal(lines.length, 5, `4 个不同来源应各留一行，实际共 ${lines.length} 行`);
  assert.ok(totalBytes() > before);
});

test('限流窗口到期后补一行汇总，说明被抑制了多少次', () => {
  const log = new Logger(dir, 'info', false);
  const key = 'window-test';
  // 窗口设 0，第二次调用就应该触发汇总
  log.throttled('warn', key, '重复事件', { a: 1 }, 0);
  log.throttled('warn', key, '重复事件', { a: 1 }, 0);

  const content = readFileSync(join(dir, logFiles()[0]), 'utf8');
  assert.match(content, /重复事件/);
});

test('内容各不相同的洪水也压不垮：超过上限自动轮转', () => {
  const fresh = mkdtempSync(join(tmpdir(), 'psai-log2-'));
  try {
    const log = new Logger(fresh, 'info', false);
    const filler = 'x'.repeat(2000);
    // 写约 12MB，超过 8MB 上限
    for (let i = 0; i < 6000; i++) log.info(`事件 ${i} ${filler}`);

    const names = readdirSync(fresh);
    const current = names.filter((n) => n.endsWith('.log'));
    const rotated = names.filter((n) => n.endsWith('.old'));

    assert.equal(current.length, 1, '当前日志应只有一个');
    assert.ok(rotated.length >= 1, '超过上限应产生归档文件');

    const currentSize = statSync(join(fresh, current[0])).size;
    assert.ok(currentSize < 9 * 1024 * 1024, `当前日志不该无限长，实际 ${currentSize} 字节`);
  } finally {
    try {
      rmSync(fresh, { recursive: true, force: true });
    } catch {
      /* noop */
    }
  }
});

test('限流不影响脱敏：抑制后补写的汇总同样不能漏密钥', () => {
  const fresh = mkdtempSync(join(tmpdir(), 'psai-log3-'));
  try {
    const log = new Logger(fresh, 'info', false);
    log.throttled('warn', 'k', '带密钥的事件', { apiKey: 'sk-abcdefghijklmnop1234' }, 0);
    log.throttled('warn', 'k', '带密钥的事件', { apiKey: 'sk-abcdefghijklmnop1234' }, 0);
    const content = readFileSync(join(fresh, readdirSync(fresh)[0]), 'utf8');
    assert.ok(!content.includes('sk-abcdefghijklmnop1234'), '明文密钥绝不能进日志');
    assert.match(content, /••/, '应该是掩码形式');
  } finally {
    try {
      rmSync(fresh, { recursive: true, force: true });
    } catch {
      /* noop */
    }
  }
});
