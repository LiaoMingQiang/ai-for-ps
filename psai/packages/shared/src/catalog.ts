/**
 * 功能目录（Catalog）—— 整个产品的 5 级信息架构，以数据形式声明。
 *
 * 参考图谱的配色即层级：深蓝=一级导航 · 黄=二级 · 绿=三级 · 浅蓝=四级 · 粉=五级。
 *
 *   L1  ComfyUI Web │ 生成 │ 历史 │ 设置
 *   L2  （生成页内）comfyui │ 闭源模型
 *   L3  洗图 / 光影溶图 / 图像编辑 / 其他功能 / 自定义工作流
 *       洗图·去噪 / 文生图 / 图生图 / 高质量产品渲染
 *   L4  人像·场景 │ 固定视角·自适应视角 │ 质感加强 │ 放大·精修·视角转换 │ 产品多视角·精修白底图
 *   L5  通用放大·无损放大 │ 产品·人物·场景 │ 360°旋转
 *
 * 这份目录是唯一事实源：导航渲染、参数表单、工作流绑定矩阵、PRD 功能表、
 * 以及「功能是否遗漏」的测试，全部读它。
 */

import type { ParamSpec } from './paramspec.js';
import { defaultValues } from './paramspec.js';
import type { WritebackMode, InputSource } from './params.js';
import {
  MAX_REFERENCE_IMAGES,
  RESOLUTION_DEFAULT,
  RESOLUTION_MAX,
  RESOLUTION_MIN,
  RESOLUTION_STEP,
  SAMPLERS_RECOMMENDED,
  SCHEDULERS_RECOMMENDED,
  CAMERA_DEFAULT,
  UPSCALE_FACTORS
} from './params.js';

/* ============================ 类型 ============================ */

export type FeatureBranch = 'comfyui' | 'cloud';

/** 执行引擎：决定 Helper 用哪一族 Provider 适配器。 */
export type FeatureEngine =
  /** 走 ComfyUI 工作流（本地 / 远程 / 本地服务器 / RunningHub 云端） */
  | 'comfy-workflow'
  /** 走闭源模型的图像 API（文生图 / 图生图 / 图像编辑） */
  | 'cloud-image'
  /** 走闭源模型的视觉理解 API（反推提示词），产出文本而非图像 */
  | 'cloud-vision';

export interface FeatureSpec {
  /** 稳定 ID，跨版本不变；工作流绑定、历史记录、设置项都用它 */
  id: string;
  /** 导航路径（用于面包屑与深链） */
  path: string[];
  label: string;
  /** 一句话说明，显示在功能页标题下 */
  description: string;
  branch: FeatureBranch;
  engine: FeatureEngine;
  params: ParamSpec[];
  /** 出厂内置工作流 id（comfy-workflow 专用）。空 = 必须用户自行绑定 */
  defaultWorkflowId: string | null;
  /** 该内置工作流依赖的 ComfyUI 节点类型，用于依赖预检 */
  requiredNodeTypes: string[];
  writeback: { modes: WritebackMode[]; default: WritebackMode };
  /** 验收标准（同时被 PRD 与验收脚本引用） */
  acceptance: string[];
}

export interface CatalogNode {
  id: string;
  label: string;
  level: 1 | 2 | 3 | 4 | 5;
  /** 叶子节点携带可执行功能 */
  feature?: FeatureSpec;
  children?: CatalogNode[];
  /** 该节点下的条目由运行时动态填充（自定义工作流） */
  dynamic?: 'customWorkflows';
}

/* ============================ 参数工厂 ============================ */

const ALL_SOURCES: InputSource[] = ['layer', 'selection', 'mergedVisible', 'paste', 'upload'];

function pImage(
  opts: Partial<{ id: string; label: string; hint: string; required: boolean; sources: InputSource[]; defaultSource: InputSource }> = {}
): ParamSpec {
  return {
    kind: 'image',
    id: opts.id ?? 'image',
    label: opts.label ?? '图像输入',
    required: opts.required ?? true,
    sources: opts.sources ?? ALL_SOURCES,
    defaultSource: opts.defaultSource ?? 'layer',
    ...(opts.hint ? { hint: opts.hint } : {})
  };
}

function pImageList(opts: Partial<{ id: string; label: string; hint: string; min: number; max: number }> = {}): ParamSpec {
  return {
    kind: 'imageList',
    id: opts.id ?? 'images',
    label: opts.label ?? '图像输入',
    required: true,
    sources: ALL_SOURCES,
    min: opts.min ?? 1,
    max: opts.max ?? MAX_REFERENCE_IMAGES,
    hint: opts.hint ?? `拖拽、粘贴或点击上传图片，最多 ${opts.max ?? MAX_REFERENCE_IMAGES} 张`
  };
}

