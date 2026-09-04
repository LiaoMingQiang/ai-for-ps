/**
 * 写回：一次授权只兑现一次，设置在任务上冻结。
 *
 * 写回真正发生在插件里 —— 只有 UXP 那一侧碰得到 Photoshop。
 * Helper 能做的只有两件事：授权，和记账。这一组守的就是这两件事。
 *
 * 为什么需要授权这道手续：没有它的话，两个面板实例（用户开了两个 Photoshop
 * 文档、或者面板被重新加载过）会各自把同一张图写进文档一次，
 * 而两次都会回报"写回成功"。用户看到的是文档里凭空多了一个图层，
 * 而历史记录里一切正常 —— 这种问题事后根本查不出来。
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

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
const FEATURE = 'comfy.wash.portrait';

let helper;
let comfy;
let dataDir;
let token;

function url(path) {
  /*
   * PORT 是模块级的，而这个文件里有好几个用例会**重启 Helper** 并重新给它赋值。
   * 只要有一处重启失败、或者赋值和使用之间穿插了别的用例，PORT 就可能还停在
   * 初值 0 —— 那时 fetch 抛的是 undici 的一句 `bad port`，跟真正的原因
   * （某次重启没起来）隔着十万八千里，整个文件的用例一起变红而没人知道为什么。
   * 这个 flake 已经出现过三轮，两次都没能从日志里定位。就地说清楚。
   */
  if (!Number.isInteger(PORT) || PORT <= 0) {
    throw new Error(`测试用的 Helper 端口无效：PORT=${PORT}。多半是某次重启 Helper 没成功，或者赋值前就发了请求。`);
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
    const { json } = await api('GET', `/v1/jobs/${jobId}`);
    last = json.job;
    if (last && predicate(last)) return last;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`超时：最后状态=${last?.state}`);
}

/** 造一条已经出图、停在待写回的任务。 */
async function pendingJob(rgb) {
  const asset = await uploadPng(rgb);
  const { json } = await api('POST', '/v1/jobs', {
    featureId: FEATURE,
    params: { prompt: '洗一下', seed: { mode: 'fixed', value: 2 } },
    inputs: [{ paramId: 'image', assetId: asset.id, index: 0, source: 'upload' }],
    target: psTarget(),
    writeback: { mode: 'smartObject', layerName: 'AI 结果' }
  });
  assert.equal(json.ok, true, JSON.stringify(json));
  return await waitFor(json.job.id, (j) => j.state === 'writeback_pending');
}

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'psai-wb-'));
  comfy = await startComfyStub(0, { runMs: 120 });
  helper = await startHelper({ dataDir, port: 0, ephemeral: true });
  PORT = helper.port; // 不从 url 里抠：端口等于 80 时 URL 会规范化掉，Number('') === 0 → undici 报 bad port
  if (!Number.isInteger(PORT) || PORT <= 0) throw new Error(`Helper 端口不可用：${PORT}（url=${helper.url}）`);
  token = helper.issueToken();
  await helper.recovered;

  await api('PATCH', '/v1/settings', { comfy: { baseUrl: comfy.url } });
  const wf = (await api('POST', '/v1/workflows/import', { json: testWorkflow(), name: '写回测试用' })).json.workflow;
  await api('PUT', `/v1/features/${FEATURE}/binding`, { providerId: 'comfyui', workflowId: wf.id, enabled: true });
});

