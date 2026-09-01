/**
 * PNG 编解码。
 *
 * 为什么是自己写的：整个 Helper 要能被 Node SEA 打成单文件 exe，
 * 一旦引入带原生扩展的图像库（sharp 之类）就打不动了 —— 这是项目一开始定下的约束。
 * 需求也确实很窄：解 8/16 位非隔行 PNG、编 8 位 RGBA，够用就行；
 * 遇到解不动的格式如实返回 null，让调用方回退，不猜、不糊弄。
 *
 * 从 thumbs.ts 抽出来是因为选区遮罩也要用同一套编解码。
 * 复制一份的话，以后修一个解码 bug 得记得改两处，而第二处一定会被忘掉。
 */

import { deflateSync, inflateSync } from 'node:zlib';

let CRC_TABLE: Int32Array | null = null;
function crc32(buf: Buffer): number {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface Decoded {
  width: number;
  height: number;
  /** 一律归一化成 RGBA，缩放逻辑就不用再分情况 */
  rgba: Buffer;
}

/** 每个颜色类型一个像素占几个通道。 */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/**
 * 解 PNG。支持 8 位和 16 位、非隔行；解不动就返回 null（调用方回退成原图）。
 * 调色板（颜色类型 3）不支持 —— 我们自己产出的和各家 Provider 返回的都不是调色板图。
 *
 * 16 位是必须支持的：Photoshop 会按文档的位深导出，源文档是 16 位/通道时
 * 快照 PNG 就是 16 位的（实测一张 2048×3640 的图有 15.4MB）。
 * 缩略图只要显示，取每个采样的高字节就够了。
 */
export function decodePng(buf: Buffer): Decoded | null {
  if (buf.length < 8 || buf.toString('ascii', 1, 4) !== 'PNG') return null;

  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat: Buffer[] = [];

  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8]!;
      colorType = data[9]!;
      interlace = data[12]!;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }

  if ((bitDepth !== 8 && bitDepth !== 16) || interlace !== 0) return null;
  const ch = CHANNELS[colorType];
  if (!ch || colorType === 3) return null;
  if (width <= 0 || height <= 0 || idat.length === 0) return null;

  const sampleBytes = bitDepth === 16 ? 2 : 1;
  const bpp = ch * sampleBytes;

  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch {
    return null;
  }

  const stride = width * bpp;
  if (raw.length < (stride + 1) * height) return null;

  // 逐行反过滤（PNG 的五种过滤器）
  const out = Buffer.alloc(stride * height);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)]!;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp]! : 0;
      const b = prev[i]!;
      const c = i >= bpp ? prev[i - bpp]! : 0;
      let v = line[i]!;
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

  // 统一转成 RGBA
  const rgba = Buffer.alloc(width * height * 4);
  // 16 位时每个采样占两字节、大端，取高字节即可（等价于除以 257 取整，显示上看不出差别）
  for (let i = 0, p = 0; i < width * height; i++, p += 4) {
    const s = i * bpp;
    if (colorType === 0) {
      const g = out[s]!;
      rgba[p] = g;
      rgba[p + 1] = g;
      rgba[p + 2] = g;
      rgba[p + 3] = 255;
    } else if (colorType === 4) {
      const g = out[s]!;
      rgba[p] = g;
      rgba[p + 1] = g;
      rgba[p + 2] = g;
      rgba[p + 3] = out[s + sampleBytes]!;
    } else if (colorType === 2) {
      rgba[p] = out[s]!;
      rgba[p + 1] = out[s + sampleBytes]!;
      rgba[p + 2] = out[s + sampleBytes * 2]!;
      rgba[p + 3] = 255;
    } else {
      rgba[p] = out[s]!;
      rgba[p + 1] = out[s + sampleBytes]!;
      rgba[p + 2] = out[s + sampleBytes * 2]!;
      rgba[p + 3] = out[s + sampleBytes * 3]!;
    }
  }
  return { width, height, rgba };
}

export function encodePngRgba(width: number, height: number, rgba: Buffer): Buffer {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // 过滤器 0：不过滤，缩略图这点体积无所谓
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}
