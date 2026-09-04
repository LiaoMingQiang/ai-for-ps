/**
 * 取消的竞态。
 *
 * 「取消」这两个字在界面上只有一种意思：这件事不会发生、钱不会花。
 * 老代码在两个地方违背了它，而且都不会报错 —— 用户看到的是一句"已取消"。
 *
 * 一、cancel() 看到 remote_id 是空的就直接判 cancelled 并释放资源。
 *     可 remote_id 为空有两种截然不同的含义：「还没提交」和「正在提交」。
 *     后者的请求已经在飞了，上游随后接单 —— 卡照占、钱照扣，
 *     而本地已经没人管这条任务。界面写着"已取消"，平台上那个任务跑到天亮。
 *
 * 二、ComfyUI 的 /interrupt 是**全局**的：它中断的是"这台机器当前正在执行的
 *     那一个"，不是我们指定的那一个。取消 A，废掉的可能是 B。
 *
 * 这里全部走真实路径：真起 Helper、真发 HTTP、真跑取消，
 * 断言只看库里的状态和桩上收到了什么。
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { startHelper } from '../dist/index.js';
import { startComfyStub, makePng } from '../../../tools/comfy-stub.mjs';
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
const CLOUD_FEATURE = 'cloud.i2i';
const COMFY_FEATURE = 'comfy.wash.portrait';

let helper;
let comfy;
let cloud;
let dataDir;
let token;
let workflowId;

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
  const json = await res.json();
  assert.equal(json.ok, true, `上传失败: ${JSON.stringify(json)}`);
  return json.assets[0];
}

function readDb(fn) {
  const db = new DatabaseSync(join(dataDir, 'psai.sqlite'), { readOnly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** 任务是不是已经不再占着并发名额了。 */
function isDone(j) {
  return j.results.length > 0 || ['succeeded', 'failed', 'lost', 'cancelled', 'submission_unknown'].includes(j.state);
}

function errText(err) {
  return err ? `${err.message}${err.details ? `（${err.details}）` : ''}` : '';
}

async function waitFor(jobId, predicate, timeoutMs = 20000) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    const { json } = await api('GET', `/v1/jobs/${jobId}`);
    last = json.job;
    if (last && predicate(last)) return last;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`超时：最后状态=${last?.state} 错误=${JSON.stringify(last?.error)}`);
}

/** 轮询等一个条件成立。 */
async function waitUntil(fn, message, timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`超时：${message}`);
}

/** 等到库里出现这条任务的 pending 提交尝试 —— 即"请求确实已经发出去了"。 */
async function waitForPendingAttempt(jobId, timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const row = readDb((db) =>
      db.prepare("SELECT attempt_id FROM submission_attempts WHERE job_id = ? AND outcome = 'pending'").get(jobId)
    );
    if (row) return row;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error('等不到 pending 的提交尝试');
}

