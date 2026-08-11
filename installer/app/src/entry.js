/* src/entry.js — 真实 UXP 插件入口 (Manifest v5 + entrypoints.setup)
 *
 * 官方依据 (Adobe UXP docs, manifest-v5 / entrypoints.setup):
 *   - import { entrypoints } from "uxp"; entrypoints.setup({ plugin, panels, commands })
 *   - panel 生命周期: create(rootNode) / show(rootNode, data) / hide(rootNode, data) / destroy(rootNode)
 *   - command 生命周期: run() / cancel()
 *   - 面板/命令 ID 必须与 manifest.json entrypoints[].id 完全一致
 *   - 浏览器预览环境 (无 require("uxp")): 注册为空操作, 由 main.js 走 DOMContentLoaded
 *
 * 启动链 (规则三):
 *   bootstrap() -> loadSettings() -> initPhotoshopBridge() -> connectHelper()
 *   -> pairHelper() -> restoreSession() -> recoverJobs() -> loadProjectContext() -> renderApp()
 */
(function () {
  "use strict";

  function hasUxp() {
    try {
      if (typeof require === "undefined") return false;
      var uxp = require("uxp");
      /* 必须存在 entrypoints.setup 才算真 UXP 运行时（浏览器预览 shim 无此 API） */
      return !!(uxp && uxp.entrypoints && typeof uxp.entrypoints.setup === "function");
    } catch (e) {
      return false;
    }
  }

  /* ---- command: 打开主面板 (manifest id: openMainPanel) ---- */
  function openMainPanel() {
    try {
      var uxp = require("uxp");
      var self = null;
      if (uxp.pluginManager && uxp.pluginManager.plugins) {
        var list = Array.from(uxp.pluginManager.plugins);
        for (var i = 0; i < list.length; i++) {
          var p = list[i];
          if (p && p.manifest && p.manifest.id === "com.aiforps.plugin.ai") { self = p; break; }
        }
      }
      if (self && self.showPanel) self.showPanel("aiForPsPanel");
    } catch (e) {
      try { console.error("openMainPanel failed", e); } catch (e2) { /* noop */ }
    }
  }

  if (!hasUxp()) {
    /* 浏览器预览: 不注册, 保持 A4P 兼容 */
    A4P.uxpEntry = { mode: "browser", openMainPanel: openMainPanel };
    return;
  }

  var entrypoints = require("uxp").entrypoints;

  entrypoints.setup({
    plugin: {
      create: function () {
        /* 插件加载: 不做重活, 面板 create 时统一 bootstrap */
      },
      destroy: function () {
        try { if (A4P.main && A4P.main.destroy) A4P.main.destroy(); } catch (e) { /* noop */ }
      }
    },
    panels: {
      aiForPsPanel: {
        create: function (rootNode) {
          try {
            if (A4P.main && A4P.main.bootstrap) A4P.main.bootstrap(rootNode);
          } catch (e) {
            try { console.error("aiForPsPanel create failed", e); } catch (e2) { /* noop */ }
          }
        },
        show: function (rootNode, data) {
          try {
            if (A4P.main && A4P.main.onShow) A4P.main.onShow(rootNode, data);
          } catch (e) { /* noop */ }
        },
        hide: function (rootNode, data) {
          try {
            if (A4P.main && A4P.main.onHide) A4P.main.onHide(rootNode, data);
          } catch (e) { /* noop */ }
        },
        destroy: function (rootNode) {
          try { if (A4P.main && A4P.main.destroy) A4P.main.destroy(); } catch (e) { /* noop */ }
        }
      }
    },
    commands: {
      openMainPanel: {
        run: openMainPanel,
        cancel: function () { /* noop */ }
      }
    }
  });

  A4P.uxpEntry = { mode: "uxp", openMainPanel: openMainPanel };
})();
