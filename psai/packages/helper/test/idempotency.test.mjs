/**
 * 幂等键必须走遍**每一条**提交路径。
 *
 * 崩溃恢复会重放同一次尝试（同一个 attempt、同一个键），那是设计出来的行为，
 * 不是异常路径。哪条路上漏了这个头，那条路上的重放就是第二次计费。
 *
 * 这一组不是看代码里"有没有写"，而是在**桩上验证那个头确实收到了**——
 * 中间隔着 headers() / submitHeaders() / mjHeaders() 好几层拼装，
 * 任何一层把它覆盖掉都不会有编译错误，只会安静地少一个头。
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { startHelper } from '../dist/index.js';
import { makePng } from '../../../tools/comfy-stub.mjs';
import { startCloudStub } from '../../../tools/cloud-stub.mjs';
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

let helper;
let cloud;
let dataDir;
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

function readDb(fn) {
  const db = new DatabaseSync(join(dataDir, 'psai.sqlite'), { readOnly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

async function waitFor(jobId, predicate, timeoutMs = 20000) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    last = (await api('GET', `/v1/jobs/${jobId}`)).json.job;
    if (last && predicate(last)) return last;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`超时：最后状态=${last?.state} 错误=${JSON.stringify(last?.error)}`);
}

/** 用指定模型跑一条云端任务。模型名决定走哪条提交路径。 */
async function runWith(model, feature, params, inputs) {
  await api('PUT', `/v1/features/${feature}/binding`, { providerId: 'comfly', model, enabled: true });
  const { json } = await api('POST', '/v1/jobs', {
    featureId: feature,
    params,
    inputs,
    target: null,
    writeback: { mode: 'assetOnly' }
  });
  assert.equal(json.ok, true, JSON.stringify(json));
  return json.job.id;
}

/** 这条任务这次提交用的幂等键 —— 桩上收到的那个必须和它一模一样。 */
function keyOf(jobId) {
  return readDb((db) =>
    db
      .prepare('SELECT idempotency_key k FROM submission_attempts WHERE job_id = ? ORDER BY started_at DESC LIMIT 1')
      .get(jobId)?.k
  );
}

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'psai-idem-'));
  cloud = await startCloudStub(0, { mode: 'ok' });
  helper = await startHelper({ dataDir, port: 0, ephemeral: true });
  PORT = helper.port; // 不从 url 里抠：端口等于 80 时 URL 会规范化掉，Number('') === 0 → undici 报 bad port
  if (!Number.isInteger(PORT) || PORT <= 0) throw new Error(`Helper 端口不可用：${PORT}（url=${helper.url}）`);
  token = helper.issueToken();
  await helper.recovered;

  await api('PATCH', '/v1/providers/comfly', { baseUrl: cloud.url, enabled: true });
  await api('POST', '/v1/providers/comfly/credentials', { apiKey: 'sk-test-not-a-real-key' });
});

after(async () => {
  await helper?.stop();
  await cloud?.stop();
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

test('/images/* 路：桩确实收到了幂等键，而且和库里那次尝试对得上', async () => {
  const before_ = cloud.submits.length;
  const asset = await uploadPng([11, 12, 13]);
  const jobId = await runWith('stub-image-model', 'cloud.i2i', { prompt: '一只猫', seed: { mode: 'fixed', value: 1 } }, [
    { paramId: 'images', assetId: asset.id, index: 0, source: 'upload' }
  ]);
  await waitFor(jobId, (j) => j.state === 'succeeded');

  const got = cloud.submits.slice(before_);
  assert.equal(got.length, 1, '应该正好提交一次');
  assert.ok(got[0].idempotencyKey, `桩没收到 Idempotency-Key：${JSON.stringify(got[0])}`);
  assert.equal(got[0].idempotencyKey, keyOf(jobId), '桩收到的键必须就是库里记的那一个');
});

test('chat 路（Gemini 图像族）：同样要带幂等键', async () => {
  /*
   * 这条路以前漏了 —— 它用的是 headers() 而不是 submitHeaders()。
   * 编译不会报错，测试也不会红，只是那个头安静地少了一个，
   * 而崩溃恢复重放这一次尝试时就变成了第二次计费。
   */
  const before_ = cloud.chats.length;
  const jobId = await runWith('gemini-3-pro-image', 'cloud.t2i', { prompt: '一只猫', seed: { mode: 'fixed', value: 2 } }, []);
  await waitFor(jobId, (j) => ['succeeded', 'failed', 'lost', 'submission_unknown'].includes(j.state));

  const got = cloud.chats.slice(before_);
  assert.ok(got.length >= 1, '应该打到 /chat/completions');
  const submitCall = got.find((c) => c.idempotencyKey);
  assert.ok(submitCall, `chat 提交路没带 Idempotency-Key：${JSON.stringify(got)}`);
  assert.equal(submitCall.idempotencyKey, keyOf(jobId), '桩收到的键必须就是库里记的那一个');
});

test('Midjourney 路：同样要带幂等键', async () => {
  // MJ 一次出图几分钟、也是实打实的额度，重复提交的代价比别的模型还高。
  const before_ = cloud.mjSubmits.length;
  const jobId = await runWith(
    'midjourney',
    'cloud.t2i',
    { prompt: 'a cat in the rain --v 7', seed: { mode: 'fixed', value: 3 } },
    []
  );
  await waitFor(jobId, (j) => ['succeeded', 'failed', 'lost', 'submission_unknown'].includes(j.state), 25000);

  const got = cloud.mjSubmits.slice(before_);
  assert.equal(got.length, 1, `应该打到 MJ 提交接口一次：${JSON.stringify(got)}`);
  assert.ok(got[0].idempotencyKey, `MJ 提交路没带 Idempotency-Key：${JSON.stringify(got[0])}`);
  assert.equal(got[0].idempotencyKey, keyOf(jobId), '桩收到的键必须就是库里记的那一个');
  // 顺带确认这条路的鉴权头也还在 —— 它和 Authorization 是两套
  assert.ok(got[0].mjSecret, 'mj-api-secret 不能因为加幂等键而丢掉');
});

test('两次不同的尝试用不同的键，同一次重放用同一个键', async () => {
  /*
   * 这是幂等键的语义所在：
   *   崩溃恢复重放的是**同一个** attempt —— 同一个键，上游只计一次费
   *   用户明确"重来一次"是**新的** attempt —— 新键，那本来就该是新计费
   * 键跟着任务走的话，用户主动重来会被上游当成重复请求直接返回旧结果，
   * 而他要的是一张新图。
   */
  const before_ = cloud.submits.length;
  const asset = await uploadPng([21, 22, 23]);
  const first = await runWith('stub-image-model', 'cloud.i2i', { prompt: '猫', seed: { mode: 'fixed', value: 4 } }, [
    { paramId: 'images', assetId: asset.id, index: 0, source: 'upload' }
  ]);
  await waitFor(first, (j) => j.state === 'succeeded');

  const second = await runWith('stub-image-model', 'cloud.i2i', { prompt: '猫', seed: { mode: 'fixed', value: 4 } }, [
    { paramId: 'images', assetId: asset.id, index: 0, source: 'upload' }
  ]);
  await waitFor(second, (j) => j.state === 'succeeded');

  const keys = cloud.submits.slice(before_).map((s) => s.idempotencyKey);
  assert.equal(keys.length, 2);
  assert.notEqual(keys[0], keys[1], '两次独立的提交必须是两个不同的键');
  assert.equal(new Set(keys).size, 2);
});
