/**
 * 付费提交的崩溃安全 —— 真起 Helper、真发 HTTP、真跑 recover()。
 *
 * 这一组守的是钱。
 *
 * 老代码在 recover() 里有这么一条：
 *   if (state === 'submitting' && !remote_id) → 重新入队
 * 也就是说"没有 remote_id 就当作没提交成功"。可是崩溃完全可能发生在
 * 「HTTP 请求已经发到平台」和「remote_id 落库」之间 —— 那时候上游
 * 已经收下并开始计费了。自动重来一次，用户就被扣两次，
 * 而且他不会知道为什么，因为界面上只显示"重启后自动恢复了一个任务"。
 *
 * 这里**不复刻**引擎里的任何判定：任务由真实的 POST /v1/jobs 创建，
 * 崩溃现场由真实的提交流程留下（云端桩把请求挂住/掐断），
 * 恢复结论由真实的 recover()（startHelper 启动时自己跑）给出。
 * 断言只看两样东西：库里的状态，和桩上收到过几次提交。
 *
 * 崩溃点按要求覆盖四处：提交前、请求悬空、上游明确拒绝、结果落库前。
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { startHelper } from '../dist/index.js';
import { makePng } from '../../../tools/comfy-stub.mjs';
import { startCloudStub } from '../../../tools/cloud-stub.mjs';
import { isChargeableProvider, pathToFinal } from '../dist/jobs/engine.js';
import { JOB_STATES, TERMINAL_STATES, JOB_TRANSITIONS, canTransition } from '../../shared/dist/job.js';
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
  // Helper 重启后连接池里可能还留着指向旧进程的死连接，第一次会 ECONNRESET
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url(path), { method, headers, body: payload });
      return { status: res.status, json: await res.json() };
    } catch (e) {
      if (attempt >= 3) {
        /*
         * 把现场带上再抛。
         *
         * 这里偶发过 `bad port`——undici 只说"地址不合法"，不说是什么地址，
         * 而它抛在三层之外，重跑又必绿。没有现场就永远查不出来：
         * 到底是 PORT 变了、helper.url 本身是坏的、还是别的。
         */
        throw new Error(
          `${method} ${path} 请求失败：${e instanceof Error ? e.message : String(e)}` +
            `（PORT=${JSON.stringify(PORT)} helper.url=${JSON.stringify(helper?.url)} 拼出的地址=${JSON.stringify(url(path))}` +
            ` cause=${JSON.stringify(e?.cause?.message ?? null)}）`
        );
      }
      await new Promise((r) => setTimeout(r, 120));
    }
  }
}

async function uploadPng(rgb = [10, 20, 30]) {
  const fd = new FormData();
  fd.append('file', new Blob([makePng(64, 64, rgb)], { type: 'image/png' }), 'in.png');
  const res = await fetch(url('/v1/assets'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: fd
  });
  const json = await res.json();
  assert.equal(json.ok, true, `上传失败: ${JSON.stringify(json)}`);
  return json.assets[0];
}

