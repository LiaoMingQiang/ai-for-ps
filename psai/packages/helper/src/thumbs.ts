/**
 * 缩略图。
 *
 * 面板上那个 46×46 的历史缩略图，以前是把**原图**整张发给插件，
 * 再由插件在 UXP 的 JS 线程上转成 base64 data URI。
 * 实测这台机器的资产库：141 张 PNG、平均 1.59MB、最大 15.4MB。
 * 历史页一次拉 200 条，等于在界面线程上生成两百多兆的 base64 字符串 ——
 * 面板卡顿、掉帧就是这么来的。
 *
 * 所以缩放要放在 Helper 这边做，而且只做一次、结果落盘缓存。
 *
 * 为什么自己写 PNG 编解码而不是拉个库：整个 Helper 要能被 Node SEA 打成单文件 exe，
 * 一旦引入带原生扩展的图像库（sharp 之类）就打不动了。这是项目一开始就定下的约束。
 * 好在需求很窄 —— 只要能把 8 位非隔行的 PNG 缩小，够用就行；
 * 遇到解不动的格式就如实回退成原图，不猜、不糊弄。
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';

/** 缩略图最长边。46px 的框在 2x 屏上也够清楚，再大就是浪费。 */
export const THUMB_MAX_EDGE = 256;

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

interface Decoded {
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
function decodePng(buf: Buffer): Decoded | null {
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

function encodePngRgba(width: number, height: number, rgba: Buffer): Buffer {
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

/**
 * 盒式降采样：每个目标像素取源图对应矩形区域的平均值。
 * 比最近邻好得多（缩到 1/10 时最近邻会糊成噪点），又比双三次简单。
 * alpha 要参与加权，否则透明区域的颜色会渗到边缘上。
 */
function downscale(src: Decoded, maxEdge: number): Decoded {
  const scale = Math.min(1, maxEdge / Math.max(src.width, src.height));
  const w = Math.max(1, Math.round(src.width * scale));
  const h = Math.max(1, Math.round(src.height * scale));
  if (w === src.width && h === src.height) return src;

  const dst = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor((y * src.height) / h);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * src.height) / h));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * src.width) / w);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * src.width) / w));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const p = (sy * src.width + sx) * 4;
          const al = src.rgba[p + 3]!;
          r += src.rgba[p]! * al;
          g += src.rgba[p + 1]! * al;
          b += src.rgba[p + 2]! * al;
          a += al;
          n++;
        }
      }
      const p = (y * w + x) * 4;
      if (a === 0) {
        dst[p] = 0;
        dst[p + 1] = 0;
        dst[p + 2] = 0;
        dst[p + 3] = 0;
      } else {
        dst[p] = Math.round(r / a);
        dst[p + 1] = Math.round(g / a);
        dst[p + 2] = Math.round(b / a);
        dst[p + 3] = Math.round(a / n);
      }
    }
  }
  return { width: w, height: h, rgba: dst };
}

/**
 * 取缩略图字节。
 *
 * 缩不了（不是 PNG、位深不对、隔行）就返回 null，让调用方回退成原图 ——
 * 宁可慢一点，也不能返回一张错的图。
 */
export function thumbnailFor(
  originalPath: string,
  cacheDir: string,
  sha256: string,
  maxEdge = THUMB_MAX_EDGE
): { bytes: Buffer; mime: string } | null {
  const key = createHash('sha256').update(`${sha256}:${maxEdge}`).digest('hex').slice(0, 24);
  const cached = join(cacheDir, `${key}.png`);
  if (existsSync(cached)) {
    return { bytes: readFileSync(cached), mime: 'image/png' };
  }

  let src: Decoded | null;
  try {
    src = decodePng(readFileSync(originalPath));
  } catch {
    return null;
  }
  if (!src) return null;

  const small = downscale(src, maxEdge);
  const bytes = encodePngRgba(small.width, small.height, small.rgba);
  try {
    mkdirSync(dirname(cached), { recursive: true });
    writeFileSync(cached, bytes);
  } catch {
    /* 缓存写不进去不影响这次返回 */
  }
  return { bytes, mime: 'image/png' };
}
