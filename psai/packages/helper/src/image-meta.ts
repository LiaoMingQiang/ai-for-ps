/**
 * 图像头解析：只读文件头拿宽高与类型，不引入 sharp 之类的原生依赖
 * （原生依赖会让 Node SEA 单文件打包无法进行）。
 */

export interface ImageMeta {
  mime: string;
  width: number;
  height: number;
  /**
   * 是否带 alpha 通道。
   * 局部重绘/消除这类云端工作流是靠 LoadImage 的 MASK 输出识别处理区域的，
   * 输入图没有 alpha 时整张图都会被当成待处理区域 —— 出来的图看着像"成功了"，
   * 其实和用户圈的选区毫无关系。所以要在提交前就能判断。
   */
  hasAlpha: boolean;
}

export function parseImageMeta(buf: Buffer): ImageMeta | null {
  return parsePng(buf) ?? parseJpeg(buf) ?? parseWebp(buf) ?? null;
}

function parsePng(b: Buffer): ImageMeta | null {
  if (b.length < 24) return null;
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) if (b[i] !== sig[i]) return null;
  // IHDR 紧跟在签名之后：长度(4) + 'IHDR'(4) + 宽(4) + 高(4)
  if (b.toString('ascii', 12, 16) !== 'IHDR') return null;
  // IHDR 数据段：宽(16) 高(20) 位深(24) 颜色类型(25)。
  // 颜色类型 4 = 灰度+alpha，6 = 真彩+alpha；3 是调色板，alpha 在可选的 tRNS 块里。
  const colorType = b[25];
  const hasAlpha = colorType === 4 || colorType === 6 || (colorType === 3 && hasTrns(b));
  return { mime: 'image/png', width: b.readUInt32BE(16), height: b.readUInt32BE(20), hasAlpha };
}

/** 调色板 PNG 的透明度放在 tRNS 块里，扫一遍块表即可（只看前若干块，不必读完整张图）。 */
function hasTrns(b: Buffer): boolean {
  let i = 8;
  while (i + 8 <= b.length) {
    const len = b.readUInt32BE(i);
    const type = b.toString('ascii', i + 4, i + 8);
    if (type === 'tRNS') return true;
    if (type === 'IDAT' || type === 'IEND') return false;
    i += 12 + len;
  }
  return false;
}

function parseJpeg(b: Buffer): ImageMeta | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = b[i + 1]!;
    // 填充字节
    if (marker === 0xff) {
      i++;
      continue;
    }
    // 无长度字段的标记
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = b.readUInt16BE(i + 2);
    // SOF0..SOF15，排除 DHT(c4) / JPG(c8) / DAC(cc)
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      // JPEG 没有 alpha 通道
      return { mime: 'image/jpeg', height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7), hasAlpha: false };
    }
    i += 2 + len;
  }
  return null;
}

function parseWebp(b: Buffer): ImageMeta | null {
  if (b.length < 30) return null;
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WEBP') return null;
  const fmt = b.toString('ascii', 12, 16);
  if (fmt === 'VP8 ') {
    // 帧头：3 字节 tag + 3 字节 sync code，然后 2+2 字节宽高（低 14 位）
    // 有损 VP8 不带 alpha（带 alpha 的会被包成 VP8X）
    return { mime: 'image/webp', width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff, hasAlpha: false };
  }
  if (fmt === 'VP8L') {
    const bits = b.readUInt32LE(21);
    // VP8L 头第 5 个字节的最高位之一是 alpha_is_used
    const hasAlpha = ((bits >>> 28) & 0x1) === 1;
    return { mime: 'image/webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, hasAlpha };
  }
  if (fmt === 'VP8X') {
    const w = b[24]! | (b[25]! << 8) | (b[26]! << 16);
    const h = b[27]! | (b[28]! << 8) | (b[29]! << 16);
    // VP8X 特性位第 4 位是 ALPHA
    const hasAlpha = ((b[20]! >> 4) & 0x1) === 1;
    return { mime: 'image/webp', width: w + 1, height: h + 1, hasAlpha };
  }
  return null;
}
