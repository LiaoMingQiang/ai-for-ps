/* providers/openai: OpenAI Compatible Provider Adapter (PHASE 7)
 * 端点: {baseUrl}/models, /images/generations, /images/edits, /chat/completions
 * - 认证失败 401 -> PROVIDER_AUTH_FAILED (规则三十七, 场景 10)
 * - 同步 API: submit 在后台执行, remoteJobId 为本地 id; cancel 明确不支持
 * - 参考图角色: 能力矩阵 subject/style, roleWeights=false (规则二十五: 不支持时明确显示) */
import crypto from "node:crypto";
import type {
  GenerationRequest, RemoteJob, RemoteJobState, ValidationResult, CancelResult,
  ResultAsset, ModelInfo, ProviderAdapter
} from "./sdk.js";
import { ProviderError, PROVIDER_ERROR_CODES as EC } from "./sdk.js";
import type { ProviderCapabilities } from "./registry.js";

const CAPS: ProviderCapabilities = {
  imageInput: true, maskInput: false,
  referenceRoles: ["subject", "style"],
  roleWeights: false, workflows: false, streamingProgress: true, cancel: false, costTracking: true, maxParallelJobs: 2
};

interface PendingJob {
  status: "queued" | "running" | "completed" | "failed";
  progress: number;
  results: ResultAsset[];
  error?: { code: string; message: string };
}

export class OpenAICompatibleAdapter implements ProviderAdapter {
  private pending = new Map<string, PendingJob>();

  constructor(public id: string, public baseUrl: string | null, private apiKey: string | null) {}

  getCapabilities(): Promise<ProviderCapabilities> { return Promise.resolve(CAPS); }

  private get base(): string {
    return (this.baseUrl || "https://api.openai.com/v1").replace(/\/$/, "");
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    if (!this.apiKey) throw new ProviderError(EC.NOT_CONFIGURED, "Provider 未配置 API Key");
    return { "content-type": "application/json", authorization: "Bearer " + this.apiKey, ...(extra || {}) };
  }

  async listModels(): Promise<ModelInfo[]> {
    const res = await fetch(this.base + "/models", { headers: this.headers() });
    if (res.status === 401 || res.status === 403) {
      throw new ProviderError(EC.AUTH_FAILED, "API Key 无效 (HTTP " + res.status + ")", false);
    }
    if (!res.ok) throw new ProviderError(EC.OFFLINE ?? "PROVIDER_OFFLINE", "模型列表失败: " + res.status);
    const j = (await res.json()) as { data?: Array<{ id: string }> };
    return (j.data || []).map((m) => ({ id: m.id, name: m.id, type: "image-model" }));
  }

  async validate(request: GenerationRequest): Promise<ValidationResult> {
    const errors: ValidationResult["errors"] = [];
    if (!this.apiKey) errors.push({ code: EC.NOT_CONFIGURED, message: "未配置 API Key" });
    if (!request.inputs.prompt && !request.workflowId) errors.push({ code: "WORKFLOW_INVALID", message: "缺少 prompt" });
    return { ok: errors.length === 0, errors };
  }

  async submit(request: GenerationRequest): Promise<RemoteJob> {
    if (!this.apiKey) throw new ProviderError(EC.NOT_CONFIGURED, "Provider 未配置 API Key");
    const remoteJobId = "sync-" + crypto.randomUUID();
    const job: PendingJob = { status: "queued", progress: 0, results: [] };
    this.pending.set(remoteJobId, job);
    /* 后台执行 (同步 API) */
    this.runGeneration(request, remoteJobId, job).catch((e) => {
      job.status = "failed";
      job.error = { code: (e as ProviderError).code || "PROVIDER_FAILED", message: (e as Error).message };
    });
    return { remoteJobId, status: "queued", progress: 0 };
  }

