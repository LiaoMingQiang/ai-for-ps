/* providers: registry, capability matrix, reference-role mapping, preflight (GEN-001/002/004, REF roles) */
(function () {
  const REF_ROLES = [
    { id: "subject", label: "主体 Subject" }, { id: "structure", label: "结构 Structure" },
    { id: "composition", label: "构图 Composition" }, { id: "scene", label: "场景 Scene" },
    { id: "style", label: "风格 Style" }, { id: "material", label: "材质 Material" },
    { id: "color", label: "颜色 Color" }, { id: "character", label: "人物 Character" },
    { id: "logo", label: "Logo / Text" }, { id: "mask", label: "Mask / Control" }
  ];

  const PROVIDERS = [
    {
      id: "comfyui", name: "本地 ComfyUI", location: "local", locationLabel: "本机 GPU · 不上传云端",
      capabilities: { img2img: true, multiImage: true, mask: true, seed: true, transparent: true, maxSize: 4096, bitDepth16: true, t2i: true },
      supportedRoles: ["subject", "structure", "composition", "scene", "style", "material", "color", "logo", "mask"],
      models: [] /* 实时从服务端 CheckpointLoaderSimple 检测 */
    },
    {
      id: "openai", name: "OpenAI Compatible", location: "cloud", locationLabel: "发送到 OpenAI Compatible Provider",
      capabilities: { img2img: true, multiImage: false, mask: false, seed: true, transparent: false, maxSize: 4096, bitDepth16: false, t2i: true },
      supportedRoles: ["subject", "style", "material", "color", "scene"],
      models: ["gpt-image-1", "dall-e-3", "qwen-image-edit"]
    },
    {
      id: "gemini", name: "Gemini Image", location: "cloud", locationLabel: "发送到 Gemini",
      capabilities: { img2img: true, multiImage: false, mask: false, seed: false, transparent: false, maxSize: 4096, bitDepth16: false, t2i: true },
      supportedRoles: ["subject", "style", "scene", "color"],
      models: ["Gemini 2.0 Flash Image"]
    },
    {
      id: "volcengine", name: "火山方舟", location: "cloud", locationLabel: "发送到火山方舟",
      capabilities: { img2img: true, multiImage: false, mask: false, seed: false, transparent: false, maxSize: 2048, bitDepth16: false, t2i: true },
      supportedRoles: ["subject", "style", "scene"],
      models: ["Ark Image / Seedream"]
    },
    {
      id: "bailian", name: "阿里百炼", location: "cloud", locationLabel: "发送到阿里百炼",
      capabilities: { img2img: true, multiImage: false, mask: false, seed: true, transparent: false, maxSize: 2048, bitDepth16: false, t2i: true },
      supportedRoles: ["subject", "style", "scene", "color"],
      models: ["Qwen Image Edit", "wanx2.1-t2i"]
    },
    {
      id: "runninghub", name: "RunningHub", location: "cloud", locationLabel: "发送到 RunningHub",
      capabilities: { img2img: true, multiImage: true, mask: true, seed: true, transparent: false, maxSize: 4096, bitDepth16: false, t2i: true },
      supportedRoles: ["subject", "structure", "style", "material", "mask"],
      models: ["ComfyUI Workflow Runner"]
    },
    {
      id: "modelscope", name: "ModelScope", location: "cloud", locationLabel: "发送到 ModelScope",
      capabilities: { img2img: false, multiImage: false, mask: false, seed: false, transparent: false, maxSize: 2048, bitDepth16: false, t2i: true },
      supportedRoles: [],
      models: ["Flux Schnell", "Kolors"]
    }
  ];

  function find(id) { return PROVIDERS.find(function (p) { return p.id === id; }); }

  /* preflight: input + references vs provider capabilities (GEN-002 / REF: must not silently drop) */
  function preflight(providerId, inputSpec, refs) {
    const p = find(providerId);
    if (!p) return { ok: false, warnings: ["未知 Provider"], errors: ["PROVIDER_UNKNOWN"] };
    const warnings = [], errors = [], blocked = [];

    if (inputSpec.role === "img2img" && !p.capabilities.img2img) errors.push("当前输入链路需要图生图，该 Provider 不支持");
    if (inputSpec.multiLayer && !p.capabilities.multiImage) warnings.push("该 Provider 不支持多图层输入，将合并为单图（降级映射）");
    if (inputSpec.mask && !p.capabilities.mask) errors.push("当前选区/Mask 输入需要 Mask 能力，该 Provider 不支持");
    if (inputSpec.transparentBg && !p.capabilities.transparent) warnings.push("该 Provider 不支持透明背景，输出将以白色/纯色填充");
    if (inputSpec.bitDepth !== 8 && !p.capabilities.bitDepth16) warnings.push("16-bit 输入将转换为 8-bit");

    (refs || []).forEach(function (r) {
      if (r.role && p.supportedRoles.indexOf(r.role) < 0) {
        if (r.requireExact) { errors.push(r.label + " 角色不受支持，请更换 Provider 或移除参考图"); blocked.push(r); }
        else warnings.push(r.label + " 角色不被支持，将降级为普通参考（不能保证角色语义）");
      }
    });

    return { ok: errors.length === 0, provider: p, warnings: warnings, errors: errors, blocked: blocked };
  }

  function renderCapabilityStrip(p) {
    const items = [
      { k: "img2img", label: "图生图" }, { k: "multiImage", label: "多图参考" },
      { k: "mask", label: "Mask" }, { k: "seed", label: "Seed" },
      { k: "transparent", label: "透明背景" }, { k: "t2i", label: "文生图" }
    ];
    return items.map(function (it) {
      const ok = p.capabilities[it.k];
      return '<span class="capability ' + (ok ? "ok" : "no") + '">' + (ok ? "✓ " : "✗ ") + it.label + "</span>";
    }).join("") +
      '<span class="capability ' + (p.capabilities.maxSize >= 4096 ? "ok" : "warn") + '">△ 最大 ' + p.capabilities.maxSize + " px</span>" +
      '<span class="capability ' + (p.capabilities.bitDepth16 ? "ok" : "no") + '">' + (p.capabilities.bitDepth16 ? "✓ 16-bit 输入转换" : "✗ 16-bit") + "</span>";
  }

  A4P.providers = { PROVIDERS: PROVIDERS, REF_ROLES: REF_ROLES, find: find, preflight: preflight, renderCapabilityStrip: renderCapabilityStrip };
})();