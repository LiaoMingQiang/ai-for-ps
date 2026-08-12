/* ps/bridge: 真实 Photoshop Bridge (PHASE 2)
 *
 * 官方依据 (Adobe UXP docs, PS 25.2 baseline):
 *   - core.executeAsModal(targetFn, {commandName})  — 所有 PSD 修改必须 modal
 *   - Document.duplicate(name, mergeLayersOnly)     → Promise<Document>
 *   - Document.saveAs.png(entry, opts?, asCopy)     → Promise<void>
 *   - Document.mergeVisibleLayers() / close(SaveOptions.DONOTSAVECHANGES)
 *   - Selection.bounds = {top,left,bottom,right} 数字像素 (PS 25.0+; 不是 UnitValue)
 *   - Layer.scale(horizontalPct, verticalPct, AnchorPosition) / translate(x,y) / move(rel, ElementPlacement)
 *   - batchPlay placeEvent (ScriptListener 动作格式, PS 全版本稳定): 放置智能对象
 *   - batchPlay crop (ScriptListener 动作格式): 按选区边界裁剪
 *
 * 安全规则:
 *   - 写回前 validateWritebackTarget: sourceDocumentId 必须仍存在且匹配
 *   - 选区任务使用任务创建时记录的 selectionBounds, 不依赖当前选区
 *   - 浏览器预览 (无 UXP): 所有能力真实失败并带原因, 禁止 mock 成功
 */
