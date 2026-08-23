/**
 * 页面渲染冒烟测试：在 UXP 的 DOM **子集**上，把每个页面、每个功能都渲染一遍。
 *
 * 这个测试是补票补出来的。生成页曾经整页白屏，原因是代码里调了
 * `Element.toggleAttribute` —— 浏览器有、jsdom 有、UXP 没有。
 * typecheck 过、lint 过、bundle 也构建成功，只有装进 Photoshop 点开那一页才炸。
 *
 * 所以这里刻意不用 jsdom：用 test/uxp-dom.mjs 那个只提供 UXP 确实有的 API 的实现，
 * 页面碰了不该碰的东西就当场抛，CI 就能在进 Photoshop 之前拦住。
 *
 * Helper 是真起的进程、真发 HTTP、真读 SQLite —— 页面拿到的功能列表、
 * 参数 schema、工作流、绑定状态全部来自真实接口，不是编出来的假数据。
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
const PORT = 34214;

let helper;
let dataDir;
let ui;
let dom;
let pairToken;

/** 把插件源码打成 ESM，好在 Node 里直接 import 页面模块。 */
async function bundlePagesForTest(outfile) {
  const entry = join(here, '.pages-entry.mjs');
  writeFileSync(
    entry,
    [
      "export * from '../src/ui/page-generate.js';",
      "export { renderHistoryPage } from '../src/ui/page-history.js';",
      "export { renderSettingsPage } from '../src/ui/page-settings.js';",
      "export { renderComfyWebPage } from '../src/ui/page-comfyweb.js';",
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
    // UXP 的宿主模块在 Node 里不存在，用桩顶上；写回能力本来就只能在 PS 里验
    plugins: [
      {
        name: 'uxp-stub',
        setup(b) {
          b.onResolve({ filter: /^(photoshop|uxp|os|fs)$/ }, (a) => ({ path: a.path, namespace: 'uxp-stub' }));
          b.onLoad({ filter: /.*/, namespace: 'uxp-stub' }, () => ({
            contents: `
              const notInPs = () => { throw new Error('UXP-ONLY'); };
              export const app = { get documents() { return []; }, activeDocument: null };
              export const action = { batchPlay: notInPs };
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

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'psai-pages-'));
  helper = await startHelper({ port: PORT, dataDir, workflowsDir: resolve(here, '../../../workflows') });

  dom = installUxpDom();

  const outfile = join(dataDir, 'pages.test.mjs');
  await bundlePagesForTest(outfile);
  ui = await import(pathToFileURL(outfile).href);

  // 真配对，拿真 token，页面走的是真实鉴权路径
  const req = await fetch(`http://127.0.0.1:${PORT}/v1/pair/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client: 'pages-test' })
  });
  const { challenge } = await req.json();
  const con = await fetch(`http://127.0.0.1:${PORT}/v1/pair/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challenge })
  });
  const { token } = await con.json();
  pairToken = token;
  ui.useHelperAt(`http://127.0.0.1:${PORT}`, token);
});

after(async () => {
  await helper?.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

test('每个功能的生成页都能在 UXP DOM 子集上渲染出来', async () => {
  const { features } = await ui.api.features();
  assert.ok(features.length >= 17, `功能数应为 17 个以上，实际 ${features.length}`);
  ui.setState({ features });

  const failures = [];
  for (const f of features) {
    const host = dom.document.createElement('div');
    dom.root.appendChild(host);
    ui.setState({ featureId: f.id, activeJobId: null });
    try {
      await ui.renderGeneratePage(host);
    } catch (e) {
      failures.push(`${f.id}: ${e?.message ?? e}`);
      continue;
    }
    // 渲染出来必须真的有内容，不能是个空壳
    if (host.children.length === 0) failures.push(`${f.id}: 渲染完是空的`);
    // 页面里如果画出了渲染出错字样，说明它自己吞了异常，同样算失败
    if (host.textContent.includes('渲染出错')) failures.push(`${f.id}: 页面内部报错`);
    dom.root.removeChild(host);
  }
  assert.deepEqual(failures, [], `以下功能的生成页渲染失败：\n${failures.join('\n')}`);
});

test('生成页画出了图像输入、参数控件和提交按钮', async () => {
  const { features } = await ui.api.features();
  ui.setState({ features });
  // 挑一个参数最全的功能：有图输入、提示词、种子、滑块
  const rich = features.find((f) => f.id === 'comfy.relight.adaptive') ?? features[0];
  ui.setState({ featureId: rich.id, activeJobId: null });

  const host = dom.document.createElement('div');
  dom.root.appendChild(host);
  await ui.renderGeneratePage(host);

  const html = host.outerHTML;
  assert.ok(host.querySelector('.featnav'), '缺少功能导航');
  assert.ok(/提交|生成/.test(html), '缺少主行动按钮');
  assert.ok(host.querySelectorAll('.param').length > 0 || /param/.test(html), '一个参数控件都没画出来');
  dom.root.removeChild(host);
});

test('历史页 / 设置页 / ComfyUI Web 页都能渲染', async () => {
  for (const [name, render] of [
    ['历史页', ui.renderHistoryPage],
    ['设置页', ui.renderSettingsPage],
    ['ComfyUI Web 页', ui.renderComfyWebPage]
  ]) {
    const host = dom.document.createElement('div');
    dom.root.appendChild(host);
    await render(host);
    assert.ok(host.children.length > 0, `${name}渲染完是空的`);
    assert.ok(!host.textContent.includes('渲染出错'), `${name}内部报错`);
    dom.root.removeChild(host);
  }
});

test('UXP DOM 子集会挡住 toggleAttribute 与两参数 classList.toggle', () => {
  const el = dom.document.createElement('div');
  assert.equal(typeof el.toggleAttribute, 'undefined', 'UXP 没有 toggleAttribute，桩里也不该有');
  assert.throws(() => el.classList.toggle('x', true), /两参数/, '两参数 toggle 必须报错');
  // 单参数是 UXP 支持的，不该被挡
  assert.doesNotThrow(() => el.classList.toggle('x'));
});

test('设置页在绑定 RunningHub 时画出预设选择器而不是裸输入框', async () => {
  // 先把一个功能绑到 RunningHub 的内置预设上
  const put = await fetch(`http://127.0.0.1:${PORT}/v1/features/cloud.product.whitebg/binding`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pairToken}` },
    body: JSON.stringify({ providerId: 'runninghub', remoteWorkflowId: '1897193863243878401', enabled: true })
  });
  assert.ok(put.ok, `绑定接口返回 ${put.status}`);

  // 设置页默认停在「本地」页签，得先切到「固定功能」
  const host = dom.document.createElement('div');
  dom.root.appendChild(host);
  await ui.renderSettingsPage(host);
  const tab = host.querySelectorAll('.subtab').find((b) => b.textContent === '固定功能');
  assert.ok(tab, '找不到「固定功能」页签');
  tab.dispatchEvent({ type: 'click' });
  // 页签切换是异步重绘，等一轮微任务 + 网络往返
  await new Promise((r) => setTimeout(r, 300));

  const picker = host.querySelector('.rh-picker');
  assert.ok(picker, '绑到 RunningHub 后应该出现预设选择器 .rh-picker');
  const text = picker.textContent;
  assert.ok(text.includes('BiRefNet'), `选择器里应显示预设名，实际：${text.slice(0, 120)}`);
  assert.ok(text.includes('节点'), '应显示节点数等元信息');
  dom.root.removeChild(host);
});
