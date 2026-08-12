/* jobs: RemoteJobStore —— 正式任务真相源 = Helper JobEngine (SQLite)
 * UXP 只做: 镜像缓存 (内存, 不写 localStorage) + WS job:update 实时同步 + 断线重同步
 * 提交/取消/重试/恢复 全部走 Helper REST; UXP 不再直连 ComfyUI /prompt /interrupt。
 * 旧链路 (A4P.comfyui 直连) 不再从正式 UI 调用; comfyui.js 仅保留给 dev-preview。 */
(function () {
  const STAGES = [
    "VALIDATING", "SNAPSHOTTING", "UPLOADING", "QUEUED", "RUNNING",
    "DOWNLOADING", "VERIFYING", "READY_FOR_WRITEBACK", "WRITING_BACK", "SUCCEEDED",
    "FAILED", "CANCELLED", "RECOVERING", "WRITEBACK_FAILED"
  ];
  const TERMINAL = { SUCCEEDED: true, FAILED: true, CANCELLED: true, WRITEBACK_FAILED: true };

  let jobs = [];          /* 镜像缓存 (仅内存) */
  let syncTimer = null;

  /* Helper 状态 -> UI 状态 */
  function mapStatus(s) {
    switch (s) {
      case "created": case "validating": return "VALIDATING";
      case "snapshotting": return "SNAPSHOTTING";
      case "uploading": return "UPLOADING";
      case "queued": return "QUEUED";
      case "running": return "RUNNING";
      case "downloading": return "DOWNLOADING";
      case "result_ready": case "writeback_pending": return "READY_FOR_WRITEBACK";
      case "writing_back": return "WRITING_BACK";
      case "completed": return "SUCCEEDED";
      case "cancel_requested": case "cancelled": return "CANCELLED";
      case "retryable_writeback_failure": return "WRITEBACK_FAILED";
      case "provider_failure": case "download_failure": case "rollback_uncertain": case "failed": return "FAILED";
      default: return "RECOVERING";
    }
  }

  function stageTextOf(status) {
    switch (status) {
      case "VALIDATING": return "参数校验与能力预检";
      case "SNAPSHOTTING": return "读取 Photoshop 图层快照";
      case "UPLOADING": return "上传输入资产到 Helper";
      case "QUEUED": return "已在任务队列 (Helper 调度)";
      case "RUNNING": return "Provider 执行中";
      case "DOWNLOADING": return "下载结果到 Asset Store";
      case "READY_FOR_WRITEBACK": return "结果已缓存，可写回";
      case "WRITING_BACK": return "正在写入 Photoshop…";
      case "SUCCEEDED": return "已完成";
      case "WRITEBACK_FAILED": return "写回失败，结果已保留，可仅重新写回";
      case "CANCELLED": return "已取消";
      case "FAILED": return "失败";
      default: return "恢复中";
    }
  }

  function emit(job) {
    A4P.store.emit("jobs:update", job);
    if (job.status === "READY_FOR_WRITEBACK" || job.status === "SUCCEEDED") A4P.store.emit("jobs:ready", job);
  }

  /* Helper job -> UI 镜像 */
  function toMirror(hj) {
    let resultAssets = [];
    try { resultAssets = JSON.parse(hj.result_assets_json || "[]"); } catch (e) { /* noop */ }
    const m = {
      id: hj.id,
      helperId: hj.id,
      remoteId: hj.remote_job_id || null,
      status: mapStatus(hj.status),
      stageText: hj.stage_text || stageTextOf(mapStatus(hj.status)),
      progress: hj.progress != null ? Math.round(hj.progress) : 0,
      label: hj.title || "AI 任务",
      title: hj.title || "AI 任务",
      kind: "image",
      tool: "生成",
      payload: (function () { try { return { inputs: JSON.parse(hj.inputs_json || "{}"), parameters: JSON.parse(hj.parameters_json || "{}") }; } catch (e) { return {}; } })(),
      provider: hj.provider_id || "local-comfy",
      providerType: hj.provider_type || null,
      workflowId: hj.workflow_id || null,
      projectId: hj.project_id || null,
      createdAt: hj.created_at || Date.now(),
      updatedAt: hj.updated_at || Date.now(),
      durationMs: hj.duration_ms || null,
      error: (function () { try { return hj.error_json ? JSON.parse(hj.error_json) : null; } catch (e) { return null; } })(),
      results: [],
      _resultAssetIds: resultAssets,
      _remote: true
    };
    /* 错误码映射: Helper 错误 -> UI 展示 */
    if (m.error) {
      if (!m.error.code && m.error.message) m.error.code = m.error.message.split(":")[0] || "UNKNOWN";
      if (!m.stageText || m.status === "FAILED") m.stageText = "执行失败：" + (m.error.message || m.error.code || "");
    }
    return m;
  }

  function upsert(mirror) {
    const i = jobs.findIndex(function (j) { return j.id === mirror.id || j.helperId === mirror.id; });
    if (i >= 0) {
      /* 合并到现有条目: 保留 UI 引用稳定的 id, 更新其余字段 */
      const existing = jobs[i];
      const keepId = existing.id !== mirror.id ? existing.id : mirror.id;
      Object.keys(mirror).forEach(function (k) { existing[k] = mirror[k]; });
      existing.id = keepId;
      return existing;
    }
    jobs.unshift(mirror);
    while (jobs.length > 300) jobs.pop();
    return mirror;
  }

  /* 断线/启动重同步: GET /v1/jobs (不重提交) */
  function refresh() {
    if (!A4P.helper || !A4P.helper.jobs || !A4P.helper.jobs.list) return Promise.resolve(0);
    return A4P.helper.jobs.list({ limit: 200 }).then(function (r) {
      if (!r || !Array.isArray(r.jobs)) return 0;
      const seen = {};
      r.jobs.forEach(function (hj) {
        seen[hj.id] = true;
        const m = upsert(toMirror(hj));
        loadThumbs(m);
        emit(m);
      });
      jobs = jobs.filter(function (j) { return seen[j.id] || !j._remote; });
      return r.jobs.length;
    }).catch(function () { return 0; });
  }

  /* 结果缩略图: Helper Asset -> Blob URL (仅显示用, 不持久化) */
  function loadThumbs(mirror) {
    if (!mirror._resultAssetIds || !mirror._resultAssetIds.length) return;
    mirror.results = mirror._resultAssetIds.map(function (assetId, i) {
      return { resultId: "res-" + assetId.slice(0, 8), assetId: assetId, filename: "result-" + (i + 1) + ".png", label: "结果 " + (i + 1), favorite: i === 0, thumb: null, _loading: true };
    });
    mirror._resultAssetIds.forEach(function (assetId, i) {
      A4P.helper.assets.get(assetId).then(function (bytes) {
        const r = mirror.results[i];
        if (!r) return;
        try {
          const blob = new Blob([bytes], { type: "image/png" });
          r.thumb = URL.createObjectURL(blob);
          r.blob = blob;
        } catch (e) { /* noop */ }
        r._loading = false;
        emit(mirror);
      }).catch(function () { if (mirror.results[i]) mirror.results[i]._loading = false; });
    });
  }

  /* WS job:update (Helper -> UXP) */
  function onRemoteUpdate(hj) {
    if (!hj || !hj.id) return;
    const m = upsert(toMirror(hj));
    if (hj.status === "result_ready" || hj.status === "completed") loadThumbs(m);
    emit(m);
    if (hj.status === "completed" || hj.status === "result_ready") {
      try {
        A4P.store.pushHistory({
          id: hj.id, createdAt: hj.created_at || Date.now(), label: hj.title || "AI 任务", version: 1,
          projectId: hj.project_id || null,
          payload: m.payload || {},
          outputs: m.results.map(function (r) { return { thumb: r.thumb, label: r.label, assetId: r.assetId }; })
        });
      } catch (e) { /* noop */ }
      A4P.store.emit("jobs:result", { jobId: hj.id, results: m.results });
    }
  }

  /* ---------- API (签名与旧版兼容, UI 零改动) ---------- */
  function create(params) {
    /* 立即返回 pending 镜像; 真实提交到 Helper, 成功后替换为 Helper job id */
    const local = {
      id: A4P.utils.uid("task"), label: params.label || "AI 任务", title: params.title || params.label || "AI 任务",
      kind: params.kind || "image", status: "DRAFT", provider: params.providerId || params.provider || "local-comfy",
      createdAt: Date.now(), updatedAt: Date.now(), progress: 0,
      stageText: "提交到 Helper…", results: [], error: null, remoteId: null, _pending: true
    };
    jobs.unshift(local);
    emit(local);

    const payload = {
      providerId: params.providerId || mapUiProvider(params.provider || "comfyui"),
      modelId: params.modelId || undefined,
      workflowId: params.workflowId || undefined,
      inputs: params.inputs || {},
      parameters: params.parameters || {},
      sourceDocumentId: params.sourceDocumentId || null,
      sourceDocumentName: params.sourceDocumentName || null,
      sourceDocumentPath: params.sourceDocumentPath || null,
      sourceLayerIds: params.sourceLayerIds || null,
      selectionBounds: params.selectionBounds || null,
      canvasWidth: params.canvasWidth || null,
      canvasHeight: params.canvasHeight || null,
      colorMode: params.colorMode || null,
      bitDepth: params.bitDepth || null,
      projectId: params.projectId || null,
      snapshot: params.snapshot || null
    };

    if (!A4P.helper || !A4P.helper.jobs || !A4P.helper.jobs.create) {
      const e = { code: "HELPER_OFFLINE", message: "Helper 未连接，无法提交任务" };
      local.status = "FAILED"; local.error = e; local.stageText = "执行失败：" + e.message;
      emit(local);
      return local;
    }
    A4P.helper.jobs.create(payload).then(function (r) {
      if (r && r.error) throw { code: r.error.code || "HELPER_REJECTED", message: r.error.message || "Helper 拒绝任务" };
      if (!r || !r.job || !r.job.id) throw { code: "HELPER_BAD_RESPONSE", message: "Helper 未返回任务" };
      /* 用 Helper id 更新本地 pending 镜像 (本地 id 保持不变, UI 引用稳定) */
      const mirror = upsert(toMirror(r.job));
      local.helperId = mirror.id;
      Object.keys(mirror).forEach(function (k) { if (k !== "id" && k !== "helperId") local[k] = mirror[k]; });
      local._pending = false;
      emit(local);
    }).catch(function (err) {
      if (local.status === "DRAFT" || local._pending) {
        local._pending = false;
        local.status = "FAILED";
        local.error = { code: err.code || "HELPER_ERROR", message: err.message || String(err) };
        local.stageText = "执行失败：" + (err.message || String(err));
        emit(local);
      }
    });
    return local;
  }

  /* UI provider id -> Helper provider id (规则十: UXP 只发 providerId) */
  function mapUiProvider(uiId) {
    const MAP = { comfyui: "local-comfy", openai: "openai-compatible", gemini: "gemini", volcengine: "volcengine", bailian: "bailian", runninghub: "runninghub", modelscope: "modelscope" };
    return MAP[uiId] || uiId;
  }

  function find(id) { return jobs.find(function (j) { return j.id === id; }) || null; }
  function list(filter) {
    let out = jobs;
    if (filter && filter.projectId) out = out.filter(function (j) { return j.projectId === filter.projectId; });
    return out;
  }
  function active() { return jobs.filter(function (j) { return !TERMINAL[j.status]; }).length; }
  function clear() { jobs = []; A4P.store.emit("jobs:cleared"); }
  function metaOf(job) {
    if (!job) return { label: "—", stage: "—", eta: "—" };
    return {
      label: A4P.t("js_" + job.status) || job.status,
      stage: job.stageText || "—",
      eta: job.status === "READY_FOR_WRITEBACK" || job.status === "SUCCEEDED" ? "完成" : "运行中"
    };
  }

  function cancel(job) {
    if (!job) return Promise.resolve();
    if (job._pending || job.status === "DRAFT") {
      job.status = "CANCELLED"; job.stageText = "用户已取消"; emit(job);
      return Promise.resolve();
    }
    if (!A4P.helper || !A4P.helper.jobs || !A4P.helper.jobs.cancel) return Promise.resolve();
    return A4P.helper.jobs.cancel(job.helperId || job.id).then(function (r) {
      if (r && r.job) onRemoteUpdate(r.job);
      else if (r && r.error) { job.error = r.error; emit(job); }
      return r;
    }).catch(function () { /* helper offline: 本地保持 */ });
  }

  function retry(job) {
    if (!job) return Promise.resolve();
    if (!A4P.helper || !A4P.helper.jobs || !A4P.helper.jobs.retry) return Promise.resolve();
    return A4P.helper.jobs.retry(job.helperId || job.id).then(function (r) {
      if (r && r.job) onRemoteUpdate(r.job);
      else if (r && r.error) { job.error = r.error; emit(job); }
      return r;
    }).catch(function () { /* noop */ });
  }

  /* 写回: 真实 Photoshop 写回 (bridge) -> 成功后再通知 Helper 置 completed
   * AI 成功与写回成功严格分离: 写回失败 -> WRITEBACK_FAILED, 结果保留 */
  function writeback(job, plan) {
    if (!job) return Promise.reject({ code: "JOB_NOT_FOUND" });
    if (job.status !== "READY_FOR_WRITEBACK" && job.status !== "SUCCEEDED" && job.status !== "WRITEBACK_FAILED") {
      return Promise.reject({ code: "NOT_READY", message: "任务尚未就绪" });
    }
    job.status = "WRITING_BACK"; job.stageText = "正在写入 Photoshop…"; emit(job);
    /* PHASE 4: 结果资产 -> UXP 临时文件 + sessionToken (正式写回不传未经授权的 raw path) */
    var prep = (plan.resultPath || plan.resultToken)
      ? Promise.resolve(plan)
      : ((A4P.ps && A4P.ps.materializeResult && plan.resultAssetId)
        ? A4P.ps.materializeResult(plan.resultAssetId).then(function (m) {
            return Object.assign({}, plan, { resultToken: m.resultToken, resultPath: m.resultPath });
          }).catch(function (e) {
            throw { code: e.code || "WRITEBACK_FAILED", message: "结果文件物化失败：" + (e.message || "") };
          })
        : Promise.reject({ code: "WRITEBACK_FAILED", message: "缺少结果文件 (resultAssetId 不可用)" }));
    return prep.then(function (p2) {
      return (A4P.ps.writeResult ? A4P.ps.writeResult(p2) : Promise.reject({ code: "NO_BRIDGE", message: "当前环境无 Photoshop Bridge" }));
    }).then(function (info) {
        const notify = A4P.helper && A4P.helper.jobs && A4P.helper.jobs.writeback
          ? A4P.helper.jobs.writeback(job.helperId || job.id, { writeback: { strategy: plan.strategy || "smartObject", layerId: info.layerId || null, layerName: info.layerName || null, summary: info.summary || null } })
          : Promise.resolve({ ok: true });
        return notify.then(function () {
          job.status = "SUCCEEDED"; job.stageText = "已完成 · " + (info.summary || ""); job.writebackInfo = info;
          emit(job);
          return job;
        });
      })
      .catch(function (err) {
        job.status = "WRITEBACK_FAILED"; job.stageText = "写回失败，结果已保留，可仅重新写回"; job.error = err || { code: "WRITEBACK_FAILED" };
        emit(job);
        throw err;
      });
  }

  /* 启动时: 从 Helper 重同步 (规则十五: 有 remoteJobId 先查远端, 不重提交) */
  function recoverAll() {
    return refresh();
  }
  function restore() { return 0; }
  function persist() { /* 不再写 localStorage */ }
  function restoreThumbs() { /* noop */ }

  A4P.jobs = {
    STAGES: STAGES, TERMINAL: TERMINAL,
    create: create, find: find, get: find, list: list, all: list, active: active, clear: clear, metaOf: metaOf,
    start: function () { /* no-op: 任务已由 Helper 驱动 */ }, run: function () { /* no-op */ },
    cancel: cancel, retry: retry, writeback: writeback,
    restore: restore, recoverAll: recoverAll, persist: persist, restoreThumbs: restoreThumbs,
    refresh: refresh, onRemoteUpdate: onRemoteUpdate, mapStatus: mapStatus,
    _raw: function () { return jobs; }
  };
})();
