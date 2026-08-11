/* providers/registry: Provider 目录与能力矩阵 (规则十/十一)
 * PHASE 3 先建立元数据与配置状态; adapter 实现于 PHASE 5-7, 12 */
import type { Store } from "../db.js";

export interface ProviderCapabilities {
  imageInput: boolean;
  maskInput: boolean;
  referenceRoles: string[];     /* subject | structure | composition | scene | style | material | color | character | logo-text | mask | control */
  roleWeights: boolean;
  workflows: boolean;           /* 是否支持自定义 ComfyUI 式 workflow */
  streamingProgress: boolean;
  cancel: boolean;
  costTracking: boolean;
  maxParallelJobs: number;
}

export interface ProviderMeta {
  id: string;
  type: string;
  name: string;
  builtin: boolean;
  defaultBaseUrl?: string;
  capabilities: ProviderCapabilities;
}

export const PROVIDER_TYPES = ["comfyui", "openai-compatible", "gemini", "volcengine", "bailian", "runninghub", "modelscope"] as const;

const CAPS: Record<string, ProviderCapabilities> = {
  comfyui: { imageInput: true, maskInput: true, referenceRoles: ["subject", "structure", "composition", "scene", "style", "material", "color", "character", "logo-text", "mask", "control"], roleWeights: true, workflows: true, streamingProgress: true, cancel: true, costTracking: false, maxParallelJobs: 4 },
  "openai-compatible": { imageInput: true, maskInput: false, referenceRoles: ["subject", "style"], roleWeights: false, workflows: false, streamingProgress: true, cancel: true, costTracking: true, maxParallelJobs: 2 },
  gemini: { imageInput: true, maskInput: false, referenceRoles: ["subject", "style"], roleWeights: false, workflows: false, streamingProgress: false, cancel: true, costTracking: true, maxParallelJobs: 2 },
  volcengine: { imageInput: true, maskInput: false, referenceRoles: ["subject", "style"], roleWeights: false, workflows: false, streamingProgress: false, cancel: true, costTracking: true, maxParallelJobs: 2 },
  bailian: { imageInput: true, maskInput: false, referenceRoles: ["subject", "style"], roleWeights: false, workflows: false, streamingProgress: false, cancel: true, costTracking: true, maxParallelJobs: 2 },
  runninghub: { imageInput: true, maskInput: true, referenceRoles: ["subject", "structure", "style"], roleWeights: false, workflows: true, streamingProgress: true, cancel: true, costTracking: true, maxParallelJobs: 2 },
  modelscope: { imageInput: true, maskInput: false, referenceRoles: ["subject", "style"], roleWeights: false, workflows: false, streamingProgress: false, cancel: true, costTracking: true, maxParallelJobs: 2 }
};

export const BUILTIN_PROVIDERS: ProviderMeta[] = [
  { id: "local-comfy", type: "comfyui", name: "本地 ComfyUI", builtin: true, defaultBaseUrl: "http://127.0.0.1:8188", capabilities: CAPS.comfyui },
  { id: "openai-compatible", type: "openai-compatible", name: "OpenAI Compatible", builtin: true, capabilities: CAPS["openai-compatible"] },
  { id: "gemini", type: "gemini", name: "Gemini", builtin: true, capabilities: CAPS.gemini },
  { id: "volcengine", type: "volcengine", name: "火山方舟", builtin: true, capabilities: CAPS.volcengine },
  { id: "bailian", type: "bailian", name: "阿里百炼", builtin: true, capabilities: CAPS.bailian },
  { id: "runninghub", type: "runninghub", name: "RunningHub", builtin: true, capabilities: CAPS.runninghub },
  { id: "modelscope", type: "modelscope", name: "ModelScope", builtin: true, capabilities: CAPS.modelscope }
];

/* 首次启动写入内置 provider 元数据 */
export function seedProviders(store: Store) {
  const now = Date.now();
  const ins = store.raw.prepare(
    "INSERT OR IGNORE INTO providers (id, type, name, base_url, enabled, is_default, config_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)"
  );
  for (const p of BUILTIN_PROVIDERS) {
    ins.run(p.id, p.type, p.name, p.defaultBaseUrl || null, p.id === "local-comfy" ? 0 : 0, p.id === "local-comfy" ? 0 : 0, JSON.stringify({}), now, now);
  }
}

export interface ProviderView {
  id: string;
  type: string;
  name: string;
  baseUrl: string | null;
  enabled: boolean;
  isDefault: boolean;
  configured: boolean;   /* 已保存凭据或无需凭据 */
  capabilities: ProviderCapabilities;
}

export function listProviders(store: Store): ProviderView[] {
  const rows = store.raw.prepare("SELECT * FROM providers ORDER BY id").all() as Array<Record<string, unknown>>;
  return rows.map((r) => {
    const type = String(r.type);
    const row = store.raw.prepare("SELECT has_credential FROM provider_credentials_meta WHERE provider_id=?").get(String(r.id)) as { has_credential: number } | undefined;
    /* comfyui 本地无需凭据 (需要 base_url 可达); 云 Provider 需要凭据 */
    const needsCred = type !== "comfyui";
    return {
      id: String(r.id),
      type,
      name: String(r.name),
      baseUrl: r.base_url ? String(r.base_url) : null,
      enabled: Number(r.enabled) === 1,
      isDefault: Number(r.is_default) === 1,
      configured: needsCred ? !!(row && row.has_credential === 1) : !!r.base_url,
      capabilities: CAPS[type] || CAPS["openai-compatible"]
    };
  });
}