function testWorkflow() {
  return {
    1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'stub_model.safetensors' } },
    2: { class_type: 'LoadImage', inputs: { image: 'example.png' } },
    4: { class_type: 'CLIPTextEncode', inputs: { text: 'a photo', clip: ['1', 1] }, _meta: { title: 'Positive' } },
    5: { class_type: 'CLIPTextEncode', inputs: { text: 'bad', clip: ['1', 1] }, _meta: { title: 'Negative' } },
    6: { class_type: 'VAEEncode', inputs: { pixels: ['2', 0], vae: ['1', 2] } },
    3: {
      class_type: 'KSampler',
      inputs: {
        model: ['1', 0],
        seed: 0,
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

async function cloudJob(rgb) {
  const asset = await uploadPng(rgb);
  const { json } = await api('POST', '/v1/jobs', {
    featureId: CLOUD_FEATURE,
    params: { prompt: '一只猫', seed: { mode: 'fixed', value: 3 } },
    inputs: [{ paramId: 'images', assetId: asset.id, index: 0, source: 'upload' }],
    target: null,
    writeback: { mode: 'assetOnly' }
  });
  assert.equal(json.ok, true, JSON.stringify(json));
  return json.job.id;
}

async function comfyJob(rgb) {
  const asset = await uploadPng(rgb);
  const { json } = await api('POST', '/v1/jobs', {
    featureId: COMFY_FEATURE,
    params: { prompt: '洗一下', seed: { mode: 'fixed', value: 4 } },
    inputs: [{ paramId: 'image', assetId: asset.id, index: 0, source: 'upload' }],
    target: null,
    writeback: { mode: 'assetOnly' }
  });
  assert.equal(json.ok, true, JSON.stringify(json));
  return json.job.id;
}

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'psai-cancel-'));
  // runMs 拉长，任务才会真的稳稳停在 running 上，够我们在那个窗口里发取消
  comfy = await startComfyStub(0, { runMs: 10_000 });
  cloud = await startCloudStub(0, { mode: 'ok' });
  helper = await startHelper({ dataDir, port: 0, ephemeral: true });
  PORT = helper.port; // 不从 url 里抠：端口等于 80 时 URL 会规范化掉，Number('') === 0 → undici 报 bad port
  if (!Number.isInteger(PORT) || PORT <= 0) throw new Error(`Helper 端口不可用：${PORT}（url=${helper.url}）`);
  token = helper.issueToken();
  await helper.recovered;

  await api('PATCH', '/v1/settings', { comfy: { baseUrl: comfy.url } });
  await api('PATCH', '/v1/providers/comfly', { baseUrl: cloud.url, enabled: true });
  await api('POST', '/v1/providers/comfly/credentials', { apiKey: 'sk-test-not-a-real-key' });
  await api('PUT', `/v1/features/${CLOUD_FEATURE}/binding`, {
    providerId: 'comfly',
    model: 'stub-image-model',
    enabled: true
  });

  workflowId = (await api('POST', '/v1/workflows/import', { json: testWorkflow(), name: '取消测试用' })).json.workflow.id;
  await api('PUT', `/v1/features/${COMFY_FEATURE}/binding`, {
    providerId: 'comfyui',
    workflowId,
    enabled: true
  });
});

