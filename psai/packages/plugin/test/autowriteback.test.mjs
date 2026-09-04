/**
 * 自动写回：插件这一侧。
 *
 * 「自动写回」这个开关以前是个摆设 —— 设置页能打开、Helper 也把它读出来，
 * 但读出来只用于挑一句提示文案，没有任何代码真的去写。
 * 用户打开它，然后对着一堆停在「等待写回」的任务，等一个永远不会到来的动作。
 *
 * 写回只能发生在插件里（只有 UXP 碰得到 Photoshop），所以"自动"必须由这边驱动。
 * 这一组走真实路径：真起 Helper、真发 HTTP、真跑 autowriteback 模块，
 * 只有最后落笔那一下（bridge.writeback）用桩替掉 —— Node 里没有 Photoshop。
 */

import { test, before, after, beforeEach } from 'node:test';
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
let PORT = 0;
let token;

/**
 * bridge 的桩。
 *
 * 只桩掉真正碰 Photoshop 的那几个函数，其余全是真代码。
 * writes 记下每一次落笔 —— "自动写回到底写了几次"这个问题只能靠它回答，
 * 而那正是这一组最关心的事（写两次 = 用户文档里凭空多一个图层）。
 */
function makeBridgeStub() {
  const state = {
    available: true,
    writes: [],
    nextResult: { ok: true, detail: '写回成功' },
    delayMs: 0,
    /** probeProvenance 的返回值：'found' / 'absent' / 'cannot-tell' */
    probe: 'cannot-tell'
  };
  return {
    state,
    source: `
      export const __state = globalThis.__psaiBridgeState;
      export function isAvailable() { return __state.available; }
      export function reason() { return '桩：不在 Photoshop 里'; }
      export function initBridge() { return { ok: __state.available, reason: '' }; }
      export function getContext() { return null; }
      export function watchContext() { return () => {}; }

      /*
       * 出处标记与"去文档里核对"这两个，桩也必须提供 ——
       * 少一个的话，写回会在落意图那一步就抛，而抛出来的错
       * 跟写回本身毫无关系。桩缺一个函数造成的失败最难认。
       */
      export function provenanceTag(p) {
        return 'psai:' + p.jobId + '/' + p.assetId + '@' + String(p.attemptId).slice(0, 8);
      }
      export function probeProvenance(target, want) {
        // 默认"核不出来"。用例想模拟"文档里找到了/确实没有"时覆盖它。
        return (__state.probe ?? 'cannot-tell');
      }

      /*
       * 这个桩必须和真桥**同序**：assetOnly 第一句就放行，
       * 之后才轮到"Photoshop 在不在"和"有没有目标"。
       *
       * 以前它无脑返回 ok —— 于是真代码里把 assetOnly 排在目标校验后面
       * 这个缺陷，在这里永远照不出来。桩比真货宽松，测试就测了个寂寞。
       */
      export function validateWritebackTarget(target, mode) {
        if (mode === 'assetOnly') return { ok: true };
        if (!__state.available) return { ok: false, code: 'PHOTOSHOP_NOT_AVAILABLE', message: '桩：不在 Photoshop 里' };
        if (!target || !target.documentId) {
          return { ok: false, code: 'WRITEBACK_TARGET_INVALID', message: '任务没有记录写回目标' };
        }
        return { ok: true };
      }

      export async function writeback(arg) {
        __state.writes.push({
          mode: arg.mode,
          layerName: arg.layerName,
          bytes: arg.bytes?.byteLength ?? 0,
          hasTarget: !!arg.target
        });
        if (__state.delayMs) await new Promise((r) => setTimeout(r, __state.delayMs));
        if (arg.mode === 'assetOnly') return { ok: true, detail: '按设置「仅存资产库」保存，未写回文档' };
        if (!__state.available) return { ok: false, code: 'PHOTOSHOP_NOT_AVAILABLE', detail: '桩：不在 Photoshop 里' };
        return __state.nextResult;
      }
    `
  };
}

