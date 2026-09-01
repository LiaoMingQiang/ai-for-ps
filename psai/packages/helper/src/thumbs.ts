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
import { decodePng, encodePngRgba } from './png.js';
import type { Decoded } from './png.js';

/** 缩略图最长边。46px 的框在 2x 屏上也够清楚，再大就是浪费。 */
export const THUMB_MAX_EDGE = 256;

/**
 * 结果预览用的中间档。
 *
 * 历史页那种 46×46 的小方块用 256 就够；但生成页的结果预览是要看清楚出图效果的，
 * 256 糊得没法判断。而另一头，直接上原图现在很危险 ——
 * 出图尺寸改成「跟随原图」之后，一张结果可能是 4000×3000 的 PNG，
 * 十几兆的字节在 UXP 的 JS 线程上转 base64 会把面板冻住好几秒。
 * 1280 长边既看得清，又只有原图的几十分之一。
 */
export const PREVIEW_MAX_EDGE = 1280;






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