/** 只读地看一眼库里的真实行 —— 断言用，不复刻任何判定逻辑。 */
function readDb(fn) {
  const db = new DatabaseSync(join(dataDir, 'psai.sqlite'), { readOnly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/**
 * 错误的完整文案。
 *
 * PsaiError 的第二个参数是 details 不是 message —— message 是错误码的固定文案，
 * 具体到这一次出了什么事的那句话在 details 里。面板上展示的是 `message（details）`，
 * 所以断言也该看这两段合起来的结果。
 */
function errText(err) {
  return `${err.message}${err.details ? `（${err.details}）` : ''}`;
}

function logText() {
  const dir = join(dataDir, 'logs');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.log'))
    .map((f) => readFileSync(join(dir, f), 'utf8'))
    .join('\n');
}

async function boot() {
  helper = await startHelper({ dataDir, port: 0, ephemeral: true });
  PORT = helper.port; // 不从 url 里抠：端口等于 80 时 URL 会规范化掉，Number('') === 0 → undici 报 bad port
  if (!Number.isInteger(PORT) || PORT <= 0) throw new Error(`Helper 端口不可用：${PORT}（url=${helper.url}）`);
  /*
   * 端口当场校验，把地址一起写进报错。
   *
   * 这个套件在并发跑的时候偶发过一次 `bad port` —— undici 抛在三层之外的
   * 某个 api() 调用里，跟真正的原因毫无关系，而且单独重跑必绿。
   * 拿不到现场就永远查不出来。这一句让下一次复发直接说出坏地址是什么。
   */
  if (!Number.isInteger(PORT) || PORT <= 0 || PORT > 65535) {
    throw new Error(`Helper 给出的地址不可用：${JSON.stringify(helper.url)}（解析出的端口 ${PORT}）`);
  }
  token = helper.issueToken();
  await helper.recovered; // 等 recover() 跑完再断言，否则读到的是中途状态
}

async function createJob(assetId, extra = {}) {
  const { json } = await api('POST', '/v1/jobs', {
    featureId: FEATURE,
    params: { prompt: '一只在下雨的城市里打伞的猫', seed: { mode: 'fixed', value: 7 } },
    inputs: [{ paramId: 'images', assetId, index: 0, source: 'upload' }],
    target: null,
    writeback: { mode: 'assetOnly' },
    ...extra
  });
  return json;
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

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'psai-paid-'));
  cloud = await startCloudStub(0, { mode: 'ok' });
  await boot();

  // 把 Comfly（OpenAI 兼容的付费网关）指向桩，并配上 Key
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
    /* Windows 上偶尔被占用，忽略 */
  }
  if (logProblem) throw logProblem;
});

/* ==================== 创建的原子性 ==================== */

