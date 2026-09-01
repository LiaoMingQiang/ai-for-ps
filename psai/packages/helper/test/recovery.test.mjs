/**
 * 重启恢复测试。
 *
 * 这是整个引擎里最贵的一条规则：Helper 重启后必须**先查远端真实状态**，
 * 绝不能因为"本地不知道"就重新提交 —— 那会重复占卡、重复计费。
 * 所以这里用同一个数据目录起两次 Helper，并统计桩收到的提交次数。
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startHelper } from '../dist/index.js';
import { startComfyStub, makePng } from '../../../tools/comfy-stub.mjs';
import { assertCleanLog } from './_log-assertions.mjs';

/*
 * 端口由系统分配，不写死。
 *
 * 写死有两个坑，第二个尤其阴：上一次跑崩留下的进程会一直占着；
 * 而 Windows 上端口被占**未必**报 EADDRINUSE —— 可能就那么挂着，
 * 整个套件一条输出都没有，报出来是一次超时，跟真正的原因毫无关系。
 * 每次 startHelper 之后都要重新读一遍：重启拿到的是新端口。
 */
let PORT = 0;

let stub;
let dataDir;
let helper;
let token;

function url(path) {
  return `http://127.0.0.1:${PORT}${path}`;
}

async function api(method, path, body) {
  const headers = { Authorization: `Bearer ${token}` };
  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  // Helper 重启后，连接池里可能还留着指向旧进程的死连接，第一次会 ECONNRESET。
  // 这是测试进程复用连接的产物，不是服务端问题，重试即可。
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url(path), { method, headers, body: payload });
      return { status: res.status, json: await res.json() };
    } catch (e) {
      if (attempt >= 3) throw e;
      await new Promise((r) => setTimeout(r, 120));
    }
  }
}

async function uploadPng() {
  const png = makePng(64, 64, [12, 34, 56]);
  const fd = new FormData();
  fd.append('file', new Blob([png], { type: 'image/png' }), 'in.png');
  const res = await fetch(url('/v1/assets'), {
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
    4: { class_type: 'CLIPTextEncode', inputs: { text: 'x', clip: ['1', 1] }, _meta: { title: 'Positive' } },
    5: { class_type: 'CLIPTextEncode', inputs: { text: 'y', clip: ['1', 1] }, _meta: { title: 'Negative' } },
    6: { class_type: 'VAEEncode', inputs: { pixels: ['2', 0], vae: ['1', 2] } },
    3: {
      class_type: 'KSampler',
      inputs: {
        model: ['1', 0],
        seed: 1,
        steps: 8,
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
    const { json } = await api('GET', `/v1/jobs/${jobId}`);
    last = json.job;
    if (last && predicate(last)) return last;
    await new Promise((r) => setTimeout(r, 60));
  }
  throw new Error(`超时：最后状态=${last?.state} 错误=${JSON.stringify(last?.error)}`);
}

async function boot() {
  helper = await startHelper({ dataDir, port: 0, ephemeral: true });
  PORT = Number(new URL(helper.url).port);
  token = helper.issueToken();
  // 等恢复跑完再断言，否则会读到恢复中途的状态
  await helper.recovered;
}

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'psai-recovery-'));
  stub = await startComfyStub(0, { runMs: 200 });
  await boot();
  await api('PATCH', '/v1/settings', { comfy: { baseUrl: stub.url } });
});

after(async () => {
  await helper?.stop();
  await stub?.stop();
  /*
   * 停机之后、删目录之前翻一遍日志。
   *
   * 非法状态转移和唯一约束冲突都不会让任何用例变红：前者只是被
   * transition() 拒绝 + 记一条 warn，后者会被事务吞掉走别的分支。
   * 它们会一直积着，直到某天某条路径真的因为被拒而卡死 ——
   * 而那时候现场早就没了。
   *
   * 位置很讲究：早于 helper.stop() 会让进程退不出去（报成超时），
   * 晚于 rmSync 则日志已经被删了。失败也要先清理再抛，
   * 否则每失败一次就漏一个临时目录。
   */
  let logProblem = null;
  try {
    if (dataDir) assertCleanLog(dataDir);
  } catch (e) {
    logProblem = e;
  }
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* noop */
  }
  if (logProblem) throw logProblem;
});

