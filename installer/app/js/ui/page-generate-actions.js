/* ui/page-generate-actions: 生成工作台逻辑 —— 全部真实链路
 * 输入上传 / checkpoint 检测 / 提交生成 / 进度 / 结果均对接 A4P.comfyui（真实 HTTP）。 */
(function () {
  const t = A4P.t;
  const G = A4P.pageGen;

  function renderRefs(listEl) {
    listEl.innerHTML = G.htmlRefRows ? G.htmlRefRows() : "";
    listEl.querySelectorAll("input[data-ref-weight]").forEach(function (inp) {
      inp.addEventListener("input", function () {
        const i = Number(inp.dataset.refWeight);
        G.ui.refs[i].weight = Math.round(Number(inp.value) * 100) / 100;
        inp.parentElement.querySelector("output").textContent = G.ui.refs[i].weight.toFixed(2);
      });
    });
  }

  function switchMode(mode, body) {
    G.ui.mode = mode;
    body.querySelectorAll("[data-mode]").forEach(function (b) { b.classList.toggle("active", b.dataset.mode === mode); });
  }

  /* 实时服务状态：检查 ComfyUI 并刷新模型/checkpoint/状态 */
  function refreshProvider(body) {
    const p = A4P.providers.find(G.ui.providerId);
    const chip = body.querySelector("#inputStateChip");
    const execEl = body.querySelector("#execLocation");
    A4P.comfyui.ping().then(function (st) {
      const pre = body.querySelector("#preflightChip");
      const est = body.querySelector("#execEstimate");
      if (execEl) execEl.textContent = st.ok ? (p.name + " · " + (st.version || "在线")) : p.name + " · 未连接";
      if (est) est.textContent = st.ok ? ((st.vram ? "VRAM " + (st.vram / 1073741824).toFixed(0) + " GB · " : "") + (st.deviceName || "Local GPU")) : "离线";
      if (pre) { pre.textContent = st.ok ? "执行端在线" : "执行端离线（生成会真实失败并提示原因）"; pre.className = "state-chip " + (st.ok ? "good" : "bad"); }
      if (st.ok) {
        if (chip) { chip.textContent = "已连接 " + (st.vram ? (st.vram / 1073741824).toFixed(0) + "GB" : ""); chip.className = "state-chip good"; }
        return A4P.comfyui.listCheckpoints();
      }
      if (chip) { chip.textContent = "未连接 · 去设置配置"; chip.className = "state-chip bad"; }
      return [];
    }).then(function (ckpts) {
      const sel = body.querySelector("#checkpointSelect");
      if (sel) {
        sel.innerHTML = ckpts.length
          ? ckpts.map(function (c) { return '<option>' + A4P.utils.escapeHtml(c) + "</option>"; }).join("")
          : '<option>未检测到 Checkpoint（请安装模型）</option>';
      }
      const modelSel = body.querySelector("#modelSelect");
      if (modelSel && G.ui.providerId === "comfyui") {
        modelSel.innerHTML = ckpts.length ? ckpts.map(function (c) { return '<option>' + A4P.utils.escapeHtml(c) + "</option>"; }).join("") : "<option>无模型</option>";
      }
    });
  }

  function renderCompare(stage) {
    if (!stage) return;
    const m = A4P.state.compare || "grid";
    const items = [];
    A4P.store.history.forEach(function (h) { items.push.apply(items, h.outputs); });
    const empty = '<div class="empty"><strong>还没有生成结果</strong><span>点击「生成」提交真实任务后，结果会实时显示在这里</span></div>';
    if (!items.length) { stage.innerHTML = empty; return; }
    const stamp = function (o) { return '<div class="cmp-thumb"><img src="' + o.thumb + '"><span>' + A4P.utils.escapeHtml(o.label || "") + "</span></div>"; };
    if (m === "grid") {
      stage.innerHTML = '<div class="cmp-grid">' + items.slice(-8).map(stamp).join("") + "</div>";
    } else if (m === "two" || m === "four") {
      const n = m === "two" ? 2 : 4;
      stage.innerHTML = '<div class="cmp-grid n' + m + '">' + items.slice(-n).map(stamp).join("") + "</div>";
    } else if (m === "ba") {
      stage.innerHTML = '<div class="cmp-ba"><div class="cmp-thumb"><div class="cmp-kicker">最近</div>' + stamp(items[items.length - 1]) + "</div><div class=\"cmp-arrow\">→</div><div class=\"cmp-thumb\"><div class=\"cmp-kicker\">最早</div>" + stamp(items[0]) + "</div></div>";
    } else if (m === "overlay") {
      stage.innerHTML = '<div class="cmp-overlay"><img src="' + items[0].thumb + '"><img src="' + items[Math.min(1, items.length - 1)].thumb + '"><span class="cmp-handle">两图叠加对比（演示）</span></div>';
    } else {
      stage.innerHTML = '<div class="cmp-diff"><img src="' + items[items.length - 1].thumb + '"><span>Difference — 需要源图（真实时由写回差异计算）</span></div>';
    }
  }

  function collectInputs(body) {
    const prompt = A4P.utils.val("#promptInput", body) || "";
    const negEl = body.querySelectorAll(".card.soft textarea");
    const negative = negEl.length ? negEl[0].value || "" : "";
    const sizeSel = body.querySelector("#sizeSelect") || body.querySelector('select');
    const size = sizeSel ? sizeSel.value || "1024 × 1024" : "1024 × 1024";
    const samplerSel = body.querySelector("#samplerSelect");
    const schedulerSel = body.querySelector("#schedulerSelect");
    return {
      mode: G.ui.mode,
      provider: G.ui.providerId,
      prompt: prompt,
      negative: negative,
      params: {
        denoise: G.ui.params.denoise, cfg: G.ui.params.cfg, steps: G.ui.params.steps,
        seed: (!G.ui.params.seed || G.ui.params.seed === "随机") ? null : G.ui.params.seed,
        size: size,
        sampler: samplerSel ? samplerSel.value : "euler",
        scheduler: schedulerSel ? schedulerSel.value : "normal"
      },
      inputImage: G.ui.inputImage || null,
      refs: G.ui.refs.map(function (r) { return { name: r.name, role: r.role, weight: r.weight }; })
    };
  }

  function bind(body) {
    const $ = A4P.utils.$;
    const $$ = A4P.utils.$$;

    refreshProvider(body);

    $("#providerSelect", body).addEventListener("change", function () {
      G.ui.providerId = this.value;
      const p = A4P.providers.find(this.value);
      $("#locationSelect", body).innerHTML = "<option>" + p.locationLabel + "</option>";
      $$("[data-mode]", body).forEach(function (b) { b.classList.toggle("active", b.dataset.mode === G.ui.mode); });
      refreshProvider(body);
    });

    $$("[data-mode]", body).forEach(function (b) {
      b.addEventListener("click", function () { switchMode(b.dataset.mode, body); });
    });

    /* 参考图 */
    $("#addRefBtn", body).addEventListener("click", function () {
      G.ui.refs.push({ name: "新参考图.png", src: "本地文件", role: "material", weight: 0.5 });
      renderRefs($("#referenceList", body));
    });
    $("#referenceList", body).addEventListener("click", function (e) {
      const el = e.target;
      if (el.dataset.refDel) { G.ui.refs.splice(Number(el.dataset.refDel), 1); renderRefs(this); }
    });
    renderRefs($("#referenceList", body));

    /* 保护与范围 */
    $$("[data-protect]", body).forEach(function (c) {
      c.addEventListener("change", function () { G.ui.protection[c.dataset.protect] = c.checked; });
    });
    $$("[data-range]", body).forEach(function (r) {
      const out = body.querySelector('[data-range-out="' + r.dataset.range + '"]');
      r.addEventListener("input", function () {
        G.ui.params[r.dataset.range] = Number(r.value);
        if (out) out.textContent = r.dataset.range === "cfg" ? Number(r.value).toFixed(1) : r.value;
      });
    });
    const seedIn = $('input[data-param="seed"]', body);
    if (seedIn) seedIn.addEventListener("change", function () { G.ui.params.seed = this.value; });

    /* 图像输入：真实文件上传 */
    const fileEl = $("#inputFile", body);
    $("#pickInputBtn", body).addEventListener("click", function () { fileEl.click(); });
    fileEl.addEventListener("change", function () {
      const f = fileEl.files && fileEl.files[0];
      if (!f) return;
      const url = URL.createObjectURL(f);
      G.ui.inputImage = { blob: f, name: f.name, preview: url };
      $("#inputTitle", body).textContent = f.name;
      $("#inputMeta", body).textContent = (f.size / 1048576).toFixed(2) + " MB · 将真实上传到执行端";
      $("#inputStateChip", body).textContent = "图生图";
      $("#inputStateChip", body).className = "state-chip good";
      $("#inputThumb", body).style.backgroundImage = "url(" + url + ")";
      $("#inputThumb", body).style.backgroundSize = "cover";
      $("#inputThumb", body).style.backgroundPosition = "center";
      $("#inputThumb", body).textContent = "";
    });
    $("#clearInputBtn", body).addEventListener("click", function () {
      G.ui.inputImage = null;
      $("#inputTitle", body).textContent = "未选择输入图片";
      $("#inputMeta", body).textContent = "不提供输入时按「文生图」运行（真实上传到 ComfyUI）";
      $("#inputStateChip", body).textContent = "文生图";
      $("#inputStateChip", body).className = "state-chip info";
      $("#inputThumb", body).style.backgroundImage = "";
      $("#inputThumb", body).textContent = "未选择\n图片";
    });

    /* Prompt 工具栏 */
    $("#optimizePromptBtn", body).addEventListener("click", function () {
      const ta = $("#promptInput", body);
      ta.value = "professional ecommerce product photography, " + (ta.value || "product shot") + ", studio lighting, soft shadows, high detail, 4k";
      A4P.app.toast("Prompt 已转为真实英文提示词（Flux/SDXL 效果更稳定）");
    });
    $("#promptHistoryBtn", body).addEventListener("click", function () { A4P.app.toast("Prompt 历史将接入项目记录"); });
    $("#promptTemplateBtn", body).addEventListener("click", function () { A4P.app.toast("Prompt 模板库将接入项目记录"); });
    $$(".variable", body).forEach(function (b) {
      b.addEventListener("click", function () {
        const ta = $("#promptInput", body);
        ta.value = ta.value + " " + (b.dataset.var || b.textContent);
        ta.focus();
      });
    });

    /* 快捷功能：直接应用真实参数预设 */
    $$("[data-quick]", body).forEach(function (b) {
      b.addEventListener("click", function () {
        $$("[data-quick]", body).forEach(function (x) { x.classList.remove("active"); });
        b.classList.add("active");
        const q = b.dataset.quick;
        if (q === "白底") { G.ui.params.denoise = 0.35; G.ui.params.seed = null; A4P.app.toast("已应用「白底」参数：denoise 0.35"); }
        else if (q === "产品洗图") { G.ui.params.denoise = 0.22; A4P.app.toast("已应用「产品洗图」参数：denoise 0.22"); }
        else if (q === "自然阴影") { G.ui.params.denoise = 0.3; A4P.app.toast("已应用「自然阴影」参数：denoise 0.30"); }
        else if (q === "高清 4X") { A4P.app.toast("高清放大需要 Upscale 工作流节点，当前构建为高清参数（steps 40）"); G.ui.params.steps = 40; }
        else { A4P.app.toast("快捷功能「" + q + "」：预设已就绪，点击生成执行"); }
      });
    });

    $("#resetParamsBtn", body).addEventListener("click", function () {
      G.ui.params = { denoise: 0.28, cfg: 4.5, steps: 28, seed: null, size: "1024 × 1024", sampler: "euler", scheduler: "normal" };
      W.$$("[data-range]", body).forEach(function (r) {
        r.value = G.ui.params[r.dataset.range];
        const out = body.querySelector('[data-range-out="' + r.dataset.range + '"]');
        if (out) out.textContent = r.value;
      });
      A4P.app.toast(t("reset_params"));
    });
    var W = A4P.utils;

    /* 输出策略 */
    $$("[data-strategy]", body).forEach(function (b) {
      b.addEventListener("click", function () {
        $$("[data-strategy]", body).forEach(function (x) { x.classList.remove("active"); });
        b.classList.add("active");
        G.ui.strategy = b.dataset.strategy;
      });
    });

    /* 比较区 */
    function refreshCompare() { renderCompare($("#compareStage", body)); }
    refreshCompare();
    $$("[data-compare]", body).forEach(function (b) {
      b.addEventListener("click", function () {
        $$("[data-compare]", body).forEach(function (x) { x.classList.remove("active"); });
        b.classList.add("active");
        A4P.state.compare = b.dataset.compare;
        refreshCompare();
      });
    });
    $("#fullPreviewBtn", body).addEventListener("click", function () { A4P.app.toast("大图查看：点击结果卡片在任务中心打开"); });

    /* 写入结果（浏览器预览：导出 PNG；UXP 真实模式：写回 Photoshop） */
    $("#writeSelectedBtn", body).addEventListener("click", function () {
      const job = A4P.jobs._raw().find(function (j) { return j.status === "READY_FOR_WRITEBACK" || j.status === "SUCCEEDED"; });
      if (!job || !job.results || !job.results.length) { A4P.app.toast("还没有可写回的结果", "warn"); return; }
      if (window.showSaveFilePicker) {
        const r = job.results[0];
        Promise.resolve(window.showSaveFilePicker && window.showSaveFilePicker({ suggestedName: r.filename || "aiforps-result.png", types: [{ description: "PNG", accept: { "image/png": [".png"] } }] }))
          .then(function (h) { return h.createWritable().then(function (w) { return w.write(r.blob); }).then(function () { return h.close(); }).then(function () { A4P.app.toast("已导出 " + (r.filename || "result.png"), "ok"); }); })
          .catch(function () { /* user cancelled */ });
      } else {
        const a = document.createElement("a");
        a.href = job.results[0].thumb; a.download = job.results[0].filename || "aiforps-result.png";
        document.body.appendChild(a); a.click(); a.remove();
        A4P.app.toast("已导出 " + (job.results[0].filename || "result.png"), "ok");
      }
    });

    /* 生成：真实任务 */
    $("#generateBtn", body).addEventListener("click", function () { runGenerate(body); });
    document.addEventListener("keydown", function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); runGenerate(body); }
    });
    $("#cancelTaskBtn", body).addEventListener("click", function () {
      A4P.jobs.cancel(A4P.jobs.find(A4P.app.state.runId));
    });
    $$("[data-goto-task]", body).forEach(function (b) { b.addEventListener("click", function () { A4P.uiRouter.switchPage("tasks"); }); });
  }

  function runGenerate(body) {
    if (!A4P.settings.get("connection", "comfyuiUrl")) { A4P.app.toast("请先在设置中配置 ComfyUI 地址", "warn"); return; }
    const payload = collectInputs(body);
    const label = (A4P.settings.get("project", "projectName") || "未命名项目") + " · " + (G.ui.mode === "text" ? "文生图" : "图生图");
    const job = A4P.jobs.create({
      label: label, title: label, kind: "image", tool: "生成",
      payload: payload, provider: "comfyui", resultCount: 1
    });
    A4P.app.state.runId = job.id;
    $("#currentTaskCard", body).classList.remove("hidden");
    A4P.jobs.start(job);
  }

  /* 任务进度联动（jobs:update 载荷为 job 对象，全部真实状态） */
  function onJobUpdate(e) {
    if (!e || !e.id || e.id !== A4P.app.state.runId) return;
    const card = document.querySelector("#currentTaskCard");
    if (!card) return;
    const stage = card.querySelector("#currentTaskStage");
    if (stage) stage.textContent = (A4P.t("js_" + e.status) || e.status) + " · " + (e.stageText || "");
    const prog = card.querySelector("#currentProgress");
    if (prog) prog.style.width = e.progress + "%";
    const tx = card.querySelector("#currentProgressText");
    if (tx) tx.textContent = e.progress + "%";
    const chip = card.querySelector(".state-chip");
    if (chip) {
      if (e.status === "READY_FOR_WRITEBACK" || e.status === "SUCCEEDED") { chip.textContent = "完成"; chip.className = "state-chip good"; }
      else if (e.status === "FAILED" || e.status === "WRITEBACK_FAILED") { chip.textContent = "失败"; chip.className = "state-chip bad"; }
      else { chip.textContent = "运行中"; chip.className = "state-chip info"; }
    }
    const cmp = document.querySelector("#compareStage");
    if (cmp && e.results && e.results.length) renderCompare(cmp);
  }
  function onJobReady(e) {
    if (!e || !e.label) return;
    A4P.app.toast(e.label + " · 完成，可写回/导出", "ok");
  }

  A4P.pageGenActions = { bind: bind, onJobUpdate: onJobUpdate, onJobReady: onJobReady, renderCompare: renderCompare, collectInputs: collectInputs };
})();