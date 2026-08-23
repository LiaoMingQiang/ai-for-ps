/**
 * 参数归一化与提示词组装。
 *
 * 提交时把 UI 传来的原始参数变成"可复现的最终参数"：
 * 种子定下来、宽高算出来、提示词拼好、机位翻译成英文片段。
 * 结果整份存进任务记录，历史页据此可以一键复现。
 */

import {
  describeCamera,
  resolveSeed,
  resolveOutputSize,
  RESOLUTION_DEFAULT,
  RESOLUTION_SOURCE,
  clamp,
  clampInt,
  RESOLUTION_MIN,
  RESOLUTION_MAX,
  PsaiError
} from '@psai/shared';
import type { FeatureSpec, ParamSpec, SeedValue, AspectValue, CameraValue } from '@psai/shared';
import type { PromptStore } from '../prompts.js';

export interface ResolvedJobParams {
  /** 注入工作流 / 发给云端的最终值表 */
  values: Record<string, unknown>;
  /** 组装后的完整正向提示词（含机位片段），云端分支直接用它 */
  prompt: string;
  negativePrompt: string;
  seed: number;
  width: number;
  height: number;
  /** 机位英文片段，comfy 分支通过 appendText 绑定单独注入 */
  cameraFragment: string;
  /** 面板上"最终提示词"折叠区展示用 */
  promptBreakdown: Array<{ label: string; text: string }>;
}

export interface ResolveOptions {
  reverseText?: string;
  enhancedPrompt?: string;
  /** 第一张输入图的尺寸。图生图类功能靠它按原始比例缩放，而不是硬套正方形。 */
  inputSize?: { width: number; height: number };
}

