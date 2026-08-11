/* providers/manager: adapter 实例管理
 * - 按 provider 行 (base_url + 凭据) 创建 adapter
 * - 未配置 -> PROVIDER_NOT_CONFIGURED (UI 显示 Disabled + 原因, 不假运行) */
import type { Store } from "../db.js";
import { CredentialService } from "../credentials.js";
import { listProviders, type ProviderView, PROVIDER_TYPES } from "./registry.js";
import { ComfyUIAdapter } from "./comfyui.js";
import { OpenAICompatibleAdapter } from "./openai.js";
import { GeminiAdapter } from "./gemini.js";
import { RunningHubAdapter } from "./runninghub.js";
import type { ProviderAdapter } from "./sdk.js";

export class ProviderManager {
  private cache = new Map<string, ProviderAdapter>();

  constructor(private store: Store, private credentials: CredentialService) {}

  view(id: string): ProviderView | undefined {
    return listProviders(this.store).find((p) => p.id === id);
  }

  async adapter(id: string): Promise<ProviderAdapter> {
    const cached = this.cache.get(id);
    if (cached) return cached;
    const view = this.view(id);
    if (!view) throw new Error("PROVIDER_NOT_FOUND:" + id);
    if (!view.enabled && !view.configured) {
      const err = new Error("Provider 尚未配置: " + id);
      (err as Error & { code?: string }).code = "PROVIDER_NOT_CONFIGURED";
      throw err;
    }
    let adapter: ProviderAdapter;
    if (view.type === "comfyui") {
      adapter = new ComfyUIAdapter(id, view.baseUrl || "http://127.0.0.1:8188");
    } else if (view.type === "openai-compatible") {
      const key = await this.credentials.get(id);
      adapter = new OpenAICompatibleAdapter(id, view.baseUrl, key);
    } else if (view.type === "gemini") {
      const key = await this.credentials.get(id);
      adapter = new GeminiAdapter(id, key, view.baseUrl);
    } else if (view.type === "volcengine") {
      /* 火山方舟: OpenAI 兼容端点 (ark.cn-beijing.volces.com/api/v3) */
      const key = await this.credentials.get(id);
      adapter = new OpenAICompatibleAdapter(id, view.baseUrl || "https://ark.cn-beijing.volces.com/api/v3", key);
    } else if (view.type === "bailian") {
      /* 阿里百炼: OpenAI 兼容端点 (dashscope.aliyuncs.com/compatible-mode/v1) */
      const key = await this.credentials.get(id);
      adapter = new OpenAICompatibleAdapter(id, view.baseUrl || "https://dashscope.aliyuncs.com/compatible-mode/v1", key);
    } else if (view.type === "modelscope") {
      /* ModelScope: OpenAI 兼容端点 */
      const key = await this.credentials.get(id);
      adapter = new OpenAICompatibleAdapter(id, view.baseUrl || "https://api-inference.modelscope.cn/v1", key);
    } else if (view.type === "runninghub") {
      const key = await this.credentials.get(id);
      adapter = new RunningHubAdapter(id, key, view.baseUrl);
    } else {
      const err = new Error("Provider 实现尚未完成: " + view.type);
      (err as Error & { code?: string }).code = "PROVIDER_NOT_IMPLEMENTED";
      throw err;
    }
    this.cache.set(id, adapter);
    return adapter;
  }

  invalidate(id: string) {
    this.cache.delete(id);
  }
}
