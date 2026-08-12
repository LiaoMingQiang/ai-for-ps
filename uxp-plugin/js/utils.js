/* utils */
(function () {
  function $ (sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function val(sel, root) { const el = (root || document).querySelector(sel); return el ? el.value : ""; }
  function uid(prefix) {
    prefix = prefix || "id";
    return prefix + "_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7);
  }
  function fmtTime(ms) {
    if (ms == null) return "--";
    const s = Math.floor(ms / 1000);
    if (s < 60) return s + "s";
    const m = Math.floor(s / 60), r = s % 60;
    return m + ":" + String(r).padStart(2, "0");
  }
  function debounce(fn, wait) {
    let h = null;
    return function () {
      const args = arguments, self = this;
      if (h) clearTimeout(h);
      h = setTimeout(function () { fn.apply(self, args); }, wait);
    };
  }
  function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }
  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function sha256Str(s) {
    /* deterministic FNV-1a hex (safe, dependency-free); real hashing done in Helper with crypto */
    let h1 = 0x811c9dc5;
    const str = String(s);
    for (let i = 0; i < str.length; i++) {
      h1 ^= str.charCodeAt(i);
      h1 = (h1 * 0x01000193) >>> 0;
    }
    return "a4p" + h1.toString(16).padStart(8, "0") + str.length.toString(16).padStart(4, "0");
  }
  /* PHASE 3: 正式 UXP 文件选择 (localFileSystem.getFileForOpening, 禁止浏览器 file input 作为正式输入)
   * UXP 模式: Promise<[{name, size, blob}]>; 浏览器模式: resolve null (调用方 fallback 到 file input) */
  function isUxpRuntime() {
    return typeof window !== "undefined" && !!window.require && typeof (window.require("uxp") || {}).storage !== "undefined";
  }
  function pickImageFiles(multiple) {
    const req = (typeof window !== "undefined" && window.require) ? window.require : null;
    if (!req) return Promise.resolve(null);
    let lfs = null, formats = null;
    try { lfs = req("uxp").storage.localFileSystem; formats = req("uxp").storage.formats; } catch (e) { return Promise.resolve(null); }
    if (!lfs || !formats) return Promise.resolve(null);
    const pick = multiple && lfs.getFileForOpening ? lfs.getFileForOpening({ allowMultiple: true }) : lfs.getFileForOpening();
    return Promise.resolve(pick).then(function (entries) {
      const list = Array.isArray(entries) ? entries : (entries ? [entries] : []);
      return Promise.all(list.map(function (entry) {
        return entry.read({ format: formats.binary }).then(function (buf) {
          return { name: entry.name, size: buf.byteLength || 0, blob: new Blob([buf], { type: "image/png" }) };
        });
      })).then(function (files) { return files; });
    }).catch(function () { return null; });
  }
  A4P.utils = { $: $, $$: $$, val: val, uid: uid, fmtTime: fmtTime, debounce: debounce, clamp: clamp, escapeHtml: escapeHtml, sha256Str: sha256Str, isUxpRuntime: isUxpRuntime, pickImageFiles: pickImageFiles };
})();