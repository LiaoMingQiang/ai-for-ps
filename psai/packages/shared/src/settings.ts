/**
 * 设置模型。
 *
 * 分层原则：
 *  - 所有会影响出图结果、以及所有含密钥的设置，真相源在 Helper（SQLite / DPAPI）。
 *  - 插件侧只本地保存纯 UI 偏好（上次停留的功能页、面板折叠状态）和配对 token（SecureStorage）。
 */

import type { ComfyMode } from './providers.js';
import type { FeatureBinding } from './workflow.js';
import type { WritebackMode } from './params.js';

export interface ComfyConnectionSettings {
  mode: ComfyMode;
  /** local 模式下也允许改端口 */
  baseUrl: string;
  /** localServer 模式：由 Helper 启动 ComfyUI 的可执行文件/启动脚本路径 */
  serverCommand: string;
  serverWorkingDir: string;
  /** 连接超时（毫秒） */
  timeoutMs: number;
}

export interface CloudConnectionSettings {
  /** RunningHub 云端默认工作流 id（可被单个功能绑定覆盖） */
  runninghubWorkflowId: string;
}

export interface ProviderSettings {
  id: string;
  enabled: boolean;
  baseUrl: string;
  defaultModel: string;
  /** 密钥不在这里；只记录"是否已设置"，真值在 DPAPI */
  hasCredentials: boolean;
}

export interface GenerationDefaults {
  writebackMode: WritebackMode;
  /** 写回图层命名模板，支持 {feature} {date} {seed} */
  layerNameTemplate: string;
  /** 本地并发上限 */
  maxConcurrency: number;
  /** 结果自动写回，还是停在"等待写回"让用户点确认 */
  autoWriteback: boolean;
}

/**
 * 这里曾经有一个 `inputMaxEdge`（"提交前把输入图缩放到的最长边上限"）。
 *
 * 它是个**空旋钮**：设置页认真地画了输入框、存进了库，但从提交到上传
 * 没有任何一行代码读过它。用户把它调成 1024 想省点带宽，实际什么也没发生；
 * 反过来，担心画质的人看到"上限 2048"会以为自己的 4000px 原图被压过 —— 也没有。
 * 两种理解都是错的，而错的方向相反，这比没有这个旋钮糟糕得多。
 *
 * 现在的行为是明确的：输入图**原样**上传，不缩放、不重编码，
 * 只有工作流自己声明要缩放时才缩放。所以这个旋钮直接删掉，
 * 而不是补一个实现 —— 默认降采样本来就不该是这个产品的行为。
 */

export interface UiPreferences {
  /** 上次停留的功能 id */
  lastFeatureId: string;
  language: 'zh-CN' | 'en-US';
  /** 高级参数是否默认展开 */
  advancedExpanded: boolean;
}

export interface AppSettings {
  schemaVersion: number;
  comfy: ComfyConnectionSettings;
  cloud: CloudConnectionSettings;
  providers: ProviderSettings[];
  featureBindings: FeatureBinding[];
  generation: GenerationDefaults;
  ui: UiPreferences;
  /** 用户对内置提示词的覆盖：presetId → 覆盖后的文本 */
  promptOverrides: Record<string, { prompt: string; negativePrompt?: string }>;
  /** 用户自建的提示词预设 */
  customPresets: Array<{ id: string; label: string; kind: string; scope: string[]; prompt: string; negativePrompt?: string }>;
}

export const SETTINGS_SCHEMA_VERSION = 1;

export function defaultSettings(): AppSettings {
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    comfy: {
      mode: 'local',
      baseUrl: 'http://127.0.0.1:8188',
      serverCommand: '',
      serverWorkingDir: '',
      timeoutMs: 15000
    },
    cloud: { runninghubWorkflowId: '' },
    providers: [],
    featureBindings: [],
    generation: {
      writebackMode: 'smartObject',
      layerNameTemplate: 'AI · {feature} · {date}',
      maxConcurrency: 1,
      autoWriteback: true
    },
    ui: { lastFeatureId: 'comfy.wash.portrait', language: 'zh-CN', advancedExpanded: false },
    promptOverrides: {},
    customPresets: []
  };
}

/** 写回图层名渲染。 */
export function renderLayerName(template: string, vars: { feature: string; date?: string; seed?: number }): string {
  const date = vars.date ?? new Date().toISOString().slice(0, 19).replace('T', ' ');
  return template
    .replaceAll('{feature}', vars.feature)
    .replaceAll('{date}', date)
    .replaceAll('{seed}', vars.seed === undefined ? '' : String(vars.seed))
    .trim();
}