after(async () => {
  await helper?.stop();
  await comfy?.stop();
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

/* ==================== 取消的返回值 ==================== */

test('取消的业务结论走 cancelled，不是把它塞进 ok 里', async () => {
  // 老写法：远端取消不了时返回 200 + ok:false。
  // 客户端那套统一的错误处理会把它当成一次**失败的调用**报出去 ——
  // 而它其实是一次成功的调用，只是答案是"取消不了"。
  cloud.setMode('ok');
  const jobId = await cloudJob([21, 22, 23]);
  await waitFor(jobId, (j) => j.state === 'succeeded');

  const { status, json } = await api('POST', `/v1/jobs/${jobId}/cancel`);
  assert.equal(status, 200);
  assert.equal(json.ok, true, '请求本身是成功的，不该报成失败');
  assert.equal(json.cancelled, false, '终态任务取消不掉');
  assert.equal(json.pending, false);
  assert.match(json.reason, /终态/);
});

/* ==================== 竞态一：提交进行中被取消 ==================== */

test('付费平台：提交进行中取消 → 落到「提交结果未知」，绝不谎称已取消', async () => {
  /*
   * 这是最贵的一条。老代码在这里判 cancelled 并 release()：
   * 请求还在飞，上游随后接单，钱照扣，而本地已经不管了。
   *
   * 中止请求之后我们**并不知道**上游收没收（请求可能已经完整送达）。
   * 说"已取消"会让用户以为不会被扣钱 —— 那是我们不知道的事。
   */
  cloud.setMode('hang'); // 桩收下请求就不回复
  const baseline = cloud.submits.length;
  const jobId = await cloudJob([31, 32, 33]);
  await waitForPendingAttempt(jobId);
  // pending 行是在**发请求之前**写的，只等它会在请求落到桩之前就往下走。
  // 后面要断言"没有重发"，所以必须先确认这一次已经到了。
  await waitUntil(() => cloud.submits.length > baseline, '桩没有收到这次提交');
  const submitsBefore = cloud.submits.length;
  assert.equal(submitsBefore, baseline + 1, '前提：只发出去了这一次');

  const res = await api('POST', `/v1/jobs/${jobId}/cancel`);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.cancelled, false, '这一刻还不能说"已取消"，我们不知道上游收没收');
  assert.equal(res.json.pending, true, '要如实说"正在中止，稍后确认"');

  const j = await waitFor(jobId, (x) => x.state === 'submission_unknown' || x.state === 'cancelled' || x.state === 'failed');
  assert.equal(j.state, 'submission_unknown', '结论必须是"不知道"，不是"已取消"');
  assert.match(errText(j.error), /计费|扣费/, '文案要点明可能已经计费，用户才知道该去查账单');

  // 中止是真的中止了：桩没有收到第二次提交
  assert.equal(cloud.submits.length, submitsBefore, '不该重发');

  // pending 的那条尝试要留着 —— 它是"钱可能已经花了"的唯一证据
  assert.equal(
    readDb((db) =>
      db.prepare("SELECT COUNT(*) n FROM submission_attempts WHERE job_id = ? AND outcome = 'pending'").get(jobId).n
    ),
    1,
    '取消不该把证据抹掉'
  );

  // 并发额度必须已经释放，后面的任务还得能跑
  cloud.setMode('ok');
  const next = await cloudJob([34, 35, 36]);
  const ok = await waitFor(next, (x) => x.state === 'succeeded' || x.state === 'failed');
  assert.equal(ok.state, 'succeeded', '停在未知态的任务不该一直占着并发名额');
});

test('本地 ComfyUI：提交进行中取消 → 干脆地判已取消（重跑不花钱）', async () => {
  // 免费的本地重跑只是多花点显卡时间。这里说"已取消"名副其实，
  // 不该把用户拖进"提交结果未知"那套需要人做决定的流程。
  comfy.setPromptHang(true);
  try {
    const jobId = await comfyJob([41, 42, 43]);
    await waitForPendingAttempt(jobId);

    const res = await api('POST', `/v1/jobs/${jobId}/cancel`);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.pending, true, '提交还在飞，先说"正在中止"');

    const j = await waitFor(jobId, (x) => x.state === 'cancelled' || x.state === 'submission_unknown' || x.state === 'failed');
    assert.equal(j.state, 'cancelled', '本地 Provider 不计费，可以干脆地说已取消');
    assert.equal(j.results.length, 0);
  } finally {
    comfy.setPromptHang(false);
  }
});

test('提交进行中取消时，资源不能提前释放 —— 定论出来之前任务还占着名额', async () => {
  /*
   * 老代码在这里就 release() 了。释放意味着：队列里下一条马上开跑，
   * 而这一条的提交还在飞。两条任务同时在跑，超出用户设的并发上限；
   * 更要命的是没有人再等那个飞在半空的请求的结果。
   */
  await api('PATCH', '/v1/settings', { generation: { maxConcurrency: 1 } });
  cloud.setMode('hang');
  const heldBaseline = cloud.submits.length;
  const held = await cloudJob([51, 52, 53]);
  await waitForPendingAttempt(held);
  await waitUntil(() => cloud.submits.length > heldBaseline, '桩没有收到这次提交');
  // 第一条的请求已经挂住了（挂住的连接不会因为改模式而放开），
  // 现在就把模式切回正常 —— 否则第二条一拿到名额就发出去，同样被挂死，
  // 整个用例会卡在一个跟被测行为无关的地方。
  cloud.setMode('ok');

  // 排在后面的一条，此刻应该还在本地队列里等
  const queued = await cloudJob([54, 55, 56]);
  assert.equal((await api('GET', `/v1/jobs/${queued}`)).json.job.state, 'queued_local', '前提：第二条在排队');

  await api('POST', `/v1/jobs/${held}/cancel`);

  const heldFinal = await waitFor(held, (j) => j.state === 'submission_unknown');
  const done = await waitFor(queued, (j) => j.state === 'succeeded' || j.state === 'failed', 25000);
  assert.equal(done.state, 'succeeded', '定论之后名额要真的还回来');

  /*
   * 关键在**先后**：第二条开始执行的时刻，必须晚于第一条那次提交有了定论的时刻。
   * 老代码在 cancel() 里当场 release()，第二条会在提交还飞着的时候就开跑 ——
   * 两条任务同时在跑，超出用户设的并发上限，而且没人再等那个飞着的请求。
   *
   * 这里比时间戳而不是抢着读一个瞬时状态：中止是很快的，
   * 取消的 HTTP 响应回来时结论往往已经落定，瞬时状态读不出区别。
   */
  assert.ok(heldFinal.finishedAt, '第一条应该有结束时间');
  assert.ok(done.startedAt, '第二条应该有开始时间');
  assert.ok(
    done.startedAt >= heldFinal.finishedAt,
    `第二条不能早于第一条的定论就开跑：started=${done.startedAt} vs finished=${heldFinal.finishedAt}`
  );
});

