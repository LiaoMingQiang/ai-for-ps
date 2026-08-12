/* providers/comfyui: ComfyUI Provider Adapter (PHASE 6)
 *
 * 官方 API (ComfyUI server):
 *   GET  /system_stats                 -> { system: { comfyui_version, devices: [{ vram_total, ... }] } }
 *   GET  /object_info                  -> { <class_type>: { input: { required: {...} } } }
 *   POST /upload/image (multipart)     -> { name, subfolder, type }
 *   POST /prompt                       -> { prompt_id } | { node_errors: {...}, error: {...} }
 *   GET  /history/{prompt_id}          -> { <id>: { status: { status_str, completed, messages }, outputs } }
 *   GET  /queue                        -> { queue_running: [[number, prompt_id, ...]], queue_pending: [...] }
 *   POST /interrupt                    -> 中断当前 running 任务
 *   GET  /view?filename=&subfolder=&type= -> 图像字节
 *   WS   /ws?clientId=                 -> progress: { type:"progress", data:{ value, max, prompt_id, node } }
 *                                        executed: { type:"executed", data:{ node, prompt_id, output } }
 *                                        exec_error: { type:"exec_error", data:{ prompt_id, exception_message } }
 *
 * 规则十二: progress 按官方结构 data.value / data.max 解析。
 * 规则十三: queued -> 查 /queue 并删除指定 prompt_id; running -> 确认 prompt_id 一致才 /interrupt。
 * 规则十五: recover 先查 /history, 不重新 submit。 */
import WebSocket from "ws";
import type {
  GenerationRequest, RemoteJob, RemoteJobState, ValidationResult, CancelResult,
  ResultAsset, ModelInfo, ProviderAdapter
} from "./sdk.js";
import { ProviderError, PROVIDER_ERROR_CODES as EC } from "./sdk.js";
import type { ProviderCapabilities } from "./registry.js";

const CAPS: ProviderCapabilities = {
  imageInput: true, maskInput: true,
  referenceRoles: ["subject", "structure", "composition", "scene", "style", "material", "color", "character", "logo-text", "mask", "control"],
  roleWeights: true, workflows: true, streamingProgress: true, cancel: true, costTracking: false, maxParallelJobs: 4
};

export interface ComfyNodeSpec {
  class_type: string;
  inputs: Record<string, unknown>;
  _meta?: { title?: string };
}

export function detectFieldType(value: unknown, node: ComfyNodeSpec | null, key: string): string {
  /* 规则十六: 明确的字段类型检测, 不做运算符优先级陷阱 */
  if (key === "seed") return "SEED";
  if (key === "steps" || key === "cfg") return "INT";
  if (key === "denoise" || key === "strength" || key === "weight") return "FLOAT";
  if (key === "width" || key === "height" || key === "size") return "SIZE";
  if (key === "sampler_name") return "SAMPLER";
  if (key === "scheduler") return "SCHEDULER";
  if (key === "ckpt_name" || key === "model_name" || key === "unet_name") return "MODEL";
  if (key === "lora_name") return "LORA";
  if (key === "vae_name") return "VAE";
  if (key === "positive" || key === "negative") return "PROMPT";
  if (key === "text") return "TEXTAREA";
  if (key === "image" || key === "images") return "IMAGE";
  if (key === "mask" || key === "masks") return "MASK";
  if (key === "color" || key === "tone") return "COLOR";
  if (key === "angle" || key === "camera") return "CAMERA";
  if (key === "boolean" || key === "enabled" || key === "keep_alive") return "BOOLEAN";
  if (typeof value === "boolean") return "BOOLEAN";
  if (typeof value === "number") {
    if (Number.isInteger(value)) return "INT";
    return "FLOAT";
  }
  if (typeof value === "string") {
    if (/^(0x[0-9a-f]+|\d{10,})$/.test(value)) return "SEED";
    if (/^-?\d+$/.test(value)) return "INT";
    if (/^-?\d*\.\d+$/.test(value)) return "FLOAT";
    if (/^(euler|ddim|dpmpp_2m|dpmpp_sde|uni_pc|heun|lms|dpm_fast|dpm_adaptive)$/.test(value)) return "SAMPLER";
    if (/^(normal|karras|exponential|sgm_uniform|simple|ddim_uniform)$/.test(value)) return "SCHEDULER";
    return "STRING";
  }
  if (Array.isArray(value)) {
    const first = value[0];
    if (typeof first === "number") return "SIZE";
    return "ADVANCED";
  }
  if (value && typeof value === "object") return "ADVANCED";
  return "STRING";
}

