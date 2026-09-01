/**
 * 选区遮罩：合成与体检。
 *
 * ## 极性约定（这一段读错了，整个功能就是反的）
 *
 * 下游的约定写在 docs/RUNNINGHUB.md 和 PRD §7.5.2 里，只有一句话：
 * **「透明处即为要处理的区域」**。ComfyUI 的 `LoadImage` 输出 MASK 时
 * 做的正是 `1 - alpha`，RunningHub 那几条局部重绘/消除预设也照这个来。
 *
 * 所以：
 *
 * | 用户在 Photoshop 里 | 选区灰度 | 我们写进 PNG 的 alpha | 下游理解为 |
 * | --- | --- | --- | --- |
 * | 选中了（要改这里）   | 255 | **0**（透明） | 处理区 |
 * | 没选中（保持不动）   | 0   | **255**（不透明） | 保留区 |
 *
 * 也就是 `alpha = 255 - gray`。第一版写成了 `alpha = gray`，正好反过来 ——
 * 那会让每一次带遮罩的任务都去改**用户没选中**的那一半，
 * 而且不会有任何报错：出来的图看着"模型没听懂",实际是我们把选区传反了。
 *
 * 为了不再犯同一个错，这个文件里一律用「可编辑（editable）」说话，
 * 不用「选中」也不用裸的 alpha 数值 —— 那两个词在这条链路上正好相反。
 *
 * ## 为什么合成放在 Helper
 *
 * PNG 编解码这边已经有了（缩略图那一套），而且这一步能被自动化测试完整覆盖；
 * 插件跑在 UXP 里，两样都没有。
 */

import { decodePng, encodePngRgba } from './png.js';
import { PsaiError } from '@psai/shared';

/** alpha 低于这个值算「完全可编辑」。0 是完全透明 = 完全可编辑。 */
const EDITABLE_MAX = 8;
/** alpha 高于这个值算「完全保留」。255 是完全不透明 = 完全保留。 */
const KEEP_MIN = 247;

export interface MaskStats {
  width: number;
  height: number;
  /** 完全可编辑（alpha≈0）的像素占比 */
  editableRatio: number;
  /** 完全保留（alpha≈255）的像素占比 */
  keepRatio: number;
  /** 处在中间地带的像素占比 —— 羽化边缘就落在这里 */
  softRatio: number;
  /** 有任何可编辑成分（完全 + 部分）的像素占比 */
  anyEditableRatio: number;
}

/**
 * 量一遍遮罩。
 *
 * 只看"有没有 alpha 通道"是不够的：一张全不透明的 RGBA 图同样"有 alpha 通道"，
 * 而按上面的约定它表达的是「整张都保留」—— 下游什么都不会做。
 * 要判断的是**通道里有没有可编辑区**。
 */
export function analyzeAlpha(png: Buffer): MaskStats | null {
  const img = decodePng(png);
  if (!img) return null;
  let editable = 0;
  let keep = 0;
  let soft = 0;
  const total = img.width * img.height;
  for (let i = 3; i < img.rgba.length; i += 4) {
    const a = img.rgba[i]!;
    if (a < EDITABLE_MAX) editable++;
    else if (a > KEEP_MIN) keep++;
    else soft++;
  }
  return {
    width: img.width,
    height: img.height,
    editableRatio: editable / total,
    keepRatio: keep / total,
    softRatio: soft / total,
    anyEditableRatio: (editable + soft) / total
  };
}

export interface MaskCheck {
  ok: boolean;
  reason?: string;
  stats?: MaskStats;
}

/**
 * 这张图能不能当遮罩用。
 *
 * 判据只有一条：**得有可编辑的区域**。
 *
 * 这里第一版写错过，而且错得很有迷惑性：当时要求"既要有可编辑的、也要有保留的"，
 * 听起来很合理 —— 一个选区总该有里有外。可我们喂给下游的是**按选区外接矩形
 * 裁过**的图：用户拉一个普通的矩形选框，裁完之后整张图就正好是选区本身，
 * 一个"保留"像素都没有。那是最常见的用法，却会被判成不可用。
 *
 * 真正的失败只有一种：整张都不可编辑（alpha 全 255）。那说明选区没能传下来，
 * 下游会原样返回，用户等半天拿回一张没变的图。
 */
export function checkUsableMask(png: Buffer): MaskCheck {
  const stats = analyzeAlpha(png);
  if (!stats) return { ok: false, reason: '这张图解不开，无法确认它带不带可用的选区遮罩' };
  if (stats.anyEditableRatio === 0) {
    return {
      ok: false,
      reason:
        '遮罩里没有任何可编辑区域（整张都是不透明的保留区）—— 选区没能传下来，' +
        '下游不会改动任何地方。请在 Photoshop 里先建立选区再提交。',
      stats
    };
  }
  return { ok: true, stats };
}

/**
 * 把选区灰度合成进 RGB 图的 alpha 通道。
 *
 * @param rgbPng   按选区外接矩形裁出来的画面
 * @param maskGray Photoshop 的选区灰度：0 = 未选中，255 = 完全选中，中间值 = 羽化
 *
 * 注意入参是 **Photoshop 的极性**（255 = 选中），写出去的是**下游的极性**
 * （0 = 可编辑）。转换就在这里，只此一处 —— 见文件头那张表。
 *
 * 尺寸必须一模一样。对不上就报错而不是缩放对齐：那种情况说明上游算错了裁剪框，
 * 硬缩放只会把错误藏起来，让遮罩整体偏移几个像素，
 * 而偏移的后果（改错地方）比直接失败难查得多。
 */
export function composeAlpha(rgbPng: Buffer, maskGray: Buffer, maskWidth: number, maskHeight: number): Buffer {
  const img = decodePng(rgbPng);
  if (!img) throw new PsaiError('PHOTOSHOP_SELECTION_INVALID', '选区截图解不开，无法合成遮罩');
  if (img.width !== maskWidth || img.height !== maskHeight) {
    throw new PsaiError(
      'PHOTOSHOP_SELECTION_INVALID',
      `选区截图 ${img.width}×${img.height} 与遮罩 ${maskWidth}×${maskHeight} 尺寸不一致，无法合成`
    );
  }
  const need = maskWidth * maskHeight;
  if (maskGray.length < need) {
    throw new PsaiError(
      'PHOTOSHOP_SELECTION_INVALID',
      `遮罩数据只有 ${maskGray.length} 字节，${maskWidth}×${maskHeight} 需要 ${need} 字节`
    );
  }

  const out = Buffer.from(img.rgba);
  for (let i = 0; i < need; i++) {
    /*
     * 极性反转就在这一行：Photoshop 的"选中"= 下游的"可编辑"= alpha 0。
     *
     * 而且是**替换**原 alpha，不是相乘。语义是"这块要不要改"，
     * 不是"这块有多不透明"：源图层自带透明（抠好的人物）时相乘会让
     * 选中区里原本透明的地方变成不可编辑 —— 而用户明明把它们框进选区了。
     */
    out[i * 4 + 3] = 255 - maskGray[i]!;
  }
  return encodePngRgba(maskWidth, maskHeight, out);
}