after(async () => {
  await helper?.stop();
  await comfy?.stop();
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

/* ==================== 设置冻结在任务上 ==================== */

test('创建时把「自动写回」冻在任务上，之后改设置不影响已有任务', async () => {
  /*
   * 每次现读当前设置的话：用户在任务跑的这几分钟里把开关关了，
   * 结果回来时还是自己写进了他的文档 —— 他明确说过不要。
   * 一条任务该不该自动写回，用户是在按下「生成」那一刻决定的。
   */
  await api('PATCH', '/v1/settings', { generation: { autoWriteback: true } });
  const withAuto = await pendingJob([11, 12, 13]);
  assert.equal(withAuto.writeback.auto, true, '创建时开着，任务上就该是 true');

  // 任务还停在待写回的时候把开关关掉
  await api('PATCH', '/v1/settings', { generation: { autoWriteback: false } });
  const again = (await api('GET', `/v1/jobs/${withAuto.id}`)).json.job;
  assert.equal(again.writeback.auto, true, '已经在途的任务不该跟着新设置变');

  const withoutAuto = await pendingJob([14, 15, 16]);
  assert.equal(withoutAuto.writeback.auto, false, '关掉之后新建的任务就该是 false');

  await api('PATCH', '/v1/settings', { generation: { autoWriteback: true } });
  const still = (await api('GET', `/v1/jobs/${withoutAuto.id}`)).json.job;
  assert.equal(still.writeback.auto, false, '重新打开也不该把已有任务卷进来');
});

/* ==================== 一次授权只兑现一次 ==================== */

test('同一条任务不能同时有两次写回', async () => {
  const job = await pendingJob([21, 22, 23]);

  const first = await api('POST', `/v1/jobs/${job.id}/writeback`, { mode: 'smartObject', layerName: 'A' });
  assert.equal(first.json.ok, true, JSON.stringify(first.json));
  assert.ok(first.json.attemptId, '必须发一个凭据回来');

  const second = await api('POST', `/v1/jobs/${job.id}/writeback`, { mode: 'smartObject', layerName: 'A' });
  assert.equal(second.json.ok, false, '第二个请求必须被拒 —— 否则用户文档里会多出一个图层');
  assert.equal(second.json.error.code, 'WRITEBACK_IN_PROGRESS');

  // 第一个凭据照常能用完
  const done = await api('POST', `/v1/jobs/${job.id}/writeback-result`, {
    ok: true,
    detail: '写回成功',
    attemptId: first.json.attemptId
  });
  assert.equal(done.json.job.state, 'succeeded');
});

test('过期的凭据回报会被丢掉，不去动任务状态', async () => {
  /*
   * 面板卡住很久之后才回过神，带着一个已经被顶替的凭据来回报。
   * 让它去改状态的话，会把后来那次成功的写回覆盖成失败 ——
   * 用户看到"写回失败"，而图其实已经好好地躺在文档里了。
   */
  const job = await pendingJob([31, 32, 33]);
  const lease = await api('POST', `/v1/jobs/${job.id}/writeback`, {});
  const attemptId = lease.json.attemptId;

  const ok = await api('POST', `/v1/jobs/${job.id}/writeback-result`, {
    ok: true,
    detail: '写回成功',
    attemptId
  });
  assert.equal(ok.json.job.state, 'succeeded');

  // 同一个凭据再回报一次（这次说失败）
  const stale = await api('POST', `/v1/jobs/${job.id}/writeback-result`, {
    ok: false,
    detail: '迟到的失败回报',
    attemptId
  });
  assert.equal(stale.json.ok, true, '这是一次正常的请求，只是内容被忽略');
  assert.equal(stale.json.job.state, 'succeeded', '任务状态不该被过期回报改掉');

  const attempts = readDb((db) =>
    db.prepare('SELECT outcome FROM writeback_attempts WHERE job_id = ?').all(job.id).map((r) => r.outcome)
  );
  assert.deepEqual(attempts, ['succeeded'], `尝试记录应该只有一条且是成功：${attempts.join(',')}`);
});

test('别的任务的凭据不能拿来回报这一条', async () => {
  const a = await pendingJob([41, 42, 43]);
  const b = await pendingJob([44, 45, 46]);
  const leaseA = await api('POST', `/v1/jobs/${a.id}/writeback`, {});

  const cross = await api('POST', `/v1/jobs/${b.id}/writeback-result`, {
    ok: true,
    detail: '张冠李戴',
    attemptId: leaseA.json.attemptId
  });
  assert.equal(cross.json.ok, false, '凭据不属于这条任务，必须拒绝');
  assert.equal((await api('GET', `/v1/jobs/${b.id}`)).json.job.state, 'writeback_pending', 'B 的状态不该被动过');

  await api('POST', `/v1/jobs/${a.id}/writeback-result`, { ok: true, detail: 'ok', attemptId: leaseA.json.attemptId });
});

test('写回记录落了库：模式、图层名、是不是自动触发的，都查得到', async () => {
  const job = await pendingJob([51, 52, 53]);
  await api('POST', `/v1/jobs/${job.id}/writeback`, { mode: 'pixelLayer', layerName: '自动图层', auto: true });

  const row = readDb((db) =>
    db
      .prepare('SELECT attempt_id, mode, layer_name, auto, outcome, asset_id FROM writeback_attempts WHERE job_id = ?')
      .get(job.id)
  );
  const row2 = row;
  assert.equal(row.mode, 'pixelLayer');
  assert.equal(row.layer_name, '自动图层');
  assert.equal(row.auto, 1, '排查"我没点它怎么自己写回了"时，全靠这一列');
  assert.equal(row.outcome, 'running');
  assert.equal(row.asset_id, job.results[0].assetId, '记下写的是哪一张图');

  await api('POST', `/v1/jobs/${job.id}/writeback-result`, { ok: true, detail: 'ok', attemptId: row2.attempt_id });
});

/* ==================== 生成成功 ≠ 写回成功 ==================== */

test('写回失败不算生成失败：结果保留，可以再写一次', async () => {
  /*
   * 判成 failed 的话，用户会以为要重跑一次（云端就是再花一次钱），
   * 而实际上图早就出来了，只要再点一次「写回」。
   */
  const job = await pendingJob([61, 62, 63]);
  const lease = await api('POST', `/v1/jobs/${job.id}/writeback`, {});
  const failed = await api('POST', `/v1/jobs/${job.id}/writeback-result`, {
    ok: false,
    detail: '文档已经被关掉了',
    code: 'WRITEBACK_TARGET_INVALID',
    attemptId: lease.json.attemptId
  });

  assert.equal(failed.json.job.state, 'retryable_writeback_failure', '不能判成 failed');
  assert.equal(failed.json.job.results.length, 1, '结果必须还在');
  assert.match(JSON.stringify(failed.json.job.error), /文档已经被关掉了/);

  // 失败之后必须能再领一次执行权 —— 否则这条任务就永远写不回去了
  const retry = await api('POST', `/v1/jobs/${job.id}/writeback`, {});
  assert.equal(retry.json.ok, true, `失败后应该能重新领权：${JSON.stringify(retry.json)}`);
  assert.notEqual(retry.json.attemptId, lease.json.attemptId, '这是新的一次尝试，凭据也该是新的');

  const done = await api('POST', `/v1/jobs/${job.id}/writeback-result`, {
    ok: true,
    detail: '这次成了',
    attemptId: retry.json.attemptId
  });
  assert.equal(done.json.job.state, 'succeeded');
});

test('删除任务时连写回记录一起删，不留孤儿', async () => {
  const job = await pendingJob([71, 72, 73]);
  const lease71 = await api('POST', `/v1/jobs/${job.id}/writeback`, {});
  await api('POST', `/v1/jobs/${job.id}/writeback-result`, {
    ok: true,
    detail: 'ok',
    attemptId: lease71.json.attemptId
  });

  assert.ok(
    readDb((db) => db.prepare('SELECT COUNT(*) n FROM writeback_attempts WHERE job_id = ?').get(job.id).n) > 0,
    '前提：应该有写回记录'
  );
  await api('DELETE', `/v1/jobs/${job.id}`);
  assert.equal(
    readDb((db) => db.prepare('SELECT COUNT(*) n FROM writeback_attempts WHERE job_id = ?').get(job.id).n),
    0,
    '这张表会一直长，任务删了它也必须跟着走'
  );
});

/* ==================== 重启之后 ==================== */

test('重启后待写回的任务还在，auto 标记也还在', async () => {
  // 自动写回最该顶用的场景就是"用户走开了一会儿"。
  // 重启后这条任务必须还认得出自己该被自动写回，否则它会永远停在这里。
  await api('PATCH', '/v1/settings', { generation: { autoWriteback: true } });
  const job = await pendingJob([81, 82, 83]);
  assert.equal(job.writeback.auto, true);

  await helper.stop();
  helper = await startHelper({ dataDir, port: 0, ephemeral: true });
  PORT = helper.port; // 不从 url 里抠：端口等于 80 时 URL 会规范化掉，Number('') === 0 → undici 报 bad port
  if (!Number.isInteger(PORT) || PORT <= 0) throw new Error(`Helper 端口不可用：${PORT}（url=${helper.url}）`);
  token = helper.issueToken();
  await helper.recovered;

  const after_ = (await api('GET', `/v1/jobs/${job.id}`)).json.job;
  assert.equal(after_.state, 'writeback_pending', '重启后该保持待写回');
  assert.equal(after_.writeback.auto, true, 'auto 标记必须跟着任务一起持久化');
  assert.equal(after_.results.length, 1, '结果不能丢');
});

test('卡死的写回会过期，不会把任务永远锁住', async () => {
  /*
   * 写回是插件那边干的活，Helper 只能等它回报。插件可能在写回中途被关掉、
   * Photoshop 可能卡在一个模态框上 —— 那条 running 记录就永远不会有结论。
   * 没有过期时间的话，这条任务从此再也写不回去了：每次点「写回」都是
   * WRITEBACK_IN_PROGRESS，而那个"正在进行"的写回其实早就不存在了。
   *
   * 用手改 started_at 来造这个现场：租约有效期是 2 分钟，
   * 真等两分钟测不起，而要复现的本来就是"库里留着一条很久以前的 running"。
   */
  const job = await pendingJob([91, 92, 93]);
  const stuck = await api('POST', `/v1/jobs/${job.id}/writeback`, {});
  assert.equal(stuck.json.ok, true);

  // 立刻再领会被拒 —— 这是正常的互斥
  const blocked = await api('POST', `/v1/jobs/${job.id}/writeback`, {});
  assert.equal(blocked.json.error.code, 'WRITEBACK_IN_PROGRESS');

  // 把那条租约的起始时间拨回 10 分钟前
  const raw = new DatabaseSync(join(dataDir, 'psai.sqlite'));
  raw.prepare('UPDATE writeback_attempts SET started_at = ? WHERE attempt_id = ?').run(
    Date.now() - 600_000,
    stuck.json.attemptId
  );
  raw.close();

  const retry = await api('POST', `/v1/jobs/${job.id}/writeback`, {});
  assert.equal(retry.json.ok, true, `过期之后必须能重新领权：${JSON.stringify(retry.json)}`);
  assert.notEqual(retry.json.attemptId, stuck.json.attemptId);

  const outcomes = readDb((db) =>
    db.prepare('SELECT attempt_id, outcome FROM writeback_attempts WHERE job_id = ?').all(job.id)
  );
  const old = outcomes.find((r) => r.attempt_id === stuck.json.attemptId);
  assert.equal(old.outcome, 'superseded', '过期的那次要如实记成被顶替，不能装作没发生过');

  // 顶替掉的那个凭据再回来回报，也不该动任务状态
  const late = await api('POST', `/v1/jobs/${job.id}/writeback-result`, {
    ok: false,
    detail: '迟到的失败',
    attemptId: stuck.json.attemptId
  });
  assert.equal(late.json.job.state, 'writeback_pending', '被顶替的凭据说什么都不算数');

  await api('POST', `/v1/jobs/${job.id}/writeback-result`, {
    ok: true,
    detail: 'ok',
    attemptId: retry.json.attemptId
  });
});

/* ==================== 半份结果 ==================== */

test('老库里的半份结果不会被当成完整的收尾', async () => {
  /*
   * 光看 COUNT(job_results) > 0 分不清"三张全在"和"写到第二张时崩了"。
   * 新代码是整体落库的，自己不会产生半份；但老版本（非原子那一版）
   * 留下的库还在用户机器上，里面确实会有。
   * 当成完整收尾的话，用户永远少了几张图 —— 而且没有任何提示，
   * 他只会觉得"这次出图好像少了"，然后去怀疑模型。
   */
  const job = await pendingJob([101, 102, 103]);
  assert.equal(job.results.length, 1);

  await helper.stop();

  // 造一个老库的现场：有结果行，但没有完成标记，而且声称本该有 3 张
  const raw = new DatabaseSync(join(dataDir, 'psai.sqlite'));
  raw.prepare("UPDATE jobs SET state='remote_queued', finished_at=NULL, finalized_at=NULL, results_expected=3 WHERE id=?").run(job.id);
  raw.close();

  helper = await startHelper({ dataDir, port: 0, ephemeral: true });
  PORT = helper.port; // 不从 url 里抠：端口等于 80 时 URL 会规范化掉，Number('') === 0 → undici 报 bad port
  if (!Number.isInteger(PORT) || PORT <= 0) throw new Error(`Helper 端口不可用：${PORT}（url=${helper.url}）`);
  token = helper.issueToken();
  await helper.recovered;

  const after_ = (await api('GET', `/v1/jobs/${job.id}`)).json.job;
  assert.notEqual(after_.state, 'succeeded', '数量对不上就不能假装完整收尾');
  assert.ok(
    ['writeback_pending', 'lost', 'remote_queued', 'running', 'downloading'].includes(after_.state),
    `应该去补齐或如实判丢失，实际 ${after_.state}`
  );
  if (after_.state === 'writeback_pending') {
    // 补齐成功的话，数量必须真的对上了，而且完成标记要落上
    const marker = readDb((db) =>
      db.prepare('SELECT finalized_at, results_expected FROM jobs WHERE id = ?').get(job.id)
    );
    assert.ok(marker.finalized_at, '补齐之后要写下完成标记');
    assert.equal(after_.results.length, marker.results_expected, '数量要和标记对得上');
  }
});

test('完成标记在的任务，重启后直接收尾，不重下也不重插', async () => {
  const job = await pendingJob([111, 112, 113]);
  const marker = readDb((db) => db.prepare('SELECT finalized_at, results_expected FROM jobs WHERE id = ?').get(job.id));
  assert.ok(marker.finalized_at, '正常落库就该带上完成标记');
  assert.equal(marker.results_expected, 1);

  await helper.stop();
  // 只把状态拨回半路，结果和标记都不动 —— 这是"崩在状态迁移那一步"的现场
  const raw = new DatabaseSync(join(dataDir, 'psai.sqlite'));
  raw.prepare("UPDATE jobs SET state='remote_queued', finished_at=NULL WHERE id=?").run(job.id);
  raw.close();

  helper = await startHelper({ dataDir, port: 0, ephemeral: true });
  PORT = helper.port; // 不从 url 里抠：端口等于 80 时 URL 会规范化掉，Number('') === 0 → undici 报 bad port
  if (!Number.isInteger(PORT) || PORT <= 0) throw new Error(`Helper 端口不可用：${PORT}（url=${helper.url}）`);
  token = helper.issueToken();
  await helper.recovered;

  const after_ = (await api('GET', `/v1/jobs/${job.id}`)).json.job;
  assert.equal(after_.state, 'writeback_pending', '有完成标记就该直接收尾');
  assert.equal(after_.results.length, 1, '不能重复插入');
});

/* ==================== 租约与重启 ==================== */

test('重启之后，上一次没结论的租约不会把任务永远锁住', async () => {
  /*
   * 插件在写回途中被关掉（Photoshop 退出、面板重载），那条 running 记录
   * 永远不会有结论。没有过期的话，这条任务从此再也写不回去：
   * 每次点「写回」都是 WRITEBACK_IN_PROGRESS，
   * 而那个"正在进行"的写回其实早就不存在了。
   */
  const job = await pendingJob([121, 122, 123]);
  const lease = await api('POST', `/v1/jobs/${job.id}/writeback`, {});
  assert.equal(lease.json.ok, true);

  await helper.stop();
  // 把租约拨回 10 分钟前 —— 等价于"插件在写回途中被关掉，然后过了很久"
  const raw = new DatabaseSync(join(dataDir, 'psai.sqlite'));
  raw.prepare('UPDATE writeback_attempts SET started_at = ? WHERE attempt_id = ?').run(
    Date.now() - 600_000,
    lease.json.attemptId
  );
  raw.close();

  helper = await startHelper({ dataDir, port: 0, ephemeral: true });
  PORT = helper.port; // 不从 url 里抠：端口等于 80 时 URL 会规范化掉，Number('') === 0 → undici 报 bad port
  if (!Number.isInteger(PORT) || PORT <= 0) throw new Error(`Helper 端口不可用：${PORT}（url=${helper.url}）`);
  token = helper.issueToken();
  await helper.recovered;

  const retry = await api('POST', `/v1/jobs/${job.id}/writeback`, {});
  assert.equal(retry.json.ok, true, `重启后过期的租约必须能让位：${JSON.stringify(retry.json)}`);
  assert.notEqual(retry.json.attemptId, lease.json.attemptId);

  await api('POST', `/v1/jobs/${job.id}/writeback-result`, {
    ok: true,
    detail: 'ok',
    attemptId: retry.json.attemptId
  });
});

test('续租能让一次长写回撑过租约期', async () => {
  /*
   * 写一张 8K 智能对象要几十秒，而租约只有两分钟。
   * 光靠"到期就让位"的话，一次**正在正常进行**的写回会被判成卡死，
   * 另一个写手接手，用户文档里就有了两个图层。
   */
  const job = await pendingJob([131, 132, 133]);
  const lease = await api('POST', `/v1/jobs/${job.id}/writeback`, {});

  // 把租约拨老，然后续一次
  const raw = new DatabaseSync(join(dataDir, 'psai.sqlite'));
  raw.prepare('UPDATE writeback_attempts SET started_at = ? WHERE attempt_id = ?').run(
    Date.now() - 600_000,
    lease.json.attemptId
  );
  raw.close();

  const renew = await api('POST', `/v1/jobs/${job.id}/writeback/renew`, { attemptId: lease.json.attemptId });
  assert.equal(renew.json.renewed, true, `续租应该成功：${renew.json.reason}`);

  // 续过之后，别人就不该能抢走
  const steal = await api('POST', `/v1/jobs/${job.id}/writeback`, {});
  assert.equal(steal.json.ok, false, '续过租的写回不该被顶替');
  assert.equal(steal.json.error.code, 'WRITEBACK_IN_PROGRESS');

  await api('POST', `/v1/jobs/${job.id}/writeback-result`, {
    ok: true,
    detail: 'ok',
    attemptId: lease.json.attemptId
  });

  // 已经有结论的凭据不能再续
  const late = await api('POST', `/v1/jobs/${job.id}/writeback/renew`, { attemptId: lease.json.attemptId });
  assert.equal(late.json.renewed, false, '已经收尾的写回不该还能续租');
});

test('多图任务只落了一半：恢复时补齐，不把半份当成完整', async () => {
  /*
   * "半份结果"只有多图才谈得上，而多图工作流是真实存在的（批量出图、多视角）。
   * 老版本（非原子那一版）留下的库里就有这种东西：三张里只写进去两张。
   *
   * 把它当成完整收尾的话，用户永远少一张图 —— 而且没有任何提示，
   * 他只会觉得"这次出图好像少了"，然后去怀疑模型或者工作流。
   */
  comfy.setResultCount(3);
  try {
    const job = await pendingJob([201, 202, 203]);
    assert.equal(job.results.length, 3, '前提：这条任务出了 3 张');
    const remoteId = job.remoteId;

    await helper.stop();

    // 造老库的现场：删掉第三张、抹掉完成标记，状态拨回半路
    const raw = new DatabaseSync(join(dataDir, 'psai.sqlite'));
    raw.prepare('DELETE FROM job_results WHERE job_id = ? AND idx = 2').run(job.id);
    raw
      .prepare("UPDATE jobs SET state='remote_queued', finished_at=NULL, finalized_at=NULL, results_expected=NULL WHERE id=?")
      .run(job.id);
    raw.close();

    helper = await startHelper({ dataDir, port: 0, ephemeral: true });
  PORT = helper.port; // 不从 url 里抠：端口等于 80 时 URL 会规范化掉，Number('') === 0 → undici 报 bad port
  if (!Number.isInteger(PORT) || PORT <= 0) throw new Error(`Helper 端口不可用：${PORT}（url=${helper.url}）`);
    token = helper.issueToken();
    await helper.recovered;

    const after_ = (await api('GET', `/v1/jobs/${job.id}`)).json.job;
    assert.equal(after_.results.length, 3, `应该从远端补回完整的 3 张，实际 ${after_.results.length} 张`);
    assert.equal(after_.remoteId, remoteId, '不该重新提交，远端任务号要保持不变');

    const marker = readDb((db) =>
      db.prepare('SELECT finalized_at, results_expected FROM jobs WHERE id = ?').get(job.id)
    );
    assert.ok(marker.finalized_at, '补齐之后要写下完成标记，下次重启才不用再来一遍');
    assert.equal(marker.results_expected, 3);

    // 补齐用的是"整体替换"，不能出现重复行
    assert.equal(
      readDb((db) => db.prepare('SELECT COUNT(DISTINCT idx) n FROM job_results WHERE job_id = ?').get(job.id).n),
      3,
      'idx 不该有重复'
    );
  } finally {
    comfy.setResultCount(1);
  }
});

/* ==================== 写回的是哪一张 ==================== */

test('写回可以指定结果里的任意一张，不是永远第 0 张', async () => {
  /*
   * 多图结果里"第 0 张"和"用户选的那张"经常不是一回事：
   * 他点开 #3 觉得最好、点写回，进文档的却是 #1，
   * 而界面上没有任何地方提示他写回的不是他选的那张 ——
   * 他只会觉得写回坏了，或者以为自己点错了。
   */
  comfy.setResultCount(3);
  try {
    const job = await pendingJob([211, 212, 213]);
    assert.equal(job.results.length, 3);
    const wanted = job.results[2].assetId;

    const lease = await api('POST', `/v1/jobs/${job.id}/writeback`, { assetId: wanted });
    assert.equal(lease.json.ok, true, JSON.stringify(lease.json));

    // 记账要记下写的是哪一张 —— 事后对账、排查"怎么进去的是另一张"全靠它
    assert.equal(
      readDb((db) =>
        db.prepare("SELECT asset_id FROM writeback_attempts WHERE job_id = ? AND outcome = 'running'").get(job.id)
          ?.asset_id
      ),
      wanted,
      '尝试记录里应该是用户指定的那一张'
    );

    await api('POST', `/v1/jobs/${job.id}/writeback-result`, {
      ok: true,
      detail: 'ok',
      attemptId: lease.json.attemptId
    });
  } finally {
    comfy.setResultCount(1);
  }
});

test('不指定时退回第一张，行为和以前一样', async () => {
  const job = await pendingJob([221, 222, 223]);
  const lease = await api('POST', `/v1/jobs/${job.id}/writeback`, {});
  assert.equal(
    readDb((db) =>
      db.prepare("SELECT asset_id FROM writeback_attempts WHERE job_id = ? AND outcome = 'running'").get(job.id)
        ?.asset_id
    ),
    job.results[0].assetId
  );
  await api('POST', `/v1/jobs/${job.id}/writeback-result`, {
    ok: true,
    detail: 'ok',
    attemptId: lease.json.attemptId
  });
});

test('指定一张不属于这条任务的资产：当场拒绝，不往用户文档里写别的图', async () => {
  /*
   * 默默换成第一张也不行 —— 调用方以为自己指定了，
   * 结果写进去的是另一张。那种不一致比直接失败难查得多。
   */
  const a = await pendingJob([231, 232, 233]);
  const b = await pendingJob([234, 235, 236]);

  const res = await api('POST', `/v1/jobs/${a.id}/writeback`, { assetId: b.results[0].assetId });
  assert.equal(res.json.ok, false, '别的任务的资产不能拿来写回');
  assert.equal(res.json.error.code, 'ASSET_NOT_FOUND');
  assert.equal(
    readDb((db) => db.prepare('SELECT COUNT(*) n FROM writeback_attempts WHERE job_id = ?').get(a.id).n),
    0,
    '被拒的请求不该留下尝试记录'
  );

  // 清理：b 还占着待写回，让它收尾，免得影响后面的用例
  for (const j of [a, b]) {
    const lease = await api('POST', `/v1/jobs/${j.id}/writeback`, {});
    await api('POST', `/v1/jobs/${j.id}/writeback-result`, {
      ok: true,
      detail: 'ok',
      attemptId: lease.json.attemptId
    });
  }
});

test('「仅存资产库」要分清是按设置还是没有可写的文档', async () => {
  /*
   * 两种情况最后都不写文档，可原因完全不同。用同一句话打发的话，
   * 第二种情况下用户会以为是自己设置错了，跑去设置页翻半天 ——
   * 而实际原因是提交时没有打开的文档。
   */
  const asset = await uploadPng([241, 242, 243]);
  const noTarget = await api('POST', '/v1/jobs', {
    featureId: FEATURE,
    params: { prompt: '没有目标文档', seed: { mode: 'fixed', value: 7 } },
    inputs: [{ paramId: 'image', assetId: asset.id, index: 0, source: 'upload' }],
    target: null,
    writeback: { mode: 'assetOnly' }
  });
  const done = await waitFor(noTarget.json.job.id, (j) => j.state === 'succeeded');
  const events = (await api('GET', `/v1/jobs/${done.id}/events`)).json.events;
  const last = events[events.length - 1];
  assert.match(last.note, /没有可写回|历史页/, `没有目标文档时要说清楚：${last.note}`);
  assert.ok(!/按设置/.test(last.note), '这不是用户的设置造成的，别让他去翻设置页');
});

/* ==================== 写回方式的服务端校验 ==================== */

test('功能不支持的写回方式，Helper 这一层也要挡', async () => {
  /*
   * 两边都要拦：插件那边挡的是误操作，这边挡的是"绕过插件直接打接口"。
   * 只在插件里拦的话，接口就成了一个可以让任意任务做任意事情的口子 ——
   * 比如让一个不支持原位的功能去做"选区原位"，而它根本没有选区可对齐。
   *
   * 「抠图」这个功能的允许列表里就没有 inPlaceSelection。
   */
  const wf = (await api('POST', '/v1/workflows/import', { json: testWorkflow(), name: '抠图测试用' })).json.workflow;
  await api('PUT', '/v1/features/comfy.edit.matting/binding', {
    providerId: 'comfyui',
    workflowId: wf.id,
    enabled: true
  });

  const asset = await uploadPng([251, 252, 253]);
  const created = await api('POST', '/v1/jobs', {
    featureId: 'comfy.edit.matting',
    params: { seed: { mode: 'fixed', value: 3 } },
    inputs: [{ paramId: 'image', assetId: asset.id, index: 0, source: 'upload' }],
    target: psTarget(),
    writeback: { mode: 'smartObject', layerName: 'AI 结果' }
  });
  assert.equal(created.json.ok, true, JSON.stringify(created.json));
  const job = await waitFor(created.json.job.id, (j) => j.state === 'writeback_pending');

  const res = await api('POST', `/v1/jobs/${job.id}/writeback`, { mode: 'inPlaceSelection' });
  assert.equal(res.json.ok, false, '越权的写回方式必须被拒');
  assert.equal(res.json.error.code, 'JOB_PARAM_INVALID');
  assert.match(`${res.json.error.message}${res.json.error.details ?? ''}`, /不支持|允许/);
  assert.equal(
    readDb((db) => db.prepare('SELECT COUNT(*) n FROM writeback_attempts WHERE job_id = ?').get(job.id).n),
    0,
    '被拒的请求不该发出凭据 —— 发了就等于允许插件去动文档'
  );

  // 允许的方式照常可用
  const ok = await api('POST', `/v1/jobs/${job.id}/writeback`, { mode: 'smartObject' });
  assert.equal(ok.json.ok, true, JSON.stringify(ok.json));
  await api('POST', `/v1/jobs/${job.id}/writeback-result`, {
    ok: true,
    detail: 'ok',
    attemptId: ok.json.attemptId
  });
});

test('原位写回没有冻结选区时，凭据都不该发出去', async () => {
  /*
   * 发完凭据才发现没选区的话，插件那边已经开始动文档了 ——
   * 图进去了才报错，用户看到的是"写回失败"外加一个凭空出现、
   * 还放错地方的图层。这条检查必须排在发凭据之前。
   */
  const asset = await uploadPng([261, 262, 263]);
  const created = await api('POST', '/v1/jobs', {
    featureId: FEATURE,
    params: { prompt: '洗一下', seed: { mode: 'fixed', value: 4 } },
    inputs: [{ paramId: 'image', assetId: asset.id, index: 0, source: 'upload' }],
    // 有目标文档，但**没有**选区
    target: { ...psTarget(), selectionBounds: null },
    writeback: { mode: 'smartObject', layerName: 'AI 结果' }
  });
  assert.equal(created.json.ok, true, JSON.stringify(created.json));
  const job = await waitFor(created.json.job.id, (j) => j.state === 'writeback_pending');

  const res = await api('POST', `/v1/jobs/${job.id}/writeback`, { mode: 'inPlaceSelection' });
  assert.equal(res.json.ok, false, '没有选区就不该发凭据');
  assert.match(`${res.json.error.message}${res.json.error.details ?? ''}`, /没有记录选区/);
  assert.equal(
    readDb((db) => db.prepare('SELECT COUNT(*) n FROM writeback_attempts WHERE job_id = ?').get(job.id).n),
    0
  );
});

/* ==================== 写回方式在「创建」这一刻就要定下来 ==================== */

/*
 * 为什么这道检查必须在创建时做，而不是等到写回：
 *
 * 等到写回才发现方式不对，图**已经生成完了**。ComfyUI 那边是电费和时间，
 * 云端那边是真金白银 —— 一次已经扣掉的钱。用户拿到的是
 * 「任务成功，但写不回去」，而这件事在他按下「开始处理」那一刻
 * 就能拦住，一分钱不花。
 *
 * 下面两条用例都同时断言「提交从没发生过」：光看到报错不够，
 * 报错完全可以发生在提交之后。
 */

test('功能不支持的写回方式：创建就被拒，Provider 一次都没被调用', async () => {
  const asset = await uploadPng([31, 32, 33]);
  const before = comfy.tasks.size;

  const res = await api('POST', '/v1/jobs', {
    // 无损放大只允许智能对象 / 像素图层 / 仅资产，不允许选区原位
    featureId: 'comfy.misc.upscale.lossless',
    params: { image: null, upscaleFactor: '2', upscaleMethod: 'lanczos' },
    inputs: [{ paramId: 'image', assetId: asset.id, index: 0, source: 'upload' }],
    target: { ...psTarget(), selectionBounds: { left: 0, top: 0, right: 64, bottom: 64 } },
    writeback: { mode: 'inPlaceSelection', layerName: 'AI 结果' }
  });

  assert.equal(res.json.ok, false, '不支持的写回方式必须在创建时就拒掉');
  assert.match(`${res.json.error.message}${res.json.error.details ?? ''}`, /不支持/);
  assert.equal(comfy.tasks.size, before, '被拒的任务绝不能已经提交出去 —— 那是白花的钱');
  assert.equal(
    readDb((db) => db.prepare("SELECT COUNT(*) n FROM jobs WHERE feature_id = 'comfy.misc.upscale.lossless'").get().n),
    0,
    '库里也不该留下这条任务'
  );
});

test('选了原位写回却没有冻结选区：创建就被拒，Provider 一次都没被调用', async () => {
  const asset = await uploadPng([41, 42, 43]);
  const before = comfy.tasks.size;

  const res = await api('POST', '/v1/jobs', {
    featureId: FEATURE, // 这个功能是允许原位写回的
    params: { prompt: '洗一下', seed: { mode: 'fixed', value: 7 } },
    inputs: [{ paramId: 'image', assetId: asset.id, index: 0, source: 'upload' }],
    target: psTarget(), // selectionBounds 是 null
    writeback: { mode: 'inPlaceSelection', layerName: 'AI 结果' }
  });

  assert.equal(res.json.ok, false, '没有选区的原位写回必须在创建时就拒掉');
  const msg = `${res.json.error.message}${res.json.error.details ?? ''}`;
  assert.match(msg, /没有记录选区/);
  assert.match(msg, /智能对象|像素图层/, '要顺手给出可行的替代方案，别让用户自己猜');
  assert.equal(comfy.tasks.size, before, '被拒的任务绝不能已经提交出去');
});

test('允许的写回方式照常创建 —— 这道闸门不能把正常路挡住', async () => {
  const asset = await uploadPng([51, 52, 53]);
  const res = await api('POST', '/v1/jobs', {
    featureId: FEATURE,
    params: { prompt: '洗一下', seed: { mode: 'fixed', value: 8 } },
    inputs: [{ paramId: 'image', assetId: asset.id, index: 0, source: 'upload' }],
    target: { ...psTarget(), selectionBounds: { left: 4, top: 4, right: 60, bottom: 60 } },
    writeback: { mode: 'inPlaceSelection', layerName: 'AI 结果' }
  });
  assert.equal(res.json.ok, true, JSON.stringify(res.json));
  await waitFor(res.json.job.id, (j) => j.state === 'writeback_pending');
});