test('同一个输入位置提交两张图：整条创建请求原子失败，库里一点痕迹都不留', async () => {
  const asset = await uploadPng([1, 2, 3]);
  const other = await uploadPng([4, 5, 6]);

  const before = readDb((db) => ({
    jobs: db.prepare('SELECT COUNT(*) n FROM jobs').get().n,
    inputs: db.prepare('SELECT COUNT(*) n FROM job_inputs').get().n,
    events: db.prepare('SELECT COUNT(*) n FROM job_events').get().n,
    docs: db.prepare('SELECT COUNT(*) n FROM documents').get().n,
    refA: db.prepare('SELECT ref_count FROM assets WHERE id = ?').get(asset.id).ref_count,
    refB: db.prepare('SELECT ref_count FROM assets WHERE id = ?').get(other.id).ref_count
  }));

  // 走**真实的**创建端点，两条输入落在同一个 (paramId, index)
  const { status, json } = await api('POST', '/v1/jobs', {
    featureId: FEATURE,
    params: { prompt: '重复位置', seed: { mode: 'fixed', value: 1 } },
    inputs: [
      { paramId: 'images', assetId: asset.id, index: 0, source: 'upload' },
      { paramId: 'images', assetId: other.id, index: 0, source: 'upload' }
    ],
    target: {
      documentId: 987654,
      documentName: '不该被记下来的文档.psd',
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

  assert.equal(status, 400);
  assert.equal(json.ok, false);
  assert.equal(json.error.code, 'JOB_PARAM_INVALID', `实际: ${JSON.stringify(json.error)}`);
  assert.match(errText(json.error), /位置/, '错误要说清楚是"位置重复"，而不是把 UNIQUE 约束原文丢给用户');

  const after_ = readDb((db) => ({
    jobs: db.prepare('SELECT COUNT(*) n FROM jobs').get().n,
    inputs: db.prepare('SELECT COUNT(*) n FROM job_inputs').get().n,
    events: db.prepare('SELECT COUNT(*) n FROM job_events').get().n,
    docs: db.prepare('SELECT COUNT(*) n FROM documents').get().n,
    refA: db.prepare('SELECT ref_count FROM assets WHERE id = ?').get(asset.id).ref_count,
    refB: db.prepare('SELECT ref_count FROM assets WHERE id = ?').get(other.id).ref_count
  }));

  assert.deepEqual(after_, before, '任务、输入、事件、文档、引用计数一律不该有变化');
});

test('被拒绝的创建请求不会留下孤儿任务 —— 重启后恢复流程也看不到它', async () => {
  // create() 不加事务时最危险的后果：孤儿任务停在 created，
  // 重启后 recover() 把它当成"未完成任务"捡起来执行 —— 云端会真的计费。
  const jobsBefore = readDb((db) => db.prepare('SELECT COUNT(*) n FROM jobs').get().n);
  const submitsBefore = cloud.submits.length;

  const asset = await uploadPng([7, 8, 9]);
  await api('POST', '/v1/jobs', {
    featureId: FEATURE,
    params: { prompt: 'x' },
    inputs: [
      { paramId: 'images', assetId: asset.id, index: 2, source: 'upload' },
      { paramId: 'images', assetId: asset.id, index: 2, source: 'upload' }
    ],
    target: null,
    writeback: { mode: 'assetOnly' }
  });

  await helper.stop();
  await boot();

  assert.equal(readDb((db) => db.prepare('SELECT COUNT(*) n FROM jobs').get().n), jobsBefore, '不该多出任务');
  assert.equal(cloud.submits.length, submitsBefore, '更不该因此产生一次真的提交');
});

/* ==================== 正常路径（作为对照） ==================== */

test('同步型付费接口：结果和状态一起落库，重启后不重新提交也不重复插入', async () => {
  cloud.setMode('ok');
  const asset = await uploadPng([11, 22, 33]);
  const created = await createJob(asset.id);
  assert.equal(created.ok, true, JSON.stringify(created));
  const jobId = created.job.id;

  const done = await waitFor(jobId, (j) => j.state === 'succeeded' || j.state === 'failed' || j.state === 'lost');
  assert.equal(done.state, 'succeeded', `错误: ${JSON.stringify(done.error)}`);
  assert.equal(done.results.length, 1);

  const submitsAfterFirst = cloud.submits.length;
  const attempt = readDb((db) =>
    db.prepare('SELECT outcome, remote_id, idempotency_key FROM submission_attempts WHERE job_id = ?').get(jobId)
  );
  assert.equal(attempt.outcome, 'completed', '结果都拿到了，这次尝试不该还停在 pending/accepted');
  assert.ok(attempt.idempotency_key, '必须带幂等键');

  await helper.stop();
  await boot();

  const again = (await api('GET', `/v1/jobs/${jobId}`)).json.job;
  assert.equal(again.state, 'succeeded', '终态任务重启后状态不该变');
  assert.equal(again.results.length, 1, '结果不该被重复插入，也不该丢');
  assert.equal(cloud.submits.length, submitsAfterFirst, '绝不能重新提交');
});

/* ==================== 崩溃点一：请求悬在半空 ==================== */

test('崩溃点一：请求已发出但没等到回复，重启后停在「提交结果未知」且绝不自动重来', async () => {
  cloud.setMode('hang'); // 桩收下请求就不回复了
  const baseline = cloud.submits.length;
  const asset = await uploadPng([44, 55, 66]);
  const created = await createJob(asset.id);
  const jobId = created.job.id;

  // 等到两件事都成立：attempt 落库成 pending（"请求发出去之前先留证据"），
  // 且桩确实收到了这一次提交。少等任何一件，后面的"没有重发"就不成立。
  const t0 = Date.now();
  let pending = null;
  while (Date.now() - t0 < 15000) {
    pending = readDb((db) =>
      db.prepare("SELECT outcome, chargeable FROM submission_attempts WHERE job_id = ? AND outcome = 'pending'").get(jobId)
    );
    if (pending && cloud.submits.length > baseline) break;
    await new Promise((r) => setTimeout(r, 60));
  }
  assert.ok(pending, '联系上游之前必须先落一条 pending 记录，否则崩溃后无从判断');
  assert.equal(pending.chargeable, 1, 'Comfly 是付费平台，必须标成会计费');

  const submitsBefore = cloud.submits.length;
  assert.equal(submitsBefore, baseline + 1, '桩应该确实收到了这一次提交，且只有一次');

  // Helper 在等回复的过程中退出 —— 崩溃现场就此定格
  await helper.stop();
  await boot(); // 真实的 recover() 在这里跑

  const j = (await api('GET', `/v1/jobs/${jobId}`)).json.job;
  assert.equal(j.state, 'submission_unknown', '这正是会重复扣费的那一刻，必须停下来等人决定');
  // 专用错误码，不再借用 JOB_LOST —— 后者的标准文案是「请重新提交」，
  // 而这里最不该做的就是重新提交。
  assert.equal(j.error.code, 'SUBMISSION_UNKNOWN');
  assert.match(errText(j.error), /重复扣费|计费/, '错误文案必须说清楚风险，用户才知道该先去查账单');
  assert.equal(cloud.submits.length, submitsBefore, '恢复流程绝不能再发一次');

  // 也不能靠「重试」绕过去
  const retry = await api('POST', `/v1/jobs/${jobId}/retry`);
  assert.equal(retry.json.ok, false, '普通重试必须被拒 —— 它没有任何重复计费的确认');
  assert.equal(cloud.submits.length, submitsBefore);

  return jobId;
});

/* ==================== 崩溃点二：连接被掐断（不重启也不能自动重试） ==================== */

test('崩溃点二：提交时连接被掐断，当场落到「提交结果未知」，不经过 failed', async () => {
  // 这一条不重启。老写法把这种模糊错误抛给外层 → 判成 failed，
  // 而 failed → queued_local 是合法转移：用户在界面上点一下「重试」
  // 立刻就能再发一次。比"崩溃后自动恢复"更容易发生 —— 看到失败，本能就会去点重试。
  cloud.setMode('reset');
  const asset = await uploadPng([77, 88, 99]);
  const created = await createJob(asset.id);
  const jobId = created.job.id;

  const j = await waitFor(jobId, (x) => x.state === 'submission_unknown' || x.state === 'failed' || x.state === 'lost');
  assert.equal(j.state, 'submission_unknown', '模糊失败不能被判成 failed —— 那等于开放了一键重复扣费');
  assert.equal(j.error.code, 'SUBMISSION_UNKNOWN');

  const submits = cloud.submits.length;
  const retry = await api('POST', `/v1/jobs/${jobId}/retry`);
  assert.equal(retry.json.ok, false);
  assert.equal(cloud.submits.length, submits, '被拒的重试不该产生任何提交');

  // 并发额度必须已经释放：后面的任务还得能正常跑
  cloud.setMode('ok');
  const next = await createJob(await uploadPng([1, 1, 1]).then((a) => a.id));
  const ok = await waitFor(next.job.id, (x) => x.state === 'succeeded' || x.state === 'failed');
  assert.equal(ok.state, 'succeeded', '停在未知态的任务不该一直占着并发名额');
});

/* ==================== 崩溃点三：上游明确拒绝 ==================== */

test('崩溃点三：上游明确拒绝（401），算作没花钱，如实判失败并允许重试', async () => {
  cloud.setMode('status', 401);
  const asset = await uploadPng([2, 2, 2]);
  const created = await createJob(asset.id);
  const jobId = created.job.id;

  const j = await waitFor(jobId, (x) => x.state === 'failed' || x.state === 'submission_unknown' || x.state === 'lost');
  assert.equal(j.state, 'failed', '明确拒绝就是明确没扣钱，不该拖进"未知"里让用户白担心');

  const attempt = readDb((db) =>
    db.prepare('SELECT outcome FROM submission_attempts WHERE job_id = ? ORDER BY started_at DESC LIMIT 1').get(jobId)
  );
  assert.equal(attempt.outcome, 'failed', '明确拒绝要写成 failed，不能留 pending');

  cloud.setMode('ok');
});

/* ==================== 崩溃点四：结果已落库、状态没跟上 ==================== */

test('崩溃点四：结果已落库但状态还停在半路，恢复直接收尾 —— 不重下载、不重复插入、不刷非法转移', async () => {
  /*
   * 真机上见过的现场：库里已经有 job_results 了，任务状态还停在 remote_queued。
   * 老恢复流程照常去查远端 → done → 再走一遍落库 →
   * `UNIQUE constraint failed: job_results.job_id, job_results.idx`
   * → 一条本来出图成功的任务被判成 JOB_LOST，
   * 沿途还刷了一串 `remote_queued → downloading` 的非法转移告警。
   *
   * 现在结果和状态在同一个事务里，这种现场不会再由我们自己制造 ——
   * 但老版本留下的库还在用户机器上。所以这里**手工把状态改回半路**，
   * 复现那份数据，验证新的恢复流程能正确收尾。只改 state 一列，
   * 其余（结果、usage、引用计数）全是真实流程写下的。
   */
  cloud.setMode('ok');
  const asset = await uploadPng([3, 3, 3]);
  const created = await createJob(asset.id);
  const jobId = created.job.id;
  await waitFor(jobId, (j) => j.state === 'succeeded');

  const resultsBefore = readDb((db) => db.prepare('SELECT COUNT(*) n FROM job_results WHERE job_id = ?').get(jobId).n);
  assert.equal(resultsBefore, 1);
  const submitsBefore = cloud.submits.length;

  await helper.stop();

  // 把状态改回"结果已落库但还没收尾"的样子
  const raw = new DatabaseSync(join(dataDir, 'psai.sqlite'));
  raw.prepare("UPDATE jobs SET state = 'remote_queued', finished_at = NULL WHERE id = ?").run(jobId);
  raw.close();

  const logBefore = logText().length;
  await boot();

  const j = (await api('GET', `/v1/jobs/${jobId}`)).json.job;
  assert.equal(j.state, 'succeeded', '有结果就该收尾成成功，而不是被判成 lost');
  assert.equal(j.results.length, 1, '结果不能被重复插入，也不能丢');
  assert.equal(
    readDb((db) => db.prepare('SELECT COUNT(*) n FROM job_results WHERE job_id = ?').get(jobId).n),
    1
  );
  assert.equal(cloud.submits.length, submitsBefore, '不该重新联系平台');

  const fresh = logText().slice(logBefore);
  assert.ok(!fresh.includes('非法状态转移'), `恢复过程不该刷非法转移告警:\n${fresh.slice(0, 800)}`);
  assert.ok(!/UNIQUE constraint failed/.test(fresh), `恢复过程不该撞唯一约束:\n${fresh.slice(0, 800)}`);

  // 状态是按合法路径一级级补上去的：每一条状态事件都必须是转移表允许的一步。
  //（事件流本身会在我们手工改 state 的地方断一次 —— 那是这个用例自己造的现场，
  //  不是被测代码写的，所以这里检查的是"每一步合法"，而不是"首尾相接"。）
  const events = (await api('GET', `/v1/jobs/${jobId}/events`)).json.events;
  for (const e of events) {
    if (e.from === null) continue;
    assert.ok(canTransition(e.from, e.to), `事件流里有一步非法转移：${e.from} → ${e.to}`);
  }
});

/* ==================== 用户处置 ==================== */

test('未知态的三条出路：放弃 / 认领 / 确认风险后重来 —— 每一条都要人明确点', async () => {
  cloud.setMode('reset');

  /* ---- 放弃 ---- */
  const abandonJob = (await createJob((await uploadPng([4, 4, 4])).id)).job.id;
  await waitFor(abandonJob, (j) => j.state === 'submission_unknown');
  const abandoned = (await api('POST', `/v1/jobs/${abandonJob}/resolve-submission`, { decision: 'abandon' })).json;
  assert.equal(abandoned.ok, true, JSON.stringify(abandoned));
  assert.equal(abandoned.job.state, 'failed');

  /* ---- 重来：不确认风险一律拒绝 ---- */
  const retryJob = (await createJob((await uploadPng([5, 5, 5])).id)).job.id;
  await waitFor(retryJob, (j) => j.state === 'submission_unknown');
  const submitsBefore = cloud.submits.length;

  const refused = await api('POST', `/v1/jobs/${retryJob}/resolve-submission`, { decision: 'retry' });
  assert.equal(refused.json.ok, false, '没确认重复计费风险就不该放行');
  assert.match(errText(refused.json.error), /重复计费/);
  assert.equal(cloud.submits.length, submitsBefore, '被拒的请求不该产生任何提交');
  assert.equal((await api('GET', `/v1/jobs/${retryJob}`)).json.job.state, 'submission_unknown', '状态不该被动过');
  // 被拒绝的请求更不该把那条 pending 记录消掉 —— 它是"钱可能已经花了"的唯一证据。
  assert.equal(
    readDb((db) =>
      db.prepare("SELECT COUNT(*) n FROM submission_attempts WHERE job_id = ? AND outcome = 'pending'").get(retryJob).n
    ),
    1,
    '一次被拒的处置不该动到证据'
  );

  cloud.setMode('ok');
  const confirmed = await api('POST', `/v1/jobs/${retryJob}/resolve-submission`, {
    decision: 'retry',
    confirmedDuplicateBillingRisk: true
  });
  assert.equal(confirmed.json.ok, true, JSON.stringify(confirmed.json));
  const redone = await waitFor(retryJob, (j) => j.state === 'succeeded' || j.state === 'failed');
  assert.equal(redone.state, 'succeeded');
  assert.ok(cloud.submits.length > submitsBefore, '确认之后才允许真的再发一次');

  // 两次尝试必须是两个不同的幂等键：
  // 崩溃恢复重放的是同一个 attempt（同一个键，上游只计一次费）；
  // 用户明确"重来一次"是新的 attempt（新键，本来就该是一次新计费）。
  const keys = readDb((db) =>
    db
      .prepare('SELECT idempotency_key k FROM submission_attempts WHERE job_id = ? ORDER BY started_at')
      .all(retryJob)
      .map((r) => r.k)
  );
  assert.equal(keys.length, 2);
  assert.notEqual(keys[0], keys[1], '用户主动重来必须换一个幂等键');

  /* ---- 认领：把平台上的任务号接回来 ---- */
  cloud.setMode('reset');
  const adoptJob = (await createJob((await uploadPng([6, 6, 6])).id)).job.id;
  await waitFor(adoptJob, (j) => j.state === 'submission_unknown');

  const noId = await api('POST', `/v1/jobs/${adoptJob}/resolve-submission`, { decision: 'adopt' });
  assert.equal(noId.json.ok, false, '认领必须给任务号');
  assert.equal(
    readDb((db) =>
      db.prepare("SELECT COUNT(*) n FROM submission_attempts WHERE job_id = ? AND outcome = 'pending'").get(adoptJob).n
    ),
    1,
    '少给参数被拒时同样不该动到证据'
  );

  // 乱写的任务号必须当场被拒，而不是存进去、等轮询时才发现查不到。
  // 那时候用户已经以为任务救回来了，最后却收到一句"丢失"—— 更糟。
  const junk = await api('POST', `/v1/jobs/${adoptJob}/resolve-submission`, {
    decision: 'adopt',
    remoteId: 'platform-task-42'
  });
  assert.equal(junk.json.ok, false, '不符合这个平台格式的任务号必须当场拒绝');

  // Comfly 走的是 OpenAI 兼容协议，只有 Midjourney 那条路有真实的远端任务号
  const adopted = await api('POST', `/v1/jobs/${adoptJob}/resolve-submission`, {
    decision: 'adopt',
    remoteId: '1949273610948169729'
  });
  assert.equal(adopted.json.ok, true, JSON.stringify(adopted.json));
  assert.equal(adopted.json.job.remoteId, 'mj:1949273610948169729', '任务号要按平台的规矩补上前缀');
  assert.ok(['submitted', 'lost', 'failed'].includes(adopted.json.job.state), '认领后应接回正常流程去轮询');

  // 认领的任务号也要落进 submission_attempts —— 事后对账全靠这一列
  assert.equal(
    readDb((db) =>
      db.prepare("SELECT remote_id FROM submission_attempts WHERE job_id = ? AND outcome = 'accepted'").get(adoptJob)
        ?.remote_id
    ),
    'mj:1949273610948169729'
  );

  // 处置结论要落进 submission_attempts，事后查得到是谁按了什么
  const outcomes = readDb((db) =>
    db.prepare('SELECT outcome FROM submission_attempts WHERE job_id = ?').all(adoptJob).map((r) => r.outcome)
  );
  assert.ok(!outcomes.includes('pending'), `处置之后不该还留着 pending: ${outcomes.join(',')}`);

  // 认领回来的任务会真的去轮询那个（并不存在的）任务号，在 45 秒的宽限期里
  // 一直占着并发名额。这是对的行为，但会拖住后面的用例 —— 主动丢弃掉。
  await api('POST', `/v1/jobs/${adoptJob}/discard`);

  const events = (await api('GET', `/v1/jobs/${abandonJob}/events`)).json.events;
  assert.ok(
    events.some((e) => e.note.includes('用户处置')),
    '每一次处置都要留下审计记录'
  );

  cloud.setMode('ok');
});

test('删除任务时连它的提交尝试一起删掉，不留孤儿证据', async () => {
  cloud.setMode('ok');
  const asset = await uploadPng([9, 9, 9]);
  const jobId = (await createJob(asset.id)).job.id;
  await waitFor(jobId, (j) => j.state === 'succeeded');

  assert.ok(
    readDb((db) => db.prepare('SELECT COUNT(*) n FROM submission_attempts WHERE job_id = ?').get(jobId).n) > 0,
    '前提：这条任务应该有提交记录'
  );

  await api('DELETE', `/v1/jobs/${jobId}`);

  assert.equal(
    readDb((db) => db.prepare('SELECT COUNT(*) n FROM submission_attempts WHERE job_id = ?').get(jobId).n),
    0,
    'submission_attempts 会一直长，任务删了它也必须跟着走'
  );
});

/* ==================== 状态机与计费判定（纯函数） ==================== */

test('submission_unknown 是终态，出口全都需要人明确点一下', () => {
  // 终态 = 不会被任何自动流程推动。这正是我们要的：
  // 不知道钱花没花的时候，任何自动动作都可能再扣一次。
  assert.ok(JOB_STATES.includes('submission_unknown'));
  assert.ok(TERMINAL_STATES.has('submission_unknown'), '必须是终态，否则恢复流程会自动推它');
  assert.ok(canTransition('submitting', 'submission_unknown'), 'submitting 要能进入这个状态');
  assert.deepEqual(
    [...JOB_TRANSITIONS['submission_unknown']].sort(),
    ['cancelled', 'failed', 'queued_local', 'submitted'].sort()
  );
});

test('本地 ComfyUI 不计费，其余一律按计费处理', () => {
  // 猜错的代价不对称：把免费的当付费，最多让用户多点一次确认；
  // 把付费的当免费，用户被扣两次还不知道为什么。
  assert.equal(isChargeableProvider('comfyui'), false);
  for (const p of ['comfly', 'liblib', 'runninghub', 'gemini', 'volcengine', 'bailian', 'modelscope', 'custom']) {
    assert.equal(isChargeableProvider(p), true, `${p} 应按计费处理`);
  }
  assert.equal(isChargeableProvider('某个以后才有的平台'), true, '没见过的平台也按计费处理');
});

test('pathToFinal 给的是合法路径，不是硬跳', () => {
  // 恢复时当前状态可能停在任意中间态，直接跳到终态会被 canTransition 判非法。
  for (const from of ['submitting', 'submitted', 'remote_queued', 'running', 'downloading']) {
    const path = pathToFinal(from, 'succeeded');
    assert.ok(path.length > 0, `${from} → succeeded 应该走得通`);
    let cur = from;
    for (const step of path) {
      assert.ok(canTransition(cur, step), `${cur} → ${step} 非法`);
      cur = step;
    }
    assert.equal(cur, 'succeeded');
  }
  assert.deepEqual(pathToFinal('succeeded', 'succeeded'), [], '已经在终点就不该再走');
  assert.deepEqual(pathToFinal('succeeded', 'running'), [], '走不通就如实返回空，不要编一条出来');
});
