/**
 * 导入工作流时，粘贴框里的东西要被当人话解释。
 *
 * 真机上的现象：名称填了「111」，JSON 框空着，点「导入」，界面红字显示
 * 「Unexpected end of JSON input」。那是 V8 的内部错误原样端了出来 ——
 * 用户看到的是插件坏了，而不是「你还没粘东西」。「扫描」按钮同一个毛病，
 * 两个按钮当时都是裸的 `JSON.parse(jsonArea.value)`。
 *
 * 这一组用例钉死几种真实会发生的粘贴情况各自该说什么。对着旧实现跑，
 * 第一条就红：旧代码抛的是英文的 SyntaxError，不含任何可操作的提示。
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));

let mod;
let dir;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'psai-wfimport-'));
  const entry = join(here, '.wf-import-entry.mjs');
  writeFileSync(entry, "export { parseGraphInput } from '../src/ui/page-settings.js';\n", 'utf8');
  const outfile = join(dir, 'wf-import.mjs');
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: ['es2022'],
    plugins: [
      {
        name: 'uxp-stub',
        setup(b) {
          b.onResolve({ filter: /^(photoshop|uxp|os|fs)$/ }, (a) => ({ path: a.path, namespace: 'uxp-stub' }));
          b.onLoad({ filter: /.*/, namespace: 'uxp-stub' }, () => ({
            contents: `
              const notInPs = () => { throw new Error('UXP-ONLY'); };
              export const app = { get documents() { return []; }, activeDocument: null };
              export const action = { batchPlay: notInPs, addNotificationListener: () => {} };
              export const core = { executeAsModal: notInPs };
              export const constants = {}; export const imaging = {};
              export const storage = { localFileSystem: {} };
              export const shell = { openExternal: () => {} };
              export const versions = { uxp: '8.0.0', photoshop: '26.0.0' };
              export default { app, action, core, constants, imaging, storage, shell, versions };
            `,
            loader: 'js'
          }));
        }
      }
    ],
    logLevel: 'silent'
  });
  rmSync(entry, { force: true });
  mod = await import(pathToFileURL(outfile).href);
});

after(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* noop */
  }
});

/** 抓住抛出来的消息，没抛就让用例失败。 */
function messageOf(input) {
  try {
    mod.parseGraphInput(input);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  assert.fail(`本该抛错，却通过了：${JSON.stringify(input).slice(0, 60)}`);
}

test('空文本框：说「还没粘」，而不是把 V8 的英文错误端出来', () => {
  for (const empty of ['', '   ', '\n\t ']) {
    const msg = messageOf(empty);
    assert.match(msg, /粘贴/, `应当提示去粘贴，实际是：${msg}`);
    // 这一条是本次修复的核心：旧实现漏出来的就是这句英文
    assert.doesNotMatch(msg, /Unexpected end of JSON input/, '不许把 JSON.parse 的原始错误直接显示给用户');
  }
});

test('粘到一半被截断：明说是截断，并报出当前字符数', () => {
  const truncated = '{"3": {"class_type": "KSampler", "inputs": {"seed": 12';
  const msg = messageOf(truncated);
  assert.match(msg, /截断/, `应当点明是截断，实际是：${msg}`);
  assert.match(msg, new RegExp(String(truncated.length)), '应当带上当前字符数，方便用户判断少了多少');
});

test('粘的是网页而不是 JSON：直接说清楚，并给出正确做法', () => {
  const msg = messageOf('<!doctype html><html><body>ComfyUI</body></html>');
  assert.match(msg, /网页/, `应当说是网页，实际是：${msg}`);
  assert.match(msg, /导出\(API\)/, '应当告诉用户去用「导出(API)」');
});

test('顶层不是对象：数组和字符串都要被拦下', () => {
  assert.match(messageOf('[1, 2, 3]'), /顶层/);
  assert.match(messageOf('"just a string"'), /顶层/);
  assert.match(messageOf('42'), /顶层/);
});

test('合法但空的对象：不是「导入成功但零节点」，而是明确报空', () => {
  assert.match(messageOf('{}'), /空的/);
});

test('从聊天窗口复制带出来的 ``` 围栏：容错，不该让用户自己去掉', () => {
  const graph = { 3: { class_type: 'KSampler', inputs: { seed: 1 } } };
  const fenced = '```json\n' + JSON.stringify(graph) + '\n```';
  assert.deepEqual(mod.parseGraphInput(fenced), graph);
});

test('BOM 打头也要能解析', () => {
  const graph = { 9: { class_type: 'SaveImage', inputs: {} } };
  assert.deepEqual(mod.parseGraphInput('﻿' + JSON.stringify(graph)), graph);
});

test('提示词里带花括号的图不算截断（权重语法很常见）', () => {
  // ComfyUI 的提示词经常写成 {best quality|masterpiece}、(word:1.2) 这类。
  // 截断判据是数括号，如果不排除字符串内部，这种正常的图会被误判成"粘了半截"。
  const graph = {
    6: { class_type: 'CLIPTextEncode', inputs: { text: '{best quality|masterpiece}, [detailed], (sharp:1.2)' } },
    9: { class_type: 'SaveImage', inputs: { images: ['6', 0] } }
  };
  assert.deepEqual(mod.parseGraphInput(JSON.stringify(graph)), graph);
});

test('字符串里带转义引号也不该被当成截断', () => {
  const graph = { 6: { class_type: 'CLIPTextEncode', inputs: { text: 'a \\"quoted\\" word {x' } } };
  const json = JSON.stringify(graph);
  assert.deepEqual(mod.parseGraphInput(json), graph);
});

test('正常的 API 格式图原样返回', () => {
  const graph = {
    3: { class_type: 'KSampler', inputs: { seed: 42, steps: 20 } },
    9: { class_type: 'SaveImage', inputs: { images: ['3', 0] } }
  };
  assert.deepEqual(mod.parseGraphInput(JSON.stringify(graph, null, 2)), graph);
});
