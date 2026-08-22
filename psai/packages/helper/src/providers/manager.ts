/**
 * Provider 管理器：持有适配器实例、按设置刷新配置、解析"这个功能该用哪个 Provider"。
 *
 * 未配置的 Provider 一律返回 configured:false + reason，UI 据此禁用入口并显示原因。
 * 绝不静默回退到另一个 Provider —— 用户必须知道图是谁生成的。
 */

import { PROVIDERS, PsaiError, findProvider, findFeature } from '@psai/shared';
import type { ProviderRuntimeStatus, ProviderCapability, FeatureSpec } from '@psai/shared';
import type { ProviderAdapter } from './types.js';
import { ComfyUiAdapter } from './comfyui.js';
import { OpenAiCompatibleAdapter } from './openai.js';
import { GeminiAdapter } from './gemini.js';
import { RunningHubAdapter } from './runninghub.js';
import type { SettingsStore } from '../settings.js';
import type { CredentialStore } from '../credentials.js';
import type { Logger } from '../log.js';

export class ProviderManager {
  private adapters = new Map<string, ProviderAdapter>();
  private statusCache = new Map<string, ProviderRuntimeStatus>();

  constructor(
    private readonly settings: SettingsStore,
    private readonly credentials: CredentialStore,
    private readonly log: Logger
  ) {
    this.refresh();
  }

  /** 设置或密钥变化后调用，重建/更新适配器配置。 */
  refresh(): void {
    const s = this.settings.get();

    for (const desc of PROVIDERS) {
      const ps = this.settings.providerSettings(desc.id);
      const apiKey = this.credentials.get(desc.id, 'apiKey');
      const timeoutMs = s.comfy.timeoutMs;

      const existing = this.adapters.get(desc.id);

      switch (desc.kind) {
        case 'comfyui': {
          const opts = { baseUrl: s.comfy.baseUrl || ps.baseUrl || desc.defaultBaseUrl, timeoutMs };
          if (existing instanceof ComfyUiAdapter) existing.updateOptions(opts);
          else this.adapters.set(desc.id, new ComfyUiAdapter(opts, this.log));
          break;
        }
        case 'runninghub': {
          const opts = {
            baseUrl: ps.baseUrl || desc.defaultBaseUrl,
            apiKey,
            defaultWorkflowId: s.cloud.runninghubWorkflowId,
            timeoutMs
          };
          if (existing instanceof RunningHubAdapter) existing.updateOptions(opts);
          else this.adapters.set(desc.id, new RunningHubAdapter(opts, this.log));
          break;
        }
        case 'gemini': {
          const opts = {
            baseUrl: ps.baseUrl || desc.defaultBaseUrl,
            apiKey,
            defaultModel: ps.defaultModel,
            timeoutMs
          };
          if (existing instanceof GeminiAdapter) existing.updateOptions(opts);
          else this.adapters.set(desc.id, new GeminiAdapter(opts));
          break;
        }
        case 'openai-compatible': {
          const opts = {
            id: desc.id,
            label: desc.label,
            baseUrl: ps.baseUrl || desc.defaultBaseUrl,
            apiKey,
            defaultModel: ps.defaultModel,
            timeoutMs,
            capabilities: desc.capabilities
          };
          if (existing instanceof OpenAiCompatibleAdapter) existing.updateOptions(opts);
          else this.adapters.set(desc.id, new OpenAiCompatibleAdapter(opts, this.log));
          break;
        }
      }
    }
  }

  adapter(id: string): ProviderAdapter {
    const a = this.adapters.get(id);
    if (!a) throw new PsaiError('PROVIDER_NOT_CONFIGURED', `未知的 Provider: ${id}`);
    return a;
  }

  comfy(): ComfyUiAdapter {
    return this.adapter('comfyui') as ComfyUiAdapter;
  }

  /**
   * ComfyUI 的地址真相源是 settings.comfy.baseUrl（连接分组），
   * 不是 providers[comfyui].baseUrl。两处都存会漂移：适配器连着 A，
   * 界面和依赖报告却显示 B，排错时极具误导性。
   */
  private baseUrlOf(id: string): string {
    const desc = findProvider(id);
    if (desc?.kind === 'comfyui') return this.settings.get().comfy.baseUrl || desc.defaultBaseUrl;
    const ps = this.settings.providerSettings(id);
    return ps.baseUrl || desc?.defaultBaseUrl || '';
  }

