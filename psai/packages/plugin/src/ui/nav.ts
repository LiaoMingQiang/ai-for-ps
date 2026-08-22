/**
 * 5 级导航渲染器。
 *
 * 完全由功能目录驱动：目录里加一个节点，导航自动多一项。
 * 规则（PRD §3.3）：
 *   - 未就绪的功能仍然显示，但是禁用态 + 原因徽标，点击可跳到设置去修
 *   - 面板窄的时候 L3 以下从分段控件降级成下拉，保证 360px 宽也能用
 */

import { CATALOG } from '@psai/shared';
import type { CatalogNode } from '@psai/shared';
import { h, clear } from '../app/dom.js';
import type { FeatureView } from '../app/api.js';

export interface NavOptions {
  featureId: string;
  features: FeatureView[];
  onSelect(featureId: string): void;
  /** 点击未就绪功能的原因徽标 */
  onFixReason(featureId: string): void;
  /** 面板宽度，用于决定分段还是下拉 */
  width: number;
}

/**
 * 找到某个功能在目录里的祖先链，**不含 `generate` 这个 L1 根节点**。
 * chain[0] 必须是 L2（comfyui / 闭源模型），否则 siblingsAt 的层级会整体错一位，
 * 结果就是 L2 那一排被画两遍。
 */
function chainOf(featureId: string): CatalogNode[] {
  const trail: CatalogNode[] = [];
  const walk = (nodes: readonly CatalogNode[], acc: CatalogNode[]): boolean => {
    for (const n of nodes) {
      const next = [...acc, n];
      if (n.feature?.id === featureId) {
        trail.push(...next);
        return true;
      }
      if (n.children && walk(n.children, next)) return true;
    }
    return false;
  };
  walk(CATALOG, []);
  return trail[0]?.id === 'generate' ? trail.slice(1) : trail;
}

/** 该层级下所有可选节点（同级兄弟）。 */
function siblingsAt(chain: CatalogNode[], level: number): CatalogNode[] {
  if (level === 0) {
    const gen = CATALOG.find((n) => n.id === 'generate');
    return gen?.children ?? [];
  }
  return chain[level - 1]?.children ?? [];
}

/** 从某个节点往下钻到第一个可执行叶子。 */
export function firstFeatureUnder(node: CatalogNode): string | null {
  if (node.feature) return node.feature.id;
  for (const c of node.children ?? []) {
    const hit = firstFeatureUnder(c);
    if (hit) return hit;
  }
  return null;
}

export function renderNav(opts: NavOptions): HTMLElement {
  const root = h('nav', { class: 'featnav' });
  const chain = chainOf(opts.featureId);
  if (chain.length === 0) return root;

  // chain[0] 是 L2（comfyui / 闭源模型），往下逐级渲染
  const compact = opts.width < 460;

  for (let level = 0; level < chain.length; level++) {
    const options = siblingsAt(chain, level);
    if (options.length === 0) continue;
    // 只有一个选项且它不是叶子时，这一级没有选择意义，跳过
    if (options.length === 1 && !options[0]!.feature) continue;

    const current = chain[level]!;
    const rowClass = `featnav-row level-${level + 2}`;

    if (compact && level >= 1) {
      const select = h('select', {
        class: 'input select featnav-select',
        onchange: (e: Event) => {
          const node = options.find((o) => o.id === (e.target as HTMLSelectElement).value);
          if (!node) return;
          const fid = firstFeatureUnder(node);
          if (fid) opts.onSelect(fid);
        }
      }) as HTMLSelectElement;
      for (const o of options) {
        const opt = h('option', { value: o.id }, o.label) as HTMLOptionElement;
        if (o.id === current.id) opt.setAttribute('selected', '');
        select.appendChild(opt);
      }
      root.appendChild(h('div', { class: rowClass }, select));
      continue;
    }

    const row = h('div', { class: rowClass });
    for (const node of options) {
      const fid = firstFeatureUnder(node);
      const view = fid ? opts.features.find((f) => f.id === fid) : null;
      const isCurrent = node.id === current.id;
      const notReady = !!view && !view.ready;

      const btn = h(
        'button',
        {
          class: `featnav-btn ${isCurrent ? 'active' : ''} ${notReady ? 'not-ready' : ''}`,
          type: 'button',
          title: notReady ? (view?.reason ?? '') : node.label,
          onclick: () => {
            if (fid) opts.onSelect(fid);
          }
        },
        h('span', { class: 'featnav-text' }, node.label)
      );

      if (notReady) {
        btn.appendChild(
          h(
            'span',
            {
              class: 'featnav-warn',
              title: view!.reason ?? '',
              onclick: (e: Event) => {
                e.stopPropagation();
                opts.onFixReason(fid!);
              }
            },
            '⚠'
          )
        );
      }
      row.appendChild(btn);
    }
    root.appendChild(row);
  }

  return root;
}

/** 面包屑，显示在功能页标题上方。 */
export function renderBreadcrumb(view: FeatureView | null): HTMLElement {
  const el = h('div', { class: 'crumb' });
  if (!view) return el;
  view.breadcrumb.forEach((part, i) => {
    if (i > 0) el.appendChild(h('span', { class: 'crumb-sep' }, '/'));
    el.appendChild(h('span', { class: i === view.breadcrumb.length - 1 ? 'crumb-cur' : '' }, part));
  });
  return el;
}

/** L1 顶部导航。 */
export function renderTopNav(
  page: string,
  onSelect: (page: 'comfyWeb' | 'generate' | 'history' | 'settings') => void
): HTMLElement {
  const items: Array<{ id: 'comfyWeb' | 'generate' | 'history' | 'settings'; label: string }> = [
    { id: 'comfyWeb', label: 'ComfyUI' },
    { id: 'generate', label: '生成' },
    { id: 'history', label: '历史' },
    { id: 'settings', label: '设置' }
  ];
  const nav = h('div', { class: 'topnav' });
  for (const it of items) {
    nav.appendChild(
      h(
        'button',
        {
          class: `topnav-btn ${page === it.id ? 'active' : ''}`,
          type: 'button',
          onclick: () => onSelect(it.id)
        },
        it.label
      )
    );
  }
  return nav;
}

export { clear };