  private async runGeneration(request: GenerationRequest, id: string, job: PendingJob): Promise<void> {
    const p = request.parameters || {};
    const inputImage = request.inputs.imageAssetIds && request.inputs.imageAssetIds[0];
    job.status = "running";
    job.progress = 10;

    let res: Response;
    if (inputImage) {
      /* 图生图: images/edits (multipart) */
      const fd = new FormData();
      fd.append("image", new Blob([new Uint8Array(0) as BlobPart]), inputImage);
      fd.append("prompt", request.inputs.prompt || "");
      fd.append("model", request.modelId || "dall-e-2");
      fd.append("n", "1");
      if (p.size) fd.append("size", String(p.size));
      res = await fetch(this.base + "/images/edits", { method: "POST", headers: { authorization: "Bearer " + this.apiKey }, body: fd });
    } else {
      /* 文生图: images/generations */
      const body: Record<string, unknown> = {
        model: request.modelId || "dall-e-3",
        prompt: request.inputs.prompt || "",
        n: 1
      };
      if (p.size) body.size = String(p.size);
      if (p.quality) body.quality = String(p.quality);
      res = await fetch(this.base + "/images/generations", { method: "POST", headers: this.headers(), body: JSON.stringify(body) });
    }

    if (res.status === 401 || res.status === 403) {
      job.status = "failed";
      job.error = { code: EC.AUTH_FAILED, message: "API Key 无效或已过期 (HTTP " + res.status + ")" };
      return;
    }
    if (res.status === 429) {
      job.status = "failed";
      job.error = { code: EC.RATE_LIMIT, message: "请求频率超限 (HTTP 429)，请稍后重试", };
      return;
    }
    if (!res.ok) {
      let detail = "";
      try { detail = JSON.stringify(await res.json()).slice(0, 300); } catch (e) { /* noop */ }
      job.status = "failed";
      job.error = { code: "PROVIDER_REQUEST_FAILED", message: "生成失败 (HTTP " + res.status + "): " + detail };
      return;
    }
    job.progress = 90;
    const j = (await res.json()) as { data?: Array<{ b64_json?: string; url?: string }> };
    const items = j.data || [];
    if (!items.length) {
      job.status = "failed";
      job.error = { code: "PROVIDER_EMPTY_RESPONSE", message: "Provider 未返回图像" };
      return;
    }
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      let bytes: Uint8Array;
      if (it.b64_json) {
        bytes = Uint8Array.from(Buffer.from(it.b64_json, "base64"));
      } else if (it.url) {
        const r2 = await fetch(it.url);
        bytes = new Uint8Array(await r2.arrayBuffer());
      } else {
        continue;
      }
      job.results.push({ filename: "openai-" + id.slice(-6) + "-" + (i + 1) + ".png", bytes });
    }
    job.status = "completed";
    job.progress = 100;
  }

  async getStatus(remoteJobId: string): Promise<RemoteJobState> {
    const job = this.pending.get(remoteJobId);
    if (!job) return { remoteJobId, status: "unknown", error: { code: EC.JOB_LOST, message: "Helper 重启后同步任务状态丢失 (不可恢复, 需重新提交)" } };
    const base: RemoteJobState = { remoteJobId, status: job.status, progress: job.progress };
    if (job.error) base.error = job.error;
    if (job.status === "completed") base.outputs = job.results.map((r, i) => ({ filename: r.filename, type: "output" }));
    return base;
  }

  async cancel(remoteJobId: string): Promise<CancelResult> {
    return { ok: false, remoteJobId, message: "OpenAI Compatible 同步 API 不支持取消" };
  }

  async recover(remoteJobId: string): Promise<RemoteJobState> {
    return this.getStatus(remoteJobId);
  }

  async downloadResults(remoteJobId: string): Promise<ResultAsset[]> {
    const job = this.pending.get(remoteJobId);
    if (!job || job.status !== "completed") throw new ProviderError(EC.JOB_LOST, "任务无结果: " + remoteJobId);
    return job.results;
  }
}
