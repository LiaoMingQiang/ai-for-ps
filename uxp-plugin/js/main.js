/* main: 启动引导 —— 浏览器预览版走真实链路；真实 UXP 封装时由 Panel entry 调用 A4P.main.boot() */
A4P.main = (function () {
  const api = {
    boot: function () {
      const root = document.getElementById("app");
      if (!root) return;

      /* 应用级 service shim（页面共用） */
      A4P.app = {
        toast: function (msg, kind) {
          const type = kind === "ok" ? "good" : kind;
          A4P.uiRouter.toast(msg, "", type);
        },
        showViewerAt: function (label) { A4P.uiRouter.toast("查看器：准备打开 " + label); },
        state: { runId: null }
      };

      A4P.store.load();
      A4P.uiRouter.renderShell(root);
      const last = A4P.state.lastPage || "generate";
      A4P.uiRouter.switchPage(last);

      A4P.uiRouter.bindGlobal();
      A4P.uiRouter.bindShortcuts();

      /* 环境：PS 上下文轮询（浏览器内为 null，不报错）+ 任务恢复 */
      if (A4P.psContext) { try { A4P.psContext.start(); A4P.psContext.refresh(); } catch (e) { /* browser */ } }
      try { const n = A4P.jobs.restore(); if (n) A4P.jobs.recoverAll(); } catch (e) { /* noop */ }
      if (A4P.agent) A4P.agent.start();

      /* 顶栏实时状态 */
      A4P.store.on("ps:context", A4P.uiRouter.updateTopbar);
      A4P.store.on("jobs:update", A4P.uiRouter.updateTaskBadge);
      A4P.store.on("jobs:ready", function (job) { A4P.uiRouter.toast(job.label + " 已完成", "", "good"); });

      A4P.uiRouter.toast("AI-for-PS 已就绪 · 演示模式（浏览器预览）", "", "info");
      document.dispatchEvent(new Event("init"));
    }
  };
  return api;
})();

document.addEventListener("DOMContentLoaded", function () { A4P.main.boot(); });