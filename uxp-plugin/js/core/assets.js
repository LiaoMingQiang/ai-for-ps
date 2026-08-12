/* assets: unified index (PRD 11.3) - inputs/outputs/models/LoRA/prompts/presets/workflows
 * PHASE 17: 静态 Seed Assets 已删除; 数据唯一来源 = Helper Asset Store (SQLite)。 */
(function () {
  const ASSET_KINDS = {
    input: { label: "输入", icon: "◫" }, output: { label: "输出", icon: "◈" },
    model: { label: "模型", icon: "M" }, lora: { label: "LoRA", icon: "L" },
    prompt: { label: "Prompt", icon: "T" }, preset: { label: "预设", icon: "P" },
    workflow: { label: "工作流", icon: "W" }
  };

  /* 真实资产列表: Helper GET /v1/assets (kind/role/favorite/source 过滤) */
  function list(filter) {
    if (!A4P.helper || !A4P.helper.assets || !A4P.helper.assets.list) {
      return Promise.resolve([]);
    }
    const q = {};
    if (filter && filter.kind) q.kind = filter.kind;
    if (filter && filter.projectId) q.projectId = filter.projectId;
    if (filter && filter.q) q.q = filter.q;
    return A4P.helper.assets.list(q).then(function (r) {
      const rows = (r && Array.isArray(r.assets) ? r.assets : []);
      let out = rows;
      if (filter && filter.q) {
        const qq = filter.q.toLowerCase();
        out = out.filter(function (a) { return String(a.original_name || a.id).toLowerCase().indexOf(qq) >= 0; });
      }
      return out;
    }).catch(function () { return []; });
  }

  A4P.assets = { ASSET_KINDS: ASSET_KINDS, list: list };
})();
