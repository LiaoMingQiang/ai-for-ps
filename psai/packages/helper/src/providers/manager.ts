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
import { LiblibAdapter } from './liblib.js';
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
            // 工作流 id 现在挂在 Provider 自己身上（和 defaultModel 对称），
            // 不再从全局的 cloud.runninghubWorkflowId 取 —— 那个字段只剩迁移用途。
            defaultWorkflowId: ps.defaultWorkflowId || s.cloud.runninghubWorkflowId,
            timeoutMs
          };
          if (existing instanceof RunningHubAdapter) existing.updateOptions(opts);
          else this.adapters.set(desc.id, new RunningHubAdapter(opts, this.log));
          break;
        }
        case 'liblib': {
          const opts = {
            baseUrl: ps.baseUrl || desc.defaultBaseUrl,
            // 两段式密钥：少一个都签不出名字，isConfigured() 会据此报未配置
            accessKey: this.credentials.get(desc.id, 'accessKey'),
            secretKey: this.credentials.get(desc.id, 'secretKey'),
            defaultWorkflowId: ps.defaultWorkflowId,
            defaultModel: ps.defaultModel,
            // 平台侧 ComfyUI 应用模板 id —— 和工作流 uuid 是两个值。
            // 走凭据存储只是图省事（它本来就是个不该外传的账号相关常量），
            // 真机上把工作流 uuid 当它发会直接被回 template not found。
            comfyTemplateUuid: this.credentials.get(desc.id, 'comfyTemplateUuid') ?? '',
            timeoutMs
          };
          if (existing instanceof LiblibAdapter) existing.updateOptions(opts);
          else this.adapters.set(desc.id, new LiblibAdapter(opts, this.log));
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
      // 探测缓存里那份才是"这个平台有哪些模型"。
      // 以前这里写的是 `ps.defaultModel ? [ps.defaultModel] : cached`，
      // 于是用户一旦选定默认模型，列表就塌成只剩那一个 —— 设置页的下拉
      // 从此再也换不了别的，看起来像平台只有一个模型。
      // 默认模型是另一件事，接口里单独有 defaultModel 字段。
      models: cached?.models ?? (ps.defaultModel ? [ps.defaultModel] : []),
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

  /**
   * 启动时把已配置的云 Provider 探一遍，顺带把模型列表拉回缓存。
   *
   * 「接口配好了就该知道有哪些模型」不能只在保存密钥那一刻成立 ——
   * Helper 重启之后缓存是空的，设置页的模型下拉就退回「尚未拉取模型」，
   * 用户明明上周就配好了，界面却表现得像什么都没配过，
   * 还得自己想到去点一次「拉取模型」才能恢复。
   *
   * 只探已启用且已配置的：没配的探了必然失败，白白拖慢启动还刷一屏错误日志。
   * 全程不抛：这是锦上添花的预热，探不到就等用户下次主动拉，
   * 绝不能因为某个平台连不上就把 Helper 启动搅黄。
   */
  async warmupCloud(): Promise<void> {
    const targets = PROVIDERS.filter((desc) => {
      if (desc.kind === 'comfyui') return false; // 启动流程里单独探过了
      if (!desc.capabilities.includes('listModels')) return false;
      if (!this.settings.providerSettings(desc.id).enabled) return false;
      return this.adapters.get(desc.id)?.isConfigured() ?? false;
    });
    await Promise.all(
      targets.map(async (desc) => {
        try {
          const s = await this.probe(desc.id);
          this.log.info('云 Provider 预热', { providerId: desc.id, online: s.online, models: s.models.length });
        } catch (e) {
          this.log.warn('云 Provider 预热失败', { providerId: desc.id, error: String(e) });
        }
      })
    );
  }

  /* ---------------- 功能 → Provider 解析 ---------------- */

  /**
   * 决定某个功能这次该用哪个 Provider。
   * 1) 有绑定用绑定；2) comfy 类功能只认 ComfyUI，不回退云端；
   * 3) 闭源功能按注册表顺序取第一个"已启用+已配置+能力匹配"的。
   */
  /**
   * 这个功能实际会用哪个 Provider —— 解析不出来就返回 null，不抛。
   *
   * 存在的理由：`/v1/features` 以前自己算了一遍
   *   `binding?.providerId ?? (comfy 就用 comfyui : null)`
   * 少了 resolveProvider 里那段「没绑定就按能力挑一个已配置的闭源 Provider」的兜底。
   * 于是没显式绑定过的云端功能一律被判成「未配置任何闭源模型 Provider」并禁用，
   * 可实际上提交是能跑通的 —— 界面说不能用、后端说能用，两边各算各的。
   *
   * 更糟的是生成页靠 view.providerId 去拉模型列表，它是 null 就整段跳过，
   * 模型下拉永远停在「尚未拉取模型列表」。设置里明明已经拉到模型了。
   *
   * 所以判定和执行必须共用同一套解析，这个方法就是那份唯一事实源。
   */
  resolveProviderIdOrNull(featureId: string): string | null {
    try {
      return this.resolveProvider(featureId).providerId;
    } catch {
      return null;
    }
  }

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
