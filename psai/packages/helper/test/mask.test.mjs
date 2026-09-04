/**
 * 选区遮罩：极性、合成、体检。
 *
 * ## 极性是这一组的核心
 *
 * 下游的约定（docs/RUNNINGHUB.md、PRD §7.5.2）只有一句话：
 * **「透明处即为要处理的区域」**。ComfyUI 的 LoadImage 输出 MASK 时做的正是
 * `1 - alpha`，RunningHub 那几条局部重绘/消除预设也照这个来。
 *
 * 所以 `alpha = 255 - 选区灰度`：
 *   用户选中了（要改这里）→ 灰度 255 → alpha 0（透明）→ 下游的处理区
 *   用户没选中（保持不动）→ 灰度 0   → alpha 255（不透明）→ 下游的保留区
 *
 * 第一版写成了 `alpha = 灰度`，正好反过来 —— 每一次带遮罩的任务都会去改
 * **用户没选中**的那一半，而且不报任何错：出来的图看着像"模型没听懂"。
 * 下面每一条断言都用「可编辑 / 保留」说话，不用裸的 alpha 数值，
 * 因为那两个词在这条链路上正好相反，用错一次就又反了。
 *
 * ## 分工
 *
 * 这里测的是合成与判定，全部在 Node 里跑得动。
 * "Photoshop 那边取出来的灰度对不对"只能在 Photoshop 里验，
 * 见 docs/PHOTOSHOP_ACCEPTANCE.md —— 那部分**没有**跑过。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';

import { analyzeAlpha, checkUsableMask, composeAlpha } from '../dist/mask.js';
import { decodePng } from '../dist/png.js';

/* ---------------- 造图工具 ---------------- */