(function () {
  "use strict";

  var psOk = false;
  var app = null, core = null, action = null, constants = null;
  var fs = null, lfs = null;

  /* ---------- init: 真实初始化 (bootstrap 必须调用) ---------- */
  function init() {
    try {
      var photoshop = require("photoshop");
      app = photoshop.app;
      core = photoshop.core;
      action = photoshop.action;
      constants = photoshop.constants;
      var uxp = require("uxp");
      fs = uxp.storage.fs;
      lfs = uxp.storage.localFileSystem;
      psOk = !!(app && core && action);
      return Promise.resolve({ ok: psOk, apiVersion: (photoshop.apiVersion !== undefined ? photoshop.apiVersion : null) });
    } catch (e) {
      psOk = false;
      return Promise.resolve({ ok: false, reason: "not-in-photoshop" });
    }
  }

  function available() { return psOk; }

  function uid(prefix) { return (prefix || "id") + "_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8); }

  /* ---------- getContext / getDocuments ---------- */
  function readDocContext(doc) {
    if (!doc) return null;
    var layers = [];
    try {
      layers = (doc.activeLayers || []).map(function (l) { return { id: l.id, name: l.name, kind: l.kind }; });
    } catch (e) { /* best-effort */ }
    var sel = null;
    var selectionBounds = null;
    try { sel = doc.selection; } catch (e) { /* noop */ }
    try {
      if (sel && !sel.isCancelled) {
        var b = sel.bounds;
        if (b) selectionBounds = { left: Math.round(b.left), top: Math.round(b.top), right: Math.round(b.right), bottom: Math.round(b.bottom) };
      }
    } catch (e) { /* best-effort */ }
    return {
      documentId: doc.id,
      documentName: doc.name,
      documentPath: (doc.path ? doc.path.nativePath : null) || "",
      width: Math.round(doc.width),
      height: Math.round(doc.height),
      colorMode: doc.mode ? String(doc.mode) : "RGB",
      bitDepth: doc.bitsPerChannel || 8,
      activeLayers: layers,
      activeLayer: layers[0] || null,
      hasSelection: !!(sel && !sel.isCancelled),
      selectionBounds: selectionBounds
    };
  }

  function getContext() {
    if (!psOk) return Promise.reject({ code: "PHOTOSHOP_NOT_AVAILABLE", message: "未在 Photoshop 中运行" });
    return Promise.resolve(readDocContext(app.activeDocument));
  }

  function getDocuments() {
    if (!psOk) return Promise.reject({ code: "PHOTOSHOP_NOT_AVAILABLE", message: "未在 Photoshop 中运行" });
    try {
      var docs = app.documents.map(function (d) {
        return { documentId: d.id, name: d.name, width: Math.round(d.width), height: Math.round(d.height), path: (d.path ? d.path.nativePath : null) || "" };
      });
      return Promise.resolve(docs);
    } catch (e) {
      return Promise.reject({ code: "PHOTOSHOP_READ_FAILED", message: "读取文档列表失败", details: String(e) });
    }
  }

  /* ---------- 图层 -> 临时 PNG (全部在 executeAsModal 内) ----------
   * 管线: duplicate(副本) → 隐藏非目标图层 → mergeVisibleLayers → (可选 crop) → saveAs.png → close
   * 输出: plugin-data:// 下的临时文件 (UXP 默认可访问, 不申请 fullAccess) */
  function exportLayersToPng(targets, opts) {
    /* targets: [{name, index}] 源文档图层定位 (duplicate 副本顺序/名称与源一致)
     * opts: { cropBounds, fileName } */
    return core.executeAsModal(async function () {
      var src = app.activeDocument;
      var srcCtx = readDocContext(src);
      var copy = await src.duplicate("A4P_snap_" + uid("s"), true);
      var outPath = null, outSize = 0;
      try {
        /* 1. 隐藏全部 */
        var all = copy.layers;
        for (var i = 0; i < all.length; i++) { try { all[i].visible = false; } catch (e) { /* locked layer */ } }
        /* 2. 显示目标 (index + name 双校验) */
        var shown = 0;
        for (var t = 0; t < targets.length; t++) {
          var cand = null;
          if (targets[t].index !== undefined && targets[t].index >= 0 && all[targets[t].index] && all[targets[t].index].name === targets[t].name) {
            cand = all[targets[t].index];
          } else {
            for (var j = 0; j < all.length; j++) { if (all[j].name === targets[t].name) { cand = all[j]; break; } }
          }
          if (cand) { try { cand.visible = true; shown++; } catch (e) { /* noop */ } }
        }
        if (shown === 0) throw { code: "PHOTOSHOP_LAYER_NOT_FOUND", message: "目标图层在快照副本中不可见" };
        /* 3. 合并可见 */
        await copy.mergeVisibleLayers();
        /* 4. 选区任务: 按原始 bounds 裁剪 (不依赖当前选区) */
        if (opts && opts.cropBounds) {
          var b = opts.cropBounds;
          await action.batchPlay([{
            _obj: "crop",
            bounds: {
              _obj: "bounds",
              left: { _unit: "pixels", _value: b.left },
              top: { _unit: "pixels", _value: b.top },
              right: { _unit: "pixels", _value: b.right },
              bottom: { _unit: "pixels", _value: b.bottom }
            },
            angle: 0
          }], {});
        }
        /* 5. 保存 PNG (plugin-data, asCopy 不弹对话框) */
        var folder = await lfs.getDataFolder();
        var name = (opts && opts.fileName) || ("snap_" + uid("snap").slice(-10) + ".png");
        var file = await folder.createFile(name, { overwrite: true });
        await copy.saveAs.png(file, {}, true);
        outPath = file.nativePath;
        try { outSize = (await file.size) || 0; } catch (e) { /* noop */ }
        var finalDoc = app.activeDocument;
        var finalCtx = readDocContext(finalDoc);
        await copy.close(constants.SaveOptions.DONOTSAVECHANGES);
        return {
          snapshotId: uid("snap"),
          documentId: srcCtx.documentId,
          documentName: srcCtx.documentName,
          documentPath: srcCtx.documentPath,
          layerIds: targets.map(function (t) { return t.id; }),
          selectionBounds: (opts && opts.cropBounds) || srcCtx.selectionBounds,
          width: finalCtx ? finalCtx.width : 0,
          height: finalCtx ? finalCtx.height : 0,
          colorMode: srcCtx.colorMode,
          bitDepth: srcCtx.bitDepth,
          createdAt: Date.now(),
          tempFile: outPath,
          tempFileSize: outSize
        };
      } catch (e) {
        try { await copy.close(constants.SaveOptions.DONOTSAVECHANGES); } catch (e2) { /* noop */ }
        throw e;
      }
    }, { commandName: "AI for PS: 捕获输入快照" });
  }

  function captureActiveLayer(opts) {
    if (!psOk) return Promise.reject({ code: "PHOTOSHOP_NOT_AVAILABLE", message: "捕获当前图层需要 Photoshop 环境" });
    var ctx = readDocContext(app.activeDocument);
    var l = ctx.activeLayer;
    if (!l) return Promise.reject({ code: "PHOTOSHOP_LAYER_NOT_FOUND", message: "当前文档没有活动图层" });
    return exportLayersToPng([{ id: l.id, name: l.name, index: findLayerIndexIn(app.activeDocument, l) }], opts || {});
  }

  function captureSelectedLayers(opts) {
    if (!psOk) return Promise.reject({ code: "PHOTOSHOP_NOT_AVAILABLE", message: "捕获所选图层需要 Photoshop 环境" });
    var ctx = readDocContext(app.activeDocument);
    if (!ctx.activeLayers.length) return Promise.reject({ code: "PHOTOSHOP_LAYER_NOT_FOUND", message: "当前没有选中图层" });
    var targets = [];
    ctx.activeLayers.forEach(function (l) {
      targets.push({ id: l.id, name: l.name, index: findLayerIndexIn(app.activeDocument, l) });
    });
    return exportLayersToPng(targets, opts || {});
  }

  function captureMergedVisible(opts) {
    if (!psOk) return Promise.reject({ code: "PHOTOSHOT_NOT_AVAILABLE", message: "合并可见快照需要 Photoshop 环境" });
    /* targets=[] 表示全部可见: exportLayersToPng 隐藏全部后无目标 → 特殊处理 */
    return core.executeAsModal(async function () {
      var src = app.activeDocument;
      var srcCtx = readDocContext(src);
      var copy = await src.duplicate("A4P_snap_" + uid("s"), true);
      try {
        await copy.mergeVisibleLayers();
        var folder = await lfs.getDataFolder();
        var name = (opts && opts.fileName) || ("snap_" + uid("snap").slice(-10) + ".png");
        var file = await folder.createFile(name, { overwrite: true });
        await copy.saveAs.png(file, {}, true);
        var finalCtx = readDocContext(app.activeDocument);
        await copy.close(constants.SaveOptions.DONOTSAVECHANGES);
        return {
          snapshotId: uid("snap"),
          documentId: srcCtx.documentId,
          documentName: srcCtx.documentName,
          documentPath: srcCtx.documentPath,
          layerIds: [],
          selectionBounds: srcCtx.selectionBounds,
          width: finalCtx ? finalCtx.width : 0,
          height: finalCtx ? finalCtx.height : 0,
          colorMode: srcCtx.colorMode,
          bitDepth: srcCtx.bitDepth,
          createdAt: Date.now(),
          tempFile: file.nativePath,
          tempFileSize: 0
        };
      } catch (e) {
        try { await copy.close(constants.SaveOptions.DONOTSAVECHANGES); } catch (e2) { /* noop */ }
        throw e;
      }
    }, { commandName: "AI for PS: 捕获合并可见快照" });
  }

  function captureSelection(opts) {
    if (!psOk) return Promise.reject({ code: "PHOTOSHOT_NOT_AVAILABLE", message: "捕获选区需要 Photoshop 环境" });
    var ctx = readDocContext(app.activeDocument);
    if (!ctx.hasSelection || !ctx.selectionBounds) {
      return Promise.reject({ code: "PHOTOSHOT_SELECTION_INVALID", message: "当前文档没有有效选区" });
    }
    /* 选区 = 所有可见图层合并后裁剪到原始 bounds */
    return core.executeAsModal(async function () {
      var src = app.activeDocument;
      var srcCtx = readDocContext(src);
      var copy = await src.duplicate("A4P_snap_" + uid("s"), true);
      try {
        await copy.mergeVisibleLayers();
        var b = ctx.selectionBounds;
        await action.batchPlay([{
          _obj: "crop",
          bounds: {
            _obj: "bounds",
            left: { _unit: "pixels", _value: b.left },
            top: { _unit: "pixels", _value: b.top },
            right: { _unit: "pixels", _value: b.right },
            bottom: { _unit: "pixels", _value: b.bottom }
          },
          angle: 0
        }], {});
        var folder = await lfs.getDataFolder();
        var name = (opts && opts.fileName) || ("snap_" + uid("snap").slice(-10) + ".png");
        var file = await folder.createFile(name, { overwrite: true });
        await copy.saveAs.png(file, {}, true);
        await copy.close(constants.SaveOptions.DONOTSAVECHANGES);
        return {
          snapshotId: uid("snap"),
          documentId: srcCtx.documentId,
          documentName: srcCtx.documentName,
          documentPath: srcCtx.documentPath,
          layerIds: [],
          selectionBounds: { left: b.left, top: b.top, right: b.right, bottom: b.bottom },
          width: Math.max(1, Math.round(b.right - b.left)),
          height: Math.max(1, Math.round(b.bottom - b.top)),
          colorMode: srcCtx.colorMode,
          bitDepth: srcCtx.bitDepth,
          createdAt: Date.now(),
          tempFile: file.nativePath,
          tempFileSize: 0
        };
      } catch (e) {
        try { await copy.close(constants.SaveOptions.DONOTSAVECHANGES); } catch (e2) { /* noop */ }
        throw e;
      }
    }, { commandName: "AI for PS: 捕获选区快照" });
  }

  function captureLayerMask(layerId) {
    if (!psOk) return Promise.reject({ code: "PHOTOSHOT_NOT_AVAILABLE", message: "捕获图层蒙版需要 Photoshop 环境" });
    /* 图层蒙版效果在图层渲染时已生效: 导出该图层 = 蒙版后的像素 */
    var ctx = readDocContext(app.activeDocument);
    var target = null, idx = -1;
    if (layerId !== undefined && layerId !== null) {
      target = findLayerByIdRecursive(app.activeDocument, layerId);
      idx = target ? findLayerIndexIn(app.activeDocument, target) : -1;
    } else if (ctx.activeLayer) {
      target = ctx.activeLayer;
      idx = findLayerIndexIn(app.activeDocument, target);
    }
    if (!target) return Promise.reject({ code: "PHOTOSHOP_LAYER_NOT_FOUND", message: "蒙版图层不存在: " + layerId });
    return exportLayersToPng([{ id: target.id, name: target.name, index: idx }], {});
  }

  /* PHASE 7: Layer Mask 输入 — MaskSnapshot
   * 官方 UXP DOM 无独立蒙版通道灰度读取 API (Channel 类仅 alpha/spot 通道, 已查官方文档);
   * 因此输出「蒙版应用后的图层像素」+ polarity 元数据 (White=可编辑/Black=保护),
   * 供 Workflow Binding 按极性使用。独立灰度通道导出需 batchPlay descriptor, 如实标注为增强项。 */
  function captureLayerMaskPixels(layerId) {
    if (!psOk) return Promise.reject({ code: "PHOTOSHOT_NOT_AVAILABLE", message: "捕获蒙版像素需要 Photoshop 环境" });
    var ctx = readDocContext(app.activeDocument);
    var target = null;
    if (layerId !== undefined && layerId !== null) {
      target = findLayerByIdRecursive(app.activeDocument, layerId);
    } else if (ctx.activeLayer) {
      target = ctx.activeLayer;
    }
    if (!target) return Promise.reject({ code: "PHOTOSHOT_LAYER_NOT_FOUND", message: "蒙版图层不存在: " + layerId });
    return exportLayersToPng([{ id: target.id, name: target.name, index: findLayerIndexIn(app.activeDocument, target) }], {})
      .then(function (snap) {
        return {
          snapshotId: snap.snapshotId,
          sourceLayerId: layerId !== undefined && layerId !== null ? layerId : target.id,
          width: snap.width,
          height: snap.height,
          tempFile: snap.tempFile,
          tempFileSize: snap.tempFileSize,
          polarity: "whiteEditable",   /* White=editable, Black=protected (蒙版应用后像素) */
          maskMode: "appliedPixels",   /* 官方 DOM 能力边界: 非独立灰度通道 */
          documentId: snap.documentId,
          documentName: snap.documentName,
          documentPath: snap.documentPath,
          createdAt: Date.now()
        };
      });
  }

  /* ---------- 写回目标验证 ---------- */
  function findDocumentById(docId) {
    try {
      var docs = app.documents;
      for (var i = 0; i < docs.length; i++) { if (docs[i].id === docId) return docs[i]; }
    } catch (e) { /* noop */ }
    return null;
  }

  /* PHASE 8: 递归图层查找 (Group / Nested Group / Smart Object / Pixel Layer)
   * sourceLayerId 必须在复杂 PSD 中可靠定位 */
  function findLayerByIdRecursive(container, layerId) {
    if (!container || layerId === undefined || layerId === null) return null;
    try {
      var layers = container.layers;
      for (var i = 0; i < layers.length; i++) {
        var l = layers[i];
        if (l.id === layerId) return l;
        /* 组图层递归深入 */
        if (l.layers || l.kind === "group") {
          var r = findLayerByIdRecursive(l, layerId);
          if (r) return r;
        }
      }
    } catch (e) { /* 不可遍历的容器 */ }
    return null;
  }

  function findLayerIndexIn(container, layer) {
    try {
      var layers = container.layers;
      for (var i = 0; i < layers.length; i++) { if (layers[i].id === layer.id) return i; }
    } catch (e) { /* noop */ }
    return -1;
  }

  function validateWritebackTarget(target) {
    if (!psOk) return Promise.resolve({ ok: false, code: "PHOTOSHOP_NOT_AVAILABLE", message: "未在 Photoshop 中运行" });
    var t = target || {};
    if (!t.sourceDocumentId) return Promise.resolve({ ok: false, code: "WRITEBACK_TARGET_INVALID", message: "缺少 sourceDocumentId" });
    var doc = findDocumentById(t.sourceDocumentId);
    if (!doc) return Promise.resolve({ ok: false, code: "PHOTOSHOP_DOCUMENT_NOT_FOUND", message: "源文档已关闭或不存在 (documentId=" + t.sourceDocumentId + ")" });
    /* 尺寸变化检测 (规则四: 文档尺寸变化必须拦截) */
    if (t.canvasWidth && t.canvasHeight) {
      var w = Math.round(doc.width), h = Math.round(doc.height);
      if (w !== t.canvasWidth || h !== t.canvasHeight) {
        return Promise.resolve({ ok: false, code: "WRITEBACK_DOCUMENT_CHANGED", message: "文档尺寸已从 " + t.canvasWidth + "x" + t.canvasHeight + " 变为 " + w + "x" + h + "，禁止自动写回" });
      }
    }
    if (t.sourceLayerIds && t.sourceLayerIds.length) {
      var names = [];
      try {
        t.sourceLayerIds.forEach(function (id) {
          var l = findLayerByIdRecursive(doc, id);
          if (l) names.push(l.name);
        });
      } catch (e) { /* noop */ }
      if (names.length !== t.sourceLayerIds.length) {
        return Promise.resolve({ ok: false, code: "PHOTOSHOP_LAYER_NOT_FOUND", message: "源图层已不存在（含嵌套图层查找），禁止自动写回" });
      }
    }
    return Promise.resolve({ ok: true, documentId: doc.id, documentName: doc.name });
  }

  /* ---------- 写回执行 (executeAsModal 内) ---------- */
  function switchToDocument(doc) {
    /* 官方 batchPlay select 命令: 切换活动文档 */
    return action.batchPlay([{ _obj: "select", _target: [{ _ref: "document", _id: doc.id }] }], {});
  }

  /* 放置智能对象: ScriptListener 动作格式 (placeEvent, PS 全版本稳定)
   * UXP 正式路径使用 sessionToken (createSessionToken), 不传未经授权的 raw path */
  function placeAsSmartObject(pngPathOrToken, layerName) {
    return action.batchPlay([{
      _obj: "placeEvent",
      "null": { _path: pngPathOrToken, _kind: "local" },
      freeTransformCenterState: { _enum: "quadCenterState", _value: "QCSAverage" },
      offset: { _obj: "offset", horizontal: 0, vertical: 0 }
    }], {}).then(function () {
      var placed = app.activeDocument.activeLayers[0];
      if (!placed) throw { code: "WRITEBACK_FAILED", message: "placeEvent 未产生图层" };
      if (layerName) { try { placed.name = layerName; } catch (e) { /* noop */ } }
      return placed;
    });
  }

  /* 像素图层 (PHASE 5 修复): 进入前确定目标文档 id = 任务创建时绑定的源文档
   * open(result) 之后 activeDocument 是结果文档, 绝不能把它当目标 PSD。
   * 正确顺序: open -> 全选复制 -> findDocumentById(targetDocumentId) -> 显式激活 -> paste -> 关闭临时文档 */
  function placeAsPixelLayer(pngPathOrToken, layerName, targetDocumentId) {
    var targetId = targetDocumentId || null;
    return action.batchPlay([{ _obj: "open", "null": { _path: pngPathOrToken, _kind: "local" } }], {}).then(async function () {
      await action.batchPlay([{ _obj: "selectAll" }, { _obj: "copy" }], {});
      var openedId = app.activeDocument.id;
      var target = targetId ? findDocumentById(targetId) : null;
      if (!target) {
        /* 目标源文档不在: 关闭临时文档, 结果保留可重试 */
        try {
          var tmp = findDocumentById(openedId);
          if (tmp) await tmp.close(constants.SaveOptions.DONOTSAVECHANGES);
        } catch (e) { /* noop */ }
        throw { code: "PHOTOSHOP_DOCUMENT_NOT_FOUND", message: "源文档已关闭，结果保留在 Helper，可稍后重新写回" };
      }
      await switchToDocument(target);
      await action.batchPlay([{ _obj: "paste" }], {});
      var placed = app.activeDocument.activeLayers[0];
      if (!placed) throw { code: "WRITEBACK_FAILED", message: "粘贴未产生图层" };
      if (layerName) { try { placed.name = layerName; } catch (e) { /* noop */ } }
      /* 关闭打开的临时结果文档 */
      try {
        var tmp2 = findDocumentById(openedId);
        if (tmp2) await tmp2.close(constants.SaveOptions.DONOTSAVECHANGES);
      } catch (e) { /* noop */ }
      return placed;
    });
  }

  /* PHASE 6: 选区原位定位 — Place 后读取 placedLayer 真实 bounds, 再计算 scale/translate。
   * 不假设放置位置在画布中心; 不使用当前选区 (用任务创建时记录的 selectionBounds)。 */
  function readLayerBounds(placed) {
    try {
      var b = placed.bounds;
      if (!b) return null;
      return { left: Math.round(b.left), top: Math.round(b.top), right: Math.round(b.right), bottom: Math.round(b.bottom) };
    } catch (e) { return null; }
  }

  async function positionPlacedLayer(placed, selectionBounds) {
    if (!selectionBounds) return; /* 无选区任务: 保持放置 */
    var b = selectionBounds;
    var targetW = Math.max(1, Math.round(b.right - b.left));
    var targetH = Math.max(1, Math.round(b.bottom - b.top));

    /* 1. 读真实放置 bounds */
    var actual = readLayerBounds(placed);
    if (!actual) return; /* bounds 不可读: 保持放置 */
    var actualW = Math.max(1, actual.right - actual.left);
    var actualH = Math.max(1, actual.bottom - actual.top);

    /* 2. 按真实尺寸缩放到原选区尺寸 (比例钳制, 防止极端值) */
    var scaleX = (targetW / actualW) * 100;
    var scaleY = (targetH / actualH) * 100;
    if (Math.abs(scaleX - 100) > 0.01 || Math.abs(scaleY - 100) > 0.01) {
      var sx = Math.min(4000, Math.max(0.1, scaleX));
      var sy = Math.min(4000, Math.max(0.1, scaleY));
      try { await placed.scale(sx, sy, constants.AnchorPosition.TOPLEFT); } catch (e) { /* scale 失败不阻塞 */ }
    }

    /* 3. 缩放后再读 bounds, 平移到原选区 left/top */
    var after = readLayerBounds(placed);
    if (after) {
      var dx = Math.round(b.left - after.left);
      var dy = Math.round(b.top - after.top);
      if (dx !== 0 || dy !== 0) {
        try { await placed.translate(dx, dy); } catch (e) { /* translate 失败不阻塞 */ }
      }
    }
  }

  function createResultGroup(groupName) {
    /* 官方 DOM: 图层组集合 */
    return app.activeDocument.layerGroups.add({ name: groupName || "AI Results" });
  }

  async function moveIntoGroup(placed, groupName) {
    if (!groupName) return;
    try {
      var doc = app.activeDocument;
      var groups = doc.layerGroups;
      for (var i = 0; i < groups.length; i++) {
        if (groups[i].name === groupName) { await placed.move(groups[i], constants.ElementPlacement.PLACEINSIDE); return; }
      }
      var g = await createResultGroup(groupName);
      await placed.move(g, constants.ElementPlacement.PLACEINSIDE);
    } catch (e) { /* 组创建失败不阻塞写回 */ }
  }

  /* PHASE 4: Helper Result Asset -> UXP 临时文件 -> sessionToken
   * 正式 UXP 写回使用 createSessionToken, 不把未经授权的 raw path 塞进 batchPlay */
  function materializeResult(assetId) {
    const req = (typeof window !== "undefined" && window.require) ? window.require : null;
    if (!req || !assetId) return Promise.reject({ code: "NO_UXP", message: "当前环境无法物化结果文件" });
    let lfs = null;
    try { lfs = req("uxp").storage.localFileSystem; } catch (e) { return Promise.reject({ code: "NO_UXP", message: "UXP localFileSystem 不可用" }); }
    return A4P.helper.assets.get(assetId).then(function (buf) {
      return lfs.getTemporaryFolder().then(function (folder) {
        const name = "a4p_result_" + String(assetId).slice(0, 8) + ".png";
        return folder.createFile(name, { overwrite: true }).then(function (file) {
          return file.write(buf).then(function () {
            return lfs.createSessionToken(file).then(function (token) {
              return { resultToken: token, resultPath: file.nativePath, resultFile: file };
            });
          });
        });
      });
    });
  }

  /* ---------- 写回入口 (plan 来自任务创建时的 snapshot) ---------- */
  function writeResult(plan) {
    if (!psOk) return Promise.reject({ code: "PHOTOSHOP_NOT_AVAILABLE", message: "写回需要 Photoshop 环境（当前为浏览器预览）" });
    var p = plan || {};
    if (!p.sourceDocumentId) return Promise.reject({ code: "WRITEBACK_TARGET_INVALID", message: "任务缺少 sourceDocumentId" });
    if (!p.resultPath) return Promise.reject({ code: "WRITEBACK_FAILED", message: "任务缺少结果文件 resultPath" });
    var strategy = p.strategy || "smartObject";
    /* UXP 正式路径: sessionToken 优先; 浏览器/dev 兼容 raw path */
    var resultRef = p.resultToken || p.resultPath;
    if (!resultRef) return Promise.reject({ code: "WRITEBACK_FAILED", message: "任务缺少结果文件 (resultToken/resultPath)" });

    /* 写回前验证 (不依赖 UI 状态, 直接查 Photoshop) */
    return validateWritebackTarget(p).then(function (v) {
      if (!v.ok) return Promise.reject({ code: v.code, message: v.message });

      return core.executeAsModal(async function () {
        var doc = findDocumentById(p.sourceDocumentId);
        if (!doc) throw { code: "PHOTOSHOP_DOCUMENT_NOT_FOUND", message: "源文档已关闭，结果保留在 Helper，可稍后重新写回" };
        await switchToDocument(doc);

        var placed;
        if (strategy === "pixelLayer") {
          placed = await placeAsPixelLayer(resultRef, p.layerName || "AI Result", p.sourceDocumentId);
        } else if (strategy === "newDocument") {
          /* 新文档: 直接打开结果图作为新文档 */
          await action.batchPlay([{ _obj: "open", "null": { _path: resultRef, _kind: "local" } }], {});
          var nd = app.activeDocument;
          if (p.layerName) nd.name = p.layerName;
          return { strategy: "newDocument", targetDocumentId: nd.id, layerId: null, layerName: nd.name, summary: "已创建新文档 " + nd.name };
        } else {
          /* 默认 NEW_SMART_OBJECT */
          placed = await placeAsSmartObject(resultRef, p.layerName || "AI Result");
        }

        /* 选区原位写回 (记录于任务创建时, 非当前选区; PHASE 6: 按真实 bounds 缩放平移) */
        if (p.selectionBounds && strategy !== "newDocument") {
          await positionPlacedLayer(placed, p.selectionBounds);
        }
        if (strategy !== "newDocument" && p.targetGroupName) {
          await moveIntoGroup(placed, p.targetGroupName);
        }

        return {
          strategy: strategy,
          targetDocumentId: p.sourceDocumentId,
          layerId: placed ? placed.id : null,
          layerName: placed ? placed.name : null,
          summary: "已" + (strategy === "pixelLayer" ? "创建像素图层" : "创建智能对象图层") + (placed && placed.name ? "：" + placed.name : "")
        };
      }, { commandName: "AI for PS: 写回 AI 结果" });
    });
  }

  /* ---------- 导出 ---------- */
  A4P.ps = {
    init: init,
    available: available,
    getContext: getContext,
    getDocuments: getDocuments,
    captureActiveLayer: captureActiveLayer,
    captureSelectedLayers: captureSelectedLayers,
    captureMergedVisible: captureMergedVisible,
    captureSelection: captureSelection,
    captureLayerMask: captureLayerMask,
    captureLayerMaskPixels: captureLayerMaskPixels,
    validateWritebackTarget: validateWritebackTarget,
    materializeResult: materializeResult,
    writeResult: writeResult
  };
})();