  /** 运行时状态列表，供设置页与导航就绪判定使用。 */
  status(id: string): ProviderRuntimeStatus {
    const desc = findProvider(id);
    const ps = this.settings.providerSettings(id);
    const a = this.adapters.get(id);
    const cached = this.statusCache.get(id);
    const configured = a?.isConfigured() ?? false;
    return {
      id,
      configured,
      enabled: ps.enabled,
      online: cached?.online ?? false,
      baseUrl: this.baseUrlOf(id),
      reason: configured
        ? ps.enabled
          ? (cached?.reason ?? null)
          : '该 Provider 已被禁用'
        : (a?.notConfiguredReason() ?? '未配置'),
      latencyMs: cached?.latencyMs ?? null,
      lastCheckedAt: cached?.lastCheckedAt ?? null,
      models: ps.defaultModel ? [ps.defaultModel] : (cached?.models ?? []),
      capabilities: desc?.capabilities ?? []
    };
  }

  allStatus(): ProviderRuntimeStatus[] {
    return PROVIDERS.map((p) => this.status(p.id));
  }

  /** 主动探测并缓存状态。 */
  async probe(id: string): Promise<ProviderRuntimeStatus> {
    const a = this.adapter(id);
    const base = this.status(id);
    if (!a.isConfigured()) {
      const next = { ...base, online: false, reason: a.notConfiguredReason(), lastCheckedAt: Date.now() };
      this.statusCache.set(id, next);
      return next;
    }
    const result = await a.testConnection();
    let models = base.models;
    if (result.ok) {
      try {
        models = await a.listModels();
      } catch {
        /* 拿不到模型列表不影响在线判定 */
      }
    }
    const next: ProviderRuntimeStatus = {
      ...base,
      online: result.ok,
      reason: result.ok ? null : result.detail,
      latencyMs: result.latencyMs,
      lastCheckedAt: Date.now(),
      models
    };
    this.statusCache.set(id, next);
    return next;
  }

  /* ---------------- 功能 → Provider 解析 ---------------- */

  /**
   * 决定某个功能这次该用哪个 Provider。
   * 1) 有绑定用绑定；2) comfy 类功能只认 ComfyUI，不回退云端；
   * 3) 闭源功能按注册表顺序取第一个"已启用+已配置+能力匹配"的。
   */
  resolveProvider(featureId: string, override?: string): { providerId: string; feature: FeatureSpec } {
    const feature = findFeature(featureId);
    if (!feature) throw new PsaiError('JOB_PARAM_INVALID', `未知功能: ${featureId}`);

    if (override) return { providerId: override, feature };

    const binding = this.settings.binding(featureId);
    if (binding?.enabled && binding.providerId) {
      return { providerId: binding.providerId, feature };
    }

    if (feature.engine === 'comfy-workflow') {
      const a = this.adapters.get('comfyui');
      if (!a?.isConfigured()) {
        throw new PsaiError('PROVIDER_NOT_CONFIGURED', a?.notConfiguredReason() ?? 'ComfyUI 未配置');
      }
      return { providerId: 'comfyui', feature };
    }

    const needed: ProviderCapability[] =
      feature.engine === 'cloud-vision' ? ['vision'] : ['textToImage', 'imageToImage'];

    for (const desc of PROVIDERS) {
      if (desc.kind === 'comfyui' || desc.kind === 'runninghub') continue;
      const ps = this.settings.providerSettings(desc.id);
      if (!ps.enabled) continue;
      const a = this.adapters.get(desc.id);
      if (!a?.isConfigured()) continue;
      if (!needed.some((c) => desc.capabilities.includes(c))) continue;
      return { providerId: desc.id, feature };
    }

    throw new PsaiError(
      'PROVIDER_NOT_CONFIGURED',
      '没有可用的闭源模型 Provider。请到 设置 → 推荐平台 配置至少一个 API Key 并启用。'
    );
  }

  /** 找一个具备视觉能力的 Provider（反推提示词 / 优化提示词用）。 */
  resolveTextProvider(preferred?: string): { providerId: string; adapter: ProviderAdapter } {
    const tryOne = (id: string): { providerId: string; adapter: ProviderAdapter } | null => {
      const a = this.adapters.get(id);
      if (!a || typeof a.textComplete !== 'function' || !a.isConfigured()) return null;
      const ps = this.settings.providerSettings(id);
      if (!ps.enabled) return null;
      return { providerId: id, adapter: a };
    };

    if (preferred) {
      const hit = tryOne(preferred);
      if (hit) return hit;
    }
    for (const desc of PROVIDERS) {
      if (!desc.capabilities.includes('vision')) continue;
      const hit = tryOne(desc.id);
      if (hit) return hit;
    }
    throw new PsaiError(
      'PROVIDER_NOT_CONFIGURED',
      '没有可用于反推/优化提示词的后端。请配置一个具备视觉能力的闭源 Provider。'
    );
  }

  dispose(): void {
    for (const a of this.adapters.values()) a.dispose?.();
    this.adapters.clear();
  }
}
