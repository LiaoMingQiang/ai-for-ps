/* providers/sdk: ProviderAdapter 统一协议 (规则十)
 * UXP 请求只携带 providerId; Helper 决定具体实现。
 * 业务层禁止直接绑定 ComfyUI。 */
import type { ProviderCapabilities } from "./registry.js";

export type RemoteJobStateStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "unknown";

export interface ReferenceImageInput {
  assetId: string;
  role: string;      /* subject | structure | composition | scene | style | material | color | character | logo-text | mask | control */
  weight?: number;
  order?: number;
}

export interface GenerationRequest {
  providerId: string;
  workflowId?: string;
  workflowJson?: Record<string, unknown>;  /* PHASE 10: 已应用 bindings 的真实 workflow JSON (Helper 内部填充) */
  modelId?: string;
  inputs: {
    prompt?: string;
    negativePrompt?: string;
    imageAssetIds?: string[];
    maskAssetId?: string;
    referenceImages?: ReferenceImageInput[];
  };
  parameters: {
    steps?: number;
    cfg?: number;
    seed?: number | string;
    denoise?: number;
    width?: number;
    height?: number;
    [k: string]: unknown;
  };
}

export interface RemoteJob {
  remoteJobId: string;
  status: RemoteJobStateStatus;
  progress?: number;          /* 0-100 */
  message?: string;
  createdAt?: number;
}

export interface RemoteJobState extends RemoteJob {
  outputs?: Array<{ filename: string; subfolder?: string; type?: string; url?: string }>;
  error?: { code: string; message: string };
}

export interface ValidationResult {
  ok: boolean;
  errors: Array<{ code: string; message: string; nodeId?: string }>;
}

export interface CancelResult {
  ok: boolean;
  remoteJobId: string;
  message?: string;
}

export interface ResultAsset {
  filename: string;
  subfolder?: string;
  type?: string;
  url?: string;
  width?: number;
  height?: number;
  bytes?: Uint8Array;
}

export interface ModelInfo {
  id: string;
  name: string;
  type: string;   /* checkpoint | lora | vae | llm | image-model | ... */
}

export interface ProviderAdapter {
  id: string;
  getCapabilities(): Promise<ProviderCapabilities>;
  listModels(): Promise<ModelInfo[]>;
  validate(request: GenerationRequest): Promise<ValidationResult>;
  submit(request: GenerationRequest): Promise<RemoteJob>;
  getStatus(remoteJobId: string): Promise<RemoteJobState>;
  cancel(remoteJobId: string): Promise<CancelResult>;
  recover(remoteJobId: string): Promise<RemoteJobState>;
  downloadResults(remoteJobId: string): Promise<ResultAsset[]>;
}

/* 统一错误码 (规则三十七) */
export const PROVIDER_ERROR_CODES = {
  AUTH_FAILED: "PROVIDER_AUTH_FAILED",
  RATE_LIMIT: "PROVIDER_RATE_LIMIT",
  TIMEOUT: "PROVIDER_TIMEOUT",
  OFFLINE: "PROVIDER_OFFLINE",
  NOT_CONFIGURED: "PROVIDER_NOT_CONFIGURED",
  MODEL_MISSING: "PROVIDER_MODEL_MISSING",
  COMFY_NODE_MISSING: "COMFY_NODE_MISSING",
  COMFY_MODEL_MISSING: "COMFY_MODEL_MISSING",
  COMFY_OOM: "COMFY_OOM",
  COMFY_OFFLINE: "COMFY_OFFLINE",
  WORKFLOW_INVALID: "WORKFLOW_INVALID",
  ASSET_DOWNLOAD_FAILED: "ASSET_DOWNLOAD_FAILED",
  JOB_LOST: "JOB_LOST"
} as const;

export class ProviderError extends Error {
  constructor(public code: string, message: string, public retryable = false, public details?: unknown) {
    super(message);
    this.name = "ProviderError";
  }
}
