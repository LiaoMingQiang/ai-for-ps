/**
 * 参数面板：把 ParamSpec 渲染成控件。
 *
 * 这里不为任何具体功能写死表单 —— 功能目录里加一个参数，面板上就自动多一个控件。
 * 这也是「功能不遗漏」能落地的原因：UI 没有第二份功能清单。
 */

import {
  ASPECT_RATIOS,
  SEED_MODES,
  SEED_MODE_LABELS,
  SEED_MAX,
  resolveSize,
  MAX_REFERENCE_IMAGES
} from '@psai/shared';
import type { ParamSpec, SeedValue, AspectValue, CameraValue } from '@psai/shared';
import { h, clear, debounce, setAttr, toggleClass } from '../app/dom.js';
import { createCameraCube } from './cube.js';

export interface ParamContext {
  /** 读当前值 */
  get(paramId: string): unknown;
  /** 写值 */
  set(paramId: string, value: unknown): void;
  /** 运行时可选项（采样器/调度器/模型…），来自 Provider 实时能力 */
  options: Record<string, string[]>;
  /** 提示词优化按钮的回调；返回 null 表示当前后端不支持 */
  onEnhance?: (paramId: string) => Promise<string | null>;
  /** 该功能可用的提示词预设 */
  presets: Array<{ id: string; label: string; kind: string; prompt: string; description: string }>;
  /** 分辨率/比例变化时用来显示推导尺寸 */
  onSizeHint?: () => void;
}

/** 渲染一组参数（自动分出「高级参数」折叠区）。 */
export function renderParams(specs: readonly ParamSpec[], ctx: ParamContext): HTMLElement {
  const basic = h('div', { class: 'param-list' });
  const advanced = h('div', { class: 'param-list' });

  let advancedCount = 0;
  for (const spec of specs) {
    if (spec.kind === 'image' || spec.kind === 'imageList') continue; // 图像输入单独一张卡
    const row = renderParam(spec, ctx);
    if (!row) continue;
    if (spec.advanced) {
      advanced.appendChild(row);
      advancedCount++;
    } else {
      basic.appendChild(row);
    }
  }

  const wrap = h('div', { class: 'params' }, basic);
  if (advancedCount > 0) {
    const details = h(
      'details',
      { class: 'param-advanced' },
      h('summary', {}, `高级参数（${advancedCount}）`),
      advanced
    );
    wrap.appendChild(details);
  }
  return wrap;
}

function field(spec: ParamSpec, control: HTMLElement, extra?: HTMLElement): HTMLElement {
  const label = h('div', { class: 'param-label' }, spec.label);
  const body = h('div', { class: 'param-control' }, control);
  const row = h('div', { class: 'param', data: { param: spec.id } }, label, body);
  if (extra) row.appendChild(extra);
  if (spec.hint) row.appendChild(h('div', { class: 'param-hint' }, spec.hint));
  return row;
}

function renderParam(spec: ParamSpec, ctx: ParamContext): HTMLElement | null {
  switch (spec.kind) {
    case 'prompt':
      return renderPrompt(spec, ctx);
    case 'negativePrompt':
      return renderTextarea(spec, ctx, spec.rows, spec.placeholder);
    case 'presetPrompt':
      return renderPresetPrompt(spec, ctx);
    case 'seed':
      return renderSeed(spec, ctx);
    case 'slider':
      return renderSlider(spec, ctx);
    case 'resolution':
      return renderSlider(spec, ctx, 'px');
    case 'select':
      return renderSelect(spec, ctx);
    case 'segmented':
      return renderSegmented(spec, ctx);
    case 'toggle':
      return renderToggle(spec, ctx);
    case 'aspect':
      return renderAspect(spec, ctx);
    case 'camera':
      return renderCamera(spec, ctx);
    case 'model':
      return renderModel(spec, ctx);
    case 'text':
      return renderText(spec, ctx);
    default:
      return null;
  }
}

/* ---------------- 提示词 ---------------- */

