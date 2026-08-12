/* ui/page-workflows: 项目工作流 (计划 / 执行 / 复盘) */
(function () {
  const t = A4P.t;
  const HTML = [
    '<div class="quickbar"><span class="crumb">工作台 / 项目工作流</span></div>',
    '<div class="wf-grid">',
    /* 计划列 */
    '<div class="card"><div class="section-head"><div class="section-title"><span class="kick"></span><h2>计划 · 项目工作流</h2></div><button class="small">＋ 新建节点</button></div>',
    '<div class="flow" id="flowList"></div>',
    '<div class="hint boxed">节点可拖拽排序、右键编辑参数；「批准」后转换为任务开始执行并计入项目统计。</div></div>',
    /* 执行列 */
    '<div class="card"><div class="section-head"><div class="section-title"><span class="kick"></span><h2>执行 · 单步运行</h2></div><button class="small" id="stopBtn">停止</button></div>',
    '<div id="runnerBox" class="runner"><div class="runner-stage">空闲</div><div class="progress"><span id="runnerProg" style="width:0%"></span></div>' +
    '<div class="task-metrics"><span id="runnerMeta">等待启动</span><span>队列 0</span></div></div>',
    '<div class="button-row"><button class="small" id="rewindBtn">上一节点</button><button class="primary" id="stepBtn">▶ 执行当前节点</button><button class="small" id="playBtn">▶▶ 整线运行</button></div></div>',
    /* 复盘列 */
    '<div class="card"><div class="section-head"><div class="section-title"><span class="kick"></span><h2>复盘 · 结果与理念</h2></div><button class="small">导出报告</button></div>',
    '<div class="metric-grid">' +
    '<div class="metric-card"><strong>—</strong><span>Concept/Aesthetic 一致性</span></div><div class="metric-card"><strong>—</strong><span>平均单任务</span></div>' +
    '<div class="metric-card"><strong>—</strong><span>Variance 变化率</span></div><div class="metric-card"><strong>—</strong><span>Outlier 命中</span></div></div>',
    '<div class="hint boxed" style="margin-top:10px">复盘指标由真实任务批量比较后计算；当前暂无已完成的工作流批次。</div></div>',
    '</div>'
  ].join("");

  function bind(body) {
    const $ = A4P.utils.$;
    const counts = {
      wf: (A4P.settings.get("project", "workflows") || []).length,
      prompt: (A4P.settings.get("prompts", "templates") || []).length
    };
    /* PHASE 9: 工作流列表来自 Helper (SQLite), 不再是本地静态数据 */
    const flowList = $("#flowList", body);
    flowList.innerHTML = '<div class="empty" style="padding:24px 0"><strong>正在从 Helper 加载工作流…</strong></div>';
    if (A4P.helper && A4P.helper.workflows && A4P.helper.workflows.list) {
      A4P.helper.workflows.list().then(function (r) {
        const wfs = (r && Array.isArray(r.workflows) ? r.workflows : []);
        flowList.innerHTML = wfs.length
          ? wfs.map(function (w, i) {
            return '<div class="flow-node"><div class="flow-index">' + (i + 1) + '</div><div class="flow-body"><strong>' + A4P.utils.escapeHtml(w.name || ("工作流 " + (i + 1))) + "</strong><span>v" + A4P.utils.escapeHtml(w.version || "1.0.0") + " · " + A4P.utils.escapeHtml(w.provider || "") + " · " + A4P.utils.escapeHtml((w.detected_fields ? Object.keys(JSON.parse(w.detected_fields || "{}")).length : 0) + " 字段") + "</span></div></div>";
          }).join("")
          : '<div class="empty" style="padding:24px 0"><strong>还没有项目工作流</strong><span>在「生成」页或导入对话框粘贴 ComfyUI API JSON 导入</span></div>';
      }).catch(function () {
        flowList.innerHTML = '<div class="empty" style="padding:24px 0"><strong>Helper 不可用</strong><span>无法加载工作流列表（Helper 离线）</span></div>';
      });
    } else {
      flowList.innerHTML = '<div class="empty" style="padding:24px 0"><strong>还没有项目工作流</strong><span>Helper 客户端不可用</span></div>';
    }

    const runner = A4P.jobs._raw ? A4P.jobs.list() : [];
    const live = runner.filter(function (j) { return j.results && j.results.length; }).length;
    $("#runnerMeta", body).textContent = "本地任务 " + runner.length + " · 有结果 " + live + " · 队列等待服务端";
    $("#runnerProg", body).style.width = Math.min(100, runner.length * 2) + "%";

    $("#stepBtn", body).addEventListener("click", function () {
      A4P.app.toast("工作流节点运行需要 UXP 真实环境（节点→任务管线）；浏览器版请用「生成」页直接提交任务", "warn");
    });
    $("#playBtn", body).addEventListener("click", function () {
      A4P.app.toast("整线运行需要 UXP 真实环境，浏览器版请逐一在「生成」页提交任务", "warn");
    });
    $("#stopBtn", body).addEventListener("click", function () {
      A4P.app.toast("无运行中的工作流（浏览器版）");
    });
    $("#rewindBtn", body).addEventListener("click", function () {
      A4P.app.toast("已回到计划视图，节点状态待 UXP 同步");
    });
  }

  A4P.pages.workflows = function (head, body) {
    body.innerHTML = HTML;
    bind(body);
  };
})();