/* ui/router: nav, page switching, drawers/modals via <dialog>, command palette, shortcuts */
(function () {
  function $s(sel) { return A4P.utils.$(sel); }
  function $all(sel) { return A4P.utils.$$(sel); }
  const t = function (k, v) { return A4P.t(k, v); };

  const NAV = [
    { page: "generate", glyph: "✦" }, { page: "edit", glyph: "◩" },
    { page: "workflows", glyph: "⌘" }, { page: "tasks", glyph: "▤" },
    { page: "history", glyph: "↶" }, { page: "assets", glyph: "▦" },
    { page: "settings", glyph: "⚙" }
  ];
  const PAGE_TITLES = {
    generate: [t("p_gen_title"), t("p_gen_sub")],
    edit: [t("p_edit_title"), t("p_edit_sub")],
    workflows: [t("p_wf_title"), t("p_wf_sub")],
    tasks: [t("p_tasks_title"), t("p_tasks_sub")],
    history: [t("p_hist_title"), t("p_hist_sub")],
    assets: [t("p_assets_title"), t("p_assets_sub")],
    settings: [t("p_settings_title"), t("p_settings_sub")]
  };

  function layout() {
    const navBtns = NAV.map(function (n) {
      return '<button class="nav" data-page="' + n.page + '"><span class="glyph">' + n.glyph + "</span><span>" + t("nav_" + n.page) + "</span></button>";
    }).join("");
    return (
      '<header class="topbar">' +
      '<div class="brand"><div class="brandmark">AI</div><div class="brandcopy"><strong>AI for PS</strong><span>' + t("brand_tagline") + "</span></div></div>" +
      '<button class="project-context" id="contextButton" title="' + t("project_ctx_hint") + '">' +
      '<span class="dot online" id="ctxDot"></span>' +
      '<span class="doc" id="ctxDoc"></span>' +
      '<span class="state-chip purple" id="ctxProject">—</span></button>' +
      '<div class="top-actions">' +
      '<button class="status-btn" id="gpuButton"><span class="dot online"></span><span class="status-label" id="gpuLabel">GPU</span></button>' +
      '<button class="status-btn" id="serviceButton"><span class="dot" id="helperDot"></span><span class="status-label" id="helperLabel">Helper</span></button>' +
      '<button class="icon-btn" id="taskDrawerButton" title="任务中心">▤<span class="badge hidden" id="taskBadge">0</span></button>' +
      '<button class="icon-btn" id="agentButton" title="AI Agent">✦</button>' +
      '<button class="icon-btn" id="commandButton" title="命令菜单">⌘</button>' +
      "</div></header>" +
      '<div class="shell"><aside class="sidebar">' + navBtns +
      '<div class="nav-spacer"></div>' +
      '<div class="sidebar-mini">' +
      '<div class="stat"><span class="dot online"></span><small>ComfyUI</small><strong id="miniComfy">--</strong></div>' +
      '<div class="stat"><span class="dot online"></span><small>VRAM</small><strong id="miniVram">--</strong></div>' +
      '<div class="stat"><span class="dot warn"></span><small>队列</small><strong id="miniQueue">0</strong></div>' +
      "</div>" +
      '<button class="nav" data-page="settings"><span class="glyph">⚙</span><span>' + t("nav_settings") + "</span></button>" +
      "</aside>" +
      '<main class="main"></main></div>'
    );
  }

  function renderShell(root) {
    root.innerHTML = layout();
    const main = $s(".main");
    /* main is populated when a page becomes active */
    $all(".nav[data-page]").forEach(function (b) {
      b.onclick = function () { switchPage(b.dataset.page); };
    });
  }

  function switchPage(page) {
    A4P.state.page = page;
    $all(".nav[data-page]").forEach(function (x) { x.classList.toggle("active", x.dataset.page === page); });
    const main = $s(".main");
    const titles = PAGE_TITLES[page];
    main.innerHTML =
      '<section class="page active">' +
      '<div class="page-head"><div><div class="breadcrumb">AI for PS / ' + (titles ? titles[0] : "") + "</div>" +
      "<h1>" + (titles ? titles[0] : "") + "</h1><p>" + (titles ? titles[1] : "") + "</p></div>" +
      '<div class="head-actions" data-head-actions></div></div>' +
      '<div data-page-body></div></section>';
    const head = A4P.utils.$("[data-head-actions]", main);
    const body = A4P.utils.$("[data-page-body]", main);
    const renderer = A4P.pages && A4P.pages[page];
    if (renderer) {
      renderer(head, body);
    } else {
      body.innerHTML = '<div class="card"><h2>' + (titles ? titles[0] : page) + "</h2></div>";
    }
    main.scrollTop = 0;
    A4P.store.persist();
  }

  /* ---------- dialogs ---------- */
  function dlgPicker() { return { task: "#dlg-task-drawer", gpu: "#dlg-gpu-drawer", agent: "#dlg-agent-drawer", project: "#dlg-project", dependency: "#dlg-dependency", preview: "#dlg-preview", import: "#dlg-import-workflow" }; }
  function openDialog(id) {
    const el = $s(id);
    if (!el) return;
    if (el.open) return;
    try { el.showModal(); } catch (e) { /* not supported */ }
    A4P.store.emit("dlg:open", id);
  }
  function closeDialog(id) {
    const el = $s(id);
    if (el && el.open) { try { el.close(); } catch (e) { /* noop */ } }
    A4P.store.emit("dlg:close", id);
  }
  function closeAllDialogs() {
    ["task", "gpu", "agent", "project", "dependency", "preview", "import"].forEach(function (k) {
      const el = $s(dlgPicker()[k]);
      if (el && el.open) try { el.close(); } catch (e) { /* noop */ }
    });
  }

  /* ---------- command palette ---------- */
  const COMMANDS = [
    { id: "generate", label: "新建生成任务", hint: "Ctrl+Enter", run: function () { closeAllDialogs(); switchPage("generate"); } },
    { id: "quick", label: "运行快捷工作流：产品洗图", run: function () { closeAllDialogs(); switchPage("generate"); A4P.store.emit("quick:run"); } },
    { id: "tasks", label: "打开任务中心", hint: "Ctrl+Shift+T", run: function () { closeAllDialogs(); switchPage("tasks"); } },
    { id: "agent", label: "打开 Photoshop AI Agent", hint: "Ctrl+Shift+A", run: function () { closeAllDialogs(); openDialog("#dlg-agent-drawer"); } },
    { id: "deps", label: "打开工作流依赖中心", run: function () { closeAllDialogs(); switchPage("workflows"); A4P.store.emit("wf:tab", "dependencies"); } },
    { id: "gpu", label: "打开 GPU Monitor", run: function () { closeAllDialogs(); openDialog("#dlg-gpu-drawer"); } },
    { id: "studio", label: "打开 Workflow Studio Lite", run: function () { closeAllDialogs(); switchPage("workflows"); A4P.store.emit("wf:tab", "studio"); } }
  ];

  function openCommand() {
    const dlg = $s("#dlg-command");
    const list = A4P.utils.$(".command-list", dlg);
    list.innerHTML = COMMANDS.map(function (c) {
      return '<button data-cmd="' + c.id + '">' + c.label + (c.hint ? '<span class="dim">' + c.hint + "</span>" : "") + "</button>";
    }).join("");
    A4P.utils.$$("[data-cmd]", list).forEach(function (b) {
      b.onclick = function () {
        const cmd = COMMANDS.find(function (c) { return c.id === b.dataset.cmd; });
        dlg.close();
        if (cmd) cmd.run();
      };
    });
    const input = A4P.utils.$("input", dlg);
    input.value = "";
    input.oninput = A4P.utils.debounce(function () {
      const q = input.value.toLowerCase();
      A4P.utils.$$("[data-cmd]", list).forEach(function (b) {
        b.style.display = b.textContent.toLowerCase().indexOf(q) >= 0 ? "" : "none";
      });
    }, 80);
    try { dlg.showModal(); } catch (e) { /* noop */ }
    input.focus();
  }

  function bindShortcuts() {
    document.addEventListener("keydown", function (e) {
      const ctrl = e.ctrlKey || e.metaKey;
      const k = (e.key || "").toLowerCase();
      if (ctrl && k === "k") { e.preventDefault(); A4P.uiRouter.openCommand(); }
      else if (ctrl && e.key === "Enter") { e.preventDefault(); A4P.store.emit("shortcut:run"); }
      else if (ctrl && e.shiftKey && k === "t") { e.preventDefault(); switchPage("tasks"); }
      else if (ctrl && e.shiftKey && k === "a") { e.preventDefault(); openDialog("#dlg-agent-drawer"); }
      else if (e.key === "Escape") { closeAllDialogs(); }
    });
  }

  function updateTopbar(ctx) {
    const dot = $s("#ctxDot");
    const docEl = $s("#ctxDoc");
    if (!docEl) return;
    if (!ctx) {
      dot.className = "dot offline";
      docEl.innerHTML = "<strong>" + t("ctx_no_doc") + "</strong>";
      return;
    }
    dot.className = "dot online";
    const sel = ctx.hasSelection ? " · 已选区" : "";
    docEl.innerHTML = "<strong>" + A4P.utils.escapeHtml(ctx.name) + "</strong>" +
      "<span>" + (ctx.activeLayer ? A4P.utils.escapeHtml(ctx.activeLayer.name) : "无活动图层") +
      " · " + ctx.width + " × " + ctx.height + " · " + (ctx.mode || "RGB") + " " + (ctx.bitDepth || 8) + " 位" + sel + "</span>";
  }

  function updateHelperStatus(info) {
    const dot = $s("#helperDot");
    const label = $s("#helperLabel");
    if (!dot) return;
    if (info && info.online) { dot.className = "dot online"; label.textContent = "Helper " + (info.version || ""); }
    else { dot.className = "dot offline"; label.textContent = A4P.settings.demoMode() ? "演示模式" : "Helper 离线"; }
  }

  function updateGpu() {
    const g = A4P.state.gpu;
    const l = $s("#gpuLabel");
    if (!l) return;
    l.textContent = g.gpuLabel || ("GPU " + (g.gpu ? g.gpu + "%" : "--"));
    const miniComfy = $s("#miniComfy"), miniVram = $s("#miniVram"), miniQueue = $s("#miniQueue");
    if (miniComfy) miniComfy.textContent = (g.pingMs != null ? g.pingMs + " ms" : "--");
    if (miniVram) miniVram.textContent = (g.vramUsed ? g.vramUsed + "G" : "--");
    if (miniQueue) miniQueue.textContent = g.queue || 0;
  }

  function updateTaskBadge() {
    const n = A4P.jobs.active();
    const badge = $s("#taskBadge");
    if (!badge) return;
    badge.textContent = n;
    badge.classList.toggle("hidden", n === 0);
  }

  function toast(title, msg, type) {
    const wrap = $s("#toastWrap");
    if (!wrap) return;
    const el = document.createElement("div");
    el.className = "toast" + (type ? " " + type : "");
    el.innerHTML = "<strong>" + A4P.utils.escapeHtml(title) + "</strong>" + (msg ? "<span>" + A4P.utils.escapeHtml(msg) + "</span>" : "");
    wrap.appendChild(el);
    setTimeout(function () { try { wrap.removeChild(el); } catch (e) { /* noop */ } }, 3400);
  }

  function bindGlobal() {
    $s("#contextButton").onclick = function () { A4P.pageModals.openProject(); };
    $s("#gpuButton").onclick = function () { A4P.pageModals.openGpu(); };
    $s("#taskDrawerButton").onclick = function () { A4P.pageModals.openTasks(); };
    $s("#agentButton").onclick = function () { openDialog("#dlg-agent-drawer"); A4P.agent && A4P.agent.bootstrap(); };
    $s("#serviceButton").onclick = function () { switchPage("settings"); A4P.store.emit("settings:tab", "connections"); };
    $s("#commandButton").onclick = openCommand;
    /* modal/drawer close buttons via [data-close-dlg] */
    A4P.utils.$$("[data-close-dlg]").forEach(function (b) { b.onclick = function () { closeDialog(b.dataset.closeDlg); }; });
  }

  A4P.uiRouter = {
    switchPage: switchPage, openDialog: openDialog, closeDialog: closeDialog, closeAllDialogs: closeAllDialogs,
    openCommand: openCommand, bindShortcuts: bindShortcuts, bindGlobal: bindGlobal,
    updateTopbar: updateTopbar, updateHelperStatus: updateHelperStatus, updateGpu: updateGpu, updateTaskBadge: updateTaskBadge,
    toast: toast, renderShell: renderShell, COMMANDS: COMMANDS
  };
})();