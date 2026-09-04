/**
 * 历史页：「再次写回」写的必须是用户**选中**的那一张。
 *
 * 一次生成可能出好几张。历史页以前只画 results[0]，「再次写回」
 * 写的也永远是 results[0] —— 用户在生成页挑中了 #3 觉得最好，
 * 过一会儿回历史页想再写一次，进文档的却是 #1，
 * 而界面上一个字的提示都没有。他只会觉得写回坏了，
 * 或者更糟：没注意到，把 #1 当成 #3 交了出去。
 *
 * 顺带守住另一件事：写回按钮的显示条件不能是"有没有目标文档"。
 * assetOnly 压根不碰文档，没有目标也照样成立 —— 而"提交时没打开文档"
 * 恰恰是最常落到 assetOnly 的情形。按老条件的话，那些任务在历史页上
 * 连按钮都没有，用户没有任何入口。
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

import { startHelper } from '../../helper/dist/index.js';
import { startComfyStub, makePng } from '../../../tools/comfy-stub.mjs';
import { installUxpDom } from './uxp-dom.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const FEATURE = 'comfy.wash.portrait';

let helper;
let comfy;
let dataDir;
let ui;
let dom;
let PORT = 0;
let token;

/**
 * 桥的桩。
 *
 * writes 记下每一次**真的落到文档上**的写回 —— 这一组最关心的
 * 就是这个数字。上一版只断言"按钮在"和"assetId 传到了 Helper"，
 * 而那两件事在一个什么都不写的实现上同样成立。
 */
const bridgeStubSource = `
  const S = globalThis.__psaiHistBridge;
  export const BridgeError = class extends Error {};
  export function isAvailable() { return S.available; }
  export function reason() { return '桩：不在 Photoshop 里'; }
  export function initBridge() { return { ok: S.available, reason: '' }; }
  export function getContext() { return S.context; }
  export function watchContext() { return () => {}; }
  export function buildTarget(ctx, selectionBounds) {
    return {
      documentId: ctx.documentId,
      documentName: ctx.documentName,
      documentPath: ctx.documentPath ?? '',
      canvasWidth: ctx.width ?? 512,
      canvasHeight: ctx.height ?? 512,
      sourceLayerIds: [],
      sourceLayerNames: [],
      selectionBounds,
      colorMode: 'RGB',
      bitDepth: 8
    };
  }
  export function validateWritebackTarget(target, mode) {
    if (mode === 'assetOnly') return { ok: true };
    if (!S.available) return { ok: false, code: 'PHOTOSHOP_NOT_AVAILABLE', message: '桩：不在 Photoshop 里' };
    if (!target || !target.documentId) return { ok: false, code: 'WRITEBACK_TARGET_INVALID', message: '没有写回目标' };
    return { ok: true };
  }
  export function provenanceTag(p) {
    return 'psai:' + p.jobId + '/' + p.assetId + '@' + String(p.attemptId).slice(0, 8);
  }
  export function probeProvenance() { return 'cannot-tell'; }
  export async function writeback(arg) {
    S.writes.push({
      mode: arg.mode,
      assetId: arg.provenance?.assetId ?? null,
      documentId: arg.target?.documentId ?? null,
      documentName: arg.target?.documentName ?? null
    });
    return { ok: true, detail: '写回成功' };
  }
`;

