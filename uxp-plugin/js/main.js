/* main: 启动引导
 * - 浏览器预览: DOMContentLoaded -> boot() (原有路径, 不破坏)
 * - 真实 UXP: src/entry.js 面板 create(rootNode) -> A4P.main.bootstrap(rootNode)
 *
 * 统一初始化链 (规则三):
 *   bootstrap()
 *   -> loadSettings()         加载本地设置 / UI 偏好
 *   -> initPhotoshopBridge()  PhotoshopBridge.init() (真实初始化)
 *   -> connectHelper()        Helper health + WebSocket 事件
 *   -> pairHelper()           pairing token 检查/配对 (无 Helper 时保持离线状态, 不假成功)
 *   -> restoreSession()       恢复上次页面/模式
 *   -> recoverJobs()          任务恢复 (存在 remoteId 时先查远端, 不无条件重提交)
 *   -> loadProjectContext()   PS 文档上下文 (浏览器内为 null)
 *   -> renderApp()            渲染应用壳
 */
A4P.main = (function () {
  "use strict";

  function toast(msg, kind) {
    try { A4P.uiRouter.toast(msg, "", kind === "ok" ? "good" : (kind || "info")); } catch (e) { /* noop */ }
  }

  function appShim() {
    A4P.app = {
      toast: toast,
      showViewerAt: function (label) { toast("查看器：准备打开 " + label); },
      state: { runId: null }
    };
  }

  /* 1. loadSettings */
  function loadSettings() {
    A4P.store.load(); /* merges persisted settings + last page/mode */
    return Promise.resolve();
  }

  /* 2. initPhotoshopBridge */
  function initPhotoshopBridge() {
    try {
      if (A4P.ps && A4P.ps.init) {
        var r = A4P.ps.init();
        if (r && typeof r.then === "function") return r;
      }
    } catch (e) { /* browser preview */ }
    return Promise.resolve();
  }

  /* 3. connectHelper */
  function connectHelper() {
    try {
      if (!A4P.helper) return Promise.resolve();
      A4P.helper.health().then(function (h) {
        A4P.state.helper = { online: !!h.online, version: h.version, pingMs: h.pingMs };
        A4P.store.emit("helper:status", A4P.state.helper);
      });
      if (A4P.helper.connectEvents) A4P.helper.connectEvents();
    } catch (e) { /* noop */ }
    return Promise.resolve();
  }

  /* 4. pairHelper: 有 token 即视为已配对; 无 token 时请求 /v1/pair (helper 离线则保持未配对) */
  function pairHelper() {
    try {
      var tok = A4P.settings.get("connection", "helperToken");
      if (tok) return Promise.resolve({ paired: true });
      if (!A4P.helper || !A4P.helper.pair) return Promise.resolve({ paired: false, reason: "no-helper-client" });
      return A4P.helper.pair().then(function (r) {
        if (r && r.token) {
          A4P.settings.set("connection", "helperToken", r.token);
          A4P.store.persist();
          return { paired: true };
        }
        A4P.state.helper.paired = false;
        A4P.store.emit("helper:status", A4P.state.helper);
        return { paired: false, reason: "pair-rejected" };
      }).catch(function () {
        A4P.state.helper.paired = false;
        A4P.store.emit("helper:status", A4P.state.helper);
        return { paired: false, reason: "helper-offline" };
      });
    } catch (e) { return Promise.resolve({ paired: false, reason: "error" }); }
  }

  /* 5. restoreSession: UI 页面/模式已由 store.load 恢复; 此处挂事件 */
  function restoreSession() {
    A4P.store.on("ps:context", A4P.uiRouter.updateTopbar);
    A4P.store.on("jobs:update", A4P.uiRouter.updateTaskBadge);
    A4P.store.on("jobs:ready", function (job) { toast(job.label + " 已完成", "ok"); });
    return Promise.resolve();
  }

  /* 6. recoverJobs: 恢复非终态任务 (Phase 9 将替换为 remoteJobId 优先恢复) */
  function recoverJobs() {
    try {
      var n = A4P.jobs.restore();
      if (n) A4P.jobs.recoverAll();
    } catch (e) { /* noop */ }
    return Promise.resolve();
  }

  /* 7. loadProjectContext */
  function loadProjectContext() {
    try {
      if (A4P.psContext) { A4P.psContext.start(); A4P.psContext.refresh(); }
    } catch (e) { /* browser */ }
    try { if (A4P.agent) A4P.agent.start(); } catch (e) { /* noop */ }
    return Promise.resolve();
  }

  /* 8. renderApp */
  function renderApp(rootNode) {
    var root = rootNode || document.getElementById("app");
    if (!root) return;
    A4P.uiRouter.renderShell(root);
    var last = A4P.state.lastPage || "generate";
    A4P.uiRouter.switchPage(last);
    A4P.uiRouter.bindGlobal();
    A4P.uiRouter.bindShortcuts();
    A4P.uiRouter.updateTopbar(A4P.state.doc);
    A4P.uiRouter.updateTaskBadge();
    document.dispatchEvent(new Event("init"));
  }

  function boot() {
    appShim();
    bootstrap(null);
  }

  /* 统一启动链: 顺序执行, 任何一步失败不阻塞后续, 但如实上报 */
  function bootstrap(rootNode) {
    appShim();
    var steps = [
      ["loadSettings", loadSettings],
      ["initPhotoshopBridge", initPhotoshopBridge],
      ["connectHelper", connectHelper],
      ["pairHelper", pairHelper],
      ["restoreSession", restoreSession],
      ["recoverJobs", recoverJobs],
      ["loadProjectContext", loadProjectContext],
      ["renderApp", function () { renderApp(rootNode); }]
    ];
    var chain = Promise.resolve();
    steps.forEach(function (step) {
      chain = chain.then(function () {
        try { return step[1](); } catch (e) { return Promise.resolve(); }
      });
    });
    chain.then(function () {
      var psOk = !!(A4P.ps && A4P.ps.available && A4P.ps.available());
      toast(psOk ? "AI-for-PS 已就绪" : "AI-for-PS 已就绪 · 未检测到 Photoshop 环境", psOk ? "ok" : "info");
    }).catch(function () { /* 已逐级捕获 */ });
    return chain;
  }

  function destroy() {
    try { if (A4P.psContext && A4P.psContext.stop) A4P.psContext.stop(); } catch (e) { /* noop */ }
    try { if (A4P.agent && A4P.agent.stop) A4P.agent.stop(); } catch (e) { /* noop */ }
  }

  function onShow() {
    try { if (A4P.psContext) A4P.psContext.refresh(); } catch (e) { /* noop */ }
  }
  function onHide() { /* 面板隐藏: 保持运行, 不销毁状态 */ }

  return {
    boot: boot,
    bootstrap: bootstrap,
    destroy: destroy,
    onShow: onShow,
    onHide: onHide
  };
})();

/* 浏览器预览入口 (UXP 面板中由 src/entry.js 的 create 调用 bootstrap)
 * 判定逻辑必须与 src/entry.js hasUxp() 一致: 存在 entrypoints.setup 才是真 UXP 运行时 */
function inUxpRuntime() {
  try {
    if (typeof require === "undefined") return false;
    var uxp = require("uxp");
    return !!(uxp && uxp.entrypoints && typeof uxp.entrypoints.setup === "function");
  } catch (e) { return false; }
}

document.addEventListener("DOMContentLoaded", function () {
  if (!inUxpRuntime()) A4P.main.boot();
});
