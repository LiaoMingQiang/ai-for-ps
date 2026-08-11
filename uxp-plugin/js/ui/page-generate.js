/* ui/page-generate: 生成工作台 - 视图 (template 部分) */
(function () {
  const t = A4P.t;
  const MODES = ["image", "text", "multi", "edit", "local", "outpaint", "upscale", "product", "view"];
  const MODE_LABELS = { image: "图生图", text: "文生图", multi: "多图参考", edit: "全图编辑", local: "局部编辑", outpaint: "扩图", upscale: "高清", product: "产品精修", view: "多视角" };
  const QUICK = ["产品洗图", "白底", "自然阴影", "高清 4X", "局部重绘", "扩图"];
  const OUTPUTS = [
    { id: "smartObject", name: "新智能对象", desc: "来源图层上方 · 推荐" },
    { id: "pixelLayer", name: "新像素图层", desc: "适合局部编辑" },
    { id: "inPlace", name: "选区原位", desc: "按原 bounds 对齐" },
    { id: "newDoc", name: "新文档", desc: "保留原始尺寸" },
    { id: "group", name: "自动图层组", desc: "Input / Mask / Output" },
    { id: "saveOnly", name: "只保存结果", desc: "不修改 Photoshop" }
  ];
  const ui = {
    providerId: "comfyui", mode: "image", strategy: "smartObject", inputImage: null,
    refs: [],
    protection: { contour: true, logo: true, text: true, color: true, texture: false, structure: 0.85, textStrength: 0.95 },
    params: { denoise: 0.28, cfg: 4.5, steps: 28, seed: "", size: "1024 × 1024", sampler: "euler", scheduler: "normal" },
    matrix: { Seed: [], Denoise: [], Preset: [] }
  };

  function esc(s) { return A4P.utils.escapeHtml(s); }

  function refRows() {
    return ui.refs.map(function (r, i) {
      const opts = A4P.providers.REF_ROLES.map(function (rr) {
        return '<option value="' + rr.id + '"' + (rr.id === r.role ? " selected" : "") + ">" + rr.label + "</option>";
      }).join("");
      return '<div class="ref-row"><div class="mini-thumb">' + (i + 1) + "</div>" +
        '<div class="ref-main"><strong>' + esc(r.name) + "</strong><small>" + esc(r.src) + "</small></div>" +
        '<select data-ref-role="' + i + '">' + opts + "</select>" +
        '<div class="weight"><input type="range" min="0" max="1" step=".05" value="' + r.weight + '" data-ref-weight="' + i + '"><output>' + r.weight.toFixed(2) + "</output></div>" +
        '<button class="icon-btn" data-ref-del="' + i + '">×</button></div>';
    }).join("");
  }

  function protectItem(key, name, en, checked) {
    return '<label class="protect-item"><input type="checkbox" data-protect="' + key + '"' + (checked ? " checked" : "") + "><div><strong>" + name + "</strong><small>" + en + "</small></div></label>";
  }

  function rangeRow(label, key, min, max, step, value) {
    return '<div class="range-row"><label>' + label + "</label>" +
      '<input type="range" min="' + min + '" max="' + max + '" step="' + step + '" value="' + value + '" data-range="' + key + '">' +
      '<output data-range-out="' + key + '">' + value + "</output></div>";
  }

  function html() {
    const p = A4P.providers.find(ui.providerId);
    const modeTabs = MODES.map(function (m) {
      return '<button class="tab' + (m === ui.mode ? " active" : "") + '" data-mode="' + m + '">' + MODE_LABELS[m] + "</button>";
    }).join("");
    const providerOpts = A4P.providers.PROVIDERS.map(function (pr) {
      return '<option value="' + pr.id + '"' + (pr.id === ui.providerId ? " selected" : "") + ">" + pr.name + "</option>";
    }).join("");
    const modelOpts = p.models.length ? p.models.map(function (m) { return "<option>" + esc(m) + "</option>"; }).join("") : '<option>加载服务端模型…</option>';
    const sources = ["当前图层", "多选图层", "当前选区", "图层蒙版", "合并可见", "上传 / 粘贴", "最近输入"].map(function (s, i) {
      return '<button class="source' + (i === 0 ? " active" : "") + '">' + s + "</button>";
    }).join("");
    const outputOpts = OUTPUTS.map(function (o) {
      return '<button class="output-option' + (o.id === ui.strategy ? " active" : "") + '" data-strategy="' + o.id + '"><strong>' + o.name + "</strong><span>" + o.desc + "</span></button>";
    }).join("");
    const matrixBoxes = Object.keys(ui.matrix).map(function (k) {
      return '<div class="matrix-box"><strong>' + k + "</strong><div class=\"matrix-values\">" +
        ui.matrix[k].map(function (v) { return '<span class="matrix-value">' + v + "</span>"; }).join("") +
        '<span class="matrix-value">＋</span></div></div>';
    }).join("");
    const compareLabels = { grid: "网格", two: "2 图", four: "4 图", ba: "Before / After", overlay: "Overlay", diff: "Difference" };
    const compareTabs = ["grid", "two", "four", "ba", "overlay", "diff"].map(function (m) {
      return '<button class="compare-tab' + (m === A4P.state.compare ? " active" : "") + '" data-compare="' + m + '">' + compareLabels[m] + "</button>";
    }).join("");
    const quickBtn = QUICK.map(function (q, i) {
      return '<button class="quick-action' + (i === 0 ? " active" : "") + '" data-quick="' + q + '">' + q + "</button>";
    }).join("");

    const S = [];
    S.push(
      '<div class="quickbar"><span class="label">⚡ 快捷功能</span>' + quickBtn + '<button class="icon-btn" title="管理快捷功能">＋</button></div>',
      '<div class="card emphasis project-card"><div class="project-main"><strong>' + esc(A4P.settings.get("project", "projectName")) + "</strong><span>已关联当前 PSD · 任务与结果自动归档到结果库</span></div>" +
        '<div class="project-stat"><strong>' + A4P.store.history.length + '</strong><span>AI 任务</span></div><div class="project-stat"><strong>' + A4P.store.history.filter(function (h) { return h.outputs && h.outputs.length; }).length + '</strong><span>有结果</span></div>' +
        '<div class="project-stat"><strong>—</strong><span>项目工作流</span></div><div class="project-stat"><strong>—</strong><span>Prompt 模板</span></div></div>',
      '<div class="mode-tabs" style="margin-bottom:14px">' + modeTabs + "</div>",
      '<div class="workspace"><div class="stack">',
      /* 模型与能力预检 */
      '<div class="card"><div class="section-head"><div class="section-title"><span class="kick"></span><h2>模型与能力预检</h2></div><button class="small" id="preflightBtn">' + t("preflight") + "</button></div>" +
        '<div class="grid3"><div class="col field"><span>执行来源</span><select id="providerSelect">' + providerOpts + "</select></div>" +
        '<div class="col field"><span>模型 / 工作流</span><select id="modelSelect">' + modelOpts + "</select></div>" +
        '<div class="col field"><span>处理位置</span><select id="locationSelect"><option>' + p.locationLabel + "</option><option>用户远程 ComfyUI</option><option>第三方云 API</option></select></div></div>" +
        '<div class="capability-strip" id="capabilityStrip">' + A4P.providers.renderCapabilityStrip(p) + "</div></div>",
      /* 图像输入 */
      '<div class="card"><div class="section-head"><div class="section-title"><span class="kick"></span><h2>图像输入</h2></div><span class="state-chip info" id="inputStateChip">文生图</span></div>' +
        '<div class="input-sources">' + sources + "</div>" +
        '<div class="input-card"><div class="thumb" id="inputThumb">未选择<br>图片</div>' +
        '<div class="input-meta"><strong id="inputTitle">未选择输入图片</strong><span id="inputMeta">不提供输入时按「文生图」运行（真实上传到 ComfyUI）</span>' +
        '<span class="dim">图片会真实上传到执行端，生成完成后不会保留在本地</span>' +
        '<div class="button-row"><button class="small" id="pickInputBtn">上传图片</button>' +
        '<button class="small" id="clearInputBtn">清除输入</button></div></div>' +
        '<input type="file" id="inputFile" accept="image/png,image/jpeg,image/webp" hidden></div>' +
        '<div class="section-head" style="margin-top:12px;margin-bottom:6px"><div><h3>参考图系统</h3><span class="hint">角色和权重由 Provider Adapter 映射到实际模型能力。</span></div>' +
        '<button class="small" id="addRefBtn">' + t("add_ref") + "</button></div>" +
        '<div class="references" id="referenceList">' + refRows() + "</div></div>",
      /* 产品保护 */
      '<div class="card"><div class="section-head"><div class="section-title"><span class="kick"></span><h2>产品结构保护</h2></div><span class="state-chip info">' + t("st_ecom_mode") + "</span></div>" +
        '<div class="protect-grid">' + protectItem("contour", "产品轮廓", "Contour", true) + protectItem("logo", "Logo", "Logo Mask", true) +
        protectItem("text", "包装文字", "Text Protect", true) + protectItem("color", "颜色", "Color Lock", true) + protectItem("texture", "材质纹理", "Texture", false) + "</div>" +
        '<div class="grid" style="margin-top:12px"><div class="col">' + rangeRow("结构保持强度", "structure", 0, 1, 0.05, 0.85) + rangeRow("Logo/文字保护", "textStrength", 0, 1, 0.05, 0.95) + "</div>" +
        '<div class="col field"><span>保护区域来源</span><div class="mask-tags"><span class="pill">自动检测文字</span><span class="pill">Logo Layer</span><span class="pill">当前选区</span><button class="small">＋ 指定图层</button></div></div></div></div>',
      /* Prompt */
      '<div class="card"><div class="section-head"><div class="section-title"><span class="kick"></span><h2>Prompt 与变量</h2></div><div class="button-row">' +
        '<button class="small" id="promptHistoryBtn">' + t("prompt_history") + "</button><button class=\"small\" id=\"promptTemplateBtn\">" + t("prompt_template") + '</button>' +
        '<button class="small" id="reversePromptBtn">' + t("reverse_prompt") + '</button><button class="small" id="optimizePromptBtn">' + t("optimize_prompt") + "</button></div></div>" +
        '<div class="prompt-toolbar"><span class="hint">支持项目变量、模板版本和回滚</span><span class="state-chip good">v7 已保存</span></div>' +
        '<textarea id="promptInput">专业电商产品摄影，保持 {product} 的包装结构、Logo 和印刷文字，真实材质，干净背景，柔和轮廓光，自然接触阴影。</textarea>' +
        '<div class="variables">' + ["{product}", "{material}", "{scene}", "{brand_color}"].map(function (v) { return '<button class="variable" data-var="' + v + '">' + v + "</button>"; }).join("") + '<button class="variable">＋ 新建变量</button></div>' +
        '<div class="card soft" style="margin-top:10px"><div class="section-head"><h3>负面提示词与 Prompt 版本</h3></div><div class="grid">' +
        '<div class="col field"><span>负面提示词</span><textarea style="min-height:64px">distorted package, wrong logo, extra text, deformed product</textarea></div>' +
        '<div class="col field"><span>版本</span><select><option>v7 · 当前</option><option>v6 · 强化材质</option><option>v5 · 白底方案</option></select>' +
        '<div class="button-row" style="margin-top:8px"><button class="secondary small">对比版本</button><button class="secondary small">恢复此版本</button></div></div></div></div></div>',
      /* 参数 */
      '<div class="card"><div class="section-head"><div class="section-title"><span class="kick"></span><h2>参数设置</h2></div><button class="small" id="resetParamsBtn">' + t("reset_params") + "</button></div>" +
        '<div class="grid3"><div class="col field"><span>尺寸</span><select id="sizeSelect"><option>1024 × 1024</option><option>768 × 1024</option><option>1024 × 768</option><option>2048 × 2048</option></select></div>' +
        '<div class="col field"><span>Sampler</span><select id="samplerSelect"><option>euler</option><option>dpmpp_2m</option><option>dpmpp_sde</option><option>uni_pc</option></select></div>' +
        '<div class="col field"><span>Scheduler</span><select id="schedulerSelect"><option>normal</option><option>karras</option><option>simple</option></select></div></div>' +
        rangeRow("Denoise", "denoise", 0, 1, 0.01, 0.28) + rangeRow("CFG", "cfg", 1, 12, 0.1, 4.5) + rangeRow("Steps", "steps", 1, 60, 1, 28) +
        '<div class="card soft" style="margin-top:12px"><div class="section-head"><h3>模型与高级参数</h3></div><div class="grid3">' +
        '<div class="col field"><span>Checkpoint（服务端真实检测）</span><select id="checkpointSelect"><option>正在检测服务端模型…</option></select></div>' +
        '<div class="col field"><span>VAE</span><select><option>跟随 Checkpoint</option></select></div>' +
        '<div class="col field"><span>LoRA</span><select><option>无</option></select></div>' +
        '<div class="col field"><span>Seed 模式</span><select><option>自动随机</option><option>固定</option></select></div>' +
        '<div class="col field"><span>Seed</span><input data-param="seed" value=""></div>' +
        '<div class="col field"><span>批量</span><select><option>1</option><option>2</option><option>4</option></select></div></div></div></div>',
      /* 批量 */
      '<div class="card"><div class="section-head"><div class="section-title"><span class="kick"></span><h2>批量参数矩阵</h2></div><span class="state-chip info">未启用（当前单任务）</span></div>' +
        '<div class="batch-matrix">' + matrixBoxes + "</div></div>",
      /* 输出 */
      '<div class="card"><div class="section-head"><div class="section-title"><span class="kick"></span><h2>输出与 Photoshop 写回</h2></div><span class="state-chip good">' + t("st_default_non_destructive") + "</span></div>" +
        '<div class="output-strategies">' + outputOpts + "</div>" +
        '<div class="grid3" style="margin-top:10px"><div class="col field"><span>目标图层组</span><select><option>AI Results / Amazon KV</option><option>文档顶部</option></select></div>' +
        '<div class="col field"><span>图层命名</span><input value="AI-{tool}-v{version}-Seed{seed}"></div>' +
        '<div class="col field"><span>尺寸不一致</span><select><option>保持原尺寸，写回前询问</option><option>适配画布</option><option>新文档</option></select></div></div></div>',
      "</div>",
      /* 右侧执行列 */
      '<div class="stack side">',
      '<div class="card emphasis"><div class="section-head"><div class="section-title"><span class="kick"></span><h2>执行</h2></div><span class="state-chip info" id="preflightChip">检测执行端…</span></div>' +
        '<div class="grid"><div class="col"><span class="hint">执行</span><strong style="display:block;margin-top:3px" id="execLocation">' + p.name + "</strong></div>" +
        '<div class="col"><span class="hint">执行端</span><strong style="display:block;margin-top:3px" id="execEstimate">未检测</strong></div></div>' +
        '<button class="primary full" id="generateBtn" style="height:42px;margin-top:12px">' + t("generate") + "</button>" +
        '<div class="hint" style="text-align:center;margin-top:7px">Ctrl / Cmd + Enter · 不会覆盖原图层</div></div>',
      '<div class="card task-current hidden" id="currentTaskCard"><div class="task-head"><div class="task-icon">↻</div><div class="task-main"><strong>当前任务</strong><div class="task-stage" id="currentTaskStage">—</div></div><span class="state-chip info">运行中</span></div>' +
        '<div class="progress"><span id="currentProgress" style="width:0%"></span></div>' +
        '<div class="task-metrics"><span id="currentProgressText">0%</span><span>已用 -- · 预计 --</span></div>' +
        '<div class="monitor-mini"><div><strong id="mGpu">--</strong><span>GPU</span></div><div><strong id="mVram">--</strong><span>VRAM</span></div>' +
        '<div><strong id="mQueue">0</strong><span>队列</span></div><div><strong id="mPing">--</strong><span>Ping</span></div></div>' +
        '<div class="button-row" style="margin-top:9px"><button class="small" id="cancelTaskBtn">' + t("cancel_task") + "</button><button class=\"small\" data-goto-task>任务详情</button></div></div>",
      '<div class="card"><div class="section-head"><div class="section-title"><span class="kick"></span><h2>结果比较</h2></div><button class="small" id="fullPreviewBtn">' + t("full_preview") + "</button></div>" +
        '<div class="compare-tabs">' + compareTabs + "</div>" +
        '<div class="compare-stage" id="compareStage"></div>' +
        '<div class="compare-controls"><div class="button-row"><label><input type="checkbox" checked> 同步 Zoom</label><label><input type="checkbox" checked> 同步 Pan</label></div><span class="hint">100% · Fit</span></div>' +
        '<div class="button-row" style="margin-top:9px"><button class="primary" id="writeSelectedBtn">' + t("write_selected") + "</button>" +
        '<button class="secondary">' + t("contact_sheet") + '</button><button class="secondary">' + t("create_artboard") + "</button></div></div>",
      "</div></div>"
    );
    return S.join("");
  }

  A4P.pageGen = { ui: ui, html: html, htmlRefRows: refRows, rangeRow: rangeRow, protectItem: protectItem, MODE_LABELS: MODE_LABELS, QUICK: QUICK, OUTPUTS: OUTPUTS };

  A4P.pages = A4P.pages || {};
  A4P.pages.generate = function (head, body) {
    body.innerHTML = html();
    A4P.pageGenActions.bind(body);
    A4P.store.on("jobs:update", A4P.pageGenActions.onJobUpdate);
    A4P.store.on("jobs:ready", A4P.pageGenActions.onJobReady);
  };
})();