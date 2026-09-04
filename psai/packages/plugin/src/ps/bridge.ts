/**
 * PhotoshopBridge：从 Photoshop 取图，把结果写回 Photoshop。
 *
 * 依据的 Adobe UXP 官方 API（PS 25.2 基线）：
 *   core.executeAsModal(fn, {commandName})       所有会改文档的操作都必须在里面跑
 *   Document.duplicate(name, mergeLayersOnly)    → Promise<Document>
 *   Document.mergeVisibleLayers()
 *   Document.saveAs.png(entry, opts?, asCopy)
 *   Document.close(SaveOptions.DONOTSAVECHANGES)
 *   Selection.bounds                              {left,top,right,bottom} 数字像素（PS 25+）
 *   Layer.scale(hPct, vPct, AnchorPosition) / translate(dx, dy)
 *   action.batchPlay placeEvent / open / crop / select   ScriptListener 动作格式
 *
 * 几条用血换来的规矩，改代码前先读：
 *   B-01 open 结果文件之后 activeDocument 是结果文档，绝不能拿它当目标 PSD；
 *        必须用任务冻结的 documentId 找回目标文档并显式激活
 *   B-02 选区原位不能假设置入位置在画布中心，要读置入后图层的真实 bounds 再算缩放平移
 *   B-03 缩放百分比必须钳制，极端值会把图层缩没
 *   B-04 选区原位用任务创建时记录的 selectionBounds，不读"当前选区"
 *   B-05 找文档/图层必须递归进组，嵌套组里的图层也要找得到
 */

import type { PhotoshopTarget, WritebackMode } from '@psai/shared';

/* ---------------- UXP / Photoshop 类型（只声明我们用到的部分） ---------------- */

interface PsBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface PsLayer {
  id: number;
  name: string;
  kind: string;
  visible: boolean;
  bounds?: PsBounds;
  layers?: PsLayer[];
  scale(h: number, v: number, anchor?: unknown): Promise<void>;
  translate(dx: number, dy: number): Promise<void>;
  /** 写回去重时用：把上一次写进去的同名图层删掉再放新的 */
  delete?(): Promise<void>;
}

interface PsSelection {
  bounds?: PsBounds;
}

interface PsDocument {
  id: number;
  name: string;
  path?: { nativePath: string } | null;
  width: number;
  height: number;
  mode?: unknown;
  bitsPerChannel?: number;
  layers: PsLayer[];
  activeLayers: PsLayer[];
  selection?: PsSelection;
  duplicate(name?: string, mergeLayersOnly?: boolean): Promise<PsDocument>;
  mergeVisibleLayers(): Promise<void>;
  /** 改色彩模式；降位深前要先确保是 RGB，否则某些模式下不允许改 */
  changeMode?(mode: unknown): Promise<void>;
  close(save?: unknown): Promise<void>;
  saveAs: { png(entry: unknown, opts?: unknown, asCopy?: boolean): Promise<void> };
}

interface PsApp {
  activeDocument: PsDocument | null;
  documents: PsDocument[];
}

interface PsCore {
  executeAsModal<T>(fn: (ctx: unknown) => Promise<T>, opts: { commandName: string }): Promise<T>;
}

interface PsAction {
  batchPlay(commands: unknown[], options: unknown): Promise<unknown[]>;
  addNotificationListener(events: string[], fn: () => void): void;
}

let app: PsApp | null = null;
let core: PsCore | null = null;
let action: PsAction | null = null;
let constants: Record<string, Record<string, unknown>> | null = null;
/**
 * photoshop.imaging —— 取选区灰度就靠它。
 *
 * getSelection 返回的是**带羽化的**选区数据：0 未选中、255 完全选中、
 * 中间值就是羽化过渡。这是唯一能把"用户到底选了什么形状"原样取出来的接口，
 * 别的路子（按外接矩形裁、存通道再读）要么丢羽化、要么要动用户的文档。
 */
let imaging: {
  getSelection(opts: {
    documentID: number;
    sourceBounds?: { left: number; top: number; right: number; bottom: number };
    componentSize?: number;
    colorSpace?: string;
  }): Promise<{
    imageData: PsImageData;
    /**
     * 接口**实际**取的那一块。
     *
     * 它未必等于我们请求的那一块：Photoshop 会把请求裁进画布，
     * 也可能按自己的对齐规则挪一挪。必须读它，不能拿请求的那份当结果 ——
     * 尺寸一样但位置差几个像素的话，遮罩会整体偏移，
     * 而"改错了地方"比"没有遮罩"难查得多。
     */
    sourceBounds?: { left: number; top: number; right: number; bottom: number };
  }>;
} | null = null;

/**
 * imaging 返回的像素块。字段照 UXP 的真实契约写，不是我们希望的样子。
 *
 * 几个必须当真的地方：
 *  · componentSize 可以是 8 / 16 / 32。16 位文档上 getData 返回的是
 *    Uint16Array，值域 0–65535；32 位是 Float32Array，值域 0–1。
 *  · getData 的返回类型跟着 componentSize 走，**不是**永远的 Uint8Array。
 *  · components 是通道数，chunky 布局下按它跨步取。
 *  · colorSpace / pixelFormat 对选区来说应该是灰度；
 *    拿到 RGB 说明取回来的根本不是选区。
 *  · 16 位默认走 Photoshop 的**缩减量程** 0–32768，不是 0–65535。
 *    要满量程必须在 getData 里显式要 `fullRange: true`。
 */
interface PsImageData {
  width: number;
  height: number;
  components: number;
  /** 每通道位宽：8 / 16 / 32 */
  componentSize?: number;
  colorSpace?: string;
  /** 'Grayscale' / 'RGB' / 'RGBA' …… 比 colorSpace 更具体 */
  pixelFormat?: string;
  getData(opts?: { chunky?: boolean; fullRange?: boolean }): Promise<Uint8Array | Uint16Array | Float32Array>;
  dispose(): void;
}

let localFileSystem: {
  getDataFolder(): Promise<{ createFile(name: string, opts?: unknown): Promise<unknown> }>;
  getFileForOpening(opts?: unknown): Promise<unknown>;
  createSessionToken(entry: unknown): string;
} | null = null;

let available = false;
let unavailableReason = '尚未初始化';

/* ---------------- 初始化 ---------------- */

export function initBridge(): { ok: boolean; reason: string | null; apiVersion: string | null } {
  try {
    const req = (globalThis as { require?: (m: string) => unknown }).require;
    if (!req) {
      available = false;
      unavailableReason = '当前不在 Photoshop 中运行（没有 require）';
      return { ok: false, reason: unavailableReason, apiVersion: null };
    }
    const photoshop = req('photoshop') as {
      app: PsApp;
      core: PsCore;
      action: PsAction;
      constants: Record<string, Record<string, unknown>>;
      imaging?: typeof imaging;
      apiVersion?: string;
    };
    const uxp = req('uxp') as { storage: { localFileSystem: typeof localFileSystem } };

    app = photoshop.app;
    core = photoshop.core;
    action = photoshop.action;
    constants = photoshop.constants;
    // imaging 是较新的 UXP 才有。取不到时选区捕获会退回外接矩形，
    // 并在快照上如实标出来 —— 不假装自己拿到了遮罩。
    imaging = photoshop.imaging ?? null;
    localFileSystem = uxp.storage.localFileSystem;

    available = !!(app && core && action);
    unavailableReason = available ? '' : 'Photoshop 模块加载不完整';
    return { ok: available, reason: available ? null : unavailableReason, apiVersion: photoshop.apiVersion ?? null };
  } catch (e) {
    available = false;
    unavailableReason = `当前不在 Photoshop 中运行：${e instanceof Error ? e.message : String(e)}`;
    return { ok: false, reason: unavailableReason, apiVersion: null };
  }
}

export function isAvailable(): boolean {
  return available;
}

export function reason(): string {
  return unavailableReason;
}

function requirePs(): void {
  if (!available) throw new BridgeError('PHOTOSHOP_NOT_AVAILABLE', unavailableReason);
}

export class BridgeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
  }
}

/* ---------------- 上下文 ---------------- */

export interface LayerInfo {
  id: number;
  name: string;
  kind: string;
}

export interface DocumentContext {
  documentId: number;
  documentName: string;
  documentPath: string;
  width: number;
  height: number;
  colorMode: string;
  bitDepth: number;
  activeLayers: LayerInfo[];
  hasSelection: boolean;
  selectionBounds: PsBounds | null;
}

function readContext(doc: PsDocument | null): DocumentContext | null {
  if (!doc) return null;
  let activeLayers: LayerInfo[] = [];
  try {
    activeLayers = (doc.activeLayers ?? []).map((l) => ({ id: l.id, name: l.name, kind: String(l.kind) }));
  } catch {
    /* 某些文档状态下读不到，尽力而为 */
  }
  let selectionBounds: PsBounds | null = null;
  try {
    const b = doc.selection?.bounds;
    if (b) {
      selectionBounds = {
        left: Math.round(b.left),
        top: Math.round(b.top),
        right: Math.round(b.right),
        bottom: Math.round(b.bottom)
      };
      // 空选区会给出零面积的 bounds
      if (selectionBounds.right <= selectionBounds.left || selectionBounds.bottom <= selectionBounds.top) {
        selectionBounds = null;
      }
    }
  } catch {
    /* 没有选区时读 bounds 会抛，属正常 */
  }
  return {
    documentId: doc.id,
    documentName: doc.name,
    documentPath: doc.path?.nativePath ?? '',
    width: Math.round(doc.width),
    height: Math.round(doc.height),
    colorMode: doc.mode ? String(doc.mode) : 'RGB',
    bitDepth: doc.bitsPerChannel ?? 8,
    activeLayers,
    hasSelection: !!selectionBounds,
    selectionBounds
  };
}

