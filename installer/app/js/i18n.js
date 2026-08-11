/* i18n - zh-CN primary (PRD NFR: strings centralized, EN reserved) */
(function () {
  const zh = {
    // nav
    nav_generate: "生成", nav_edit: "AI 编辑", nav_workflows: "工作流", nav_tasks: "任务",
    nav_history: "历史", nav_assets: "资产库", nav_settings: "设置",
    brand_tagline: "Design AI Operating Layer",
    // topbar
    project_ctx_hint: "点击查看 PSD 项目上下文",
    ctx_no_doc: "无打开的文档",
    // pages
    p_gen_title: "生成工作台", p_gen_sub: "从 Photoshop 上下文读取输入，调用模型或工作流，并非破坏性写回。",
    p_edit_title: "AI 编辑工具", p_edit_sub: "所有功能均可由内置工作流或用户自定义工作流替换。",
    p_wf_title: "工作流中心", p_wf_sub: "导入 ComfyUI API JSON，封装成设计师可直接运行的工具。",
    p_tasks_title: "任务与计算中心", p_tasks_sub: "跨 Provider、ComfyUI 实例和本地 GPU 的统一队列、恢复和成本管理。",
    p_hist_title: "项目历史与生成血缘", p_hist_sub: "任务、输入、Prompt、工作流版本和 Photoshop 写回形成可追踪链路。",
    p_assets_title: "资产与项目资源", p_assets_sub: "输入、输出、模型、LoRA、Prompt、预设和工作流统一索引。",
    p_settings_title: "设置", p_settings_sub: "Helper、Provider、计算、写回、安全、更新和扩展。",
    // buttons
    new_draft: "新建草稿", save_preset: "保存预设", add_ref: "＋ 添加参考图",
    refresh_input: "刷新输入", preview_input: "预览原图", clear_input: "清除",
    preflight: "重新预检", prompt_history: "历史", prompt_template: "模板",
    reverse_prompt: "反推", optimize_prompt: "优化", reset_params: "恢复默认",
    generate: "开始生成", generate_run: "正在提交…", manage_quick: "管理快捷功能",
    write_selected: "写入所选结果", contact_sheet: "Contact Sheet", create_artboard: "创建画板",
    full_preview: "大图", cancel_task: "取消任务", task_detail: "任务详情",
    // states
    st_snapshot_frozen: "已冻结 Photoshop 快照",
    st_preflight_ok: "预检通过",
    st_default_non_destructive: "默认非破坏性",
    st_ecom_mode: "电商模式",
    st_prompt_saved: "已保存",
    st_expected_tasks: "预计 {n} 个子任务",
    // job states
    js_DRAFT: "草稿", js_VALIDATING: "校验中", js_SNAPSHOTTING: "冻结输入", js_UPLOADING: "上传输入",
    js_QUEUED: "排队", js_RUNNING: "运行中", js_DOWNLOADING: "下载结果", js_VERIFYING: "校验结果",
    js_READY_FOR_WRITEBACK: "待写回", js_WRITING_BACK: "写回中", js_SUCCEEDED: "已完成",
    js_FAILED: "失败", js_CANCELLED: "已取消", js_RECOVERING: "恢复中", js_WRITEBACK_FAILED: "写回失败",
    // toast + errors
    toast_saved_preset: "已保存参数预设",
    toast_wb_safe: "写回安全检查通过",
    err_helper_offline: "Helper 不可达，已进入演示模式",
    err_ps_doc_closed: "来源文档已关闭，结果保留为待写回",
    // settings nav
    set_connections: "连接与账户", set_compute: "计算 / GPU", set_projects: "项目上下文",
    set_writeback: "Photoshop 写回", set_prompts: "Prompt / 预设", set_storage: "存储与缓存",
    set_security: "隐私与安全", set_diagnostics: "日志与诊断", set_updates: "更新 / 回滚",
    set_shortcuts: "快捷键", set_team: "团队", set_sdk: "Plugin SDK", set_about: "关于",
    // agent
    agent_title: "Photoshop AI Agent", agent_placeholder: "描述你想在 Photoshop 里完成的任务…",
    agent_approve: "批准并执行", agent_send: "发送",
    agent_plan_ready: "已解析为受控步骤", agent_need_confirm: "高风险动作需确认",
    // misc
    ok: "确定", cancel: "取消", close: "关闭", save: "保存", run: "运行", copy: "复制",
    search_placeholder: "搜索…",
    processing_location_local: "本机 GPU · 不上传云端",
    wf_env_locked: "环境已锁定", wf_ready: "可运行", wf_dep_missing: "有缺失依赖",
    ver: "版本", diag_id: "诊断 ID",
    about_copy: "Photoshop 内置 AI 模型与 ComfyUI 工作流聚合平台。",
    about_exclude: "无限画布与完整 ComfyUI 节点编辑器不属于产品范围。"
  };
  const en = {}; /* reserved for future */
  const dict = { "zh-CN": zh, "zh": zh, "en": en, "en-US": en };
  function t(key, vars) {
    const lang = (navigator.language || "zh-CN").toLowerCase().replace("_", "-");
    let map = dict[lang] || zh;
    let s = map[key] !== undefined ? map[key] : zh[key];
    if (s === undefined) return key;
    if (!vars) return s;
    return s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? vars[k] : m));
  }
  globalThis.A4P = globalThis.A4P || {};
  A4P.t = t;
})();