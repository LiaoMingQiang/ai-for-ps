/* ui/page-settings: 设置 —— 真实连接配置与检测 */
(function () {
  function providerRows() {
    return A4P.providers.PROVIDERS.map(function (p) {
      const enabled = p.id === "comfyui" || (A4P.settings.get("connection", "connections") || []).some(function (c) { return c.type === p.id || c.id === p.id; });
      const st = enabled
        ? '<span class="state-chip good">' + A4P.t("st_connected") + "</span>"
        : '<span class="state-chip warning">' + A4P.t("st_need_config") + "</span>";
      const note = p.id === "comfyui" ? "真实 HTTP API · " + (A4P.settings.get("connection", "comfyuiUrl") || "未设置") : p.locationLabel;
      return '<div class="provider-row"><div class="provider-logo">' + p.name.slice(0, 1) + "</div>" +
        '<div class="provider-main"><strong>' + p.name + "</strong><span>" + note + "</span></div>" + st +
        '<button class="small-outline" data-test="' + p.id + '">测试</button>' +
        '<label class="switch"><input type="checkbox" data-toggle="' + p.id + '"' + (enabled ? " checked" : "") + "><i></i></label>" +
        "</div>";
    }).join("");
  }

  const HTML = [
    '<div class="quickbar"><span class="crumb">工作台 / 设置</span></div>',
    '<div class="grid2"><div class="col">',
    '<div class="card"><div class="section-head"><div class="section-title"><span class="kick"></span><h2>Provider 连接</h2></div>' +
    '<span class="state-chip" id="connChip">未检测</span></div>' +
    '<div class="provider-list" id="providerList">' + providerRows() + "</div></div>",
    '<div class="card"><div class="section-head"><div class="section-title"><span class="kick"></span><h2>ComfyUI 执行端</h2></div></div>' +
    '<div class="grid"><div class="col field"><span>ComfyUI 地址</span><input id="comfyUrl" placeholder="http://127.0.0.1:8188" value="' + (A4P.settings.get("connection", "comfyuiUrl") || "") + '"></div>' +
    '<div class="col field"><span>状态</span><span class="state-chip info" id="comfyChip">点击「测试连接」检测</span></div></div>' +
    '<div class="button-row" style="margin-top:10px"><button class="primary small" id="comfyTestBtn">测试连接</button>' +
    '<button class="small" id="comfySaveBtn">保存地址</button></div>' +
    '<div class="hint">浏览器版会真实调用该地址的 ComfyUI API（/system_stats、/object_info、/prompt、/view）。<br>UXP 版同样经此地址，或由 Photoshop 端 Helper 代理。</div></div>',
    '<div class="card"><div class="section-head"><div class="section-title"><span class="kick"></span><h2>生成默认值</h2></div></div>' +
    '<div class="grid"><div class="col field"><span>默认输出策略</span><select><option>新智能对象（推荐）</option><option>新像素图层</option><option>选区原位</option></select></div>' +
    '<div class="col field"><span>默认尺寸</span><select><option>2048 × 2048</option><option>1536 × 2048</option><option>1024 × 1024</option></select></div>' +
    '<div class="col field"><span>写回前安全校验</span><label class="switch"><input type="checkbox" checked><i></i></label></div>' +
    '<div class="col field"><span>尺寸不一致处理</span><select><option>保持原尺寸，写回前询问</option><option>适配画布</option></select></div></div></div>',
    "</div><div class=\"col\">",
    '<div class="card"><div class="section-head"><div class="section-title"><span class="kick"></span><h2>刷新与重置</h2></div></div>' +
    '<div class="button-row"><button class="small" id="devReload">重新加载插件</button><button class="small danger" id="devReset">清除本地数据</button></div>' +
    '<div class="hint" style="margin-top:10px">清除本地任务与结果缓存，不会修改 Photoshop 图层与 ComfyUI 文件。</div></div>',
    '<div class="card"><div class="section-head"><div class="section-title"><span class="kick"></span><h2>关于</h2></div></div>' +
    '<div class="about"><div class="logo-big">AI</div><div><strong>AI-for-PS · 电商 AI 工作台</strong><span>v0.5.0</span><span>核心：ComfyUI + 深度编辑 + 电商保护 + 任务管线（浏览器版为真实链路预览）</span></div></div>' +
    '<pre class="log" id="bootLog">[core] providers: comfyui (真实 HTTP)\n' +
    '[comfy] API 地址: ' + (A4P.settings.get("connection", "comfyuiUrl") || "未设置") + '\n' +
    '[comfy] 状态: ' + (A4P.comfyui.lastState && A4P.comfyui.lastState.ok ? "在线 " + (A4P.comfyui.lastState.version || "") : "未连接（生成会真实失败并给出原因）") + '\n' +
    '[core] jobs store: localStorage\n' +
    '[core] 模式: 真实模式（无演示数据）</pre></div>',
    "</div></div>"
  ].join("");

  function updateChips(body) {
    A4P.comfyui.ping().then(function (st) {
      const chip = body.querySelector("#comfyChip");
      const conn = body.querySelector("#connChip");
      if (chip) {
        if (st.ok) { chip.textContent = "在线 · " + (st.version || "ComfyUI") + " · " + (st.vram ? (st.vram / 1073741824).toFixed(0) + "GB" : "?"); chip.className = "state-chip good"; }
        else { chip.textContent = "离线 · " + st.error; chip.className = "state-chip bad"; }
      }
      if (conn) { conn.textContent = st.ok ? "真实模式 · 执行端在线" : "真实模式（执行端离线）"; conn.className = st.ok ? "state-chip good" : "state-chip warning"; }
    });
  }

  A4P.pages.settings = function (head, body) {
    body.innerHTML = HTML;
    const $ = A4P.utils.$;
    $("#devReload", body).addEventListener("click", function () { location.reload(); });
    $("#devReset", body).addEventListener("click", function () {
      A4P.jobs.clear();
      try { window.localStorage.removeItem("aiforps.state.v1"); } catch (e) { /* noop */ }
      A4P.app.toast("已清除本地任务与结果");
      location.reload();
    });
    $("#comfySaveBtn", body).addEventListener("click", function () {
      const v = $("#comfyUrl", body).value.trim().replace(/\/+$/, "");
      if (!/^https?:\/\//.test(v)) { A4P.app.toast("地址需以 http(s):// 开头", "warn"); return; }
      A4P.settings.set("connection", "comfyuiUrl", v);
      A4P.comfyui.setEndpoint(v);
      updateChips(body);
      A4P.app.toast("已保存执行端地址：" + v, "ok");
    });
    $("#comfyTestBtn", body).addEventListener("click", function () { updateChips(body); A4P.app.toast("正在检测 ComfyUI…"); });
    body.querySelectorAll("[data-toggle]").forEach(function (c) {
      c.addEventListener("change", function () {
        A4P.app.toast("Provider " + c.dataset.toggle + " -> " + (c.checked ? "已启用" : "已停用"));
      });
    });
    body.querySelectorAll("[data-test]").forEach(function (b) {
      b.addEventListener("click", function () {
        const chip = b.parentElement.querySelector(".state-chip");
        chip.textContent = "测试中…";
        const prom = b.dataset.test === "comfyui" ? A4P.comfyui.ping() : Promise.resolve({ ok: false, error: "未配置密钥" });
        prom.then(function (st) {
          chip.textContent = st.ok ? "已连接" : "未连接";
          chip.className = "state-chip " + (st.ok ? "good" : "bad");
          A4P.app.toast(b.dataset.test + (st.ok ? "：在线" : "：" + st.error));
        });
      });
    });
    updateChips(body);
  };
})();