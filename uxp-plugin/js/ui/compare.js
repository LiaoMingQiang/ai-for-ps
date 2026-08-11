/* ui/compare: Compare stage renderers (grid / 2 / 4 / before-after / overlay / diff) */
(function () {
  const FALLBACK = [
    { name: "Result 01", size: "2048x2048" }, { name: "Result 02", size: "2048x2048" },
    { name: "Result 03", size: "2048x2048" }, { name: "Result 04", size: "2048x2048" }
  ];

  function card(res, idx, selected) {
    const tone = ["", "b", "c", "d"][idx % 4];
    return '<div class="result-card ' + (selected ? "selected" : "") + '" data-cmp-select="' + idx + '">' +
      '<div class="result-art ' + tone + '">' + A4P.utils.escapeHtml(res.name || "Result") + "</div>" +
      '<div class="result-info"><span>' + A4P.utils.escapeHtml(res.name || "Result") + "</span><span>" + A4P.utils.escapeHtml(res.size || "2048") + "</span></div></div>";
  }

  function render(mode, container, results) {
    const r = (results && results.length) ? results : FALLBACK;
    let html = "";
    if (mode === "ba") {
      html = '<div style="padding:9px"><div class="compare-stage" style="display:flex;height:280px">' +
        '<div style="flex:1;background:#4c5663;display:flex;align-items:center;justify-content:center;color:#fff">原图（左）</div>' +
        '<div style="flex:1;background:#aeb9c4;display:flex;align-items:center;justify-content:center;color:#26313c">结果（右）</div>' +
        "</div></div>";
    } else if (mode === "two") {
      html = '<div class="result-grid">' + card(r[0], 0, true) + card(r[1] || r[0], 1, false) + "</div>";
    } else if (mode === "four") {
      html = '<div class="result-grid">' + [0, 1, 2, 3].map(function (i) { return card(r[i] || r[0], i, i === 0); }).join("") + "</div>";
    } else if (mode === "overlay") {
      html = '<div class="compare-stage" style="margin:9px;min-height:200px">' +
        '<div style="height:200px;background:#6f7883;opacity:.55"></div>' +
        '<div style="height:200px;background:#abb6c2;opacity:.68;border:1px solid #6e8bd8"></div>' +
        '<span class="state-chip info" style="margin:8px">Overlay 68%</span></div>';
    } else if (mode === "diff") {
      html = '<div class="compare-stage" style="margin:9px;min-height:200px;display:flex;align-items:center;justify-content:center;color:#ff9b9b">Difference 视图（不修改原结果文件）</div>';
    } else {
      html = '<div class="result-grid">' + r.map(function (x, i) { return card(x, i, i === 0); }).join("") + "</div>";
    }
    container.innerHTML = html;
    A4P.utils.$$("[data-cmp-select]", container).forEach(function (el) {
      el.onclick = function () {
        A4P.utils.$$("[data-cmp-select]", container).forEach(function (x) { x.classList.remove("selected"); });
        el.classList.add("selected");
        A4P.state.selectedResult = Number(el.dataset.cmpSelect);
        A4P.store.emit("compare:select", A4P.state.selectedResult);
      };
    });
  }

  A4P.compare = { render: render, FALLBACK: FALLBACK };
})();