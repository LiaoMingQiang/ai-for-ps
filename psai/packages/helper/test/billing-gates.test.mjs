/**
 * 计费旁路。
 *
 * 「提交结果未知」这个状态的全部意义，是**不让人不假思索地再发一次**。
 * 处置面板上那道重复计费确认是它的核心。可如果别处还留着一条不经过确认
 * 就能重发的路，那道确认就成了摆设 —— 用户根本不会走到它面前，
 * 他会点那个和别处一模一样的「重试」或者「用这套参数重跑」。
 *
 * 这一组守的就是那些旁路：每一条都要么被堵上，要么把人引回处置面板。
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
const FEATURE = 'cloud.i2i';

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
  throw new Error(`超时：最后状态=${last?.state}`);
}

/** 造一条停在「提交结果未知」的任务：桩收下请求就掐断连接。 */
async function unknownJob(rgb) {
  cloud.setMode('reset');
  const asset = await uploadPng(rgb);
  const { json } = await api('POST', '/v1/jobs', {
    featureId: FEATURE,
    params: { prompt: '一只猫', seed: { mode: 'fixed', value: 3 } },
    inputs: [{ paramId: 'images', assetId: asset.id, index: 0, source: 'upload' }],
    target: null,
    writeback: { mode: 'assetOnly' }
  });
  assert.equal(json.ok, true, JSON.stringify(json));
  await waitFor(json.job.id, (j) => j.state === 'submission_unknown');
  cloud.setMode('ok');
  return json.job.id;
}

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'psai-billing-'));
  cloud = await startCloudStub(0, { mode: 'ok' });
  helper = await startHelper({ dataDir, port: 0, ephemeral: true });
  PORT = helper.port; // 不从 url 里抠：端口等于 80 时 URL 会规范化掉，Number('') === 0 → undici 报 bad port
  if (!Number.isInteger(PORT) || PORT <= 0) throw new Error(`Helper 端口不可用：${PORT}（url=${helper.url}）`);
  token = helper.issueToken();
  await helper.recovered;

  await api('PATCH', '/v1/providers/comfly', { baseUrl: cloud.url, enabled: true });
  await api('POST', '/v1/providers/comfly/credentials', { apiKey: 'sk-test-not-a-real-key' });
  await api('PUT', `/v1/features/${FEATURE}/binding`, {
    providerId: 'comfly',
    model: 'stub-image-model',
    enabled: true
  });
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

test('未决的提交尝试挡住普通「重跑」', async () => {
  /*
   * rerun 会造一条新任务、发一次新的请求 —— 那是实打实的第二次计费，
   * 而第一次到底扣没扣还不知道。历史页上这个按钮和别处那些长得一模一样，
   * 用户会顺手点。堵在这里，把他引回处置面板。
   */
  const jobId = await unknownJob([11, 12, 13]);
  const submitsBefore = cloud.submits.length;
  const jobsBefore = readDb((db) => db.prepare('SELECT COUNT(*) n FROM jobs').get().n);

  const res = await api('POST', `/v1/jobs/${jobId}/rerun`);
  assert.equal(res.json.ok, false, '有未决尝试时不许走普通重跑');
  assert.equal(res.json.error.code, 'SUBMISSION_UNKNOWN');
  assert.match(`${res.json.error.message}${res.json.error.details ?? ''}`, /处置|重复计费/);

  assert.equal(cloud.submits.length, submitsBefore, '被拒的重跑不该产生任何提交');
  assert.equal(
    readDb((db) => db.prepare('SELECT COUNT(*) n FROM jobs').get().n),
    jobsBefore,
    '更不该造出一条新任务'
  );
});