let CRC = null;
function crc32(buf) {
  if (!CRC) {
    CRC = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function rgbPng(w, h, rgb = [120, 130, 140]) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let o = 0;
  for (let y = 0; y < h; y++) {
    raw[o++] = 0;
    for (let x = 0; x < w; x++) {
      raw[o++] = rgb[0];
      raw[o++] = rgb[1];
      raw[o++] = rgb[2];
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ---------------- Photoshop 侧的选区灰度（255 = 选中） ---------------- */

/** 整块画布上的矩形选区。 */
function psRectSelection(w, h, r) {
  const g = Buffer.alloc(w * h, 0);
  for (let y = r.top; y < r.bottom; y++) for (let x = r.left; x < r.right; x++) g[y * w + x] = 255;
  return g;
}

/** 圆形 + 羽化，模拟套索圈一块再羽化 N 像素。 */
function psFeatheredCircle(w, h, radius, feather) {
  const g = Buffer.alloc(w * h, 0);
  const cx = w / 2;
  const cy = h / 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      let v;
      if (d <= radius - feather) v = 255;
      else if (d >= radius) v = 0;
      else v = Math.round(255 * (1 - (d - (radius - feather)) / feather));
      g[y * w + x] = v;
    }
  }
  return g;
}

/**
 * 按 bounds 裁一块灰度出来 —— 模拟 imaging.getSelection 带 sourceBounds 的行为。
 * 生产路径就是这样：画面按 bounds 裁，遮罩也按同一个 bounds 读。
 */
function cropGray(gray, w, b) {
  const cw = b.right - b.left;
  const ch = b.bottom - b.top;
  const out = Buffer.alloc(cw * ch);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) out[y * cw + x] = gray[(b.top + y) * w + (b.left + x)];
  return out;
}

/** 这个像素有多"可编辑"（下游会改这里）。alpha 越低越可编辑。 */
function editableAt(png, x, y) {
  const img = decodePng(png);
  return 255 - img.rgba[(y * img.width + x) * 4 + 3];
}

/* ==================== 极性 ==================== */

test('极性：用户选中的地方变成透明（下游的处理区）', () => {
  /*
   * 这一条要是反了，每次带遮罩的任务都会去改用户**没选**的那一半，
   * 而且不报任何错。它是整组测试里最要紧的一条。
   */
  const w = 16;
  const h = 16;
  const sel = { left: 4, top: 4, right: 12, bottom: 12 };
  const out = composeAlpha(rgbPng(w, h), psRectSelection(w, h, sel), w, h);

  assert.equal(editableAt(out, 8, 8), 255, '选中的地方必须完全可编辑（alpha 0）');
  assert.equal(editableAt(out, 1, 1), 0, '没选中的地方必须完全保留（alpha 255）');
});

test('极性：羽化的过渡方向也要对', () => {
  // 选区中心最该被改，边缘外最不该被改。方向反了的话曲线是倒过来的。
  const w = 64;
  const h = 64;
  const out = composeAlpha(rgbPng(w, h), psFeatheredCircle(w, h, 24, 8), w, h);

  const mid = h / 2;
  const samples = [];
  for (let x = 32; x < 60; x += 2) samples.push(editableAt(out, x, mid));
  assert.equal(samples[0], 255, '圆心方向应完全可编辑');
  assert.equal(samples[samples.length - 1], 0, '圆外应完全保留');
  for (let i = 1; i < samples.length; i++) {
    assert.ok(samples[i] <= samples[i - 1], `可编辑程度应随半径单调不增：${samples.join(',')}`);
  }
});

/* ==================== 生产路径：先裁再读 ==================== */

test('生产路径：硬矩形选区裁完之后整块都可编辑，且必须判为可用', () => {
  /*
   * 这是最常见的一种用法，而第一版的体检会把它判成不可用。
   *
   * 我们喂给下游的是**按选区外接矩形裁过**的图。用户拉一个普通矩形选框，
   * 裁完之后整张图就正好是选区本身 —— 一个"保留"像素都没有。
   * 当时的判据要求"既要有可编辑的、也要有保留的"，听起来合理，
   * 实际把最普通的用法拒之门外。
   */
  const w = 64;
  const h = 64;
  const b = { left: 10, top: 12, right: 42, bottom: 40 };
  const full = psRectSelection(w, h, b);

  const cw = b.right - b.left;
  const ch = b.bottom - b.top;
  const out = composeAlpha(rgbPng(cw, ch), cropGray(full, w, b), cw, ch);

  const s = analyzeAlpha(out);
  assert.equal(s.width, cw);
  assert.equal(s.height, ch);
  assert.equal(s.editableRatio, 1, '裁完之后整块都该是可编辑区');
  assert.equal(s.keepRatio, 0, '硬矩形裁完不该剩下保留区');

  const check = checkUsableMask(out);
  assert.equal(check.ok, true, `普通矩形选区必须可用：${check.reason}`);
});

test('生产路径：羽化圆形裁完之后，四角是保留区、中心可编辑', () => {
  const w = 64;
  const h = 64;
  const b = { left: 8, top: 8, right: 56, bottom: 56 };
  const full = psFeatheredCircle(w, h, 20, 6);
  const cw = b.right - b.left;
  const ch = b.bottom - b.top;
  const out = composeAlpha(rgbPng(cw, ch), cropGray(full, w, b), cw, ch);

  const s = analyzeAlpha(out);
  assert.ok(s.editableRatio > 0, '中心应有完全可编辑的区域');
  assert.ok(s.keepRatio > 0, '四角应有完全保留的区域');
  assert.ok(s.softRatio > 0.02, `羽化过渡带必须留下来，实际 ${(s.softRatio * 100).toFixed(1)}%`);
  assert.equal(checkUsableMask(out).ok, true);
});

test('生产路径：不规则形状逐像素还原，不做任何简化', () => {
  const w = 16;
  const h = 16;
  const g = Buffer.alloc(w * h, 0);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (x + y < 12) g[y * w + x] = 255;

  const out = composeAlpha(rgbPng(w, h), g, w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      assert.equal(editableAt(out, x, y), x + y < 12 ? 255 : 0, `(${x},${y}) 的可编辑状态不对`);
    }
  }
});

/* ==================== 体检 ==================== */