async function bundleForTest(outfile) {
  const entry = join(here, '.history-entry.mjs');
  writeFileSync(
    entry,
    [
      "export { renderHistoryPage } from '../src/ui/page-history.js';",
      "export { setState, getState } from '../src/app/store.js';",
      "export { useHelperAt } from '../src/app/api.js';"
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
          /*
           * 桥要换成可控的桩。
           *
           * 这一组要断言的是"文档到底被写了没有"—— 真桥在 Node 里
           * 一碰就抛，只能证明"按钮点了没崩"，而那正是上一版
           * 漏掉这个缺陷的原因：按钮在、assetId 也传到了 Helper，
           * 可 Photoshop 那边一个字节都没动。
           */
          b.onResolve({ filter: /ps\/bridge\.js$/ }, () => ({ path: 'psai-bridge', namespace: 'uxp-stub' }));
          b.onResolve({ filter: /^(photoshop|uxp|os|fs)$/ }, (a) => ({ path: a.path, namespace: 'uxp-stub' }));
          b.onLoad({ filter: /.*/, namespace: 'uxp-stub' }, (a) => {
            if (a.path === 'psai-bridge') return { contents: bridgeStubSource, loader: 'js' };
            return {
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
            };
          });
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

async function uploadPng(rgb) {
  const fd = new FormData();
  fd.append('file', new Blob([makePng(64, 64, rgb)], { type: 'image/png' }), 'in.png');
  const res = await fetch(`http://127.0.0.1:${PORT}/v1/assets`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: fd
  });
  return (await res.json()).assets[0];
}

function testWorkflow() {
  return {
    1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'stub_model.safetensors' } },
    2: { class_type: 'LoadImage', inputs: { image: 'example.png' } },
    4: { class_type: 'CLIPTextEncode', inputs: { text: 'a', clip: ['1', 1] }, _meta: { title: 'Positive' } },
    5: { class_type: 'CLIPTextEncode', inputs: { text: 'b', clip: ['1', 1] }, _meta: { title: 'Negative' } },
    6: { class_type: 'VAEEncode', inputs: { pixels: ['2', 0], vae: ['1', 2] } },
    3: {
      class_type: 'KSampler',
      inputs: {
        model: ['1', 0],
        seed: 1,
        steps: 4,
        cfg: 7,
        sampler_name: 'euler',
        scheduler: 'normal',
        positive: ['4', 0],
        negative: ['5', 0],
        latent_image: ['6', 0],
        denoise: 1
      }
    },
    8: { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['1', 2] } },
    9: { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: 'psai' } }
  };
}

async function waitFor(jobId, predicate, timeoutMs = 20000) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    last = (await api('GET', `/v1/jobs/${jobId}`)).job;
    if (last && predicate(last)) return last;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`超时：最后状态=${last?.state}`);
}

/** 造一条出了 3 张图、写回方式是「仅存资产库」的任务。 */
async function multiResultJob(seed) {
  const asset = await uploadPng([seed, seed + 1, seed + 2]);
  const created = await api('POST', '/v1/jobs', {
    featureId: FEATURE,
    params: { prompt: '洗一下', seed: { mode: 'fixed', value: seed }, batch: 3 },
    inputs: [{ paramId: 'image', assetId: asset.id, index: 0, source: 'upload' }],
    // 没有 target：提交时没有打开的文档，正是最常落到 assetOnly 的情形
    writeback: { mode: 'assetOnly', layerName: 'AI 结果' }
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  const job = await waitFor(created.job.id, (j) => j.results.length >= 3);
  assert.equal(job.target, null, '前提：这条任务没有目标文档');
  return job;
}

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'psai-histpick-'));
  comfy = await startComfyStub(0, { runMs: 60, resultCount: 3 });
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
  globalThis.__psaiHistBridge = { available: true, writes: [], context: null };

  const outfile = join(dataDir, 'history.test.mjs');
  await bundleForTest(outfile);
  ui = await import(pathToFileURL(outfile).href);
  ui.useHelperAt(`http://127.0.0.1:${PORT}`, token);

  await api('PATCH', '/v1/settings', { comfy: { baseUrl: comfy.url } });
  const wf = (await api('POST', '/v1/workflows/import', { json: testWorkflow(), name: '历史页选图测试用' })).workflow;
  await api('PUT', `/v1/features/${FEATURE}/binding`, { providerId: 'comfyui', workflowId: wf.id, enabled: true });

  ui.setState({
    booted: true,
    health: { online: true, version: 'test', paired: true, activeJobs: 0, comfyui: null, reason: null }
  });
});

after(async () => {
  await helper?.stop();
  await comfy?.stop();
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* noop */
  }
});

/** 渲染历史页，把这条任务那一行里的缩略图和按钮找出来。 */
async function renderHistory() {
  const host = dom.document.createElement('div');
  dom.root.appendChild(host);
  await ui.renderHistoryPage(host);
  const buttons = host.querySelectorAll('button');
  return {
    host,
    cells: host.querySelectorAll('.hist-thumb-cell'),
    writeback: buttons.find((b) => b.textContent === '再次写回'),
    rebind: buttons.find((b) => b.textContent === '写入当前文档'),
    confirm: () => host.querySelectorAll('button').find((b) => b.textContent === '确认'),
    cancel: () => host.querySelectorAll('button').find((b) => b.textContent === '取消'),
    confirmText: () => {
      const el = host.querySelector('.hist-confirm');
      return el ? el.textContent : '';
    }
  };
}

