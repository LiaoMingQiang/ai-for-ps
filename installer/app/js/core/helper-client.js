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
    writeback: function (id, plan) { return request("POST", "/v1/jobs/" + encodeURIComponent(id) + "/writeback", plan); }
  };

  const gpu = function () {
    return request("GET", "/v1/gpu").catch(function () { return null; });
  };

  A4P.helper = { health: health, connectEvents: connectEvents, request: request, jobs: jobs, gpu: gpu };
})();