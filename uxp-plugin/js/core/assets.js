/* assets: unified index (PRD 11.3) - inputs/outputs/models/LoRA/prompts/presets/workflows */
(function () {
  const ASSET_KINDS = {
    input: { label: "输入", icon: "◫" }, output: { label: "输出", icon: "◈" },
    model: { label: "模型", icon: "M" }, lora: { label: "LoRA", icon: "L" },
    prompt: { label: "Prompt", icon: "T" }, preset: { label: "预设", icon: "P" },
    workflow: { label: "工作流", icon: "W" }
  };

  const seed = [
    { id: "a1", kind: "output", name: "Result 01", meta: "输出 · 2048² · 8.1 MB", project: "Amazon Listing", favorite: true },
    { id: "a2", kind: "input", name: "产品正面", meta: "Photoshop Snapshot · 16 bit", project: "Subject", hash: "2df…" },
    { id: "a3", kind: "lora", name: "product_detail_v3", meta: "LoRA · 384 MB · Hash matched", project: "ComfyUI", ok: true },
    { id: "a4", kind: "workflow", name: "产品洗图 Pro", meta: "Workflow · v3.2.1", project: "Lockfile", ok: true },
    { id: "a5", kind: "prompt", name: "Amazon Product Prompt", meta: "Prompt Template · v7", project: "4 variables", favorite: true },
    { id: "a6", kind: "preset", name: "高材质预设", meta: "Preset · Denoise 0.28", project: "Product Clean", ok: true },
    { id: "a7", kind: "model", name: "flux1-dev-fp8", meta: "Checkpoint · 11.9 GB", project: "ComfyUI", ok: true },
    { id: "a8", kind: "model", name: "ae.safetensors", meta: "VAE · 335 MB", project: "ComfyUI", ok: true }
  ];

  function list(filter) {
    let out = seed.slice();
    if (filter && filter.kind) out = out.filter(function (a) { return a.kind === filter.kind; });
    else if (filter && filter.project) out = out.filter(function (a) { return a.project.indexOf(filter.project) >= 0; });
    if (filter && filter.q) {
      const q = filter.q.toLowerCase();
      out = out.filter(function (a) { return (a.name + " " + a.meta).toLowerCase().indexOf(q) >= 0; });
    }
    return out;
  }

  A4P.assets = { ASSET_KINDS: ASSET_KINDS, list: list };
})();