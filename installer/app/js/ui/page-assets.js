/* ui/page-assets: 素材库 —— 真实文件（浏览器版本地上传，会话内可用） */
(function () {
  A4P.pages.assets = function (head, body) {
    body.innerHTML =
      '<div class="quickbar"><span class="crumb">工作台 / 素材库</span></div>' +
      '<div class="asset-toolbar card"><div class="search"><input placeholder="搜索素材… （名称 / 标签 / 用途）"></div>' +
      '<div class="segment"><button class="active">全部</button><button>引用图</button><button>背景</button><button>材质</button><button>遮罩</button></div>' +
      '<div class="button-row"><button class="small" id="assetUploadBtn">上传</button><button class="small" id="assetExportBtn">导出素材包</button></div>' +
      '<input type="file" id="assetFile" accept="image/png,image/jpeg,image/webp" multiple hidden></div>' +
      '<div class="asset-grid" id="assetGrid"><div class="empty" style="padding:48px 0;grid-column:1/-1"><strong>素材库为空</strong><span>点击「上传」添加真实图片文件（当前会话内使用）</span></div></div>' +
      '<div class="hint" style="margin-top:10px">浏览器版素材保存在当前会话；UXP 版将接入 Photoshop 项目文件夹。</div>';

    const grid = body.querySelector("#assetGrid");
    /* PHASE 17: 资产真相源 = Helper Asset Store (SQLite), 不再用 settings 本地列表 */
    const list = [];

    function render() {
      if (!list.length) {
        grid.innerHTML = '<div class="empty" style="padding:48px 0;grid-column:1/-1"><strong>素材库为空</strong><span>点击「上传」把图片存入 Helper Asset Store（跨会话保留）</span></div>';
        return;
      }
      grid.innerHTML = list.map(function (a, i) {
        return '<div class="asset-card card"><div class="asset-thumb" style="background-image:url(' + a.preview + ')"><span class="fav">★</span></div>' +
          '<div class="asset-meta"><strong>' + A4P.utils.escapeHtml(a.name) + "</strong><span>" + a.type + " · " + (a.size / 1048576).toFixed(2) + " MB · Helper</span>" +
          '<div class="button-row"><button class="small" data-use="' + i + '">引用</button><button class="small danger" data-del="' + i + '">移除</button></div></div></div>';
      }).join("");
    }

    /* 从 Helper 加载资产 (reference/input 类) */
    function loadFromHelper() {
      if (!A4P.helper || !A4P.helper.assets || !A4P.helper.assets.list) {
        grid.innerHTML = '<div class="empty" style="padding:48px 0;grid-column:1/-1"><strong>Helper 不可用</strong><span>无法加载资产库（Helper 离线）</span></div>';
        return;
      }
      grid.innerHTML = '<div class="empty" style="padding:48px 0;grid-column:1/-1"><strong>正在从 Helper 加载资产…</strong></div>';
      A4P.helper.assets.list({ limit: 200 }).then(function (r) {
        const rows = (r && Array.isArray(r.assets) ? r.assets : []).filter(function (a) { return a.kind === "reference" || a.kind === "input"; });
        rows.forEach(function (a, i) {
          list.push({ id: a.id, name: a.original_name || (a.id.slice(0, 8) + ".png"), size: a.size || 0, type: "参考图", source: "helper", preview: "" });
          A4P.helper.assets.get(a.id).then(function (buf) {
            try { list[i].preview = URL.createObjectURL(new Blob([buf], { type: "image/png" })); } catch (e) { /* noop */ }
            render();
          }).catch(function () { /* missing */ });
        });
        render();
      }).catch(function () {
        grid.innerHTML = '<div class="empty" style="padding:48px 0;grid-column:1/-1"><strong>加载失败</strong><span>Helper 返回错误</span></div>';
      });
    }
    loadFromHelper();

    body.querySelector("#assetUploadBtn").addEventListener("click", function () {
      /* PHASE 3: UXP 正式路径 = localFileSystem.getFileForOpening; 浏览器预览 fallback file input */
      if (A4P.utils.isUxpRuntime && A4P.utils.isUxpRuntime()) {
        A4P.utils.pickImageFiles(true).then(function (files) {
          if (!files || !files.length) return;
          let done = 0, failed = 0;
          files.forEach(function (f) {
            A4P.helper.assets.upload(f.blob, { kind: "reference" }).then(function (r) {
              done++;
              if (r && r.asset && r.asset.id) {
                list.push({ id: r.asset.id, name: f.name, size: f.size, type: "参考图", preview: URL.createObjectURL(f.blob), source: "helper" });
                render();
              } else { failed++; }
              if (done + failed === files.length) A4P.app.toast("已上传 " + done + " 个素材到 Helper" + (failed ? "，" + failed + " 失败" : ""), done ? "ok" : "warn");
            });
          });
        });
        return;
      }
      body.querySelector("#assetFile").click();
    });
    body.querySelector("#assetExportBtn").addEventListener("click", function () { A4P.app.toast("导出素材包需 UXP 端支持，浏览器版暂不可用", "warn"); });
    body.querySelector("#assetFile").addEventListener("change", function () {
      /* 浏览器预览 fallback: 上传到 Helper (正式 UXP 走 getFileForOpening) */
      Array.prototype.forEach.call(body.querySelector("#assetFile").files || [], function (f) {
        A4P.helper.assets.upload(f, { kind: "reference" }).then(function (r) {
          if (r && r.asset && r.asset.id) {
            list.push({ id: r.asset.id, name: f.name, size: f.size, type: "参考图", preview: URL.createObjectURL(f), source: "helper" });
            render();
          }
        });
      });
      A4P.app.toast("已上传 " + body.querySelector("#assetFile").files.length + " 个素材到 Helper", "ok");
    });
    grid.addEventListener("click", function (e) {
      const use = e.target.dataset.use, del = e.target.dataset.del;
      if (del !== undefined) { list.splice(Number(del), 1); render(); return; }
      if (use !== undefined) {
        const a = list[Number(use)];
        const gen = A4P.pageGen;
        if (gen) {
          gen.ui.refs.push({ name: a.name, src: "素材库", role: "material", weight: 0.5 });
          A4P.app.toast("已引用素材「" + a.name + "」到参考图系统", "ok");
        } else {
          A4P.app.toast("已引用素材「" + a.name + "」", "ok");
        }
      }
    });
    render();
  };
})();