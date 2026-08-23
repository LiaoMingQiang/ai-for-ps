/**
 * Provider 注册表。
 *
 * 来源：参考图谱「设置 → 本地 / 云端 / 推荐平台」。
 * 出厂内置 8 个 Provider；未配置的一律显示"未配置 + 原因"并禁用，绝不 mock 成功。
 */

export type ProviderKind =
  /** ComfyUI HTTP API（本地 / 局域网 / 远程服务器） */
  | 'comfyui'
  /** RunningHub 云端 ComfyUI 任务 API */
  | 'runninghub'
  /** OpenAI 兼容协议（火山方舟 / 阿里百炼 / 魔搭 / comfly / 自定义） */
  | 'openai-compatible'
  /** Google Gemini generateContent */
  | 'gemini';

export type ProviderCapability =
  | 'textToImage'
  | 'imageToImage'
  | 'multiImageInput'
  | 'imageEdit'
  | 'vision'
  | 'workflow'
  | 'cancel'
  | 'progress'
  | 'listModels';

/** ComfyUI 的三种接法（参考图谱：本地 / 远程 / 本地服务器）。 */
export const COMFY_MODES = ['local', 'remote', 'localServer'] as const;
export type ComfyMode = (typeof COMFY_MODES)[number];

export const COMFY_MODE_LABELS: Record<ComfyMode, string> = {
  local: '本地',
  remote: '远程',
  localServer: '本地服务器'
};

export const COMFY_MODE_HINTS: Record<ComfyMode, string> = {
  local: '本机运行的 ComfyUI，默认 127.0.0.1:8188',
  remote: '公网或内网的 ComfyUI 服务，需要填写完整地址',
  localServer: '由 Helper 托管启动的本机 ComfyUI 进程'
};

export interface CredentialField {
  key: string;
  label: string;
  /** 密文字段：仅存 Helper（Windows DPAPI），UI 只显示掩码 */
  secret: boolean;
  placeholder: string;
  required: boolean;
}

export interface ProviderDescriptor {
  id: string;
  label: string;
  kind: ProviderKind;
  /** 「推荐平台」里展示的申请/控制台地址 */
  consoleUrl: string | null;
  /** 出厂默认服务地址 */
  defaultBaseUrl: string;
  /** 用户是否可以改地址 */
  baseUrlEditable: boolean;
  capabilities: ProviderCapability[];
  credentials: CredentialField[];
  /** 该 Provider 的默认模型；ComfyUI 类为空 */
  defaultModel: string | null;
  /** UI 上的一句话说明 */
  description: string;
  /** 出厂是否列在「推荐平台」区 */
  recommended: boolean;
  /** 取消语义：某些云 Provider 官方没有取消接口，必须如实告知 */
  cancelSupport: 'full' | 'queuedOnly' | 'none';
}

