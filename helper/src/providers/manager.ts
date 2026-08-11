/* providers/manager: adapter 实例管理
 * - 按 provider 行 (base_url + 凭据) 创建 adapter
 * - 未配置 -> PROVIDER_NOT_CONFIGURED (UI 显示 Disabled + 原因, 不假运行) */
import type { Store } from "../db.js";
import { CredentialService } from "../credentials.js";
import { listProviders, type ProviderView } from "./registry.js";
import { ComfyUIAdapter } from "./comfyui.js";
import { OpenAICompatibleAdapter } from "./openai.js";
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
    } else {
      const err = new Error("Provider 实现尚未完成 (PHASE 12): " + view.type);
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
