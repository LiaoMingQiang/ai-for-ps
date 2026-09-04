/**
 * 断线重连之后的任务列表对账。
 *
 * WebSocket 断开期间的 job:update 是**不补发**的。网络抖一下、
 * Helper 重启一次、机器睡一觉醒来 —— 这期间任务照跑，而面板里那份
 * 快照停在断线那一刻。用户看到的是一堆永远停在「生成中」的任务，
 * 而它们其实早就完成了。
 *
 * 这一组守两层：
 *   · 合并规则本身（纯函数，快，能把每种边界都摆出来）
 *   · 真的断开再连上时，面板确实会去对账 —— 而且**不看 Photoshop 在不在**
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

const { mergeJobSnapshot } = await import('../src/app/reconcile.ts');

/* ==================== 合并规则 ==================== */

function job(id, over = {}) {
  return {
    id,
    featureId: 'f',
    providerId: 'comfyui',
    workflowId: null,
    workflowVersion: null,
    state: 'running',
    progress: {},
    params: {},
    resolvedParams: {},
    inputs: [],
    results: [],
    target: null,
    writeback: null,
    error: null,
    createdAt: 1000,
    updatedAt: 1000,
    ...over
  };
}

const FULL = { complete: true, requestedAt: 9_000_000 };

test('断线期间才建的任务，会被补进来', () => {
  const merged = mergeJobSnapshot([job('a')], [job('a'), job('b', { createdAt: 1100 })], FULL);
  assert.deepEqual(merged.map((j) => j.id).sort(), ['a', 'b']);
});

test('断线期间的状态变化会被补上', () => {
  const merged = mergeJobSnapshot(
    [job('a', { state: 'running', updatedAt: 1000 })],
    [job('a', { state: 'succeeded', updatedAt: 2000 })],
    FULL
  );
  assert.equal(merged[0].state, 'succeeded');
});

test('过时的快照绝不能盖掉更新的推送', () => {
  /*
   * 这一条是整组的重点。那次 REST 请求要花几十到几百毫秒，
   * 回来时 WebSocket 可能已经推来了更新的状态。
   * 直接覆盖的话，任务在界面上"倒退"回旧状态，然后停在那儿不动 ——
   * 因为下一条推送要等到下一次真实的状态变化。
   */
  const merged = mergeJobSnapshot(
    [job('a', { state: 'succeeded', updatedAt: 5000 })], // 推送刚给的
    [job('a', { state: 'running', updatedAt: 3000 })], // 快照是更早拍的
    FULL
  );
  assert.equal(merged[0].state, 'succeeded', '更新的那份必须留下');
  assert.equal(merged[0].updatedAt, 5000);
});

test('时间戳相同时以服务端那份为准', () => {
  const merged = mergeJobSnapshot(
    [job('a', { state: 'running', updatedAt: 4000 })],
    [job('a', { state: 'succeeded', updatedAt: 4000 })],
    FULL
  );
  assert.equal(merged[0].state, 'succeeded');
});

test('断线期间被删掉的任务会从列表里消失', () => {
  const merged = mergeJobSnapshot([job('a'), job('b')], [job('a')], FULL);
  assert.deepEqual(
    merged.map((j) => j.id),
    ['a']
  );
});

test('分页之外的老任务不算被删 —— 拉回 100 条不等于总共只有 100 条', () => {
  /*
   * 快照是分页的。拿"本地有、快照没有"直接判成删除的话，
   * 翻页范围之外的老任务会凭空消失 —— 用户会以为我们把他的历史弄丢了。
   */
  const merged = mergeJobSnapshot(
    [job('old', { createdAt: 1 }), job('new', { createdAt: 5000 })],
    [job('new', { createdAt: 5000 })],
    { complete: false, requestedAt: 9_000_000 }
  );
  assert.deepEqual(
    merged.map((j) => j.id).sort(),
    ['new', 'old'],
    '老任务只是没被这一页覆盖到，不是被删了'
  );
});

