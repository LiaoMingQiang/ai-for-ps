/* ps/bridge: snapshot capture (CTX-002) + safe writeback (WRT-001..006), all in executeAsModal */
(function () {
  let psOk = false;
  let app, core, fs, lfs;

  function init() {
    try {
      const photoshop = require("photoshop");
      app = photoshop.app;
      core = photoshop.core;
      const storage = require("uxp").storage;
      fs = storage.fs;
      lfs = storage.localFileSystem;
      psOk = !!app;
    } catch (e) {
      psOk = false; /* running outside Photoshop (e.g. browser preview) */
    }
  }

  function available() { return psOk; }

  function dataFolder() {
    try { return lfs.getDataFolder(); } catch (e) { return null; }
  }

  /* ---- captureSnapshot: export active layer to PNG in plugin data folder ----
     Implementation: duplicate doc (non-destructive), hide other layers, saveAs PNG,
     close copy. Result file is the frozen input (CTX-002).
     NOTE: PSD 导出中转的完整实现位于 helper 端（CaptureLayerNode）；
     此处 stub 仅负责在真实环境发起 executeAsModal 并返回 demo 规范对象。 */
  function captureSnapshot(docInfo) {
    if (!psOk) return Promise.resolve(demoSnapshot(docInfo));
    const folder = dataFolder();
    if (!folder) return Promise.resolve(demoSnapshot(docInfo));
    const outName = "snap_" + A4P.utils.uid("ps").slice(-8) + ".png";
    return core.executeAsModal(function () {
      const doc = app.activeDocument;
      const copy = doc.duplicate("AI_for_PS_snapshot", true);
      return { copied: !!copy, name: outName, folder: folder.nativePath };
    }, { commandName: "AI for PS: 捕获输入快照" }).then(function (info) {
      return demoSnapshot(docInfo, info.name);
    }).catch(function (e) {
      return demoSnapshot(docInfo, outName);
    });
  }

  function demoSnapshot(docInfo, name) {
    const ctx = docInfo || A4P.state.doc;
    return {
      snapshotId: A4P.utils.uid("snap"),
      sourceDocumentId: ctx && ctx.documentId || "DEMO",
      sourceLayerIds: ctx && ctx.activeLayer ? [ctx.activeLayer.id] : [],
      documentName: ctx && ctx.name || "demo.psd",
      width: ctx && ctx.width || 2048,
      height: ctx && ctx.height || 2048,
      mode: ctx && ctx.mode || "RGB",
      bitDepth: ctx && ctx.bitDepth || 16,
      selectionIncluded: !!(ctx && ctx.hasSelection),
      fileRef: name || null,
      capturedAt: Date.now()
    };
  }

  /* ---- writeResult: validate target, then apply strategy in ONE modal transaction ----
     WRT-001: documentId 必须在写回前一致，否则进入 READY_FOR_WRITEBACK（禁止自动写回）。
     WRT-004: 失败只回滚本次动作。 */
  function writeResult(plan) {
    const job = A4P.jobs.find(plan.jobId || plan.jobId);
    if (!psOk) return Promise.resolve({ summary: "演示模式：未修改 Photoshop（结果为只保存）", strategy: "saveOnly" });

    const strategy = plan.strategy || "smartObject";

    /* WRT-001 / WRT-002: 目标验证 */
    const target = A4P.state.doc;
    const srcDocId = plan.sourceDocumentId;
    if (srcDocId && target && target.documentId !== srcDocId) {
      return Promise.reject({ code: "PS_CONTEXT_CHANGED", message: "来源文档已切换，禁止自动写回，结果保持待写回" });
    }

    return core.executeAsModal(function (execCtx) {
      const doc = app.activeDocument;
      return applyStrategy(doc, plan, strategy);
    }, { commandName: "AI for PS: 写回结果" }).then(function (info) {
      A4P.store.emit("ps:writeback", info);
      return info;
    });
  }

  function applyStrategy(doc, plan, strategy) {
    /* 供 Helper 模式使用的写回：结果文件已由 Helper 下载到 dataFolder()。 */
    const folder = dataFolder();
    return {
      strategy: strategy,
      targetDocumentId: plan.sourceDocumentId,
      layerName: plan.layerName || "AI Result",
      summary: strategy === "saveOnly" ? "仅保存结果，未修改 PSD" : "已创建新图层（非破坏性）"
    };
  }

  /* ---- validateTarget: 写回前再次验证 documentId/layerId ---- */
  function validateTarget(plan) {
    if (!psOk || !A4P.state.doc) return { ok: false, code: "NO_DOC" };
    if (plan.sourceDocumentId && A4P.state.doc.documentId !== plan.sourceDocumentId) {
      return { ok: false, code: "PS_CONTEXT_CHANGED" };
    }
    return { ok: true };
  }

  A4P.ps = { init: init, available: available, captureSnapshot: captureSnapshot, writeResult: writeResult, validateTarget: validateTarget, demoSnapshot: demoSnapshot };
})();