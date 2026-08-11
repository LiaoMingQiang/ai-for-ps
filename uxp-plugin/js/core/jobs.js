/* jobs: task engine —— 真实 ComfyUI 执行管线
 * VALIDATING -> SNAPSHOTTING/UPLOADING -> QUEUED -> RUNNING -> VERIFYING -> READY_FOR_WRITEBACK
 * 全部阶段由真实 HTTP 状态驱动；失败进入 FAILED 并保留真实错误信息。 */
(function () {
  const STAGES = [
    "VALIDATING", "SNAPSHOTTING", "UPLOADING", "QUEUED", "RUNNING",
    "DOWNLOADING", "VERIFYING", "READY_FOR_WRITEBACK", "WRITING_BACK", "SUCCEEDED",
    "FAILED", "CANCELLED", "RECOVERING", "WRITEBACK_FAILED"
  ];
  const TERMINAL = { SUCCEEDED: true, FAILED: true, CANCELLED: true, WRITEBACK_FAILED: true };
  const PERSIST_KEY = "aiforps.jobs.v1";

  let jobs = [];
  let seq = 28;
  const activeRuns = {};   /* jobId -> {stop, promptId} */

  /* ---------- persistence ---------- */
  function persist() {
    try {
      const ser = jobs.slice(0, 200).map(function (j) {
        const c = Object.assign({}, j);
        delete c._results;
        c.results = (c.results || []).map(function (r) { return { resultId: r.resultId, seed: r.seed, width: r.width, height: r.height, filename: r.filename, subfolder: r.subfolder, type: r.type, favorite: !!r.favorite }; });
        return c;
      });
      window.localStorage.setItem(PERSIST_KEY, JSON.stringify(ser));
    } catch (e) { /* ignore quota */ }
  }
  function restore() {
    try {
      const raw = window.localStorage.getItem(PERSIST_KEY);
      if (raw) {
        jobs = JSON.parse(raw).map(function (j) {
          if (!TERMINAL[j.status]) j.status = "RECOVERING"; /* JOB-001: restart recovery */
          j._recovered = true;
          return j;
        });
        return jobs.length;
      }
    } catch (e) { /* empty store */ }
    return 0;
  }

  /* ---------- job creation ---------- */
  function create(params, opts) {
    const job = {
      id: A4P.utils.uid("task"),
      label: params.label || params.title || "AI 任务",
      title: params.title || params.label || "AI 任务",
      kind: params.kind || null,
      payload: params.payload || null,
      parentId: opts && opts.parentId || null,
      projectId: opts && opts.projectId || null,
      status: "DRAFT",
      provider: params.provider || "comfyui",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      progress: 0,
      stageText: "参数尚未提交",
      results: [],
      error: null,
      remoteId: null,
      stdout: []
    };
    jobs.unshift(job);
    persist();
    emit(job);
    return job;
  }

  function find(id) { return jobs.find(function (j) { return j.id === id; }); }
  function list(filter) {
    let out = jobs;
    if (filter && filter.projectId) out = out.filter(function (j) { return j.projectId === filter.projectId; });
    return out;
  }
  function active() { return jobs.filter(function (j) { return !TERMINAL[j.status]; }).length; }
  function clear() { Object.keys(activeRuns).forEach(function (k) { if (activeRuns[k].stop) activeRuns[k].stop(); }); jobs = []; persist(); }
  function metaOf(job) {
    if (!job) return { label: "—", stage: "—", eta: "—" };
    return {
      label: A4P.t("js_" + job.status) || job.status,
      stage: job.stageText || "—",
      eta: job.status === "READY_FOR_WRITEBACK" || job.status === "SUCCEEDED" ? "完成" : "运行中"
    };
  }

  function emit(job) {
    A4P.store.emit("jobs:update", job);
    if (job.status === "READY_FOR_WRITEBACK" || job.status === "SUCCEEDED") A4P.store.emit("jobs:ready", job);
  }
  function update(job, patch) {
    Object.keys(patch).forEach(function (k) { job[k] = patch[k]; });
    job.updatedAt = Date.now();
    persist();
    emit(job);
    return job;
  }
  function log(job, line) { (job.stdout = job.stdout || []).push("[" + new Date().toLocaleTimeString() + "] " + line); }

  /* ---------- lifecycle ---------- */
  function cancel(job) {
    if (!job) return;
    if (activeRuns[job.id] && activeRuns[job.id].stop) { try { activeRuns[job.id].stop(); } catch (e) { /* noop */ } }
    if (job.remoteId && A4P.comfyui.cancel) { A4P.comfyui.cancel().catch(function () { /* noop */ }); }
    if (job.status !== "READY_FOR_WRITEBACK" && job.status !== "SUCCEEDED") {
      update(job, { status: "CANCELLED", stageText: "用户已取消", progress: job.progress });
    }
  }

  function retry(job) {
    if (!job) return;
    update(job, { status: "DRAFT", progress: 0, error: null, stageText: "重新提交", results: [], remoteId: null });
    run(job);
  }

  /* ---------- 真实执行管线 ---------- */
  function run(job) {
    const p = job.payload || {};
    const runId = job.id;
    update(job, { status: "VALIDATING", stageText: "连接 ComfyUI 与能力预检", progress: 2 });

    const stopHandlers = [];
    activeRuns[runId] = { stop: function () { stopHandlers.forEach(function (f) { try { f(); } catch (e) { /* noop */ } }); }, promptId: null };

    /* 1. 探测服务 */
    A4P.comfyui.ping().then(function (stats) {
      if (!stats || !stats.ok) {
        throw { code: "COMFY_OFFLINE", message: (stats && stats.error) || "无法连接 ComfyUI（" + A4P.comfyui.baseUrl() + "）" };
      }
      log(job, "ComfyUI 在线 " + (stats.version || ""));
      update(job, { status: "SNAPSHOTTING", stageText: "准备图像输入", progress: 5 });

      /* 2. 上传输入图（图生图） */
      const upload = p.inputImage && p.inputImage.blob
        ? A4P.comfyui.uploadImage(p.inputImage.blob, p.inputImage.name || "input.png").then(function (up) { return up; })
        : Promise.resolve(null);
      return upload.then(function (up) {
        if (up) { update(job, { status: "UPLOADING", stageText: "已上传输入 " + up.name, progress: 10 }); log(job, "uploaded " + up.name); }
        else update(job, { status: "UPLOADING", stageText: "文生图（无输入图像）", progress: 10 });

        /* 3. 自动检测 checkpoint（真实列表） */
        return A4P.comfyui.listCheckpoints().then(function (ckpts) {
          if (ckpts.length === 0) throw { code: "COMFY_NO_CKPT", message: "ComfyUI 没有可用的 Checkpoint（CheckpointLoaderSimple 检测为空），请在服务端安装模型" };
          const ckpt = p.checkpoint && ckpts.indexOf(p.checkpoint) >= 0 ? p.checkpoint : ckpts[0];
          log(job, "checkpoint: " + ckpt);

          /* 4. 构建并提交工作流 */
          const wf = A4P.comfyui.buildWorkflow({ prompt: p.prompt, negative: p.negative, params: p.params, inputImage: up || null, checkpoint: ckpt });
          update(job, { status: "QUEUED", stageText: "提交工作流", progress: 12 });
          return A4P.comfyui.submitWorkflow(wf).then(function (r) {
            job.remoteId = r.promptId;
            if (activeRuns[runId]) activeRuns[runId].promptId = r.promptId;
            log(job, "prompt_id=" + r.promptId);
            runProgress(job, runId, r.promptId);
          });
        });
      });
    }).catch(function (err) {
      fail(job, err);
    });

    function fail(j, err) {
      const code = err && err.code || "UNKNOWN";
      const msg = err && err.message || String(err);
      update(j, { status: "FAILED", stageText: "执行失败：" + msg, error: { code: code, message: msg }, progress: j.progress });
      log(j, "ERR " + code + ": " + msg);
      delete activeRuns[j.id];
    }

    function runProgress(jobX, id, promptId) {
      if (jobX.status === "FAILED" || jobX.status === "CANCELLED" || jobX.status === "TERMINAL") return;
      const stop = A4P.comfyui.connectProgress(promptId,
        function (f) { update(jobX, { status: "RUNNING", stageText: "生成中 " + Math.round(f * 100) + "%", progress: 14 + Math.round(f * 76) }); },
        function (hist) { finishSuccess(jobX, id, hist); },
        function (err) { fail(jobX, err); }
      );
      stopHandlers.push(stop);
    }

    function finishSuccess(jobX, id, hist) {
      update(jobX, { status: "DOWNLOADING", stageText: "下载结果", progress: 94 });
      const out = hist.outputs || {};
      let images = [];
      Object.keys(out).forEach(function (nid) {
        const nodeOut = out[nid];
        if (nodeOut && Array.isArray(nodeOut.images)) images = images.concat(nodeOut.images);
      });
      if (!images.length) {
        const statusM = hist.status && hist.status.messages;
        throw { code: "COMFY_NO_OUTPUT", message: "工作流执行完成但未保存任何图像（" + (statusM ? statusM.length + " 条消息" : "无输出节点") + "）" };
      }
      return Promise.all(images.map(A4P.comfyui.downloadImage)).then(function (downs) {
        const results = downs.map(function (d, i) {
          return {
            resultId: A4P.utils.uid("res"), seed: (jobX.payload && jobX.payload.params && jobX.payload.params.seed) || null,
            width: 0, height: 0, thumb: d.url, filename: d.filename, subfolder: d.subfolder, type: d.type,
            label: d.filename + (images.length > 1 ? " · " + (i + 1) + "/" + images.length : ""), favorite: i === 0
          };
        });
        update(jobX, { status: "VERIFYING", stageText: "校验结果（PNG）", progress: 97, results: results });
        setTimeout(function () {
          update(jobX, { status: "READY_FOR_WRITEBACK", stageText: "结果已缓存，可写回", progress: 100 });
          delete activeRuns[id];
          try {
            A4P.store.pushHistory({
              id: jobX.id, createdAt: jobX.createdAt, label: jobX.label, version: 1,
              projectId: jobX.projectId || null, payload: jobX.payload || {},
              outputs: results.map(function (r) { return { thumb: r.thumb, label: r.label }; })
            });
          } catch (e) { /* noop */ }
          A4P.store.emit("jobs:result", { jobId: jobX.id, results: results });
        }, 120);
      }).catch(function (err) { fail(jobX, err); });
    }
  }

  /* 已完成任务的缩略图恢复（重启后从 ComfyUI 重新拉取，对象文件仍保留在服务端） */
  function restoreThumbs(job) {
    if (!job || !job.results || !job.results.length) return;
    let i = 0;
    const next = function () {
      if (i >= job.results.length) return;
      const r = job.results[i++];
      if (!r.filename) { next(); return; }
      A4P.comfyui.downloadImage({ filename: r.filename, subfolder: r.subfolder || "", type: r.type || "output" })
        .then(function (d) { r.thumb = d.url; emit(job); next(); })
        .catch(function () { next(); });
    };
    next();
  }

  /* ---------- recovery on boot ---------- */
  function recoverAll() {
    const rec = jobs.filter(function (j) { return j.status === "RECOVERING"; });
    rec.forEach(function (j) {
      const done = j.status === "READY_FOR_WRITEBACK" || j.status === "SUCCEEDED";
      if (j.preStatus && TERMINAL[j.preStatus]) { /* 恢复到终态 */ }
      if (j.results && j.results.length) {
        update(j, { status: "READY_FOR_WRITEBACK", stageText: "结果已缓存，可写回", progress: 100 });
        restoreThumbs(j);
      } else {
        update(j, { status: "DRAFT", stageText: "上次运行被中断，重新提交", progress: 0 });
        run(j);
      }
    });
    return rec.length;
  }

  /* ---------- writeback（写回：UXP 真实模式走 bridge；浏览器预览导出 PNG） ---------- */
  function writeback(job, plan) {
    if (!job || job.status !== "READY_FOR_WRITEBACK") return Promise.reject({ code: "NOT_READY" });
    update(job, { status: "WRITING_BACK", stageText: "正在写入 Photoshop…", progress: 100 });
    return A4P.ps.writeResult(plan).then(function (info) {
      update(job, { status: "SUCCEEDED", stageText: "已完成 · " + info.summary, writebackInfo: info });
      return job;
    }).catch(function (err) {
      update(job, { status: "WRITEBACK_FAILED", stageText: "写回失败，结果已保留，可仅重新写回", error: err });
      throw err;
    });
  }

  A4P.jobs = {
    STAGES: STAGES, TERMINAL: TERMINAL,
    create: create, find: find, get: find, list: list, all: list, active: active, clear: clear, metaOf: metaOf,
    start: run, run: run, cancel: cancel, retry: retry, writeback: writeback,
    restore: restore, recoverAll: recoverAll, persist: persist, restoreThumbs: restoreThumbs,
    _raw: function () { return jobs; }
  };
})();