function pPrompt(opts: Partial<{ label: string; placeholder: string; required: boolean; enhanceable: boolean; defaultValue: string; rows: number }> = {}): ParamSpec {
  return {
    kind: 'prompt',
    id: 'prompt',
    label: opts.label ?? '提示词',
    placeholder: opts.placeholder ?? '请输入提示词...',
    required: opts.required ?? false,
    enhanceable: opts.enhanceable ?? true,
    defaultValue: opts.defaultValue ?? '',
    rows: opts.rows ?? 4
  };
}

function pNegativePrompt(defaultValue = 'lowres, blurry, watermark, text, deformed'): ParamSpec {
  return {
    kind: 'negativePrompt',
    id: 'negativePrompt',
    label: '负向提示词',
    placeholder: '不希望出现的内容...',
    defaultValue,
    rows: 2,
    advanced: true
  };
}

function pEnhance(): ParamSpec {
  return {
    kind: 'toggle',
    id: 'promptEnhance',
    label: '是否优化提示词',
    defaultValue: false,
    hint: '开启后先用视觉/语言模型把提示词改写成高质量版本，再送去生图'
  };
}

function pSeed(): ParamSpec {
  return {
    kind: 'seed',
    id: 'seed',
    label: '随机种子',
    defaultValue: { mode: 'autoRandom', value: 0 }
  };
}

function pDenoise(defaultValue = 0.25): ParamSpec {
  return {
    kind: 'slider',
    id: 'denoise',
    label: '重绘幅度',
    min: 0,
    max: 1,
    step: 0.01,
    defaultValue,
    precision: 2,
    hint: '越大越偏离原图；0.2~0.35 保结构，0.6 以上接近重画'
  };
}

function pStrength(label = '强度', defaultValue = 0.6): ParamSpec {
  return { kind: 'slider', id: 'strength', label, min: 0, max: 1, step: 0.01, defaultValue, precision: 2 };
}

function pRealism(defaultValue = 0.5): ParamSpec {
  return {
    kind: 'slider',
    id: 'realism',
    label: '真实感',
    min: 0,
    max: 1,
    step: 0.01,
    defaultValue,
    precision: 2,
    hint: '提高皮肤/材质的真实细节权重'
  };
}

function pLighting(defaultValue = 0.5): ParamSpec {
  return {
    kind: 'slider',
    id: 'lighting',
    label: '光影',
    min: 0,
    max: 1,
    step: 0.01,
    defaultValue,
    precision: 2,
    hint: '控制重打光的强度：0 保留原图光照，1 完全按参考重打'
  };
}

function pTexture(defaultValue = 0.55): ParamSpec {
  return {
    kind: 'slider',
    id: 'texture',
    label: '质感强度',
    min: 0,
    max: 1,
    step: 0.01,
    defaultValue,
    precision: 2,
    hint: '增强表面微结构与材质细节的程度'
  };
}

function pSampler(defaultValue = 'euler'): ParamSpec {
  return {
    kind: 'select',
    id: 'sampler',
    label: '采样器',
    options: SAMPLERS_RECOMMENDED.map((s) => ({ value: s, label: s })),
    defaultValue,
    dynamicSource: 'samplers',
    advanced: true
  };
}

function pScheduler(defaultValue = 'normal'): ParamSpec {
  return {
    kind: 'select',
    id: 'scheduler',
    label: '调度器',
    options: SCHEDULERS_RECOMMENDED.map((s) => ({ value: s, label: s })),
    defaultValue,
    dynamicSource: 'schedulers',
    advanced: true
  };
}

function pSteps(defaultValue = 20): ParamSpec {
  return { kind: 'slider', id: 'steps', label: '步数', min: 1, max: 100, step: 1, defaultValue, precision: 0, advanced: true };
}

function pCfg(defaultValue = 7): ParamSpec {
  return { kind: 'slider', id: 'cfg', label: 'CFG', min: 1, max: 20, step: 0.1, defaultValue, precision: 1, advanced: true };
}

function pResolution(defaultValue = RESOLUTION_DEFAULT): ParamSpec {
  return {
    kind: 'resolution',
    id: 'resolution',
    label: '分辨率',
    min: RESOLUTION_MIN,
    max: RESOLUTION_MAX,
    step: RESOLUTION_STEP,
    defaultValue
  };
}

function pAspect(defaultId = '1:1'): ParamSpec {
  return { kind: 'aspect', id: 'aspect', label: '生图比例', defaultValue: { id: defaultId } };
}

function pCamera(injectPrompt = true): ParamSpec {
  return {
    kind: 'camera',
    id: 'camera',
    label: '摄像机 3D 视窗调整',
    defaultValue: { ...CAMERA_DEFAULT },
    injectPrompt,
    hint: '拖拽立方体：左右改变水平角，上下改变俯仰角'
  };
}