function writes() {
  return globalThis.__psaiHistBridge.writes;
}

function resetBridge(over = {}) {
  globalThis.__psaiHistBridge.writes.length = 0;
  globalThis.__psaiHistBridge.available = true;
  globalThis.__psaiHistBridge.context = null;
  Object.assign(globalThis.__psaiHistBridge, over);
}

/** 一份"现在打开着的"文档。 */
function openDoc(over = {}) {
  return {
    documentId: 77,
    documentName: '刚打开的.psd',
    documentPath: 'D:/稿子/刚打开的.psd',
    width: 512,
    height: 512,
    colorMode: 'RGB',
    bitDepth: 8,
    activeLayers: [],
    hasSelection: false,
    selectionBounds: null,
    ...over
  };
}

test('多张结果全都画出来，不是只画第一张', async () => {
  const job = await multiResultJob(11);
  assert.equal(job.results.length, 3, '前提：这条任务出了 3 张');

  const { cells } = await renderHistory();
  assert.equal(cells.length, 3, `3 张结果就该有 3 个缩略图，实际 ${cells.length} 个 —— 看不见的那两张等于不存在`);
});

/* ==================== 没有目标文档的任务：按钮要名副其实 ==================== */

/*
 * 这条任务提交时没有打开文档，结果只进了资产库。
 *
 * 上一版给它摆一个「再次写回」按钮，点下去只给 Helper 记一笔账，
 * Photoshop 那边一个字节都不动。按钮写着"写回"却不写回，
 * 比没有按钮更糟：用户点完看不出任何变化，只会以为写回坏了，
 * 或者更糟 —— 以为图已经进文档了。
 *
 * 现在它是「写入当前文档」，而且真的写。
 */

test('没有目标文档时，摆的不是「再次写回」', async () => {
  resetBridge({ context: openDoc() });
  const { writeback, rebind } = await renderHistory();
  assert.equal(writeback, undefined, '这条任务没有可"再"写的文档，不该用这个标签');
  assert.ok(rebind, '应该给一个说得清自己在做什么的入口');
});

test('没打开文档时点「写入当前文档」：说清楚，且什么都不写', async () => {
  resetBridge({ context: null });
  const { rebind, confirm } = await renderHistory();
  rebind.dispatchEvent({ type: 'click' });
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(confirm(), undefined, '没有可写的文档就不该进到确认那一步');
  assert.deepEqual(writes(), [], '一个字节都不该写');
});

test('要先确认写进哪一份，确认框里必须写着文档名', async () => {
  /*
   * 用户可能同时开着好几份文档，而"写进哪一份"是不可撤销的决定。
   * 不把名字摆出来的话，他只能赌。
   */
  resetBridge({ context: openDoc() });
  const { rebind, confirmText, confirm } = await renderHistory();
  rebind.dispatchEvent({ type: 'click' });
  await new Promise((r) => setTimeout(r, 50));

  assert.ok(confirm(), '应该出现确认按钮');
  assert.match(confirmText(), /刚打开的\.psd/, '确认时必须说清写进哪一份');
  assert.deepEqual(writes(), [], '还没确认，就还不能写');
});

test('确认之后**真的**写进当前文档，写的是选中的那一张', async () => {
  /*
   * 这一条是整组的重点：断言的是 Photoshop 那边收到了一次写回，
   * 而且目标文档和资产都对。只看"按钮在不在"或者"assetId 到没到
   * Helper"的话，一个什么都不写的实现照样能通过。
   */
  const job = (await api('GET', '/v1/jobs?limit=1')).jobs[0];
  resetBridge({ context: openDoc() });

  const { cells, rebind, confirm } = await renderHistory();
  cells[2].dispatchEvent({ type: 'click' }); // 选第 3 张
  rebind.dispatchEvent({ type: 'click' });
  await new Promise((r) => setTimeout(r, 50));
  confirm().dispatchEvent({ type: 'click' });
  await new Promise((r) => setTimeout(r, 500));

  assert.equal(writes().length, 1, `Photoshop 那边必须真的被写了一次，实际 ${writes().length} 次`);
  assert.equal(writes()[0].documentId, 77, '要写进用户确认的那一份文档');
  assert.equal(writes()[0].assetId, job.results[2].assetId, '写的必须是选中的那一张');
  assert.notEqual(writes()[0].mode, 'assetOnly', '不能还是那个什么都不做的方式');
});