/* ==================== 竞态二：ComfyUI 的全局 /interrupt ==================== */

test('没声明独占时，绝不动用全局 /interrupt', async () => {
  /*
   * ComfyUI 的 /interrupt 中断的是"这台机器当前正在执行的那一个"，
   * 不是我们指定的那一个。用户取消 A，被废掉的可能是 B。
   *
   * 中间有过一版"先查 /queue 确认正在跑的就是这一条才发"——那不成立：
   * 查完到发出去之间隔着一次网络往返，ComfyUI 完全可能已经切到下一个任务上了。
   * 一个快照授权不了一个全局副作用。所以现在只认用户的明确声明。
   *
   * 桩这里如实照抄了真实语义：/interrupt 删掉**所有**正在执行的任务。
   */
  await api('PATCH', '/v1/settings', { generation: { maxConcurrency: 2 } });
  let a;
  let b;
  try {
    a = await comfyJob([61, 62, 63]);
    b = await comfyJob([64, 65, 66]);
    await waitFor(a, (j) => j.state === 'running', 15000);
    await waitFor(b, (j) => j.state === 'running', 15000);

    const res = await api('POST', `/v1/jobs/${a}/cancel`);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.cancelled, false, '没声明独占就不许用全局中断 —— 必须如实说取消不了');
    assert.match(res.json.reason, /全局|独占/, `理由要说清为什么: ${res.json.reason}`);

    // 关键断言：B 必须毫发无损地跑完
    const bDone = await waitFor(b, (j) => j.results.length > 0 || j.state === 'failed' || j.state === 'lost', 25000);
    assert.equal(bDone.results.length, 1, '取消 A 绝不能把 B 废掉');

    // A 也没有被凭空判成取消，它照常跑完
    const aDone = await waitFor(a, (j) => j.results.length > 0 || j.state === 'failed' || j.state === 'lost', 25000);
    assert.ok(aDone.state !== 'cancelled', '取消没生效就不能显示成已取消');
  } finally {
    // 无论成败都要把还在跑的排干净：并发名额不还回来，后面的用例会一直饿着，
    // 报出来的错是"超时：最后状态=queued_local"，跟真正的原因毫无关系。
    for (const id of [a, b]) {
      if (id) await waitFor(id, (j) => isDone(j), 30000).catch(() => undefined);
    }
    await api('PATCH', '/v1/settings', { generation: { maxConcurrency: 1 } });
  }
});

test('声明了独占之后，正在执行的任务才允许中断', async () => {
  /*
   * 守卫不能把正常情况也拦掉：用户明确说了"这台 ComfyUI 只跑本插件"，
   * 取消已经在执行的任务就必须真的管用 —— 那是他勾那个选项换来的东西。
   */
  await api('PATCH', '/v1/settings', { generation: { maxConcurrency: 1 }, comfy: { exclusive: true } });
  try {
    const jobId = await comfyJob([71, 72, 73]);
    await waitFor(jobId, (j) => j.state === 'running', 15000);

    const res = await api('POST', `/v1/jobs/${jobId}/cancel`);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.cancelled, true, `独占实例上取消应当生效: ${res.json.reason}`);
    assert.equal(res.json.job.state, 'cancelled');
  } finally {
    await api('PATCH', '/v1/settings', { comfy: { exclusive: false } });
  }
});

