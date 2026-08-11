/* providers/runninghub: RunningHub Provider Adapter (PHASE 12)
 * API: POST /api/v1/task/create -> { code, data: { task_id } }
 *      GET  /api/v1/task/status?task_id= -> { data: { task_status: 0/1/2/3, task_result: [{ url }] } }
 * 文档化端点 (RunningHub 官方 API v1); 凭据: token (Authorization: token) */
import crypto from "node:crypto";
import type {
  GenerationRequest, RemoteJob, RemoteJobState, ValidationResult, CancelResult,
  ResultAsset, ModelInfo, ProviderAdapter
} from "./sdk.js";
import { ProviderError, PROVIDER_ERROR_CODES as EC } from "./sdk.js";
import type { ProviderCapabilities } from "./registry.js";

const CAPS: ProviderCapabilities = {
  imageInput: true, maskInput: true,
  referenceRoles: ["subject", "structure", "style"],
  roleWeights: false, workflows: true, streamingProgress: true, cancel: false, costTracking: true, maxParallelJobs: 2
};

interface PendingJob {
  status: "queued" | "running" | "completed" | "failed";
  progress: number;
  results: ResultAsset[];
  error?: { code: string; message: string };
}

export class RunningHubAdapter implements ProviderAdapter {
  private pending = new Map<string, PendingJob>();
  private base = "https://api.runninghub.ai";

  constructor(public id: string, private apiKey: string | null, baseUrl?: string | null) {
    if (baseUrl) this.base = baseUrl.replace(/\/$/, "");
  }

  getCapabilities(): Promise<ProviderCapabilities> { return Promise.resolve(CAPS); }

  async listModels(): Promise<ModelInfo[]> {
    /* RunningHub 模型按 workflow 运行; 常用官方模板表 */
    return [
      { id: "rh-product-cleanup", name: "商品图精修", type: "workflow-template" },
      { id: "rh-bg-removal", name: "抠图", type: "workflow-template" },
      { id: "rh-upscale", name: "高清放大", type: "workflow-template" }
    ];
  }

  async validate(request: GenerationRequest): Promise<ValidationResult> {
    const errors: ValidationResult["errors"] = [];
    if (!this.apiKey) errors.push({ code: EC.NOT_CONFIGURED, message: "未配置 API Token" });
    if (!request.workflowId && !request.modelId) errors.push({ code: "WORKFLOW_INVALID", message: "缺少 workflowId 或 modelId" });
    return { ok: errors.length === 0, errors };
  }

  async submit(request: GenerationRequest): Promise<RemoteJob> {
    if (!this.apiKey) throw new ProviderError(EC.NOT_CONFIGURED, "未配置 API Token");
    const res = await fetch(this.base + "/api/v1/task/create", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "token " + this.apiKey },
      body: JSON.stringify({
        workflowId: request.workflowId || request.modelId,
        params: {
          prompt: request.inputs.prompt || "",
          negativePrompt: request.inputs.negativePrompt || "",
          ...request.parameters
        }
      })
    });
    if (res.status === 401 || res.status === 403) throw new ProviderError(EC.AUTH_FAILED, "Token 无效 (HTTP " + res.status + ")");
    if (!res.ok) {
      let detail = "";
      try { detail = JSON.stringify(await res.json()).slice(0, 200); } catch (e) { /* noop */ }
      throw new ProviderError("PROVIDER_REQUEST_FAILED", "任务创建失败 (HTTP " + res.status + "): " + detail);
    }
    const j = (await res.json()) as { code?: number; data?: { task_id?: string } };
    const taskId = j.data?.task_id;
    if (!taskId) throw new ProviderError("PROVIDER_REQUEST_FAILED", "RunningHub 未返回 task_id");
    const remoteJobId = String(taskId);
    const job: PendingJob = { status: "queued", progress: 0, results: [] };
    this.pending.set(remoteJobId, job);
    this.poll(remoteJobId, job).catch((e) => {
      job.status = "failed";
      const cause = (e as { cause?: Error }).cause;
      job.error = { code: (e as ProviderError).code || "PROVIDER_FAILED", message: (e as Error).message + " cause=" + (cause ? cause.message : "none") + " | statusUrl=" + this.base + "/api/v1/task/status" };
    });
    return { remoteJobId, status: "queued", progress: 0 };
  }

  private async poll(taskId: string, job: PendingJob): Promise<void> {
    while (job.status === "queued" || job.status === "running") {
      await new Promise((r) => setTimeout(r, 3000));
      const res = await fetch(this.base + `/api/v1/task/status?task_id=${encodeURIComponent(taskId)}`, {
        headers: { authorization: "token " + this.apiKey || "" }
      });
      if (!res.ok) continue;
      const j = (await res.json()) as { data?: { task_status?: number; task_result?: Array<{ url?: string }> } };
      const st = j.data?.task_status; /* 0=pending 1=queueing 2=processing 3=success 4=fail */
      if (st === 3) {
        const urls = (j.data?.task_result || []).map((r) => r.url).filter(Boolean) as string[];
        for (let i = 0; i < urls.length; i++) {
          const r2 = await fetch(urls[i]);
          if (!r2.ok) continue;
          job.results.push({ filename: "runninghub-" + taskId.slice(-6) + "-" + (i + 1) + ".png", bytes: new Uint8Array(await r2.arrayBuffer()) });
        }
        job.status = "completed";
        job.progress = 100;
        return;
      }
      if (st === 4) {
        job.status = "failed";
        job.error = { code: "PROVIDER_REQUEST_FAILED", message: "RunningHub 任务失败 (task_status=4)" };
        return;
      }
      job.status = "running";
      job.progress = Math.min(90, job.progress + 5);
    }
  }

  async getStatus(remoteJobId: string): Promise<RemoteJobState> {
    const job = this.pending.get(remoteJobId);
    if (!job) return { remoteJobId, status: "unknown", error: { code: EC.JOB_LOST, message: "Helper 重启后任务状态丢失 (RunningHub 需重新查询)" } };
    const base: RemoteJobState = { remoteJobId, status: job.status, progress: job.progress };
    if (job.error) base.error = job.error;
    if (job.status === "completed") base.outputs = job.results.map((r, i) => ({ filename: r.filename, type: "output" }));
    return base;
  }

  async cancel(remoteJobId: string): Promise<CancelResult> {
    return { ok: false, remoteJobId, message: "RunningHub 无任务取消 API" };
  }

  async recover(remoteJobId: string): Promise<RemoteJobState> {
    /* 重启后无法恢复轮询上下文: 诚实上报 (不假成功) */
    return this.getStatus(remoteJobId);
  }

  async downloadResults(remoteJobId: string): Promise<ResultAsset[]> {
    const job = this.pending.get(remoteJobId);
    if (!job || job.status !== "completed") throw new ProviderError(EC.JOB_LOST, "任务无结果: " + remoteJobId);
    return job.results;
  }
}
