/**
 * 设置页的两条界面契约。
 *
 * 一、任何一节渲染失败，都不许留下一片空白。
 *
 *    页签的 onclick 原来是 `void renderSettingsPage(host)` —— 分节里
 *    任何一处抛错都变成一条没人接的 rejection：页签在、标题在、内容没了，
 *    而且没有任何提示。用户看到的是"这一页坏了"，却说不出哪儿坏了，
 *    我们也查不下去。空白比报错糟得多。
 *
 * 二、开关必须有一个**真实的**滑块元素。
 *
 *    原来滑块是 `::after` 画的。伪元素在 UXP 上不可靠，一旦不渲染，
 *    开关就退化成一个空的圆角框 —— 开和关看起来一模一样。
 *    而这里控制的是「结果要不要自动写进你的文档」这种不能猜的事。
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

import { startHelper } from '../../helper/dist/index.js';
import { installUxpDom } from './uxp-dom.mjs';

const here = dirname(fileURLToPath(import.meta.url));

let helper;
let dataDir;
let ui;
let dom;
let PORT = 0;
let token;

async function bundleForTest(outfile) {
  const entry = join(here, '.settings-ui-entry.mjs');
  writeFileSync(
    entry,
    [
      "export { renderSettingsPage } from '../src/ui/page-settings.js';",
      "export { setState, getState } from '../src/app/store.js';",
      "export { api, useHelperAt } from '../src/app/api.js';"
    ].join('\n'),
    'utf8'
  );
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
}

async function api(method, path, body) {
  const headers = { Authorization: `Bearer ${token}` };
  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { method, headers, body: payload });
  return res.json();
}

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'psai-setui-'));
  helper = await startHelper({
    port: 0,
    dataDir,
    ephemeral: true,
    workflowsDir: resolve(here, '../../../workflows')
  });
  PORT = Number(new URL(helper.url).port);
  token = helper.issueToken();
  await helper.recovered;

  dom = installUxpDom();
  const outfile = join(dataDir, 'settings-ui.mjs');
  await bundleForTest(outfile);
  ui = await import(pathToFileURL(outfile).href);
  ui.useHelperAt(`http://127.0.0.1:${PORT}`, token);
});

after(async () => {
  await helper?.stop();
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* noop */
  }
});

async function renderSettings(tab) {
  ui.setState({
    booted: true,
    settings: (await api('GET', '/v1/settings')).settings,
    health: { online: true, version: 'test', paired: true, activeJobs: 0, comfyui: null, reason: null }
  });
  const host = dom.document.createElement('div');
  dom.root.appendChild(host);
  await ui.renderSettingsPage(host);
  if (tab) {
    const btn = host.querySelectorAll('button').find((b) => b.textContent === tab);
    assert.ok(btn, `找不到「${tab}」页签`);
    btn.dispatchEvent({ type: 'click', target: btn, currentTarget: btn });
    await new Promise((r) => setTimeout(r, 400));
  }
  return host;
}

test('某一节渲染失败时，页面给出可读的错误，而不是一片空白', async () => {
  /*
   * 「固定功能」那一页真机上就是这么消失的：页签在、标题在、内容没了，
   * 没有任何提示。这条用例把那种情况造出来 —— 让它依赖的接口失败。
   */
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (/\/v1\/features(\?|$)/.test(String(url))) throw new TypeError('fetch failed');
    return realFetch(url, init);
  };
  let host;
  try {
    host = await renderSettings('固定功能');
  } finally {
    globalThis.fetch = realFetch;
  }

  const body = host.querySelector('.settings-body');
  assert.ok(body, '应该还有 settings-body');
  const text = body.textContent ?? '';
  assert.notEqual(text.trim(), '', '不许是一片空白 —— 用户没法把问题告诉任何人');
  assert.match(text, /没能画出来/, '要说清是哪一页没画出来');
  assert.match(text, /固定功能/, '要指名是哪一节');
});

