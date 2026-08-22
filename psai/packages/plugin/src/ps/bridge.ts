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
      apiVersion?: string;
    };
    const uxp = req('uxp') as { storage: { localFileSystem: typeof localFileSystem } };

    app = photoshop.app;
    core = photoshop.core;
    action = photoshop.action;
    constants = photoshop.constants;
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
}

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function findLayerRecursive(container: { layers?: PsLayer[] }, id: number): PsLayer | null {
  for (const l of container.layers ?? []) {
    if (l.id === id) return l;
    if (l.layers?.length) {
      const hit = findLayerRecursive(l, id);
      if (hit) return hit;
    }
  }
  return null;
}

function hideAll(container: { layers?: PsLayer[] }): void {
  for (const l of container.layers ?? []) {
    try {
      l.visible = false;
    } catch {
      /* 锁定图层改不了可见性，跳过 */
    }
    if (l.layers?.length) hideAll(l);
  }
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
    const copy = await srcDoc.duplicate(`psai_snap_${uid()}`, true);
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

      const folder = await localFileSystem!.getDataFolder();
      const bytes = await readTempPng(folder, copy);
      const width = Math.round(copy.width);
      const height = Math.round(copy.height);
      await copy.close(constants!['SaveOptions']!['DONOTSAVECHANGES']);
      return { bytes, width, height, source, context: ctx, selectionBounds: cropBounds };
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
      hideAll(copy);
      let shown = 0;
      for (const id of wantedIds) {
        const layer = findLayerRecursive(copy, id);
        if (layer) {
          try {
            layer.visible = true;
            shown++;
          } catch {
            /* 锁定图层 */
          }
        }
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

/** 当前选区：合并可见后按选区边界裁剪 */
export async function captureSelection(): Promise<Snapshot> {
  requirePs();
  const ctx = readContext(app!.activeDocument);
  if (!ctx?.selectionBounds) {
    throw new BridgeError('PHOTOSHOP_SELECTION_INVALID', '当前文档没有有效选区');
  }
  const bounds = ctx.selectionBounds;
  return captureWith(
    'AI for PS: 捕获选区',
    'selection',
    async (copy) => {
      await copy.mergeVisibleLayers();
    },
    bounds
  );
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

/* ---------------- 写回前校验 ---------------- */

export interface ValidateResult {
  ok: boolean;
  code?: string;
  message?: string;
}

function findDocumentById(id: number): PsDocument | null {
  try {
    for (const d of app!.documents) if (d.id === id) return d;
  } catch {
    /* noop */
  }
  return null;
}

/** 写回前的完整安全校验（PRD §10.4）。任何一项不过就不写。 */
export function validateWritebackTarget(target: PhotoshopTarget | null): ValidateResult {
  if (!available) return { ok: false, code: 'PHOTOSHOP_NOT_AVAILABLE', message: unavailableReason };
  if (!target?.documentId) return { ok: false, code: 'WRITEBACK_TARGET_INVALID', message: '任务没有记录写回目标' };

  const doc = findDocumentById(target.documentId);
  if (!doc) {
    return {
      ok: false,
      code: 'PHOTOSHOP_DOCUMENT_NOT_FOUND',
      message: `源文档「${target.documentName}」已关闭。结果已保留，重新打开该文档后可在历史页再次写回。`
    };
  }

  const w = Math.round(doc.width);
  const h = Math.round(doc.height);
  if (target.canvasWidth && target.canvasHeight && (w !== target.canvasWidth || h !== target.canvasHeight)) {
    return {
      ok: false,
      code: 'WRITEBACK_DOCUMENT_CHANGED',
      message: `画布尺寸已从 ${target.canvasWidth}×${target.canvasHeight} 变成 ${w}×${h}，自动写回可能错位。请改用「新建图层」方式手动放置。`
    };
  }

  for (const id of target.sourceLayerIds ?? []) {
    if (!findLayerRecursive(doc, id)) {
      return {
        ok: false,
        code: 'PHOTOSHOP_LAYER_NOT_FOUND',
        message: '任务记录的源图层已不存在（含嵌套组内查找）。'
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
async function placeSmartObject(token: string, layerName: string): Promise<PsLayer> {
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
  const placed = app!.activeDocument?.activeLayers?.[0];
  if (!placed) throw new BridgeError('WRITEBACK_FAILED', 'placeEvent 没有产生图层');
  try {
    placed.name = layerName;
  } catch {
    /* 改名失败不影响结果 */
  }
  return placed;
}

/**
 * 置入为像素图层。
 * B-01：open 之后 activeDocument 是结果文档，必须显式切回目标文档再粘贴。
 */
async function placePixelLayer(token: string, layerName: string, targetDocId: number): Promise<PsLayer> {
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

    const placed = app!.activeDocument?.activeLayers?.[0];
    if (!placed) throw new BridgeError('WRITEBACK_FAILED', '粘贴没有产生图层');
    try {
      placed.name = layerName;
    } catch {
      /* noop */
    }
    return placed;
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
  target: PhotoshopTarget;
}): Promise<WritebackResult> {
  if (!available) return { ok: false, code: 'PHOTOSHOP_NOT_AVAILABLE', detail: unavailableReason };
  if (opts.mode === 'assetOnly') return { ok: true, detail: '按设置仅保存到资产库，未写回' };

  const check = validateWritebackTarget(opts.target);
  if (!check.ok) return { ok: false, code: check.code!, detail: check.message! };

  let temp: { token: string; entry: { delete(): Promise<void> } } | null = null;
  try {
    temp = await writeTempResult(opts.bytes);
    const token = temp.token;

    await core!.executeAsModal(async () => {
      const target = findDocumentById(opts.target.documentId);
      if (!target) throw new BridgeError('PHOTOSHOP_DOCUMENT_NOT_FOUND', '源文档已关闭');
      await activateDocument(target);

      let placed: PsLayer;
      if (opts.mode === 'pixelLayer') {
        placed = await placePixelLayer(token, opts.layerName, opts.target.documentId);
      } else {
        placed = await placeSmartObject(token, opts.layerName);
      }

      if (opts.mode === 'inPlaceSelection') {
        // B-04：用任务创建时记录的选区，不读"当前选区"
        if (!opts.target.selectionBounds) {
          throw new BridgeError('WRITEBACK_TARGET_INVALID', '该任务没有记录选区，无法原位写回');
        }
        await fitToSelection(placed, opts.target.selectionBounds);
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