function pModel(): ParamSpec {
  return { kind: 'model', id: 'model', label: '模型', defaultValue: '', hint: '留空使用该 Provider 的默认模型' };
}

function pUpscaleFactor(defaultValue = '2'): ParamSpec {
  return {
    kind: 'segmented',
    id: 'upscaleFactor',
    label: '放大倍数',
    options: UPSCALE_FACTORS.map((f) => ({ value: String(f), label: `${f}×` })),
    defaultValue
  };
}

function pUpscaleMethod(): ParamSpec {
  return {
    kind: 'select',
    id: 'upscaleMethod',
    label: '重采样方式',
    options: [
      { value: 'lanczos', label: 'Lanczos（最锐利）' },
      { value: 'bicubic', label: 'Bicubic（平衡）' },
      { value: 'bilinear', label: 'Bilinear（最柔和）' },
      { value: 'area', label: 'Area（缩小时最佳）' },
      { value: 'nearest-exact', label: 'Nearest（保留硬边）' }
    ],
    defaultValue: 'lanczos'
  };
}

/** 精修强度就是重绘幅度，只是把量程收窄到"只收拾不改画"的区间。 */
function pRetouchStrength(): ParamSpec {
  return {
    kind: 'slider',
    id: 'strength',
    label: '精修强度',
    min: 0,
    max: 1,
    step: 0.01,
    defaultValue: 0.5,
    precision: 2,
    hint: '映射到 0.05–0.5 的重绘幅度，保证只收拾细节而不会把画面重画'
  };
}

/** 视角改动幅度：越大越敢改机位，越小越贴近原图。 */
function pViewpointStrength(): ParamSpec {
  return {
    kind: 'slider',
    id: 'strength',
    label: '视角改动幅度',
    min: 0,
    max: 1,
    step: 0.01,
    defaultValue: 0.7,
    precision: 2,
    hint: '映射到 0.4–0.95 的重绘幅度；角度改得多时需要调高才推得动'
  };
}

const WB_IMAGE = {
  modes: ['smartObject', 'pixelLayer', 'inPlaceSelection', 'assetOnly'] as WritebackMode[],
  default: 'smartObject' as WritebackMode
};
const WB_NEW = {
  modes: ['smartObject', 'pixelLayer', 'assetOnly'] as WritebackMode[],
  default: 'smartObject' as WritebackMode
};

/* ============================ ComfyUI 分支：11 个固定功能 ============================ */

/*
 * 设计约束：每个滑杆都必须映射到工作流里某个真实的节点输入。
 * 参考图谱把「真实感 / 光影 / 强度」画成一排共享参数，但同一个滑杆在不同功能里
 * 未必都有对应的节点输入 —— 摆一个转不动的旋钮比不摆更糟。
 * 因此这里按功能只保留能真正接上的那几个，映射关系写在 docs/WORKFLOWS.md 里。
 */

const F_WASH_PORTRAIT: FeatureSpec = {
  id: 'comfy.wash.portrait',
  path: ['generate', 'comfyui', 'wash', 'portrait'],
  label: '人像',
  description: '人像洗图：在保持人物身份与构图的前提下，重绘皮肤、发丝与衣物质感。',
  branch: 'comfyui',
  engine: 'comfy-workflow',
  params: [
    pImage(),
    pPrompt({ placeholder: '补充希望强化的方向，可留空...' }),
    pNegativePrompt(),
    pSeed(),
    pRealism(0.6),
    pDenoise(0.28),
    pSampler('dpmpp_2m'),
    pScheduler('karras'),
    pSteps(24),
    pResolution()
  ],
  defaultWorkflowId: 'wf.wash.portrait',
  requiredNodeTypes: [
    'CLIPTextEncode',
    'CheckpointLoaderSimple',
    'ImageScale',
    'KSampler',
    'LoadImage',
    'SaveImage',
    'VAEDecode',
    'VAEEncode'
  ],
  writeback: WB_IMAGE,
  acceptance: [
    '输入当前图层 → 出图按输入比例缩放到分辨率参数，不被压成正方形',
    '重绘幅度 0.28 时人物五官与轮廓保持可辨识',
    '随机种子固定时两次提交结果一致'
  ]
};

