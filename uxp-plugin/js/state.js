/* state: app store, event bus, localStorage persistence */
(function () {
  const LS_KEY = "aiforps.state.v1";
  const listeners = {};

  const state = {
    page: "generate",
    mode: "image",
    compare: "grid",
    doc: null,               // PS context (see ps/context.js)
    project: null,           // current AI project
    helper: { online: false, version: null, pingMs: null },
    gpu: { gpu: 0, vramUsed: 0, vramTotal: 24, ramUsed: 0, ramTotal: 64, queue: 0, ping: null, comfyVersion: null },
    selectedResult: null,
    activeJobId: null,
    waitingConfirm: null      // {risk:'high', message, fn}
  };

  /* ---- persistence: only UI prefs / settings (never credentials) ---- */
  function persist() {
    const p = {
      settings: A4P.settings.all ? A4P.settings.all() : {},
      lastPage: state.page,
      lastMode: state.mode
    };
    try {
      if (window.localStorage) window.localStorage.setItem(LS_KEY, JSON.stringify(p));
    } catch (e) { /* quota / unavailable: keep in memory */ }
  }
  function load() {
    try {
      const raw = window.localStorage && window.localStorage.getItem(LS_KEY);
      if (raw) {
        const p = JSON.parse(raw);
        if (p.lastPage) state.lastPage = p.lastPage;
        if (p.lastMode) state.lastMode = p.lastMode;
        if (p.settings && A4P.settings) A4P.settings.merge(p.settings);
      }
    } catch (e) { /* corrupt state: ignore */ }
  }

  /* ---- event bus ---- */
  function on(name, fn) { (listeners[name] = listeners[name] || []).push(fn); }
  function off(name, fn) {
    const l = listeners[name];
    if (!l) return;
    const i = l.indexOf(fn);
    if (i >= 0) l.splice(i, 1);
  }
  function emit(name, payload) {
    const l = listeners[name];
    if (!l) return;
    l.slice().forEach(function (fn) { try { fn(payload); } catch (e) { console.error(e); } });
  }

  /* ---- generation history: 由真实任务产出追加 {id, createdAt, label, version, projectId, payload:{prompt}, outputs:[{thumb,label}]} ---- */
  const history = [];
  function pushHistory(item) { history.unshift(item); while (history.length > 500) history.pop(); A4P.store.emit("history:update", item); }

  A4P.state = state;
  A4P.store = { on: on, off: off, emit: emit, persist: persist, load: load, LS_KEY: LS_KEY, history: history, pushHistory: pushHistory };
})();