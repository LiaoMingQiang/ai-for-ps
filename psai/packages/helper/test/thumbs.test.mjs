/**
 * 缩略图的回归测试。
 *
 * 这块是面板卡顿的根因所在：历史页一屏几十个 46×46 的小方块，
 * 以前每个都在拉原图，再由插件在 UXP 的 JS 线程上转 base64。
 * 实测这台机器的资产库平均 1.59MB、最大 15.4MB —— 一次渲染就是几百兆字符串。
 *
 * 所以这里要守住三件事：
 *   1. 真的缩小了（不然改了等于没改）
 *   2. 缩出来的图是对的（颜色没串、透明没糊）
 *   3. 缩不动的格式如实返回 null，让调用方回退成原图，而不是返回一张错的图
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';

import { thumbnailFor, THUMB_MAX_EDGE } from '../dist/thumbs.js';

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

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/**
 * 造一张 PNG。bitDepth 支持 8 和 16，颜色类型 2(RGB) / 6(RGBA)。
 * 内容是左半红、右半蓝，方便断言缩完之后颜色还在原来那一侧。
 */
function makePng(width, height, { bitDepth = 8, colorType = 2 } = {}) {
  const ch = colorType === 6 ? 4 : 3;
  const sb = bitDepth === 16 ? 2 : 1;
  const bpp = ch * sb;
  const raw = Buffer.alloc((width * bpp + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0; // 过滤器 0
    for (let x = 0; x < width; x++) {
      const left = x < width / 2;
      const rgba = [left ? 255 : 0, 0, left ? 0 : 255, 255];
      for (let c = 0; c < ch; c++) {
        if (sb === 2) {
          raw[o++] = rgba[c];
          raw[o++] = rgba[c];
        } else {
          raw[o++] = rgba[c];
        }
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/** 读缩略图的宽高和一个像素（缩略图一律是 8 位 RGBA）。 */
function readOut(png) {
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  return { width, height, bitDepth: png[24], colorType: png[25] };
}

function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'psai-thumbs-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('大图会被缩到最长边以内', () => {
  withTmp((dir) => {
    const src = join(dir, 'big.png');
    writeFileSync(src, makePng(2048, 3640));
    const t = thumbnailFor(src, join(dir, 'cache'), 'sha-big');
    assert.ok(t, '应该能缩');
    const out = readOut(t.bytes);
    assert.equal(Math.max(out.width, out.height), THUMB_MAX_EDGE, `最长边应为 ${THUMB_MAX_EDGE}，实际 ${out.width}x${out.height}`);
    // 长宽比要保住，不能拉变形
    assert.equal(out.width, Math.round((2048 / 3640) * THUMB_MAX_EDGE));
    assert.ok(t.bytes.length < 200 * 1024, `缩完还有 ${(t.bytes.length / 1024).toFixed(0)}KB，没起到作用`);
  });
});

test('16 位 PNG 也能缩 —— Photoshop 按文档位深导出，16 位 PSD 出来就是 16 位', () => {
  withTmp((dir) => {
    const src = join(dir, 'deep.png');
    writeFileSync(src, makePng(800, 600, { bitDepth: 16 }));
    const t = thumbnailFor(src, join(dir, 'cache'), 'sha-16');
    assert.ok(t, '16 位必须支持，否则真机上最常见的那种快照全都缩不动');
    const out = readOut(t.bytes);
    assert.equal(out.bitDepth, 8, '缩略图统一输出 8 位');
    assert.equal(out.colorType, 6, '缩略图统一输出 RGBA');
    assert.equal(Math.max(out.width, out.height), THUMB_MAX_EDGE);
  });
});

test('带透明通道的 PNG 缩完仍然带透明通道', () => {
  withTmp((dir) => {
    const src = join(dir, 'rgba.png');
    writeFileSync(src, makePng(600, 600, { colorType: 6 }));
    const t = thumbnailFor(src, join(dir, 'cache'), 'sha-rgba');
    assert.ok(t);
    assert.equal(readOut(t.bytes).colorType, 6);
  });
});

test('比上限还小的图不会被放大', () => {
  withTmp((dir) => {
    const src = join(dir, 'small.png');
    writeFileSync(src, makePng(64, 48));
    const t = thumbnailFor(src, join(dir, 'cache'), 'sha-small');
    assert.ok(t);
    const out = readOut(t.bytes);
    assert.equal(out.width, 64);
    assert.equal(out.height, 48);
  });
});

test('缩过一次就落盘缓存，第二次直接读文件', () => {
  withTmp((dir) => {
    const src = join(dir, 'c.png');
    const cache = join(dir, 'cache');
    writeFileSync(src, makePng(1200, 900));
    const first = thumbnailFor(src, cache, 'sha-cache');
    assert.ok(first);
    // 把源文件删掉：还能拿到结果就证明走的是缓存
    rmSync(src);
    const second = thumbnailFor(src, cache, 'sha-cache');
    assert.ok(second, '第二次应命中磁盘缓存');
    assert.deepEqual(second.bytes, first.bytes, '缓存内容应与首次一致');
  });
});

test('不是 PNG 就返回 null，让调用方回退成原图', () => {
  withTmp((dir) => {
    const src = join(dir, 'not.png');
    writeFileSync(src, Buffer.from('这不是 PNG，只是一段文本'));
    assert.equal(thumbnailFor(src, join(dir, 'cache'), 'sha-bad'), null, '解不动必须返回 null，不能返回一张错的图');
  });
});

test('隔行 PNG 不硬解，返回 null', () => {
  withTmp((dir) => {
    const png = makePng(200, 200);
    // 把 IHDR 的 interlace 字节改成 1
    png[28] = 1;
    const src = join(dir, 'inter.png');
    writeFileSync(src, png);
    assert.equal(thumbnailFor(src, join(dir, 'cache'), 'sha-inter'), null);
  });
});

test('缩完颜色没有串位 —— 左半仍是红、右半仍是蓝', () => {
  withTmp((dir) => {
    const src = join(dir, 'color.png');
    writeFileSync(src, makePng(1000, 1000));
    const t = thumbnailFor(src, join(dir, 'cache'), 'sha-color');
    assert.ok(t);
    // 解开缩略图（8 位 RGBA、过滤器全 0，直接读）
    const png = t.bytes;
    const w = png.readUInt32BE(16);
    const h = png.readUInt32BE(20);
    let pos = 8;
    const idat = [];
    while (pos + 8 <= png.length) {
      const len = png.readUInt32BE(pos);
      const type = png.toString('ascii', pos + 4, pos + 8);
      if (type === 'IDAT') idat.push(png.subarray(pos + 8, pos + 8 + len));
      if (type === 'IEND') break;
      pos += 12 + len;
    }
    const raw = inflateSync(Buffer.concat(idat));
    const px = (x, y) => {
      const i = y * (w * 4 + 1) + 1 + x * 4;
      return [raw[i], raw[i + 1], raw[i + 2]];
    };
    const mid = Math.floor(h / 2);
    const [lr, , lb] = px(Math.floor(w * 0.25), mid);
    const [rr, , rb] = px(Math.floor(w * 0.75), mid);
    assert.ok(lr > 200 && lb < 60, `左侧应为红色，实际 rgb(${lr},_,${lb})`);
    assert.ok(rb > 200 && rr < 60, `右侧应为蓝色，实际 rgb(${rr},_,${rb})`);
  });
});
