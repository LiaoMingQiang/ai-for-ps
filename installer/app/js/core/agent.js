/* core/agent: 任务抽象层——队列 → 调度 → jobs 引擎（demo: 直接驱动 A4P.jobs）
 * 真实模式：queue 提交到 Helper (A4P.helper.jobs.create)，由远端 worker 执行。 */
(function () {
  const queue = [];
  const listeners = {};
  let ticker = null;

  function emit() {
    Object.keys(listeners).forEach(function (k) { try { listeners[k](); } catch (e) { /* noop */ } });
  }

  A4P.agent = {
    on: function (fn) { const id = "l" + Math.random().toString(36).slice(2); listeners[id] = fn; return function () { delete listeners[id]; }; },
    pending: function () { return queue.length; },
    push: function (payload) {
      queue.push(payload);
      emit();
      return queue.length;
    },
    cancel: function (jobId) { A4P.jobs.cancel(A4P.jobs.find(jobId)); emit(); },
    tick: function () {
      if (!queue.length) return;
      const payload = queue.shift();
      const job = A4P.jobs.create({
        label: payload.label || "AI 批量任务",
        title: payload.label || "AI 批量任务",
        kind: payload.mode || "image",
        tool: payload.tool || "生成",
        payload: payload,
        provider: payload.providerId || "comfyui",
        seed: payload.params && payload.params.seed,
        resultCount: payload.resultCount || 1
      });
      A4P.jobs.start(job);
      emit();
      return job.id;
    },
    start: function () { if (!ticker) ticker = setInterval(function () { A4P.agent.tick(); }, 800); return ticker; },
    stop: function () { if (ticker) { clearInterval(ticker); ticker = null; } },
    bootstrap: function () {
      /* 供 #dlg-agent-drawer 使用：注入示例任务 */
      A4P.store.emit("agent:plan", [
        { action: "captureSnapshot", args: { label: "产品主体" }, risk: "low" },
        { action: "queueWorkflow", args: { workflowId: "wf-product-clean" }, risk: "low" },
        { action: "writeback", args: { strategy: "smartObject" }, risk: "medium" }
      ]);
      return true;
    }
  };
})();