test('分页时，覆盖范围**之内**缺席的仍然算被删', () => {
  // 覆盖范围 = 快照里最老那条（z，5500）往新的方向。
  // x 是 5800，落在范围内却没出现在快照里 —— 那就是真的被删了。
  const merged = mergeJobSnapshot(
    [job('x', { createdAt: 5800 }), job('y', { createdAt: 6000 })],
    [job('y', { createdAt: 6000 }), job('z', { createdAt: 5500 })],
    { complete: false, requestedAt: 9_000_000 }
  );
  assert.ok(!merged.some((j) => j.id === 'x'), 'x 在覆盖范围内却不在快照里，是真的被删了');
  assert.ok(
    merged.some((j) => j.id === 'y') && merged.some((j) => j.id === 'z'),
    '快照里的那两条都该在'
  );
});

test('快照发出之后才更新的本地任务，不会被当成已删除', () => {
  /*
   * 请求发出的那一刻它还不存在（或者刚被推送更新过），
   * 快照里当然没有它。删掉的话，用户刚提交的任务会一闪就没。
   */
  const merged = mergeJobSnapshot(
    [job('brand-new', { createdAt: 8000, updatedAt: 8000 })],
    [],
    { complete: true, requestedAt: 7000 }
  );
  assert.deepEqual(
    merged.map((j) => j.id),
    ['brand-new']
  );
});

test('合并结果按新→旧排，和 Helper 的口径一致', () => {
  const merged = mergeJobSnapshot([], [job('a', { createdAt: 1 }), job('b', { createdAt: 9 })], FULL);
  assert.deepEqual(
    merged.map((j) => j.id),
    ['b', 'a']
  );
});

/* ==================== 真的断开再连上 ==================== */

const here = dirname(fileURLToPath(import.meta.url));
const FEATURE = 'comfy.wash.portrait';

let helper;
let comfy;
let dataDir;
let ui;
let dom;
let PORT = 0;
let token;

