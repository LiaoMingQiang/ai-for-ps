/**
 * 设置页：改一项，不许把另一项顺手改回去；存不上必须说。
 *
 * 两类问题，都很安静。
 *
 * 一、整组覆盖。设置页渲染时把 `settings.generation` 抓在闭包里，
 *    之后每个控件的 onchange 都 `{ ...g, 我这一项: 新值 }` 整组发出去 ——
 *    而 `g` 是**渲染那一刻**的快照，改设置不触发重画，它永远不会更新。
 *
 *      用户关掉「自动写回」→ 服务端存下 false
 *      用户接着改「图层命名模板」→ 整组里 autoWriteback 还是旧的 true
 *      → 自动写回自己开回去了
 *
 *    界面上那个开关还显示着"关"（DOM 没重画），而实际行为是开着的。
 *    下次生成，图就自己进了他的文档 —— 他明明关过。
 *
 *    Helper 那边是按分组浅合并的（`{...current, ...patch[group]}`），
 *    所以只发变了的那一个字段就够了，整组发反而是有害的。
 *
 * 二、存失败不吭声。patch() 原来一个 try 都没有：Helper 掉线、鉴权过期、
 *    参数被拒 —— 失败的 promise 变成一条没人接的 rejection，
 *    用户什么都看不到，而控件还显示着他刚改的值。
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
  const entry = join(here, '.settings-entry.mjs');
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
              export const constants = {};
              export const imaging = {};
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

const remoteSettings = async () => (await api('GET', '/v1/settings')).settings;

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'psai-setpatch-'));
  helper = await startHelper({
    port: 0,
    dataDir,
    ephemeral: true,
    workflowsDir: resolve(here, '../../../workflows')
  });
  PORT = helper.port; // 不从 url 里抠：端口等于 80 时 URL 会规范化掉，Number('') === 0 → undici 报 bad port
  if (!Number.isInteger(PORT) || PORT <= 0) throw new Error(`Helper 端口不可用：${PORT}（url=${helper.url}）`);
  token = helper.issueToken();
  await helper.recovered;

  dom = installUxpDom();

  const outfile = join(dataDir, 'settings.test.mjs');
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

/**
 * 渲染设置页并切到指定分节。
 *
 * 设置页是分页签的，而当前页签是模块级状态 —— 前一条用例把它留在
 * 哪儿，下一条就从哪儿开始。所以每条用例都显式指定自己要的那一页。
 */
async function renderSettings(tab) {
  ui.setState({
    booted: true,
    settings: await remoteSettings(),
    health: { online: true, version: 'test', paired: true, activeJobs: 0, comfyui: null, reason: null }
  });
  const host = dom.document.createElement('div');
  dom.root.appendChild(host);
  await ui.renderSettingsPage(host);

  if (tab) {
    const btn = host.querySelectorAll('button').find((b) => b.textContent === tab);
    assert.ok(btn, `找不到「${tab}」页签`);
    btn.dispatchEvent({ type: 'click', target: btn, currentTarget: btn });
    // 页签的 onclick 里是 void renderSettingsPage(...)，等它画完
    await new Promise((r) => setTimeout(r, 300));
  }

  /**
   * 按标签文字找到那一行里的控件。
   *
   * 只在**这一页自己的容器**里找：前面几条用例各自留了一个 host 在
   * dom.root 上，全局找会取到别人的。
   */
  const rowFor = (label) => {
    for (const row of host.querySelectorAll('.setting')) {
      if (row.textContent.includes(label)) return row;
    }
    return null;
  };
  const inputFor = (label) => rowFor(label)?.querySelector('input');
  return { host, rowFor, inputFor };
}

function fire(el, type = 'change') {
  el.dispatchEvent({ type, target: el, currentTarget: el });
}

/** 阻断 PATCH /v1/settings，模拟"存不上"。 */
async function withPatchBlocked(fn) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if ((init?.method ?? 'GET') === 'PATCH' && /\/v1\/settings$/.test(String(url))) {
      throw new TypeError('fetch failed');
    }
    return realFetch(url, init);
  };
  try {
    await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
}

/* ==================== 一、改一项不许动别的 ==================== */

