/* comfyui-client: 真实 ComfyUI 接入 —— ping / object_info / 上传 / 提交 / 进度(WS+轮询) / 下载结果
 * 全部为真实 HTTP 调用；服务不可达时抛出明确错误，不做假进度。 */
(function () {
  function baseUrl() {
    const u = A4P.settings.get("connection", "comfyuiUrl");
    if (u && String(u).indexOf("http") === 0) return String(u).replace(/\/+$/, "");
    return "http://127.0.0.1:8188";
  }
  function setEndpoint(url) {
    A4P.settings.set("connection", "comfyuiUrl", String(url).replace(/\/+$/, ""));
  }
  A4P.comfyui = A4P.comfyui || {};
  A4P.comfyui.setEndpoint = setEndpoint;

  function req(path, opts, json) {
    return fetch(baseUrl() + path, opts).then(function (r) {
      if (!r.ok) return r.text().then(function (t) {
        throw { code: "COMFY_HTTP_" + r.status, message: path + " -> " + r.status + " " + t.slice(0, 200), body: t };
      });
      const ct = r.headers.get("content-type") || "";
      if (json === false) return r.arrayBuffer();
      if (ct.indexOf("json") >= 0) return r.json();
      return r.arrayBuffer();
    });
  }

  /* ---- 探测 ---- */
  let lastState = { ok: false, error: "未检测" };
  function ping() {
    return req("/system_stats", {}, false).then(function (buf) {
      let j;
      try {
        j = JSON.parse(new TextDecoder().decode(buf));
        lastState = { ok: true, version: j.system && j.system.comfyui_version, vram: j.devices && j.devices[0] && j.devices[0].vram_total, deviceName: j.devices && j.devices[0] && j.devices[0].name };
      } catch (e) { lastState = { ok: true }; }
      return lastState;
    }).catch(function (e) {
      lastState = { ok: false, error: e && e.message || "无法连接 ComfyUI" };
      return lastState;
    });
  }

  let objInfoCache = null;
  function objectInfo(force) {
    if (objInfoCache && !force) return Promise.resolve(objInfoCache);
    return req("/object_info", {}, false).then(function (buf) {
      objInfoCache = JSON.parse(new TextDecoder().decode(buf));
      return objInfoCache;
    });
  }

  function listCheckpoints() {
    return objectInfo().then(function (info) {
      const node = info && info.CheckpointLoaderSimple;
      const list = node && node.input && node.input.required && node.input.required.ckpt_name;
      if (Array.isArray(list) && list.length) return list.map(function (x) { return x[0]; });
      if (Array.isArray(list)) return list;
      return [];
    }).catch(function () { return []; });
  }

  function listSamplers() {
    return objectInfo().then(function (info) {
      const n = info && info.KSampler;
      const s = n && n.input && n.input.required && n.input.required.sampler_name;
      return Array.isArray(s) ? s.map(function (x) { return x[0]; }) : [];
    }).catch(function () { return []; });
  }

  /* ---- 工作流构建：真实 ComfyUI API JSON（t2i / i2i） ---- */
  function parseSize(s, maxSide) {
    const m = String(s || "1024 × 1024").match(/(\d+)\s*[x×X*]\s*(\d+)/);
    let w = 1024, h = 1024;
    if (m) { w = Number(m[1]); h = Number(m[2]); }
    maxSide = maxSide || 2048;
    if (w > maxSide || h > maxSide) { const k = maxSide / Math.max(w, h); w = Math.round(w * k); h = Math.round(h * k); }
    w = Math.max(64, Math.round(w / 8) * 8); h = Math.max(64, Math.round(h / 8) * 8);
    return { width: w, height: h };
  }

  function buildWorkflow(p) {
    const pp = p.params || {};
    const dim = parseSize(pp.size);
    const seed = pp.seed || Math.floor(Math.random() * 1e8);
    const ckpt = p.checkpoint || "checkpoints.json 自动检测";
    const negText = (p.negative && p.negative.trim()) ? p.negative : "lowres, bad anatomy, watermark, jpeg artifacts";
    const wf = {
      "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: ckpt } },
      "6": { class_type: "CLIPTextEncode", inputs: { text: p.prompt || "", clip: ["4", 1] } },
      "7": { class_type: "CLIPTextEncode", inputs: { text: negText, clip: ["4", 1] } }
    };
    if (p.inputImage) {
      /* 图生图：LoadImage -> VAEEncode -> KSampler */
      wf["1"] = { class_type: "LoadImage", inputs: { image: p.inputImage.name, upload: p.inputImage.upload } };
      wf["2"] = { class_type: "VAEEncode", inputs: { pixels: ["1", 0], vae: ["4", 2] } };
      wf["3"] = {
        class_type: "KSampler",
        inputs: {
          seed: seed, steps: pp.steps || 28, cfg: pp.cfg || 4.5,
          sampler_name: pp.sampler || "euler", scheduler: pp.scheduler || "normal",
          denoise: pp.denoise == null ? 0.35 : pp.denoise,
          model: ["4", 0], positive: ["6", 0], negative: ["7", 0], latent_image: ["2", 0]
        }
      };
    } else {
      /* 文生图：EmptyLatentImage -> KSampler */
      wf["5"] = { class_type: "EmptyLatentImage", inputs: { width: dim.width, height: dim.height, batch_size: pp.batch || 1 } };
      wf["3"] = {
        class_type: "KSampler",
        inputs: {
          seed: seed, steps: pp.steps || 28, cfg: pp.cfg || 4.5,
          sampler_name: pp.sampler || "euler", scheduler: pp.scheduler || "normal",
          denoise: pp.denoise == null ? 1 : pp.denoise,
          model: ["4", 0], positive: ["6", 0], negative: ["7", 0], latent_image: ["5", 0]
        }
      };
    }
    wf["8"] = { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["4", 2] } };
    wf["9"] = { class_type: "SaveImage", inputs: { images: ["8", 0], filename_prefix: "aiforps" } };
    return wf;
  }

  function uploadImage(blob, name) {
    const form = new FormData();
    form.append("image", blob, name || "input.png");
    return req("/upload/image", { method: "POST", body: form }).then(function (j) {
      return { name: j.name || name, subfolder: j.subfolder || "", type: j.type || "input", upload: !!j.upload };
    });
  }

  function submitWorkflow(wf) {
    return req("/prompt", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: wf }) })
      .then(function (j) {
        if (j.node_errors && Object.keys(j.node_errors).length) {
          const k = Object.keys(j.node_errors)[0];
          throw { code: "COMFY_NODE_ERROR", message: "工作流节点错误 " + k + ": " + JSON.stringify(j.node_errors[k]).slice(0, 200) };
        }
        return { promptId: j.prompt_id };
      })
      .catch(function (e) {
        /* ComfyUI 对坏节点返回 400 + node_errors：解析为可读的节点错误 */
        if (e && e.code === "COMFY_HTTP_400" && e.body) {
          let k = null;
          try {
            const j = JSON.parse(e.body);
            if (j && j.node_errors && Object.keys(j.node_errors).length) k = Object.keys(j.node_errors)[0];
          } catch (x) { /* 非 JSON 错误体，原样抛出 */ }
          if (k) throw { code: "COMFY_NODE_ERROR", message: "工作流节点错误 " + k + ": " + JSON.stringify(JSON.parse(e.body).node_errors[k]).slice(0, 200) };
        }
        throw e;
      });
  }

  function cancel() { return req("/interrupt", { method: "POST" }); }

  /* ---- 进度：优先 WS，自动回退轮询 ---- */
  function parseProgress(message) {
    if (!message || !message.data) return null;
    const data = message.data;
    if (data.prompt_id === undefined || !data.value) return null;
    const cur = data.value[0] || {};
    if (!cur.max) return null;
    return Math.min(0.99, (cur.value || 0) / cur.max);
  }

  function fetchHistory(promptId) { return req("/history/" + promptId, {}, false).then(function (b) { return JSON.parse(new TextDecoder().decode(b)); }); }

  function connectProgress(promptId, onProgress, onDone, onError, timeoutMs) {
    let ws = null, pollTimer = null, pollCount = 0, finished = false;
    timeoutMs = timeoutMs || 10 * 60 * 1000;
    const startAt = Date.now();

    function finish() {
      if (ws) { try { ws.close(); } catch (e) { /* noop */ } ws = null; }
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    }

    function checkDone() {
      if (finished) return;
      if (Date.now() - startAt > timeoutMs) { finished = true; finish(); onError({ code: "COMFY_TIMEOUT", message: "生成超时（" + timeoutMs / 1000 + "s）" }); return; }
      return fetchHistory(promptId).then(function (hist) {
        const h = hist[promptId];
        if (h && h.status) {
          if (h.status.status_str === "success") { finished = true; finish(); onDone(h); }
          else if (h.status.status_str === "error" || h.status.status_str === "cancelled") {
            finished = true; finish();
            onError({ code: "COMFY_EXEC_" + h.status.status_str, message: "ComfyUI 执行" + h.status.status_str + (h.status.messages ? ": " + h.status.messages.map(function (m) { return m[1] && m[1].message || ""; }).join("; ") : "") });
          }
        }
      }).catch(function () { /* 继续轮询 */ });
    }

    const startPoll = function () {
      pollTimer = setInterval(function () {
        pollCount++;
        checkDone().catch(function () { /* noop */ });
      }, 1000);
    };

    try {
      if (typeof WebSocket === "undefined") { startPoll(); return finish; }
      const wsu = baseUrl().replace(/^http/, "ws") + "/ws?clientId=aiforps";
      ws = new WebSocket(wsu);
      ws.onopen = function () { try { ws.send(JSON.stringify({ type: "watch", prompt_id: promptId })); } catch (e) { /* noop */ } };
      ws.onmessage = function (ev) {
        let msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
        const p = parseProgress(msg);
        if (p !== null) onProgress(p);
        if (msg.type === "executed" && msg.data && msg.data.prompt_id === promptId) {
          try { ws.send(JSON.stringify({ type: "unwatch", prompt_id: promptId })); } catch (e) { /* noop */ }
          fetchHistory(promptId).then(function (hist) {
            const h = hist[promptId];
            if (h && h.status && (h.status.status_str === "success" || h.status.status_str === "error")) {
              finished = true; finish();
              if (h.status.status_str === "success") onDone(h);
              else onError({ code: "COMFY_EXEC_error", message: h.status.messages ? h.status.messages.map(function (m) { return m[1] && m[1].message || ""; }).join("; ") : "执行失败" });
            } else { checkDone(); }
          });
        }
      };
      ws.onerror = function () { finish(); startPoll(); };
      ws.onclose = function () { finish(); startPoll(); };
    } catch (e) { startPoll(); }

    /* 立即做一次历史检查（任务可能已经完成） */
    checkDone().catch(function () { /* noop */ });
    return finish;
  }

  /* ---- 下载输出：返回 {bytes, url(blob/data), filename}，PNG 校验 ---- */
  function downloadImage(img) {
    const q = "?filename=" + encodeURIComponent(img.filename) + "&subfolder=" + encodeURIComponent(img.subfolder || "") + "&type=" + encodeURIComponent(img.type || "output");
    return req("/view" + q, {}, false).then(function (buf) {
      const bytes = new Uint8Array(buf);
      if (!(bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47)) {
        throw { code: "COMFY_BAD_IMAGE", message: "下载结果不是有效 PNG: " + img.filename };
      }
      let url;
      const sb = new Blob([buf], { type: "image/png" });
      if (typeof URL !== "undefined" && URL.createObjectURL) { try { url = URL.createObjectURL(sb); } catch (e) { url = null; } }
      if (!url) {
        const b64 = btoa(String.fromCharCode.apply(null, bytes));
        url = "data:image/png;base64," + b64;
      }
      return { bytes: bytes, url: url, filename: img.filename, subfolder: img.subfolder || "", type: img.type || "output", blob: sb };
    });
  }

  function systemStats() { return ping(); }

  A4P.comfyui = {
    baseUrl: baseUrl, setEndpoint: setEndpoint, ping: ping, objectInfo: objectInfo, lastState: lastState,
    listCheckpoints: listCheckpoints, listSamplers: listSamplers, buildWorkflow: buildWorkflow,
    uploadImage: uploadImage, submitWorkflow: submitWorkflow, fetchHistory: fetchHistory,
    connectProgress: connectProgress, downloadImage: downloadImage, cancel: cancel, systemStats: systemStats
  };
})();