async function bundleForTest(outfile) {
  const entry = join(here, '.reconcile-entry.mjs');
  writeFileSync(
    entry,
    [
      "export { bootPlugin, teardownPlugin, reconcileJobs } from '../src/app/main.js';",
      "export { setState, getState, resetStore } from '../src/app/store.js';",
      "export { useHelperAt, connectEvents, disconnectEvents, eventsConnected } from '../src/app/api.js';"
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
        name: 'stubs',
        setup(b) {
          /*
           * 桥一律报"不可用"。
           *
           * 这正是要验的场景：对账不该看 Photoshop 的脸色。
           * 上一版把对账挂在 reconcileAutoWriteback 里，而那个函数
           * 第一句就是 `if (!bridge.isAvailable()) return` —— 于是在
           * 浏览器预览里、Photoshop 崩过之后、或者没装 Photoshop 的机器上，
           * 任务列表永远停在断线那一刻。
           */
          b.onResolve({ filter: /ps\/bridge\.js$/ }, () => ({ path: 'psai-bridge', namespace: 'stub' }));
          b.onResolve({ filter: /^(photoshop|uxp|os|fs)$/ }, (a) => ({ path: a.path, namespace: 'stub' }));
          b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => {
            if (a.path === 'psai-bridge') {
              return {
                contents: `
                  export const BridgeError = class extends Error {};
                  export function isAvailable() { return false; }
                  export function reason() { return '桩：不在 Photoshop 里'; }
                  export function initBridge() { return { ok: false, reason: '桩：不在 Photoshop 里' }; }
                  export function getContext() { return null; }
                  export function watchContext() { return () => {}; }
                  export function buildTarget() { return null; }
                  export function validateWritebackTarget() { return { ok: false, code: 'PHOTOSHOP_NOT_AVAILABLE', message: '桩' }; }
                  export function provenanceTag(p) { return 'psai:' + p.jobId + '/' + p.assetId; }
                  export function probeProvenance() { return 'cannot-tell'; }
                  export async function writeback() { return { ok: false, detail: '桩：不在 Photoshop 里' }; }
                `,
                loader: 'js'
              };
            }
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
  if (!Number.isInteger(PORT) || PORT <= 0) {
    throw new Error(`测试用的 Helper 端口无效：PORT=${PORT}。多半是某次启动 Helper 没成功，或者在赋值前就发了请求。`);
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

async function until(fn, what, timeoutMs = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`超时：${typeof what === 'function' ? what() : what}`);
}

/** 造一条真任务。 */
async function makeJob(seed) {
  const asset = await uploadPng([seed, seed + 1, seed + 2]);
  const created = await api('POST', '/v1/jobs', {
    featureId: FEATURE,
    params: { prompt: '洗一下', seed: { mode: 'fixed', value: seed } },
    inputs: [{ paramId: 'image', assetId: asset.id, index: 0, source: 'upload' }],
    writeback: { mode: 'assetOnly', layerName: 'AI 结果' }
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  return created.job;
}

/**
 * 等这条任务跑到终态。
 *
 * 要在 Helper 那边真的跑完，不能只 sleep 一段固定时间 ——
 * 那样在慢一点的机器上就成了偶发红。
 */
async function waitDone(jobId) {
  let last = null;
  await until(
    async () => {
      last = (await api('GET', `/v1/jobs/${jobId}`)).job;
      return ['succeeded', 'writeback_pending', 'failed', 'cancelled', 'lost'].includes(last?.state);
    },
    () => `任务没跑完，停在 ${last?.state}`
  );
  return last;
}

function jobsInStore() {
  return ui.getState().jobs;
}

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'psai-recon-'));
  comfy = await startComfyStub(0, { runMs: 50 });
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

  const outfile = join(dataDir, 'reconcile.test.mjs');
  await bundleForTest(outfile);
  ui = await import(pathToFileURL(outfile).href);
  ui.useHelperAt(`http://127.0.0.1:${PORT}`, token);

  await api('PATCH', '/v1/settings', { comfy: { baseUrl: comfy.url } });
  const wf = (await api('POST', '/v1/workflows/import', { json: testWorkflow(), name: '对账测试用' })).workflow;
  await api('PUT', `/v1/features/${FEATURE}/binding`, { providerId: 'comfyui', workflowId: wf.id, enabled: true });
});

after(async () => {
  try {
    ui?.teardownPlugin();
  } catch {
    /* noop */
  }
  await helper?.stop();
  await comfy?.stop();
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* noop */
  }
});

test('Photoshop 不可用时，重连照样对账', async () => {
  /*
   * 这一条是这个文件存在的主要理由。
   *
   * 对账挂在 reconcileAutoWriteback 里的话，`!bridge.isAvailable()`
   * 那一句会让它一步都走不到 —— 于是没装 Photoshop、
   * Photoshop 崩过一次、或者跑在浏览器预览里的时候，
   * 任务列表永远停在断线那一刻。
   */
  await ui.bootPlugin();
  await until(() => ui.eventsConnected(), 'WebSocket 应该连上');

  // 断线
  ui.disconnectEvents();
  await until(() => !ui.eventsConnected(), '应该断开了');

  // 断线**期间**建一条任务 —— 这条 job:update 面板收不到
  const created = await makeJob(41);
  assert.ok(
    !jobsInStore().some((j) => j.id === created.id),
    '前提：断线期间建的任务，面板还不知道'
  );

  // 重连
  await ui.connectEvents();
  await until(
    () => jobsInStore().some((j) => j.id === created.id),
    () => `重连之后应该补上断线期间那条任务；现在列表里有 ${jobsInStore().length} 条`
  );
});

test('断线期间完成的状态变化，重连后补上', async () => {
  const created = await makeJob(42);
  // 先对一次账把它带进来。这一步是**布置现场**，不是被测行为 ——
  // 指望实时推送的话，这条用例会连带测上 WebSocket 的时序，
  // 而它真正要验的是"断线期间的变化会不会补上"。
  await ui.reconcileJobs();
  assert.ok(jobsInStore().some((j) => j.id === created.id), '前提：面板先知道这条任务');

  ui.disconnectEvents();
  await until(() => !ui.eventsConnected(), '应该断开了');

  // 断线期间它跑完了 —— 这几条 job:update 面板一条都收不到
  const remote = await waitDone(created.id);
  assert.notEqual(
    jobsInStore().find((j) => j.id === created.id)?.state,
    remote.state,
    '前提：面板手里那份还是断线之前的旧状态'
  );

  await ui.connectEvents();
  await until(
    () => jobsInStore().find((j) => j.id === created.id)?.state === remote.state,
    () => `重连后状态该对上：期望 ${remote.state}，实际 ${jobsInStore().find((j) => j.id === created.id)?.state}`
  );
});

test('断线期间被删掉的任务，重连后从列表里消失', async () => {
  const created = await makeJob(43);
  await ui.reconcileJobs();
  assert.ok(jobsInStore().some((j) => j.id === created.id), '前提：面板先知道这条任务');

  // 跑完再删：还在跑的任务删不掉，那样这条用例测的就成了"删除被拒"
  await waitDone(created.id);

  ui.disconnectEvents();
  await until(() => !ui.eventsConnected(), '应该断开了');

  const del = await api('DELETE', `/v1/jobs/${created.id}`);
  assert.equal(del.ok, true, `前提：得真的删掉 ${JSON.stringify(del)}`);
  assert.ok(jobsInStore().some((j) => j.id === created.id), '前提：面板这时候还以为它在');

  await ui.connectEvents();
  await until(
    () => !jobsInStore().some((j) => j.id === created.id),
    '重连之后已删除的任务该消失，否则用户会对着一条点不动的幽灵任务'
  );
});

test('对账请求还在路上时收到推送：不许被旧快照盖回去', async () => {
  /*
   * 用一次慢响应把窗口拉开：对账的 GET /v1/jobs 拖住 500ms，
   * 期间往 store 里塞一个"更新的"状态（等价于 WebSocket 推送到了）。
   * 合并必须按 updatedAt 走，旧快照不能盖掉它。
   */
  const created = await makeJob(44);
  await ui.reconcileJobs();
  assert.ok(jobsInStore().some((j) => j.id === created.id), '前提：面板先知道这条任务');

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (/\/v1\/jobs\?/.test(String(url))) await new Promise((r) => setTimeout(r, 500));
    return realFetch(url, init);
  };
  try {
    const pending = ui.reconcileJobs();
    // 快照还在路上时，推送先到了
    await new Promise((r) => setTimeout(r, 100));
    ui.setState({
      jobs: ui
        .getState()
        .jobs.map((j) => (j.id === created.id ? { ...j, state: 'succeeded', updatedAt: Date.now() + 60_000 } : j))
    });
    await pending;
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(
    jobsInStore().find((j) => j.id === created.id)?.state,
    'succeeded',
    '推送比快照新，就不能被快照盖回去'
  );
});

test('反复 boot / teardown：对账回调不会越挂越多', async () => {
  /*
   * onEventsOpen 的订阅不退的话，每 boot 一次就多挂一个：
   * 一次重连会触发 N 次对账、N 次补报。表现是越用越卡，
   * 而且并发的对账互相打架 —— 这种问题在开发时（只 boot 一次）
   * 永远看不到。
   */
  ui.teardownPlugin();
  for (let i = 0; i < 3; i++) {
    await ui.bootPlugin();
    ui.teardownPlugin();
  }
  await ui.bootPlugin();
  await until(() => ui.eventsConnected(), 'WebSocket 应该连上');

  let listCalls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (/\/v1\/jobs\?/.test(String(url))) listCalls++;
    return realFetch(url, init);
  };
  try {
    ui.disconnectEvents();
    await until(() => !ui.eventsConnected(), '应该断开了');
    await ui.connectEvents();
    await until(() => listCalls > 0, '重连之后该有一次对账');
    await new Promise((r) => setTimeout(r, 600));
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(listCalls, 1, `一次重连只该对账一次，实际 ${listCalls} 次 —— 说明旧订阅没退掉`);
});