function renderPrompt(spec: Extract<ParamSpec, { kind: 'prompt' }>, ctx: ParamContext): HTMLElement {
  const ta = h('textarea', {
    class: 'input textarea',
    rows: String(spec.rows),
    placeholder: spec.placeholder,
    oninput: debounce((e: Event) => ctx.set(spec.id, (e.target as HTMLTextAreaElement).value), 150)
  }) as HTMLTextAreaElement;
  ta.value = String(ctx.get(spec.id) ?? '');

  const counter = h('span', { class: 'prompt-count' }, `${ta.value.length}`);
  ta.addEventListener('input', () => (counter.textContent = String(ta.value.length)));

  const tools = h('div', { class: 'prompt-tools' }, counter);

  if (spec.enhanceable && ctx.onEnhance) {
    const undoWrap = h('span', { class: 'prompt-undo hidden' });
    const btn = h(
      'button',
      {
        class: 'btn-ghost btn-enhance',
        type: 'button',
        title: '用视觉/语言模型把提示词改写成高质量版本',
        onclick: async () => {
          const before = ta.value;
          btn.setAttribute('disabled', '');
          btn.textContent = '优化中…';
          try {
            const next = await ctx.onEnhance!(spec.id);
            if (next) {
              ta.value = next;
              ctx.set(spec.id, next);
              counter.textContent = String(next.length);
              clear(undoWrap);
              undoWrap.classList.remove('hidden');
              undoWrap.appendChild(h('span', {}, '已优化 · '));
              undoWrap.appendChild(
                h(
                  'button',
                  {
                    class: 'link',
                    type: 'button',
                    onclick: () => {
                      ta.value = before;
                      ctx.set(spec.id, before);
                      counter.textContent = String(before.length);
                      undoWrap.classList.add('hidden');
                    }
                  },
                  '撤销'
                )
              );
            }
          } catch (e) {
            undoWrap.classList.remove('hidden');
            clear(undoWrap);
            undoWrap.appendChild(h('span', { class: 'err' }, e instanceof Error ? e.message : String(e)));
          } finally {
            btn.removeAttribute('disabled');
            btn.textContent = '✨ 优化提示词';
          }
        }
      },
      '✨ 优化提示词'
    );
    tools.appendChild(undoWrap);
    tools.appendChild(btn);
  }

  const required = spec.required ? h('span', { class: 'req' }, '必填') : null;
  const row = field(spec, h('div', { class: 'prompt-box' }, ta, tools));
  if (required) row.querySelector('.param-label')?.appendChild(required);
  return row;
}

function renderTextarea(
  spec: ParamSpec & { defaultValue: string },
  ctx: ParamContext,
  rows: number,
  placeholder: string
): HTMLElement {
  const ta = h('textarea', {
    class: 'input textarea',
    rows: String(rows),
    placeholder,
    oninput: debounce((e: Event) => ctx.set(spec.id, (e.target as HTMLTextAreaElement).value), 150)
  }) as HTMLTextAreaElement;
  ta.value = String(ctx.get(spec.id) ?? spec.defaultValue);
  return field(spec, ta);
}

function renderText(spec: Extract<ParamSpec, { kind: 'text' }>, ctx: ParamContext): HTMLElement {
  const input = h('input', {
    class: 'input',
    type: 'text',
    placeholder: spec.placeholder,
    oninput: debounce((e: Event) => ctx.set(spec.id, (e.target as HTMLInputElement).value), 150)
  }) as HTMLInputElement;
  input.value = String(ctx.get(spec.id) ?? spec.defaultValue);
  return field(spec, input);
}

/* ---------------- 预设选择器 ---------------- */

