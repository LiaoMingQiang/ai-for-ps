/* ui/page-edit: 图像编辑 (图生图 / 局部重绘 / 扩图 / 高清) */
(function () {
  const t = A4P.t;
  const MODE_LABELS = { "inpaint": "局部重绘", "outpaint": "扩图", "upscale": "高清", "crop": "裁切重绘", "clean": "去瑕疵" };  // eslint-disable-line no-unused-vars
  function esc(s) { return A4P.utils.escapeHtml(s); }

  const ui = {
    mode: "inpaint",
    brush: { size: 48, feather: 8, hardness: 0.5, showBrushCursor: false },
    mask: { source: "layer", refine: "expand", edge: "feather", previewColor: "rgba(255,60,60,0.35)" },
    inpaint: { denoise: 0.55, area: "selection", fill: "auto" },
    outpaint: { direction: "all", px: 256, bg: "content" },
    upscale: { factor: 4, method: "ai", sharp: 0.3 }
  };

  function html() {
    const S = [];
    S.push(
      '<div class="quickbar"><span class="crumb">工作台 / 图像编辑</span></div>',
      '<div class="edit-layout">',
      /* 左侧编辑区 */
      '<div class="edit-canvas card"><div class="canvas-head">' +
        '<div class="seg"><button class="seg-btn active" data-mode="inpaint">局部重绘</button><button class="seg-btn" data-mode="outpaint">扩图</button>' +
        '<button class="seg-btn" data-mode="upscale">高清</button><button class="seg-btn" data-mode="clean">去瑕疵</button></div>' +
        '<div class="button-row"><button class="small">撤销</button><button class="small">重做</button>' +
        '<button class="small" id="btnSnapshot">' + t("refresh_input") + "</button></div></div>" +
        '<div class="canvas-stage" id="canvasStage"><div class="canvas-empty" id="canvasEmpty"><strong>尚未同步图层快照</strong><small>在 Photoshop 端点击「刷新输入」获取当前图层的真实图像</small></div>' +
        '<div class="canvas-hint" id="canvasHint"><span>✎</span><strong>在图像上涂抹需要重绘的区域</strong><small>Alt + 拖动 擦除蒙版 · 快捷键 B 画笔 · E 橡皮 · 空格 平移</small></div>' +
        '<div class="canvas-toolbar"><button data-tool="brush" class="active">画笔</button><button data-tool="eraser">橡皮</button>' +
        '<button data-tool="lasso">套索</button><button data-tool="rect">矩形</button><span class="spacer"></span>' +
        '<span class="hint">画笔 \'</span><input data-brush="size" type="range" min="8" max="120" value="48"><span class="hint">羽化 </span>' +
        '<input data-brush="feather" type="range" min="0" max="24" value="8"></div></div>' +
        '<div class="canvas-foot"><span class="state-chip info">未同步 · UXP 版接入 Photoshop 后可获取图层快照</span><span class="hint">原图层不会被修改，编辑结果另存新图层</span></div></div>',
      /* 右侧参数 */
      '<div class="stack side">',
      '<div class="card"><div class="section-head"><div class="section-title"><span class="kick"></span><h2>区域与蒙版</h2></div></div>' +
        '<div class="segment" data-seg="mask-source"><button class="active">当前选区</button><button>自定义形状</button><button>手绘蒙版</button></div>' +
        '<div class="grid"><div class="col field"><span>细分方式</span><select><option>边缘扩展 +1px</option><option>Edge 检测</option><option>手动调整</option></select></div>' +
        '<div class="col field"><span>边缘羽化</span><select><option>Feather 2px</option><option>Feather 8px</option><option>硬边</option></select></div>' +
        '<div class="col field"><span>蒙版预览</span><div class="button-row"><button class="small">显示蒙版</button><button class="small">在 PS 中预览</button></div></div></div>' +
        '<div class="range-row"><label>画笔大小</label><input type="range" min="8" max="160" value="48" data-range="brushSize"><output>48 px</output></div></div>',
      '<div class="card" id="modeCard"><div class="section-head"><div class="section-title"><span class="kick"></span><h2>参数</h2></div><span class="state-chip info">' + t("st_ecom_mode") + "</span></div>" +
        '<div class="grid"><div class="col field"><span>重绘区域</span><select><option>仅蒙版区域</option><option>整幅图像</option></select></div>' +
        '<div class="col field"><span>填充内容</span><select><option>原图内容</option><option>纯色 / 透明</option><option>Latent Noise</option></select></div></div>' +
        '<div class="range-row"><label>重绘强度</label><input type="range" min="0" max="1" step="0.01" value="0.55" data-range="denoise"><output>0.55</output></div>' +
        '<div class="range-row"><label>CFG</label><input type="range" min="1" max="12" step="0.1" value="4.5" data-range="cfg"><output>4.5</output></div>' +
        '<div class="range-row"><label>Steps</label><input type="range" min="1" max="60" value="28" data-range="steps"><output>28</output></div>' +
        '<div class="hint">支持指定图层书籍“不用画”区域与结构保护；区域外像素完全保持不变。</div></div>',
      '<div class="card"><div class="section-head"><div class="section-title"><span class="kick"></span><h2>结果输出</h2></div></div>' +
        '<div class="output-strategies compact">' +
        '<button class="output-option active" data-strategy="smartObject"><strong>新智能对象</strong><span>原图上方</span></button>' +
        '<button class="output-option" data-strategy="inPlace"><strong>选区原位</strong><span>按原 bounds</span></button>' +
        '<button class="output-option" data-strategy="layer"><strong>新图层</strong><span>多结果</span></button></div>' +
        '<span class="hint">蒙版与输入会随结果保存，便于后续再次重绘。</span>' +
        '<button class="primary full" id="runEditBtn" style="margin-top:12px">运行编辑 · 局部重绘</button></div>',
      "</div></div>"
    );
    return S.join("");
  }

  function bind(body) {
    const $ = A4P.utils.$;
    const $$ = A4P.utils.$$;

    /** 模式切换 */
    const modeBtn = function (b) {
      b.addEventListener("click", function () {
        $$(".seg-btn", body).forEach(function (x) { x.classList.remove("active"); });
        b.classList.add("active");
        ui.mode = b.dataset.mode;
        $("#runEditBtn", body).textContent = "运行编辑 · " + b.textContent;
        $("#canvasHint strong", body).textContent = { inpaint: "在图像上涂抹需要重绘的区域", outpaint: "拖动边缘箭头选择扩图方向与幅度", upscale: "选择区域或点按「整幅高清」", clean: "涂抹要去除的瑕疵" }[ui.mode];
      });
    };
    $$("[data-mode]", body).forEach(modeBtn);

    /* 工具 */
    $$("[data-tool]", body).forEach(function (b) {
      b.addEventListener("click", function () {
        $$("[data-tool]", body).forEach(function (x) { x.classList.remove("active"); });
        b.classList.add("active");
      });
    });

    /* 滑块 */
    $$("[data-range]", body).forEach(function (r) {
      const out = r.parentElement.querySelector("output");
      r.addEventListener("input", function () {
        if (out) out.textContent = (r.dataset.range === "denoise" || r.dataset.range === "cfg") ? Number(r.value).toFixed(2) : r.value + (r.dataset.range === "brushSize" ? " px" : "");
        if (r.dataset.range === "brushSize") { $('#canvasStage', body).style.setProperty("--brushSize", r.value + "px"); }
      });
    });

    /* 选区段 */
    $$("[data-seg] button", body).forEach(function (b) {
      b.addEventListener("click", function () {
        $$(this.parentElement.querySelectorAll("button")).forEach(function (x) { x.classList.remove("active"); });
        b.classList.add("active");
      });
    });

    $("#btnSnapshot", body).addEventListener("click", function () {
      A4P.bridge.send({ type: "doc-snapshot" });
      A4P.app.toast("已请求同步图层快照（需 UXP 真实环境）");
    });

    /* 执行：浏览器版无真实快照/蒙版，引导到生成页（UXP 版才接深度编辑管线） */
    $("#runEditBtn", body).addEventListener("click", function () {
      A4P.app.toast("深度编辑需要 Photoshop 中的图层快照与蒙版，浏览器版请使用「生成」页提交真实任务", "warn");
      A4P.uiRouter.switchPage("generate");
    });
  }

  A4P.pages.edit = function (head, body) {
    body.innerHTML = html();
    bind(body);
  };
})();