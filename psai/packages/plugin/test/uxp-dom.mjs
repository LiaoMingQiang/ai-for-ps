/**
 * UXP DOM 的**子集**实现，用来在 Node 里把插件页面渲染一遍。
 *
 * 为什么不用 jsdom：jsdom 实现的是完整浏览器 DOM，而 UXP 的 DOM 是它的一个子集。
 * 用 jsdom 测出来的"通过"是假的 —— `Element.toggleAttribute` 在 jsdom 里好好的，
 * 装进 Photoshop 却当场抛 `is not a function`，整页白屏。
 * 我们真正需要的是一个**只提供 UXP 确实有的东西**的 DOM：
 * 缺什么就让它缺，页面碰了不该碰的 API 就当场炸给 CI 看。
 *
 * 已知 UXP 没有 / 不可靠的（本文件刻意不实现）：
 *   - Element.toggleAttribute            真机实测抛异常
 *   - classList.toggle(name, force)      两参数形式不可靠，这里只接受一个参数
 *   - Element.closest / matches          UXP 支持不完整
 *   - localStorage / sessionStorage      没有
 *   - getComputedStyle                   没有
 *
 * 名单里每一条都应当对应一次真机上踩过的坑或官方文档的明确说明，
 * 不要凭印象往里加 —— 加错了会让 CI 挡住本来能用的写法。
 */

const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'meta', 'link']);

class ClassList {
  constructor(el) {
    this.el = el;
    this.set = new Set();
  }
  add(...names) {
    for (const n of names) if (n) this.set.add(n);
  }
  remove(...names) {
    for (const n of names) this.set.delete(n);
  }
  contains(n) {
    return this.set.has(n);
  }
  /** 故意只接受一个参数：两参数形式在 UXP 上不可靠，用了就该报错。 */
  toggle(n, ...rest) {
    if (rest.length > 0) {
      throw new TypeError('UXP: classList.toggle(name, force) 两参数形式不可靠，请用 dom.ts 的 toggleClass');
    }
    if (this.set.has(n)) {
      this.set.delete(n);
      return false;
    }
    this.set.add(n);
    return true;
  }
  toString() {
    return [...this.set].join(' ');
  }
}

class Style {
  constructor() {
    this._ = {};
  }
  setProperty(k, v) {
    this._[k] = v;
  }
  removeProperty(k) {
    delete this._[k];
  }
}

class Node {
  constructor() {
    this.childNodes = [];
    this.parentNode = null;
  }
  get children() {
    return this.childNodes.filter((c) => c instanceof Element);
  }
  get firstChild() {
    return this.childNodes[0] ?? null;
  }
  get parentElement() {
    return this.parentNode instanceof Element ? this.parentNode : null;
  }
  appendChild(child) {
    if (child == null) throw new TypeError('appendChild(null)');
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  removeChild(child) {
    const i = this.childNodes.indexOf(child);
    if (i < 0) throw new Error('removeChild: 不是子节点');
    this.childNodes.splice(i, 1);
    child.parentNode = null;
    return child;
  }
  insertBefore(node, ref) {
    const i = ref ? this.childNodes.indexOf(ref) : this.childNodes.length;
    this.childNodes.splice(i < 0 ? this.childNodes.length : i, 0, node);
    node.parentNode = this;
    return node;
  }
}

class TextNode extends Node {
  constructor(text) {
    super();
    this.nodeType = 3;
    this.data = String(text);
  }
  get textContent() {
    return this.data;
  }
  set textContent(v) {
    this.data = String(v);
  }
}

class Element extends Node {
  constructor(tag) {
    super();
    this.nodeType = 1;
    this.tagName = String(tag).toUpperCase();
    this.attributes = new Map();
    this.classList = new ClassList(this);
    this.style = new Style();
    this.listeners = new Map();
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.selected = false;
  }

  get className() {
    return this.classList.toString();
  }
  set className(v) {
    this.classList.set = new Set(String(v).split(/\s+/).filter(Boolean));
  }