function renderPresetPrompt(spec: Extract<ParamSpec, { kind: 'presetPrompt' }>, ctx: ParamContext): HTMLElement {
  const current = (ctx.get(spec.id) as { presetId?: string; enabled?: boolean } | undefined) ?? {
    presetId: spec.defaultPresetId,
    enabled: spec.defaultEnabled
  };
  const pool = ctx.presets.filter((p) => p.kind === spec.presetKind);

  const select = h('select', {
    class: 'input select',
    onchange: (e: Event) => {
      const presetId = (e.target as HTMLSelectElement).value;
      ctx.set(spec.id, { ...current, presetId });
      current.presetId = presetId;
      renderPreview();
    }
  }) as HTMLSelectElement;

  select.appendChild(h('option', { value: '' }, '（不使用）'));
  for (const p of pool) {
    const opt = h('option', { value: p.id }, p.label) as HTMLOptionElement;
    if (p.id === current.presetId) opt.setAttribute('selected', '');
    select.appendChild(opt);
  }

  const toggle = spec.toggleable
    ? h('button', {
        class: `switch ${current.enabled ? 'on' : ''}`,
        type: 'button',
        role: 'switch',
        'aria-checked': String(!!current.enabled),
        onclick: (e: Event) => {
          const next = !current.enabled;
          current.enabled = next;
          ctx.set(spec.id, { ...current, enabled: next });
          const btn = e.currentTarget as HTMLElement;
          toggleClass(btn, 'on', next);
          btn.setAttribute('aria-checked', String(next));
          toggleClass(preview, 'dim', !next);
        }
      })
    : null;

  const preview = h('div', { class: `preset-preview ${current.enabled ? '' : 'dim'}` });
  function renderPreview(): void {
    clear(preview);
    const p = pool.find((x) => x.id === current.presetId);
    if (!p) return;
    preview.appendChild(h('div', { class: 'preset-desc' }, p.description));
    const details = h(
      'details',
      { class: 'preset-full' },
      h('summary', {}, '查看完整提示词'),
      h('pre', { class: 'preset-text' }, p.prompt)
    );
    preview.appendChild(details);
  }
  renderPreview();

  const head = h('div', { class: 'preset-head' }, select);
  if (toggle) head.appendChild(toggle);
  return field(spec, h('div', { class: 'preset' }, head, preview));
}

/* ---------------- 种子 ---------------- */

function renderSeed(spec: Extract<ParamSpec, { kind: 'seed' }>, ctx: ParamContext): HTMLElement {
  const current = ((ctx.get(spec.id) as SeedValue | undefined) ?? spec.defaultValue) as SeedValue;

  const numInput = h('input', {
    class: 'input seed-value',
    type: 'text',
    onchange: (e: Event) => {
      const n = Number((e.target as HTMLInputElement).value.replace(/[^0-9]/g, ''));
      const v = Number.isFinite(n) ? Math.min(SEED_MAX, Math.max(0, Math.round(n))) : 0;
      (e.target as HTMLInputElement).value = String(v);
      ctx.set(spec.id, { mode: current.mode, value: v });
      current.value = v;
    }
  }) as HTMLInputElement;
  numInput.value = String(current.value ?? 0);

  const seg = h('div', { class: 'segmented' });
  for (const mode of SEED_MODES) {
    const btn = h(
      'button',
      {
        class: `seg ${current.mode === mode ? 'active' : ''}`,
        type: 'button',
        onclick: () => {
          current.mode = mode;
          if (mode === 'random') {
            const v = Math.floor(Math.random() * (SEED_MAX + 1));
            current.value = v;
            numInput.value = String(v);
          }
          ctx.set(spec.id, { mode, value: current.value });
          for (const b of Array.from(seg.children)) b.classList.remove('active');
          btn.classList.add('active');
          setAttr(numInput, 'readonly', mode !== 'fixed');
        }
      },
      SEED_MODE_LABELS[mode]
    );
    seg.appendChild(btn);
  }
  setAttr(numInput, 'readonly', current.mode !== 'fixed');

  return field(spec, h('div', { class: 'seed' }, seg, numInput));
}

/* ---------------- 滑杆 ---------------- */