test('关掉自动写回之后再改别的，自动写回不许自己开回去', async () => {
  /*
   * 这一条是这个文件的理由。自动写回决定"结果要不要直接进用户的文档"——
   * 它自己开回去，用户下一次生成就会看到图凭空进了文档，
   * 而他记得清清楚楚自己关过。
   */
  const { rowFor, inputFor } = await renderSettings('生成默认值');

  const toggle = rowFor('自动写回')?.querySelector('button');
  assert.ok(toggle, '应该有「自动写回」开关');
  assert.equal((await remoteSettings()).generation.autoWriteback, true, '前提：默认开着');

  toggle.dispatchEvent({ type: 'click', target: toggle, currentTarget: toggle });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal((await remoteSettings()).generation.autoWriteback, false, '关掉之后服务端该是 false');

  const tpl = inputFor('图层命名模板');
  assert.ok(tpl, '应该有「图层命名模板」输入框');
  tpl.value = 'AI · {feature} · {seed}';
  fire(tpl);
  await new Promise((r) => setTimeout(r, 200));

  const after_ = (await remoteSettings()).generation;
  assert.equal(after_.layerNameTemplate, 'AI · {feature} · {seed}', '模板要改上');
  assert.equal(
    after_.autoWriteback,
    false,
    '改模板不该把「自动写回」顺手开回去 —— 用户会看到图自己进了文档'
  );
});

test('连改三项，三项都要留下', async () => {
  const { rowFor, inputFor } = await renderSettings('生成默认值');

  const tpl = inputFor('图层命名模板');
  tpl.value = '第一次';
  fire(tpl);
  await new Promise((r) => setTimeout(r, 150));

  const conc = inputFor('本地并发上限');
  conc.value = '3';
  fire(conc);
  await new Promise((r) => setTimeout(r, 150));

  const mode = rowFor('默认写回方式').querySelector('select');
  mode.value = 'pixelLayer';
  fire(mode);
  await new Promise((r) => setTimeout(r, 150));

  const s = (await remoteSettings()).generation;
  assert.equal(s.layerNameTemplate, '第一次', '第一项被后面的覆盖了');
  assert.equal(s.maxConcurrency, 3, '第二项被后面的覆盖了');
  assert.equal(s.writebackMode, 'pixelLayer', '第三项没写上');
});

test('ComfyUI 分节同样：改地址不许把超时改回去', async () => {
  /*
   * comfy 那一组是同一个毛病，而且更容易碰上：地址、超时、独占
   * 三个挨在一起，用户很自然会连着改。
   */
  const { inputFor } = await renderSettings('本地');

  const timeout = inputFor('连接超时');
  assert.ok(timeout, '应该有「连接超时」输入框');
  timeout.value = '90000';
  fire(timeout);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal((await remoteSettings()).comfy.timeoutMs, 90000, '超时要改上');

  const url = inputFor('地址');
  assert.ok(url, '应该有「地址」输入框');
  url.value = 'http://127.0.0.1:9999';
  fire(url);
  await new Promise((r) => setTimeout(r, 200));

  const after_ = (await remoteSettings()).comfy;
  assert.equal(after_.baseUrl, 'http://127.0.0.1:9999', '地址要改上');
  assert.equal(after_.timeoutMs, 90000, '改地址不该把超时改回默认');
});

/* ==================== 二、存不上必须说 ==================== */

test('保存失败时要弹错误提示，服务端也不该被改动', async () => {
  const { inputFor } = await renderSettings('生成默认值');
  const before = (await remoteSettings()).generation.layerNameTemplate;
  ui.setState({ toasts: [] });

  await withPatchBlocked(async () => {
    const tpl = inputFor('图层命名模板');
    tpl.value = '存不上的值';
    fire(tpl);
    await new Promise((r) => setTimeout(r, 400));
  });

  const toasts = ui.getState().toasts;
  assert.ok(
    toasts.some((t) => t.title.includes('没保存上')),
    `失败必须弹提示，实际的提示是：${JSON.stringify(toasts.map((t) => t.title))}`
  );
  assert.ok(
    toasts.some((t) => t.kind === 'error'),
    '这是错误，不是普通提示'
  );
  assert.equal((await remoteSettings()).generation.layerNameTemplate, before, '既然存失败了，服务端就不该变');
});

test('保存失败之后重画，控件不许停在那个假的新值上', async () => {
  /*
   * 光弹个提示、控件还显示着他刚敲进去的值，等于让界面继续骗人 ——
   * 用户下次打开设置页会看到两个互相矛盾的说法。
   */
  const { host, inputFor } = await renderSettings('生成默认值');
  const saved = (await remoteSettings()).generation.layerNameTemplate;

  await withPatchBlocked(async () => {
    const tpl = inputFor('图层命名模板');
    tpl.value = '假的新值';
    fire(tpl);
    await new Promise((r) => setTimeout(r, 500));
  });

  // 重画之后在**这一页自己的容器**里重新找那个控件
  const latest = [...host.querySelectorAll('.setting')]
    .filter((r) => r.textContent.includes('图层命名模板'))
    .map((r) => r.querySelector('input'))
    .pop();
  assert.ok(latest, '重画之后该还有这一行');
  assert.equal(latest.value, saved, '控件要回到真实存着的值，不能停在没存上的那个');
});