const F_WASH_SCENE: FeatureSpec = {
  id: 'comfy.wash.scene',
  path: ['generate', 'comfyui', 'wash', 'scene'],
  label: '场景',
  description: '场景洗图：重绘环境、背景与氛围，保留主体位置与透视。',
  branch: 'comfyui',
  engine: 'comfy-workflow',
  params: [
    pImage(),
    pPrompt({ placeholder: '描述想要的场景，可留空...' }),
    pNegativePrompt(),
    pSeed(),
    pRealism(0.5),
    pDenoise(0.4),
    pSampler('dpmpp_2m'),
    pScheduler('karras'),
    pSteps(24),
    pResolution()
  ],
  defaultWorkflowId: 'wf.wash.scene',
  requiredNodeTypes: [
    'CLIPTextEncode',
    'CheckpointLoaderSimple',
    'ImageScale',
    'KSampler',
    'LoadImage',
    'SaveImage',
    'VAEDecode',
    'VAEEncode'
  ],
  writeback: WB_IMAGE,
  acceptance: ['主体位置与透视不变', '提示词为空时工作流仍能出图', '重绘幅度滑杆对结果有可见影响']
};

const F_RELIGHT_FIXED: FeatureSpec = {
  id: 'comfy.relight.fixed',
  path: ['generate', 'comfyui', 'relight', 'fixed'],
  label: '固定视角',
  description: '光影溶图（固定视角）：把主体按背景的光照重新打光并融合，机位保持不变。',
  branch: 'comfyui',
  engine: 'comfy-workflow',
  params: [
    pImage({ label: '主体图', hint: '需要被重新打光的主体' }),
    pImage({ id: 'background', label: '背景 / 参考光图', defaultSource: 'upload', hint: '提供目标光照氛围的场景图' }),
    pPrompt({ placeholder: '补充光照描述，例如 warm rim light from left...' }),
    pNegativePrompt(),
    pSeed(),
    pLighting(0.7),
    pDenoise(0.9),
    pSampler('dpmpp_2m'),
    pScheduler('karras'),
    pSteps(24),
    pCfg(2.5),
    pResolution(768)
  ],
  defaultWorkflowId: 'wf.relight.fixed',
  requiredNodeTypes: [
    'CLIPTextEncode',
    'CheckpointLoaderSimple',
    'ICLightConditioning',
    'ImageScale',
    'KSampler',
    'LoadAndApplyICLightUnet',
    'LoadImage',
    'SaveImage',
    'VAEDecode',
    'VAEEncode'
  ],
  writeback: WB_IMAGE,
  acceptance: ['主体轮廓与机位不变', '光照方向跟随背景图', '光影滑杆调低时更接近原图光照']
};

const F_RELIGHT_ADAPTIVE: FeatureSpec = {
  id: 'comfy.relight.adaptive',
  path: ['generate', 'comfyui', 'relight', 'adaptive'],
  label: '自适应视角',
  description: '光影溶图（自适应视角）：允许小幅调整主体机位以贴合背景透视，再统一打光融合。',
  branch: 'comfyui',
  engine: 'comfy-workflow',
  params: [
    pImage({ label: '主体图' }),
    pImage({ id: 'background', label: '背景 / 参考光图', defaultSource: 'upload' }),
    pCamera(true),
    pPrompt({ placeholder: '补充光照与融合描述...' }),
    pNegativePrompt(),
    pSeed(),
    pLighting(0.7),
    pDenoise(0.95),
    pSampler('dpmpp_2m'),
    pScheduler('karras'),
    pSteps(24),
    pCfg(2.5),
    pResolution(768)
  ],
  defaultWorkflowId: 'wf.relight.adaptive',
  requiredNodeTypes: [
    'CLIPTextEncode',
    'CheckpointLoaderSimple',
    'ICLightConditioning',
    'ImageScale',
    'KSampler',
    'LoadAndApplyICLightUnet',
    'LoadImage',
    'SaveImage',
    'VAEDecode',
    'VAEEncode'
  ],
  writeback: WB_IMAGE,
  acceptance: ['立方体角度会改变注入的机位提示词', '稳定度为 C 时 UI 给出风险提示', '融合后主体与背景无明显边缘']
};

const F_EDIT_TEXTURE: FeatureSpec = {
  id: 'comfy.edit.texture',
  path: ['generate', 'comfyui', 'edit', 'texture'],
  label: '质感加强',
  description: '图像编辑（质感加强）：增强表面微结构、材质纹理与细节层次，不改变形体。',
  branch: 'comfyui',
  engine: 'comfy-workflow',
  params: [
    pImage(),
    pPrompt({ placeholder: '指定要强化的材质，例如 brushed aluminium, matte leather...' }),
    pNegativePrompt(),
    pSeed(),
    pTexture(0.55),
    pDenoise(0.22),
    pSampler('dpmpp_2m'),
    pScheduler('karras'),
    pSteps(20),
    pResolution()
  ],
  defaultWorkflowId: 'wf.edit.texture',
  requiredNodeTypes: [
    'CLIPTextEncode',
    'CheckpointLoaderSimple',
    'ImageScale',
    'KSampler',
    'LoadImage',
    'SaveImage',
    'VAEDecode',
    'VAEEncode'
  ],
  writeback: WB_IMAGE,
  acceptance: ['形体与轮廓不变', '质感强度滑杆对细节量有可见影响', '不引入新的物体']
};