test('没有任何可编辑区的遮罩不可用 —— 选区没传下来', () => {
  /*
   * 这是唯一一种真正的失败：整张都是保留区，下游会原样返回，
   * 用户等半天拿回一张没变的图。
   */
  const out = composeAlpha(rgbPng(16, 16), Buffer.alloc(16 * 16, 0), 16, 16); // 灰度全 0 = 什么都没选
  const check = checkUsableMask(out);
  assert.equal(check.ok, false);
  assert.match(check.reason, /没有任何可编辑|不会改动/);
  assert.equal(check.stats.anyEditableRatio, 0);
});

test('整张都可编辑是**合法**的，不该被拦', () => {
  // 裁过之后的矩形选区就是这样；全选（Ctrl+A）也是这样。
  // 两者都是用户真实会做的事，下游也处理得了。
  const out = composeAlpha(rgbPng(16, 16), Buffer.alloc(16 * 16, 255), 16, 16);
  assert.equal(checkUsableMask(out).ok, true, '整张可编辑不是错误');
});

test('一张没有 alpha 通道的图，判定为不可用', () => {
  // 解码器把 RGB 补成 alpha=255，按约定那是"整张都保留"—— 下游什么都不会做
  const check = checkUsableMask(rgbPng(16, 16));
  assert.equal(check.ok, false);
  assert.match(check.reason, /没有任何可编辑/);
});

test('解不开的字节如实说解不开，不猜', () => {
  const check = checkUsableMask(Buffer.from('这不是 PNG'));
  assert.equal(check.ok, false);
  assert.match(check.reason, /解不开/);
  assert.equal(analyzeAlpha(Buffer.from('nope')), null);
});

/* ==================== 合成的其它约束 ==================== */

test('源图自带透明时，选区**替换** alpha 而不是相乘', () => {
  /*
   * 语义是"这块要不要改"，不是"这块有多不透明"。源图层本身带透明
   * （抠好的人物）时相乘会让选中区里原本透明的地方变成不可编辑 ——
   * 而用户明明把它们框进选区了。
   */
  const w = 8;
  const h = 8;
  const half = Buffer.alloc(w * h, 0);
  for (let y = 0; y < h; y++) for (let x = 4; x < w; x++) half[y * w + x] = 255;
  const withAlpha = composeAlpha(rgbPng(w, h), half, w, h);
  assert.equal(editableAt(withAlpha, 1, 1), 0, '前提：左半是保留区');

  const allSelected = Buffer.alloc(w * h, 255);
  const out = composeAlpha(withAlpha, allSelected, w, h);
  assert.equal(editableAt(out, 1, 1), 255, '全选中就该整张可编辑，不受原 alpha 影响');
});

test('尺寸对不上时报错，绝不缩放对齐', () => {
  // 硬缩放只会让遮罩整体偏几个像素 —— "改错了地方"比"直接失败"难查得多。
  // 断言看 details：PsaiError 的第二个参数是 details，message 是错误码的固定文案。
  const grab = (fn) => {
    try {
      fn();
      return null;
    } catch (e) {
      return e;
    }
  };
  const sizeErr = grab(() => composeAlpha(rgbPng(16, 16), Buffer.alloc(8 * 8, 255), 8, 8));
  assert.ok(sizeErr);
  assert.equal(sizeErr.code, 'PHOTOSHOP_SELECTION_INVALID');
  assert.match(sizeErr.details, /尺寸不一致/);

  const shortErr = grab(() => composeAlpha(rgbPng(16, 16), Buffer.alloc(10), 16, 16));
  assert.ok(shortErr);
  assert.match(shortErr.details, /字节/);
});

test('统计口径：三段占比加起来正好是 1', () => {
  const out = composeAlpha(rgbPng(40, 40), psFeatheredCircle(40, 40, 15, 5), 40, 40);
  const s = analyzeAlpha(out);
  assert.ok(Math.abs(s.editableRatio + s.keepRatio + s.softRatio - 1) < 1e-9);
  assert.ok(Math.abs(s.anyEditableRatio - (s.editableRatio + s.softRatio)) < 1e-9);
});