export const PROVIDERS: readonly ProviderDescriptor[] = [
  {
    id: 'comfyui',
    label: 'ComfyUI',
    kind: 'comfyui',
    consoleUrl: null,
    defaultBaseUrl: 'http://127.0.0.1:8188',
    baseUrlEditable: true,
    capabilities: ['workflow', 'textToImage', 'imageToImage', 'multiImageInput', 'imageEdit', 'cancel', 'progress', 'listModels'],
    credentials: [],
    defaultModel: null,
    description: '本地 / 远程 ComfyUI。所有 ComfyUI 分支的固定功能与自定义工作流都走它。',
    recommended: false,
    cancelSupport: 'full'
  },
  {
    id: 'runninghub',
    label: 'RunningHub 云端',
    kind: 'runninghub',
    consoleUrl: 'https://www.runninghub.cn',
    defaultBaseUrl: 'https://www.runninghub.cn',
    baseUrlEditable: true,
    capabilities: ['workflow', 'textToImage', 'imageToImage', 'multiImageInput', 'progress', 'listModels'],
    credentials: [
      { key: 'apiKey', label: 'API Key', secret: true, placeholder: 'RunningHub API Key', required: true },
      { key: 'workflowId', label: '工作流 ID', secret: false, placeholder: '云端工作流 ID', required: false }
    ],
    defaultModel: null,
    description: '把 ComfyUI 工作流放到云端跑，不占用本机显卡。',
    recommended: true,
    cancelSupport: 'none'
  },
  {
    id: 'comfly',
    label: 'Comfly',
    kind: 'openai-compatible',
    consoleUrl: 'https://ai.comfly.org/token',
    defaultBaseUrl: 'https://ai.comfly.org/v1',
    baseUrlEditable: true,
    capabilities: ['textToImage', 'imageToImage', 'multiImageInput', 'imageEdit', 'vision', 'listModels'],
    credentials: [{ key: 'apiKey', label: 'API Key', secret: true, placeholder: 'sk-...', required: true }],
    defaultModel: '',
    description: '聚合多家闭源模型的 OpenAI 兼容网关。',
    recommended: true,
    cancelSupport: 'none'
  },
  {
    id: 'modelscope',
    label: '魔搭 ModelScope',
    kind: 'openai-compatible',
    consoleUrl: 'https://www.modelscope.cn',
    defaultBaseUrl: 'https://api-inference.modelscope.cn/v1',
    baseUrlEditable: true,
    capabilities: ['textToImage', 'imageToImage', 'vision', 'listModels'],
    credentials: [{ key: 'apiKey', label: 'API Token', secret: true, placeholder: 'ms-...', required: true }],
    defaultModel: '',
    description: '阿里魔搭社区的推理 API。',
    recommended: true,
    cancelSupport: 'none'
  },
  {
    id: 'volcengine',
    label: '火山引擎 · 方舟',
    kind: 'openai-compatible',
    consoleUrl: 'https://www.volcengine.com/',
    defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    baseUrlEditable: true,
    capabilities: ['textToImage', 'imageToImage', 'multiImageInput', 'imageEdit', 'vision', 'listModels'],
    credentials: [{ key: 'apiKey', label: 'API Key', secret: true, placeholder: '火山方舟 API Key', required: true }],
    defaultModel: '',
    description: '字节火山方舟：豆包系列文生图 / 图生图 / 视觉理解。',
    recommended: true,
    cancelSupport: 'none'
  },
  {
    id: 'bailian',
    label: '阿里百炼',
    kind: 'openai-compatible',
    consoleUrl: 'https://bailian.console.aliyun.com',
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    baseUrlEditable: true,
    capabilities: ['textToImage', 'imageToImage', 'vision', 'listModels'],
    credentials: [{ key: 'apiKey', label: 'API Key', secret: true, placeholder: 'sk-...', required: true }],
    defaultModel: '',
    description: '阿里云百炼：通义万相 / 通义千问 VL。',
    recommended: true,
    cancelSupport: 'none'
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    kind: 'gemini',
    consoleUrl: 'https://aistudio.google.com/apikey',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    baseUrlEditable: true,
    capabilities: ['textToImage', 'imageToImage', 'multiImageInput', 'imageEdit', 'vision', 'listModels'],
    credentials: [{ key: 'apiKey', label: 'API Key', secret: true, placeholder: 'AIza...', required: true }],
    defaultModel: '',
    description: 'Gemini 的图像生成与视觉理解。',
    recommended: false,
    cancelSupport: 'none'
  },
  {
    id: 'custom',
    label: '自定义网站',
    kind: 'openai-compatible',
    consoleUrl: null,
    defaultBaseUrl: '',
    baseUrlEditable: true,
    capabilities: ['textToImage', 'imageToImage', 'vision', 'listModels'],
    credentials: [{ key: 'apiKey', label: 'API Key', secret: true, placeholder: 'sk-...', required: false }],
    defaultModel: '',
    description: '任意 OpenAI 兼容服务：自己填写地址与 Key。',
    recommended: false,
    cancelSupport: 'none'
  }
];

export function findProvider(id: string): ProviderDescriptor | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

export function recommendedProviders(): ProviderDescriptor[] {
  return PROVIDERS.filter((p) => p.recommended);
}

/** 能承接闭源模型分支（cloud-image / cloud-vision）的 Provider。 */
export function cloudImageProviders(): ProviderDescriptor[] {
  return PROVIDERS.filter((p) => p.kind === 'openai-compatible' || p.kind === 'gemini');
}

/* ============================ 运行时状态 ============================ */