const F_UPSCALE_GENERAL: FeatureSpec = {
  id: 'comfy.misc.upscale.general',
  path: ['generate', 'comfyui', 'misc', 'upscale', 'general'],
  label: '通用放大',
  description: '通用放大：先按倍数重采样，再用扩散模型补充细节，适合需要"越放越清晰"的场景。',
  branch: 'comfyui',
  engine: 'comfy-workflow',
  params: [
    pImage(),
    pUpscaleFactor('2'),
    pPrompt({ placeholder: '可留空；填写可引导补充的细节方向...' }),
    pNegativePrompt(),
    pSeed(),
    pDenoise(0.25),
    pSampler('dpmpp_2m'),
    pScheduler('karras'),
    pSteps(16),
    pCfg(6)
  ],
  defaultWorkflowId: 'wf.upscale.general',
  requiredNodeTypes: [
    'CLIPTextEncode',
    'CheckpointLoaderSimple',
    'ImageScaleBy',
    'KSampler',
    'LoadImage',
    'SaveImage',
    'VAEDecode',
    'VAEEncode'
  ],
  writeback: WB_NEW,
  acceptance: ['输出尺寸 = 输入 × 放大倍数（±8px 对齐误差）', '细节量高于纯插值放大', '重绘幅度调到最低时几乎不产生新内容']
};

const F_UPSCALE_LOSSLESS: FeatureSpec = {
  id: 'comfy.misc.upscale.lossless',
  path: ['generate', 'comfyui', 'misc', 'upscale', 'lossless'],
  label: '无损放大',
  description: '无损放大：纯重采样，不经过扩散模型，绝不改变画面内容，同输入永远同输出。',
  branch: 'comfyui',
  engine: 'comfy-workflow',
  params: [pImage(), pUpscaleFactor('2'), pUpscaleMethod()],
  defaultWorkflowId: 'wf.upscale.lossless',
  requiredNodeTypes: ['ImageScaleBy', 'LoadImage', 'SaveImage'],
  writeback: WB_NEW,
  acceptance: [
    '输出内容与输入逐物体一致（无新增/丢失元素）',
    '输出尺寸 = 输入 × 放大倍数',
    '不含随机性：同输入两次结果完全一致'
  ]
};

function retouchFeature(id: string, label: string, subject: string, workflowId: string): FeatureSpec {
  return {
    id,
    path: ['generate', 'comfyui', 'misc', 'retouch', id.split('.').pop()!],
    label,
    description: `精修（${label}）：针对${subject}做局部提亮、瑕疵清理与细节收拾，保持原构图。`,
    branch: 'comfyui',
    engine: 'comfy-workflow',
    params: [
      pImage(),
      pPrompt({ placeholder: '可指定要重点收拾的部分...' }),
      pNegativePrompt(),
      pSeed(),
      pRetouchStrength(),
      pSampler('dpmpp_2m'),
      pScheduler('karras'),
      pSteps(22),
      pCfg(),
      pResolution()
    ],
    defaultWorkflowId: workflowId,
    requiredNodeTypes: [
    'CLIPTextEncode',
    'CheckpointLoaderSimple',
    'ImageScale',
    'KSampler',
    'LoadImage',
    'SaveImage',
    'VAEDecode',
    'VAEEncode'
  ],
    writeback: WB_IMAGE,
    acceptance: ['构图与主体位置不变', '精修强度滑杆有可见影响', '不产生多余肢体/物体']
  };
}

const F_RETOUCH_PRODUCT = retouchFeature('comfy.misc.retouch.product', '产品', '产品表面', 'wf.retouch.product');
const F_RETOUCH_PERSON = retouchFeature('comfy.misc.retouch.person', '人物', '人物皮肤与五官', 'wf.retouch.person');
const F_RETOUCH_SCENE = retouchFeature('comfy.misc.retouch.scene', '场景', '场景环境与道具', 'wf.retouch.scene');

