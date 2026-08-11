/* ui/page-tasks: 任务中心 */
(function () {
  function row(job) {
    const meta = A4P.jobs.metaOf(job);
    const thumb = (job.results && job.results[0]) ? '<img src="' + job.results[0].thumb + '">' : "<span>—</span>";
    return '<div class="task-row" data-job-id="' + job.id + '"><div class="task-row-thumb">' + thumb + "</div>" +
      '<div class="task-row-main"><strong>' + A4P.utils.escapeHtml(job.label || job.title) + "</strong><span class=\"hint\">" + job.id + " · " + A4P.utils.fmtTime(job.createdAt) + " 前</span>" +
      '<div class="task-row-progress"><div class="progress"><span style="width:' + job.progress + '%"></span></div><span>' + job.progress + "%</span></div>" +
      '<div class="task-row-meta"><span class="state-chip ' + (job.status === "READY_FOR_WRITEBACK" || job.status === "SUCCEEDED" ? "good" : job.status === "FAILED" || job.status === "WRITEBACK_FAILED" ? "bad" : "info") + '">' +
      '<span class="status-dot ' + job.status.toLowerCase() + '"></span>' + meta.label + "</span>" +
      "<span>" + meta.stage + "</span><span>" + meta.eta + "</span><span>" + (job.results ? job.results.length : 0) + " 结果</span></div></div>" +
      '<div class="task-row-actions"><button class="small" data-act="open">打开</button>' +
      (job.status === "RUNNING" || job.status === "QUEUED" || job.status === "VALIDATING" ? '<button class="small" data-act="cancel">取消</button>' : "") +
      '<button class="small" data-act="retry">重试</button><button class="small" data-act="copy">复制 Prompt</button></div></div>';
  }

  function render(body) {
    const jobs = A4P.jobs.list();
    const list = body.querySelector("#taskList");
    list.innerHTML = jobs.length ? jobs.map(row).join("") : '<div class="empty"><strong>暂无任务</strong><span>从生成工作台开始第一次 AI 任务</span></div>';
  }

  A4P.pages.tasks = function (head, body) {
    const $ = A4P.utils.$;
    body.innerHTML =
      '<div class="quickbar"><span class="crumb">工作台 / 任务中心</span></div>' +
      '<div class="card"><div class="section-head"><div class="section-title"><span class="kick"></span><h2>AI 任务</h2></div>' +
      '<div class="button-row"><select class="mini-select" id="filterTasks"><option>全部</option><option>运行中</option><option>已完成</option><option>失败</option></select>' +
      '<button class="small" id="clearJobs">清空历史</button></div></div>' +
      '<div id="taskList"></div></div>';
    render(body);
    $("#filterTasks").addEventListener("change", function () {
      const f = ["全部", "运行中", "已完成", "失败"].indexOf(this.value);
      const filter = f === 1 ? ["VALIDATING", "SNAPSHOTTING", "UPLOADING", "QUEUED", "RUNNING", "DOWNLOADING", "VERIFYING", "READY_FOR_WRITEBACK", "WRITING_BACK"] : f === 2 ? ["SUCCEEDED", "READY_FOR_WRITEBACK"] : f === 3 ? ["FAILED", "WRITEBACK_FAILED"] : null;
      const list = body.querySelector("#taskList");
      const jobs = filter ? A4P.jobs.list({ status: null }).filter(function (j) { return filter.indexOf(j.status) >= 0; }) : A4P.jobs.list();
      list.innerHTML = jobs.length ? jobs.map(row).join("") : '<div class="empty"><strong>无匹配任务</strong></div>';
    });
    $("#clearJobs").addEventListener("click", function () { A4P.jobs.clear(); render(body); });
    $("#taskList").addEventListener("click", function (e) {
      const rowEl = e.target.closest("[data-job-id]");
      const btn = e.target.closest("[data-act]");
      if (!rowEl || !btn) return;
      const job = A4P.jobs.find(rowEl.dataset.jobId);
      const act = btn.dataset.act;
      if (act === "cancel") A4P.jobs.cancel(job);
      if (act === "retry") A4P.jobs.retry(job);
      if (act === "copy") {
        const p = job && job.payload && job.payload.prompt;
        if (navigator.clipboard && p) navigator.clipboard.writeText(p);
        A4P.app.toast(p ? "Prompt 已复制" : "该任务无 Prompt");
      }
      if (act === "open") A4P.app.showViewerAt(job ? job.label : "");
    });
    A4P.store.on("jobs:update", function () { render(body); });
    A4P.store.on("jobs:ready", function () { render(body); });
  };
})();