  /**
   * `<select>` 的 value 要从选中的 `<option>` 推出来，不能只是个自由字段。
   * 真实 DOM（含 UXP）就是这个行为，页面代码正是靠它读当前选中项；
   * 桩里如果只存一个空串，页面会以为"什么都没选"，测出来的通过是假的。
   */
  get value() {
    if (this.tagName !== 'SELECT') return this._value ?? '';
    if (this._value !== undefined && this._value !== '') return this._value;
    const opts = this.querySelectorAll('option');
    const picked = opts.find((o) => o.hasAttribute('selected')) ?? opts[0];
    return picked ? (picked.getAttribute('value') ?? picked.textContent) : '';
  }
  set value(v) {
    this._value = String(v);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'class') this.className = String(value);
  }
  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }
  removeAttribute(name) {
    this.attributes.delete(name);
  }
  hasAttribute(name) {
    return this.attributes.has(name);
  }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const l = this.listeners.get(type);
    if (l) this.listeners.set(type, l.filter((f) => f !== fn));
  }
  dispatchEvent(evt) {
    for (const fn of this.listeners.get(evt.type) ?? []) fn(evt);
    const inline = this[`on${evt.type}`];
    if (typeof inline === 'function') inline(evt);
    return true;
  }

  get textContent() {
    return this.childNodes.map((c) => c.textContent ?? '').join('');
  }
  set textContent(v) {
    this.childNodes = [];
    if (v !== '' && v != null) this.appendChild(new TextNode(v));
  }

  /** UXP 有 innerHTML，但我们只需要它能吞下空串来清空。 */
  set innerHTML(v) {
    if (String(v) !== '') throw new Error('UXP: 不要用 innerHTML 拼 DOM，请用 h() 构造节点');
    this.childNodes = [];
  }

  getBoundingClientRect() {
    return { left: 0, top: 0, width: 360, height: 640, right: 360, bottom: 640, x: 0, y: 0 };
  }

  querySelector(sel) {
    return this.querySelectorAll(sel)[0] ?? null;
  }
  querySelectorAll(sel) {
    // 只支持 .class / #id / tag —— UXP 的选择器支持也很有限，别在产品代码里用复杂选择器
    const out = [];
    const match = (el) => {
      if (sel.startsWith('.')) return el.classList.contains(sel.slice(1));
      if (sel.startsWith('#')) return el.getAttribute('id') === sel.slice(1);
      return el.tagName === sel.toUpperCase();
    };
    const walk = (el) => {
      for (const c of el.children) {
        if (match(c)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }

  get outerHTML() {
    const attrs = [...this.attributes].map(([k, v]) => ` ${k}="${v}"`).join('');
    const tag = this.tagName.toLowerCase();
    if (VOID_TAGS.has(tag)) return `<${tag}${attrs}>`;
    return `<${tag}${attrs}>${this.childNodes.map((c) => c.outerHTML ?? escapeText(c.textContent)).join('')}</${tag}>`;
  }
}

function escapeText(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

class DocumentImpl extends Node {
  constructor() {
    super();
    this.body = new Element('body');
    this.appendChild(this.body);
    this.documentElement = this.body;
  }
  createElement(tag) {
    return new Element(tag);
  }
  /**
   * UXP 支持 SVG（取景立方体就是靠它画的，真机验证过），所以这里要有。
   * 命名空间只记下来，行为上和普通元素一样。
   */
  createElementNS(ns, tag) {
    const el = new Element(tag);
    el.namespaceURI = ns;
    return el;
  }
  createTextNode(t) {
    return new TextNode(t);
  }
  createDocumentFragment() {
    return new Element('#fragment');
  }
  getElementById(id) {
    return this.body.querySelector(`#${id}`);
  }
  querySelector(sel) {
    return this.body.querySelector(sel);
  }
  querySelectorAll(sel) {
    return this.body.querySelectorAll(sel);
  }
  addEventListener() {}
  removeEventListener() {}
}

/**
 * 装好全局环境。返回 { document, root, calls }，
 * calls 记录页面对宿主能力的调用，方便断言。
 */
export function installUxpDom() {
  const document = new DocumentImpl();
  globalThis.document = document;
  globalThis.Element = Element;
  globalThis.Node = Node;
  globalThis.HTMLElement = Element;

  const win = {
    document,
    addEventListener() {},
    removeEventListener() {},
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    innerWidth: 360,
    innerHeight: 700
  };
  globalThis.window = win;
  // UXP 里没有这些，页面碰了就该炸
  delete globalThis.localStorage;
  delete globalThis.sessionStorage;
  globalThis.getComputedStyle = () => {
    throw new Error('UXP: 没有 getComputedStyle');
  };

  return { document, root: document.body };
}

export { Element, TextNode, DocumentImpl };