/* ==================== 走真实上传端点 ==================== */

import { startHelper } from '../dist/index.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test as t2, before, after } from 'node:test';
import { assertCleanLog } from './_log-assertions.mjs';

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
  const res = await fetch(`http://127.0.0.1:${PORT}/v1/assets`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: fd
  });
  return { status: res.status, json: await res.json() };
}

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'psai-mask-'));
  helper = await startHelper({ dataDir, port: 0, ephemeral: true });
  PORT = helper.port; // 不从 url 里抠：端口等于 80 时 URL 会规范化掉，Number('') === 0 → undici 报 bad port
  if (!Number.isInteger(PORT) || PORT <= 0) throw new Error(`Helper 端口不可用：${PORT}（url=${helper.url}）`);
  token = helper.issueToken();
  await helper.recovered;
});

after(async () => {
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

t2('上传时带遮罩：落库的那张图带着正确极性的 alpha', async () => {
  const w = 32;
  const h = 32;
  const { json } = await upload(rgbPng(w, h), psFeatheredCircle(w, h, 12, 4), w, h);
  assert.equal(json.ok, true, JSON.stringify(json));
  assert.equal(json.mask.ok, true, `体检应该通过：${json.mask?.reason}`);

  // 把落库的那张取回来，确认 alpha 是真的在里面 —— 不是接口说说而已
  const res = await fetch(`http://127.0.0.1:${PORT}/v1/assets/${json.assets[0].id}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const stored = Buffer.from(await res.arrayBuffer());
  const s = analyzeAlpha(stored);
  assert.ok(s.editableRatio > 0, '圆心应落成可编辑区');
  assert.ok(s.keepRatio > 0, '四角应落成保留区');
  assert.ok(s.softRatio > 0, '羽化过渡带要保留');
  // 极性再确认一次：中心可编辑、角落保留
  assert.equal(editableAt(stored, w / 2, h / 2), 255, '中心（选中）应完全可编辑');
  assert.equal(editableAt(stored, 0, 0), 0, '角落（未选中）应完全保留');
});

t2('不带遮罩时一切照旧，接口不会凭空多出一个 mask 字段', async () => {
  const { json } = await upload(rgbPng(16, 16), null, 0, 0);
  assert.equal(json.ok, true);
  assert.equal(json.mask, undefined, '没传遮罩就不该有体检结果');
});

t2('整块可编辑的遮罩（裁过的矩形选区）走完整条上传路径也判为可用', async () => {
  const w = 16;
  const h = 16;
  const { json } = await upload(rgbPng(w, h), Buffer.alloc(w * h, 255), w, h);
  assert.equal(json.ok, true);
  assert.equal(json.mask.ok, true, `裁过的矩形选区必须可用：${json.mask?.reason}`);
});

t2('什么都没选中的遮罩：上传成功，但如实带回"不可用"', async () => {
  /*
   * 不在这里拦死是有意的：拦不拦得住是**功能**说了算 ——
   * 局部重绘那一族没有可用遮罩就是废的，而普通图生图带不带都能跑。
   * 上传这一层只负责把事实测出来，判断留给知道用途的那一层。
   */
  const w = 16;
  const h = 16;
  const { json } = await upload(rgbPng(w, h), Buffer.alloc(w * h, 0), w, h);
  assert.equal(json.ok, true, '上传本身不该失败');
  assert.equal(json.mask.ok, false);
  assert.match(json.mask.reason, /没有任何可编辑/);
});

t2('遮罩尺寸对不上时，如实报错而不是悄悄缩放', async () => {
  const { status, json } = await upload(rgbPng(32, 32), Buffer.alloc(8 * 8, 255), 8, 8);
  assert.equal(json.ok, false);
  assert.equal(status, 400);
  assert.match(`${json.error.message}${json.error.details ?? ''}`, /尺寸不一致/);
});
