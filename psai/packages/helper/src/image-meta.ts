/**
 * 图像头解析：只读文件头拿宽高与类型，不引入 sharp 之类的原生依赖
 * （原生依赖会让 Node SEA 单文件打包无法进行）。
 */

export interface ImageMeta {
  mime: string;
  width: number;
  height: number;
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
  return { mime: 'image/png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
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
      return { mime: 'image/jpeg', height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
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
    return { mime: 'image/webp', width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  if (fmt === 'VP8L') {
    const bits = b.readUInt32LE(21);
    return { mime: 'image/webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (fmt === 'VP8X') {
    const w = b[24]! | (b[25]! << 8) | (b[26]! << 16);
    const h = b[27]! | (b[28]! << 8) | (b[29]! << 16);
    return { mime: 'image/webp', width: w + 1, height: h + 1 };
  }
  return null;
}