test('放弃过的任务，之后也不能靠普通重试绕过确认', async () => {
  /*
   * 「放弃」这句话的前提是"我知道上一次可能已经计费了"。
   * 放弃之后任务变成 failed，而 failed 是允许普通重试的 ——
   * 于是用户随手一点「重试」就绕开了那次确认，处置面板白做。
   */
  const jobId = await unknownJob([21, 22, 23]);
  const abandoned = await api('POST', `/v1/jobs/${jobId}/resolve-submission`, { decision: 'abandon' });
  assert.equal(abandoned.json.job.state, 'failed', '前提：放弃之后是 failed，而 failed 本来可以重试');

  const submitsBefore = cloud.submits.length;
  const retry = await api('POST', `/v1/jobs/${jobId}/retry`);
  assert.equal(retry.json.ok, false, '放弃过的任务不许走普通重试');
  assert.equal(retry.json.error.code, 'SUBMISSION_UNKNOWN');
  assert.equal(cloud.submits.length, submitsBefore);

  // 重跑同样堵住
  assert.equal((await api('POST', `/v1/jobs/${jobId}/rerun`)).json.ok, false, '重跑也是一条旁路');
  assert.equal(cloud.submits.length, submitsBefore);
});

test('没有历史包袱的任务，普通重试照常可用', async () => {
  // 闸门不能把正常情况一起挡掉：明确失败（上游 401）等于确定没扣钱，
  // 那种任务重试是安全的，也是用户最常用的动作。
  cloud.setMode('status', 401);
  const asset = await uploadPng([31, 32, 33]);
  const created = await api('POST', '/v1/jobs', {
    featureId: FEATURE,
    params: { prompt: '一只猫', seed: { mode: 'fixed', value: 4 } },
    inputs: [{ paramId: 'images', assetId: asset.id, index: 0, source: 'upload' }],
    target: null,
    writeback: { mode: 'assetOnly' }
  });
  const jobId = created.json.job.id;
  await waitFor(jobId, (j) => j.state === 'failed');
  assert.equal(
    readDb((db) =>
      db.prepare("SELECT COUNT(*) n FROM submission_attempts WHERE job_id = ? AND outcome = 'pending'").get(jobId).n
    ),
    0,
    '前提：明确拒绝不留 pending'
  );

  cloud.setMode('ok');
  const retry = await api('POST', `/v1/jobs/${jobId}/retry`);
  assert.equal(retry.json.ok, true, `确定没扣钱的失败必须还能重试：${JSON.stringify(retry.json)}`);
  await waitFor(jobId, (j) => j.state === 'succeeded');
});

test('字符串 "false" 不能冒充确认', async () => {
  /*
   * `!opts.confirmedDuplicateBillingRisk` 这种写法下，非空字符串是 truthy，
   * 所以 "false" 会被当成"确认过了"直接放行 —— 一个手写的 curl、
   * 或者哪天某个客户端把布尔序列化成字符串，就悄悄绕过了整道确认。
   */
  const jobId = await unknownJob([41, 42, 43]);
  const submitsBefore = cloud.submits.length;

  for (const bogus of ['false', 'true', 1, 0, 'yes', {}, []]) {
    const res = await api('POST', `/v1/jobs/${jobId}/resolve-submission`, {
      decision: 'retry',
      confirmedDuplicateBillingRisk: bogus
    });
    assert.equal(res.json.ok, false, `${JSON.stringify(bogus)} 不该被当成确认`);
    assert.equal(
      (await api('GET', `/v1/jobs/${jobId}`)).json.job.state,
      'submission_unknown',
      `${JSON.stringify(bogus)} 被拒之后状态不该被动过`
    );
  }
  assert.equal(cloud.submits.length, submitsBefore, '一次都不该发出去');

  // 真正的布尔 true 才放行
  const ok = await api('POST', `/v1/jobs/${jobId}/resolve-submission`, {
    decision: 'retry',
    confirmedDuplicateBillingRisk: true
  });
  assert.equal(ok.json.ok, true, JSON.stringify(ok.json));
  await waitFor(jobId, (j) => j.state === 'succeeded' || j.state === 'failed');
});

test('未知态的错误码是 SUBMISSION_UNKNOWN，不是「请重新提交」的那个', async () => {
  // JOB_LOST 的标准文案是「任务状态在 Helper 重启后无法恢复，请重新提交」。
  // 用它来表示"可能已经计费"，等于一边警告重复扣费一边让人重新提交。
  const jobId = await unknownJob([51, 52, 53]);
  const j = (await api('GET', `/v1/jobs/${jobId}`)).json.job;
  assert.equal(j.error.code, 'SUBMISSION_UNKNOWN');
  const whole = `${j.error.message}${j.error.details ?? ''}`;
  assert.ok(!/请重新提交/.test(j.error.message), `标准文案不能是"请重新提交"：${j.error.message}`);
  assert.match(whole, /计费|扣费/);
});

