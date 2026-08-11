/* agent: 受控 Tool Registry + Plan 生成 + 审计 (规则三十三/三十四)
 * - Agent 只能调用注册工具 (不允许任意 batchPlay/文件/shell)
 * - 每次执行先 Plan: 显示 Provider / 预计耗时 / 是否云上传 / 预计成本 / PSD 修改方式
 * - 用户批准后才执行; 高风险步骤单独确认
 * - 审计: agentRequest / agentPlan / approvedPlan / toolsExecuted / toolResults / writebackResult */
import crypto from "node:crypto";
import type { Store } from "../db.js";
import type { JobEngine } from "../job-engine.js";

export type ToolRisk = "low" | "medium" | "high";

export interface ToolDef {
  id: string;
  label: string;
  description: string;
  risk: ToolRisk;
  requiresPhotoshop: boolean;   /* true: 由 UXP 执行 (Helper 返回委托指令) */
  cloudUpload: boolean;         /* 是否上传到云端 Provider */
  argsSchema: Record<string, string>; /* argName -> 类型描述 */
  estTimeSec: number;
}

/* 受控工具注册表 (规则三十三: 不得扩展为任意命令) */
export const TOOL_REGISTRY: ToolDef[] = [
  { id: "captureActiveLayer", label: "捕获当前图层", description: "导出当前图层为 PNG 快照", risk: "low", requiresPhotoshop: true, cloudUpload: true, argsSchema: { label: "string" }, estTimeSec: 3 },
  { id: "captureSelection", label: "捕获当前选区", description: "导出选区像素为 PNG 快照", risk: "low", requiresPhotoshop: true, cloudUpload: true, argsSchema: { label: "string" }, estTimeSec: 3 },
  { id: "runWorkflow", label: "运行工作流", description: "在 Provider 上执行 ComfyUI 工作流", risk: "medium", requiresPhotoshop: false, cloudUpload: true, argsSchema: { workflowId: "string", inputs: "object", parameters: "object" }, estTimeSec: 60 },
  { id: "runProvider", label: "调用模型生成", description: "直接调用 Provider 模型生成图像", risk: "medium", requiresPhotoshop: false, cloudUpload: true, argsSchema: { providerId: "string", modelId: "string", prompt: "string", parameters: "object" }, estTimeSec: 45 },
  { id: "resizeImage", label: "调整图像尺寸", description: "缩放结果图像 (Helper 端 sharp)", risk: "low", requiresPhotoshop: false, cloudUpload: false, argsSchema: { assetId: "string", width: "number", height: "number" }, estTimeSec: 2 },
  { id: "createMask", label: "创建蒙版", description: "生成/转换蒙版资产", risk: "medium", requiresPhotoshop: true, cloudUpload: false, argsSchema: { layerId: "number" }, estTimeSec: 5 },
  { id: "createLayerGroup", label: "创建图层组", description: "在文档中创建结果分组", risk: "medium", requiresPhotoshop: true, cloudUpload: false, argsSchema: { name: "string" }, estTimeSec: 2 },
  { id: "placeSmartObject", label: "写回智能对象", description: "将结果放置为智能对象图层", risk: "high", requiresPhotoshop: true, cloudUpload: false, argsSchema: { assetId: "string", layerName: "string" }, estTimeSec: 5 }
];

export interface AgentStep {
  tool: string;
  label: string;
  args: Record<string, unknown>;
  risk: ToolRisk;
  provider?: string;
  estTimeSec: number;
  cloudUpload: boolean;
  estCost: string | null;      /* 云: 估算费用文本; 本地: null (不虚构货币) */
  psdModification: string;     /* PSD 修改方式描述; 无修改: "无" */
}

export interface AgentPlan {
  planId: string;
  intent: string;
  steps: AgentStep[];
  totalEstTimeSec: number;
  requiresPhotoshop: boolean;
  hasCloudUpload: boolean;
}