export function getContext(): DocumentContext | null {
  if (!available) return null;
  try {
    return readContext(app!.activeDocument);
  } catch {
    return null;
  }
}

/** 监听文档/选区变化，节流后回调。 */
export function watchContext(onChange: () => void, throttleMs = 200): void {
  if (!available) return;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const fire = (): void => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      onChange();
    }, throttleMs);
  };
  try {
    action!.addNotificationListener(
      ['select', 'open', 'close', 'make', 'delete', 'set', 'move', 'hide', 'show', 'historyStateChanged'],
      fire
    );
  } catch {
    /* 监听不上就退化为手动刷新 */
  }
}

/* ---------------- 捕获 ---------------- */

export interface Snapshot {
  /** PNG 字节 */
  bytes: ArrayBuffer;
  width: number;
  height: number;
  source: string;
  context: DocumentContext;
  /** 选区任务：捕获时的选区边界，写回时按它原位放回 */
  selectionBounds: PsBounds | null;
  /**
   * 选区灰度（0 未选中 / 255 完全选中 / 中间是羽化），与 bytes 同尺寸。
   *
   * 有它才谈得上"真正的选区"：外接矩形裁剪会把羽化和不规则形状一起丢掉，
   * 而下游的局部重绘工作流正是靠这份数据认"改哪里"的。
   * 取不到时为 null —— 那时候快照退化成矩形，调用方要如实告诉用户。
   */
  maskGray: Uint8Array | null;
  maskWidth: number;
  maskHeight: number;
  /**
   * 没拿到遮罩时，**为什么**没拿到。
   *
   * 只说"没有遮罩"是不够的：老版本没接口是环境限制，而接口报错、
   * 尺寸对不上是出了问题 —— 后者必须让用户看见，否则羽化和不规则形状
   * 会长期悄悄失效而没人知道。
   */
  maskUnavailable: string | null;
}

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function findLayerRecursive(container: { layers?: PsLayer[] }, id: number): PsLayer | null {
  return findLayerPath(container, id)?.layer ?? null;
}

/**
 * 找图层，**连同它的祖先组一起**返回。
 *
 * 只拿到图层本身是不够的：一个图层放在组里时，它显不显示是
 * 「自己 visible」和「每一层祖先组都 visible」的与。
 * 所以把某个嵌套图层设成 visible 之后，它照样可能不显示 ——
 * 而快照导出的是"看得见的东西"，于是导出来一张全透明的图，
 * 一路传到模型那里，用户拿回一张跟输入毫无关系的结果。
 */
