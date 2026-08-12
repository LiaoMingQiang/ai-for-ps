/* helper-client: REST + WebSocket to local Helper (PRD 16.2 Job Contract) */
(function () {
  const BASE = function () { return A4P.settings.get("connection", "helperUrl") || "http://127.0.0.1:33057"; };
  let ws = null;
  let reconnectTimer = null;
  let tokenCache = null;   /* 内存缓存; 真相源 = SecureStorage (PHASE 15) */

  function headers(extra) {
    const h = { "Content-Type": "application/json" };
    if (tokenCache) h["Authorization"] = "Bearer " + tokenCache;
    if (extra) Object.keys(extra).forEach(function (k) { h[k] = extra[k]; });
    return h;
  }

  /* 启动时从 SecureStorage 加载配对 token */
  function loadToken() {
    if (tokenCache) return Promise.resolve(tokenCache);
    if (!A4P.utils || !A4P.utils.secureGet) return Promise.resolve(null);
    return A4P.utils.secureGet("a4p.helperToken").then(function (t) {
      if (t) tokenCache = t;
      return t;
    }).catch(function () { return null; });
  }

  /* 兼容旧设置 (localStorage 时代的 token 迁移到 SecureStorage) */
  function migrateLegacyToken() {
    const old = A4P.settings.get("connection", "helperToken");
    if (old && !tokenCache) {
      tokenCache = old;
      if (A4P.utils && A4P.utils.secureSet) A4P.utils.secureSet("a4p.helperToken", old);
      A4P.settings.set("connection", "helperToken", ""); /* 清除明文来源 */
    }
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

  /* pair: PHASE 16 两段式 — request 拿 challenge, confirm 换长期 token (存 SecureStorage) */
  function pair() {
    return requestPublic("POST", "/v1/pair/request", { client: "uxp", version: "0.9.0" }).then(function (r) {
      if (r && r.paired) return { paired: true, alreadyPaired: true };
      if (!r || !r.challenge) throw new Error("配对请求失败：" + (r && r.error ? r.error.message : "无 challenge"));
      return requestPublic("POST", "/v1/pair/confirm", { challenge: r.challenge })
        .then(function (c) {
          if (!c || !c.token) throw new Error("配对确认失败：" + (c && c.error ? c.error.message : "无 token"));
          tokenCache = c.token;
          if (A4P.utils && A4P.utils.secureSet) A4P.utils.secureSet("a4p.helperToken", c.token);
          return { paired: true, token: c.token };
        });
    });
  }

  /* 公开端点 (无 token) */
  function requestPublic(method, path, body) {
    const url = BASE() + path;
    const opts = { method: method, headers: { "Content-Type": "application/json" } };
    if (body !== undefined) opts.body = JSON.stringify(body);
    return fetch(url, opts).then(function (res) {
      return res.json().catch(function () { return { ok: false }; }).then(function (j) {
        j._status = res.status;
        return j;
      });
    });
  }

  function connectEvents() {
    try {
      if (typeof WebSocket === "undefined") return;
      if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
      const url = BASE().replace(/^http/, "ws") + "/v1/events?token=" + encodeURIComponent(tokenCache || "");
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

  A4P.helper = { health: health, pair: pair, loadToken: loadToken, migrateLegacyToken: migrateLegacyToken, connectEvents: connectEvents, request: request, jobs: jobs, assets: assets, providers: providers, workflows: workflows, projects: projects, agent: agent, deps: deps, gpu: gpu };
})();