export function resolveJobParams(
  feature: FeatureSpec,
  raw: Record<string, unknown>,
  prompts: PromptStore,
  opts: ResolveOptions = {}
): ResolvedJobParams {
  const values: Record<string, unknown> = {};
  const breakdown: Array<{ label: string; text: string }> = [];

  let seed = 0;
  let width = 1024;
  let height = 1024;
  let cameraFragment = '';

  const specById = new Map<string, ParamSpec>(feature.params.map((p) => [p.id, p]));

  // 1. 逐个参数按 spec 归一化
  for (const spec of feature.params) {
    const v = raw[spec.id];
    switch (spec.kind) {
      case 'seed': {
        const sv = (v as SeedValue | undefined) ?? spec.defaultValue;
        seed = resolveSeed(sv);
        values['seed'] = seed;
        break;
      }
      case 'slider': {
        const n = typeof v === 'number' ? v : spec.defaultValue;
        values[spec.id] = clamp(n, spec.min, spec.max);
        break;
      }
      case 'resolution': {
        const n = typeof v === 'number' ? v : spec.defaultValue;
        // RESOLUTION_SOURCE(0) 是「跟随原图」的哨兵值，不是一个小得离谱的分辨率。
        // 无脑 clamp 会把它夹成 RESOLUTION_MIN(512)，于是「跟随原图」静默变成
        // 「把长边压到 512」—— 比原来压到 1024 还糟，而且完全看不出是谁干的。
        values[spec.id] = n === RESOLUTION_SOURCE ? RESOLUTION_SOURCE : clampInt(n, RESOLUTION_MIN, RESOLUTION_MAX);
        break;
      }
      case 'select':
      case 'segmented':
      case 'model':
      case 'text': {
        values[spec.id] = typeof v === 'string' && v !== '' ? v : spec.defaultValue;
        break;
      }
      case 'toggle': {
        values[spec.id] = typeof v === 'boolean' ? v : spec.defaultValue;
        break;
      }
      case 'camera': {
        const cam = (v as CameraValue | undefined) ?? spec.defaultValue;
        const d = describeCamera(cam);
        cameraFragment = spec.injectPrompt ? d.promptFragment : '';
        values['camera'] = cameraFragment;
        values['__cameraYaw'] = d.yaw;
        values['__cameraPitch'] = d.pitch;
        values['__cameraName'] = d.name;
        values['__cameraStability'] = d.stability;
        if (cameraFragment) breakdown.push({ label: '机位', text: cameraFragment });
        break;
      }
      case 'aspect': {
        const av = (v as AspectValue | undefined) ?? spec.defaultValue;
        values['aspect'] = av;
        break;
      }
      case 'image':
      case 'imageList':
        // 图像在引擎层单独处理（要先上传拿到远端文件名）
        break;
      case 'prompt':
      case 'negativePrompt':
      case 'presetPrompt':
        // 下面统一组装
        break;
    }
  }

  // 2. 宽高
  //    统一交给 resolveOutputSize：显式选的比例/分辨率 > 跟随原图 > 分辨率当正方形。
  //
  //    这里以前是「有比例就按比例、没比例就把原图长边压到分辨率滑杆的值」。
  //    压缩那一支是默认路径，而滑杆默认 1024 —— 于是一张 4000×3000 的图
  //    洗完回来只有 1024×768。用户没要求缩小，贴回 Photoshop 却糊了一圈，
  //    而且原图分辨率再也拿不回来。现在有输入图就默认照抄原图尺寸。
  const resolutionSpec = specById.get('resolution');
  const size = resolveOutputSize({
    aspect: values['aspect'] as AspectValue | undefined,
    resolution: resolutionSpec ? Number(values['resolution'] ?? RESOLUTION_DEFAULT) : undefined,
    inputSize: opts.inputSize
  });
  width = size.width;
  height = size.height;
  values['__width'] = width;
  values['__height'] = height;
  // 下游（闭源平台）要知道这个尺寸是不是「原图尺寸」：
  // 是的话，平台给不了精确尺寸时才该退到 2K 兜底，而不是随便找个档位。
  values['__followSourceSize'] = size.followedSource;

  // 3. 提示词组装
  const positives: string[] = [];
  const negatives: string[] = [];

  // 3a. 反推结果（由引擎在调用前算好传进来）
  if (opts.reverseText && opts.reverseText.trim()) {
    positives.push(opts.reverseText.trim());
    breakdown.push({ label: '反推结果', text: opts.reverseText.trim() });
  }

  // 3b. 稿型 / 技能预设
  for (const spec of feature.params) {
    if (spec.kind !== 'presetPrompt') continue;
    const val = raw[spec.id] as { presetId?: string; enabled?: boolean } | undefined;
    const enabled = val?.enabled ?? spec.defaultEnabled;
    const presetId = val?.presetId ?? spec.defaultPresetId;
    values[spec.id] = { presetId, enabled };
    if (!enabled || !presetId) continue;
    if (spec.presetKind === 'reverse' || spec.presetKind === 'skill') continue; // 这两类是指令，不进最终提示词
    const preset = prompts.find(presetId);
    if (!preset) continue;
    positives.push(preset.prompt);
    if (preset.negativePrompt) negatives.push(preset.negativePrompt);
    breakdown.push({ label: preset.label, text: preset.prompt });
  }

  // 3c. 用户提示词（优化过就用优化后的）
  const promptSpec = feature.params.find((p) => p.kind === 'prompt');
  if (promptSpec && promptSpec.kind === 'prompt') {
    const userPrompt = opts.enhancedPrompt ?? (typeof raw['prompt'] === 'string' ? (raw['prompt'] as string) : '');
    const trimmed = userPrompt.trim();
    if (promptSpec.required && !trimmed) {
      throw new PsaiError('JOB_PARAM_INVALID', `「${promptSpec.label}」是必填项`);
    }
    if (trimmed) {
      positives.push(trimmed);
      breakdown.push({ label: opts.enhancedPrompt ? '提示词（已优化）' : '提示词', text: trimmed });
    }
  }

  // 3d. 负向
  const negSpec = feature.params.find((p) => p.kind === 'negativePrompt');
  if (negSpec && negSpec.kind === 'negativePrompt') {
    const userNeg = typeof raw['negativePrompt'] === 'string' ? (raw['negativePrompt'] as string) : negSpec.defaultValue;
    if (userNeg.trim()) negatives.push(userNeg.trim());
  }

  // 3e. 输出类型（高质量产品渲染）
  const outputType = values['outputType'];
  if (outputType === 'whiteBackground') {
    const w = 'pure white seamless background, e-commerce product shot, soft even studio lighting, no props';
    positives.push(w);
    breakdown.push({ label: '输出类型', text: w });
  }

  // comfy 分支的机位由绑定单独注入，云端分支需要拼进最终提示词
  const promptForComfy = positives.join(', ');
  const promptForCloud = [promptForComfy, cameraFragment].filter((s) => s.trim()).join(', ');

  values['prompt'] = promptForComfy;
  values['negativePrompt'] = negatives.join(', ');

  return {
    values,
    prompt: feature.engine === 'comfy-workflow' ? promptForComfy : promptForCloud,
    negativePrompt: negatives.join(', '),
    seed,
    width,
    height,
    cameraFragment,
    promptBreakdown: breakdown
  };
}

/** 该功能是否需要在提交前先做一次反推。 */
export function reversePresetOf(
  feature: FeatureSpec,
  raw: Record<string, unknown>
): { presetId: string } | null {
  for (const spec of feature.params) {
    if (spec.kind !== 'presetPrompt') continue;
    if (spec.presetKind !== 'reverse' && spec.presetKind !== 'skill') continue;
    const val = raw[spec.id] as { presetId?: string; enabled?: boolean } | undefined;
    const enabled = val?.enabled ?? spec.defaultEnabled;
    const presetId = val?.presetId ?? spec.defaultPresetId;
    if (enabled && presetId) return { presetId };
  }
  return null;
}

/** 是否开启了「优化提示词」。 */
export function wantsEnhance(feature: FeatureSpec, raw: Record<string, unknown>): boolean {
  const spec = feature.params.find((p) => p.id === 'promptEnhance');
  if (!spec || spec.kind !== 'toggle') return false;
  const v = raw['promptEnhance'];
  return typeof v === 'boolean' ? v : spec.defaultValue;
}