const F_VIEWPOINT_ORBIT: FeatureSpec = {
  id: 'comfy.misc.viewpoint.orbit',
  path: ['generate', 'comfyui', 'misc', 'viewpoint', 'orbit'],
  label: '360° 旋转',
  description: '视角转换（360° 旋转）：由单张图推出其他机位的同一主体，用于补齐多视角素材。',
  branch: 'comfyui',
  engine: 'comfy-workflow',
  params: [
    pImage(),
    pCamera(true),
    pPrompt({ placeholder: '补充主体描述可提高一致性...' }),
    pNegativePrompt(),
    pSeed(),
    pViewpointStrength(),
    pSampler('dpmpp_2m'),
    pScheduler('karras'),
    pSteps(26),
    pCfg(),
    pResolution(768)
  ],
  defaultWorkflowId: 'wf.viewpoint.orbit',
  requiredNodeTypes: [
    'CLIPTextEncode',
    'CheckpointLoaderSimple',
    'ImageScale',
    'KSampler',
    'LoadImage',
    'SaveImage',
    'VAEDecode',
    'VAEEncode'
  ],
  writeback: WB_NEW,
  acceptance: [
    '水平角 0 / 垂直角 0 时输出接近输入',
    '改变水平角会改变注入工作流的机位提示词',
    '稳定度徽章随角度变化（0/0 显示 S+ 最稳定）'
  ]
};

const F_CUSTOM_WORKFLOW: FeatureSpec = {
  id: 'comfy.custom',
  path: ['generate', 'comfyui', 'custom'],
  label: '自定义工作流',
  description: '运行用户导入的 ComfyUI 工作流，参数由导入时扫描出的可绑定字段动态生成。',
  branch: 'comfyui',
  engine: 'comfy-workflow',
  params: [pImage({ required: false })],
  defaultWorkflowId: null,
  requiredNodeTypes: [],
  writeback: WB_IMAGE,
  acceptance: [
    '导入的工作流出现在列表中',
    '扫描出的 Prompt/Seed/Steps/CFG/Denoise/Width/Height/Image 字段可在 UI 中调节',
    '未绑定输出节点的工作流导入时明确报错'
  ]
};

/* ============================ 闭源模型分支：5 个功能 ============================ */

const F_CLOUD_WASH: FeatureSpec = {
  id: 'cloud.wash',
  path: ['generate', 'cloud', 'wash'],
  label: '洗图 / 去噪',
  description: '用闭源模型重绘输入图；可先用内置反推提示词把原图描述出来，再按稿型改写。',
  branch: 'cloud',
  engine: 'cloud-image',
  params: [
    pImage(),
    pModel(),
    {
      kind: 'presetPrompt',
      id: 'reversePrompt',
      label: '通用内置反推提示词',
      presetKind: 'reverse',
      defaultPresetId: 'preset.reverse.generic',
      toggleable: true,
      defaultEnabled: true,
      hint: '开启后先反推出原图描述，再拼到你的提示词前面'
    },
    {
      kind: 'presetPrompt',
      id: 'stylePreset',
      label: '稿型预设',
      presetKind: 'stylize',
      defaultPresetId: '',
      toggleable: true,
      defaultEnabled: false,
      hint: '黑白线稿 / 纯色稿 / 白膜 / 黑白深度 / 法线'
    },
    pPrompt({ placeholder: '请输入提示词...' }),
    pEnhance(),
    pSeed(),
    pDenoise(0.25),
    pAspect('1:1'),
    pResolution(1280)
  ],
  defaultWorkflowId: null,
  requiredNodeTypes: [],
  writeback: WB_IMAGE,
  acceptance: [
    '反推开关关闭时不产生额外的视觉模型调用',
    '选中稿型预设后提示词面板显示最终拼接结果',
    '未配置任何闭源 Provider 时按钮禁用并显示原因'
  ]
};

const F_CLOUD_T2I: FeatureSpec = {
  id: 'cloud.t2i',
  path: ['generate', 'cloud', 't2i'],
  label: '文生图',
  description: '纯文本生成图像。可选先做提示词优化再生成。',
  branch: 'cloud',
  engine: 'cloud-image',
  params: [
    pModel(),
    pPrompt({ required: true, placeholder: '描述你想要的画面...', rows: 5 }),
    pEnhance(),
    pNegativePrompt(''),
    pSeed(),
    pAspect('1:1'),
    pResolution(1280)
  ],
  defaultWorkflowId: null,
  requiredNodeTypes: [],
  writeback: WB_NEW,
  acceptance: ['提示词为空时提交被拦截并提示', '优化开关开启时可看到优化后的提示词', '出图比例与所选比例一致']
};

const F_CLOUD_I2I: FeatureSpec = {
  id: 'cloud.i2i',
  path: ['generate', 'cloud', 'i2i'],
  label: '图生图',
  description: `以最多 ${MAX_REFERENCE_IMAGES} 张参考图 + 提示词生成新图。`,
  branch: 'cloud',
  engine: 'cloud-image',
  params: [
    pImageList({ label: '上传图', max: MAX_REFERENCE_IMAGES }),
    pModel(),
    pPrompt({ required: true, placeholder: '描述希望的改动...' }),
    pEnhance(),
    pNegativePrompt(''),
    pSeed(),
    pDenoise(0.5),
    pAspect('1:1'),
    pResolution(1280)
  ],
  defaultWorkflowId: null,
  requiredNodeTypes: [],
  writeback: WB_IMAGE,
  acceptance: [
    `上传第 ${MAX_REFERENCE_IMAGES + 1} 张时被拒绝并提示上限`,
    '不支持多图的模型会明确报 PROVIDER_UNSUPPORTED，不静默丢图',
    '每张参考图可单独删除并重排'
  ]
};

