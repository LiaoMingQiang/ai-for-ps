/* helper-client: REST + WebSocket to local Helper (PRD 16.2 Job Contract) */
(function () {
  const BASE = function () { return A4P.settings.get("connection", "helperUrl") || "http://127.0.0.1:33057"; };
  let ws = null;
  let reconnectTimer = null;

  function headers(extra) {
    const h = { "Content-Type": "application/json" };
    const tok = A4P.settings.get("connection", "helperToken");
    if (tok) h["Authorization"] = "Bearer " + tok;
    if (extra) Object.keys(extra).forEach(function (k) { h[k] = extra[k]; });
    return h;
  }

  function request(method, path, body) {
    const url = BASE() + path;
    const opts = { method: method, headers: headers() };
    if (body !== undefined) opts.body = JSON.stringify(body);
    return fetch(url, opts).then(function (res) {
      return res.json().catch(function () { return { ok: false }; }).then(function (j) {
        j._status = res.status;
        return j;
      });
    });
  }

  function health() {
    return request("GET", "/v1/health")
      .then(function (j) {
        return { online: !!j.online, version: j.version, pingMs: j.pingMs, comfyui: j.comfyui };
      })
      .catch(function () { return { online: false }; });
  }

  /* pair: 首次配对 — Helper 生成 token, UXP 存 SecureStorage/local settings (不存 API Key) */
  function pair() {
    return request("POST", "/v1/pair", { client: "uxp", version: "0.9.0" });
  }

  function connectEvents() {
    try {
      if (typeof WebSocket === "undefined") return;
      if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
      const url = BASE().replace(/^http/, "ws") + "/v1/events?token=" + encodeURIComponent(A4P.settings.get("connection", "helperToken") || "");
      ws = new WebSocket(url);
      ws.onopen = function () { A4P.store.emit("helper:events", { type: "connected" }); };
      ws.onmessage = function (ev) {
        try {
          const msg = JSON.parse(ev.data);
          A4P.store.emit("helper:event", msg);
          if (msg.type === "job" || msg.type === "job:update") {
            A4P.jobs.onRemoteUpdate(msg.job);
          }
        } catch (e) { /* ignore malformed */ }
      };
      ws.onclose = function () {
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connectEvents, 5000);
      };
      ws.onerror = function () { try { ws.close(); } catch (e) { /* noop */ } };
    } catch (e) { /* ws unavailable */ }
  }

  /* ---- Job Contract ---- */
  const jobs = {
    create: function (payload) { return request("POST", "/v1/jobs", payload); },
    get: function (id) { return request("GET", "/v1/jobs/" + encodeURIComponent(id)); },
    list: function (q) { return request("GET", "/v1/jobs?" + new URLSearchParams(q || {}).toString()); },
    cancel: function (id) { return request("POST", "/v1/jobs/" + encodeURIComponent(id) + "/cancel"); },
    retry: function (id) { return request("POST", "/v1/jobs/" + encodeURIComponent(id) + "/retry"); },
    writeback: function (id, plan) { return request("POST", "/v1/jobs/" + encodeURIComponent(id) + "/writeback-ready", plan); },
    recover: function (id) { return request("GET", "/v1/jobs/" + encodeURIComponent(id)); },
    lineage: function (id) { return request("GET", "/v1/jobs/" + encodeURIComponent(id) + "/lineage"); }
  };

  /* ---- Asset Contract (PHASE 2: Snapshot/参考图 -> Helper Asset Store) ---- */
  const assets = {
    /* file: Blob 或 UXP File; meta: {kind, snapshotId, documentId, jobId, role, projectId} */
    upload: function (file, meta) {
      const fd = new FormData();
      fd.append("file", file, (file && file.name) || "input.png");
      (meta || {}).kind && fd.append("kind", meta.kind);
      (meta || {}).snapshotId && fd.append("snapshotId", meta.snapshotId);
      (meta || {}).documentId && fd.append("documentId", meta.documentId);
      (meta || {}).jobId && fd.append("jobId", meta.jobId);
      (meta || {}).role && fd.append("role", meta.role);
      (meta || {}).projectId && fd.append("projectId", meta.projectId);
      const h = headers();
      delete h["Content-Type"];
      return fetch(BASE() + "/v1/assets", { method: "POST", headers: h, body: fd })
        .then(function (res) { return res.json().catch(function () { return { ok: false }; }); });
    },
    get: function (id) {
      const h = headers();
      delete h["Content-Type"];
      return fetch(BASE() + "/v1/assets/" + encodeURIComponent(id), { headers: h })
        .then(function (res) { if (!res.ok) throw new Error("asset " + res.status); return res.arrayBuffer(); });
    },
    list: function (q) { return request("GET", "/v1/assets?" + new URLSearchParams(q || {}).toString()); }
  };

  /* ---- Providers / Workflows / Projects / Agent Contract (PHASE 9/11/12/20) ---- */
  const providers = {
    list: function () { return request("GET", "/v1/providers"); },
    get: function (id) { return request("GET", "/v1/providers/" + encodeURIComponent(id)); },
    models: function (id) { return request("GET", "/v1/providers/" + encodeURIComponent(id) + "/models"); },
    capabilities: function (id) { return request("GET", "/v1/providers/" + encodeURIComponent(id) + "/capabilities"); },
    test: function (id) { return request("POST", "/v1/providers/" + encodeURIComponent(id) + "/test"); },
    update: function (id, patch) { return request("PATCH", "/v1/providers/" + encodeURIComponent(id), patch); },
    credentials: function (id, body) { return request("POST", "/v1/providers/" + encodeURIComponent(id) + "/credentials", body); }
  };

  const workflows = {
    list: function () { return request("GET", "/v1/workflows"); },
    get: function (id) { return request("GET", "/v1/workflows/" + encodeURIComponent(id)); },
    importJson: function (json) { return request("POST", "/v1/workflows/import", { json: json }); },
    bindings: function (id, body) { return request("POST", "/v1/workflows/" + encodeURIComponent(id) + "/bindings", body); },
    dependencies: function (id) { return request("GET", "/v1/workflows/" + encodeURIComponent(id) + "/dependencies"); },
    versions: function (id) { return request("GET", "/v1/workflows/" + encodeURIComponent(id) + "/versions"); }
  };

  const projects = {
    get: function (id) { return request("GET", "/v1/projects/" + encodeURIComponent(id)); },
    upsert: function (body) { return request("POST", "/v1/projects", body); },
    state: function (id, body) { return request("POST", "/v1/projects/" + encodeURIComponent(id) + "/state", body); },
    jobs: function (id) { return request("GET", "/v1/projects/" + encodeURIComponent(id) + "/jobs"); }
  };

  const agent = {
    tools: function () { return request("GET", "/v1/agent/tools"); },
    plan: function (body) { return request("POST", "/v1/agent/plan", body); },
    execute: function (body) { return request("POST", "/v1/agent/execute", body); },
    audit: function (id) { return request("GET", "/v1/agent/audit/" + encodeURIComponent(id)); }
  };

  const deps = function () { return request("GET", "/v1/dependencies"); };
  const gpu = function () {
    return request("GET", "/v1/gpu").catch(function () { return null; });
  };

  A4P.helper = { health: health, pair: pair, connectEvents: connectEvents, request: request, jobs: jobs, assets: assets, providers: providers, workflows: workflows, projects: projects, agent: agent, deps: deps, gpu: gpu };
})();