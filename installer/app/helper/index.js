/* helper/index: CEP-style 主机桥接 → UXP (mock):
 * 真实 UXP 中由 require('uxp')/require('photoshop') 提供；此处提供
 * 浏览器可运行的替身实现，保证 index.html 可脱离 PS 直接预览。 */
(function () {
  A4P = (typeof A4P !== "undefined") ? A4P : {};

  /* i18n 优先 (js/i18n.js)；此处只补演示页缺失的 key */
  if (!A4P.t) {
    A4P.t = function (k) {
      const FALLBACK = {
        st_connected: "已连接", st_need_config: "需要配置", st_disabled_auto: "未启用 · 自动",
        st_mock: "演示数据", st_written_back: "已写回 Photoshop（智能对象）", st_job_completed: "任务完成",
        result: "结果"
      };
      return FALLBACK[k] || k;
    };
  }

  /* ---- require shim：按模块返回 (photoshop → app:null 使 ps 层走演示路径) ---- */
  const UXP_MOCKS = { photoshop: {}, uxp: {} };

  if (typeof require !== "function") {
    globalThis.require = function (name) {
      if (name === "photoshop") {
        return { app: null, core: { executeAsModal: function () { return Promise.resolve("mock"); } } };
      }
      if (name === "uxp") {
        return {
          storage: {
            fs: {},
            localFileSystem: {
              getPluginFolder: function () { return { nativePath: "./" }; },
              getTemporaryFolder: function () { return { nativePath: "./" }; },
              getDataFolder: function () { return { nativePath: "./" }; }
            }
          },
          clipboard: { readText: function () { return ""; } },
          os: { platform: "win32" }
        };
      }
      return UXP_MOCKS[name] || UXP_MOCKS;
    };
  }

  /* ---- bridge: 与 ps/bridge 同构的消息接口（mock 端直接派发本地事件） ---- */
  A4P.bridge = A4P.bridge || {};
  if (!A4P.bridge._wired) {
    A4P.bridge._wired = true;
    A4P.bridge = {
      send: function (msg) {
        if (!msg || !msg.type) return;
        if (msg.type === "doc-snapshot") {
          A4P.store.emit("snapshot", { label: "产品主体", dims: "2048 × 2048", takenAt: new Date() });
        }
        if (msg.type === "write-doc") A4P.store.emit("write:doc", msg);
        if (msg.type === "open-file") { /* mock: noop */ }
      },
      on: function (type, fn) {
        A4P.store.on(type, fn);
        return function () { A4P.store.off(type, fn); };
      },
      request: function (type) {
        if (type === "snippet.config") return Promise.resolve({ cfg: { url: "http://localhost:8188" } });
        return Promise.resolve({ ok: true });
      },
      openPs: function () { return Promise.resolve(true); },
      createEntry: function (data) { return { file: { name: (data && data.name || "out") + ".png", nativePath: "/mock/out.png" }, ok: true }; },
      savePhoto: function () { return Promise.resolve(true); },
      message: function (s) { if (A4P.uiRouter) A4P.uiRouter.toast(String(s)); }
    };
  }

  /* ---- entry / CEP 兼容 ----
   * 真实 UXP 封装时由 Panel entry 调用：A4P.apply({documentName, settings, project}) */
  A4P.apply = function (data) {
    if (!data) return;
    if (data.documentName) A4P.state.doc = data.documentName;
    if (data.settings) { Object.keys(data.settings).forEach(function (k) { A4P.settings.set(k, data.settings[k]); }); }
    A4P.store.emit("outer-entry", data);
  };
  A4P.configure = function (cfg) {
    if (cfg && cfg.provider === "comfyui") A4P.store.emit("comfy:config", cfg.url);
    return Promise.resolve(true);
  };
  A4P.getPluginInfo = function () { return { id: "ai-for-ps", name: "AI-for-PS", version: "0.5.0" }; };
})();