const F_CLOUD_PRODUCT_MULTIVIEW: FeatureSpec = {
  id: 'cloud.product.multiview',
  path: ['generate', 'cloud', 'product', 'multiview'],
  label: '产品多视角',
  description:
    '上传产品多视角照片 → 用内置 skills 提示词反推出产品结构与材质描述 → 调整摄像机 → 渲染白底图或场景图。',
  branch: 'cloud',
  engine: 'cloud-image',
  params: [
    pImageList({ id: 'images', label: '上传产品多视角', min: 1, max: MAX_REFERENCE_IMAGES }),
    pModel(),
    {
      kind: 'presetPrompt',
      id: 'structurePrompt',
      label: '反推产品结构提示词',
      presetKind: 'skill',
      defaultPresetId: 'preset.skills.productStructure',
      toggleable: true,
      defaultEnabled: true,
      hint: '根据多视角，详细描述产品材质结构设计等'
    },
    pCamera(true),
    {
      kind: 'segmented',
      id: 'outputType',
      label: '输出类型',
      options: [
        { value: 'whiteBackground', label: '白底图' },
        { value: 'scene', label: '场景图' }
      ],
      defaultValue: 'whiteBackground'
    },
    pPrompt({ label: '场景描述', placeholder: '输出场景图时描述环境...', rows: 3 }),
    pEnhance(),
    pSeed(),
    pAspect('1:1'),
    pResolution(1280)
  ],
  defaultWorkflowId: null,
  requiredNodeTypes: [],
  writeback: WB_NEW,
  acceptance: [
    '反推结果显示在可编辑的文本框里，用户可改后再生成',
    '输出类型为白底图时背景为纯白',
    '摄像机角度改变会改变输出机位'
  ]
};

const F_CLOUD_PRODUCT_WHITEBG: FeatureSpec = {
  id: 'cloud.product.whitebg',
  path: ['generate', 'cloud', 'product', 'whitebg'],
  label: '精修白底图',
  description: '把一张产品照精修成电商可用的标准白底图：去背、修瑕、统一打光。',
  branch: 'cloud',
  engine: 'cloud-image',
  params: [
    pImage({ label: '上传图' }),
    pModel(),
    pPrompt({ placeholder: '可补充要保留/去掉的细节...', rows: 3 }),
    pEnhance(),
    pSeed(),
    pAspect('1:1'),
    pResolution(1280)
  ],
  defaultWorkflowId: null,
  requiredNodeTypes: [],
  writeback: WB_NEW,
  acceptance: ['输出背景为纯白（角落像素 > 250）', '产品主体完整不缺角', '输出比例与所选比例一致']
};

/* ============================ 目录树 ============================ */

