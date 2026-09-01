/**
 * 图像输入卡：拖拽 / 粘贴 / 上传 / 从 Photoshop 取图层·选区·合并可见。
 * 单图与多图（最多 10 张）共用一套实现。
 */

import { INPUT_SOURCE_LABELS } from '@psai/shared';
import type { ParamSpec, InputSource } from '@psai/shared';
import { h, clear, formatBytes } from '../app/dom.js';
import { api, assetImgSrc } from '../app/api.js';
import { toast } from '../app/store.js';
import * as bridge from '../ps/bridge.js';

export interface PickedImage {
  assetId: string;
  width: number;
  height: number;
  bytes: number;
  source: InputSource;
  /** 选区来源时记录，供写回原位使用 */
  selectionBounds: { left: number; top: number; right: number; bottom: number } | null;
  previewSrc: string;
  /**
   * 这张图是从哪个 Photoshop 文档取的。
   *
   * 提交时要拿它和**当前**文档比一比。两者可以不一样，而且很容易不一样：
   * 用户从 A 取了图，中间切到 B，然后点了「开始处理」——
   * 输入是 A 的内容，而写回目标会被冻结成 B。结果就是 A 的图被贴进 B 的文档，
   * 而两边都不会报错。
   *
   * 非 Photoshop 来源（上传、粘贴）为 null —— 那种图本来就不属于任何文档。
   */
  sourceDocumentId: number | null;
  sourceDocumentName: string | null;
  /**
   * 取图那一刻文档的**耐久身份**，光靠 id 是不够的。
   *
   * Photoshop 的文档 id 在文档关掉之后会被回收：用户关掉 A、新建一份 B，
   * B 完全可能拿到 A 的旧编号。只比 id 的话，这时候"输入图和当前文档
   * 对不上"这道检查会**放行** —— 然后 A 的内容被贴进 B 的文档，
   * 而 B 可能是另一个客户的稿子。
   *
   * 存过盘的比路径（最硬的凭据），没存过的比文件名 + 画布尺寸。
   * 都是取图那一刻记下来的，之后不再变。
   */
  sourceDocumentPath: string | null;
  sourceCanvasWidth: number | null;
  sourceCanvasHeight: number | null;
}

export interface ImageInputHandle {
  el: HTMLElement;
  getValue(): PickedImage[];
  clear(): void;
}

