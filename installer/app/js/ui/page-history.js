/* ui/page-history: 生成历史与结果库 —— 真实来源 = Helper (SQLite jobs + assets) (PHASE 18)
 * 不再使用 const history=[] 作为正式真相源; 断线时显示真实错误。 */
(function () {
  const t = A4P.t;

  function loadFromHelper() {
    if (!A4P.helper || !A4P.helper.jobs) return Promise.resolve([]);
    return A4P.helper.jobs.list({ limit: 100 }).then(function (r) {
      return (r && Array.isArray(r.jobs) ? r.jobs : []).map(function (j) {
        let assetIds = [];
        try { assetIds = JSON.parse(j.result_assets_json || "[]"); } catch (e) { /* noop */ }
        let inputs = {};
        try { inputs = JSON.parse(j.inputs_json || "{}"); } catch (e) { /* noop */ }
        return {
          id: j.id,
          createdAt: j.created_at || Date.now(),
          label: j.title || "AI 任务",
          status: j.status,
          providerId: j.provider_id,
          workflowId: j.workflow_id,
          prompt: inputs.prompt || "",
          assetIds: assetIds
        };
      });
    }).catch(function () { return null; }); /* null = helper 不可用 */
  }

  A4P.pages.history = function (head, body) {
    const empty = '<div class="empty" style="padding:48px 0"><strong>还没有生成结果</strong><span>打开「生成」页提交真实任务，产物会归档到这里</span></div>';
    body.innerHTML =
      '<div class="quickbar"><span class="crumb">工作台 / 生成历史</span></div>' +
      '<div class="split-list" style="width:100%">' +
      '<div class="sidebar-card"><div class="section-title" style="margin-bottom:8px;padding:0 4px"><h2>结果库</h2></div>' +
      '<button class="side-item active-item" data-col="all"><span>🗂</span><strong>全部</strong><em id="histCount">…</em></button>' +
      '<button class="side-item" data-col="favorites"><span>★</span><strong>收藏</strong><em id="favCount">…</em></button></div>' +
      '<div class="history-main card"><div class="section-head"><div class="section-title"><span class="kick"></span><h2>全部结果</h2></div>' +
      '<div class="button-row"><select class="mini-select"><option>最近使用</option><option>最早</option><option>按项目</option></select>' +
      '<button class="small">↻</button></div></div>' +
      '<div id="histBody" class="history-body">' + empty + '</div></div></div>';

    const histBody = body.querySelector("#histBody");
    histBody.innerHTML = '<div class="empty" style="padding:48px 0"><strong>正在从 Helper 加载历史…</strong></div>';
    loadFromHelper().then(function (jobs) {
      if (jobs === null) {
        histBody.innerHTML = '<div class="empty" style="padding:48px 0"><strong>Helper 不可用</strong><span>无法加载历史（Helper 离线）</span></div>';
        return;
      }
      const countEl = body.querySelector("#histCount");
      if (countEl) countEl.textContent = jobs.length;
      if (!jobs.length) { histBody.innerHTML = empty; return; }
      histBody.innerHTML = '<div class="gallery">' + jobs.map(function (h, i) {
        return '<figure class="gallery-item"><div class="gallery-thumb" data-asset="' + (h.assetIds[0] || "") + '">' +
          '<span class="gallery-ver">' + A4P.utils.escapeHtml(h.status || "") + "</span></div>" +
          '<figcaption><strong>' + A4P.utils.escapeHtml(h.label) + "</strong><span>" + A4P.utils.fmtTime(h.createdAt) + "</span>" +
          '<span class="hint">' + A4P.utils.escapeHtml(h.prompt || "").slice(0, 42) + "</span></figcaption></figure>";
      }).join("") + "</div>";
      /* 缩略图: Helper Asset -> Blob URL (仅显示, 不持久化) */
      jobs.forEach(function (h) {
        if (!h.assetIds || !h.assetIds.length) return;
        const thumb = histBody.querySelector('.gallery-thumb[data-asset="' + h.assetIds[0] + '"]');
        if (!thumb || !A4P.helper.assets) return;
        A4P.helper.assets.get(h.assetIds[0]).then(function (buf) {
          try { thumb.style.backgroundImage = "url(" + URL.createObjectURL(new Blob([buf], { type: "image/png" })) + ")"; } catch (e) { /* noop */ }
        }).catch(function () { /* asset missing */ });
      });
    });
  };
})();