export class ComfyUIAdapter implements ProviderAdapter {
  constructor(public id: string, public baseUrl: string) {}

  getCapabilities(): Promise<ProviderCapabilities> { return Promise.resolve(CAPS); }

  async listModels(): Promise<ModelInfo[]> {
    const info = await this.fetchJson("/object_info");
    const out: ModelInfo[] = [];
    for (const cls of Object.keys(info)) {
      if (!/CheckpointLoader/i.test(cls)) continue;
      const req = info[cls]?.input?.required || {};
      const list = req.ckpt_name && Array.isArray(req.ckpt_name[0]) ? req.ckpt_name[0] : [];
      for (const name of list) out.push({ id: String(name), name: String(name), type: "checkpoint" });
    }
    return out;
  }

  async listCustomNodes(): Promise<string[]> {
    const info = await this.fetchJson("/object_info");
    return Object.keys(info).sort();
  }

  async validate(request: GenerationRequest): Promise<ValidationResult> {
    const errors: ValidationResult["errors"] = [];
    if (!request.inputs.prompt && !request.workflowId) {
      errors.push({ code: "WORKFLOW_INVALID", message: "缺少 prompt 或 workflowId" });
    }
    if (request.inputs.imageAssetIds && request.inputs.imageAssetIds.length > 4) {
      errors.push({ code: "WORKFLOW_INVALID", message: "输入图超过 4 张上限" });
    }
    /* 模型存在性: object_info 检测 (规则二十一/场景 8: 缺模型不得进入执行) */
    try {
      const models = await this.listModels();
      const want = request.modelId;
      if (want && models.length && !models.some((m) => m.id === want)) {
        errors.push({ code: EC.COMFY_MODEL_MISSING, message: "ComfyUI 缺少模型: " + want });
      }
    } catch (e) {
      errors.push({ code: EC.COMFY_OFFLINE, message: "无法连接 ComfyUI: " + String((e as Error).message) });
    }
    return { ok: errors.length === 0, errors };
  }

  /* ---- workflow 构建 (规则十六: 标准字段识别) ---- */
  buildWorkflow(request: GenerationRequest): Record<string, ComfyNodeSpec> {
    const p = request.parameters || {};
    const inputImage = request.inputs.imageAssetIds && request.inputs.imageAssetIds[0];
    const nodes: Record<string, ComfyNodeSpec> = {};
    let n = 1;
    const next = (): string => String(n++);

    const posId = next();
    nodes[posId] = { class_type: "CLIPTextEncode", inputs: { text: request.inputs.prompt || "", clip: ["checkpoint", 1] } };
    const negId = next();
    nodes[negId] = { class_type: "CLIPTextEncode", inputs: { text: request.inputs.negativePrompt || "", clip: ["checkpoint", 1] } };
    const ckptId = next();
    nodes[ckptId] = { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: request.modelId || "" } };

    let imgId: string | null = null;
    let latentId: string | null = null;
    if (inputImage) {
      imgId = next();
      nodes[imgId] = { class_type: "LoadImage", inputs: { image: inputImage } };
      latentId = next();
      nodes[latentId] = {
        class_type: "VAEEncode",
        inputs: { pixels: [imgId, 0], vae: ["checkpoint", 2] }
      };
    } else {
      latentId = next();
      nodes[latentId] = {
        class_type: "EmptyLatentImage",
        inputs: {
          width: p.width || 1024,
          height: p.height || 1024,
          batch_size: 1
        }
      };
    }