test('重启后：远端已完成的任务直接取结果，不重新提交', async () => {
  const wf = (await api('POST', '/v1/workflows/import', { json: testWorkflow(), name: '恢复用工作流' })).json.workflow;
  await api('PUT', '/v1/features/comfy.wash.portrait/binding', {
    providerId: 'comfyui',
    workflowId: wf.id,
    enabled: true
  });

  // 挂住队列，让任务停在"已提交但没跑完"
  stub.setHold(true);
  const asset = await uploadPng();
  const created = await api('POST', '/v1/jobs', {
    featureId: 'comfy.wash.portrait',
    params: { prompt: '恢复测试', seed: { mode: 'fixed', value: 7 } },
    inputs: [{ paramId: 'image', assetId: asset.id, index: 0, source: 'layer' }],
    target: {
      documentId: 1,
      documentName: 'a.psd',
      documentPath: '',
      canvasWidth: 100,
      canvasHeight: 100,
      sourceLayerIds: [1],
      sourceLayerNames: ['L'],
      selectionBounds: null,
      colorMode: 'RGB',
      bitDepth: 8
    },
    writeback: { mode: 'smartObject' }
  });
  const jobId = created.json.job.id;
  const submitted = await waitFor(jobId, (j) => !!j.remoteId);
  const remoteId = submitted.remoteId;
  const submitCountBefore = stub.tasks.size;
  assert.equal(submitCountBefore, 1, '此时桩上应只有 1 条提交');

  // 模拟 Helper 挂掉
  await helper.stop();

  // Helper 不在的时候，远端把活干完了
  stub.setHold(false);
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(stub.tasks.get(remoteId).state, 'done', '远端应已完成');

  // 重启
  await boot();

  const done = await waitFor(jobId, (j) => j.results.length > 0 || j.state === 'lost', 20000);
  assert.equal(done.results.length, 1, '应直接取回远端已完成的结果');
  assert.equal(done.remoteId, remoteId, '远端任务号不应变化');
  assert.equal(stub.tasks.size, submitCountBefore, '绝不能重新提交（桩上的任务数必须没变）');

  const events = (await api('GET', `/v1/jobs/${jobId}/events`)).json.events;
  assert.ok(
    events.some((e) => e.note.includes('远端已完成')),
    '恢复动作应留下审计记录'
  );
});

test('重启后：远端仍在排队的任务继续监听并完成，同样不重新提交', async () => {
  stub.setHold(true);
  const asset = await uploadPng();
  const created = await api('POST', '/v1/jobs', {
    featureId: 'comfy.wash.portrait',
    params: { prompt: '继续监听', seed: { mode: 'fixed', value: 8 } },
    inputs: [{ paramId: 'image', assetId: asset.id, index: 0, source: 'layer' }],
    target: null,
    writeback: { mode: 'assetOnly' }
  });
  const jobId = created.json.job.id;
  await waitFor(jobId, (j) => !!j.remoteId);
  const countBefore = stub.tasks.size;

  await helper.stop();
  await boot();

  // 重启后远端才开始跑
  stub.setHold(false);
  const done = await waitFor(jobId, (j) => j.results.length > 0 || j.state === 'lost', 25000);
  assert.equal(done.results.length, 1, '应继续监听到结果');
  assert.equal(stub.tasks.size, countBefore, '不能重新提交');
});

test('重启后：远端查不到的任务如实标记为丢失，不伪装成功也不重跑', async () => {
  stub.setHold(true);
  const asset = await uploadPng();
  const created = await api('POST', '/v1/jobs', {
    featureId: 'comfy.wash.portrait',
    params: { prompt: '会丢失', seed: { mode: 'fixed', value: 9 } },
    inputs: [{ paramId: 'image', assetId: asset.id, index: 0, source: 'layer' }],
    target: null,
    writeback: { mode: 'assetOnly' }
  });
  const jobId = created.json.job.id;
  const submitted = await waitFor(jobId, (j) => !!j.remoteId);

  await helper.stop();

  // 远端把这条任务弄丢了（相当于 ComfyUI 重启过）
  stub.tasks.delete(submitted.remoteId);
  stub.setHold(false);
  // 桩是跨用例共享的，只能比较"有没有新增提交"，不能比较总数
  const countAfterDelete = stub.tasks.size;

  await boot();

  const lost = await waitFor(jobId, (j) => j.state === 'lost', 20000);
  assert.equal(lost.state, 'lost');
  assert.equal(lost.results.length, 0, '不能凭空产生结果');
  assert.equal(lost.error.code, 'JOB_LOST');
  assert.equal(stub.tasks.size, countAfterDelete, '不能悄悄重新提交');
});

test('重启后：还没提交出去的任务重新入队并正常完成', async () => {
  // 先挂住并发，让任务停在 queued_local
  await api('PATCH', '/v1/settings', { generation: { maxConcurrency: 1 } });
  stub.setHold(true);

  const a = await uploadPng();
  const first = await api('POST', '/v1/jobs', {
    featureId: 'comfy.wash.portrait',
    params: { prompt: '占住并发', seed: { mode: 'fixed', value: 10 } },
    inputs: [{ paramId: 'image', assetId: a.id, index: 0, source: 'layer' }],
    target: null,
    writeback: { mode: 'assetOnly' }
  });
  await waitFor(first.json.job.id, (j) => !!j.remoteId);

  const second = await api('POST', '/v1/jobs', {
    featureId: 'comfy.wash.portrait',
    params: { prompt: '排队等着', seed: { mode: 'fixed', value: 11 } },
    inputs: [{ paramId: a.id ? 'image' : 'image', assetId: a.id, index: 0, source: 'layer' }],
    target: null,
    writeback: { mode: 'assetOnly' }
  });
  const queuedId = second.json.job.id;
  const queued = (await api('GET', `/v1/jobs/${queuedId}`)).json.job;
  assert.equal(queued.state, 'queued_local');
  assert.equal(queued.remoteId, null, '还没提交出去');

  await helper.stop();
  await boot();
  stub.setHold(false);

  const done = await waitFor(queuedId, (j) => j.results.length > 0, 30000);
  assert.equal(done.results.length, 1, '重新入队后应正常完成');
});
