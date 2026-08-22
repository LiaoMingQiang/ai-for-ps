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

  async function addBytes(bytes: ArrayBuffer, name: string, source: InputSource, selectionBounds: PickedImage['selectionBounds']): Promise<void> {
    if (images.length >= max) {
      setError(`最多 ${max} 张，请先移除一张再添加`);
      return;
    }
    setBusy('上传中…');
    try {
      const asset = await api.uploadAsset(bytes, name);
      const previewSrc = await assetImgSrc(asset.id);
      const picked: PickedImage = {
        assetId: asset.id,
        width: asset.width,
        height: asset.height,
        bytes: asset.bytes,
        source,
        selectionBounds,
        previewSrc
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
      await addBytes(snap.bytes, `${source}.png`, source, snap.selectionBounds);
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