/* Plan 生成: 根据意图模板生成受控步骤 (Agent 不能自由发明工具) */
const INTENT_PLANS: Array<{ re: RegExp; steps: Array<Omit<AgentStep, "label" | "estCost"> & { label: string }> }> = [
  {
    re: /白底|产品图|去背景|cleanup|clean/i,
    steps: [
      { tool: "captureActiveLayer", label: "捕获当前产品图层", args: { label: "产品主体" }, risk: "low", estTimeSec: 3, cloudUpload: true, psdModification: "无（只读快照）" },
      { tool: "runWorkflow", label: "运行产品洗图工作流", args: { workflowId: "wf_product_clean", inputs: {}, parameters: { denoise: 0.25 } }, risk: "medium", provider: "本地 ComfyUI", estTimeSec: 60, cloudUpload: false, psdModification: "无（仅生成）" },
      { tool: "placeSmartObject", label: "结果写回为智能对象", args: { assetId: "", layerName: "AI-Product-Clean" }, risk: "high", estTimeSec: 5, cloudUpload: false, psdModification: "新增智能对象图层（非破坏）" }
    ]
  },
  {
    re: /抠图|蒙版|mask|cutout/i,
    steps: [
      { tool: "captureActiveLayer", label: "捕获当前图层", args: {}, risk: "low", estTimeSec: 3, cloudUpload: true, psdModification: "无（只读快照）" },
      { tool: "createMask", label: "创建主体蒙版", args: { layerId: 0 }, risk: "medium", estTimeSec: 5, cloudUpload: false, psdModification: "添加图层蒙版" },
      { tool: "placeSmartObject", label: "蒙版结果写回", args: { layerName: "AI-Mask" }, risk: "high", estTimeSec: 5, cloudUpload: false, psdModification: "新增蒙版图层" }
    ]
  },
  {
    re: /放大|高清|upscale|4x/i,
    steps: [
      { tool: "captureActiveLayer", label: "捕获当前图层", args: {}, risk: "low", estTimeSec: 3, cloudUpload: true, psdModification: "无（只读快照）" },
      { tool: "runWorkflow", label: "运行 4X 高清放大", args: { workflowId: "wf_upscale_4x", inputs: {}, parameters: {} }, risk: "medium", provider: "本地 ComfyUI", estTimeSec: 90, cloudUpload: false, psdModification: "无（仅生成）" },
      { tool: "resizeImage", label: "校验/调整结果尺寸", args: { assetId: "", width: 4096, height: 4096 }, risk: "low", estTimeSec: 2, cloudUpload: false, psdModification: "无" },
      { tool: "placeSmartObject", label: "高清结果写回", args: { layerName: "AI-Upscale-4x" }, risk: "high", estTimeSec: 5, cloudUpload: false, psdModification: "新增智能对象图层（非破坏）" }
    ]
  }
];

const DEFAULT_PLAN_STEPS: Array<Omit<AgentStep, "label" | "estCost"> & { label: string }> = [
  { tool: "captureActiveLayer", label: "捕获当前图层", args: {}, risk: "low", estTimeSec: 3, cloudUpload: true, psdModification: "无（只读快照）" },
  { tool: "runProvider", label: "调用模型生成", args: { providerId: "local-comfy", modelId: "", prompt: "" }, risk: "medium", provider: "本地 ComfyUI", estTimeSec: 45, cloudUpload: false, psdModification: "无（仅生成）" },
  { tool: "placeSmartObject", label: "结果写回为智能对象", args: { layerName: "AI-Result" }, risk: "high", estTimeSec: 5, cloudUpload: false, psdModification: "新增智能对象图层（非破坏）" }
];

export function planRequest(request: { intent: string; providerId?: string; modelId?: string; workflowId?: string; prompt?: string }): AgentPlan {
  const intent = (request.intent || "").trim();
  let steps: Array<Omit<AgentStep, "label" | "estCost"> & { label: string }> = DEFAULT_PLAN_STEPS;
  for (const p of INTENT_PLANS) {
    if (p.re.test(intent)) { steps = p.steps; break; }
  }
  /* 注入请求参数 */
  const planSteps: AgentStep[] = steps.map((s) => {
    const args = { ...s.args };
    if (s.tool === "runProvider") {
      if (request.providerId) args.providerId = request.providerId;
      if (request.modelId) args.modelId = request.modelId;
      if (request.prompt) args.prompt = request.prompt;
    }
    if (s.tool === "runWorkflow" && request.workflowId) args.workflowId = request.workflowId;
    const def = TOOL_REGISTRY.find((t) => t.id === s.tool);
    const provider = s.provider || (def && !def.requiresPhotoshop ? (request.providerId || "本地") : "Photoshop");
    /* 成本估算 (规则三十三: 云上传显示估算; 本地不虚构货币) */
    let estCost: string | null = null;
    if (s.cloudUpload) estCost = provider && provider !== "本地" && provider !== "本地 ComfyUI" ? "约 ¥0.01–0.05/次（按 Provider 计费）" : "本地 GPU（无货币费用）";
    return { tool: s.tool, label: s.label, args, risk: s.risk, provider, estTimeSec: s.estTimeSec, cloudUpload: s.cloudUpload, estCost, psdModification: s.psdModification };
  });
  return {
    planId: crypto.randomUUID(),
    intent,
    steps: planSteps,
    totalEstTimeSec: planSteps.reduce((a, s) => a + s.estTimeSec, 0),
    requiresPhotoshop: planSteps.some((s) => TOOL_REGISTRY.find((t) => t.id === s.tool)?.requiresPhotoshop),
    hasCloudUpload: planSteps.some((s) => s.cloudUpload)
  };
}

