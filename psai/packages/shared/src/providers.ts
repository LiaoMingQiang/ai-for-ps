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


/* ============================ 生图模型筛选 ============================ */

/**
 * 出图要走哪条协议。
 *
 * 同一个聚合网关上，三族模型走三条**完全不同**的路。真机实测（Comfly 真账号）：
 *   images  POST /v1/images/generations          gpt-image-2      200 ·  41s · 回 url
 *   chat    POST /v1/chat/completions            gemini-3-pro-image 200 · 27s · 回 markdown 图链接
 *   mj      POST /mj/submit/imagine + 轮询 fetch  midjourney       SUCCESS · 54s
 *
 * 走错路不是"慢一点"，是必然失败，而且错得看不出原因：
 *   gemini-3-pro-image 打 /images/generations → 503「不支持此 API 路径 [/v1/images/generations]」
 *   midjourney         打 /images/generations → 400「The model `midjourney` does not exist」
 * 用户看到的都是「没有任何结果」。所以模型和协议必须一起定，不能只给一份模型名单。
 */
export type ImageRoute = 'images' | 'chat' | 'mj';

export interface ApprovedImageFamily {
  /** 家族标识，仅用于日志与测试 */
  id: string;
  /** UI 上的族名 */
  label: string;
  match: RegExp;
  route: ImageRoute;
  /** 为什么是这条路 —— 全部来自真机实测，不是猜的 */
  note: string;
}

/**
 * 出厂认可的生图模型。
 *
 * 为什么要收窄到这么小的一份名单：网关的 /models 是**平台全量目录**，
 * 实测 Comfly 一次回 858 个，其中能走通生图的连一成都不到。
 * 之前那版按名字启发式筛出 96 个，看着少了很多，可里面依然混着
 * 打哪条路都不通的（gemini-3-pro-image 在 /images/generations 上 503）。
 * 下拉里每多一个用不了的选项，就多一次「点了没反应」。
 *
 * 所以默认只上这四族 —— 每一族都在真机上跑出过图，协议也钉死了。
 * 想用别的：设置页「拉取全部模型」，那里给的是完整目录，愿意自己试就自己试。
 */
export const APPROVED_IMAGE_FAMILIES: readonly ApprovedImageFamily[] = [
  {
    id: 'gpt-image',
    label: 'GPT Image',
    // gpt-image-2 / gpt-image-2-all，以及将来的 gpt-image-3+。
    // 不含 gpt-image-1 系列：认可名单从 2 代起。
    match: /^gpt-image-(?:[2-9]|\d{2,})\b/i,
    route: 'images',
    note: '真机 200 · 41s · 回图片 url；注意这一族不认 response_format 参数'
  },
  {
    id: 'nano-banana-pro',
    label: 'Nano-Banana Pro',
    // nano-banana-pro / -2k / -4k。nano-banana-2 与 nano-banana-hd 不是 Pro，不在名单里。
    match: /^nano-banana-pro\b/i,
    route: 'images',
    note: '真机 200 · 33s · 回 b64_json'
  },
  {
    id: 'gemini-image',
    label: 'Gemini 图像',
    // gemini-3-pro-image[-2k|-4k|-preview]、gemini-3.1-flash-image[-512px]、
    // gemini-2.5-flash-image、gemini-2.0-flash-exp-image-generation …
    // 名字里没有 image 的 gemini 全是纯文本模型，不会被这条捞进来。
    match: /^gemini-.*image/i,
    route: 'chat',
    note: '真机 200 · 27s；只能走 chat/completions，图以 markdown 链接回来'
  },
  {
    id: 'midjourney',
    label: 'Midjourney',
    // 只认这一个 id。mj_fast_* / mj_relax_* 是计费 SKU 与动作端点
    // （upscale / pan / zoom / blend / describe 都要先有一个已存在的任务），
    // 摆进"选个模型然后文生图"的下拉里没有一个是能直接用的。
    match: /^midjourney$/i,
    route: 'mj',
    note: '真机 SUCCESS · 54s；异步代理接口，提交拿 taskId 再轮询'
  }
];

/** 这个模型 id 该走哪条协议；不在认可名单里返回 null。 */
export function imageRouteFor(id: string): ImageRoute | null {
  const s = id.trim();
  return APPROVED_IMAGE_FAMILIES.find((f) => f.match.test(s))?.route ?? null;
}