async function bundleForTest(outfile, bridgeSource) {
  const entry = join(here, '.autowb-entry.mjs');
  writeFileSync(
    entry,
    [
      "export { maybeAutoWriteback, reconcileAutoWriteback, forgetAutoWriteback, autoWritebackGivenUp, autoWritebackHeldUntil } from '../src/ui/autowriteback.js';",
      "export { performWriteback, performWritebackDetailed } from '../src/ui/page-generate.js';",
      "export { pendingAckCount, flushAcks, clearPendingAcks, resumePendingAcks, setAckStore, stopAckFlush } from '../src/ui/writeback-queue.js';",
      "export { setState, getState, resetStore } from '../src/app/store.js';",
      "export { api, useHelperAt, connectEvents, disconnectEvents, onEventsOpen, eventsConnected } from '../src/app/api.js';"
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
          // Photoshop 桥：换成可控的桩
          b.onResolve({ filter: /ps\/bridge\.js$/ }, () => ({ path: 'psai-bridge', namespace: 'stub' }));
          b.onResolve({ filter: /^(photoshop|uxp|os|fs)$/ }, (a) => ({ path: a.path, namespace: 'stub' }));
          b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => {
            if (a.path === 'psai-bridge') return { contents: bridgeSource, loader: 'js' };
            return {
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

function psTarget() {
  return {
    documentId: 1,
    documentName: 'a.psd',
    documentPath: '',
    canvasWidth: 512,
    canvasHeight: 512,
    sourceLayerIds: [1],
    sourceLayerNames: ['L'],
    selectionBounds: null,
    colorMode: 'RGB',
    bitDepth: 8
  };
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

/** 造一条已经出图、停在待写回的任务，并把它放进面板的状态里。 */
async function pendingJob(rgb) {
  const asset = await uploadPng(rgb);
  const created = await api('POST', '/v1/jobs', {
    featureId: FEATURE,
    params: { prompt: '洗一下', seed: { mode: 'fixed', value: 2 } },
    inputs: [{ paramId: 'image', assetId: asset.id, index: 0, source: 'upload' }],
    target: psTarget(),
    writeback: { mode: 'smartObject', layerName: 'AI 结果' }
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  const job = await waitFor(created.job.id, (j) => j.state === 'writeback_pending');
  ui.setState({ jobs: [job, ...ui.getState().jobs.filter((j) => j.id !== job.id)] });
  return job;
}

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'psai-autowb-'));
  comfy = await startComfyStub(0, { runMs: 100 });
  helper = await startHelper({ port: 0, dataDir, ephemeral: true, workflowsDir: resolve(here, '../../../workflows') });
  PORT = helper.port; // 不从 url 里抠：端口等于 80 时 URL 会规范化掉，Number('') === 0 → undici 报 bad port
  if (!Number.isInteger(PORT) || PORT <= 0) throw new Error(`Helper 端口不可用：${PORT}（url=${helper.url}）`);
  token = helper.issueToken();
  await helper.recovered;

  installUxpDom();

  const bridge = makeBridgeStub();
  globalThis.__psaiBridgeState = bridge.state;

  const outfile = join(dataDir, 'autowb.test.mjs');
  await bundleForTest(outfile, bridge.source);
  ui = await import(pathToFileURL(outfile).href);
  ui.useHelperAt(`http://127.0.0.1:${PORT}`, token);

  await api('PATCH', '/v1/settings', { comfy: { baseUrl: comfy.url }, generation: { autoWriteback: true } });
  const wf = (await api('POST', '/v1/workflows/import', { json: testWorkflow(), name: '自动写回测试用' })).workflow;
  await api('PUT', `/v1/features/${FEATURE}/binding`, { providerId: 'comfyui', workflowId: wf.id, enabled: true });
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

beforeEach(() => {
  const st = globalThis.__psaiBridgeState;
  st.writes.length = 0;
  st.available = true;
  st.nextResult = { ok: true, detail: '写回成功' };
  st.delayMs = 0;
  st.probe = 'cannot-tell';
});

test('任务进入待写回就自动写下去，不用人点', async () => {
  const job = await pendingJob([11, 12, 13]);
  assert.equal(job.writeback.auto, true, '前提：这条任务上冻结的是"要自动写回"');

  await ui.maybeAutoWriteback(job);

  const writes = globalThis.__psaiBridgeState.writes;
  assert.equal(writes.length, 1, `应该正好写一次，实际 ${writes.length} 次`);
  assert.equal(writes[0].mode, 'smartObject');
  assert.ok(writes[0].bytes > 0, '写进去的得是真的图像字节');

  const after_ = (await api('GET', `/v1/jobs/${job.id}`)).job;
  assert.equal(after_.state, 'succeeded', '写回成功后任务该收尾');
});

test('没开自动写回的任务，一个字节都不许写', async () => {
  // 这条是反面保证。自动写回改的是用户的文档 ——
  // 在他没打开这个开关的时候动他的文档，比不自动写回糟糕得多。
  await api('PATCH', '/v1/settings', { generation: { autoWriteback: false } });
  try {
    const job = await pendingJob([21, 22, 23]);
    assert.equal(job.writeback.auto, false, '前提：这条任务上冻结的是"不要自动写回"');

    await ui.maybeAutoWriteback(job);
    assert.equal(globalThis.__psaiBridgeState.writes.length, 0, '没开开关就绝不能动用户的文档');
    assert.equal((await api('GET', `/v1/jobs/${job.id}`)).job.state, 'writeback_pending', '任务该原地不动');
  } finally {
    await api('PATCH', '/v1/settings', { generation: { autoWriteback: true } });
  }
});

test('同一条任务被推送好几次，也只写一次', async () => {
  /*
   * 一次生成会连着推来好几条 job:update（进度、状态迁移、结果落库）。
   * 每一条都触发一次写回的话，用户文档里会多出一叠一模一样的图层。
   */
  const job = await pendingJob([31, 32, 33]);
  globalThis.__psaiBridgeState.delayMs = 120; // 让几次调用真的重叠上

  await Promise.all([
    ui.maybeAutoWriteback(job),
    ui.maybeAutoWriteback(job),
    ui.maybeAutoWriteback(job),
    ui.maybeAutoWriteback(job)
  ]);

  assert.equal(globalThis.__psaiBridgeState.writes.length, 1, '四次推送只该落笔一次');
});

test('Photoshop 不可用时安静跳过，等它回来再说', async () => {
  const job = await pendingJob([41, 42, 43]);
  globalThis.__psaiBridgeState.available = false;

  await ui.maybeAutoWriteback(job);
  assert.equal(globalThis.__psaiBridgeState.writes.length, 0, 'PS 不在就别写');
  assert.equal((await api('GET', `/v1/jobs/${job.id}`)).job.state, 'writeback_pending', '也别把任务判成失败');

  // 回来之后要能接上 —— 不然"PS 暂时不可用"会让这条任务永远卡住
  globalThis.__psaiBridgeState.available = true;
  await ui.maybeAutoWriteback((await api('GET', `/v1/jobs/${job.id}`)).job);
  assert.equal(globalThis.__psaiBridgeState.writes.length, 1, 'PS 回来之后该补上');
});

test('重连之后补写断线期间完成的任务', async () => {
  /*
   * 这是自动写回最该顶用的场景：用户去泡了杯咖啡。
   * 断线期间完成的任务，它们的 job:update 我们没收到，
   * 只靠事件驱动的话会永远停在待写回 —— 而用户以为自动写回在替他干活。
   */
  const a = await pendingJob([51, 52, 53]);
  const b = await pendingJob([54, 55, 56]);

  // 模拟"重连之后重新拉了一遍任务列表"
  ui.setState({ jobs: [(await api('GET', `/v1/jobs/${a.id}`)).job, (await api('GET', `/v1/jobs/${b.id}`)).job] });
  await ui.reconcileAutoWriteback();

  assert.equal(globalThis.__psaiBridgeState.writes.length, 2, '两条都该补上');
  for (const id of [a.id, b.id]) {
    assert.equal((await api('GET', `/v1/jobs/${id}`)).job.state, 'succeeded', `${id} 应该已经写回`);
  }
});

test('写回失败不会陷进无限重试', async () => {
  /*
   * 写回失败最常见的原因是文档被关了、尺寸变了、目标图层没了 ——
   * 全都是重试一百次也一样的。而每次失败都会弹一个红色提示。
   * 任务停在「写回失败（结果已保留）」，用户随时能手动再点一次，
   * 那才是这个状态该有的样子。
   */
  const job = await pendingJob([61, 62, 63]);
  globalThis.__psaiBridgeState.nextResult = { ok: false, detail: '目标文档已经关掉了', code: 'WRITEBACK_TARGET_INVALID' };

  await ui.maybeAutoWriteback(job);
  assert.equal(globalThis.__psaiBridgeState.writes.length, 1);

  const failed = (await api('GET', `/v1/jobs/${job.id}`)).job;
  assert.equal(failed.state, 'retryable_writeback_failure', '写回失败不等于生成失败，结果得留着');
  assert.equal(failed.results.length, 1);

  // 再推几次，不该再写
  globalThis.__psaiBridgeState.nextResult = { ok: true, detail: '写回成功' };
  ui.setState({ jobs: [failed] });
  await ui.reconcileAutoWriteback();
  await ui.maybeAutoWriteback(failed);
  assert.equal(globalThis.__psaiBridgeState.writes.length, 1, '失败过的任务不该被自动反复重试');
  assert.ok(ui.autoWritebackGivenUp().includes(job.id), '应该记着这一条已经放弃了');

  // 但用户手动点「再次写回」必须还能用
  const ok = await ui.performWriteback(failed, 'smartObject', 'AI 结果');
  assert.equal(ok, true, '手动重试是这个状态存在的意义，不能被自动逻辑挡掉');
  assert.equal((await api('GET', `/v1/jobs/${job.id}`)).job.state, 'succeeded');
});

/* ==================== 改文档 与 报结果 是两件事 ==================== */

test('Photoshop 改完了但回报没发出去：绝不重做，只重试通知', async () => {
  /*
   * 这是最坑的一种失败。图**已经**进了用户的文档，而我们因为一个网络抖动
   * 把它记成「写回失败」。用户看到失败就去点「再次写回」——
   * 文档里于是出现第二个一模一样的图层，而且他完全看不出为什么。
   *
   * 所以改文档和报结果必须彻底分开：改完先记在本地，
   * 然后只重试**通知**，绝不重新改文档。
   */
  const job = await pendingJob([151, 152, 153]);
  ui.clearPendingAcks();

  // 让回报这一步失败，但 Photoshop 那一步正常成功
  const realFetch = globalThis.fetch;
  let blocking = true;
  globalThis.fetch = async (url, init) => {
    if (blocking && String(url).includes('/writeback-result')) throw new TypeError('fetch failed');
    return realFetch(url, init);
  };

  try {
    const ok = await ui.performWriteback(job, 'smartObject', 'AI 结果');
    // 关键：Photoshop 那一步成功了，就必须如实返回成功
    assert.equal(ok, true, '文档已经改了，不能因为通知发不出去就说写回失败');
    assert.equal(globalThis.__psaiBridgeState.writes.length, 1, '只该改一次文档');
    assert.equal(ui.pendingAckCount(), 1, '没报上去的结果要留在补报队列里');

    // 再来一次自动写回：绝不能因为 Helper 那边还是 writeback_pending 就重写
    await ui.maybeAutoWriteback((await api('GET', `/v1/jobs/${job.id}`)).job);
    assert.equal(globalThis.__psaiBridgeState.writes.length, 1, '绝不能重做 Photoshop 那一步');
  } finally {
    blocking = false;
    globalThis.fetch = realFetch;
  }

  // 网络恢复之后，补报要能把状态对上
  assert.equal(await ui.flushAcks(), true, '恢复之后应该补报成功');
  assert.equal(ui.pendingAckCount(), 0);
  assert.equal((await api('GET', `/v1/jobs/${job.id}`)).job.state, 'succeeded', '补报之后状态要对上');
});

test('补偿会先把欠着的回报补掉，再决定要不要写', async () => {
  /*
   * 顺序反了的话：扫描看到任务还停在 writeback_pending（因为回报没上去），
   * 于是**再写一遍** —— 用户文档里多一个图层。补报必须排在扫描前面。
   */
  const job = await pendingJob([161, 162, 163]);
  ui.clearPendingAcks();

  const realFetch = globalThis.fetch;
  let blocking = true;
  globalThis.fetch = async (url, init) => {
    if (blocking && String(url).includes('/writeback-result')) throw new TypeError('fetch failed');
    return realFetch(url, init);
  };
  try {
    await ui.performWriteback(job, 'smartObject', 'AI 结果');
    assert.equal(ui.pendingAckCount(), 1, '前提：有一条欠着的回报');
  } finally {
    blocking = false;
    globalThis.fetch = realFetch;
  }

  const writesBefore = globalThis.__psaiBridgeState.writes.length;
  await ui.reconcileAutoWriteback();
  assert.equal(globalThis.__psaiBridgeState.writes.length, writesBefore, '补报之后就不该再写一遍');
  assert.equal((await api('GET', `/v1/jobs/${job.id}`)).job.state, 'succeeded');
});

test('撞上别人正在写不是失败，租约到期后还要再试', async () => {
  /*
   * WRITEBACK_IN_PROGRESS 只是"有人已经在写了"。那次写回可能几秒后就完了，
   * 也可能是一条卡死的租约、两分钟后自动让位。当成永久失败的话，
   * 一次偶然的撞车会让这条任务再也不会被自动写回，而用户完全看不出为什么。
   */
  const job = await pendingJob([171, 172, 173]);
  // 先把执行权占掉，制造撞车
  const lease = await api('POST', `/v1/jobs/${job.id}/writeback`, {});
  assert.equal(lease.ok, true);

  const writesBefore = globalThis.__psaiBridgeState.writes.length;
  await ui.maybeAutoWriteback(job);
  assert.equal(globalThis.__psaiBridgeState.writes.length, writesBefore, '撞车时不该动文档');

  // 撞车登记的是"稍后再试"，不是"永久放弃"—— 两者对用户的意义完全不同：
  // 一个要他手动点一下，一个什么都不用做。
  assert.ok(!ui.autoWritebackGivenUp().includes(job.id), '撞车不该被记成永久放弃');
  const until = ui.autoWritebackHeldUntil(job.id);
  assert.ok(until && until > Date.now(), '要登记一个到期时间，过了就再试');

  // 那次写回收尾之后，这条任务照样能被自动写回 —— 只是要等按下不表的时间过去
  await api('POST', `/v1/jobs/${job.id}/writeback-result`, {
    ok: true,
    detail: 'ok',
    attemptId: lease.attemptId
  });
});

test('真失败才永久放弃，而且手动重试不受影响', async () => {
  const job = await pendingJob([181, 182, 183]);
  globalThis.__psaiBridgeState.nextResult = { ok: false, detail: '目标文档已经关掉了', code: 'WRITEBACK_TARGET_INVALID' };
  await ui.maybeAutoWriteback(job);

  assert.ok(ui.autoWritebackGivenUp().includes(job.id), '真失败要记成永久放弃，别反复弹红色提示');

  globalThis.__psaiBridgeState.nextResult = { ok: true, detail: '写回成功' };
  const fresh = (await api('GET', `/v1/jobs/${job.id}`)).job;
  ui.setState({ jobs: [fresh] });
  const ok = await ui.performWriteback(fresh, 'smartObject', 'AI 结果');
  assert.equal(ok, true, '手动重试是这个状态存在的意义，不能被自动逻辑挡掉');
});

/* ==================== 只靠 WebSocket 重连触发的补偿 ==================== */

test('WebSocket 断了又连上时会补偿，不依赖健康检查', async () => {
  /*
   * 健康检查走的是 HTTP：它说"在线"的时候 WebSocket 可能还在重连。
   * 而 WebSocket 自己悄悄重连的那些次（网络抖一下）根本不经过健康检查 ——
   * 那期间漏掉的 job:update 就永远没人补，任务停在「等待写回」不动，
   * 用户看到的是"自动写回没生效"。
   */
  let opened = 0;
  const off = ui.onEventsOpen(() => opened++);
  try {
    await ui.connectEvents();
    const t0 = Date.now();
    while (!ui.eventsConnected() && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 30));
    assert.ok(ui.eventsConnected(), 'WebSocket 应该连上了');
    assert.ok(opened >= 1, 'onopen 回调必须被触发 —— 补偿就挂在它上面');

    // 断开再连：每一次真正连上都要触发一次
    const before = opened;
    ui.disconnectEvents();
    await ui.connectEvents();
    const t1 = Date.now();
    while (opened <= before && Date.now() - t1 < 5000) await new Promise((r) => setTimeout(r, 30));
    assert.ok(opened > before, '重连之后也要触发，否则断线期间漏掉的事件永远没人补');
  } finally {
    off();
    ui.disconnectEvents();
  }
});

test('补偿会重新拉一份任务快照，而不是用断线前的内存副本', async () => {
  /*
   * 断线期间的 job:update 我们没收到，内存里那份是断线**之前**的快照。
   * 拿它去判断"谁还等着写回"，会漏掉断线期间才完成的那些 ——
   * 而那恰恰是这个函数存在的全部理由。
   */
  const job = await pendingJob([191, 192, 193]);
  // 模拟"断线期间完成的任务"：内存里根本没有它
  ui.setState({ jobs: [] });
  ui.clearPendingAcks();

  const writesBefore = globalThis.__psaiBridgeState.writes.length;
  await ui.reconcileAutoWriteback();

  assert.equal(globalThis.__psaiBridgeState.writes.length, writesBefore + 1, '重新拉一份才发现得了它');
  assert.equal((await api('GET', `/v1/jobs/${job.id}`)).job.state, 'succeeded');
});

/* ==================== 仅存资产库：不该依赖 Photoshop，也不该依赖目标 ==================== */

/*
 * assetOnly 是唯一一条**必定能成功**的写回路径 —— 它压根不碰文档，
 * 结果早就在资产库里了，"写回"只是记一笔账。
 *
 * 可它以前被两道前置检查挡着：先查有没有目标文档，再查桥可不可用。
 * 而这两件事恰恰是最常落到 assetOnly 的情形：
 *   · 用户提交时没有打开任何文档（于是 job.target 是空的）
 *   · Photoshop 崩过一次 / 面板跑在浏览器预览里（于是桥不可用）
 * 结果用户得到的是「该任务没有记录 Photoshop 目标」，
 * 而他要的只是把图存下来。
 *
 * 下面几条走的是真路径：真 Helper、真 HTTP、真 performWritebackDetailed，
 * 只有最后落笔那一下是桩（Node 里没有 Photoshop）。
 */

/** 造一条**没有目标文档**、写回方式是 assetOnly 的任务。 */
async function assetOnlyJob(rgb) {
  const asset = await uploadPng(rgb);
  const created = await api('POST', '/v1/jobs', {
    featureId: FEATURE,
    params: { prompt: '洗一下', seed: { mode: 'fixed', value: 21 } },
    inputs: [{ paramId: 'image', assetId: asset.id, index: 0, source: 'upload' }],
    // 提交时没有打开的文档 —— target 整个缺席
    writeback: { mode: 'assetOnly', layerName: 'AI 结果' }
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  // assetOnly 不需要写回，任务直接收尾
  const job = await waitFor(created.job.id, (j) => j.state === 'succeeded');
  assert.equal(job.target, null, '前提：这条任务确实没有目标文档');
  ui.setState({ jobs: [job, ...ui.getState().jobs.filter((j) => j.id !== job.id)] });
  return job;
}

test('assetOnly：没有目标文档也能写回成功', async () => {
  const job = await assetOnlyJob([21, 22, 23]);

  const res = await ui.performWritebackDetailed(job, 'assetOnly', 'AI 结果');
  assert.equal(res.ok, true, `没有目标不该挡住 assetOnly：${res.detail}`);
  assert.equal(res.busy, false);

  const writes = globalThis.__psaiBridgeState.writes;
  assert.equal(writes.length, 1, '该走到落笔那一步（哪怕它什么都不做）');
  assert.equal(writes[0].mode, 'assetOnly');
  assert.equal(writes[0].hasTarget, false, '没有目标就别硬凑一个传下去');
});

test('assetOnly：Photoshop 不可用时照样写回成功', async () => {
  const job = await assetOnlyJob([24, 25, 26]);
  globalThis.__psaiBridgeState.available = false;

  const res = await ui.performWritebackDetailed(job, 'assetOnly', 'AI 结果');
  assert.equal(res.ok, true, `桥不可用不该挡住 assetOnly：${res.detail}`);
});

test('assetOnly：既没有目标、Photoshop 也不可用，仍然成功', async () => {
  // 两个条件同时成立才是真实场景：浏览器预览里点历史页的「写回」。
  const job = await assetOnlyJob([27, 28, 29]);
  globalThis.__psaiBridgeState.available = false;

  const res = await ui.performWritebackDetailed(job, 'assetOnly', 'AI 结果');
  assert.equal(res.ok, true, res.detail);

  const after_ = (await api('GET', `/v1/jobs/${job.id}`)).job;
  assert.equal(after_.state, 'succeeded', '账要记上：任务停在 succeeded');
});

test('assetOnly 的账照样要记：Helper 那边发得出凭据、收得到结论', async () => {
  /*
   * "不碰文档"不等于"不记账"。历史页要能看出这一次点过写回、
   * 结论是什么；否则用户点完什么反馈都没有，只会再点一次。
   */
  const job = await assetOnlyJob([30, 31, 32]);
  const lease = await api('POST', `/v1/jobs/${job.id}/writeback`, { mode: 'assetOnly', layerName: 'AI 结果' });
  assert.equal(lease.ok, true, `没有目标的 assetOnly 也该发得出凭据：${JSON.stringify(lease)}`);
  assert.ok(lease.attemptId, '得有 attemptId，否则回报时对不上号');

  const done = await api('POST', `/v1/jobs/${job.id}/writeback-result`, {
    attemptId: lease.attemptId,
    ok: true,
    detail: '按设置「仅存资产库」保存'
  });
  assert.equal(done.ok, true, JSON.stringify(done));
});

test('非 assetOnly 的方式，没有目标时照旧被拒 —— 这道闸门不能一起放开', async () => {
  /*
   * 前面几条放开的只是 assetOnly。智能对象是真的要往文档里放东西，
   * 没有目标就是写不了 —— 那时候必须如实拒绝，而不是假装成功。
   */
  const job = await assetOnlyJob([33, 34, 35]);

  const res = await ui.performWritebackDetailed(job, 'smartObject', 'AI 结果');
  assert.equal(res.ok, false, '没有目标的智能对象写回必须失败');
  assert.match(res.detail, /没有记录 Photoshop 目标/);
  assert.deepEqual(globalThis.__psaiBridgeState.writes, [], '不该走到落笔那一步');

  const lease = await api('POST', `/v1/jobs/${job.id}/writeback`, { mode: 'smartObject', layerName: 'AI 结果' });
  assert.equal(lease.ok, false, 'Helper 那边也要拦 —— 绕过插件直接打接口同样不行');
});

/* ==================== 待报队列要活过一次面板重载 ==================== */

/*
 * 到了要回报的这一刻，图**已经**进了用户的文档 —— 那一步不可撤销。
 * 如果队列只在内存里，面板一重载（用户关掉再打开、插件重载、Photoshop 重启）
 * 它就没了：Helper 那边永远等不到结论，租约过期后判成
 * 「等待插件回报超时」，用户在历史页看到「写回失败」——
 * 而他文档里那个图层好端端地待着。
 *
 * 接下来他会去点「再次写回」，于是文档里出现第二个一模一样的图层。
 * 这正是整套写回设计最想避免的那件事，而触发它的只是一次普通的面板重载。
 */

/**
 * 一份跨"面板实例"共享的落盘后端。
 *
 * 放在 globalThis 上，因为"面板重载"在这里是**再打包一份模块**——
 * 两份模块各有各的内存状态，只有这个后端是共用的，
 * 正如真机上两次面板生命周期共用同一个数据目录。
 */
function sharedRecordStore() {
  const backing = (globalThis.__psaiAckFiles ??= new Map());
  return {
    write: async (name, text) => {
      backing.set(name, text);
    },
    read: async (name) => backing.get(name) ?? null,
    remove: async (name) => {
      backing.delete(name);
    },
    list: async () => [...backing.keys()]
  };
}

function resetAckFiles() {
  globalThis.__psaiAckFiles = new Map();
}

function ackFiles() {
  return globalThis.__psaiAckFiles ?? new Map();
}

/**
 * 拿一份**全新模块状态**的 UI —— 等价于面板重载之后的那一份。
 *
 * 只打包一次，之后靠 URL 上的查询串拿新实例：Node 的 ESM 缓存是按
 * 完整 URL 算的，`?v=2` 就是另一个模块。
 * 每次都重新 esbuild 的话，光这一个文件就要跑四分钟 ——
 * 而慢到没人愿意跑的测试，和没有测试差不多。
 */
let reloadBundle = null;
let reloadSeq = 0;
async function reloadPanel() {
  if (!reloadBundle) {
    reloadBundle = join(dataDir, 'autowb.reload.mjs');
    await bundleForTest(reloadBundle, makeBridgeStub().source);
  }
  const fresh = await import(`${pathToFileURL(reloadBundle).href}?v=${++reloadSeq}`);
  fresh.useHelperAt(`http://127.0.0.1:${PORT}`, token);
  fresh.setAckStore(sharedRecordStore());
  return fresh;
}

test('面板重载之后，没报上去的结果还在，并且能补报成功', async () => {
  const job = await pendingJob([161, 162, 163]);
  ui.clearPendingAcks();
  resetAckFiles();
  ui.setAckStore(sharedRecordStore());

  // Photoshop 那一步成功，回报发不出去
  const realFetch = globalThis.fetch;
  let blocking = true;
  globalThis.fetch = async (url, init) => {
    if (blocking && String(url).includes('/writeback-result')) throw new TypeError('fetch failed');
    return realFetch(url, init);
  };
  try {
    const ok = await ui.performWriteback(job, 'smartObject', 'AI 结果');
    assert.equal(ok, true, '文档已经改了，就该返回成功');
    assert.equal(ui.pendingAckCount(), 1, '前提：有一条没报上去');
  } finally {
    blocking = false;
    globalThis.fetch = realFetch;
  }

  assert.ok(ackFiles().size > 0, '没报上去的结果必须落盘，不能只留在内存里');

  // 面板重载：一份全新的模块状态
  const fresh = await reloadPanel();
  assert.equal(fresh.pendingAckCount(), 0, '前提：新实例一开始是空的');

  const sum = await fresh.resumePendingAcks();
  assert.equal(sum.resumed, 1, '有结论的那一条应该直接接着报');

  await fresh.flushAcks();
  assert.equal(
    (await api('GET', `/v1/jobs/${job.id}`)).job.state,
    'succeeded',
    '补报之后 Helper 那边的状态要对上，而不是等到租约超时判失败'
  );
  fresh.stopAckFlush();
});

test('报掉之后盘上不留垃圾', async () => {
  // 不清的话，每次启动都会把它重新捡起来，然后被 Helper 以
  // "这次写回已经有结论了"拒掉 —— 一条永远处理不完的记录。
  const job = await pendingJob([164, 165, 166]);
  ui.clearPendingAcks();
  resetAckFiles();
  ui.setAckStore(sharedRecordStore());

  await ui.performWriteback(job, 'smartObject', 'AI 结果');
  assert.equal(ui.pendingAckCount(), 0, '前提：已经报上去了');
  assert.equal(ackFiles().size, 0, `报掉之后不该还留着文件：${[...ackFiles().keys()].join('、')}`);
});

/* ==================== 崩溃注入 ==================== */

/*
 * 下面几条模拟"面板在某一步之后突然没了"。
 *
 * 手法是：让那一步之后的代码永远走不到（抛一个不会被吞掉的错，
 * 或者直接不调用），然后**换一份新的模块实例**当作重启。
 * 盘上留下什么，就是真机崩溃时会留下什么。
 */

/**
 * 往盘上留一条"动手了但没有结论"的记录 —— 等价于中途崩溃。
 *
 * 凭据必须是**真的**（从 Helper 领一张），不能随手编一个。
 * 编的那种在补报时会被 Helper 以"凭据不属于这条任务"拒掉，
 * 于是任务状态一动不动 —— 用例看起来在测对账，其实测的是
 * "假凭据会被拒"，而真正的对账逻辑一行都没走到。
 */
async function writeOrphanIntent(job, over = {}) {
  const lease = await api('POST', `/v1/jobs/${job.id}/writeback`, { mode: 'smartObject', layerName: 'AI 结果' });
  assert.equal(lease.ok, true, `前提：得领得到凭据 ${JSON.stringify(lease)}`);
  const attemptId = over.attemptId ?? lease.attemptId;
  const assetId = job.results[0].assetId;
  const intent = {
    attemptId,
    jobId: job.id,
    assetId,
    mode: 'smartObject',
    layerName: 'AI 结果',
    documentId: job.target?.documentId ?? 1,
    documentName: job.target?.documentName ?? 'a.psd',
    documentPath: job.target?.documentPath ?? '',
    provenanceTag: `psai:${job.id}/${assetId}@${attemptId.slice(0, 8)}`,
    startedAt: Date.now(),
    ...over
  };
  ackFiles().set(`${intent.attemptId}.intent.json`, JSON.stringify(intent));
  return intent;
}

test('崩在领到凭据之后、动文档之前：核对到"没写进去"，判失败并可放心重试', async () => {
  /*
   * 这一档是安全的：文档没被动过。必须明确报失败，
   * 好让这条任务回到"可以重写"的状态 —— 卡在等待里才是最坏的。
   */
  const job = await pendingJob([171, 172, 173]);
  ui.clearPendingAcks();
  resetAckFiles();
  await writeOrphanIntent(job);

  const fresh = await reloadPanel();
  globalThis.__psaiBridgeState.probe = 'absent'; // 文档打得开，里面没有那个标记

  const sum = await fresh.resumePendingAcks();
  assert.equal(sum.refuted, 1, '核对到没写进去，就该判失败');
  assert.equal(sum.unknown, 0);

  await fresh.flushAcks();
  const after_ = (await api('GET', `/v1/jobs/${job.id}`)).job;
  assert.equal(after_.state, 'retryable_writeback_failure', '失败但结果保留，可以再写');
  fresh.stopAckFlush();
});

test('崩在图层刚建出来之后：核对到那一次的标记，判成功，绝不重写', async () => {
  /*
   * 图已经在文档里了。这时候判失败的话，用户会去点「再次写回」，
   * 于是文档里出现第二个一模一样的图层 —— 而他看不出区别。
   */
  const job = await pendingJob([174, 175, 176]);
  ui.clearPendingAcks();
  resetAckFiles();
  await writeOrphanIntent(job);

  const fresh = await reloadPanel();
  globalThis.__psaiBridgeState.probe = 'found'; // 文档里找到了那一次的出处标记

  const sum = await fresh.resumePendingAcks();
  assert.equal(sum.confirmed, 1, '找到证据就该判成功');
  assert.deepEqual(globalThis.__psaiBridgeState.writes, [], '对账绝不能顺手再写一次');

  await fresh.flushAcks();
  assert.equal((await api('GET', `/v1/jobs/${job.id}`)).job.state, 'succeeded');
  fresh.stopAckFlush();
});

test('崩在写完之后、落结论之前，而且核不出来：进入"不确定"，绝不自动重写', async () => {
  /*
   * 源文档没打开、或者那个编号已经归了别的文档 —— 什么都不知道。
   *
   * 这时候两个方向都是错的：说成功，用户以为拿到了结果；
   * 说失败，用户去重写，而文档里可能已经有一个了。
   * 唯一诚实的做法是承认不知道，并要求人先去看一眼。
   */
  const job = await pendingJob([177, 178, 179]);
  ui.clearPendingAcks();
  resetAckFiles();
  await writeOrphanIntent(job);

  const fresh = await reloadPanel();
  globalThis.__psaiBridgeState.probe = 'cannot-tell';

  const sum = await fresh.resumePendingAcks();
  assert.equal(sum.unknown, 1, '核不出来就该进入"不确定"');
  assert.deepEqual(globalThis.__psaiBridgeState.writes, [], '不确定的时候更不能自动再写');

  await fresh.flushAcks();
  const after_ = (await api('GET', `/v1/jobs/${job.id}`)).job;
  assert.equal(after_.error?.code, 'WRITEBACK_UNKNOWN', '要用专门的码，不能和"失败"混为一谈');
  assert.match(after_.error.message + (after_.error.details ?? ''), /检查|确认/, '要让人先去看一眼文档');
  fresh.stopAckFlush();
});

test('"不确定"的任务不会被自动写回捡起来', async () => {
  // 文档里可能已经有一个了，自动再写就是第二个。这一档必须由人来判断。
  const job = await pendingJob([180, 181, 182]);
  ui.clearPendingAcks();

  const unknownJob = {
    ...job,
    state: 'writeback_pending',
    error: { code: 'WRITEBACK_UNKNOWN', message: '写回被中断且无法确认结果', retryable: false }
  };
  await ui.maybeAutoWriteback(unknownJob);
  assert.deepEqual(globalThis.__psaiBridgeState.writes, [], '不确定的任务绝不自动写');
});

test('崩在落结论的过程中（文件写了一半）：按不确定处理，不拿半条记录当真', async () => {
  const job = await pendingJob([183, 184, 185]);
  ui.clearPendingAcks();
  resetAckFiles();
  const intent = await writeOrphanIntent(job);
  // 结论文件写了一半就断电
  ackFiles().set(`${intent.attemptId}.done.json`, '{"ok":tr');

  const fresh = await reloadPanel();
  globalThis.__psaiBridgeState.probe = 'found'; // 就算文档里找得到，坏记录也不该被当真

  const sum = await fresh.resumePendingAcks();
  assert.equal(sum.resumed, 0, '坏掉的结论不能当成有结论');
  assert.equal(sum.unknown, 1, '半条记录一律按不确定处理');
  fresh.stopAckFlush();
});

test('意图文件本身坏了：丢掉，绝不让面板起不来', async () => {
  /*
   * 这段代码跑在启动路径上。抛出去的话整个面板打不开，
   * 而代价远大于丢掉一条待报记录。
   */
  ui.clearPendingAcks();
  resetAckFiles();
  ackFiles().set('att_broken.intent.json', '{ 这不是 JSON');

  const fresh = await reloadPanel();
  const sum = await fresh.resumePendingAcks();
  assert.equal(sum.resumed + sum.confirmed + sum.refuted + sum.unknown, 0, '连是哪条任务都不知道，只能丢掉');
  assert.equal(fresh.pendingAckCount(), 0);
  fresh.stopAckFlush();
});

test('两次写回并发落盘：各写各的，不会互相覆盖', async () => {
  /*
   * 早先是一整个 JSON 数组反复覆写：后写的那次会把前一次的内容整个盖掉，
   * 于是先完成的那条写回就此消失 —— Helper 永远等不到它的结论。
   * 现在一条记录一个文件。
   */
  ui.clearPendingAcks();
  resetAckFiles();
  ui.setAckStore(sharedRecordStore());

  const a = await pendingJob([186, 187, 188]);
  const b = await pendingJob([189, 190, 191]);

  const realFetch = globalThis.fetch;
  let blocking = true;
  globalThis.fetch = async (url, init) => {
    if (blocking && String(url).includes('/writeback-result')) throw new TypeError('fetch failed');
    return realFetch(url, init);
  };
  try {
    await Promise.all([
      ui.performWriteback(a, 'smartObject', 'AI 结果'),
      ui.performWriteback(b, 'smartObject', 'AI 结果')
    ]);
    assert.equal(ui.pendingAckCount(), 2, '两条都该留在队列里');
  } finally {
    blocking = false;
    globalThis.fetch = realFetch;
  }

  const done = [...ackFiles().keys()].filter((k) => k.endsWith('.done.json'));
  assert.equal(done.length, 2, `两条结论都该在盘上，实际只有 ${done.length} 条`);

  await ui.flushAcks();
  for (const j of [a, b]) {
    assert.equal((await api('GET', `/v1/jobs/${j.id}`)).job.state, 'succeeded');
  }
});


test('408 / 429 不是"这条请求有问题"，不能把已经改完文档的记录扔掉', async () => {
  /*
   * 老代码一刀切：所有 4xx 都从队列里删掉。
   * 于是服务端限流（429）或者一次请求超时（408）的时候，
   * 一条**文档已经改完**的记录被直接扔了 —— Helper 永远等不到结论。
   */
  for (const status of [408, 429]) {
    const job = await pendingJob([170 + status / 8, 171, 172]);
    ui.clearPendingAcks();

    const realFetch = globalThis.fetch;
    let blocking = true;
    globalThis.fetch = async (url, init) => {
      if (blocking && String(url).includes('/writeback-result')) {
        return new Response(JSON.stringify({ ok: false, error: { code: 'PROVIDER_RATE_LIMIT', message: '慢点' } }), {
          status,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return realFetch(url, init);
    };
    try {
      await ui.performWriteback(job, 'smartObject', 'AI 结果');
      assert.equal(ui.pendingAckCount(), 1, `HTTP ${status} 之后这条记录必须留着重试`);
    } finally {
      blocking = false;
      globalThis.fetch = realFetch;
    }

    assert.equal(await ui.flushAcks(), true, `恢复之后 HTTP ${status} 那条应该补报成功`);
    assert.equal((await api('GET', `/v1/jobs/${job.id}`)).job.state, 'succeeded');
  }
});

test('真的说不通的 4xx（凭据无效）照旧丢掉，别占着队列', async () => {
  // 这道闸门只对"待会儿再来"那几个码放开，不能一起放开。
  const job = await pendingJob([178, 179, 180]);
  ui.clearPendingAcks();

  const realFetch = globalThis.fetch;
  let blocking = true;
  globalThis.fetch = async (url, init) => {
    if (blocking && String(url).includes('/writeback-result')) {
      return new Response(JSON.stringify({ ok: false, error: { code: 'JOB_PARAM_INVALID', message: '凭据不认' } }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return realFetch(url, init);
  };
  try {
    await ui.performWriteback(job, 'smartObject', 'AI 结果');
    assert.equal(ui.pendingAckCount(), 0, '再报一百次也是一样的结果');
  } finally {
    blocking = false;
    globalThis.fetch = realFetch;
  }
});

/* ==================== 排队期间的租约 ==================== */

test('排队等 Photoshop 的时候也在续租，不是抢到锁才开始', async () => {
  /*
   * executeAsModal 是全局独占的，写回要排队。排在前面的可能是
   * 另一条任务的 8K 智能对象，几十秒起步 —— 而租约只有两分钟。
   * 心跳放在锁**里面**的话，这一整段排队时间没人续租：
   * 轮到我们时租约可能早过期，Helper 已经允许别人接手，
   * 接下来两边都会往文档里放一张图。
   */
  const job = await pendingJob([181, 182, 183]);

  let renews = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/writeback/renew')) renews++;
    return realFetch(url, init);
  };

  // 让落笔那一步慢下来，制造一段"排队 + 执行"的时间
  globalThis.__psaiBridgeState.delayMs = 60;
  try {
    await ui.performWriteback(job, 'smartObject', 'AI 结果');
  } finally {
    globalThis.fetch = realFetch;
    globalThis.__psaiBridgeState.delayMs = 0;
  }

  assert.ok(renews >= 1, '抢到锁、动文档之前必须先确认凭据还有效');
});

test('排队期间凭据被顶替：一个字节都不许写，也不许拿它报失败', async () => {
  /*
   * 那张凭据在 Helper 那边已经有结论了（被顶替 / 超时）。
   * 拿它去报一次"写回失败"，覆盖掉的可能是另一个写手刚刚成功的那一次 ——
   * 用户看到"失败"，然后再写一遍，文档里多一个图层。
   * 而我们这边其实一个字节都没动过。
   */
  const job = await pendingJob([184, 185, 186]);
  ui.clearPendingAcks();

  const realFetch = globalThis.fetch;
  let reportCalls = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/writeback/renew')) {
      // 模拟"这张凭据已经有结论了"
      return new Response(JSON.stringify({ ok: true, renewed: false, reason: '这次写回已经有结论了（superseded）' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    if (String(url).includes('/writeback-result')) reportCalls++;
    return realFetch(url, init);
  };
  try {
    const res = await ui.performWritebackDetailed(job, 'smartObject', 'AI 结果');
    assert.equal(res.ok, false);
    assert.equal(res.busy, true, '这是"有人已经在写了"，不是写回失败');
    assert.deepEqual(globalThis.__psaiBridgeState.writes, [], '文档一个字节都不许动');
    assert.equal(reportCalls, 0, '绝不能拿一张已经有结论的凭据去报失败');
  } finally {
    globalThis.fetch = realFetch;
  }
});