function renderSlider(
  spec: Extract<ParamSpec, { kind: 'slider' | 'resolution' }>,
  ctx: ParamContext,
  unit = ''
): HTMLElement {
  const value = Number(ctx.get(spec.id) ?? spec.defaultValue);
  const precision = 'precision' in spec ? spec.precision : 0;

  const out = h('input', { class: 'input slider-value', type: 'text' }) as HTMLInputElement;
  const fmt = (n: number): string => (precision > 0 ? n.toFixed(precision) : String(Math.round(n)));
  out.value = fmt(value);

  const range = h('input', {
    class: 'slider',
    type: 'range',
    min: String(spec.min),
    max: String(spec.max),
    step: String(spec.step),
    value: String(value),
    oninput: (e: Event) => {
      const n = Number((e.target as HTMLInputElement).value);
      out.value = fmt(n);
      ctx.set(spec.id, n);
      ctx.onSizeHint?.();
    }
  }) as HTMLInputElement;

  out.addEventListener('change', () => {
    const n = Number(out.value.replace(/[^\-0-9.]/g, ''));
    const clamped = Number.isFinite(n) ? Math.min(spec.max, Math.max(spec.min, n)) : spec.defaultValue;
    out.value = fmt(clamped);
    range.value = String(clamped);
    ctx.set(spec.id, clamped);
    ctx.onSizeHint?.();
  });

  const box = h('div', { class: 'slider-row' }, range, h('div', { class: 'slider-out' }, out, unit ? h('span', { class: 'unit' }, unit) : null));
  return field(spec, box);
}

/* ---------------- 下拉 / 分段 / 开关 ---------------- */

function renderSelect(spec: Extract<ParamSpec, { kind: 'select' }>, ctx: ParamContext): HTMLElement {
  const runtime = spec.dynamicSource ? ctx.options[spec.dynamicSource] : undefined;
  const options = runtime?.length ? runtime.map((v) => ({ value: v, label: v })) : spec.options;
  const current = String(ctx.get(spec.id) ?? spec.defaultValue);

  const select = h('select', {
    class: 'input select',
    onchange: (e: Event) => ctx.set(spec.id, (e.target as HTMLSelectElement).value)
  }) as HTMLSelectElement;

  let matched = false;
  for (const o of options) {
    const opt = h('option', { value: o.value }, o.label) as HTMLOptionElement;
    if (o.value === current) {
      opt.setAttribute('selected', '');
      matched = true;
    }
    select.appendChild(opt);
  }
  // 运行时列表里没有当前值时保留它，避免静默改掉用户的选择
  if (!matched && current) {
    const opt = h('option', { value: current }, `${current}（当前后端未提供）`) as HTMLOptionElement;
    opt.setAttribute('selected', '');
    select.insertBefore(opt, select.firstChild);
  }
  return field(spec, select);
}

function renderSegmented(spec: Extract<ParamSpec, { kind: 'segmented' }>, ctx: ParamContext): HTMLElement {
  const current = String(ctx.get(spec.id) ?? spec.defaultValue);
  const seg = h('div', { class: 'segmented' });
  for (const o of spec.options) {
    const btn = h(
      'button',
      {
        class: `seg ${o.value === current ? 'active' : ''}`,
        type: 'button',
        onclick: () => {
          ctx.set(spec.id, o.value);
          for (const b of Array.from(seg.children)) b.classList.remove('active');
          btn.classList.add('active');
        }
      },
      o.label
    );
    seg.appendChild(btn);
  }
  return field(spec, seg);
}

function renderToggle(spec: Extract<ParamSpec, { kind: 'toggle' }>, ctx: ParamContext): HTMLElement {
  const current = Boolean(ctx.get(spec.id) ?? spec.defaultValue);
  const btn = h('button', {
    class: `switch ${current ? 'on' : ''}`,
    type: 'button',
    role: 'switch',
    'aria-checked': String(current),
    onclick: () => {
      const next = !btn.classList.contains('on');
      toggleClass(btn, 'on', next);
      btn.setAttribute('aria-checked', String(next));
      ctx.set(spec.id, next);
    }
  });
  return field(spec, btn);
}