/** 这个模型属于认可名单里的哪一族；不在名单里返回 null。 */
export function approvedFamilyOf(id: string): ApprovedImageFamily | null {
  const s = id.trim();
  return APPROVED_IMAGE_FAMILIES.find((f) => f.match.test(s)) ?? null;
}

export function isApprovedImageModel(id: string): boolean {
  return approvedFamilyOf(id) !== null;
}

/* ---------------- Midjourney 版本下限 ---------------- */

/**
 * 认可名单要的是「Midjourney v7 及以上」，可版本号根本不在模型 id 里 ——
 * MJ 的版本是提示词里的 `--v 7` / `--version 7` 参数，同一个 `midjourney`
 * 既能出 v6 也能出 v7。所以版本只能在提交前从提示词上判。
 */
export const MJ_MIN_VERSION = 7;

/** 从 MJ 提示词里读出显式版本号；没写返回 null。 */
export function midjourneyVersionOf(prompt: string): number | null {
  const m = /--(?:v|version)\s+(\d+(?:\.\d+)?)/i.exec(prompt);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * 把 MJ 提示词补齐到认可的版本。
 *
 * 没写版本就补 `--v 7`：不补的话用的是账号默认版本，可能是 v6 甚至更早，
 * 那就跟"认可名单里是 v7+"对不上，而用户完全看不出来自己拿到的是哪一版。
 * 显式写了低于 7 的版本则如实拒绝 —— 静默把它改成 7 是替用户改需求，
 * 静默照发又违反名单，两个都不能干，只能说清楚。
 */
export function normalizeMidjourneyPrompt(prompt: string): { prompt: string; error: string | null } {
  const v = midjourneyVersionOf(prompt);
  if (v === null) return { prompt: `${prompt.trim()} --v ${MJ_MIN_VERSION}`, error: null };
  if (v < MJ_MIN_VERSION) {
    return {
      prompt: prompt.trim(),
      error: `认可的 Midjourney 版本是 v${MJ_MIN_VERSION} 及以上，提示词里写的是 --v ${v}。改掉它，或删掉这个参数由我们补 --v ${MJ_MIN_VERSION}。`
    };
  }
  return { prompt: prompt.trim(), error: null };
}

/* ---------------- 更宽的一层：像生图的模型 ---------------- */

/**
 * 生图模型的正面特征（认可名单之外的一层）。
 *
 * 用户在设置页点「拉取全部模型」之后，可以退到这一层来挑 —— 它比认可名单宽，
 * 但仍然挡掉聊天 / 语音 / 嵌入 / 视频那一大片。
 *
 * 第一条 /image/ 是主力：这一族的命名几乎都把 image 写进名字里 ——
 * gpt-image-*、gemini-3-pro-image-*、grok-4.2-image、kling-image-*、
 * sora_image、z-image-turbo、qwen-image-edit… 实测 858 个模型里有 56 个带 image。
 *
 * 后面几条补的是**名字里没有 image 的**生图模型。
 * 只写前缀白名单的话 gemini / grok / kling / sora 整族会被误杀。
 */
const IMAGE_MODEL_PATTERNS: RegExp[] = [
  /image/i,
  /^flux/i,
  /^bfl\//i,
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
 * 明确排除的：名字像生图，但这条路走不通。
 *
 * mj_fast_* / mj_relax_* 是 Midjourney 的动作端点与计费 SKU，
 * upscale / pan / zoom / blend / describe 都要先有一个已存在的任务才能调，
 * 不是"选中就能文生图"的东西 —— 认可名单里的 `midjourney` 才是入口。
 * kolors-virtual-try-on 是虚拟试穿专用接口，收的参数完全不同。
 */
const NOT_IMAGE_API: RegExp[] = [
  /^mj_/i,
  /virtual-try-on/i,
  // 视频模型。wanx 系列里 i2v / t2v / kf2v / vace 全是出视频的，
  // 被 /^wanx/ 一并捞了进来 —— 出的不是图，写不回 Photoshop 图层。
  /-(i2v|t2v|v2v|kf2v)/i,
  /-(i2v|t2v|v2v|kf2v)-/i,
  /vace/i
];

export function isLikelyImageModel(id: string): boolean {
  const s = id.trim();
  if (isApprovedImageModel(s)) return true;
  if (NOT_IMAGE_API.some((re) => re.test(s))) return false;
  return IMAGE_MODEL_PATTERNS.some((re) => re.test(s));
}

/* ---------------- 三档口径 ---------------- */

/**
 * 模型列表的三档口径：
 *   approved 出厂默认。只有真机验证过、协议钉死的四族。
 *   image    像生图的都留下。用户主动「拉取全部模型」后可以退到这一层。
 *   all      平台全量目录，一个不筛。
 */
export const MODEL_SCOPES = ['approved', 'image', 'all'] as const;
export type ModelScope = (typeof MODEL_SCOPES)[number];

export function isModelScope(s: string): s is ModelScope {
  return (MODEL_SCOPES as readonly string[]).includes(s);
}

/**
 * 按口径筛模型。
 *
 * 逐级兜底：approved 一个都没命中就退到 image，image 也没有才退回全量。
 * 空下拉等于这个平台彻底不能用 —— 那比列表太长糟糕得多。
 * 兜底发生时调用方要如实告诉用户这是第几档，不能假装筛过了。
 */
export function filterModelsByScope(
  models: readonly string[],
  scope: ModelScope = 'approved'
): { models: string[]; scope: ModelScope; total: number } {
  const total = models.length;
  if (scope === 'approved') {
    const hit = models.filter(isApprovedImageModel);
    if (hit.length > 0) return { models: hit, scope: 'approved', total };
  }
  if (scope === 'approved' || scope === 'image') {
    const hit = models.filter(isLikelyImageModel);
    if (hit.length > 0) return { models: hit, scope: 'image', total };
  }
  return { models: [...models], scope: 'all', total };
}

/* ============================ 提示词优化模型 ============================ */

/**
 * 「优化提示词 / 反推提示词」内置用的语言模型。
 *
 * 出厂钉死在 GPT-5.6 一族，设置页不暴露这个旋钮 —— 这一步是给生图打底的内部工序，
 * 不是让用户挑模型的地方。以前它跟着「生图默认模型」走，用户把默认模型设成
 * flux-2-max，优化提示词就拿生图模型去发 chat 请求，报一个和提示词八竿子打不着的错。
 *
 * 注意：**没有**裸的 `gpt-5.6` 这个 id。真机实测 —— 直接发 gpt-5.6 会 503：
 *   「所有分组对于模型 gpt-5.6 无可用渠道…请尝试更改模型为以下其一[…][gpt-5.6-sol][…]」
 * 网关上真正存在的是 luna / sol / terra 三个变体，三个都实测出词正常：
 *   gpt-5.6-terra 2.2s · gpt-5.6-luna 2.8s · gpt-5.6-sol 7.0s
 * 所以这里按"该平台实际有哪个"去挑，而不是写死一个名字然后祈祷它存在。
 * 顺序上快的优先：优化提示词卡在生图前面，每一秒用户都在等。
 */
export const PROMPT_MODEL_PREFERENCE: RegExp[] = [
  /^gpt-5\.6-terra$/i,
  /^gpt-5\.6-luna$/i,
  /^gpt-5\.6-sol$/i,
  /^gpt-5\.6/i,
  // 平台没有 5.6 时依次降级。降级是如实降级，不是失败 ——
  // 优化提示词用哪一代模型，对出图质量的影响远小于"这一步直接报错"。
  /^gpt-5\.5$/i,
  /^gpt-5\.4$/i,
  /^gpt-4o-mini$/i,
  /^gpt-4o$/i
];

/**
 * 连模型列表都拉不到时用的兜底 id。
 * 只在"网关连不上/列表接口挂了"这种情况下才会走到 —— 真发出去失败了，
 * 上游那句错误本身就是用户该看到的诊断，比我们自己编一句「没有可用模型」强。
 */
export const DEFAULT_PROMPT_MODEL = 'gpt-5.6-terra';

/** 在该平台实际有的模型里，挑内置提示词模型；挑不到返回 null。 */
export function pickPromptModel(models: readonly string[]): string | null {
  for (const re of PROMPT_MODEL_PREFERENCE) {
    const hit = models.find((m) => re.test(m.trim()));
    if (hit) return hit;
  }
  return null;
}
