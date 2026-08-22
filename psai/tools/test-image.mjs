/**
 * 测试用图像工具。
 *
 * 纯色图作为生图输入几乎证明不了什么（进去一块红、出来还是一块红，
 * 管线断了也看不出来）。这里生成有结构的图，并提供像素差异度量，
 * 用来断言"模型确实动过这张图"，而不只是把它原样传回来。
 */

import { deflateSync, inflateSync } from 'node:zlib';

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ 0xffffffff;
}

function encodePng(width, height, rgbRows) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rgbRows)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/**
 * 生成一张有结构的测试图：渐变背景 + 一个圆 + 一个方块 + 网格线。
 * 这样的图过一遍扩散模型后会有明显变化，能真正验证管线。
 */
export function makeStructuredPng(width = 512, height = 512) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let o = 0;
  const cx = width * 0.35;
  const cy = height * 0.4;
  const r = Math.min(width, height) * 0.22;

  for (let y = 0; y < height; y++) {
    raw[o++] = 0;
    for (let x = 0; x < width; x++) {
      // 背景：左上到右下的渐变
      let R = Math.round(40 + (x / width) * 120);
      let G = Math.round(60 + (y / height) * 110);
      let B = Math.round(150 - (x / width) * 60);

      // 圆
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy < r * r) {
        R = 230;
        G = 90;
        B = 60;
      }

      // 方块
      if (x > width * 0.58 && x < width * 0.88 && y > height * 0.55 && y < height * 0.85) {
        R = 245;
        G = 220;
        B = 90;
      }

      // 网格线，给模型一些高频细节
      if (x % 64 === 0 || y % 64 === 0) {
        R = Math.min(255, R + 60);
        G = Math.min(255, G + 60);
        B = Math.min(255, B + 60);
      }

      raw[o++] = R;
      raw[o++] = G;
      raw[o++] = B;
    }
  }
  return encodePng(width, height, raw);
}

/** 解出 PNG 的像素（仅支持本工具生成的 8 位 truecolor，无交错）。 */
export function decodePng(buf) {
  if (buf.slice(1, 4).toString('ascii') !== 'PNG') throw new Error('不是 PNG');
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`暂不支持的 PNG 格式: bitDepth=${bitDepth} colorType=${colorType}`);
  }
  const channels = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * channels);

  // PNG 逐行 filter 还原
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let v = line[i];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = v & 0xff;
    }
    cur.copy(out, y * stride);
    prev = cur;
  }
  return { width, height, channels, data: out };
}

/**
 * 两张同尺寸图的平均通道差（0–255）。
 * 用来判断"输出到底有没有被模型改过"。
 */
export function meanAbsDiff(aBuf, bBuf) {
  const a = decodePng(aBuf);
  const b = decodePng(bBuf);
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`尺寸不一致：${a.width}×${a.height} vs ${b.width}×${b.height}`);
  }
  let sum = 0;
  let n = 0;
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      const ai = (y * a.width + x) * a.channels;
      const bi = (y * b.width + x) * b.channels;
      for (let c = 0; c < 3; c++) {
        sum += Math.abs(a.data[ai + c] - b.data[bi + c]);
        n++;
      }
    }
  }
  return sum / n;
}
