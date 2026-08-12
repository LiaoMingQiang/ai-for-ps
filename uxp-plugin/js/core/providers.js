/* providers: UXP 侧 Provider 元数据 — 能力唯一来源 = Helper adapter.getCapabilities() (规则十四)
 * UXP 不再维护 capability 硬编码矩阵; 启动/切页时 syncFromHelper() 拉取并缓存。
 * 离线/未同步时 capability 为 null, UI 明确显示「能力未获取」, 不假填充。 */
(function () {
  const REF_ROLES = [
    { id: "subject", label: "主体 Subject" }, { id: "structure", label: "结构 Structure" },
    { id: "composition", label: "构图 Composition" }, { id: "scene", label: "场景 Scene" },
    { id: "style", label: "风格 Style" }, { id: "material", label: "材质 Material" },
    { id: "color", label: "颜色 Color" }, { id: "character", label: "人物 Character" },
    { id: "logo", label: "Logo / Text" }, { id: "mask", label: "Mask / Control" }
  ];

  /* UI 元数据 (能力字段不再硬编码, 由 Helper 填充) */
  const PROVIDERS = [
    { id: "comfyui", name: "本地 ComfyUI", location: "local", locationLabel: "本机 GPU · 不上传云端", supportedRoles: ["subject", "structure", "composition", "scene", "style", "material", "color", "logo", "mask"], models: [] },
    { id: "openai", name: "OpenAI Compatible", location: "cloud", locationLabel: "发送到 OpenAI Compatible Provider", supportedRoles: ["subject", "style", "material", "color", "scene"], models: [] },
    { id: "gemini", name: "Gemini Image", location: "cloud", locationLabel: "发送到 Gemini", supportedRoles: ["subject", "style", "scene", "color"], models: [] },
    { id: "volcengine", name: "火山方舟", location: "cloud", locationLabel: "发送到火山方舟", supportedRoles: ["subject", "style", "scene"], models: [] },
    { id: "bailian", name: "阿里百炼", location: "cloud", locationLabel: "发送到阿里百炼", supportedRoles: ["subject", "style", "scene", "color"], models: [] },
    { id: "runninghub", name: "RunningHub", location: "cloud", locationLabel: "发送到 RunningHub", supportedRoles: ["subject", "structure", "style", "material", "mask"], models: [] },
    { id: "modelscope", name: "ModelScope", location: "cloud", locationLabel: "发送到 ModelScope", supportedRoles: [], models: [] }
  ];

  const capsCache = {};   /* uiProviderId -> Helper ProviderCapabilities | null */

  /* UI provider id -> Helper provider id */
  function helperIdOf(uiId) {
    const MAP = { comfyui: "local-comfy", openai: "openai-compatible", gemini: "gemini", volcengine: "volcengine", bailian: "bailian", runninghub: "runninghub", modelscope: "modelscope" };
    return MAP[uiId] || uiId;
  }

  function find(id) { return PROVIDERS.find(function (p) { return p.id === id; }); }

  /* 从 Helper 拉取全部 provider capabilities (唯一来源) */
  function syncFromHelper() {
    if (!A4P.helper || !A4P.helper.providers) return Promise.resolve(0);
    return A4P.helper.providers.list().then(function (r) {
      const list = (r && Array.isArray(r.providers) ? r.providers : []);
      const tasks = list.map(function (hp) {
        const uiId = Object.keys({ comfyui: "local-comfy", openai: "openai-compatible", gemini: "gemini", volcengine: "volcengine", bailian: "bailian", runninghub: "runninghub", modelscope: "modelscope" }).find(function (k) { return ({ comfyui: "local-comfy", openai: "openai-compatible", gemini: "gemini", volcengine: "volcengine", bailian: "bailian", runninghub: "runninghub", modelscope: "modelscope" })[k] === hp.id; });
        if (!uiId) return Promise.resolve();
        capsCache[uiId] = null; /* 默认 unknown, 拉取失败不假填充 */
        return A4P.helper.providers.capabilities(hp.id).then(function (cr) {
          if (cr && cr.capabilities) capsCache[uiId] = cr.capabilities;
        }).catch(function () { /* keep null */ });
      });
      return Promise.all(tasks).then(function () { return list.length; });
    }).catch(function () { return 0; });
  }

  /* capability 查询: null = 未获取 (UI 显示未知, 不假) */
  function capabilitiesOf(uiId) { return capsCache[uiId] !== undefined ? capsCache[uiId] : null; }

  /* preflight: 基于 Helper capability 真实数据 (规则十四) */
  function preflight(providerId, inputSpec, refs) {
    const p = find(providerId);
    if (!p) return { ok: false, warnings: ["未知 Provider"], errors: ["PROVIDER_UNKNOWN"] };
    const caps = capabilitiesOf(providerId);
    const warnings = [], errors = [], blocked = [];
    if (!caps) {
      warnings.push("Provider 能力尚未获取（Helper 离线或未同步），预检将仅基于基本信息");
    } else {
      if (inputSpec.role === "img2img" && !caps.imageInput) errors.push("当前输入链路需要图生图，该 Provider 不支持");
      if (inputSpec.mask && !caps.maskInput) errors.push("当前选区/Mask 输入需要 Mask 能力，该 Provider 不支持");
      if (caps.referenceRoles && Array.isArray(caps.referenceRoles)) {
        (refs || []).forEach(function (r) {
          if (r.role && caps.referenceRoles.indexOf(r.role) < 0) {
            if (r.requireExact) { errors.push(r.label + " 角色不受支持，请更换 Provider 或移除参考图"); blocked.push(r); }
            else warnings.push(r.label + " 角色不被支持，将降级为普通参考（不能保证角色语义）");
          }
        });
      }
    }
    return { ok: errors.length === 0, provider: p, caps: caps, warnings: warnings, errors: errors, blocked: blocked };
  }

  /* 能力条: 只展示 Helper 真实能力; 未同步时显示「能力未获取」 */
  function renderCapabilityStrip(p) {
    const caps = p ? capabilitiesOf(p.id) : null;
    if (!caps) {
      return '<span class="capability no">能力未获取（需要 Helper 在线）</span>';
    }
    const items = [
      { k: "imageInput", label: "图像输入" },
      { k: "maskInput", label: "Mask" },
      { k: "workflows", label: "工作流" },
      { k: "streamingProgress", label: "实时进度" },
      { k: "cancel", label: "取消" }
    ];
    const roles = (caps.referenceRoles || []).length;
    return items.map(function (it) {
      const ok = !!caps[it.k];
      return '<span class="capability ' + (ok ? "ok" : "no") + '">' + (ok ? "✓ " : "✗ ") + it.label + "</span>";
    }).join("") +
      '<span class="capability ' + (roles > 1 ? "ok" : "no") + '">' + (roles > 1 ? "✓ " : "✗ ") + "参考图角色 ×" + roles + "</span>";
  }

  A4P.providers = { PROVIDERS: PROVIDERS, REF_ROLES: REF_ROLES, find: find, helperIdOf: helperIdOf, syncFromHelper: syncFromHelper, capabilitiesOf: capabilitiesOf, preflight: preflight, renderCapabilityStrip: renderCapabilityStrip };
})();