export function createImageInput(
  spec: Extract<ParamSpec, { kind: 'image' | 'imageList' }>,
  onChange: (images: PickedImage[]) => void
): ImageInputHandle {
  const multi = spec.kind === 'imageList';
  const max = multi ? spec.max : 1;
  const min = multi ? spec.min : spec.required ? 1 : 0;
  let images: PickedImage[] = [];

  const grid = h('div', { class: multi ? 'img-grid' : 'img-single' });
  const status = h('div', { class: 'img-status' });
  const sources = h('div', { class: 'img-sources' });

  const card = h(
    'section',
    { class: 'card' },
    h('h3', { class: 'card-title' }, spec.label, multi ? h('span', { class: 'img-count' }, `0 / ${max}`) : null),
    grid,
    sources,
    status
  );

  function countEl(): HTMLElement | null {
    return card.querySelector('.img-count');
  }

  function emit(): void {
    const c = countEl();
    if (c) c.textContent = `${images.length} / ${max}`;
    onChange(images.slice());
  }

  function setBusy(msg: string): void {
    clear(status);
    if (msg) status.appendChild(h('span', { class: 'muted' }, msg));
  }

  function setError(msg: string): void {
    clear(status);
    status.appendChild(h('span', { class: 'err' }, msg));
  }

  async function addBytes(
    bytes: ArrayBuffer,
    name: string,
    source: InputSource,
    selectionBounds: PickedImage['selectionBounds'],
    mask?: { gray: Uint8Array; width: number; height: number } | null,
    sourceDoc?: { id: number; name: string; path: string; width: number; height: number } | null
  ): Promise<void> {
    if (images.length >= max) {
      setError(`最多 ${max} 张，请先移除一张再添加`);
      return;
    }
    setBusy('上传中…');
    try {
      const asset = await api.uploadAsset(bytes, name, 'image/png', mask);
      /*
       * 遮罩体检没过要当场说。
       *
       * 全不透明（选区丢了）和全透明（空选区）这两种，下游都不会报错 ——
       * 前者整张重画、后者什么都不改，用户要等几分钟、花完钱才发现不对，
       * 而且多半会归咎于模型。在这里说一句，代价是零。
       */
      if (asset.maskCheck && !asset.maskCheck.ok) {
        toast('选区遮罩不可用', asset.maskCheck.reason ?? '', 'warn');
      }
      // 输入区的预览框也就一百多像素高，同样用缩略图
      const previewSrc = await assetImgSrc(asset.id, { thumb: true });
      const picked: PickedImage = {
        assetId: asset.id,
        width: asset.width,
        height: asset.height,
        bytes: asset.bytes,
        source,
        selectionBounds,
        previewSrc,
        sourceDocumentId: sourceDoc?.id ?? null,
        sourceDocumentName: sourceDoc?.name ?? null,
        sourceDocumentPath: sourceDoc?.path ?? null,
        sourceCanvasWidth: sourceDoc?.width ?? null,
        sourceCanvasHeight: sourceDoc?.height ?? null
      };
      images = multi ? [...images, picked] : [picked];
      render();
      setBusy('');
      emit();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  /* ---------------- 来源按钮 ---------------- */

  async function fromPhotoshop(source: InputSource): Promise<void> {
    if (!bridge.isAvailable()) {
      setError(bridge.reason() || '当前不在 Photoshop 中运行');
      return;
    }
    setBusy('正在从 Photoshop 取图…');
    try {
      let snap: bridge.Snapshot;
      if (source === 'layer') snap = await bridge.captureActiveLayers();
      else if (source === 'selection') snap = await bridge.captureSelection();
      else snap = await bridge.captureMergedVisible();

      /*
       * 取不到遮罩时如实说一声，而且要说清**为什么**。
       *
       * 这时候选区退化成了外接矩形，羽化和不规则形状都没了。
       * 老版本没接口是环境限制，用户改不了；而接口报错、尺寸对不上
       * 是出了问题，值得他看一眼 —— 混成同一句话的话，
       * 真正的故障会被当成"我这版 Photoshop 就这样"而长期无人察觉。
       */
      if (source === 'selection' && !snap.maskGray) {
        toast(
          '选区已按外接矩形处理',
          `${snap.maskUnavailable ?? '取不到选区遮罩'} —— 羽化与不规则形状不会保留`,
          'warn'
        );
      }
      await addBytes(
        snap.bytes,
        `${source}.png`,
        source,
        snap.selectionBounds,
        snap.maskGray ? { gray: snap.maskGray, width: snap.maskWidth, height: snap.maskHeight } : null,
        // 身份要在**取图这一刻**记全：id 会被回收，路径和画布尺寸不会
        {
          id: snap.context.documentId,
          name: snap.context.documentName,
          path: snap.context.documentPath,
          width: snap.context.width,
          height: snap.context.height
        }
      );
    } catch (e) {
      const msg = e instanceof bridge.BridgeError ? e.message : e instanceof Error ? e.message : String(e);
      setError(msg);
    }
  }

  async function fromUpload(): Promise<void> {
    if (!bridge.isAvailable()) {
      setError('文件选择需要在 Photoshop 中运行');
      return;
    }
    try {
      const picked = await bridge.pickImageFile();
      if (!picked) return;
      await addBytes(picked.bytes, picked.name, 'upload', null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function fromClipboard(): Promise<void> {
    try {
      const clip = (navigator as unknown as { clipboard?: { read?(): Promise<Array<{ types: string[]; getType(t: string): Promise<Blob> }>> } }).clipboard;
      if (!clip?.read) {
        setError('当前环境不支持读取剪贴板图像，请改用「上传」');
        return;
      }
      const items = await clip.read();
      for (const item of items) {
        const type = item.types.find((t) => t.startsWith('image/'));
        if (!type) continue;
        const blob = await item.getType(type);
        await addBytes(await blob.arrayBuffer(), 'paste.png', 'paste', null);
        return;
      }
      setError('剪贴板里没有图像');
    } catch (e) {
      setError(`读取剪贴板失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  function renderSources(): void {
    clear(sources);
    for (const s of spec.sources) {
      const disabled = s === 'selection' && !bridge.getContext()?.hasSelection;
      const btn = h(
        'button',
        {
          class: 'btn-src',
          type: 'button',
          disabled,
          title: disabled ? '当前文档没有选区' : `从${INPUT_SOURCE_LABELS[s]}获取`,
          onclick: () => {
            if (s === 'upload') void fromUpload();
            else if (s === 'paste') void fromClipboard();
            else void fromPhotoshop(s);
          }
        },
        INPUT_SOURCE_LABELS[s]
      );
      sources.appendChild(btn);
    }
  }

  /* ---------------- 渲染 ---------------- */

  function emptyState(): HTMLElement {
    return h(
      'div',
      {
        class: 'img-empty',
        onclick: () => void fromUpload()
      },
      h('div', { class: 'img-empty-icon' }, '🖼'),
      h('div', { class: 'img-empty-text' }, multi ? `拖拽、粘贴或点击上传图片，最多 ${max} 张` : '拖拽、粘贴或点击上传图片')
    );
  }

  function thumb(img: PickedImage, index: number): HTMLElement {
    const preview = h('img', { class: 'img-thumb-pic', src: img.previewSrc, alt: '' });
    const meta = h(
      'div',
      { class: 'img-thumb-meta' },
      `${INPUT_SOURCE_LABELS[img.source]} · ${img.width}×${img.height} · ${formatBytes(img.bytes)}`
    );
    const remove = h(
      'button',
      {
        class: 'img-thumb-remove',
        type: 'button',
        title: '移除',
        onclick: (e: Event) => {
          e.stopPropagation();
          images = images.filter((_, i) => i !== index);
          render();
          emit();
        }
      },
      '×'
    );
    return h('div', { class: 'img-thumb' }, preview, remove, meta);
  }

  function render(): void {
    clear(grid);
    if (images.length === 0) {
      grid.appendChild(emptyState());
    } else {
      images.forEach((img, i) => grid.appendChild(thumb(img, i)));
      if (multi && images.length < max) {
        grid.appendChild(
          h('button', { class: 'img-add', type: 'button', onclick: () => void fromUpload() }, '+')
        );
      }
    }
    renderSources();
  }

  /* ---------------- 拖拽 ---------------- */

  card.addEventListener('dragover', (e: Event) => {
    e.preventDefault();
    card.classList.add('is-dropping');
  });
  card.addEventListener('dragleave', () => card.classList.remove('is-dropping'));
  card.addEventListener('drop', (e: Event) => {
    e.preventDefault();
    card.classList.remove('is-dropping');
    const dt = (e as DragEvent).dataTransfer;
    if (!dt?.files?.length) return;
    void (async () => {
      for (const file of Array.from(dt.files).slice(0, max - images.length)) {
        if (!file.type.startsWith('image/')) {
          setError(`${file.name} 不是图片`);
          continue;
        }
        await addBytes(await file.arrayBuffer(), file.name, 'upload', null);
      }
    })();
  });

  render();

  return {
    el: card,
    getValue: () => images.slice(),
    clear: () => {
      images = [];
      render();
      emit();
    }
  };
}

/** 校验输入是否满足要求，返回可直接展示的错误文案。 */
export function validateImages(spec: Extract<ParamSpec, { kind: 'image' | 'imageList' }>, images: PickedImage[]): string | null {
  if (spec.kind === 'image') {
    if (spec.required && images.length === 0) return `「${spec.label}」是必需的`;
    return null;
  }
  if (images.length < spec.min) return `「${spec.label}」至少需要 ${spec.min} 张`;
  if (images.length > spec.max) return `「${spec.label}」最多 ${spec.max} 张`;
  return null;
}

export { toast };