test('开关有真实的滑块元素，不靠伪元素', async () => {
  /*
   * 伪元素在 UXP 上不渲染的话，开关就是一个空的圆角框，
   * 开和关看起来一模一样。而它控制的是"结果要不要自动写进文档"。
   */
  const host = await renderSettings('生成默认值');
  const switches = host.querySelectorAll('.switch');
  assert.ok(switches.length > 0, '生成默认值里应该有开关');

  for (const sw of switches) {
    assert.ok(
      sw.querySelector('.switch-knob'),
      '开关里必须有一个真实的 .switch-knob 子元素，不能只靠 ::after'
    );
  }
});

test('开关切换时，on 类和 aria-checked 一起变', async () => {
  // 类名决定外观，aria-checked 决定可访问性读出来的状态 —— 两个必须一致，
  // 否则界面显示"开"而辅助技术读出"关"。
  const host = await renderSettings('生成默认值');
  const sw = host.querySelectorAll('.switch')[0];
  const before = sw.classList.contains('on');

  sw.dispatchEvent({ type: 'click', target: sw, currentTarget: sw });
  await new Promise((r) => setTimeout(r, 250));

  assert.notEqual(sw.classList.contains('on'), before, 'on 类应该翻转');
  assert.equal(
    sw.getAttribute('aria-checked'),
    String(!before),
    'aria-checked 要跟着 on 类一起变'
  );
});

test('分节渲染完是空的时候，也要说一声，不许留白板', async () => {
  /*
   * 「固定功能」真机上就是这样：没抛错（所以上面那条错误提示不会出现），
   * 也没内容，一片空白。空白说不出任何信息 —— 用户没法反馈，我也没法查。
   *
   * 这里把"接口都通、但返回空"的情况造出来：功能列表为空，
   * 绑定表就只剩表头……而表头也在 card 里，card 是最后才 append 的。
   */
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (/\/v1\/features(\?|$)/.test(String(url))) {
      return new Response(JSON.stringify({ ok: true, features: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return realFetch(url, init);
  };
  let host;
  try {
    host = await renderSettings('固定功能');
  } finally {
    globalThis.fetch = realFetch;
  }

  const body = host.querySelector('.settings-body');
  const text = (body?.textContent ?? '').trim();
  assert.notEqual(text, '', '空白是最糟的结果 —— 至少要说一句话');
});

test('分节还在载入时先给占位，不是先空着', async () => {
  /*
   * 各分节都要 await 后端。慢一点（甚至挂住）时这块本来是一片空白 ——
   * 用户看不出是在加载、还是坏了、还是这一页本来就没内容。
   */
  // 先把页面渲染出来（停在「本地」，不碰 providers），再设闸门 ——
  // 否则初始渲染自己就会被卡住，测的就成了"用例把自己锁死了"。
  const host = await renderSettings('本地');

  const realFetch = globalThis.fetch;
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  globalThis.fetch = async (url, init) => {
    if (/\/v1\/providers(\?|$)/.test(String(url))) await gate;
    return realFetch(url, init);
  };

  try {
    const btn = host.querySelectorAll('button').find((b) => b.textContent === '云端');
    assert.ok(btn, '应该有「云端」页签');
    btn.dispatchEvent({ type: 'click', target: btn, currentTarget: btn });

    // 还卡在 providers 上：这时候必须已经有东西可看
    await new Promise((r) => setTimeout(r, 250));
    const body = host.querySelector('.settings-body');
    assert.match((body?.textContent ?? '').trim(), /正在载入/, '载入期间不许是空白');

    release();
    await new Promise((r) => setTimeout(r, 800));
    assert.ok(
      !/正在载入/.test(body?.textContent ?? ''),
      '数据回来之后占位符要被换掉，不能和真内容并排留着'
    );
  } finally {
    release?.();
    globalThis.fetch = realFetch;
  }
});