test('改绑之后任务真的挂上了目标文档，下次就是普通的「再次写回」', async () => {
  // 改绑要落到 Helper 上，否则下次进历史页又回到"没有目标"的状态。
  const job = (await api('GET', '/v1/jobs?limit=1')).jobs[0];
  const fresh = (await api('GET', `/v1/jobs/${job.id}`)).job;
  assert.ok(fresh.target, '改绑之后任务上该有目标文档了');
  assert.equal(fresh.target.documentId, 77);
  assert.equal(fresh.target.documentName, '刚打开的.psd');

  const { writeback, rebind } = await renderHistory();
  assert.ok(writeback, '有目标之后就该是普通的「再次写回」');
  assert.equal(rebind, undefined);
});

test('点了取消就什么都不写', async () => {
  const job = await multiResultJob(21);
  void job;
  resetBridge({ context: openDoc({ documentId: 88, documentName: '别写这份.psd' }) });

  const { rebind, cancel } = await renderHistory();
  rebind.dispatchEvent({ type: 'click' });
  await new Promise((r) => setTimeout(r, 50));
  cancel().dispatchEvent({ type: 'click' });
  await new Promise((r) => setTimeout(r, 200));

  assert.deepEqual(writes(), [], '取消就是取消');
});

test('从看到提示到点确认之间切换了文档：拒绝，不写进另一份', async () => {
  /*
   * 确认框上写的是 A，用户切到 B 之后才点确认 —— 这时候写进 B
   * 就是写进了一份他没确认过的文档，而且不可撤销。
   */
  resetBridge({ context: openDoc({ documentId: 88, documentName: 'A.psd' }) });
  const { rebind, confirm } = await renderHistory();
  rebind.dispatchEvent({ type: 'click' });
  await new Promise((r) => setTimeout(r, 50));

  // 用户在这中间切走了
  globalThis.__psaiHistBridge.context = openDoc({ documentId: 99, documentName: 'B.psd' });

  confirm().dispatchEvent({ type: 'click' });
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(writes(), [], '确认的是 A，就不能写进 B');
});

/* ==================== 有目标文档的任务：选哪张写哪张 ==================== */

/** 造一条**有**目标文档、出了 3 张图的任务。 */
async function targetedJob(seed) {
  const asset = await uploadPng([seed, seed + 1, seed + 2]);
  const created = await api('POST', '/v1/jobs', {
    featureId: FEATURE,
    params: { prompt: '洗一下', seed: { mode: 'fixed', value: seed }, batch: 3 },
    inputs: [{ paramId: 'image', assetId: asset.id, index: 0, source: 'upload' }],
    target: {
      documentId: 5,
      documentName: '原稿.psd',
      documentPath: 'D:/稿子/原稿.psd',
      canvasWidth: 512,
      canvasHeight: 512,
      sourceLayerIds: [1],
      sourceLayerNames: ['L'],
      selectionBounds: null,
      colorMode: 'RGB',
      bitDepth: 8
    },
    writeback: { mode: 'smartObject', layerName: 'AI 结果' }
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  return await waitFor(created.job.id, (j) => j.results.length >= 3);
}

test('有目标文档时，点中第 3 张再写回，进文档的就是第 3 张', async () => {
  const job = await targetedJob(31);
  resetBridge({ context: openDoc({ documentId: 5, documentName: '原稿.psd' }) });

  const { cells, writeback } = await renderHistory();
  assert.ok(writeback, '有目标就该是「再次写回」');
  cells[2].dispatchEvent({ type: 'click' });
  writeback.dispatchEvent({ type: 'click' });
  await new Promise((r) => setTimeout(r, 500));

  assert.equal(writes().length, 1, '要真的写一次');
  assert.equal(writes()[0].assetId, job.results[2].assetId, '写的必须是用户点中的那一张');
  assert.equal(writes()[0].documentId, 5, '写进任务自己那份文档');
});

test('一张都没点时默认第一张 —— 不能因此变成什么都不写', async () => {
  const job = (await api('GET', '/v1/jobs?limit=1')).jobs[0];
  resetBridge({ context: openDoc({ documentId: 5, documentName: '原稿.psd' }) });

  const { writeback } = await renderHistory();
  writeback.dispatchEvent({ type: 'click' });
  await new Promise((r) => setTimeout(r, 500));

  assert.equal(writes().length, 1);
  assert.equal(writes()[0].assetId, job.results[0].assetId, '没选就用第一张，这是合理的默认');
});
