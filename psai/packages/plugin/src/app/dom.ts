/**
 * 极小的 DOM 构造工具。
 *
 * UXP 的 DOM 是浏览器 DOM 的子集，也没有 npm 运行时，所以不引框架，
 * 只提供一个够用的 h()：属性、事件、子节点一次写完，避免满屏 createElement。
 */

export type Child = Node | string | number | null | undefined | false;

export interface Attrs {
  class?: string;
  id?: string;
  title?: string;
  style?: Partial<CSSStyleDeclaration> | string;
  disabled?: boolean;
  hidden?: boolean;
  /** data-* 属性 */
  data?: Record<string, string>;
  /** 事件：onclick / oninput / onchange ... */
  [key: string]: unknown;
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs | null = null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) applyAttrs(el, attrs);
  if (tag === 'input' || tag === 'textarea') liftLengthLimit(el, attrs);
  append(el, children);
  return el;
}

/**
 * UXP 的 `<input>` / `<textarea>` **默认最多只收 256 个字符**，超出的直接吞掉。
 *
 * 这个上限不在我们代码里 —— 全库没有一处 maxlength，是宿主的默认值。
 * 表现极具迷惑性：粘一段长文进去只进去开头一截，没有任何报错，
 * 看起来像"粘贴失败"或者"这个框坏了"。真机上连着坑了几轮：
 *   ComfyUI 的工作流 JSON（几十 KB）永远只进去开头
 *   RunningHub 的请求示例 curl 粘不全，于是解析不出 nodeInfoList
 *   提示词写长一点就被截断，而右下角的计数器停在 256 —— 那就是证据
 *
 * 所以在唯一的创建点统一解开：调用方没有显式给 maxlength 时，
 * 给一个足够大的值。显式给了的（真要限长的场合）原样尊重。
 *
 * 上限取 100 万：ComfyUI 导出的大图也就几百 KB，留足余量；
 * 又不至于大到让宿主为一个输入框预分配离谱的内存。
 */
const UXP_DEFAULT_MAXLENGTH = 1_000_000;

function liftLengthLimit(el: HTMLElement, attrs: Attrs | null): void {
  if (attrs && ('maxlength' in attrs || 'maxLength' in attrs)) return;
  try {
    el.setAttribute('maxlength', String(UXP_DEFAULT_MAXLENGTH));
    // 属性和 IDL 属性在 UXP 上不一定互通，两边都写一次
    (el as unknown as { maxLength?: number }).maxLength = UXP_DEFAULT_MAXLENGTH;
  } catch {
    /* 宿主不认这个属性就算了，至少不能因此建不出控件 */
  }
}

/** SVG 元素必须用命名空间创建，否则在 UXP 里不渲染。 */
export function svgEl(tag: string, attrs: Record<string, string | number> = {}, ...children: Child[]): SVGElement {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag) as SVGElement;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  append(el as unknown as HTMLElement, children);
  return el;
}

function applyAttrs(el: HTMLElement, attrs: Attrs): void {
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;

    if (key === 'class') {
      el.className = String(value);
    } else if (key === 'style') {
      if (typeof value === 'string') el.setAttribute('style', value);
      else Object.assign(el.style, value);
    } else if (key === 'data') {
      for (const [dk, dv] of Object.entries(value as Record<string, string>)) {
        el.setAttribute(`data-${dk}`, dv);
      }
    } else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2), value as EventListener);
    } else if (key === 'disabled' || key === 'hidden' || key === 'checked') {
      if (value) el.setAttribute(key, '');
      else el.removeAttribute(key);
    } else {
      el.setAttribute(key, String(value));
    }
  }
}

function append(el: HTMLElement, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
  }
}

/**
 * UXP 的 DOM 是浏览器 DOM 的子集，下面两个是踩过的坑，必须用这里的封装：
 *
 *   el.toggleAttribute(name, force)      UXP 里根本没有这个方法，
 *                                        调用直接抛 "is not a function"，整页白屏
 *   el.classList.toggle(name, force)     带第二个参数的写法在 UXP 里不可靠
 *
 * tools/lint.mjs 里有规则禁止在插件源码里直接用这两个 API。
 */
export function setAttr(el: Element, name: string, on: boolean): void {
  if (on) el.setAttribute(name, '');
  else el.removeAttribute(name);
}

export function toggleClass(el: Element, name: string, on: boolean): void {
  if (on) el.classList.add(name);
  else el.classList.remove(name);
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function mount(parent: Element, ...children: Child[]): void {
  clear(parent);
  append(parent as HTMLElement, children);
}

export function $(selector: string, root: ParentNode = document): HTMLElement | null {
  return root.querySelector(selector);
}

export function $$(selector: string, root: ParentNode = document): HTMLElement[] {
  return Array.from(root.querySelectorAll(selector));
}

/** 防抖：滑杆连续拖动时避免每一帧都提交。 */
export function debounce<T extends (...args: never[]) => void>(fn: T, ms = 120): T {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return ((...args: never[]) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  }) as T;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

export function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
