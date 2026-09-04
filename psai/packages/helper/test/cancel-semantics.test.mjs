/**
 * 取消的语义：说"已取消"之前，得先确定它真的停了。
 *
 * 这一组针对的是三种"汇报成功但其实什么都没发生"：
 *   1. 队列删除对一条**已经开跑**的任务无效，而 ComfyUI 照样回 200
 *   2. 全局 /interrupt 掐掉的可能是别人 —— 靠一个队列快照授权它是不成立的
 *   3. 远端不支持取消时，任务得原样退回去，不能卡在「取消中」
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { startHelper } from '../dist/index.js';
import { startComfyStub, makePng } from '../../../tools/comfy-stub.mjs';

/*
 * 端口由系统分配，不写死。
 *
 * 写死有两个坑，第二个尤其阴：上一次跑崩留下的进程会一直占着；
 * 而 Windows 上端口被占**未必**报 EADDRINUSE —— 可能就那么挂着，
 * 整个套件一条输出都没有，报出来是一次超时，跟真正的原因毫无关系。
 * 每次 startHelper 之后都要重新读一遍：重启拿到的是新端口。
 */
let PORT = 0;
const FEATURE = 'comfy.wash.portrait';

let helper;
let comfy;
let dataDir;
let token;

function url(path) {
  if (!Number.isInteger(PORT) || PORT <= 0) {
    throw new Error(`测试用的 Helper 端口无效：PORT=${PORT}。多半是某次启动 Helper 没成功，或者在赋值前就发了请求。`);
  }
  return `http://127.0.0.1:${PORT}${path}`;
}

async function api(method, path, body) {
  const headers = { Authorization: `Bearer ${token}` };
  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(url(path), { method, headers, body: payload });
  return { status: res.status, json: await res.json() };
}

async function uploadPng(rgb) {
  const fd = new FormData();
  fd.append('file', new Blob([makePng(64, 64, rgb)], { type: 'image/png' }), 'in.png');
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
    last = (await api('GET', `/v1/jobs/${jobId}`)).json.job;
    if (last && predicate(last)) return last;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`超时：最后状态=${last?.state}`);
}

async function comfyJob(rgb) {
  const asset = await uploadPng(rgb);
  const { json } = await api('POST', '/v1/jobs', {
    featureId: FEATURE,
    params: { prompt: '洗一下', seed: { mode: 'fixed', value: 5 } },
    inputs: [{ paramId: 'image', assetId: asset.id, index: 0, source: 'upload' }],
    target: null,
    writeback: { mode: 'assetOnly' }
  });
  assert.equal(json.ok, true, JSON.stringify(json));
  return json.job.id;
}

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'psai-cancelsem-'));
  comfy = await startComfyStub(0, { runMs: 8000 });
  helper = await startHelper({ dataDir, port: 0, ephemeral: true });
  PORT = helper.port; // 不从 url 里抠：端口等于 80 时 URL 会规范化掉，Number('') === 0 → undici 报 bad port
  if (!Number.isInteger(PORT) || PORT <= 0) throw new Error(`Helper 端口不可用：${PORT}（url=${helper.url}）`);
  token = helper.issueToken();
  await helper.recovered;

  await api('PATCH', '/v1/settings', { comfy: { baseUrl: comfy.url, exclusive: false } });
  const wf = (await api('POST', '/v1/workflows/import', { json: testWorkflow(), name: '取消语义测试' })).json.workflow;
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

test('队列删除什么也没删掉时，绝不汇报成"已取消"', async () => {
  /*
   * ComfyUI 对 `{delete:[...]}` 一律回 200，哪怕那个 id 根本不在队列里。
   * 最常见的情形是：我们以为它在排队，其实它刚刚开始执行。
   * 只看状态码的话，界面显示"已取消"，而 ComfyUI 把它跑完 ——
   * 显卡白烧一轮，结果还会在下一次轮询时冒出来，撞上一条"已取消"的任务。
   */
  comfy.setHold(true);
  try {
    const jobId = await comfyJob([11, 12, 13]);
    const submitted = await waitFor(jobId, (j) => !!j.remoteId);

    // 我们这边还以为它在排队，ComfyUI 那边已经开跑了
    comfy.forceRunning(submitted.remoteId);

    const res = await api('POST', `/v1/jobs/${jobId}/cancel`);
    assert.equal(res.json.ok, true, '请求本身是成功的');
    assert.equal(res.json.cancelled, false, '什么都没删掉，就不能说已取消');
    assert.match(res.json.reason, /执行|队列/, `理由要说清楚：${res.json.reason}`);
    assert.notEqual(res.json.job.state, 'cancelled', '状态更不能变成已取消');
  } finally {
    comfy.setHold(false);
  }
});

