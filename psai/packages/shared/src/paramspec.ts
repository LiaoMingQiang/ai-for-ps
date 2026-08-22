/**
 * 参数规格（ParamSpec）—— 声明式描述一个功能需要哪些控件。
 *
 * 设计意图：UI 不为任何功能写死表单。生成页读取 FeatureSpec.params，
 * 按 ParamSpec 逐条渲染控件；提交时按同一份 spec 校验并归一化。
 * 新增一个功能 = 新增目录项 + 工作流，UI 零改动。
 */

import type { InputSource, SeedValue, AspectValue, CameraValue } from './params.js';

export type ParamKind =
  | 'image'
  | 'imageList'
  | 'prompt'
  | 'negativePrompt'
  | 'presetPrompt'
  | 'seed'
  | 'slider'
  | 'select'
  | 'segmented'
  | 'toggle'
  | 'aspect'
  | 'resolution'
  | 'camera'
  | 'model'
  | 'text';

interface ParamBase {
  id: string;
  label: string;
  kind: ParamKind;
  /** 控件下方的灰色说明 */
  hint?: string;
  /** 折叠到「高级」分组里 */
  advanced?: boolean;
  /** 仅当该表达式为真时显示：{ param: 'xxx', equals: true } */
  visibleWhen?: { param: string; equals: string | number | boolean };
}

export interface ImageParam extends ParamBase {
  kind: 'image';
  required: boolean;
  /** 允许的来源；顺序即 UI 中按钮顺序 */
  sources: InputSource[];
  defaultSource: InputSource;
}

export interface ImageListParam extends ParamBase {
  kind: 'imageList';
  required: boolean;
  sources: InputSource[];
  min: number;
  max: number;
}

export interface PromptParam extends ParamBase {
  kind: 'prompt';
  placeholder: string;
  required: boolean;
  /** 显示 ✨ 优化提示词按钮 */
  enhanceable: boolean;
  defaultValue: string;
  rows: number;
}

export interface NegativePromptParam extends ParamBase {
  kind: 'negativePrompt';
  placeholder: string;
  defaultValue: string;
  rows: number;
}

export interface PresetPromptParam extends ParamBase {
  kind: 'presetPrompt';
  /** 只列出 scope 命中当前功能、且 kind 匹配的预设 */
  presetKind: 'reverse' | 'stylize' | 'skill';
  /** 出厂默认选中的预设 id；空串表示不选 */
  defaultPresetId: string;
  /** 是否附带「是否启用」开关（参考图谱：内置反推场景 → 是否启用） */
  toggleable: boolean;
  defaultEnabled: boolean;
}

export interface SeedParam extends ParamBase {
  kind: 'seed';
  defaultValue: SeedValue;
}

export interface SliderParam extends ParamBase {
  kind: 'slider';
  min: number;
  max: number;
  step: number;
  defaultValue: number;
  /** 显示时的小数位 */
  precision: number;
  unit?: string;
}

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectParam extends ParamBase {
  kind: 'select';
  options: SelectOption[];
  defaultValue: string;
  /** 运行时可被 Provider 实时能力覆盖（例：采样器列表来自 /object_info） */
  dynamicSource?: 'samplers' | 'schedulers' | 'upscaleModels' | 'checkpoints';
}

export interface SegmentedParam extends ParamBase {
  kind: 'segmented';
  options: SelectOption[];
  defaultValue: string;
}

export interface ToggleParam extends ParamBase {
  kind: 'toggle';
  defaultValue: boolean;
}

export interface AspectParam extends ParamBase {
  kind: 'aspect';
  defaultValue: AspectValue;
}

export interface ResolutionParam extends ParamBase {
  kind: 'resolution';
  min: number;
  max: number;
  step: number;
  defaultValue: number;
}

export interface CameraParam extends ParamBase {
  kind: 'camera';
  defaultValue: CameraValue;
  /** 是否把机位翻译成的英文片段自动拼进提示词 */
  injectPrompt: boolean;
}

export interface ModelParam extends ParamBase {
  kind: 'model';
  /** 空串 = 用 Provider 的默认模型 */
  defaultValue: string;
}

export interface TextParam extends ParamBase {
  kind: 'text';
  placeholder: string;
  defaultValue: string;
}

export type ParamSpec =
  | ImageParam
  | ImageListParam
  | PromptParam
  | NegativePromptParam
  | PresetPromptParam
  | SeedParam
  | SliderParam
  | SelectParam
  | SegmentedParam
  | ToggleParam
  | AspectParam
  | ResolutionParam
  | CameraParam
  | ModelParam
  | TextParam;

/** 一次提交里所有参数的取值。 */
export type ParamValues = Record<string, unknown>;

/** 取出该 spec 的出厂默认值。 */
export function defaultValueOf(spec: ParamSpec): unknown {
  switch (spec.kind) {
    case 'image':
      return { source: spec.defaultSource, assetId: null };
    case 'imageList':
      return [];
    case 'prompt':
    case 'negativePrompt':
    case 'text':
      return spec.defaultValue;
    case 'presetPrompt':
      return { presetId: spec.defaultPresetId, enabled: spec.defaultEnabled };
    case 'seed':
      return { ...spec.defaultValue };
    case 'slider':
    case 'resolution':
      return spec.defaultValue;
    case 'select':
    case 'segmented':
    case 'model':
      return spec.defaultValue;
    case 'toggle':
      return spec.defaultValue;
    case 'aspect':
      return { ...spec.defaultValue };
    case 'camera':
      return { ...spec.defaultValue };
    default:
      return null;
  }
}

/** 为一组 spec 生成完整的默认取值表。 */
export function defaultValues(specs: readonly ParamSpec[]): ParamValues {
  const out: ParamValues = {};
  for (const s of specs) out[s.id] = defaultValueOf(s);
  return out;
}

/** 该参数在当前取值下是否应该显示。 */
export function isVisible(spec: ParamSpec, values: ParamValues): boolean {
  if (!spec.visibleWhen) return true;
  return values[spec.visibleWhen.param] === spec.visibleWhen.equals;
}
