/**
 * 设置存储。真相源在这里，插件只是缓存显示。
 * 分组存储（每组一行 JSON），避免一处改动重写整份设置造成并发覆盖。
 */

import { defaultSettings, SETTINGS_SCHEMA_VERSION } from '@psai/shared';
import type { AppSettings, FeatureBinding, ProviderSettings } from '@psai/shared';
import { PROVIDERS, fixedComfyFeatures, allFeatures } from '@psai/shared';
import type { Db } from './db.js';

type Group = keyof Omit<AppSettings, 'schemaVersion'>;

const GROUPS: Group[] = [
  'comfy',
  'cloud',
  'providers',
  'featureBindings',
  'generation',
  'ui',
  'promptOverrides',
  'customPresets'
];

export class SettingsStore {
  constructor(private readonly db: Db) {
    this.ensureSeeded();
  }

  private readGroup<K extends Group>(key: K, fallback: AppSettings[K]): AppSettings[K] {
    const row = this.db.prepare('SELECT json FROM settings WHERE key = ?').get(key) as { json: string } | undefined;
    if (!row) return fallback;
    try {
      return JSON.parse(row.json) as AppSettings[K];
    } catch {
      return fallback;
    }
  }

  private writeGroup<K extends Group>(key: K, value: AppSettings[K]): void {
    this.db
      .prepare(
        `INSERT INTO settings(key, json, updated_at) VALUES(?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`
      )
      .run(key, JSON.stringify(value), Date.now());
  }

  get(): AppSettings {
    const d = defaultSettings();
    return {
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      comfy: this.readGroup('comfy', d.comfy),
      cloud: this.readGroup('cloud', d.cloud),
      providers: this.readGroup('providers', d.providers),
      featureBindings: this.readGroup('featureBindings', d.featureBindings),
      generation: this.readGroup('generation', d.generation),
      ui: this.readGroup('ui', d.ui),
      promptOverrides: this.readGroup('promptOverrides', d.promptOverrides),
      customPresets: this.readGroup('customPresets', d.customPresets)
    };
  }

  /** 增量更新：只写传进来的分组，其余不动。 */
  patch(partial: Partial<AppSettings>): AppSettings {
    for (const g of GROUPS) {
      if (partial[g] !== undefined) {
        const current = this.get()[g];
        const next =
          Array.isArray(partial[g]) || typeof partial[g] !== 'object'
            ? partial[g]
            : { ...(current as object), ...(partial[g] as object) };
        this.writeGroup(g, next as never);
      }
    }
    return this.get();
  }

  /* ---------------- Provider ---------------- */

  providerSettings(id: string): ProviderSettings {
    const list = this.get().providers;
    const found = list.find((p) => p.id === id);
    if (found) return found;
    const desc = PROVIDERS.find((p) => p.id === id);
    return {
      id,
      enabled: false,
      baseUrl: desc?.defaultBaseUrl ?? '',
      defaultModel: desc?.defaultModel ?? '',
      hasCredentials: false
    };
  }

  upsertProvider(next: Partial<ProviderSettings> & { id: string }): ProviderSettings {
    const list = this.get().providers;
    const idx = list.findIndex((p) => p.id === next.id);
    const merged = { ...this.providerSettings(next.id), ...next };
    if (idx >= 0) list[idx] = merged;
    else list.push(merged);
    this.writeGroup('providers', list);
    return merged;
  }

  /* ---------------- 功能绑定 ---------------- */

  binding(featureId: string): FeatureBinding | null {
    return this.get().featureBindings.find((b) => b.featureId === featureId) ?? null;
  }

  upsertBinding(next: FeatureBinding): FeatureBinding {
    const list = this.get().featureBindings;
    const idx = list.findIndex((b) => b.featureId === next.featureId);
    if (idx >= 0) list[idx] = next;
    else list.push(next);
    this.writeGroup('featureBindings', list);
    return next;
  }

  /** 恢复某功能的出厂绑定。 */
  resetBinding(featureId: string): FeatureBinding | null {
    const list = this.get().featureBindings.filter((b) => b.featureId !== featureId);
    this.writeGroup('featureBindings', list);
    this.seedBindings();
    return this.binding(featureId);
  }

  /* ---------------- 初始化 ---------------- */

  private ensureSeeded(): void {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM settings').get() as { n: number };
    if (row.n === 0) {
      const d = defaultSettings();
      for (const g of GROUPS) this.writeGroup(g, d[g]);
    }
    this.seedProviders();
    this.seedBindings();
  }

  /** 把注册表里的 Provider 补进设置（新版本新增 Provider 时也会自动补上）。 */
  private seedProviders(): void {
    const list = this.get().providers;
    let changed = false;
    for (const desc of PROVIDERS) {
      if (!list.some((p) => p.id === desc.id)) {
        list.push({
          id: desc.id,
          // 本地 ComfyUI 出厂即启用；其余等用户填 Key
          enabled: desc.id === 'comfyui',
          baseUrl: desc.defaultBaseUrl,
          defaultModel: desc.defaultModel ?? '',
          hasCredentials: false
        });
        changed = true;
      }
    }
    if (changed) this.writeGroup('providers', list);
  }

  /** 11 个 ComfyUI 固定功能出厂即绑定内置工作流；闭源功能出厂不绑定。 */
  private seedBindings(): void {
    const list = this.get().featureBindings;
    let changed = false;
    for (const f of fixedComfyFeatures()) {
      if (!list.some((b) => b.featureId === f.id)) {
        list.push({
          featureId: f.id,
          providerId: 'comfyui',
          workflowId: f.defaultWorkflowId,
          remoteWorkflowId: null,
          model: null,
          enabled: true
        });
        changed = true;
      }
    }
    if (changed) this.writeGroup('featureBindings', list);
  }

  /** 所有功能 id（含闭源与自定义），供 /v1/features 用。 */
  featureIds(): string[] {
    return allFeatures().map((f) => f.id);
  }
}
