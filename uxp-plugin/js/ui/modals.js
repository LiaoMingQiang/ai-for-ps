/* ui/modals: project context / GPU monitor / task drawer / dependency fix / preview / import dialogs */
(function () {
  const $ = A4P.utils.$, $$ = A4P.utils.$$;
  const t = A4P.t;

  function head(title, closeId) {
    return '<div class="dlg-head"><strong>' + title + '</strong><button class="icon-btn" data-close-dlg="' + closeId + '">×</button></div>';
  }

  function openProject() {
    const dlg = $("#dlg-project");
    const ctx = A4P.state.doc;
    dlg.innerHTML = head("PSD 项目上下文", "#dlg-project") +
      '<div class="dlg-body">' +
      '<div class="card emphasis"><strong>' + (ctx ? A4P.utils.escapeHtml(ctx.name) : "无文档") + "</strong>" +
      '<p>' + A4P.utils.escapeHtml(A4P.settings.get("project", "projectName") || "未关联项目") + "</p>" +
      '<div class="grid">' +
      '<div class="col env-box"><strong>28</strong><span>任务</span></div>' +
      '<div class="col env-box"><strong>7</strong><span>收藏</span></div>' +
      '<div class="col env-box"><strong>4</strong><span>工作流</span></div>' +
      '<div class="col env-box"><strong>3</strong><span>Prompt</span></div></div></div>' +
      '<table class="dep-table"><tbody>' +
      "<tr><td>工作流</td><td>产品洗图 Pro v3.2.1</td></tr>" +
      "<tr><td>模型</td><td>FLUX / IC-Light</td></tr>" +
      "<tr><td>Prompt</td><td>Amazon Product Prompt v7</td></tr>" +
      "<tr><td>结果</td><td>Result #28 · 已写回</td></tr></tbody></table></div>" +
      '<div class="dlg-foot"><button class="secondary">切换 AI 项目</button>' +
      '<button class="primary" data-close-dlg="#dlg-project">恢复项目状态</button></div>';
    bindClose(dlg);
    A4P.uiRouter.openDialog("#dlg-project");
  }

  function openGpu() {
    const dlg = $("#dlg-gpu-drawer");
    const g = A4P.state.gpu;
    dlg.innerHTML = head("GPU / ComfyUI Monitor", "#dlg-gpu-drawer") +
      '<div class="dlg-body">' +
      '<div class="monitor-grid">' +
      metric(g.gpu || 0, "GPU") + metric(g.vramUsed || 0, "VRAM (GB)") +
      metric(g.ramUsed || 0, "RAM (GB)") + metric(g.queue || 0, "Queue") + "</div>" +
      '<div class="card"><div class="section-head"><h2>ComfyUI</h2><span class="state-chip good">' + (g.comfyOnline ? "Online" : "Offline") + "</span></div>" +
      '<div class="grid">' +
      '<div class="col env-box"><strong>' + (g.comfyVersion || "--") + "</strong><span>版本</span></div>" +
      '<div class="col env-box"><strong>' + (g.pingMs != null ? g.pingMs + " ms" : "--") + "</strong><span>Ping</span></div>" +
      '<div class="col env-box"><strong>RTX 4090</strong><span>Device</span></div>' +
      '<div class="col env-box"><strong>39</strong><span>Workflow nodes</span></div></div></div></div>' +
      '<div class="dlg-foot"><button class="secondary full" data-close-dlg="#dlg-gpu-drawer" data-goto="tasks">打开计算中心</button></div>';
    bindClose(dlg);
    A4P.uiRouter.openDialog("#dlg-gpu-drawer");
  }

  function metric(v, label) {
    return '<div class="metric"><strong>' + v + "</strong><span>" + label + "</span><div class=\"bar\"><span></span></div></div>";
  }

  function openTasks() {
    const dlg = $("#dlg-task-drawer");
    const jobs = A4P.jobs.list();
    const active = jobs.filter(function (j) { return !A4P.jobs.TERMINAL[j.status]; }).slice(0, 6);
    const items = active.length ? active.map(function (j) {
      return '<div class="task-current"><div class="task-head"><div class="task-icon">' + (j.status === "RUNNING" ? "↻" : "▤") + "</div>" +
        '<div class="task-main"><strong>' + A4P.utils.escapeHtml(j.title) + "</strong>" +
        '<div class="task-stage">' + A4P.utils.escapeHtml(j.stageText) + "</div></div>" +
        '<span class="state-chip ' + (j.status === "QUEUED" ? "warning" : j.status === "READY_FOR_WRITEBACK" ? "purple" : "info") + '">' + t("js_" + j.status) + "</span></div>" +
        (j.status === "RUNNING" || j.status === "UPLOADING" || j.status === "DOWNLOADING" ? '<div class="progress"><span style="width:' + j.progress + '%"></span></div>' : "") +
        "</div>";
    }).join("") : '<div class="card soft"><p>当前没有活动任务</p></div>';
    dlg.innerHTML = head("活动任务", "#dlg-task-drawer") +
      '<div class="dlg-body">' + items + "</div>" +
      '<div class="dlg-foot"><button class="primary full" data-close-dlg="#dlg-task-drawer" data-goto="tasks">打开任务中心</button></div>';
    bindClose(dlg);
    A4P.uiRouter.openDialog("#dlg-task-drawer");
  }

  function openDependency() {
    const dlg = $("#dlg-dependency");
    dlg.innerHTML = head("依赖修复助手", "#dlg-dependency") +
      '<div class="dlg-body"><div class="card soft"><span class="state-chip bad">COMFY_NODE_MISSING</span>' +
      '<h2>缺少 LayerUtility: ImageBlendAdvance</h2><p>此节点用于场景融合。当前工作流要求 LayerUtility ≥ 1.7.0。</p>' +
      '<div class="grid"><div class="col env-box"><strong>建议</strong><span>在 ComfyUI Manager 中安装/更新 LayerUtility</span></div>' +
      '<div class="col env-box"><strong>安全</strong><span>插件不会自动执行任意安装脚本</span></div></div></div></div>' +
      '<div class="dlg-foot"><button class="secondary" data-close-dlg="#dlg-dependency">取消</button>' +
      '<button class="primary" data-close-dlg="#dlg-dependency" id="openComfyFixBtn">打开 ComfyUI 修复</button></div>';
    bindClose(dlg);
    const fix = $("#openComfyFixBtn", dlg);
    if (fix) fix.onclick = function () { A4P.uiRouter.toast("已打开 ComfyUI 修复入口", "插件不会自动执行未知安装脚本"); };
    A4P.uiRouter.openDialog("#dlg-dependency");
  }

  function openPreview() {
    const dlg = $("#dlg-preview");
    dlg.innerHTML = head("结果 Compare", "#dlg-preview") +
      '<div class="dlg-body"><div id="previewCompare"></div></div>' +
      '<div class="dlg-foot"><button class="secondary">保存 Compare</button>' +
      '<button class="primary">写入所选结果</button></div>';
    bindClose(dlg);
    A4P.compare.render(A4P.state.compare || "grid", $("#previewCompare", dlg), null);
    A4P.uiRouter.openDialog("#dlg-preview");
  }

  function openImportWorkflow() {
    const dlg = $("#dlg-import-workflow");
    dlg.innerHTML = head("导入工作流", "#dlg-import-workflow") +
      '<div class="dlg-body">' +
      '<div class="grid"><div class="col card" style="cursor:pointer" id="importJsonCard"><strong>ComfyUI API JSON</strong><p>文件选择或粘贴 JSON</p></div>' +
      '<div class="col card" style="cursor:pointer" id="importPackageCard"><strong>.workflow 工作流包</strong><p>包含 manifest、封面、预设和 Lockfile</p></div></div>' +
      '<div class="card soft"><span class="state-chip good">安全扫描</span><p>导入不会执行任意代码；未知字段进入高级模式，依赖在保存前检查。</p></div>' +
      '<div class="field" style="margin-top:10px"><span>粘贴 API JSON</span><textarea id="importJsonText" style="min-height:110px;font-family:monospace"></textarea></div></div>' +
      '<div class="dlg-foot"><button class="secondary" data-close-dlg="#dlg-import-workflow">取消</button>' +
      '<button class="primary" id="importJsonBtn">扫描并导入</button></div>';
    bindClose(dlg);
    $("input[type=file]", dlg) && ($("input[type=file]", dlg).style.display = "none");
    $("input[type=file]", dlg) && $("input[type=file]", dlg).setAttribute("hidden", "");
    /* 选择 JSON 文件: UXP 正式路径 = localFileSystem.getFileForOpening; 浏览器预览 fallback 文件框 */
    $("input[type=file]", dlg) && $("input[type=file]", dlg).addEventListener("change", function () {
      const f = $("input[type=file]", dlg).files && $("input[type=file]", dlg).files[0];
      if (!f) return;
      const rd = new FileReader();
      rd.onload = function () { $("input[type=file]", dlg).dataset.picked = rd.result; $("input[type=file]", dlg).dataset.pickedName = f.name; };
      rd.readAsText(f);
    });
    if ($("input[type=file]", dlg)) { $("input[type=file]", dlg).dataset.picked = ""; }
    $("#importJsonBtn", dlg).onclick = function () {
      const picked = $("input[type=file]", dlg) ? ($("input[type=file]", dlg).dataset.picked || "") : "";
      const body = $("#importJsonText", dlg).value || picked || "";
      if (!body || !body.trim()) { A4P.uiRouter.toast("请先粘贴 JSON 或选择文件", "warn"); return; }
      /* PHASE 9: 真实导入 — Helper parse/scan/依赖检查/SQLite, 只有真正成功才提示 */
      const btn = $("#importJsonBtn", dlg);
      btn.disabled = true; btn.textContent = "导入中…";
      A4P.helper.workflows.importJson(body).then(function (r) {
        btn.disabled = false; btn.textContent = "扫描并导入";
        if (r && r.error) throw { code: r.error.code || "WORKFLOW_INVALID", message: r.error.message || "导入失败" };
        if (!r || !r.workflow || !r.workflow.id) throw { code: "WORKFLOW_INVALID", message: "Helper 未返回 workflow" };
        A4P.uiRouter.toast("工作流导入完成：" + (r.workflow.name || r.workflow.id), "ok");
        A4P.store.emit("workflow:imported", r.workflow);
        dlg.close();
        try { A4P.uiRouter.switchPage("workflows"); } catch (e) { /* noop */ }
      }).catch(function (err) {
        btn.disabled = false; btn.textContent = "扫描并导入";
        A4P.uiRouter.toast("导入失败：" + (err.message || String(err)), "warn");
      });
    };
    A4P.uiRouter.openDialog("#dlg-import-workflow");
  }

  function bindClose(dlg) {
    $$("[data-close-dlg]", dlg).forEach(function (b) {
      b.onclick = function () {
        const target = b.dataset.closeDlg;
        if (b.dataset.goto) { A4P.uiRouter.switchPage(b.dataset.goto); }
        A4P.uiRouter.closeDialog(target);
      };
    });
  }

  A4P.pageModals = { openProject: openProject, openGpu: openGpu, openTasks: openTasks, openDependency: openDependency, openPreview: openPreview, openImportWorkflow: openImportWorkflow };
})();