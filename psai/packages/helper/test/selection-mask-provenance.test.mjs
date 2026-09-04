/**
 * 选区遮罩的出处：alpha 通道**是不是**用户圈出来的。
 *
 * 靠遮罩工作的工作流（Flux Fill 局部重绘、万物消除那一族）按约定
 * 「透明处即处理区」。判据一旦退化成"有没有 alpha 通道"，
 * 就有一条很安静的错路：
 *
 *   用户建了选区 → 捕获时 imaging 读遮罩失败（权限、并发、版本…）
 *   → 界面提示"选区已按外接矩形处理"，但图照样能提交
 *   → 而这张图碰巧自带透明（透明背景的图层、抠过的素材、带透明边的 PNG）
 *   → 那片**天然透明**被当成了用户的选区
 *   → 模型去改一片他完全没碰过的地方，钱照花
 *
 * 用户看到的是一张"模型没听懂我"的图，不会想到是遮罩的出处错了。
 * 所以判据必须是资产上记着的事实：合成的时候**真的收到过**选区灰度。
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { startHelper } from '../dist/index.js';
import { RunningHubAdapter } from '../dist/providers/runninghub.js';
import { composeAlpha } from '../dist/mask.js';
import { makePng } from '../../../tools/comfy-stub.mjs';
import { startDeadServer } from './_dead-server.mjs';
import { assertCleanLog } from './_log-assertions.mjs';

/** 需要遮罩的内置预设：Flux Fill 局部重绘。 */
const INPAINT = '1901904713074548737';

const silentLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => silentLog
};

/** 一张 RGB 图（完全不透明，没有 alpha 通道）。 */
function opaquePng(w = 16, h = 16) {
  return makePng(w, h, [120, 130, 140]);
}

/**
 * 一张**天然带透明**的图。
 *
 * 字节是用 composeAlpha 造的，但它在生产里对应的是
 * "用户拿了一张抠过图的素材"，而不是"用户圈了选区"——
 * 关键就在于：光看字节，这两者分不出来。
 */
function naturallyTransparentPng(w = 16, h = 16) {
  const gray = Buffer.alloc(w * h, 0);
  for (let i = 0; i < w * h; i++) gray[i] = i % 2 === 0 ? 255 : 0;
  return composeAlpha(makePng(w, h, [120, 130, 140]), gray, w, h);
}

function input(buffer, { hasSelectionMask }) {
  return {
    paramId: 'image',
    index: 0,
    buffer,
    mime: 'image/png',
    filename: 'in.png',
    hasAlpha: true,
    hasSelectionMask
  };
}

/** 每条用例起的"死服务器"，收尾时统一关掉，别把端口漏出去。 */
const deadServers = [];

/** PsaiError 的 message 是错误码的通用文案，具体原因在 details 上。 */
function why(e) {
  return `${e?.message ?? ''}｜${e?.details ?? ''}`;
}

async function submitInpaint(inputs) {
  /*
   * 地址来自一个"连上就掐断"的服务器：只要走到发请求那一步就一定是网络错，
   * 和"被遮罩闸门拦下"区分得开。
   *
   * 不用"拿一个空闲端口再放掉"——那是个竞态，放掉之后别的套件随时可能
   * 绑上去，于是这里会连到一个真能应答的服务，用例假通过。
   */
  const deadSrv = await startDeadServer();
  deadServers.push(deadSrv);
  const rh = new RunningHubAdapter(
    { baseUrl: deadSrv.url, apiKey: 'test-key', defaultWorkflowId: INPAINT, timeoutMs: 2000 },
    silentLog
  );
  return rh.submit({
    jobId: 'job_test',
    featureId: 'rh.inpaint',
    params: { prompt: '补一下' },
    inputs,
    remoteWorkflowId: INPAINT,
    prompt: '补一下'
  });
}

test('天然透明冒充选区：必须拦下来，而且要说清为什么', async () => {
  /*
   * 这张图有 alpha 通道，也确实"有可编辑区"——
   * 任何只看像素的检查都会放行。唯一能识破它的是出处。
   */
  const err = await submitInpaint([input(naturallyTransparentPng(), { hasSelectionMask: false })]).then(
    () => null,
    (e) => e
  );
  assert.ok(err, '没带选区的局部重绘必须提交失败');
  assert.equal(err.code, 'JOB_PARAM_INVALID');
  assert.match(why(err), /没有带上选区/);
  assert.match(why(err), /不是你圈出来的/, '要点破"那是它自己的透明度"，否则用户无从下手');
  assert.match(why(err), /外接矩形/, '要提示上一步那句警告，把两件事连起来');
});

test('压根没有 alpha 的图：同样拦下，但不说那句多余的话', async () => {
  const err = await submitInpaint([
    { ...input(opaquePng(), { hasSelectionMask: false }), hasAlpha: false }
  ]).then(
    () => null,
    (e) => e
  );
  assert.ok(err);
  assert.match(why(err), /没有带上选区/);
  assert.ok(!/不是你圈出来的/.test(why(err)), '这张图没有透明通道，那句提醒只会让人更糊涂');
});

test('带了真选区就放行 —— 闸门不能把正常路挡住', async () => {
  /*
   * 放行之后会死在网络上（地址是个确定连不上的端口）。
   * 断言的是"失败的原因不再是遮罩"—— 这正好证明它过了闸门。
   */
  const err = await submitInpaint([input(naturallyTransparentPng(), { hasSelectionMask: true })]).then(
    () => null,
    (e) => e
  );
  assert.ok(err, '连不上就该报错');
  assert.ok(!/没有带上选区/.test(why(err)), `不该再被遮罩闸门拦：${why(err)}`);
  assert.ok(!/遮罩不可用/.test(why(err)), `遮罩是可用的：${why(err)}`);
});

