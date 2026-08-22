/**
 * 内置提示词库。
 *
 * 来源：参考图谱「内置提示词 / 通用内置反推提示词 / 内置 skills 提示词」。
 * 这些是出厂默认值；用户可在「设置 → 内置提示词」里编辑或新增，编辑后存 Helper 的 SQLite，
 * 出厂项不可删除但可恢复默认。
 */

export type PromptPresetKind =
  /** 反推（图 → 文）：用视觉模型描述输入图，产出可复用的提示词 */
  | 'reverse'
  /** 风格化：把输入图转成某种稿型（线稿 / 白膜 / 法线 …） */
  | 'stylize'
  /** 技能：给视觉模型的系统级指令 */
  | 'skill';

export interface PromptPreset {
  id: string;
  label: string;
  kind: PromptPresetKind;
  /** 归属功能（用于在对应页面里筛选出可用预设） */
  scope: string[];
  /** 出厂正向提示词 */
  prompt: string;
  /** 出厂负向提示词（ComfyUI 分支用） */
  negativePrompt?: string;
  /** 说明，显示在 UI 的 tooltip */
  description: string;
  builtin: true;
}

const NEG_COMMON =
  'lowres, blurry, jpeg artifacts, watermark, text, logo, extra limbs, deformed, oversaturated, cartoon';

export const PROMPT_PRESETS: readonly PromptPreset[] = [
  /* ---------------- 反推 ---------------- */
  {
    id: 'preset.reverse.generic',
    label: '通用内置反推提示词',
    kind: 'reverse',
    scope: ['cloud.wash', 'comfy.wash.portrait', 'comfy.wash.scene'],
    prompt:
      'Describe this image as a single dense prompt for an image generation model. Cover: subject, material, surface finish, color, lighting direction and quality, camera angle and focal length, background, composition, and overall photographic style. Output English only, comma-separated, no sentences, no preamble.',
    description: '对输入图做通用反推，产出可直接喂给生图模型的英文提示词。',
    builtin: true
  },
  {
    id: 'preset.reverse.scene',
    label: '内置反推场景',
    kind: 'reverse',
    scope: ['cloud.wash', 'comfy.wash.scene'],
    prompt:
      'Describe ONLY the environment of this image: location, background elements, props, surface the subject rests on, lighting setup, time of day, atmosphere and color grading. Ignore the main subject entirely. Output English only, comma-separated.',
    description: '只反推场景/环境，忽略主体——用于换背景而保留主体。',
    builtin: true
  },

  /* ---------------- 稿型 ---------------- */
  {
    id: 'preset.lineart.bw',
    label: '黑白线稿',
    kind: 'stylize',
    scope: ['cloud.wash', 'comfy.edit.texture'],
    prompt:
      'clean black and white line art, technical illustration, pure white background, uniform line weight, no shading, no gradients, no color',
    negativePrompt: NEG_COMMON + ', shading, gradient, color, photo, texture',
    description: '把输入图转成干净的黑白线稿（工业设计稿风格）。',
    builtin: true
  },
  {
    id: 'preset.flat.solid',
    label: '纯色稿',
    kind: 'stylize',
    scope: ['cloud.wash'],
    prompt:
      'flat color blocking, solid fill areas, no gradients, no texture, hard edges, minimal shading, vector-like poster style',
    negativePrompt: NEG_COMMON + ', gradient, texture, noise, photo realistic',
    description: '把输入图压成平涂纯色块，用于确定配色与体块关系。',
    builtin: true
  },
  {
    id: 'preset.whitemodel.plain',
    label: '白膜',
    kind: 'stylize',
    scope: ['cloud.wash', 'comfy.edit.texture'],
    prompt:
      'clay render, matte white material, uniform albedo, soft studio lighting, neutral grey background, no textures, no branding, ambient occlusion visible, 3d render',
    negativePrompt: NEG_COMMON + ', color, texture, pattern, printed graphics, reflection',
    description: '素白膜：去掉所有材质与贴图，只留形体与体积关系。',
    builtin: true
  },
  {
    id: 'preset.whitemodel.textured',
    label: '白膜 · 带材质',
    kind: 'stylize',
    scope: ['cloud.wash', 'comfy.edit.texture'],
    prompt:
      'white clay render with preserved surface microstructure, matte white base material, subtle roughness variation, panel gaps and seams visible, soft studio lighting, neutral background, 3d render',
    negativePrompt: NEG_COMMON + ', color, printed graphics, decals',
    description: '带材质白膜：保留表面微结构与分模线，只去掉颜色与贴图。',
    builtin: true
  },
  {
    id: 'preset.depth.bw',
    label: '黑白深度',
    kind: 'stylize',
    scope: ['cloud.wash', 'comfy.edit.texture'],
    prompt:
      'grayscale depth map, near surfaces white, far surfaces black, smooth monotonic depth gradient, no texture, no lighting, no color',
    negativePrompt: NEG_COMMON + ', color, texture, lighting, shadow detail',
    description: '输出黑白深度图（近白远黑），可作为 ControlNet 的深度控制图。',
    builtin: true
  },
  {
    id: 'preset.normal',
    label: '法线',
    kind: 'stylize',
    scope: ['cloud.wash', 'comfy.edit.texture'],
    prompt:
      'tangent-space normal map, purple-blue base, surface direction encoded in RGB, crisp geometric detail, no lighting, no albedo',
    negativePrompt: NEG_COMMON + ', albedo, lighting, shadow, photo',
    description: '输出切线空间法线图，可作为 ControlNet 的法线控制图。',
    builtin: true
  },

  /* ---------------- 技能 ---------------- */
  {
    id: 'preset.skills.productStructure',
    label: '反推产品结构提示词',
    kind: 'skill',
    scope: ['cloud.product.multiview'],
    prompt:
      'You are a senior industrial designer. You are given multiple views of ONE product. Describe it in detail for a photorealistic render prompt: overall form and proportions, part breakdown and how parts join, materials per part (metal / plastic / glass / fabric, and finish: matte, gloss, brushed, anodized, soft-touch), color per part, surface details (seams, chamfers, knurling, stitching, vents, buttons, logos placement), scale cues, and construction logic. Be specific and consistent across all views. Output English only, comma-separated keyword phrases, no sentences.',
    description: '内置 skills 提示词：根据多视角图，详细描述产品的材质、结构与设计。',
    builtin: true
  },
  {
    id: 'preset.skills.promptEnhance',
    label: '提示词优化',
    kind: 'skill',
    scope: ['cloud.t2i', 'cloud.i2i', 'cloud.wash', 'cloud.product.multiview', 'cloud.product.whitebg'],
    prompt:
      'Rewrite the user prompt into a high-quality image generation prompt. Keep every explicit user requirement. Add concrete detail for: subject, material, lighting, camera, composition, background and style. Do not invent a different subject. Output English only, comma-separated, under 120 words, no preamble.',
    description: '「是否优化提示词」开启时，用它把用户输入改写成高质量提示词。',
    builtin: true
  }
];

export function findPreset(id: string): PromptPreset | undefined {
  return PROMPT_PRESETS.find((p) => p.id === id);
}

export function presetsForFeature(featureId: string, kind?: PromptPresetKind): PromptPreset[] {
  return PROMPT_PRESETS.filter(
    (p) => p.scope.includes(featureId) && (kind === undefined || p.kind === kind)
  );
}
