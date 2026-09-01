/**
 * 测试运行器自己的回归用例。
 *
 * 门禁本身没人守的话，它坏掉的样子是最坏的那一种：**依然全绿**。
 *
 * 真实发生过的：`PSAI_TEST_REPEAT=not-a-number` → `Number()` 得到 NaN
 * → `Math.max(1, NaN)` 还是 NaN → `for (i = 1; i <= NaN; i++)` 一轮都不跑
 * → 照样打印 TESTS-OK、退出码 0。一次拼错的环境变量换来一个
 * 什么都没验过的"全部通过"，而且没有任何迹象。
 *
 * 所以这里守两件事：
 *   1. 非法的环境变量必须让命令**失败**，不能兜底成默认值
 *   2. 一个套件都没发现时必须失败，"零个测试全部通过"不算通过
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { positiveInt } from '../../../tools/env-int.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const runner = resolve(here, '../../../tools/run-tests.mjs');

test('没设置时用默认值', () => {
  assert.equal(positiveInt('X', undefined, 4), 4);
  assert.equal(positiveInt('X', '', 4), 4);
  assert.equal(positiveInt('X', null, 7), 7);
});

test('正常的正整数照收', () => {
  assert.equal(positiveInt('X', '1', 4), 1);
  assert.equal(positiveInt('X', '12', 4), 12);
  assert.equal(positiveInt('X', ' 3 ', 4), 3, '两边的空格不算错');
});

test('这些写法一个都不能收 —— 收下只会让错误更难发现', () => {
  /*
   * 每一条都是 Number() 会默默接受的。
   * 'not-a-number' 是真踩过的那一个；其余几条同样会让轮数变成
   * 一个没人想要的值（0 轮、1000 轮、1.9 轮、无穷轮）。
   */
  for (const bad of [
    'not-a-number',
    '0', // 跑 0 轮等于什么都没测
    '-1',
    '1.9',
    '1e3', // 科学计数法：其实是 1000 轮
    '0x10', // 十六进制：其实是 16 轮
    'Infinity',
    'NaN',
    '  ',
    '3abc',
    '+3'
  ]) {
    assert.throws(
      () => positiveInt('PSAI_TEST_REPEAT', bad, 1),
      /必须是/,
      `「${bad}」不该被接受`
    );
  }
});

test('超出安全整数范围也拒', () => {
  assert.throws(() => positiveInt('X', '99999999999999999999', 1), /必须是/);
});

/* ==================== 真的跑一次命令 ==================== */

function runRunner(env) {
  return spawnSync(process.execPath, [runner], {
    cwd: resolve(here, '../../..'),
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 120_000
  });
}

test('非法的 PSAI_TEST_REPEAT 让整条命令失败，而不是一声不吭地跳过所有测试', () => {
  /*
   * 这条是整个文件的理由。旧行为是：一个测试都不跑，
   * 打印 TESTS-OK，退出码 0 —— 在 CI 上就是一块绿牌子。
   */
  const r = runRunner({ PSAI_TEST_REPEAT: 'not-a-number' });
  assert.notEqual(r.status, 0, '必须以非零退出码结束');
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  assert.match(out, /TESTS-FAIL/, '要明确说失败');
  assert.match(out, /PSAI_TEST_REPEAT/, '要指出是哪个变量');
  assert.ok(!/TESTS-OK/.test(out), '绝不能同时打印 TESTS-OK');
});

test('非法的 PSAI_TEST_CONCURRENCY 同样让命令失败', () => {
  const r = runRunner({ PSAI_TEST_CONCURRENCY: '0' });
  assert.notEqual(r.status, 0);
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  assert.match(out, /TESTS-FAIL/);
  assert.match(out, /PSAI_TEST_CONCURRENCY/);
  assert.ok(!/TESTS-OK/.test(out));
});

/* ==================== 临时 Helper 一律不许探宿主机 ==================== */

test('每个测试里起的 Helper 都必须是 ephemeral（或显式关掉探测）', () => {
  /*
   * 新数据目录的默认 ComfyUI 地址是 http://127.0.0.1:8188 ——
   * 那是用户本机真实 ComfyUI 的地址。十几个套件各起一个 Helper，
   * 就会一起去敲它：轻则把它压出超时（我们这边表现为一批用例
   * 卡在 15 秒整数上失败），重则在别人正干活的时候插一脚。
   *
   * 这条检查是给**将来**的：漏掉 ephemeral 不会让任何用例变红，
   * 只会让整个套件在某些机器上偶尔慢、偶尔挂 —— 那种问题查起来
   * 会一路查到网络和 Photoshop 上去，跟真正的原因差着十万八千里。
   */
  const testDirs = [resolve(here, '..'), resolve(here, '../../plugin/test')];
  const offenders = [];

  for (const dir of testDirs) {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.test.mjs')) continue;
      const src = readFileSync(resolve(dir, name), 'utf8');
      // 找每一次 startHelper(...)，看它那一对括号里有没有关掉探测
      let i = 0;
      while ((i = src.indexOf('startHelper(', i)) >= 0) {
        let depth = 0;
        let j = i + 'startHelper'.length;
        for (; j < src.length; j++) {
          if (src[j] === '(') depth++;
          else if (src[j] === ')') {
            depth--;
            if (depth === 0) break;
          }
        }
        const call = src.slice(i, j + 1);
        if (!/ephemeral\s*:\s*true/.test(call) && !/probeOnStart\s*:\s*false/.test(call)) {
          offenders.push(`${name}: ${call.replace(/\s+/g, ' ').slice(0, 100)}`);
        }
        i = j + 1;
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `这些 Helper 会去探宿主机上真实的 ComfyUI：\n  ${offenders.join('\n  ')}`
  );
});
