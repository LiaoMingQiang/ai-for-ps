/* image-meta: 纯 JS 图像尺寸解析 (PNG/JPEG/WebP/GIF 头解析, 零 native 依赖)
 * 替代 sharp 的最小必要能力 (sharp 变为可选依赖) */
export interface ImageMeta {
  width: number | null;
  height: number | null;
  format: string | null;
}

export function imageMeta(buf: Uint8Array): ImageMeta {
  /* PNG: IHDR 8-23 字节 */
  if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    return { width: dv.getUint32(16), height: dv.getUint32(20), format: "png" };
  }
  /* JPEG: SOF0/SOF2 marker 扫描 */
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { i += 2; continue; }
      if (marker === 0xd9 || marker === 0xda) break;
      const len = (buf[i + 2] << 8) | buf[i + 3];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: (buf[i + 7] << 8) | buf[i + 8], height: (buf[i + 5] << 8) | buf[i + 6], format: "jpeg" };
      }
      i += 2 + len;
    }
    return { width: null, height: null, format: "jpeg" };
  }
  /* WebP: VP8/VP8L/VP8X */
  const s = Buffer.from(buf).toString("latin1");
  if (buf.length > 30 && s.slice(0, 4) === "RIFF" && s.slice(8, 12) === "WEBP") {
    const tag = s.slice(12, 16);
    if (tag === "VP8X" && buf.length > 30) {
      const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      return { width: (dv.getUint32(24) & 0xffffff) + 1, height: (dv.getUint32(27) & 0xffffff) + 1, format: "webp" };
    }
    if (tag === "VP8L" && buf.length > 25) {
      const b = buf[21] | (buf[22] << 8) | (buf[23] << 16) | (buf[24] << 24);
      return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1, format: "webp" };
    }
    return { width: null, height: null, format: "webp" };
  }
  /* GIF */
  if (buf.length > 10 && s.slice(0, 3) === "GIF") {
    return { width: buf[6] | (buf[7] << 8), height: buf[8] | (buf[9] << 8), format: "gif" };
  }
  return { width: null, height: null, format: null };
}

export function mimeFromFormat(format: string | null): string {
  switch (format) {
    case "jpeg": return "image/jpeg";
    case "webp": return "image/webp";
    case "gif": return "image/gif";
    case "png": return "image/png";
    default: return "image/png";
  }
}