/* 审计 (规则三十四) */
export class AgentAuditor {
  constructor(private store: Store) {}

  create(phase: "requested" | "planned", agentRequest: unknown, plan: AgentPlan | null): string {
    const id = crypto.randomUUID();
    const now = Date.now();
    this.store.raw.prepare(
      "INSERT INTO agent_audit (id, status, agent_request_json, agent_plan_json, approved_plan_json, tools_executed_json, tool_results_json, writeback_result_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
    ).run(id, phase, JSON.stringify(agentRequest), plan ? JSON.stringify(plan) : "{}", "{}", "[]", "[]", null, now, now);
    return id;
  }

  update(id: string, patch: { status?: string; approvedPlan?: AgentPlan; toolExecuted?: { tool: string; args: unknown; result: unknown }; writebackResult?: unknown }) {
    const row = this.store.raw.prepare("SELECT * FROM agent_audit WHERE id=?").get(id) as Record<string, unknown> | undefined;
    if (!row) return;
    const now = Date.now();
    if (patch.status) this.store.raw.prepare("UPDATE agent_audit SET status=?, updated_at=? WHERE id=?").run(patch.status, now, id);
    if (patch.approvedPlan) {
      this.store.raw.prepare("UPDATE agent_audit SET approved_plan_json=?, status=?, updated_at=? WHERE id=?").run(JSON.stringify(patch.approvedPlan), patch.status || "approved", now, id);
    }
    if (patch.toolExecuted) {
      const tools = JSON.parse(String(row.tools_executed_json || "[]")) as unknown[];
      const results = JSON.parse(String(row.tool_results_json || "[]")) as unknown[];
      tools.push({ tool: patch.toolExecuted.tool, args: patch.toolExecuted.args });
      results.push({ tool: patch.toolExecuted.tool, result: patch.toolExecuted.result });
      this.store.raw.prepare("UPDATE agent_audit SET tools_executed_json=?, tool_results_json=?, updated_at=? WHERE id=?").run(JSON.stringify(tools), JSON.stringify(results), now, id);
    }
    if (patch.writebackResult !== undefined) {
      this.store.raw.prepare("UPDATE agent_audit SET writeback_result_json=?, updated_at=? WHERE id=?").run(JSON.stringify(patch.writebackResult), now, id);
    }
  }
}

/* 工具执行 (受控): 返回 { status, result | delegateToUxp } */
export async function executeTool(tool: ToolDef, args: Record<string, unknown>, ctx: { store: Store; engine: JobEngine }): Promise<{ status: string; result?: unknown; delegateToUxp?: { tool: string; args: Record<string, unknown> } }> {
  if (tool.requiresPhotoshop) {
    /* PS 工具: Helper 无法直接执行, 委托 UXP (审计仍完整记录) */
    return { status: "delegated", delegateToUxp: { tool: tool.id, args } };
  }
  if (tool.id === "runWorkflow") {
    const job = await ctx.engine.create({
      providerId: String(args.providerId || "local-comfy"),
      workflowId: args.workflowId ? String(args.workflowId) : undefined,
      inputs: (args.inputs as Record<string, unknown>) || { prompt: args.prompt ? String(args.prompt) : undefined },
      parameters: (args.parameters as Record<string, unknown>) || {}
    });
    return { status: "started", result: { jobId: job.id, status: job.status } };
  }
  if (tool.id === "runProvider") {
    const job = await ctx.engine.create({
      providerId: String(args.providerId || "local-comfy"),
      modelId: args.modelId ? String(args.modelId) : undefined,
      inputs: { prompt: args.prompt ? String(args.prompt) : undefined },
      parameters: (args.parameters as Record<string, unknown>) || {}
    });
    return { status: "started", result: { jobId: job.id, status: job.status } };
  }
  if (tool.id === "resizeImage") {
    /* Helper 端 sharp 缩放 (结果资产) */
    const { default: sharp } = await import("sharp");
    const assetId = String(args.assetId || "");
    const a = ctx.store.raw.prepare("SELECT storage_path FROM assets WHERE id=?").get(assetId) as { storage_path: string } | undefined;
    if (!a) return { status: "error", result: { error: "ASSET_NOT_FOUND:" + assetId } };
    const w = Number(args.width), h = Number(args.height);
    if (!w || !h) return { status: "error", result: { error: "INVALID_SIZE" } };
    const outPath = a.storage_path.replace(/\.(png|jpg|jpeg|webp)$/i, "-resized.png");
    await sharp(a.storage_path).resize(w, h).png().toFile(outPath);
    return { status: "completed", result: { storagePath: outPath } };
  }
  return { status: "error", result: { error: "UNKNOWN_TOOL:" + tool.id } };
}
