/**
 * 提交前对输入图的检查。
 *
 * 单独一个文件、只有类型导入 —— 这样它能被直接 import 进测试，
 * 不用把整个 UXP DOM 和 Photoshop 桥都搭起来。
 * 这些规则值得钉死，埋在 submit() 的闭包里就只能靠端到端点一遍。
 */

import type { WritebackMode } from '@psai/shared';
import type { PickedImage } from './imageinput.js';

export interface GuardMessage {
  title: string;
  detail: string;
}

/** 提交时能看到的当前文档。字段和 bridge 的 DocumentContext 对齐。 */
export interface TargetDocument {
  documentId: number;
  documentName: string;
  documentPath?: string;
  width?: number;
  height?: number;
}

/**
 * 这张输入图，和现在这份文档，是不是同一份。
 *
 * 只比 id 是不够的。Photoshop 的文档 id 在文档关掉之后会被回收：
 * 用户关掉 A、新建一份 B，B 完全可能拿到 A 的旧编号。
 * 那时候只比 id 会**放行** —— 然后 A 的内容被贴进 B 的文档，
 * 而 B 可能是另一个客户的稿子，两边都不报错。
 *
 * 判定顺序（都用取图那一刻记下来的值）：
 *   1. id 对不上 —— 肯定不是同一份
 *   2. 两边都有路径 —— 路径一致才算同一份（最硬的凭据）
 *   3. 只有一边有路径 —— 存盘状态变了（新建后另存 / 另存到别处），
 *      认不出来，按"不是同一份"处理
 *   4. 都没有路径（未存盘）—— 比文件名和画布尺寸
 */
function sameDocument(img: PickedImage, ctx: TargetDocument): boolean {
  if (img.sourceDocumentId !== ctx.documentId) return false;

  const was = img.sourceDocumentPath ?? '';
  const now = ctx.documentPath ?? '';
  if (was && now) return was === now;
  if (was || now) return false;

  // 都没存过盘：只能比文件名 + 画布尺寸。
  // 不如路径硬，但比只看一个会被回收的编号强得多。
  if (img.sourceDocumentName !== ctx.documentName) return false;
  if (img.sourceCanvasWidth != null && ctx.width != null && img.sourceCanvasWidth !== ctx.width) return false;
  if (img.sourceCanvasHeight != null && ctx.height != null && img.sourceCanvasHeight !== ctx.height) return false;
  return true;
}

/**
 * 输入图取自的文档，和现在要写回的文档，是不是同一个。
 *
 * 这两者很容易对不上，而且完全不需要用户做错什么：
 * 从 A 取了图，中间切到 B 看一眼，回来点「开始处理」——
 * 输入是 A 的内容，写回目标却被冻结成当前的 B。
 * 结果是 A 的图被贴进 B 的文档，而两边都不会报错，
 * 用户只会看到自己的文档里凭空多了一张不相干的图。
 *
 * @param mode 这次选的写回方式。assetOnly 压根不写文档，
 *   拿"输入图和当前文档对不上"去挡它是无中生有 ——
 *   而"没有打开的文档"恰恰是最常落到 assetOnly 的情形。
 *
 * 返回 null 表示可以提交。
 */
export function documentMismatch(
  images: PickedImage[],
  ctx: TargetDocument | null,
  mode?: WritebackMode
): GuardMessage | null {
  /*
   * assetOnly 不碰文档，没有"贴错地方"这回事。
   * 这一句必须排在最前面：后面几条查的都是"写回目标对不对"，
   * 而这个模式根本没有写回目标。
   */
  if (mode === 'assetOnly') return null;

  // 上传/粘贴来的图不属于任何文档，写回哪里都行
  const fromPs = images.filter((i) => i.sourceDocumentId !== null);
  if (fromPs.length === 0) return null;

  if (!ctx) {
    return {
      title: '没有打开的文档',
      detail: '输入图取自 Photoshop，但现在没有可写回的文档。请先打开原文档，或改用「仅存资产库」。'
    };
  }

  const foreign = fromPs.find((i) => !sameDocument(i, ctx));
  if (!foreign) return null;

  /*
   * 拦下来而不是自动改用原文档：那个文档可能已经关了，
   * 而且"我要写回哪里"是用户的意图，不该由我们替他猜。
   */
  const reused = foreign.sourceDocumentId === ctx.documentId;
  return {
    title: '输入图和当前文档对不上',
    detail: reused
      ? // 编号一样但不是同一份 —— 这种最容易让人以为是我们搞错了，要说破
        `这张图取自「${foreign.sourceDocumentName}」，那份文档已经关掉了，` +
        `${ctx.documentId} 号现在是「${ctx.documentName}」。` +
        '为免写进不相干的文档，请重新打开原文档，或者移除这张图重新取一次。'
      : `这张图取自「${foreign.sourceDocumentName}」，而现在打开的是「${ctx.documentName}」。` +
        '请切回原文档再提交，或者移除这张图重新取一次。'
  };
}
