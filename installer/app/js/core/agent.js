/* core/agent: 前端 Agent — 真实链路 (PHASE 20)
 * 用户 Request -> POST /v1/agent/plan (Helper) -> 显示真实 Plan
 * -> 用户批准 -> POST /v1/agent/execute -> Helper Tool Registry
 * -> PS 工具委托 UXP bridge; 审计由 Helper 记录。
 * 不再有 fake queue / setInterval / 示例自动计划。 */
(function () {
  const listeners = {};

  function emit(name, payload) {
    Object.keys(listeners).forEach(function (k) { try { listeners[k](name, payload); } catch (e) { /* noop */ } });
  }

  A4P.agent = {
    on: function (fn) { const id = "l" + Math.random().toString(36).slice(2); listeners[id] = fn; return function () { delete listeners[id]; }; },
    /* 打开 Agent 面板: 请求真实 Plan (不执行) */
    bootstrap: function (intent) {
      if (!A4P.helper || !A4P.helper.agent) {
        emit("agent:error", { code: "HELPER_OFFLINE", message: "Agent 需要 Helper 在线" });
        return Promise.reject({ code: "HELPER_OFFLINE" });
      }
      const req = {
        intent: intent || "给当前产品图层抠图生成蒙版并写回",
        providerId: A4P.providers.helperIdOf ? A4P.providers.helperIdOf("comfyui") : "local-comfy"
      };
      return A4P.helper.agent.plan(req).then(function (r) {
        if (r && r.error) throw { code: r.error.code, message: r.error.message };
        emit("agent:plan", { planId: r.planId, auditId: r.auditId, plan: r.plan });
        return r;
      }).catch(function (e) {
        emit("agent:error", { code: e.code || "AGENT_PLAN_FAILED", message: e.message || String(e) });
        throw e;
      });
    },
    /* 用户批准后执行 (Helper 审计完整记录; PS 工具委托 UXP) */
    approve: function (auditId) {
      if (!A4P.helper || !A4P.helper.agent) return Promise.reject({ code: "HELPER_OFFLINE" });
      return A4P.helper.agent.execute({ auditId: auditId, approved: true }).then(function (r) {
        emit("agent:result", r);
        return r;
      });
    },
    reject: function (auditId) {
      if (!A4P.helper || !A4P.helper.agent) return Promise.reject({ code: "HELPER_OFFLINE" });
      return A4P.helper.agent.execute({ auditId: auditId, approved: false }).then(function (r) {
        emit("agent:rejected", r);
        return r;
      });
    },
    audit: function (id) {
      if (!A4P.helper || !A4P.helper.agent) return Promise.reject({ code: "HELPER_OFFLINE" });
      return A4P.helper.agent.audit(id);
    },
    /* 兼容旧 API 表面 (不再有本地队列/定时器) */
    pending: function () { return 0; },
    push: function () { return 0; },
    cancel: function (jobId) { return A4P.jobs.cancel(A4P.jobs.find(jobId)); },
    tick: function () { return null; },
    start: function () { return null; },
    stop: function () { /* noop */ }
  };
})();