test('排队中的任务任何时候都能取消', async () => {
  // queuedOnly 承诺的就是这一条，它必须永远成立。
  await api('PATCH', '/v1/settings', { generation: { maxConcurrency: 1 } });
  comfy.setHold(true);
  try {
    const first = await comfyJob([81, 82, 83]);
    await waitFor(first, (j) => !!j.remoteId, 15000);
    const second = await comfyJob([84, 85, 86]);

    const res = await api('POST', `/v1/jobs/${second}/cancel`);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.cancelled, true, '还没提交出去的任务一定取消得掉');
    assert.equal(res.json.job.state, 'cancelled');

    const firstCancel = await api('POST', `/v1/jobs/${first}/cancel`);
    assert.equal(firstCancel.json.cancelled, true, '在远端队列里排着的也一定取消得掉');
  } finally {
    comfy.setHold(false);
  }
});

/* ==================== 竞态三：提交前的准备工作期间取消 ==================== */

test('优化提示词期间取消：任务判为已取消，而且绝不能还把它提交出去', async () => {
  /*
   * 这条路径老代码错得最隐蔽。
   *
   * 提交前有几次 await（反推、优化提示词），每次都可能跑几十秒。
   * 用户在这期间点取消 → cancel() 看到没有 remote_id，判 cancelled 并 release()，
   * release() 把 entry 从 running 里删掉。
   * 然后 run() 走到"提交前检查"那一步，取的 entry 已经是 undefined，
   * `entry?.cancelled` 是 undefined —— falsy，于是**照常提交**。
   *
   * 结果：一条界面上明明写着"已取消"的任务被提交到付费平台，用户被扣了钱，
   * 而且历史里那条记录的状态是 cancelled，事后根本对不上账。
   */
  cloud.setMode('ok');
  cloud.setChatHang(true); // 优化提示词的请求收下就不回复
  const submitsBefore = cloud.submits.length;
  const chatsBefore = cloud.chats.length;

  const asset = await uploadPng([91, 92, 93]);
  const { json } = await api('POST', '/v1/jobs', {
    featureId: CLOUD_FEATURE,
    params: { prompt: '一只猫', promptEnhance: true, seed: { mode: 'fixed', value: 5 } },
    inputs: [{ paramId: 'images', assetId: asset.id, index: 0, source: 'upload' }],
    target: null,
    writeback: { mode: 'assetOnly' }
  });
  assert.equal(json.ok, true, JSON.stringify(json));
  const jobId = json.job.id;

  try {
    // 等到优化提示词的请求确实发出去了 —— 那时任务卡在提交**之前**
    await waitUntil(() => cloud.chats.length > chatsBefore, '桩没有收到优化提示词的请求');
    assert.equal(cloud.submits.length, submitsBefore, '前提：这时候还没提交任何东西');

    const res = await api('POST', `/v1/jobs/${jobId}/cancel`);
    assert.equal(res.json.ok, true);

    /*
     * 关键的一步：让那次优化提示词的请求**成功**返回。
     *
     * 掐断和成功返回是两种不同的现场。掐断只验证"中止管不管用"；
     * 而老代码真正漏掉的是这一条 —— 准备工作照常跑完了，
     * 然后它接着往下走，把一条已经判为"已取消"的任务提交到付费平台。
     */
    cloud.releaseChats();

    const j = await waitFor(jobId, (x) => isDone(x));
    assert.equal(j.state, 'cancelled', '还没联系过生图接口，说"已取消"名副其实');
    assert.equal(j.results.length, 0);
    assert.equal(j.error, null, '取消是用户自己要的结果，不该表现成一个报错');
  } finally {
    cloud.setChatHang(false);
  }

  // 最关键的一条：绝不能在判了"已取消"之后还把它提交出去
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(cloud.submits.length, submitsBefore, '已取消的任务绝不能被提交到付费平台');
});