export const CATALOG: readonly CatalogNode[] = [
  {
    id: 'comfyWeb',
    label: 'ComfyUI',
    level: 1
  },
  {
    id: 'generate',
    label: '生成',
    level: 1,
    children: [
      {
        id: 'generate.comfyui',
        label: 'comfyui',
        level: 2,
        children: [
          {
            id: 'generate.comfyui.wash',
            label: '洗图',
            level: 3,
            children: [
              { id: F_WASH_PORTRAIT.id, label: F_WASH_PORTRAIT.label, level: 4, feature: F_WASH_PORTRAIT },
              { id: F_WASH_SCENE.id, label: F_WASH_SCENE.label, level: 4, feature: F_WASH_SCENE }
            ]
          },
          {
            id: 'generate.comfyui.relight',
            label: '光影溶图',
            level: 3,
            children: [
              { id: F_RELIGHT_FIXED.id, label: F_RELIGHT_FIXED.label, level: 4, feature: F_RELIGHT_FIXED },
              { id: F_RELIGHT_ADAPTIVE.id, label: F_RELIGHT_ADAPTIVE.label, level: 4, feature: F_RELIGHT_ADAPTIVE }
            ]
          },
          {
            id: 'generate.comfyui.edit',
            label: '图像编辑',
            level: 3,
            children: [{ id: F_EDIT_TEXTURE.id, label: F_EDIT_TEXTURE.label, level: 4, feature: F_EDIT_TEXTURE }]
          },
          {
            id: 'generate.comfyui.misc',
            label: '其他功能',
            level: 3,
            children: [
              {
                id: 'generate.comfyui.misc.upscale',
                label: '放大',
                level: 4,
                children: [
                  { id: F_UPSCALE_GENERAL.id, label: F_UPSCALE_GENERAL.label, level: 5, feature: F_UPSCALE_GENERAL },
                  { id: F_UPSCALE_LOSSLESS.id, label: F_UPSCALE_LOSSLESS.label, level: 5, feature: F_UPSCALE_LOSSLESS }
                ]
              },
              {
                id: 'generate.comfyui.misc.retouch',
                label: '精修',
                level: 4,
                children: [
                  { id: F_RETOUCH_PRODUCT.id, label: F_RETOUCH_PRODUCT.label, level: 5, feature: F_RETOUCH_PRODUCT },
                  { id: F_RETOUCH_PERSON.id, label: F_RETOUCH_PERSON.label, level: 5, feature: F_RETOUCH_PERSON },
                  { id: F_RETOUCH_SCENE.id, label: F_RETOUCH_SCENE.label, level: 5, feature: F_RETOUCH_SCENE }
                ]
              },
              {
                id: 'generate.comfyui.misc.viewpoint',
                label: '视角转换',
                level: 4,
                children: [
                  { id: F_VIEWPOINT_ORBIT.id, label: F_VIEWPOINT_ORBIT.label, level: 5, feature: F_VIEWPOINT_ORBIT }
                ]
              }
            ]
          },
          {
            id: 'generate.comfyui.custom',
            label: '自定义工作流',
            level: 3,
            dynamic: 'customWorkflows',
            feature: F_CUSTOM_WORKFLOW
          }
        ]
      },
      {
        id: 'generate.cloud',
        label: '闭源模型',
        level: 2,
        children: [
          { id: F_CLOUD_WASH.id, label: F_CLOUD_WASH.label, level: 3, feature: F_CLOUD_WASH },
          { id: F_CLOUD_T2I.id, label: F_CLOUD_T2I.label, level: 3, feature: F_CLOUD_T2I },
          { id: F_CLOUD_I2I.id, label: F_CLOUD_I2I.label, level: 3, feature: F_CLOUD_I2I },
          {
            id: 'generate.cloud.product',
            label: '高质量产品渲染',
            level: 3,
            children: [
              {
                id: F_CLOUD_PRODUCT_MULTIVIEW.id,
                label: F_CLOUD_PRODUCT_MULTIVIEW.label,
                level: 4,
                feature: F_CLOUD_PRODUCT_MULTIVIEW
              },
              {
                id: F_CLOUD_PRODUCT_WHITEBG.id,
                label: F_CLOUD_PRODUCT_WHITEBG.label,
                level: 4,
                feature: F_CLOUD_PRODUCT_WHITEBG
              }
            ]
          }
        ]
      }
    ]
  },
  { id: 'history', label: '历史', level: 1 },
  { id: 'settings', label: '设置', level: 1 }
];

/* ============================ 查询工具 ============================ */

export function walkCatalog(nodes: readonly CatalogNode[] = CATALOG): CatalogNode[] {
  const out: CatalogNode[] = [];
  const visit = (n: CatalogNode): void => {
    out.push(n);
    n.children?.forEach(visit);
  };
  nodes.forEach(visit);
  return out;
}

/** 所有可执行功能（含自定义工作流这个模板功能）。 */
export function allFeatures(): FeatureSpec[] {
  return walkCatalog()
    .map((n) => n.feature)
    .filter((f): f is FeatureSpec => !!f);
}

/** 固定功能：需要在「设置 → 固定功能」里绑定工作流的那些（不含自定义）。 */
export function fixedComfyFeatures(): FeatureSpec[] {
  return allFeatures().filter((f) => f.engine === 'comfy-workflow' && f.id !== 'comfy.custom');
}

export function findFeature(id: string): FeatureSpec | undefined {
  return allFeatures().find((f) => f.id === id);
}

export function findNode(id: string): CatalogNode | undefined {
  return walkCatalog().find((n) => n.id === id);
}

/** 面包屑：['生成', 'comfyui', '洗图', '人像'] */
export function breadcrumb(featureId: string): string[] {
  const trail: string[] = [];
  const hunt = (nodes: readonly CatalogNode[], acc: string[]): boolean => {
    for (const n of nodes) {
      const next = [...acc, n.label];
      if (n.feature?.id === featureId) {
        trail.push(...next);
        return true;
      }
      if (n.children && hunt(n.children, next)) return true;
    }
    return false;
  };
  hunt(CATALOG, []);
  return trail;
}

/** 该功能的出厂默认参数取值。 */
export function featureDefaults(featureId: string): Record<string, unknown> {
  const f = findFeature(featureId);
  return f ? defaultValues(f.params) : {};
}