export interface ProviderRuntimeStatus {
  id: string;
  configured: boolean;
  enabled: boolean;
  online: boolean;
  baseUrl: string;
  /** 未配置 / 离线的具体原因，UI 直接展示，不允许留空 */
  reason: string | null;
  latencyMs: number | null;
  /** 最近一次「验证」的时间与结果 */
  lastCheckedAt: number | null;
  models: string[];
  capabilities: ProviderCapability[];
}

/**
 * 判断一个模型 id 看起来是不是「能用 /images/generations 出图」的模型。
 *
 * 为什么需要这个：聚合网关的 /models 会把平台上**所有**模型都列出来 ——
 * 实测 Comfly 返回 858 个，里面绝大多数是对话、音频、视频、重排模型。
 * 生成页的模型下拉直接把这 858 个全塞进去，用户没有任何依据去挑，
 * 挑中一个不支持这个接口的就是一次失败：
 *   gemini-3-pro-image-2k → 503「所有分组对于模型 … 不支持此 API 路径」
 * 这不是用户的错，是我们把一份没法用的清单摆在了他面前。
 *
 * 这里只做**启发式**过滤，不假装准确：
 *  - 命中的不保证一定能用（该账号可能没开通某个模型的渠道）
 *  - 没命中的也未必真不行（新模型的命名我们可能还不认识）
 * 所以界面上要如实说明「只列出了 N 个 / 共 M 个」，
 * 真要用冷门模型，去「设置 → 推荐平台」里填完整名字，那里给的是全量列表。
 */
/**
 * 生图模型的正面特征。
 *
 * 第一条 /image/ 是主力：这一族的命名几乎都把 image 写进名字里 ——
 * gpt-image-*、gemini-3-pro-image-*、grok-4.2-image、kling-image-*、
 * sora_image、z-image-turbo、qwen-image-edit… 实测 858 个模型里
 * 有 56 个带 image，除 Midjourney 那几个外全都能走 /images/generations。
 *
 * 后面几条补的是**名字里没有 image 的**生图模型。
 * 一开始我只写了前缀白名单，结果 gemini / grok / kling / sora 整族被误杀 ——
 * 用户在下拉里根本看不到能用的模型，比不过滤还糟。
 */
const IMAGE_MODEL_PATTERNS: RegExp[] = [
  /image/i,
  /^flux/i,
  /^dall-e/i,
  /seedream/i,
  /nano-banana/i,
  /^imagen/i,
  /^wanx/i,
  /^stable-diffusion/i,
  /^sd3/i,
  /^irag/i,
  /^kolors/i,
  /^cogview/i,
  /^recraft/i,
  /^ideogram/i,
  /^playground-v/i
];

/**
 * 明确排除的：名字里有 image，但走的不是 /images/generations 这条路。
 *
 * Midjourney 那一族（mj_fast_* / mj_relax_*）是代理任务接口，
 * 提交完要另外轮询，协议和同步生图完全不同；
 * kolors-virtual-try-on 是虚拟试穿专用接口，收的参数也不一样。
 * 摆在生图下拉里只会让人选中、点生成、然后失败。
 */
const NOT_IMAGE_API: RegExp[] = [
  /^mj_/i,
  /^midjourney/i,
  /virtual-try-on/i,
  // 视频模型。wanx 系列里 i2v / t2v / kf2v / vace 全是出视频的，
  // 被 /^wanx/ 一并捞了进来 —— 出的不是图，写不回 Photoshop 图层。
  /-(i2v|t2v|v2v|kf2v)/i,
  /-(i2v|t2v|v2v|kf2v)-/i,
  /vace/i
];

export function isLikelyImageModel(id: string): boolean {
  const s = id.trim();
  if (NOT_IMAGE_API.some((re) => re.test(s))) return false;
  return IMAGE_MODEL_PATTERNS.some((re) => re.test(s));
}


/**
 * 从全量模型列表里挑出适合生图的。
 * 一个都挑不出来时返回原列表 —— 宁可让用户面对一份长清单，
 * 也不能把下拉变成空的，那样连手动试的机会都没有了。
 */
export function filterImageModels(models: readonly string[]): string[] {
  const hit = models.filter(isLikelyImageModel);
  return hit.length > 0 ? hit : [...models];
}
