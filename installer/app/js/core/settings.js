/* settings: 13 sections per PRD 14.1; defaults; merges persisted user config */
(function () {
  const DEFAULTS = {
    connection: {
      helperUrl: "http://127.0.0.1:33057",
      helperToken: "",
      accountId: "",
      comfyuiUrl: "http://127.0.0.1:8188",
      demoMode: false,               /* 已移除演示引擎：ComfyUI 离线即真实失败 */
      connections: [
        { id: "local4090", name: "本地 4090 工作站", type: "comfyui", url: "http://127.0.0.1:8188", online: false },
        { id: "openai", name: "OpenAI Compatible", type: "openai", url: "https://api.openai.com/v1", online: false }
      ]
    },
    compute: {
      workers: [
        { id: "w1", name: "Local RTX 4090", vram: 24, online: true, ping: 8 },
        { id: "w2", name: "Studio RTX 5090", vram: 32, online: true, ping: 22 }
      ],
      smartConcurrency: true,
      vramThreshold: 0.9,
      autoStartIdle: true,
      notifyOnDone: true,
      failover: false
    },
    project: {
      autoLink: true, restoreLastState: true, filterByProject: true,
      projectName: "Amazon Listing / Version 12", defaultResultGroup: "AI Results / Amazon KV"
    },
    writeback: {
      defaultStrategy: "smartObject",
      autoGroup: true, overwriteAllowed: false, verifyDocumentOnWriteback: true,
      layerNaming: "AI-{tool}-v{version}-Seed{seed}",
      sizeMismatch: "ask"
    },
    prompts: {
      saveVersions: true, saveRecentVariables: true, keepOriginalOnOptimize: true
    },
    storage: { keepDays: 30, capGb: 20, saveInputCopies: true, hashDedup: true },
    security: { helperLoopbackOnly: true, workflowScan: true, showCloudLocation: true },
    diagnostics: { exportDiagOnError: false },
    updates: { autoCheck: true, backupBeforeMigrate: true },
    shortcuts: {
      runQuick: "Ctrl+Alt+1", openTasks: "Ctrl+Shift+T", openAgent: "Ctrl+Shift+A", openCommand: "Ctrl+K"
    },
    team: { hideRawJson: true, centralizedProvider: true, members: 8, workflows: 12, monthCost: 328 },
    sdk: {
      providerSdk: "1.0", workflowSdk: "1.0", fieldRendererSdk: "0.9 (Beta)", aiToolSdk: "0.8 (Beta)"
    },
    about: { pluginVersion: "1.0.0", helperVersion: "1.0.0", schemaVersion: 3, manifestVersion: 5 }
  };

  let current = null;

  function clone(obj) { return JSON.parse(JSON.stringify(obj)); }
  function all() { return current; }
  function merge(patch) {
    if (!current) current = clone(DEFAULTS);
    if (!patch) return current;
    Object.keys(patch).forEach(function (k) {
      const v = patch[k];
      if (v && typeof v === "object" && !Array.isArray(v) && current[k] && typeof current[k] === "object") {
        Object.keys(v).forEach(function (k2) { current[k][k2] = v[k2]; });
      } else {
        current[k] = v;
      }
    });
    return current;
  }
  function get(section, key) {
    if (!current) current = clone(DEFAULTS);
    return key ? current[section] && current[section][key] : current[section];
  }
  function set(section, key, value) {
    if (!current) current = clone(DEFAULTS);
    if (!current[section]) current[section] = {};
    current[section][key] = value;
    A4P.store && A4P.store.persist && A4P.store.persist();
    return current;
  }
  function reset() { current = clone(DEFAULTS); }
  function demoMode() { return current ? !!current.connection.demoMode : false; }

  A4P.settings = { defaults: DEFAULTS, all: all, merge: merge, get: get, set: set, reset: reset, demoMode: demoMode };
})();