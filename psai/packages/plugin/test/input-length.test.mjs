/**
 * 输入框不许再被 256 个字符卡住。
 *
 * UXP 的 input / textarea **默认最多收 256 个字符**，超出的静默丢掉 ——
 * 没有报错、没有事件。这个上限不在我们代码里（全库没有一处 maxlength），
 * 是宿主的默认值，而它连着坑了好几轮：
 *
 *   ComfyUI 的工作流 JSON（几十 KB）粘进去只剩开头一截
 *   RunningHub 的 curl 粘不全，于是解析不出 nodeInfoList，
 *     报出来的是「没能找到 nodeInfoList」，看起来像我们不认他的格式
 *   提示词写长一点就被截断，而界面右下角的计数器停在 256 —— 那就是证据
 *
 * 修法是在 h() 这个唯一的创建点统一给一个大 maxlength。
 * 这一组用例对着**真实的 h()** 跑，不是对着我以为的那份。
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { installUxpDom } from './uxp-dom.mjs';

const here = dirname(fileURLToPath(import.meta.url));
let dom;
let dm;
let tmp;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'psai-inputlen-'));
  dom = installUxpDom();
  const outfile = join(tmp, 'dom.test.mjs');
  await build({
    stdin: {
      contents: "export { h } from '../src/app/dom.js';",
      resolveDir: here,
      loader: 'ts'
    },
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent'
  });
  dm = await import(pathToFileURL(outfile).href);
});

after(() => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* noop */
  }
});

/** 比 UXP 的默认上限长得多的一段文字 */
const LONG = 'x'.repeat(5000);

test('textarea 收得下五千字 —— 不再被截到 256', () => {
  const ta = dm.h('textarea', { class: 'input' });
  ta.value = LONG;
  assert.equal(ta.value.length, LONG.length, `被截断了：只剩 ${ta.value.length} 个字符`);
});

test('input 同样收得下', () => {
  const el = dm.h('input', { type: 'text' });
  el.value = LONG;
  assert.equal(el.value.length, LONG.length);
});

test('一份几十 KB 的工作流 JSON 能完整放进去', () => {
  // 真实场景：ComfyUI 导出的图。之前永远只进去开头，用户以为是粘贴坏了。
  const graph = {};
  for (let i = 0; i < 400; i++) {
    graph[String(i)] = { class_type: 'KSampler', inputs: { seed: i, text: '一段中文提示词'.repeat(3) } };
  }
  const json = JSON.stringify(graph);
  assert.ok(json.length > 20000, '这份夹具本身要够大才有意义');

  const ta = dm.h('textarea', {});
  ta.value = json;
  assert.equal(ta.value.length, json.length);
  // 能原样解析回来，才说明一个字符都没丢
  assert.equal(Object.keys(JSON.parse(ta.value)).length, 400);
});

test('调用方自己写了 maxlength 的，原样尊重', () => {
  // 真要限长的场合（比如某个只该填几位数字的框）不能被这条通用规则顶掉。
  const el = dm.h('input', { type: 'text', maxlength: '10' });
  el.value = LONG;
  assert.equal(el.value.length, 10);
});

test('非输入类元素不碰 maxlength', () => {
  const div = dm.h('div', { class: 'x' });
  assert.equal(div.getAttribute('maxlength'), null);
});