function renderModel(spec: Extract<ParamSpec, { kind: 'model' }>, ctx: ParamContext): HTMLElement {
  const models = ctx.options['models'] ?? [];
  const current = String(ctx.get(spec.id) ?? spec.defaultValue);
  const select = h('select', {
    class: 'input select',
    onchange: (e: Event) => ctx.set(spec.id, (e.target as HTMLSelectElement).value)
  }) as HTMLSelectElement;

  select.appendChild(h('option', { value: '' }, models.length ? '（使用默认模型）' : '（尚未拉取模型列表）'));
  for (const m of models) {
    const opt = h('option', { value: m }, m) as HTMLOptionElement;
    if (m === current) opt.setAttribute('selected', '');
    select.appendChild(opt);
  }
  return field(spec, select);
}

/* ---------------- 比例 ---------------- */

function renderAspect(spec: Extract<ParamSpec, { kind: 'aspect' }>, ctx: ParamContext): HTMLElement {
  const current = ((ctx.get(spec.id) as AspectValue | undefined) ?? spec.defaultValue) as AspectValue;
  const grid = h('div', { class: 'aspect-grid' });
  const customBox = h('div', { class: `aspect-custom ${current.id === 'custom' ? '' : 'hidden'}` });

  const hintFor = (id: string): string => {
    const base = Number(ctx.get('resolution') ?? 1024);
    if (id === 'custom') return '自定义';
    const { width, height } = resolveSize({ id }, base);
    return `${width}×${height}`;
  };

  const buttons: HTMLElement[] = [];
  for (const a of ASPECT_RATIOS) {
    const btn = h(
      'button',
      {
        class: `aspect ${a.id === current.id ? 'active' : ''}`,
        type: 'button',
        onclick: () => {
          current.id = a.id;
          ctx.set(spec.id, { ...current });
          for (const b of buttons) b.classList.remove('active');
          btn.classList.add('active');
          toggleClass(customBox, 'hidden', a.id !== 'custom');
        }
      },
      h('span', { class: 'aspect-label' }, a.label),
      h('span', { class: 'aspect-size', data: { aspect: a.id } }, hintFor(a.id))
    );
    buttons.push(btn);
    grid.appendChild(btn);
  }

  const mk = (key: 'customW' | 'customH', label: string): HTMLElement => {
    const input = h('input', {
      class: 'input',
      type: 'text',
      placeholder: label,
      onchange: (e: Event) => {
        const n = Number((e.target as HTMLInputElement).value.replace(/[^0-9]/g, ''));
        current[key] = Number.isFinite(n) && n > 0 ? n : undefined;
        ctx.set(spec.id, { ...current });
      }
    }) as HTMLInputElement;
    if (current[key]) input.value = String(current[key]);
    return h('label', { class: 'aspect-custom-field' }, h('span', {}, label), input);
  };
  customBox.appendChild(mk('customW', '宽'));
  customBox.appendChild(mk('customH', '高'));

  const row = field(spec, h('div', {}, grid, customBox));
  // 分辨率变化时刷新每个比例下方的推导尺寸
  row.setAttribute('data-refresh-sizes', '1');
  return row;
}

/** 分辨率滑杆动了以后，刷新比例按钮下方的尺寸提示。 */
export function refreshAspectHints(root: HTMLElement, resolution: number): void {
  for (const el of Array.from(root.querySelectorAll('.aspect-size'))) {
    const id = el.getAttribute('data-aspect');
    if (!id || id === 'custom') continue;
    const { width, height } = resolveSize({ id }, resolution);
    el.textContent = `${width}×${height}`;
  }
}

/* ---------------- 摄像机 ---------------- */

function renderCamera(spec: Extract<ParamSpec, { kind: 'camera' }>, ctx: ParamContext): HTMLElement {
  const current = ((ctx.get(spec.id) as CameraValue | undefined) ?? spec.defaultValue) as CameraValue;
  const cube = createCameraCube({
    value: current,
    onChange: (v) => ctx.set(spec.id, v)
  });
  const row = field(spec, cube.el);
  row.classList.add('param-camera');
  return row;
}

export { MAX_REFERENCE_IMAGES };