    const ksId = next();
    nodes[ksId] = {
      class_type: "KSampler",
      inputs: {
        model: ["checkpoint", 0],
        positive: [posId, 0],
        negative: [negId, 0],
        latent_image: [latentId, 0],
        seed: p.seed !== undefined ? p.seed : Math.floor(Math.random() * 1e12),
        steps: p.steps || 20,
        cfg: p.cfg !== undefined ? p.cfg : 7,
        sampler_name: p.sampler_name || "euler",
        scheduler: p.scheduler || "normal",
        denoise: p.denoise !== undefined ? p.denoise : (inputImage ? 0.65 : 1)
      }
    };

    const decId = next();
    nodes[decId] = { class_type: "VAEDecode", inputs: { samples: [ksId, 0], vae: ["checkpoint", 2] } };
    const saveId = next();
    nodes[saveId] = { class_type: "SaveImage", inputs: { images: [decId, 0], filename_prefix: "aiforps" } };

    /* 参考图 (规则二十五): LoadImage 挂载, 由具体 workflow 决定用法; 此处记录不注入 */
    return nodes;
  }

  async submit(request: GenerationRequest): Promise<RemoteJob> {
    /* PHASE 10: 已导入 workflow (含 bindings 应用) 优先; 否则模板构建 */
    const wf = request.workflowJson ? (request.workflowJson as Record<string, ComfyNodeSpec>) : this.buildWorkflow(request);
    return this.submitRaw(wf);
  }

  /* 原始 workflow 提交 + 官方错误解析 (node_errors / OOM) */
  async submitRaw(wf: Record<string, ComfyNodeSpec>): Promise<RemoteJob> {
    const body = JSON.stringify({ prompt: wf, client_id: "a4p-helper" });
    const res = await fetch(this.baseUrl + "/prompt", {
      method: "POST", headers: { "content-type": "application/json" }, body
    });
    if (!res.ok) {
      let detail = "";
      try {
        const j = (await res.json()) as { node_errors?: unknown; error?: { message?: string; type?: string } };
        if (j.node_errors) detail = "node_errors: " + JSON.stringify(Object.keys(j.node_errors as object)).slice(0, 200);
        else if (j.error) detail = j.error.message || j.error.type || "";
      } catch (e) { /* noop */ }
      const msg = "ComfyUI 提交失败 (" + res.status + "): " + detail;
      if (/node_errors/i.test(detail)) throw new ProviderError(EC.COMFY_NODE_MISSING, msg, false, { status: res.status });
      if (/Out of Memory|OOM|CUDA out of memory/i.test(detail)) throw new ProviderError(EC.COMFY_OOM, "ComfyUI 显存不足 (OOM): " + detail, false);
      throw new ProviderError(EC.COMFY_OFFLINE, msg, true, { status: res.status });
    }
    const j = (await res.json()) as { prompt_id: string };
    return { remoteJobId: j.prompt_id, status: "queued", progress: 0 };
  }

  async getStatus(remoteJobId: string): Promise<RemoteJobState> {
    /* 1. history: completed/failed 判定 */
    try {
      const hist = await this.fetchJson("/history/" + encodeURIComponent(remoteJobId));
      const entry = hist[remoteJobId];
      if (entry) {
        const st = entry.status || {};
        if (st.status_str === "error") {
          const msgs = (st.messages || []).map((m: unknown[]) => (Array.isArray(m) ? m[1] : m));
          const err = msgs.find((m: { type?: string }) => m && m.type === "execution_error") as { exception_message?: string } | undefined;
          return {
            remoteJobId, status: "failed",
            error: { code: /OOM|out of memory/i.test(err?.exception_message || "") ? EC.COMFY_OOM : "COMFY_EXECUTION_ERROR", message: err?.exception_message || "ComfyUI 执行错误" }
          };
        }
        if (st.completed) {
          return { remoteJobId, status: "completed", progress: 100, outputs: this.outputsOf(entry) };
        }
        /* 运行中 (history 存在但未完成) */
        return { remoteJobId, status: "running", progress: 50 };
      }
    } catch (e) {
      if (!(e as Error).message.includes("404")) throw e;
    }
    /* 2. queue: queued / running 判定 */
    const queue = await this.fetchJson("/queue") as { queue_running?: Array<unknown[]>; queue_pending?: Array<unknown[]> };
    const inRunning = (queue.queue_running || []).some((q) => q[1] === remoteJobId);
    if (inRunning) return { remoteJobId, status: "running", progress: 50 };
    const inPending = (queue.queue_pending || []).some((q) => q[1] === remoteJobId);
    if (inPending) return { remoteJobId, status: "queued", progress: 0 };
    /* 3. 都不在: provider 丢失 */
    return { remoteJobId, status: "unknown", error: { code: "COMFY_JOB_LOST", message: "ComfyUI 中未找到任务 (可能已被清除)" } };
  }

  /* 规则十五: recover = 查询远端状态, 绝不重新 submit */
  async recover(remoteJobId: string): Promise<RemoteJobState> {
    return this.getStatus(remoteJobId);
  }

  async cancel(remoteJobId: string): Promise<CancelResult> {
    const queue = await this.fetchJson("/queue") as { queue_running?: Array<unknown[]>; queue_pending?: Array<unknown[]> };
    const running = (queue.queue_running || []).find((q) => q[1] === remoteJobId);
    if (running) {
      /* 规则十三: 确认是当前任务才 interrupt */
      await fetch(this.baseUrl + "/interrupt", { method: "POST" });
      return { ok: true, remoteJobId, message: "interrupted (running)" };
    }
    const pending = (queue.queue_pending || []).some((q) => q[1] === remoteJobId);
    if (pending) {
      /* queued: WS delete 消息删除指定 prompt (官方客户端协议) */
      const del = await this.wsDelete([remoteJobId]);
      return { ok: del, remoteJobId, message: del ? "deleted (queued)" : "delete 未确认, 任务可能已开始" };
    }
    return { ok: false, remoteJobId, message: "任务不在队列中" };
  }

  private wsDelete(ids: string[]): Promise<boolean> {
    return new Promise((resolve) => {
      const ws = new WebSocket(this.baseUrl.replace(/^http/, "ws") + "/ws?clientId=a4p-helper-cancel");
      const t = setTimeout(() => { try { ws.close(); } catch (e) { /* noop */ } resolve(false); }, 4000);
      ws.on("open", () => {
        ws.send(JSON.stringify({ delete: ids }));
        setTimeout(() => { clearTimeout(t); try { ws.close(); } catch (e) { /* noop */ } resolve(true); }, 500);
      });
      ws.on("error", () => { clearTimeout(t); resolve(false); });
    });
  }

  async downloadResults(remoteJobId: string): Promise<ResultAsset[]> {
    const hist = await this.fetchJson("/history/" + encodeURIComponent(remoteJobId));
    const entry = hist[remoteJobId];
    if (!entry) throw new ProviderError("COMFY_JOB_LOST", "任务结果不存在: " + remoteJobId);
    const outs = this.outputsOf(entry);
    const assets: ResultAsset[] = [];
    for (const o of outs) {
      const url = this.baseUrl + "/view?filename=" + encodeURIComponent(o.filename) +
        (o.subfolder ? "&subfolder=" + encodeURIComponent(o.subfolder) : "") + "&type=" + (o.type || "output");
      const res = await fetch(url);
      if (!res.ok) throw new ProviderError(EC.ASSET_DOWNLOAD_FAILED ?? "ASSET_DOWNLOAD_FAILED", "下载失败: " + o.filename + " (" + res.status + ")");
      const buf = new Uint8Array(await res.arrayBuffer());
      assets.push({ filename: o.filename, subfolder: o.subfolder, type: o.type, url, bytes: buf });
    }
    return assets;
  }

  private outputsOf(entry: { outputs?: Record<string, { images?: Array<{ filename: string; subfolder?: string; type?: string }> }> }) {
    const out: Array<{ filename: string; subfolder?: string; type?: string }> = [];
    const outputs = entry.outputs || {};
    for (const nid of Object.keys(outputs)) {
      const nodeOut = outputs[nid];
      if (nodeOut && Array.isArray(nodeOut.images)) out.push(...nodeOut.images);
    }
    return out;
  }

  async uploadImage(bytes: Uint8Array, filename: string, subfolder = ""): Promise<string> {
    const fd = new FormData();
    fd.append("image", new Blob([bytes as BlobPart]), filename);
    if (subfolder) fd.append("subfolder", subfolder);
    fd.append("type", "input");
    const res = await fetch(this.baseUrl + "/upload/image", { method: "POST", body: fd });
    if (!res.ok) throw new ProviderError(EC.COMFY_OFFLINE, "上传失败: " + res.status);
    const j = (await res.json()) as { name: string; subfolder?: string; type?: string };
    return j.subfolder ? j.subfolder + "/" + j.name : j.name;
  }

  /* ---- progress: WS 官方结构 + 轮询回退 ---- */
  connectProgress(remoteJobId: string, onProgress: (f: number) => void): () => void {
    let stopped = false;
    const wsUrl = this.baseUrl.replace(/^http/, "ws") + "/ws?clientId=a4p-helper-progress";
    const ws = new WebSocket(wsUrl);
    let pollTimer: NodeJS.Timeout | null = null;
    ws.on("message", (data) => {
      if (stopped) return;
      try {
        const msg = JSON.parse(String(data)) as { type: string; data?: { value?: number; max?: number; prompt_id?: string } };
        /* 官方结构: data.value / data.max (规则十二) */
        if (msg.type === "progress" && msg.data && msg.data.prompt_id === remoteJobId) {
          const value = Number(msg.data.value || 0);
          const max = Number(msg.data.max || 0);
          onProgress(max > 0 ? value / max : 0);
        }
      } catch (e) { /* malformed */ }
    });
    ws.on("error", () => { if (!stopped && !pollTimer) pollTimer = setInterval(() => this.pollOnce(remoteJobId, onProgress), 1500); });
    ws.on("close", () => { if (!stopped && !pollTimer) pollTimer = setInterval(() => this.pollOnce(remoteJobId, onProgress), 1500); });
    return () => {
      stopped = true;
      if (pollTimer) clearInterval(pollTimer);
      try { ws.close(); } catch (e) { /* noop */ }
    };
  }

  private pollOnce(remoteJobId: string, onProgress: (f: number) => void) {
    this.getStatus(remoteJobId).then((st) => {
      if (st.status === "running") onProgress(0.5);
    }).catch(() => { /* offline */ });
  }

  private async fetchJson(path: string): Promise<any> {
    const res = await fetch(this.baseUrl + path);
    if (!res.ok) throw new ProviderError(EC.COMFY_OFFLINE, "ComfyUI " + path + " -> " + res.status);
    return res.json();
  }

  /* PHASE 13: 真实连通性测试 — DNS/HTTP + /system_stats + 延迟 */
  async testConnection(): Promise<{ ok: boolean; latencyMs?: number; code?: string; message?: string }> {
    const t0 = Date.now();
    try {
      const res = await fetch(this.baseUrl + "/system_stats");
      const latencyMs = Date.now() - t0;
      if (!res.ok) return { ok: false, latencyMs, code: "COMFY_HTTP_" + res.status, message: "ComfyUI 返回 HTTP " + res.status };
      const j = (await res.json()) as { system?: { comfyui_version?: string } };
      return { ok: true, latencyMs, message: "ComfyUI " + (j.system?.comfyui_version || "在线") };
    } catch (e) {
      return { ok: false, latencyMs: Date.now() - t0, code: "COMFY_OFFLINE", message: "无法连接 ComfyUI (" + this.baseUrl + ")" };
    }
  }
}
