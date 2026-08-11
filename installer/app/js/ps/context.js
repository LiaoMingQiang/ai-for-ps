/* ps/context: current document watcher (CTX-001: refresh <=500ms), demo-safe */
(function () {
  let timer = null;
  let lastKey = "";

  function tryRequire(mod) {
    try { return require(mod); } catch (e) { return null; }
  }

  function readContext() {
    const app = tryRequire("photoshop");
    if (!app || !app.app) return null;
    try {
      const doc = app.app.activeDocument;
      if (!doc) return null;
      const layers = doc.activeLayers || [];
      const active = layers[0] || null;
      const sel = doc.selection;
      let selectionBounds = null;
      try { if (sel && sel.bounds && !sel.isCancelled) { selectionBounds = { left: sel.bounds.left.as("px"), top: sel.bounds.top.as("px"), right: sel.bounds.right.as("px"), bottom: sel.bounds.bottom.as("px") }; } } catch (e) { /* best-effort */ }
      return {
        documentId: doc.id,
        name: doc.name,
        width: doc.width,
        height: doc.height,
        mode: doc.mode,
        bitDepth: doc.bitsPerChannel,
        activeLayer: active ? { id: active.id, name: active.name, kind: active.kind } : null,
        hasSelection: !!sel && !sel.isCancelled,
        selectionBounds: selectionBounds,
        colorSpace: doc.colorSpaceName
      };
    } catch (e) {
      return null;
    }
  }

  function keyOf(ctx) {
    if (!ctx) return "none";
    return [ctx.documentId, ctx.activeLayer && ctx.activeLayer.id, ctx.hasSelection ? 1 : 0].join(":");
  }

  function start() {
    if (timer) return;
    timer = setInterval(function () {
      const ctx = readContext();
      const key = keyOf(ctx);
      if (key !== lastKey) {
        lastKey = key;
        A4P.state.doc = ctx;
        A4P.store.emit("ps:context", ctx);
      }
    }, 500);
  }

  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  /* run once immediately (used by boot) */
  function refresh() {
    const ctx = readContext();
    lastKey = keyOf(ctx);
    A4P.state.doc = ctx;
    A4P.store.emit("ps:context", ctx);
    return ctx;
  }

  A4P.psContext = { start: start, stop: stop, refresh: refresh };
})();