/* providers/gemini: Gemini Provider Adapter (PHASE 12)
 * 端点: https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
 * 图片输入: inline_data (base64); 输出: candidates[].content.parts[].inlineData */
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
  roleWeights: false, workflows: false, streamingProgress: false, cancel: true, costTracking: true, maxParallelJobs: 2
};

interface PendingJob {
  status: "queued" | "running" | "completed" | "failed";
  progress: number;
  results: ResultAsset[];
  error?: { code: string; message: string };
}

export class GeminiAdapter implements ProviderAdapter {
  private pending = new Map<string, PendingJob>();
  private base = "https://generativelanguage.googleapis.com/v1beta";

  constructor(public id: string, private apiKey: string | null, baseUrl?: string | null) {
    if (baseUrl) this.base = baseUrl.replace(/\/$/, "");
  }

  getCapabilities(): Promise<ProviderCapabilities> { return Promise.resolve(CAPS); }

  async listModels(): Promise<ModelInfo[]> {
    /* Gemini 模型列表需要 API Key; 常用图像模型为内置表 */
    return [
      { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash", type: "image-model" },
      { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", type: "image-model" },
      { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", type: "image-model" }
    ];
  }

  async validate(request: GenerationRequest): Promise<ValidationResult> {
    const errors: ValidationResult["errors"] = [];
    if (!this.apiKey) errors.push({ code: EC.NOT_CONFIGURED, message: "未配置 API Key" });
    if (!request.inputs.prompt) errors.push({ code: "WORKFLOW_INVALID", message: "缺少 prompt" });
    return { ok: errors.length === 0, errors };
  }

  async submit(request: GenerationRequest): Promise<RemoteJob> {
    const remoteJobId = "gem-" + crypto.randomUUID();
    const job: PendingJob = { status: "queued", progress: 0, results: [] };
    this.pending.set(remoteJobId, job);
    this.runGeneration(request, remoteJobId, job).catch((e) => {
      job.status = "failed";
      job.error = { code: (e as ProviderError).code || "PROVIDER_FAILED", message: (e as Error).message };
    });
    return { remoteJobId, status: "queued", progress: 0 };
  }

  private async runGeneration(request: GenerationRequest, id: string, job: PendingJob): Promise<void> {
    if (!this.apiKey) throw new ProviderError(EC.NOT_CONFIGURED, "未配置 API Key");
    job.status = "running";
    job.progress = 10;
    const model = request.modelId || "gemini-2.0-flash";
    const contents: Array<Record<string, unknown>> = [];
    const parts: Array<Record<string, unknown>> = [];
    if (request.inputs.imageAssetIds?.length) {
      /* 图片输入由 JobEngine 以本地路径提供时不可用; 此处由 UXP 直接传 base64 数据 via inputs */
      const b64 = request.inputs.imageAssetIds[0];
      if (/^data:/.test(b64) || /^[A-Za-z0-9+/=]+$/.test(b64)) {
        parts.push({ inline_data: { mime_type: "image/png", data: b64.replace(/^data:[^,]+;base64,/, "") } });
      }
    }
    parts.push({ text: request.inputs.prompt || "" });
    contents.push({ role: "user", parts });

    const res = await fetch(`${this.base}/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey },
      body: JSON.stringify({
        contents,
        generationConfig: {
          temperature: 1,
          responseModalities: ["TEXT", "IMAGE"]
        }
      })
    });
    if (res.status === 401 || res.status === 403) {
      job.status = "failed";
      job.error = { code: EC.AUTH_FAILED, message: "API Key 无效 (HTTP " + res.status + ")" };
      return;
    }
    if (res.status === 429) {
      job.status = "failed";
      job.error = { code: EC.RATE_LIMIT, message: "请求频率超限 (HTTP 429)" };
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
    interface GemPart { inlineData?: { data?: string; mimeType?: string }; text?: string }
    const j = (await res.json()) as { candidates?: Array<{ content?: { parts?: GemPart[] } }> };
    const partsOut: GemPart[] = j.candidates?.[0]?.content?.parts || [];
    const images = partsOut.filter((p) => p.inlineData && p.inlineData.data);
    if (!images.length) {
      job.status = "failed";
      job.error = { code: "PROVIDER_EMPTY_RESPONSE", message: "Gemini 未返回图像 (可能返回了文本: " + ((partsOut.find((p) => p.text)?.text) || "").slice(0, 100) + ")" };
      return;
    }
    images.forEach((img, i) => {
      const data = img.inlineData ? img.inlineData.data : null;
      if (!data) return;
      const bytes = Uint8Array.from(Buffer.from(data, "base64"));
      const ext = img.inlineData?.mimeType === "image/jpeg" ? ".jpg" : ".png";
      job.results.push({ filename: "gemini-" + id.slice(-6) + "-" + (i + 1) + ext, bytes });
    });
    job.status = "completed";
    job.progress = 100;
  }

  async getStatus(remoteJobId: string): Promise<RemoteJobState> {
    const job = this.pending.get(remoteJobId);
    if (!job) return { remoteJobId, status: "unknown", error: { code: EC.JOB_LOST, message: "Helper 重启后同步任务状态丢失" } };
    const base: RemoteJobState = { remoteJobId, status: job.status, progress: job.progress };
    if (job.error) base.error = job.error;
    if (job.status === "completed") base.outputs = job.results.map((r, i) => ({ filename: r.filename, type: "output" }));
    return base;
  }

  async cancel(remoteJobId: string): Promise<CancelResult> {
    return { ok: false, remoteJobId, message: "Gemini 生成请求已发出, 无法取消 (可忽略结果)" };
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