function findLayerPath(
  container: { layers?: PsLayer[] },
  id: number,
  ancestors: PsLayer[] = []
): { layer: PsLayer; ancestors: PsLayer[] } | null {
  for (const l of container.layers ?? []) {
    if (l.id === id) return { layer: l, ancestors };
    if (l.layers?.length) {
      const hit = findLayerPath(l, id, [...ancestors, l]);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * 全部藏起来，同时**记下每一层原来是显示还是隐藏**。
 *
 * 记下来是为了组：选中一个组的时候，只把组本身打开是没用的 ——
 * 它里面的图层刚刚被这一趟全藏掉了，合并出来是一张全透明的图。
 * 要把组里那些**原本就显示**的还原回去，而原本隐藏的必须保持隐藏
 * （用户是特意关掉它们的，不能替他打开）。
 */
function hideAll(container: { layers?: PsLayer[] }, was = new Map<number, boolean>()): Map<number, boolean> {
  for (const l of container.layers ?? []) {
    was.set(l.id, l.visible !== false);
    try {
      l.visible = false;
    } catch {
      /* 锁定图层改不了可见性，跳过 */
    }
    if (l.layers?.length) hideAll(l, was);
  }
  return was;
}

/**
 * 把一个组里**原本可见**的那些子层重新打开。
 *
 * 只还原到原来的样子，不多开一个：用户在组里关掉的图层，
 * 他不希望它出现在结果里。
 */
function restoreSubtree(group: PsLayer, was: Map<number, boolean>): number {
  let shown = 0;
  for (const child of group.layers ?? []) {
    if (was.get(child.id) === false) continue; // 用户本来就关着它
    try {
      child.visible = true;
      shown++;
    } catch {
      /* 锁定图层改不了可见性，跳过 */
    }
    if (child.layers?.length) shown += restoreSubtree(child, was);
  }
  return shown;
}

async function readTempPng(folder: { createFile(name: string, opts?: unknown): Promise<unknown> }, doc: PsDocument): Promise<ArrayBuffer> {
  const file = (await folder.createFile(`psai_snap_${uid()}.png`, { overwrite: true })) as {
    read(opts: { format: unknown }): Promise<ArrayBuffer>;
    delete(): Promise<void>;
  };
  await doc.saveAs.png(file, {}, true);
  const fsFormats = ((globalThis as { require?: (m: string) => { storage?: { formats?: { binary?: unknown } } } }).require?.(
    'uxp'
  )?.storage?.formats ?? {}) as { binary?: unknown };
  const bytes = (await file.read({ format: fsFormats.binary })) as ArrayBuffer;
  try {
    await file.delete();
  } catch {
    /* 临时文件删不掉不影响主流程 */
  }
  return bytes;
}

/**
 * 通用捕获管线：复制文档 → 按需隐藏/合并/裁剪 → 存 PNG → 关闭副本。
 * 任何一步失败都要关掉副本，不留垃圾文档。
 */
async function captureWith(
  commandName: string,
  source: string,
  prepare: (copy: PsDocument, ctx: DocumentContext) => Promise<void>,
  cropBounds: PsBounds | null
): Promise<Snapshot> {
  requirePs();
  const srcDoc = app!.activeDocument;
  if (!srcDoc) throw new BridgeError('PHOTOSHOP_DOCUMENT_NOT_FOUND', '当前没有打开的文档');
  const ctx = readContext(srcDoc)!;

  return core!.executeAsModal(async () => {
    // duplicate 的第二个参数是 merge：传 true 会把副本拍平成一个合并图层。
    // 拍平之后原来的图层 id 就都不存在了，「当前图层」那条路径
    // 拿 id 去副本里找必然找不到，永远报「目标图层在快照副本中不可见」。
    //
    // 三条捕获路径其实都不需要它拍平：
    //   当前图层   —— 自己 hideAll 再单独打开要的那几层
    //   合并可见   —— 自己调 mergeVisibleLayers()
    //   当前选区   —— 同上，再按选区裁剪
    // 而且导出 PNG 本来就会把可见内容压平。所以这里一律不合并。
    const copy = await srcDoc.duplicate(`psai_snap_${uid()}`);
    try {
      await prepare(copy, ctx);

      if (cropBounds) {
        await action!.batchPlay(
          [
            {
              _obj: 'crop',
              bounds: {
                _obj: 'bounds',
                left: { _unit: 'pixels', _value: cropBounds.left },
                top: { _unit: 'pixels', _value: cropBounds.top },
                right: { _unit: 'pixels', _value: cropBounds.right },
                bottom: { _unit: 'pixels', _value: cropBounds.bottom }
              },
              angle: 0,
              delete: true
            }
          ],
          {}
        );
      }

      // 快照统一降到 8 位/通道再导出。
      //
      // Photoshop 是按文档位深导出 PNG 的：16 位/通道的 PSD 出来的快照是 16 位 PNG，
      // 实测一张 2048×3640 就有 15.4MB，正好是 8 位的两倍。
      // 而下游没有一个环节吃得到这多出来的一倍 —— ComfyUI、RunningHub、
      // 各家闭源模型全都在 8 位上工作，多出来的字节一路占着上传带宽、
      // 占着资产库、还要在面板上转成更长的 base64。
      // 这里降一次，整条链路都轻一半。
      try {
        if (Math.round(copy.bitsPerChannel ?? 8) > 8) {
          await copy.changeMode?.(constants!['ChangeMode']?.['RGB'] ?? 'RGB');
          copy.bitsPerChannel = 8;
        }
      } catch {
        // 降不了就照原样导出：宁可大一点，也不能因为这一步把整次捕获弄失败
      }

      /*
       * 导出之前先确认副本上真的有东西。
       *
       * 空图不会让任何一步报错，它会安安静静地一路传到模型那里 ——
       * 几分钟后用户拿回一张跟输入毫无关系的结果，而问题出在最开头。
       * 在这儿拦下来，代价是一次直方图查询。
       */
      if (!(await hasVisiblePixels(copy))) {
        throw new BridgeError(
          'PHOTOSHOP_LAYER_NOT_FOUND',
          '捕获到的是一张空图（目标图层可能在收起的组里、内容在画布外、或者选区落在空白处）。请检查后重试。'
        );
      }

      const folder = await localFileSystem!.getDataFolder();
      const bytes = await readTempPng(folder, copy);
      const width = Math.round(copy.width);
      const height = Math.round(copy.height);
      await copy.close(constants!['SaveOptions']!['DONOTSAVECHANGES']);
      return {
        bytes,
        width,
        height,
        source,
        context: ctx,
        selectionBounds: cropBounds,
        maskGray: null,
        maskWidth: 0,
        maskHeight: 0,
        maskUnavailable: null
      };
    } catch (e) {
      try {
        await copy.close(constants!['SaveOptions']!['DONOTSAVECHANGES']);
      } catch {
        /* 已经关掉了 */
      }
      throw e;
    }
  }, { commandName });
}

/**
 * 这份快照里有没有**实际内容**。
 *
 * 捕获路径上有好几种"成功地导出了一张空图"的走法：目标图层藏在收起的组里、
 * 图层内容在画布外、选区落在空白处。这些都不会报错 ——
 * 一张全透明的 PNG 会一路传到模型那里，几分钟后用户拿回一张
 * 跟他的输入毫无关系的结果，而他完全不知道问题出在最开头。
 *
 * 判据用的是合并之后那个图层的 **bounds**：没有像素的图层，bounds 是零面积。
 *
 * 一开始写的是查文档直方图，但那条判据有个真实的误伤：纯黑图层
 * （阴影层、蒙版底，都是常见用法）所有像素都落在 0 号桶，
 * 会被判成"空的"而拦下来 —— 而它明明有内容。
 * bounds 只关心"有没有像素"，不关心像素是什么颜色，不存在这个问题。
 */
async function hasVisiblePixels(doc: PsDocument): Promise<boolean> {
  try {
    const layers = doc.layers ?? [];
    if (layers.length === 0) return false;
    // 合并之后通常只剩一个图层；保险起见只要有**任意一个**非空就算有内容
    for (const l of layers) {
      const b = l.bounds;
      if (!b) return true; // 读不到 bounds 就别拦，宁可放行
      if (Math.round(b.right - b.left) > 0 && Math.round(b.bottom - b.top) > 0) return true;
    }
    return false;
  } catch {
    // 这一步只是个保险，不该由它决定整次捕获的成败
    return true;
  }
}

/** 当前活动图层（多选时合并所选） */
export async function captureActiveLayers(): Promise<Snapshot> {
  requirePs();
  const ctx = readContext(app!.activeDocument);
  if (!ctx || ctx.activeLayers.length === 0) {
    throw new BridgeError('PHOTOSHOP_LAYER_NOT_FOUND', '当前文档没有选中的图层');
  }
  const wantedIds = ctx.activeLayers.map((l) => l.id);

  return captureWith(
    'AI for PS: 捕获图层',
    ctx.activeLayers.length > 1 ? 'layers' : 'layer',
    async (copy) => {
      const was = hideAll(copy);
      let shown = 0;
      for (const id of wantedIds) {
        const found = findLayerPath(copy, id);
        if (!found) continue;
        try {
          /*
           * 祖先组也要一并打开。
           *
           * 图层显不显示 = 自己 visible && 每一层祖先组都 visible。
           * 只把图层本身设成 visible 的话，藏在收起的组里的图层照样不显示，
           * 而我们导出的是"看得见的东西"—— 结果是一张全透明的图
           * 一路传到模型那里，用户拿回一张跟输入毫无关系的结果，
           * 而且整条链路上没有一处报错。
           */
          for (const g of found.ancestors) g.visible = true;
          found.layer.visible = true;
          shown++;
        } catch {
          /* 锁定图层改不了可见性，跳过 —— 下面的 shown 会兜住 */
        }
        /*
         * 选中的是**组**的时候，光把组打开还是空的 ——
         * 它里面的图层刚刚被 hideAll 一起藏掉了。
         * 用户选中一个组，要的是这个组画出来的样子，
         * 所以要把组里原本可见的那些还原回去（原本隐藏的保持隐藏）。
         *
         * 不做这一步的话，导出的是一张全透明的图，一路传到模型那里，
         * 用户拿回一张跟他的图毫无关系的结果，而整条链路上没有一处报错。
         */
        if (found.layer.layers?.length) shown += restoreSubtree(found.layer, was);
      }
      if (shown === 0) throw new BridgeError('PHOTOSHOP_LAYER_NOT_FOUND', '目标图层在快照副本中不可见');
      await copy.mergeVisibleLayers();
    },
    null
  );
}

/** 合并可见 */
export async function captureMergedVisible(): Promise<Snapshot> {
  return captureWith(
    'AI for PS: 捕获合并可见',
    'mergedVisible',
    async (copy) => {
      await copy.mergeVisibleLayers();
    },
    null
  );
}

/**
 * 当前选区。
 *
 * 两步：按选区外接矩形裁出画面，再单独取一份**选区灰度**。
 *
 * 只做第一步的话（老代码就是这样），选区就退化成了一个矩形：
 * 羽化没了、不规则形状没了。用户特意羽化 20px 想要软边过渡，拿到的是硬边；
 * 用套索圈出来的人物，变成一个方框。而下游的局部重绘工作流
 * （Flux Fill 那一族）正是靠 alpha 认"改哪里"的 —— 给它一个全不透明的方块，
 * 它要么整张重画、要么什么都不改，两种结果用户都会以为是模型不行。
 *
 * 灰度数据交给 Helper 合成进 alpha 通道（那边有 PNG 编解码，也测得到）。
 */
export async function captureSelection(): Promise<Snapshot> {
  requirePs();
  const ctx = readContext(app!.activeDocument);
  if (!ctx?.selectionBounds) {
    throw new BridgeError('PHOTOSHOP_SELECTION_INVALID', '当前文档没有有效选区');
  }
  const bounds = ctx.selectionBounds;
  const snap = await captureWith(
    'AI for PS: 捕获选区',
    'selection',
    async (copy) => {
      await copy.mergeVisibleLayers();
    },
    bounds
  );

  const mask = await readSelectionMask(ctx.documentId, bounds);
  if (mask.kind === 'unsupported') {
    return { ...snap, maskUnavailable: '这个 Photoshop 版本没有选区遮罩接口' };
  }
  if (mask.kind === 'failed') {
    /*
     * 接口在、但这次读失败了 —— 这和"老版本没有这个接口"是两回事，
     * 不能混成同一种"退回矩形"。前者是环境限制，后者是**出了问题**：
     * 权限、并发、选区被别的操作改掉…… 都值得让用户看见，
     * 否则羽化和不规则形状会长期悄悄失效，而没有任何人知道。
     */
    return { ...snap, maskUnavailable: `读取选区遮罩失败：${mask.reason}` };
  }

  /*
   * 尺寸必须和裁出来的画面一致。
   *
   * 两边用的是**同一个** bounds：画面按它裁，遮罩按它读。所以正常情况下
   * 一定对得上；对不上说明 Photoshop 给的窗口和我们想的不一样，
   * 那是个需要知道的事实，不能当成"没遮罩"悄悄咽下去 ——
   * 硬缩放对齐更不行，遮罩整体偏几个像素之后"改错了地方"比"没有遮罩"难查得多。
   */
  if (mask.width !== snap.width || mask.height !== snap.height) {
    return {
      ...snap,
      maskUnavailable: `选区遮罩尺寸 ${mask.width}×${mask.height} 与截图 ${snap.width}×${snap.height} 对不上`
    };
  }
  return { ...snap, maskGray: mask.gray, maskWidth: mask.width, maskHeight: mask.height };
}

/** 读选区遮罩的三种结局。失败和"没有这个接口"必须分开。 */
type MaskRead =
  | { kind: 'ok'; gray: Uint8Array; width: number; height: number }
  | { kind: 'unsupported' }
  | { kind: 'failed'; reason: string };

/**
 * 读选区灰度。
 *
 * imaging.getSelection 给的就是带羽化的选区数据（0 未选中 / 255 完全选中）。
 *
 * 三种结局要分清楚，第一版把它们全揉成了"返回 null"：
 *   unsupported —— 老版本 UXP 根本没有这个接口，这是环境限制，如实降级
 *   failed      —— 接口在但这次失败了，那是**出了问题**，必须让用户看见
 *   ok          —— 拿到了
 * 混在一起的话，羽化和不规则形状可能长期悄悄失效，而没有任何人知道。
 */
async function readSelectionMask(documentId: number, bounds: PsBounds): Promise<MaskRead> {
  if (!imaging?.getSelection) return { kind: 'unsupported' };
  const wantW = bounds.right - bounds.left;
  const wantH = bounds.bottom - bounds.top;
  try {
    return await core!.executeAsModal(
      async () => {
        /*
         * 明确要 8 位灰度。
         *
         * 不要就得看文档的位深脸色：16 位文档给 Uint16Array（0–65535），
         * 32 位给 Float32Array（0–1）。老版本 UXP 不认这两个选项会忽略它们，
         * 所以下面照样按拿到的东西逐项核对 —— 这里只是先礼后兵。
         */
        const res = await imaging!.getSelection({
          documentID: documentId,
          sourceBounds: bounds,
          componentSize: 8,
          colorSpace: 'Grayscale'
        });
        const imageData = res?.imageData;
        if (!imageData) return { kind: 'failed', reason: '接口没有返回 imageData' } as MaskRead;
        try {
          /*
           * 先核**接口实际取的那一块**，再看像素。
           *
           * res.sourceBounds 未必等于我们请求的那一块：Photoshop 会把
           * 请求裁进画布，也可能按自己的对齐规则挪一挪。
           * 拿请求的那份当结果用的话，"尺寸一样但位置差几个像素"这种
           * 最坏的情况会完全看不出来 —— 遮罩整体偏移，
           * 模型在紧挨着选区的地方动手，而用户只会觉得模型不听话。
           */
          const boundsCheck = checkReturnedBounds(res.sourceBounds, bounds);
          if (boundsCheck) return { kind: 'failed', reason: boundsCheck } as MaskRead;

          return await decodeSelectionData(imageData, wantW, wantH);
        } finally {
          try {
            imageData.dispose();
          } catch {
            /* 释放失败不影响已经读出来的数据 */
          }
        }
      },
      { commandName: 'AI for PS: 读取选区遮罩' }
    );
  } catch (e) {
    return { kind: 'failed', reason: e instanceof Error ? e.message : String(e) };
  }
}

/** 一个矩形是不是四个整数、且非空。 */
function isSaneRect(r: unknown): r is PsBounds {
  if (!r || typeof r !== 'object') return false;
  const b = r as Partial<PsBounds>;
  return (
    Number.isInteger(b.left) &&
    Number.isInteger(b.top) &&
    Number.isInteger(b.right) &&
    Number.isInteger(b.bottom) &&
    (b.right as number) > (b.left as number) &&
    (b.bottom as number) > (b.top as number)
  );
}

function fmtRect(r: PsBounds): string {
  return `${r.left},${r.top}–${r.right},${r.bottom}`;
}

/**
 * 核对接口实际取的窗口。
 *
 * 要求**完全一致**，不只是尺寸一致。画面是按 `want` 裁的，遮罩必须
 * 描述同一块像素；位置差一点点就意味着遮罩整体偏移，
 * 而那种错法不会报错、也看不出来 —— 模型会在紧挨着选区的地方动手。
 *
 * @returns 有问题时返回原因，没问题返回 null
 */
function checkReturnedBounds(got: unknown, want: PsBounds): string | null {
  if (got === undefined || got === null) {
    /*
     * 老版本可能不返回这个字段。这时候只能退回"用尺寸核对"（在
     * decodeSelectionData 里做）—— 那道检查挡得住尺寸不符，
     * 但挡不住同样大小、位置不同的窗口。如实降级，不假装核过了。
     */
    return null;
  }
  if (!isSaneRect(got)) return `接口返回的 sourceBounds 不合法：${JSON.stringify(got)}`;
  if (got.left !== want.left || got.top !== want.top || got.right !== want.right || got.bottom !== want.bottom) {
    return `接口实际取的是 ${fmtRect(got)}，与截图用的 ${fmtRect(want)} 不一致`;
  }
  return null;
}

/**
 * 把 imaging 给的像素块解成 0–255 的选区灰度。
 *
 * 这里每一条检查都对应一种**会悄悄产出错误遮罩**的情况。遮罩错了不会报错，
 * 只会让模型改错地方 —— 而用户要等到花完钱、看到结果才发现，
 * 还会以为是模型不行。所以这里宁可如实说"读不到"（退回外接矩形，
 * 界面会明说），也不猜。
 */
async function decodeSelectionData(
  imageData: PsImageData,
  wantW: number,
  wantH: number
): Promise<MaskRead> {
  const w = imageData.width;
  const h = imageData.height;
  if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) {
    return { kind: 'failed', reason: `尺寸不合法：${w}×${h}` };
  }
  /*
   * 拿回来的窗口必须就是我们要的那一块。
   *
   * 画面和遮罩用的是**同一个** bounds，对不上就说明 Photoshop 给的
   * 窗口和我们想的不一样。硬缩放对齐是最坏的选择：遮罩整体偏几个像素之后，
   * "改错了地方"比"没有遮罩"难查得多。
   */
  if (w !== wantW || h !== wantH) {
    return { kind: 'failed', reason: `返回窗口 ${w}×${h} 与请求的 ${wantW}×${wantH} 不一致` };
  }

  /*
   * components 是通道数，必须是接口真的给了的那个数。
   *
   * 老代码写的是 `imageData.components || 1` —— 0 或 undefined 会被
   * 悄悄改成 1，然后按单通道跨步去读一份其实是多通道的数据，
   * 读出来的是一张错位的噪声图，而它长得很像一张"有内容的遮罩"。
   */
  const comps = imageData.components;
  if (!Number.isInteger(comps) || comps < 1 || comps > 4) {
    return { kind: 'failed', reason: `通道数不合法：${String(comps)}` };
  }

  /*
   * 选区是灰度的。拿到 RGB 说明取回来的根本不是选区
   * （或者接口忽略了 colorSpace 而返回了别的东西）——
   * 那时候"第 0 通道"是红色分量，不是选区强度。
   *
   * colorSpace 和 pixelFormat 两个都看：前者是色彩空间，
   * 后者更具体（'Grayscale' / 'RGB' / 'RGBA'）。哪个说了不是灰度都算数。
   */
  const cs = imageData.colorSpace;
  if (cs !== undefined && cs !== null && !/gray/i.test(String(cs))) {
    return { kind: 'failed', reason: `色彩空间是 ${String(cs)}，不是灰度 —— 取回来的不是选区数据` };
  }
  const pf = imageData.pixelFormat;
  if (pf !== undefined && pf !== null && !/gray/i.test(String(pf))) {
    return { kind: 'failed', reason: `像素格式是 ${String(pf)}，不是灰度 —— 取回来的不是选区数据` };
  }

  /*
   * chunky = 交错排列（RGBARGBA…）。下面的跨步取值就是按它写的，
   * 别让接口的默认值替我们做主。
   *
   * fullRange 必须显式要。Photoshop 的 16 位是**缩减量程** 0–32768，
   * 不是 0–65535 —— 这是它的历史约定，不是笔误。
   * 不要 fullRange 而按 65535 换算的话，每个值都会小一半：
   * 一张"完全选中"的遮罩会被读成"半选"，下游只做一半的活，
   * 而这既不报错也不容易看出来（结果就是"模型改得不够狠"）。
   */
  const raw = await imageData.getData({ chunky: true, fullRange: true });
  if (!raw || typeof raw.length !== 'number') {
    return { kind: 'failed', reason: 'getData 没有返回像素数据' };
  }

  const need = w * h * comps;
  if (raw.length < need) {
    return { kind: 'failed', reason: `数据长度 ${raw.length} 不足 ${w}×${h}×${comps} 所需的 ${need}` };
  }

  /*
   * 位深换算。这一段是这个函数存在的主要理由。
   *
   * 老代码直接 `gray[i] = raw[i * comps]`，而 gray 是 Uint8Array ——
   * 赋值是**按 256 取模**截断的，不是钳制。于是 16 位文档上
   * 一个 0x0100（约等于"几乎没选中"）会变成 0，0x8000（半选）也变成 0，
   * 整张遮罩变成一片对不上任何东西的噪声。而且不报错。
   *
   * 16 位按 65535 换算，前提是上面 getData 要了 `fullRange: true`。
   * 两处必须一起看：只改一边就会整体差一倍。
   *
   * 32 位是 Float32，值域 0–1；直接截断的话除了 1.0 之外全变成 0。
   *
   * 都钳制到 0–255：接口给出界的值（超出量程、浮点略大于 1）时，
   * 宁可饱和也不要绕回去 —— 绕回去会让"全选"变成"全不选"。
   */
  const clamp255 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
  const size = imageData.componentSize ?? 8;
  let scale: (v: number) => number;
  if (size === 8) scale = clamp255;
  else if (size === 16) scale = (v) => clamp255((v / 65535) * 255);
  else if (size === 32) scale = (v) => clamp255(v * 255);
  else return { kind: 'failed', reason: `不支持的位深 ${size}` };

  /*
   * 位深要和拿到的数组类型对得上。对不上说明我们理解错了这份数据的排布，
   * 那就不能按任何一种解释去读它。
   */
  const okType =
    (size === 8 && raw instanceof Uint8Array) ||
    (size === 16 && raw instanceof Uint16Array) ||
    (size === 32 && raw instanceof Float32Array);
  if (!okType) {
    return {
      kind: 'failed',
      reason: `位深 ${size} 与数据类型 ${raw.constructor?.name ?? '未知'} 对不上`
    };
  }

  const gray = new Uint8Array(w * h);
  if (size === 8 && comps === 1 && raw instanceof Uint8Array) {
    gray.set(raw.subarray(0, w * h)); // 最常见的那条路，省一遍逐点计算
  } else {
    for (let i = 0; i < w * h; i++) gray[i] = scale(raw[i * comps]!);
  }
  return { kind: 'ok', gray, width: w, height: h };
}

/** 从磁盘选一张图（走 UXP 文件选择，不用 input[type=file]） */
export async function pickImageFile(): Promise<{ bytes: ArrayBuffer; name: string } | null> {
  requirePs();
  const entry = (await localFileSystem!.getFileForOpening({
    types: ['png', 'jpg', 'jpeg', 'webp'],
    allowMultiple: false
  })) as { read(opts: { format: unknown }): Promise<ArrayBuffer>; name: string } | null;
  if (!entry) return null;
  const fsFormats = ((globalThis as { require?: (m: string) => { storage?: { formats?: { binary?: unknown } } } }).require?.(
    'uxp'
  )?.storage?.formats ?? {}) as { binary?: unknown };
  return { bytes: await entry.read({ format: fsFormats.binary }), name: entry.name };
}

/**
 * 从磁盘选一个文本文件（工作流 JSON）。
 *
 * 为什么要有它：ComfyUI 导出的图动辄几十 KB、上千行。让用户把这么一大坨
 * 粘进一个文本框，本身就是个别扭的做法 —— 粘贴容易漏、看不全、
 * 也没法确认到底进去了多少。直接读文件是这件事的正常做法。
 *
 * 走 UXP 的文件选择器而不是 input[type=file]：UXP 的 DOM 子集里
 * 那个控件不可用（它没有文件系统权限模型，选了也读不到内容）。
 *
 * 用 utf8 格式读：JSON 就是文本，按二进制读回来还得自己解码，
 * 而 ComfyUI 导出的文件里常有中文提示词，解错就是一堆乱码。
 */
export async function pickJsonFile(): Promise<{ text: string; name: string } | null> {
  requirePs();
  /*
   * 也收 txt / curl / 无扩展名。
   *
   * 除了 ComfyUI 导出的图，这个选择器还要接 RunningHub 的「请求示例」——
   * 用户从网页复制那段 curl 之后，粘进 UXP 的文本框会被截断（宿主行为，
   * 改不了），存成文件再选进来是唯一不经过剪贴板、也不用手打的路。
   * 存文件时扩展名是什么全看他随手怎么存，所以别只认 json。
   */
  const entry = (await localFileSystem!.getFileForOpening({
    types: ['json', 'txt', 'curl', 'sh', 'text', ''],
    allowMultiple: false
  })) as { read(opts?: { format?: unknown }): Promise<string>; name: string } | null;
  if (!entry) return null;
  const fsFormats = ((globalThis as { require?: (m: string) => { storage?: { formats?: { utf8?: unknown } } } }).require?.(
    'uxp'
  )?.storage?.formats ?? {}) as { utf8?: unknown };
  const text = await entry.read(fsFormats.utf8 === undefined ? undefined : { format: fsFormats.utf8 });
  return { text: String(text), name: entry.name };
}

/* ---------------- 写回前校验 ---------------- */

export interface ValidateResult {
  ok: boolean;
  code?: string;
  message?: string;
}

/**
 * 我们自己写进去的图层的**出处标记**。
 *
 * 为什么必须有这个东西：去重曾经是按**图层名**匹配的，
 * 而图层名是用户随手就能占用的。"AI 结果"这种默认名，
 * 用户自己建一个、或者从别的地方粘一个进来，太正常了 ——
 * 然后我们的下一次写回就把它删了。删的是用户的东西，
 * 而且没有任何提示，撤销栈里只会看到一次"删除图层"。
 *
 * 所以改成认这个标记：只有带着**我们写的、且属于同一次逻辑写回**的
 * 标记的图层才允许被替换。用户的图层没有这个标记，永远安全。
 *
 * 标记塞在图层名后面一个不显眼的括号里 —— UXP 没有给图层挂自定义元数据的
 * 稳定接口（XMP 那条路要走 batchPlay 且各版本行为不一），
 * 而图层名是唯一一个跨版本都能读写、又能跟着文档一起存盘的位置。
 * 代价是用户能看见它、也能改掉它；改掉之后我们就认不出来了，
 * 那时候宁可多留一个图层，也不会误删。
 */
const PROVENANCE_PREFIX = 'psai:';

export interface LayerProvenance {
  jobId: string;
  attemptId: string;
  assetId: string;
}

/**
 * 出处标记里 attemptId 只留前 8 位。
 *
 * 三个 id 全写全的话，图层名会变成一条一百多字符的天书 ——
 * 而用户是在图层面板里天天看着它的。attemptId 是随机 UUID，
 * 前 8 位在**一条任务的几次写回**这个范围内区分绰绰有余，
 * 而它要回答的正是这个范围内的问题：这个图层是哪一次写进来的。
 */
const ATTEMPT_ID_LEN = 8;

function shortAttempt(attemptId: string): string {
  return attemptId.slice(0, ATTEMPT_ID_LEN);
}

/**
 * 把出处编进图层名：`图层名 [psai:<jobId>/<assetId>@<attemptId 前 8 位>]`
 *
 * 三样都要在里面：
 *   jobId    —— 下一次同一条任务的写回靠它认出自己人
 *   assetId  —— 这个图层放的是哪一张结果（多图时不能只知道任务）
 *   attemptId—— 这一层是**哪一次**写回放进来的
 *
 * 最后这个不是可有可无的。出现两个同 jobId 图层的时候，
 * 光看 jobId 和 assetId 分不出"用户复制了一份"和"两次写回各放了一张"——
 * 而这两种情况该怎么处理完全不同。带上 attemptId 至少让这件事
 * 事后看得出来（图层面板里、诊断包里都看得到）。
 */
function stampName(layerName: string, p: LayerProvenance): string {
  return `${layerName} [${provenanceTag(p)}]`;
}

/**
 * 出处标记本身（不含图层名和方括号）。
 *
 * 落盘的意图记录里要存它：重启后靠它在文档里找**那一次**写回的证据。
 * 存标记而不是三个 id 分开存，是为了让"记下来的"和"写进图层名的"
 * 只有一个来源 —— 两边各拼一次的话，哪天格式改了就对不上了，
 * 而对不上的表现是"永远核不到证据"，一路退化成"不确定"。
 */
export function provenanceTag(p: LayerProvenance): string {
  return `${PROVENANCE_PREFIX}${p.jobId}/${p.assetId}@${shortAttempt(p.attemptId)}`;
}

/**
 * 从图层名里读回出处。不是我们写的就返回 null。
 *
 * `@attempt` 那一段是后加的，所以读的时候允许它不在 —— 用户文档里
 * 可能还留着旧版本写进去的图层，把它们判成"不是我们的"会让
 * 「再次写回」从替换变成叠加，一次升级就给所有人多一个图层。
 */
export function readProvenance(name: string): { jobId: string; assetId: string; attemptId: string | null } | null {
  // 用字符串切而不是正则：jobId / assetId 里都可能带正则元字符，
  // 拼进模式里会变成一个悄悄匹配错东西的表达式。
  const trimmed = name.trimEnd();
  if (!trimmed.endsWith(']')) return null;
  const start = trimmed.lastIndexOf(`[${PROVENANCE_PREFIX}`);
  if (start < 0) return null;
  const body = trimmed.slice(start + 1 + PROVENANCE_PREFIX.length, trimmed.length - 1);
  const slash = body.indexOf('/');
  if (slash <= 0 || slash === body.length - 1) return null;

  const jobId = body.slice(0, slash);
  const rest = body.slice(slash + 1);
  const at = rest.lastIndexOf('@');
  if (at < 0) return { jobId, assetId: rest, attemptId: null };
  if (at === 0) return null; // `@xxx` 前面没有 assetId，不是我们写的
  return { jobId, assetId: rest.slice(0, at), attemptId: rest.slice(at + 1) };
}

/**
 * 重启后去文档里找证据：那一次写回到底写进去没有。
 *
 * 三种结论，必须分清楚：
 *   found      —— 找到了带**那一次**标记的图层，写回确实成功了
 *   absent     —— 文档打得开、身份也对得上，但没有那个标记 ——
 *                  那次写回没有落地（或者落了又被撤销了）
 *   cannot-tell—— Photoshop 不在、文档没开、或者身份对不上。
 *                  这时候**什么都不知道**，不能猜。
 *
 * 最后一种是这个函数存在的理由。猜"成功"会让用户以为拿到了结果，
 * 其实没有；猜"失败"会让他去点重写，而文档里可能已经有一个了。
 * 唯一诚实的做法是承认不知道，并且**绝不自动再写一次**。
 */
export type ProvenanceProbe = 'found' | 'absent' | 'cannot-tell';

export function probeProvenance(
  target: { documentId: number; documentName: string; documentPath: string } | null,
  want: { jobId: string; assetId: string; attemptId: string }
): ProvenanceProbe {
  if (!available || !target) return 'cannot-tell';
  const resolved = resolveTargetDocument({
    documentId: target.documentId,
    documentName: target.documentName,
    documentPath: target.documentPath
  } as PhotoshopTarget);
  if ('code' in resolved) return 'cannot-tell';

  const wantAttempt = shortAttempt(want.attemptId);
  let hit = false;
  const walk = (c: { layers?: PsLayer[] }): void => {
    for (const l of c.layers ?? []) {
      const prov = readProvenance(l.name);
      if (prov && prov.jobId === want.jobId && prov.assetId === want.assetId && prov.attemptId === wantAttempt) {
        hit = true;
        return;
      }
      if (l.layers?.length) walk(l);
      if (hit) return;
    }
  };
  try {
    walk(resolved.doc);
  } catch {
    // 读图层树都读不了，等于什么都不知道
    return 'cannot-tell';
  }
  return hit ? 'found' : 'absent';
}

/**
 * 找上一次**我们自己**为这条任务写进去的图层。
 *
 * 只认出处标记里的 jobId：同一条任务的重复写回才算"同一次逻辑写回"，
 * 可以替换。不同任务哪怕用了同一个默认图层名，也各是各的，谁都不许动谁。
 *
 * 返回**全部**匹配而不是第一个：找到不止一个时说明情况和我们的模型对不上
 * （用户复制过我们的图层？手工改过标记？），那时候删哪一个都可能是错的 ——
 * 调用方会选择一个都不删。删错一个用户的图层，比多留一个图层严重得多。
 */
function findOwnedLayers(container: { layers?: PsLayer[] }, jobId: string, into: PsLayer[] = []): PsLayer[] {
  for (const l of container.layers ?? []) {
    const prov = readProvenance(l.name);
    if (prov && prov.jobId === jobId) into.push(l);
    if (l.layers?.length) findOwnedLayers(l, jobId, into);
  }
  return into;
}

function findDocumentById(id: number): PsDocument | null {
  try {
    for (const d of app!.documents) if (d.id === id) return d;
  } catch {
    /* noop */
  }
  return null;
}

/**
 * 按任务记录的目标找回那份文档，并**确认它确实是同一份**。
 *
 * 只按 id 找是不够的：Photoshop 的文档 id 在文档关掉之后会被回收，
 * 后面新开的文档拿到同一个号是完全可能的。那时候只看 id 的话，
 * 我们会把一张 AI 结果放进一份**毫无关系的文档**里 ——
 * 用户可能正在改另一个客户的稿子，而这次写回还会回报"成功"。
 *
 * 所以再核一次身份：存过盘的比路径（最硬的凭据），没存过的比文件名。
 * 对不上就明确拒绝，绝不"找个像的先写进去"。
 * 拒绝是可以补救的（换仅存资产库、或者重新捕获一次）；
 * 写进别人的文档不行。
 */
function resolveTargetDocument(target: PhotoshopTarget): { doc: PsDocument } | { code: string; message: string } {
  const doc = findDocumentById(target.documentId);
  if (!doc) {
    return {
      code: 'PHOTOSHOP_DOCUMENT_NOT_FOUND',
      message: `源文档「${target.documentName}」已关闭。结果已保留，重新打开该文档后可在历史页再次写回。`
    };
  }

  const nowPath = doc.path?.nativePath ?? '';
  const wantPath = target.documentPath ?? '';
  const samePath = !!wantPath && !!nowPath && nowPath === wantPath;
  const sameName = doc.name === target.documentName;

  /*
   * 认定"是同一份"的两条路：
   *   · 记录里有路径，而且现在这份文档的路径一模一样 —— 最硬
   *   · 记录里没有路径（当时没存过盘），那就只能比文件名
   *
   * 「记录里有路径、现在也有路径、但两者不同」是最危险的一种：
   * 要么 id 被另一份文档占用了，要么用户另存成了别的文件。
   * 两种都不该继续。
   */
  if (samePath || (!wantPath && sameName)) return { doc };

  return {
    code: 'WRITEBACK_TARGET_INVALID',
    message:
      `${target.documentId} 号文档现在是「${doc.name}」，不是任务记录的「${target.documentName}」——` +
      '源文档大概已经关掉，这个编号被另一份文档占用了。' +
      '为免写进不相干的文档，这次写回已中止。请重新打开原文档后在历史页再试，或改用「仅存资产库」。'
  };
}

/**
 * 写回前的安全校验（PRD §10.4）。
 *
 * 严格程度按**写回方式**分档，这一点很要紧：
 *
 *   inPlaceSelection —— 要把结果放回原来那块选区。画布尺寸变了就会错位，
 *                       源图层没了就找不到参照，所以两项都必须核。
 *   smartObject / pixelLayer —— 只是往文档里新建一个图层。画布改没改、
 *                       原来那些图层还在不在，都不影响这次放置。
 *
 * 老代码对三种方式一视同仁地严格：用户裁了一下画布，或者把源图层合并了，
 * 连"新建一个图层"都被拦下来，理由还是"自动写回可能错位"——
 * 可新建图层根本不存在错位这回事。结果他只能去历史页反复点，
 * 每次都被同一条不相干的理由挡回来。
 */
export function validateWritebackTarget(
  target: PhotoshopTarget | null | undefined,
  mode?: WritebackMode
): ValidateResult {
  /*
   * assetOnly 要排在**所有**前置检查之前，包括"Photoshop 在不在"和
   * "有没有目标文档"。
   *
   * 它压根不碰文档 —— 结果落资产库就完事了，既不需要 Photoshop，
   * 也不需要目标。放在后面的话，两种最常见的情况会被莫名其妙地挡住：
   * 提交时没有打开的文档（于是 target 是空的），和 Photoshop 崩过一次
   * （于是桥不可用）—— 而这两种恰恰是最该退到"仅存资产库"的情况。
   * 用户看到的是"无法写回：任务没有记录写回目标"，
   * 而他要的只是把图存下来。
   */
  if (mode === 'assetOnly') return { ok: true };

  if (!available) return { ok: false, code: 'PHOTOSHOP_NOT_AVAILABLE', message: unavailableReason };
  if (!target?.documentId) return { ok: false, code: 'WRITEBACK_TARGET_INVALID', message: '任务没有记录写回目标' };

  const resolved = resolveTargetDocument(target);
  if ('code' in resolved) return { ok: false, code: resolved.code, message: resolved.message };
  const doc = resolved.doc;

  // 下面两项只对"原位放回"有意义。新建图层不存在错位问题，
  // 拿它们去拦新建图层，等于用一条不相干的理由挡住一个安全的操作。
  const inPlace = mode === 'inPlaceSelection';
  if (!inPlace) return { ok: true };

  const w = Math.round(doc.width);
  const h = Math.round(doc.height);
  if (target.canvasWidth && target.canvasHeight && (w !== target.canvasWidth || h !== target.canvasHeight)) {
    return {
      ok: false,
      code: 'WRITEBACK_DOCUMENT_CHANGED',
      message:
        `画布尺寸已从 ${target.canvasWidth}×${target.canvasHeight} 变成 ${w}×${h}，原位写回会错位。` +
        '改用「智能对象图层」或「像素图层」可以直接放进去，位置由你自己调。'
    };
  }

  for (const id of target.sourceLayerIds ?? []) {
    if (!findLayerRecursive(doc, id)) {
      return {
        ok: false,
        code: 'PHOTOSHOP_LAYER_NOT_FOUND',
        message:
          '任务记录的源图层已不存在（含嵌套组内查找），原位写回失去了参照。' +
          '改用「智能对象图层」或「像素图层」仍然可以写回。'
      };
    }
  }
  return { ok: true };
}

/* ---------------- 写回 ---------------- */

async function writeTempResult(bytes: ArrayBuffer): Promise<{ token: string; entry: { delete(): Promise<void> } }> {
  const folder = await localFileSystem!.getDataFolder();
  const file = (await folder.createFile(`psai_result_${uid()}.png`, { overwrite: true })) as {
    write(data: ArrayBuffer, opts: { format: unknown }): Promise<void>;
    delete(): Promise<void>;
  };
  const fsFormats = ((globalThis as { require?: (m: string) => { storage?: { formats?: { binary?: unknown } } } }).require?.(
    'uxp'
  )?.storage?.formats ?? {}) as { binary?: unknown };
  await file.write(bytes, { format: fsFormats.binary });
  return { token: localFileSystem!.createSessionToken(file), entry: file };
}

async function activateDocument(doc: PsDocument): Promise<void> {
  await action!.batchPlay([{ _obj: 'select', _target: [{ _ref: 'document', _id: doc.id }] }], {});
}

/** 置入为智能对象。placeEvent 是 ScriptListener 动作格式，跨版本最稳。 */
/** 把这份文档里所有图层的 id 收集起来（含嵌套组）。置入前后对比用。 */
function collectLayerIds(container: { layers?: PsLayer[] }, into = new Set<number>()): Set<number> {
  for (const l of container.layers ?? []) {
    into.add(l.id);
    if (l.layers?.length) collectLayerIds(l, into);
  }
  return into;
}

/**
 * 确认 activeLayers[0] 真的是**这次新建**出来的那个图层。
 *
 * 这道检查不能省。placeEvent / paste 有可能什么都没做就返回（路径不对、
 * 剪贴板是空的、命令被别的东西吞了），而 Photoshop 不会为此报错 ——
 * 那时候 activeLayers[0] 是**用户原本选中的那个图层**。
 * 拿它当"刚置入的结果"往下走，接着就会给它改名（盖上我们的出处标记）、
 * 缩放、位移 —— 用户一个好好的图层被就地改掉，而我们汇报"写回成功"。
 */
/** 收集容器里所有图层（含嵌套组），按 id 索引。 */
function collectLayers(container: { layers?: PsLayer[] }, into = new Map<number, PsLayer>()): Map<number, PsLayer> {
  for (const l of container.layers ?? []) {
    into.set(l.id, l);
    if (l.layers?.length) collectLayers(l, into);
  }
  return into;
}

/**
 * 找出这次置入**真正新建**的那个图层。
 *
 * 判据是"置入前后整份文档的图层 id 集合之差"，不是 activeLayers[0]。
 * 两个理由，方向相反：
 *
 *  1. placeEvent / paste 可能什么都没做就返回（路径不对、剪贴板空了、
 *     命令被别的东西吞了），而 Photoshop 不报错。那时候 activeLayers[0]
 *     是**用户原本选中的那个图层** —— 拿它当结果往下走，
 *     我们会给用户一个好好的图层改名、缩放、位移，还汇报"写回成功"。
 *
 *  2. 反过来：图层建出来了，但**没有**被设成当前图层。
 *     只看 activeLayers[0] 的话我们会判"没有新建图层"然后报失败 ——
 *     而那个图层就留在用户文档里，谁也不知道它是哪来的。
 *     "报失败"的含义是文档没被动过、放心重试；留一个没人认领的图层
 *     会让用户重试一次多一个。
 *
 * 所以：以集合之差为准。恰好一个就是它；一个都没有才是真的没建；
 * 多于一个说明情况超出我们的理解 —— 那时候把它们全部撤掉再失败，
 * 绝不留下没人认领的东西。
 */
function takePlacedLayer(container: { layers?: PsLayer[] }, beforeIds: Set<number>, what: string): PsLayer {
  const after = collectLayers(container);
  const fresh: PsLayer[] = [];
  for (const [id, l] of after) if (!beforeIds.has(id)) fresh.push(l);

  if (fresh.length === 1) return fresh[0]!;

  if (fresh.length === 0) {
    const active = app!.activeDocument?.activeLayers?.[0];
    throw new BridgeError(
      'WRITEBACK_FAILED',
      `${what}没有新建图层` +
        (active ? `（当前选中的还是原来那个 #${active.id}）` : '') +
        ' —— 已中止，未改动文档'
    );
  }

  /*
   * 多于一个。优先认当前图层（Photoshop 正常置入后会把新图层设为当前），
   * 其余的当作意外产物撤掉 —— 留着就是没人认领的垃圾。
   */
  const active = app!.activeDocument?.activeLayers?.[0];
  const chosen = active && fresh.some((l) => l.id === active.id) ? active : null;
  if (chosen) {
    for (const l of fresh) {
      if (l.id !== chosen.id) void removeLayer(l);
    }
    log(`${what}产生了 ${fresh.length} 个新图层，已保留当前图层 #${chosen.id}，其余撤掉`);
    return chosen;
  }

  // 认不出该用哪一个：全部撤掉再失败，绝不留下没人认领的图层
  return failAndSweep(fresh, what);
}

/** 撤掉这些图层，然后抛错。撤不干净的话如实说"写了一半"。 */
function failAndSweep(layers: PsLayer[], what: string): never {
  const leftover: string[] = [];
  for (const l of layers) {
    // 同步版本：这里已经在模态块里，用不着等 —— 但删不掉要记下来
    try {
      if (typeof l.delete === 'function') void l.delete();
      else leftover.push(`#${l.id}`);
    } catch {
      leftover.push(`#${l.id}`);
    }
  }
  if (leftover.length > 0) {
    throw new BridgeError(
      'WRITEBACK_PARTIAL',
      `${what}产生了认不出归属的图层（${leftover.join('、')}），而且没能撤掉。请手动检查文档后再重试。`
    );
  }
  throw new BridgeError(
    'WRITEBACK_FAILED',
    `${what}产生了 ${layers.length} 个新图层，无法确定哪个是结果 —— 已全部撤销，文档回到动手之前`
  );
}

/**
 * 盖上出处标记，并**读回来确认盖住了**。
 *
 * 盖不上就必须失败：没有标记的图层，下一次写回认不出它是自己人，
 * 于是会在用户的文档里越堆越多；而如果我们此时还汇报成功，
 * 用户就更没有理由去检查。改名失败很少见，但"少见"不等于"可以假装没发生"。
 */
function stampProvenance(placed: PsLayer, layerName: string, prov: LayerProvenance): void {
  const want = stampName(layerName, prov);
  try {
    placed.name = want;
  } catch (e) {
    throw new BridgeError('WRITEBACK_FAILED', `无法给结果图层写入出处标记：${e instanceof Error ? e.message : String(e)}`);
  }
  /*
   * 三样都要核回来。
   *
   * 只核一两样的话，一个被截断的图层名（Photoshop 对图层名有长度上限）
   * 可能刚好保住前面那截、丢掉后面那截，而我们会当成写成功了 ——
   * 然后在一个其实认不全的标记上做替换决策。
   */
  const got = readProvenance(placed.name);
  if (
    !got ||
    got.jobId !== prov.jobId ||
    got.assetId !== prov.assetId ||
    got.attemptId !== shortAttempt(prov.attemptId)
  ) {
    throw new BridgeError(
      'WRITEBACK_FAILED',
      `结果图层的出处标记没写全（读回来的是「${placed.name}」）—— 下次写回将无法识别它`
    );
  }
}

async function placeSmartObject(token: string, beforeIds: Set<number>): Promise<PsLayer> {
  await action!.batchPlay(
    [
      {
        _obj: 'placeEvent',
        null: { _path: token, _kind: 'local' },
        freeTransformCenterState: { _enum: 'quadCenterState', _value: 'QCSAverage' },
        offset: { _obj: 'offset', horizontal: { _unit: 'pixels', _value: 0 }, vertical: { _unit: 'pixels', _value: 0 } }
      }
    ],
    {}
  );
  return takePlacedLayer(app!.activeDocument!, beforeIds, 'placeEvent');
}

/**
 * 置入为像素图层。
 * B-01：open 之后 activeDocument 是结果文档，必须显式切回目标文档再粘贴。
 */
async function placePixelLayer(token: string, beforeIds: Set<number>, targetDocId: number): Promise<PsLayer> {
  await action!.batchPlay([{ _obj: 'open', null: { _path: token, _kind: 'local' } }], {});
  const openedId = app!.activeDocument?.id ?? null;
  try {
    await action!.batchPlay([{ _obj: 'selectAll' }, { _obj: 'copyEvent' }], {});

    const target = findDocumentById(targetDocId);
    if (!target) {
      throw new BridgeError(
        'PHOTOSHOP_DOCUMENT_NOT_FOUND',
        '源文档已关闭，结果保留在资产库，可稍后重新写回'
      );
    }
    await activateDocument(target);
    await action!.batchPlay([{ _obj: 'paste' }], {});

    return takePlacedLayer(app!.activeDocument!, beforeIds, '粘贴');
  } finally {
    if (openedId !== null) {
      const tmp = findDocumentById(openedId);
      if (tmp && tmp.id !== targetDocId) {
        try {
          await tmp.close(constants!['SaveOptions']!['DONOTSAVECHANGES']);
        } catch {
          /* noop */
        }
      }
    }
  }
}

/**
 * 把置入的图层对齐到原选区。
 * B-02：读真实 bounds 再算，不假设置入在画布中心。
 * B-03：缩放百分比钳制。
 */
async function fitToSelection(placed: PsLayer, bounds: PsBounds): Promise<void> {
  const targetW = Math.max(1, bounds.right - bounds.left);
  const targetH = Math.max(1, bounds.bottom - bounds.top);

  const readBounds = (): PsBounds | null => {
    try {
      const b = placed.bounds;
      if (!b) return null;
      return {
        left: Math.round(b.left),
        top: Math.round(b.top),
        right: Math.round(b.right),
        bottom: Math.round(b.bottom)
      };
    } catch {
      return null;
    }
  };

  const actual = readBounds();
  if (!actual) return;

  const actualW = Math.max(1, actual.right - actual.left);
  const actualH = Math.max(1, actual.bottom - actual.top);
  const sx = Math.min(4000, Math.max(0.1, (targetW / actualW) * 100));
  const sy = Math.min(4000, Math.max(0.1, (targetH / actualH) * 100));

  if (Math.abs(sx - 100) > 0.01 || Math.abs(sy - 100) > 0.01) {
    try {
      await placed.scale(sx, sy, constants!['AnchorPosition']!['TOPLEFT']);
    } catch {
      /* 缩放失败就保持原位，总比不写回好 */
    }
  }

  const after = readBounds();
  if (after) {
    const dx = Math.round(bounds.left - after.left);
    const dy = Math.round(bounds.top - after.top);
    if (dx !== 0 || dy !== 0) {
      try {
        await placed.translate(dx, dy);
      } catch {
        /* noop */
      }
    }
  }
}

/**
 * 删掉一个图层，如实返回删没删掉。
 *
 * 吞掉异常是有意的：调用方要根据"删没删成"决定后面怎么说，
 * 而不是让一次清理失败把整个流程炸掉。
 */
async function removeLayer(l: PsLayer): Promise<boolean> {
  try {
    if (typeof l.delete !== 'function') return false;
    await l.delete();
    return true;
  } catch {
    return false;
  }
}

/** 桥这一层没有 Logger，出问题时至少留在控制台上。 */
function log(msg: string): void {
  try {
    console.warn(`[psai/bridge] ${msg}`);
  } catch {
    /* noop */
  }
}

/**
 * 原位写回之后核对一遍落点。
 *
 * scale / translate 都可能悄悄失败或者只做了一半（图层被锁、变换被限制…），
 * 而它们不抛错。不核对的话我们会汇报"已写回选区原位"，
 * 而那张图实际歪在别的地方 —— 用户得自己发现，然后手动挪回去。
 * 报告成功却明显放错位置，比直接说失败糟糕得多。
 */
async function verifyPlacedBounds(placed: PsLayer, want: PsBounds): Promise<void> {
  const got = placed.bounds;
  if (!got) {
    throw new BridgeError('WRITEBACK_FAILED', '置入之后读不到图层边界，无法确认结果放对了位置');
  }
  // 容差 2px：Photoshop 的变换会有取整误差，但真放错位不会只差 2px
  const tol = 2;
  const off =
    Math.abs(got.left - want.left) > tol ||
    Math.abs(got.top - want.top) > tol ||
    Math.abs(got.right - want.right) > tol ||
    Math.abs(got.bottom - want.bottom) > tol;
  if (off) {
    throw new BridgeError(
      'WRITEBACK_FAILED',
      `原位写回没有落在选区上：期望 ${want.left},${want.top},${want.right},${want.bottom}，` +
        `实际 ${Math.round(got.left)},${Math.round(got.top)},${Math.round(got.right)},${Math.round(got.bottom)}`
    );
  }
}

export interface WritebackResult {
  ok: boolean;
  detail: string;
  code?: string;
}

/** 把结果写回 Photoshop。调用前必须先跑 validateWritebackTarget。 */
export async function writeback(opts: {
  bytes: ArrayBuffer;
  mode: WritebackMode;
  layerName: string;
  /** assetOnly 不需要目标；其余方式没有目标就写不了，会在动文档之前被拒 */
  target?: PhotoshopTarget | null;
  /** 出处：写进图层名里，下一次同一条任务的写回靠它认出自己人 */
  provenance: LayerProvenance;
  /** 这个功能允许的写回方式。传了就据此校验，挡住越权的模式 */
  allowedModes?: WritebackMode[];
}): Promise<WritebackResult> {
  /*
   * assetOnly 排在最前面，而且**不看 Photoshop 在不在**。
   *
   * 它压根不碰文档 —— 结果落资产库就完事了。把它挡在
   * "Photoshop 不可用"后面的话，浏览器预览、Photoshop 崩过一次之后，
   * 一个本来必定成功的操作会报失败，而用户完全不知道为什么。
   */
  if (opts.mode === 'assetOnly') {
    // 说清楚是"按设置"还是"没有可写回的目标"—— 后者用户会跑去设置页
    // 翻半天，而真正的原因是提交时没有打开的文档。
    return {
      ok: true,
      detail: opts.target?.documentId
        ? '按设置「仅存资产库」保存，未写回文档'
        : '没有可写回的 Photoshop 文档，结果已存入资产库（可在历史页写回）'
    };
  }

  if (!available) return { ok: false, code: 'PHOTOSHOP_NOT_AVAILABLE', detail: unavailableReason };

  /*
   * 到这里就一定要动文档了，没有目标是走不下去的。
   * 这句放在 assetOnly 之后，是为了让"没有目标"只挡住真正需要目标的那几种。
   */
  const wbTarget = opts.target;
  if (!wbTarget?.documentId) {
    return { ok: false, code: 'WRITEBACK_TARGET_INVALID', detail: '该任务没有记录 Photoshop 目标' };
  }

  /*
   * 越权的写回方式要挡在**动文档之前**。
   *
   * 功能自己声明了允许哪几种（比如「文生图」没有"选区原位"这一项）。
   * 不校验的话，一个手写的请求就能让我们去做一件这个功能根本不支持的事，
   * 而失败会发生在半路 —— 那时候文档已经被改过了。
   */
  if (opts.allowedModes && !opts.allowedModes.includes(opts.mode)) {
    return {
      ok: false,
      code: 'WRITEBACK_TARGET_INVALID',
      detail: `这个功能不支持「${opts.mode}」写回方式（允许：${opts.allowedModes.join(' / ')}）`
    };
  }

  /*
   * 原位写回必须有冻结下来的选区，**这一条也要在动文档之前查**。
   *
   * 老代码把它放在置入之后：图已经进了文档，才发现没有选区可对齐，
   * 于是抛错 —— 而那张图还留在用户的文档里，位置是随便放的。
   * 用户看到的是"写回失败"加上一个凭空出现、还放错地方的图层。
   */
  if (opts.mode === 'inPlaceSelection' && !wbTarget.selectionBounds) {
    return {
      ok: false,
      code: 'WRITEBACK_TARGET_INVALID',
      detail: '该任务没有记录选区，无法原位写回。请改用「智能对象图层」或「像素图层」。'
    };
  }

  const check = validateWritebackTarget(wbTarget, opts.mode);
  if (!check.ok) return { ok: false, code: check.code!, detail: check.message! };

  const provenance = opts.provenance;

  let temp: { token: string; entry: { delete(): Promise<void> } } | null = null;
  try {
    temp = await writeTempResult(opts.bytes);
    const token = temp.token;

    await core!.executeAsModal(async () => {
      /*
       * 动手之前再认一次文档。
       *
       * 前面 validateWritebackTarget 已经认过一遍，但那之后还隔着
       * 排队、取字节、写临时文件 —— 这段时间用户完全可能把源文档关掉，
       * 而那个编号会被下一份新建文档接手。这里必须重认，
       * 不能只按 id 拿一个回来就往里写。
       */
      const resolved = resolveTargetDocument(wbTarget);
      if ('code' in resolved) throw new BridgeError(resolved.code, resolved.message);
      const target = resolved.doc;
      await activateDocument(target);

      /*
       * 「再次写回」是明确支持的动作，所以要替换掉上一次的那个图层 ——
       * 否则点三次就有三个一模一样的图层叠在一起，从面板上看不出哪个是最新的。
       *
       * 整段的顺序是：记下现状 → 放新的 → 证明它是新的 → 变换 → 核对落点
       * → 盖出处标记 → **最后**才删前任。任何一步失败都把刚放进去的那个撤掉，
       * 让文档回到动手之前的样子。
       *
       * 反过来（先删后放）的话，只要置入那一步失败，用户就同时失去了
       * 旧结果和新结果 —— 而他什么都没做错，只是 Photoshop 那一刻不高兴。
       * "操作失败还顺手毁掉已有成果"是最不能接受的一类。
       */
      const previous = findOwnedLayers(target, provenance.jobId);
      const beforeIds = collectLayerIds(target);

      let placed: PsLayer;
      if (opts.mode === 'pixelLayer') {
        placed = await placePixelLayer(token, beforeIds, wbTarget.documentId);
      } else {
        placed = await placeSmartObject(token, beforeIds);
      }

      /*
       * 从这里开始，文档已经被改过了。后面每一步都可能失败，
       * 而失败时**必须**把这个新图层撤掉 —— 否则用户会看到
       * "写回失败"外加一个凭空多出来、还可能放错位置的图层。
       */
      try {
        if (opts.mode === 'inPlaceSelection') {
          // B-04：用任务创建时记录的选区，不读"当前选区"。
          // selectionBounds 在进这个模态块之前已经校验过了。
          await fitToSelection(placed, wbTarget.selectionBounds!);
          await verifyPlacedBounds(placed, wbTarget.selectionBounds!);
        }
        stampProvenance(placed, opts.layerName, provenance);
      } catch (e) {
        const cleaned = await removeLayer(placed);
        if (!cleaned) {
          /*
           * 撤不掉。这时候不能说"失败了，文档没动"—— 文档确实动了。
           * 如实说清楚：写了一半、多出来一个图层、需要人去看一眼。
           * 含糊其辞的话用户会直接重试，然后又多一个。
           */
          throw new BridgeError(
            'WRITEBACK_PARTIAL',
            `写回中途失败（${e instanceof Error ? e.message : String(e)}），` +
              `而且没能撤掉刚置入的图层「${placed.name}」。请手动检查文档后再重试。`
          );
        }
        throw e;
      }

      /*
       * 到这里新图层已经放好、位置核对过、出处也盖上了 —— 现在才轮到删前任。
       *
       * 只在**恰好有一个**前任时才删。找到不止一个说明情况和我们的模型对不上
       * （用户复制过我们的图层？手工改过标记？），那时候删哪一个都可能是错的。
       * 多留一个图层是小事，删错一个用户的东西不是。
       */
      const stale = previous.filter((l) => l.id !== placed.id);
      if (stale.length === 1) {
        // 删不掉（锁定、或者用户手动改过）就留着 —— 不能为这个把一次
        // **已经成功**的写回判成失败。
        await removeLayer(stale[0]!);
      } else if (stale.length > 1) {
        log(`同一条任务找到 ${stale.length} 个带出处标记的图层，无法确定该替换哪一个，全部保留`);
      }
    }, { commandName: 'AI for PS: 写回结果' });

    const modeLabel =
      opts.mode === 'smartObject' ? '智能对象图层' : opts.mode === 'pixelLayer' ? '像素图层' : '选区原位';
    return { ok: true, detail: `已写回为${modeLabel}「${opts.layerName}」` };
  } catch (e) {
    if (e instanceof BridgeError) return { ok: false, code: e.code, detail: e.message };
    const msg = e instanceof Error ? e.message : String(e);
    // Photoshop 正忙时抛的是模态冲突
    if (/modal|busy/i.test(msg)) {
      return { ok: false, code: 'PHOTOSHOP_MODAL_BUSY', detail: 'Photoshop 正忙（可能有对话框打开），请关闭后重试' };
    }
    return { ok: false, code: 'WRITEBACK_FAILED', detail: msg };
  } finally {
    try {
      await temp?.entry.delete();
    } catch {
      /* 临时文件清理失败不影响结果 */
    }
  }
}

/** 由当前上下文构造任务要冻结的写回目标。 */
export function buildTarget(ctx: DocumentContext, selectionBounds: PsBounds | null): PhotoshopTarget {
  return {
    documentId: ctx.documentId,
    documentName: ctx.documentName,
    documentPath: ctx.documentPath,
    canvasWidth: ctx.width,
    canvasHeight: ctx.height,
    sourceLayerIds: ctx.activeLayers.map((l) => l.id),
    sourceLayerNames: ctx.activeLayers.map((l) => l.name),
    selectionBounds,
    colorMode: ctx.colorMode,
    bitDepth: ctx.bitDepth
  };
}