test('取消没生效时，任务原样退回取消之前的状态，不卡在「取消中」', async () => {
  /*
   * cancel_requested 的合法出边只有 cancelled / running / result_ready / failed。
   * 老代码退回去时猜的是 `running 或 remote_queued` 二选一 ——
   * 实际状态可能是 submitted、downloading，猜错了 transition 直接拒绝，
   * 任务就永远停在「取消中」：不再轮询、也没人推进，用户对着一个转圈的任务干等。
   */
  comfy.setHold(true);
  try {
    const jobId = await comfyJob([21, 22, 23]);
    const before = await waitFor(jobId, (j) => !!j.remoteId);
    comfy.forceRunning(before.remoteId); // 让取消必然失败（非独占实例）

    await api('POST', `/v1/jobs/${jobId}/cancel`);

    const after_ = (await api('GET', `/v1/jobs/${jobId}`)).json.job;
    assert.notEqual(after_.state, 'cancel_requested', '不能卡在「取消中」');
    assert.equal(after_.state, before.state, `应该原样退回 ${before.state}，实际是 ${after_.state}`);
    assert.equal(after_.error.code, 'JOB_CANCEL_UNSUPPORTED', '要如实记下取消没生效');

    // 任务照常跑完 —— 而且那条"取消未生效"的陈旧错误要被清掉
    comfy.setHold(false);
    const done = await waitFor(jobId, (j) => j.results.length > 0 || j.state === 'failed' || j.state === 'lost', 25000);
    assert.equal(done.results.length, 1, '退回去之后要继续跟踪到出结果');
    assert.equal(
      done.error,
      null,
      '成功之后不能还挂着「取消未生效」—— 用户看到「已完成」旁边一行红字，不知道该信哪个'
    );
  } finally {
    comfy.setHold(false);
  }
});

test('非独占实例上，正在执行的任务一律不许动全局中断', async () => {
  /*
   * 靠"先查队列确认正在跑的就是这条"来授权是不成立的：查完到发出去之间
   * 隔着一次网络往返，ComfyUI 完全可能已经切到下一个任务上了。
   * 而且失败得毫无声息 —— 我们收到 200，如实汇报"已中断"，
   * 被废掉的却是用户另一条跑到一半的活。快照授权不了全局副作用。
   */
  await api('PATCH', '/v1/settings', { generation: { maxConcurrency: 1 }, comfy: { exclusive: false } });
  const jobId = await comfyJob([31, 32, 33]);
  await waitFor(jobId, (j) => j.state === 'running', 15000);

  const res = await api('POST', `/v1/jobs/${jobId}/cancel`);
  assert.equal(res.json.cancelled, false, '没声明独占就不许中断已经在跑的');
  assert.match(res.json.reason, /全局|独占/, `理由要说清为什么：${res.json.reason}`);

  // 那条任务必须还活着 —— 中断没发出去，它就该照常跑完
  const done = await waitFor(jobId, (j) => j.results.length > 0 || j.state === 'failed' || j.state === 'lost', 25000);
  assert.equal(done.results.length, 1, '没中断成功就该照常出结果');
});

test('声明独占之后，中断才生效', async () => {
  // 守卫不能把正常情况一起挡掉：用户明确说了"这台机器只跑本插件的任务"，
  // 取消已经在执行的任务就必须真的管用 —— 那是他勾那个选项换来的。
  await api('PATCH', '/v1/settings', { comfy: { exclusive: true } });
  try {
    const jobId = await comfyJob([41, 42, 43]);
    await waitFor(jobId, (j) => j.state === 'running', 15000);
    const res = await api('POST', `/v1/jobs/${jobId}/cancel`);
    assert.equal(res.json.cancelled, true, `独占实例上取消应当生效：${res.json.reason}`);
    assert.equal(res.json.job.state, 'cancelled');
  } finally {
    await api('PATCH', '/v1/settings', { comfy: { exclusive: false } });
  }
});

test('整个套件跑完，日志里不该有一条非法状态转移', async () => {
  /*
   * 非法转移告警意味着代码在试图走一条转移表不允许的路。
   * 它不会让任何用例变红 —— transition() 只是拒绝并记一条 warn ——
   * 所以它会一直积着，直到某天某条路径真的因为被拒而卡死。
   *
   * 这里查的是这个数据目录下所有日志：上面几个用例已经把
   * 提交、轮询、取消、退回、恢复都走了一遍。
   */
  const { readdirSync, readFileSync } = await import('node:fs');
  const dir = join(dataDir, 'logs');
  const text = readdirSync(dir)
    .filter((f) => f.endsWith('.log') || f.endsWith('.old'))
    .map((f) => readFileSync(join(dir, f), 'utf8'))
    .join('\n');
  const bad = text.split('\n').filter((l) => l.includes('非法状态转移'));
  assert.deepEqual(bad, [], `出现了非法状态转移：\n${bad.slice(0, 10).join('\n')}`);
});

test('删掉的任务不会在库里留下取消相关的残骸', async () => {
  const jobId = await comfyJob([51, 52, 53]);
  await waitFor(jobId, (j) => j.results.length > 0 || j.state === 'failed', 25000);
  await api('DELETE', `/v1/jobs/${jobId}`);

  const db = new DatabaseSync(join(dataDir, 'psai.sqlite'), { readOnly: true });
  try {
    for (const table of ['submission_attempts', 'writeback_attempts', 'text_tasks', 'job_events', 'job_results']) {
      assert.equal(
        db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE job_id = ?`).get(jobId).n,
        0,
        `${table} 里还留着这条任务的记录`
      );
    }
  } finally {
    db.close();
  }
});