test('认领的任务号按平台规范化，不合格式的当场拒绝', async () => {
  const jobId = await unknownJob([61, 62, 63]);

  for (const bad of ['platform-task-42', 'oai_1b2c3d', '', '  ']) {
    const res = await api('POST', `/v1/jobs/${jobId}/resolve-submission`, { decision: 'adopt', remoteId: bad });
    assert.equal(res.json.ok, false, `「${bad}」不该被接受`);
  }
  // 被拒之后证据要还在 —— 那是"钱可能已经花了"的唯一记录
  assert.equal(
    readDb((db) =>
      db.prepare("SELECT COUNT(*) n FROM submission_attempts WHERE job_id = ? AND outcome = 'pending'").get(jobId).n
    ),
    1
  );

  // Comfly 走 OpenAI 兼容协议，只有 Midjourney 那条路有真实任务号
  const ok = await api('POST', `/v1/jobs/${jobId}/resolve-submission`, {
    decision: 'adopt',
    remoteId: '1949273610948169729'
  });
  assert.equal(ok.json.ok, true, JSON.stringify(ok.json));
  assert.equal(ok.json.job.remoteId, 'mj:1949273610948169729', '要按平台的规矩补上前缀');
  assert.equal(
    readDb((db) =>
      db.prepare("SELECT remote_id FROM submission_attempts WHERE job_id = ? AND outcome = 'accepted'").get(jobId)
        ?.remote_id
    ),
    'mj:1949273610948169729',
    '认领的任务号也要落进尝试记录，事后对账靠它'
  );
  await api('POST', `/v1/jobs/${jobId}/discard`);
});

test('反推/优化的结果会被复用，不重复计费', async () => {
  /*
   * 这两步跑在图像提交之前，在付费平台上是真金白银的一次模型调用。
   * 图像提交失败、用户点重试时，它们会跟着重跑 ——
   * 用户以为自己重试的是"生图"，实际上把前面那次也重新买了一遍。
   */
  cloud.setMode('status', 500); // 让生图这一步失败，但优化提示词先跑完
  const asset = await uploadPng([71, 72, 73]);
  const chatsBefore = cloud.chats.length;
  const created = await api('POST', '/v1/jobs', {
    featureId: FEATURE,
    params: { prompt: '一只猫', promptEnhance: true, seed: { mode: 'fixed', value: 9 } },
    inputs: [{ paramId: 'images', assetId: asset.id, index: 0, source: 'upload' }],
    target: null,
    writeback: { mode: 'assetOnly' }
  });
  const jobId = created.json.job.id;
  await waitFor(jobId, (j) => ['failed', 'submission_unknown', 'lost'].includes(j.state));

  const chatsAfterFirst = cloud.chats.length;
  assert.ok(chatsAfterFirst > chatsBefore, '前提：优化提示词确实调用过一次');
  assert.equal(
    readDb((db) => db.prepare("SELECT COUNT(*) n FROM text_tasks WHERE job_id = ? AND outcome = 'succeeded'").get(jobId).n),
    1,
    '成功的文本调用要落库，才谈得上复用'
  );

  // 同样的输入再跑一次：文本那一步必须命中缓存，一分钱不花
  cloud.setMode('ok');
  const second = await api('POST', '/v1/jobs', {
    featureId: FEATURE,
    params: { prompt: '一只猫', promptEnhance: true, seed: { mode: 'fixed', value: 9 } },
    inputs: [{ paramId: 'images', assetId: asset.id, index: 0, source: 'upload' }],
    target: null,
    writeback: { mode: 'assetOnly' }
  });
  await waitFor(second.json.job.id, (j) => j.state === 'succeeded');
  assert.equal(cloud.chats.length, chatsAfterFirst, '同样的输入不该再买一次优化提示词');
});