test('带了选区但整张都不可编辑：拦下，说的是"遮罩不可用"', async () => {
  /*
   * 这是另一回事，要分开说：出处对，但内容是废的
   * （用户圈了个空选区 / 遮罩全 0）。下游什么都不会做，
   * 用户等几分钟拿回一张没变的图。
   */
  const w = 16;
  const h = 16;
  const allKeep = composeAlpha(makePng(w, h, [1, 2, 3]), Buffer.alloc(w * h, 0), w, h);
  const err = await submitInpaint([input(allKeep, { hasSelectionMask: true })]).then(
    () => null,
    (e) => e
  );
  assert.ok(err);
  assert.equal(err.code, 'JOB_PARAM_INVALID');
  assert.match(why(err), /遮罩不可用/);
  assert.ok(!/没有带上选区/.test(why(err)), '出处是对的，别把两种问题说成一种');
});

/* ==================== 出处是怎么记下来的 ==================== */

let helper;
let dataDir;
let token;
let PORT = 0;

async function upload(png, mask, w, h) {
  const fd = new FormData();
  fd.append('file', new Blob([png], { type: 'image/png' }), 'in.png');
  if (mask) {
    fd.append('mask', new Blob([mask], { type: 'application/octet-stream' }), 'mask.gray');
    fd.append('maskWidth', String(w));
    fd.append('maskHeight', String(h));
  }
  if (!Number.isInteger(PORT) || PORT <= 0) {
    throw new Error(`测试用的 Helper 端口无效：PORT=${PORT}。多半是某次启动 Helper 没成功，或者在赋值前就发了请求。`);
  }
  const res = await fetch(`http://127.0.0.1:${PORT}/v1/assets`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: fd
  });
  return (await res.json()).assets[0];
}

function flagOf(assetId) {
  const db = new DatabaseSync(join(dataDir, 'psai.sqlite'), { readOnly: true });
  try {
    return Number(db.prepare('SELECT has_selection_mask m FROM assets WHERE id = ?').get(assetId).m);
  } finally {
    db.close();
  }
}

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'psai-maskprov-'));
  helper = await startHelper({ dataDir, port: 0, ephemeral: true });
  PORT = helper.port; // 不从 url 里抠：端口等于 80 时 URL 会规范化掉，Number('') === 0 → undici 报 bad port
  if (!Number.isInteger(PORT) || PORT <= 0) throw new Error(`Helper 端口不可用：${PORT}（url=${helper.url}）`);
  token = helper.issueToken();
  await helper.recovered;
});

after(async () => {
  for (const d of deadServers) await d.stop();
  deadServers.length = 0;
  await helper?.stop();
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

test('真的合成过选区的那一张，库里记着；别的都不记', async () => {
  const w = 16;
  const h = 16;
  const gray = Buffer.alloc(w * h, 255);

  const withMask = await upload(makePng(w, h, [10, 20, 30]), gray, w, h);
  assert.equal(flagOf(withMask.id), 1, '带遮罩上传的要记上');

  // 同一张底图、不带遮罩上传 —— 字节不同（没有合成 alpha），是另一条记录
  const without = await upload(makePng(w, h, [10, 20, 30]), null, 0, 0);
  assert.notEqual(without.id, withMask.id, '前提：合成过 alpha 的字节和原图不是同一份');
  assert.equal(flagOf(without.id), 0, '没带遮罩就不能记');
});

test('天然带透明的图上传，不会被记成"带选区"', async () => {
  // 这是整条防线的关键：这张图有 alpha、也有可编辑区，
  // 但它从来没有经过选区合成。
  const rec = await upload(naturallyTransparentPng(16, 16), null, 0, 0);
  assert.equal(flagOf(rec.id), 0, '天然透明绝不能被当成选区');
});

test('去重命中时补记出处，不会因为"以前存过"就永远判成没选区', async () => {
  /*
   * 资产按 sha256 去重。同一份字节如果先以"没带遮罩"的身份进过库，
   * 之后用户重新捕获同样的选区，命中去重直接返回旧记录 ——
   * 出处标记就永远补不上，他会一直被判成"没有带上选区"，
   * 而他明明每次都圈了。
   */
  const w = 8;
  const h = 8;
  const gray = Buffer.alloc(w * h, 200);
  const composed = composeAlpha(makePng(w, h, [7, 8, 9]), gray, w, h);

  // 先以"普通图片"的身份进库
  const first = await upload(composed, null, 0, 0);
  assert.equal(flagOf(first.id), 0);

  // 再走真正的选区路径：底图 + 遮罩，合成出来的字节和上面完全一样
  const second = await upload(makePng(w, h, [7, 8, 9]), gray, w, h);
  assert.equal(second.id, first.id, '前提：字节一样，命中去重');
  assert.equal(flagOf(second.id), 1, '命中去重也要把出处补上');
});

test('补记只朝一个方向走：记过的不会被后来的普通上传抹掉', async () => {
  const w = 8;
  const h = 8;
  const gray = Buffer.alloc(w * h, 180);
  const withMask = await upload(makePng(w, h, [4, 5, 6]), gray, w, h);
  assert.equal(flagOf(withMask.id), 1);

  const again = await upload(composeAlpha(makePng(w, h, [4, 5, 6]), gray, w, h), null, 0, 0);
  assert.equal(again.id, withMask.id, '前提：还是同一份字节');
  assert.equal(flagOf(again.id), 1, '字节一样，"这份 alpha 是选区"这个事实不会因此变假');
});
