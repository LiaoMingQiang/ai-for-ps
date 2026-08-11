/* workflows: package, API-JSON field scanner (WF-001..005), version diff, lockfile */
(function () {
  const FIELD_KIND_HINTS = [
    { node: "LoadImage", field: "image", kind: "IMAGE" }, { node: "LoadImage", field: "upload", kind: "IMAGE" },
    { node: "ImageUpload", field: "image", kind: "IMAGE" },
    { node: "CLIPTextEncode", field: "text", kind: "STRING", semantic: "prompt" },
    { node: "KSampler", field: "denoise", kind: "FLOAT", min: 0, max: 1, step: 0.01 },
    { node: "KSampler", field: "cfg", kind: "FLOAT" },
    { node: "KSampler", field: "steps", kind: "INT" },
    { node: "KSampler", field: "seed", kind: "INT", semantic: "seed" },
    { node: "KSampler", field: "sampler_name", kind: "ENUM" },
    { node: "KSampler", field: "scheduler", kind: "ENUM" },
    { node: "EmptyLatentImage", field: "width", kind: "INT", semantic: "size" },
    { node: "EmptyLatentImage", field: "height", kind: "INT", semantic: "size" },
    { node: "EmptyLatentImage", field: "batch_size", kind: "INT" },
    { node: "CheckpointLoaderSimple", field: "ckpt_name", kind: "MODEL" },
    { node: "CheckpointLoader", field: "ckpt_name", kind: "MODEL" },
    { node: "UNETLoader", field: "unet_name", kind: "MODEL" },
    { node: "VAELoader", field: "vae_name", kind: "MODEL" },
    { node: "LoraLoader", field: "lora_name", kind: "LORA" },
    { node: "LoraLoader", field: "strength_model", kind: "FLOAT", min: 0, max: 2, step: 0.01 },
    { node: "LoraLoader", field: "strength_clip", kind: "FLOAT", min: 0, max: 2, step: 0.01 },
    { node: "LoadImageMask", field: "mask", kind: "MASK" },
    { node: "InvertMask", field: "mask", kind: "MASK" },
    { node: "SaveImage", field: "filename_prefix", kind: "STRING", semantic: "output", advanced: true }
  ];

  function scanField(nodeType, inputName, value) {
    const name = nodeType.split(":")[1] || nodeType;
    const hit = FIELD_KIND_HINTS.find(function (h) { return h.node === name && h.field === inputName; });
    if (hit) return Object.assign({}, hit);
    /* type inference fallback */
    if (typeof value === "number") {
      return { kind: Number.isInteger(value) ? "INT" : "FLOAT", advanced: true };
    }
    if (typeof value === "string") return { kind: "STRING", advanced: true };
    if (typeof value === "boolean") return { kind: "BOOL", advanced: true };
    return null;
  }

  /* scan ComfyUI API JSON -> [{nodeId, nodeType, input, kind, semantic, advanced, hasDefault}] */
  function scanApiJson(apiJson) {
    const out = [];
    if (!apiJson || typeof apiJson !== "object") return out;
    Object.keys(apiJson).forEach(function (nodeId) {
      const n = apiJson[nodeId];
      const inputs = n.inputs || {};
      Object.keys(inputs).forEach(function (k) {
        const v = inputs[k];
        if (v !== null && typeof v === "object" && Array.isArray ? Array.isArray(v) : (v && v[0] !== undefined)) return; /* link, not literal */
        const f = scanField(n.class_type || "", k, v);
        if (f) out.push({ nodeId: nodeId, nodeType: n.class_type, input: k, kind: f.kind, semantic: f.semantic || null, advanced: !!f.advanced, min: f.min, max: f.max, step: f.step, value: v });
      });
    });
    return out;
  }

  function summarizeFields(fields) {
    const exposed = fields.filter(function (f) { return !f.advanced; });
    const kinds = exposed.map(function (f) { return f.kind; });
    const uniq = kinds.filter(function (v, i) { return kinds.indexOf(v) === i; });
    return { total: fields.length, exposed: exposed.length, kinds: uniq };
  }

  /* ---------- workflow packages ---------- */
  const builtins = [
    {
      id: "wf_product_clean", name: "产品洗图 Pro", version: "3.2.1", category: "产品",
      provider: "ComfyUI", desc: "结构保持 · IC-Light · ColorMatch",
      fields: ["图片输入", "Prompt", "Denoise", "分辨率", "结构保护", "写回"],
      deps: { nodes: 39, models: 5, missing: 1, outdated: 1 }, locked: true,
      lockfile: { comfyui: "0.3.45", custom_nodes_hash: "8f9c…a22d", checkpoint: "flux1-dev-fp8@sha256:81a…", lora: "product_detail_v3@sha256:2df…" }
    },
    {
      id: "wf_scene_fusion", name: "场景融合 V4", version: "4.0.0", category: "合成",
      provider: "ComfyUI", desc: "主体 + 场景 + 光影匹配", favorite: true,
      fields: ["主图", "场景图", "融合强度", "Prompt"], deps: { nodes: 31, models: 4, missing: 0, outdated: 0 }, locked: false
    },
    {
      id: "wf_upscale_4x", name: "4X UltraSharp", version: "2.1.3", category: "高清",
      provider: "ComfyUI", desc: "高清放大与细节补偿",
      fields: ["图片输入", "倍率", "细节增强"], deps: { nodes: 12, models: 3, missing: 0, outdated: 1 }, locked: false
    }
  ];

  function all() { return builtins.concat(A4P.store._customWorkflows || []); }
  function find(id) { return all().find(function (w) { return w.id === id; }); }
  function addCustom(w) {
    A4P.store._customWorkflows = A4P.store._customWorkflows || [];
    w.id = "wf_custom_" + A4P.utils.uid("wf").slice(-6);
    A4P.store._customWorkflows.unshift(w);
    return w;
  }

  /* ---------- version diff (WF: Diff / Rollback) ---------- */
  function diffVersions(oldVer, newVer) {
    const lines = { add: [], remove: [], change: [] };
    const compareValues = function (a, b) {
      if (JSON.stringify(a) === JSON.stringify(b)) return;
      if (a === undefined) lines.add.push("新增字段");
      else if (b === undefined) lines.remove.push("删除字段");
      else lines.change.push("值变化");
    };
    compareValues(oldVer.lockfile, newVer.lockfile);
    if (oldVer.nodes !== newVer.nodes) lines.change.push("节点 " + (oldVer.nodes || 0) + " → " + (newVer.nodes || 0));
    if (oldVer.defaults && newVer.defaults) {
      Object.keys(newVer.defaults).forEach(function (k) {
        if (oldVer.defaults[k] !== newVer.defaults[k]) lines.change.push("参数默认值 " + k + ": " + oldVer.defaults[k] + " → " + newVer.defaults[k]);
      });
    }
    return lines;
  }

  A4P.workflows = { FIELD_KIND_HINTS: FIELD_KIND_HINTS, scanApiJson: scanApiJson, summarizeFields: summarizeFields, all: all, find: find, addCustom: addCustom, diffVersions: diffVersions };
})();