/* ui/page-history: 生成历史与结果库 —— 真实任务产物 */
(function () {
  const t = A4P.t;

  function collections() {
    const hist = A4P.store.history || [];
    const count = function (pred) { return hist.reduce(function (n, h) { return n + (pred(h) ? (h.outputs || []).length : 0); }, 0); };
    return [
      { id: "favorites", icon: "★", name: "收藏", count: count(function (h) { return h.favorite; }) },
      { id: "kv", icon: "🛒", name: "Amazon KV", count: count(function (h) { return h.label && /KV|listing|kv/i.test(h.label); }) },
      { id: "all", icon: "🗂", name: "全部", count: count(function () { return true; }) }
    ];
  }

  A4P.pages.history = function (head, body) {
    const hist = A4P.store.history;
    const empty = '<div class="empty" style="padding:48px 0"><strong>还没有生成结果</strong><span>打开「生成」页提交真实任务，产物会归档到这里</span></div>';
    body.innerHTML =
      '<div class="quickbar"><span class="crumb">工作台 / 生成历史</span></div>' +
      '<div class="split-list" style="width:100%">' +
      '<div class="sidebar-card"><div class="section-title" style="margin-bottom:8px;padding:0 4px"><h2>结果库</h2></div>' +
      collections().map(function (c) { return '<button class="side-item active-item" data-col="' + c.id + '"><span>' + c.icon + "</span><strong>" + c.name + '</strong><em>' + c.count + "</em></button>"; }).join("") +
      '<button class="side-add">＋ 新建收藏集</button></div>' +
      '<div class="history-main card"><div class="section-head"><div class="section-title"><span class="kick"></span><h2>全部结果</h2></div>' +
      '<div class="button-row"><select class="mini-select"><option>最近使用</option><option>最早</option><option>按项目</option></select>' +
      '<button class="small">↻</button><button class="small">⋮⋮</button></div></div>' +
      (hist && hist.length
        ? '<div class="gallery">' + hist.map(function (h, i) {
          return h.outputs.map(function (o, j) {
            return '<figure class="gallery-item"><div class="gallery-thumb" style="background-image:url(' + o.thumb + ')">' +
              '<span class="gallery-ver">v' + (h.version || 1) + "</span></div>" +
              '<figcaption><strong>' + t("result") + " " + (i + 1) + "." + (j + 1) + "</strong><span>" + A4P.utils.fmtTime(h.createdAt) + "</span>" +
              '<span class="hint">' + A4P.utils.escapeHtml((h.payload && h.payload.prompt) ? String(h.payload.prompt).slice(0, 42) : "") + "</span></figcaption></figure>";
          }).join("");
        }).join("") + "</div>"
        : empty) + "</div></div>";
    body.querySelectorAll(".art-hover").forEach(function (b) {
      b.addEventListener("click", function () { A4P.app.showViewerAt(decodeURIComponent(b.dataset.preview)); });
    });
  };
})();