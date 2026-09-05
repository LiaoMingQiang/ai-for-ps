/**
 * RunningHub 云端工作流预设。
 *
 * 每条预设都对应 runninghub.cn 上一个**真实存在、公开可跑**的工作流，
 * nodeId / 字段名不是猜的 —— 全部来自官方接口
 *   POST /api/openapi/getJsonApiFormat  { apiKey, workflowId }
 * 返回的 ComfyUI API 格式图，逐个节点核对过。
 *
 * `npm run verify:rh` 会拿当前 API Key 重新拉一遍每个工作流的图，逐条比对绑定是否还成立。
 * 云端作者改图会让绑定失效，这个校验就是用来赶在用户之前先发现的。
 *
 * ── 一条用真金白银换来的教训 ─────────────────────────────────
 * 提示词绑到哪个节点上，必须**能真的走到文本编码器**。
 * 我们一开始挑的两个工作流把提示词接在 `ArgosTranslateTextNode`（第三方中译英节点）上，
 * RunningHub 的环境里这个节点不工作，输出空字符串 —— 任务照样"成功"，
 * 出来的却是 Flux 拿空提示词乱画的文字截图。接口全绿、状态机全绿、图也有，
 * 只有肉眼看图才发现提示词根本没生效。所以：
 *   1. 只选提示词能顺着连线走到 CLIPTextEncode 的工作流
 *   2. verify:rh 会做这条可达性检查
 *   3. 换过预设之后必须真跑一次，看图确认提示词生效
 *
 * 「不留死旋钮」在这里同样成立：某个预设没有的能力就不在 bindings 里列出来。
 */

import type { ParamBinding } from './workflow.js';

/** 预设覆盖的能力类别，用于设置页分组与筛选。 */
export type RhCategory =
  | 'textToImage'
  | 'imageToImage'
  | 'matting'
  | 'background'
  | 'inpaint'
  | 'outpaint'
  | 'upscale'
  | 'relight'
  | 'lineart'
  | 'restore'
  | 'erase';

export const RH_CATEGORY_LABELS: Record<RhCategory, string> = {
  textToImage: '文生图',
  imageToImage: '图生图',
  matting: '抠图去背景',
  background: '换背景',
  inpaint: '局部重绘',
  outpaint: '扩图',
  upscale: '高清放大',
  relight: '重打光',
  lineart: '线稿',
  restore: '修复',
  erase: '消除'
};

export interface RunningHubPreset {
  /** 插件内稳定 id */
  id: string;
  label: string;
  category: RhCategory;
  /** runninghub.cn 上的工作流 id，作品页 https://www.runninghub.cn/post/<id> */
  workflowId: string;
  /** 一句话说明它实际做什么，显示在设置页 */
  description: string;
  /** 云端图里的节点总数，核对时用来快速发现「作者换了一整套图」 */
  nodeCount: number;
  /** 主要模型/节点栈，帮用户判断风格 */
  stack: string;
  /**
   * 该工作流是否要求输入图带 alpha 通道当遮罩。
   * ComfyUI 的 LoadImage 会把 alpha 反相后输出成 MASK；
   * 要 mask 的工作流必须收 RGBA PNG，否则整张图会被当成待处理区域。
   */
  needsMask: boolean;
  /** 建议绑定到哪些 catalog 功能（设置页据此推荐） */
  featureIds: string[];
  /**
   * 这条预设推荐的参数取值，覆盖功能自身的默认值。
   *
   * 同一个功能挂不同预设，合理的默认值可以差很远。
   * 「质感加强」的重绘幅度默认 0.22 是对的 —— 它就是要保住原图结构；
   * 但把 Flux Fill 局部重绘挂上去，0.22 意味着遮罩区几乎没变化，
   * 用户选了预设、点了生成、什么也没发生，还以为是插件坏了。
   *
   * 这些值只是**默认值**，会照常显示在参数面板里，用户随时可以改 —— 不是暗改。
   */
  paramDefaults?: Record<string, unknown>;
  /** 提交时写进 nodeInfoList 的绑定 */
  bindings: ParamBinding[];
  /** 出图节点，校验时一并检查存在性 */
  outputNodeIds: string[];
}

const b = (paramId: string, nodeId: string, input: string, required = false): ParamBinding => ({
  paramId,
  nodeId,
  input,
  required
});

export const RUNNINGHUB_PRESETS: readonly RunningHubPreset[] = [
  {
    id: 'rh.t2i.flux',
    label: 'Flux Turbo 文生图（8 步）',
    category: 'textToImage',
    workflowId: '1909669429062631425',
    description: 'Nunchaku 加速的官方 Flux.1-dev，8 步出图。作者挂的吉卜力风格 LoRA 被我们置零，出来的是中性写实的 Flux。',
    nodeCount: 16,
    stack: 'Nunchaku Flux.1-dev + FLUX.1-Turbo-Alpha',
    needsMask: false,
    featureIds: ['cloud.t2i'],
    bindings: [
      b('prompt', '6', 'text', true),
      b('seed', '25', 'noise_seed', true),
      b('steps', '17', 'steps'),
      b('sampler', '16', 'sampler_name'),
      { paramId: 'aspect', nodeId: '27', input: 'width', transform: { type: 'sizeWidth' }, required: false },
      { paramId: 'aspect', nodeId: '27', input: 'height', transform: { type: 'sizeHeight' }, required: false },
      // 作者的风格 LoRA 会把每张图都拉成吉卜力插画，强制关掉
      { paramId: '__styleLora', nodeId: '47', input: 'lora_strength', transform: { type: 'const', value: 0 }, required: false }
    ],
    outputNodeIds: ['9']
  },
  {
    id: 'rh.i2i.hidream',
    label: 'HiDream 图生图（提示词 + 自动反推）',
    category: 'imageToImage',
    workflowId: '1915248465113452546',
    description: 'RH_Captioner 先反推原图内容，再把你的提示词拼在前面一起送进去，既保内容又听指令。',
    nodeCount: 16,
    stack: 'hidream_i1_full + llama-3.1-8b 文本编码 + RH_Captioner',
    needsMask: false,
    featureIds: ['cloud.i2i'],
    // 反推出来的原图描述会和用户提示词拼在一起，重绘幅度低的话原图描述占上风，
    // 用户的要求就体现不出来；0.85 是实测下来既听话又不丢结构的位置
    paramDefaults: { denoise: 0.85, steps: 25 },
    bindings: [
      b('image', '76', 'image', true),
      b('prompt', '90', 'value', true),
      b('negativePrompt', '40', 'text'),
      b('denoise', '82', 'denoise'),
      b('steps', '82', 'steps'),
      b('cfg', '82', 'cfg'),
      b('sampler', '82', 'sampler_name'),
      b('seed', '82', 'seed', true)
    ],
    outputNodeIds: ['9']
  },
  {
    id: 'rh.matting.birefnet',
    label: 'BiRefNet 复杂背景抠图',
    category: 'matting',
    workflowId: '1897193863243878401',
    description: '四个节点的纯抠图流程，输出带透明通道的 PNG，适合直接当图层贴回 Photoshop。',
    nodeCount: 4,
    stack: 'BiRefNet-General + PyMatting',
    needsMask: false,
    featureIds: ['cloud.product.whitebg'],
    bindings: [
      b('image', '32', 'image', true),
      b('edgeBlack', '33', 'black_point'),
      b('edgeWhite', '33', 'white_point')
    ],
    outputNodeIds: ['31']
  },
  {
    id: 'rh.bg.flux',
    label: 'Flux 换背景（深度 + Redux 参考）',
    category: 'background',
    workflowId: '1897953978448039938',
    description: '主体走 Depth ControlNet 保形，背景由提示词或参考图（Redux）决定，抠像用 BiRefNet。',
    nodeCount: 36,
    stack: 'flux1-depth-dev + F.1-Fill + flux1-redux + BiRefNet',
    needsMask: false,
    featureIds: ['cloud.product.whitebg', 'comfy.edit.texture'],
    bindings: [
      b('image', '285', 'image', true),
      b('reference', '333', 'image'),
      b('prompt', '280', 'text', true),
      b('seed', '279', 'seed', true),
      b('steps', '279', 'steps'),
      { paramId: 'aspect', nodeId: '283', input: 'width', transform: { type: 'sizeWidth' }, required: false },
      { paramId: 'aspect', nodeId: '283', input: 'height', transform: { type: 'sizeHeight' }, required: false }
    ],
    outputNodeIds: ['316', '345']
  },
  {
    id: 'rh.product.background',
    label: '产品场景图（ACE++ 保形换景）',
    category: 'background',
    workflowId: '1896098010688847873',
    description: 'ACE++ subject LoRA 锁住产品本体不变形，按提示词生成整套场景，电商主图直接可用。',
    nodeCount: 24,
    stack: 'F.1-Fill + ace++_subject_lora16',
    needsMask: false,
    featureIds: ['comfy.misc.retouch.product', 'cloud.product.whitebg'],
    bindings: [
      b('image', '296', 'image', true),
      b('prompt', '288', 'text', true),
      b('negativePrompt', '301', 'text'),
      b('seed', '364', 'seed', true),
      b('steps', '364', 'steps')
    ],
    outputNodeIds: ['300']
  },
  {
    id: 'rh.inpaint.fluxfill',
    label: 'Flux Fill 局部重绘（无痕）',
    category: 'inpaint',
    workflowId: '1901904713074548737',
    description:
      '需要带 alpha 的 PNG：透明处即为要重绘的区域。DifferentialDiffusion 让接缝几乎看不出来，Photoshop 选区可直接转成遮罩。',
    nodeCount: 15,
    stack: 'flux1-fill-dev + DifferentialDiffusion',
    needsMask: true,
    featureIds: ['comfy.edit.texture'],
    // 局部重绘要的是"把遮罩区换成提示词描述的东西"，重绘幅度必须拉满；
    // 沿用「质感加强」的 0.22 会让遮罩区几乎不变，看起来像插件没反应
    paramDefaults: { denoise: 1, steps: 20, cfg: 1 },
    bindings: [
      b('image', '14', 'image', true),
      b('prompt', '19', 'text', true),
      b('negativePrompt', '9', 'text'),
      b('seed', '3', 'seed', true),
      b('steps', '3', 'steps'),
      b('denoise', '3', 'denoise'),
      b('cfg', '3', 'cfg')
    ],
    outputNodeIds: ['20']
  },
  {
    id: 'rh.outpaint.fluxfill',
    label: 'Flux Fill 扩图',
    category: 'outpaint',
    workflowId: '1894045000794046466',
    description: '四个方向分别给扩展像素数，边缘羽化过渡。不需要遮罩，扩出来的区域由 Flux Fill 补全。',
    nodeCount: 14,
    stack: 'F.1-Fill-fp16 + ImagePadForOutpaint',
    needsMask: false,
    featureIds: ['comfy.edit.texture'],
    bindings: [
      b('image', '53', 'image', true),
      b('prompt', '23', 'text'),
      b('negativePrompt', '7', 'text'),
      b('seed', '3', 'seed', true),
      b('steps', '3', 'steps'),
      b('expandTop', '44', 'top'),
      b('expandBottom', '44', 'bottom'),
      b('expandLeft', '44', 'left'),
      b('expandRight', '44', 'right'),
      b('feather', '44', 'feathering')
    ],
    outputNodeIds: ['9']
  },
  {
    id: 'rh.upscale.fluxcn',
    label: 'Flux ControlNet 高清放大',
    category: 'upscale',
    workflowId: '1839649528810000386',
    description: 'jasperai 的 Flux Upscaler ControlNet，倍数可调，Florence2 自动补描述以保住细节语义。',
    nodeCount: 17,
    stack: 'flux1-dev-fp8 + Flux.1-dev-Controlnet-Upscaler + Florence-2',
    needsMask: false,
    // 只挂「通用放大」。「无损放大」是确定性的纯算法放大，连种子都没有，
    // 而这是一条扩散链：它会补细节、也会改细节，挂上去就名不副实了。
    featureIds: ['comfy.misc.upscale.general'],
    bindings: [
      b('image', '17', 'image', true),
      { paramId: 'upscaleFactor', nodeId: '31', input: 'value', transform: { type: 'number' }, required: false },
      b('strength', '14', 'strength'),
      b('seed', '3', 'seed', true),
      b('steps', '3', 'steps')
    ],
    outputNodeIds: ['9']
  },
  {
    id: 'rh.relight.iclight',
    label: 'IC-Light 重打光',
    category: 'relight',
    workflowId: '1897257503439147010',
    description: '八向光源可选（左/右/上/下/四角），细节用 soft-light 回贴，主体不会被重打光洗掉。',
    nodeCount: 23,
    stack: 'majicmixRealistic_v7 + iclight_sd15_fc',
    needsMask: false,
    featureIds: ['comfy.relight.fixed', 'comfy.relight.adaptive'],
    bindings: [
      b('image', '111', 'image', true),
      b('prompt', '76', 'text'),
      b('negativePrompt', '77', 'text'),
      b('lightPosition', '114', 'light_position'),
      b('seed', '80', 'seed', true),
      b('steps', '80', 'steps')
    ],
    outputNodeIds: ['123']
  },
  {
    id: 'rh.lineart.colorize',
    label: 'Canny + Redux 线稿上色',
    category: 'lineart',
    workflowId: '1895671416807686145',
    description: '线稿走 Canny ControlNet 保结构，配色参考图走 Redux 风格迁移。两张图一起给效果最好。',
    nodeCount: 21,
    stack: 'flux1-canny-dev + flux1-redux-dev',
    needsMask: false,
    featureIds: ['comfy.wash.portrait', 'comfy.wash.scene'],
    bindings: [
      b('image', '34', 'image', true),
      b('reference', '53', 'image'),
      b('prompt', '21', 'text'),
      b('strength', '32', 'strength'),
      b('seed', '3', 'seed', true),
      b('steps', '3', 'steps')
    ],
    outputNodeIds: ['9']
  },
  {
    id: 'rh.lineart.extract',
    label: '图片转线稿',
    category: 'lineart',
    workflowId: '1899080497694425090',
    description: '把照片或渲染图转成干净线稿，可用来做产品结构稿或上色底稿。',
    nodeCount: 17,
    stack: 'Lineart_v1.1 + control_v11p_sd15_lineart + IPAdapter',
    needsMask: false,
    featureIds: ['comfy.wash.scene'],
    bindings: [
      b('image', '16', 'image', true),
      b('prompt', '6', 'text'),
      b('negativePrompt', '44', 'text'),
      b('strength', '18', 'strength'),
      b('seed', '3', 'seed', true),
      b('steps', '3', 'steps'),
      b('cfg', '3', 'cfg')
    ],
    outputNodeIds: ['9']
  },
  {
    id: 'rh.restore.oldphoto',
    label: '老照片修复 + 上色',
    category: 'restore',
    workflowId: '1895765097086320642',
    description: 'Recolor ControlNet 上色 + CodeFormer 面部修复，黑白老照片一步到彩色。',
    nodeCount: 23,
    stack: 'majicmixRealistic_v7 + ioclab_sd15_recolor + CodeFormer',
    needsMask: false,
    featureIds: ['comfy.wash.portrait'],
    bindings: [
      b('image', '1', 'image', true),
      b('prompt', '65', 'text'),
      b('negativePrompt', '123', 'text'),
      b('seed', '280', 'seed', true),
      b('steps', '280', 'steps'),
      b('denoise', '121', 'denoise')
    ],
    outputNodeIds: ['498']
  },
  {
    id: 'rh.erase.oneclick',
    label: '万物消除 / 去水印',
    category: 'erase',
    workflowId: '1909791576560758785',
    description:
      '需要带 alpha 的 PNG：透明处即为要擦掉的区域。先用 LaMa 补大面积，再用 Fooocus Inpaint 精修，8 步出图。',
    nodeCount: 18,
    stack: 'DreamShaper XL Turbo + fooocus_inpaint + LaMa(Places_512)',
    needsMask: true,
    featureIds: ['comfy.edit.texture'],
    // 消除用的是 Turbo 模型，8 步足够；重绘幅度 0.6 是原作者调好的，太高会连周围一起改
    paramDefaults: { denoise: 0.6, steps: 8 },
    bindings: [
      b('image', '199', 'image', true),
      b('prompt', '196', 'text'),
      b('negativePrompt', '197', 'text'),
      b('seed', '210', 'seed', true),
      b('steps', '210', 'steps'),
      b('denoise', '210', 'denoise')
    ],
    outputNodeIds: ['383']
  }
];

/** 按 id 查预设。 */
export function rhPreset(id: string): RunningHubPreset | null {
  return RUNNINGHUB_PRESETS.find((p) => p.id === id) ?? null;
}

/** 按云端工作流 id 反查预设（引擎提交时用它拿绑定表）。 */
export function rhPresetByWorkflowId(workflowId: string): RunningHubPreset | null {
  const wanted = workflowId.trim();
  if (!wanted) return null;
  return RUNNINGHUB_PRESETS.find((p) => p.workflowId === wanted) ?? null;
}

/** 某个功能推荐的预设。 */
export function rhPresetsForFeature(featureId: string): RunningHubPreset[] {
  return RUNNINGHUB_PRESETS.filter((p) => p.featureIds.includes(featureId));
}

/** 作品页地址，设置页给「去 RunningHub 看看这个工作流」的链接。 */
export function rhPostUrl(workflowId: string): string {
  return 'https://www.runninghub.cn/post/' + workflowId;
}

/* ============================ AI 应用（v2 接口） ============================ */

/**
 * RunningHub 的「AI 应用」和「ComfyUI 工作流」是**两种不同的东西**，
 * 接口也完全不同。实测（用真实 ID 打 /api/openapi/getJsonApiFormat）：
 *
 *   AI 应用 ID  1892509998193545217 → code 380 WORKFLOW_NOT_EXISTS
 *   工作流 ID   2095750036550721537 → code 810 WORKFLOW_NOT_SAVED_OR_NOT_RUNNING
 *
 * 也就是说工作流接口**根本不认识** AI 应用的 ID，不是"没权限"也不是"没绑定"。
 * 而工作流那个 810 是另一回事：ID 认出来了，只是那份工作流还没在平台上
 * 保存并成功跑过一次，平台就不给它的 API 格式图。
 *
 * 两者的差别决定了本机能做什么：
 *   工作流  —— 能拉回 ComfyUI 图，于是能扫描、能自动推导参数绑定
 *   AI 应用 —— 拉不到图，节点号只存在于平台给每个应用单独生成的 API 文档页里，
 *             没有任何公开接口能查。所以只能让用户把那段 curl 贴进来。
 */
export type RunningHubRemoteKind = 'workflow' | 'aiApp';

/** AI 应用 nodeInfoList 里的一项。 */
export interface RhNodeField {
  nodeId: string;
  fieldName: string;
  /** 平台文档里对这个字段的说明，原样带给用户看 */
  description: string;
  /** 文档示例里的值。图片位会被换掉，其余的作为默认值 */
  defaultValue: string;
}

/**
 * 从用户粘贴的内容里解析出 nodeInfoList。
 *
 * 接受三种形态，因为用户手上可能是其中任意一种：
 *   整段 curl（平台「复制文档」给的就是这个）
 *   请求体 JSON        {"nodeInfoList": [...], "instanceType": "default"}
 *   光是那个数组        [{"nodeId": "525", ...}]
 *
 * 之所以不要求用户自己摘出数组：那一步全靠手工，摘错了报的错会指向别处，
 * 而他并不知道自己摘错了。宁可这里多认几种形态。
 */
export function parseRhNodeInfo(raw: string): RhNodeField[] {
  const text = raw.trim();
  if (!text) throw new Error('请先把平台上的「请求示例」粘贴进来。');

  const candidates: string[] = [];
  // curl 里的 --data-raw '...' / --data '...'，单双引号都认
  for (const m of text.matchAll(/--data(?:-raw|-binary)?\s+(['"])([\s\S]*?)\1/g)) {
    if (m[2]) candidates.push(m[2]);
  }
  candidates.push(text);

  for (const c of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(c.trim());
    } catch {
      continue;
    }
    const list = Array.isArray(parsed)
      ? parsed
      : ((parsed as { nodeInfoList?: unknown })?.nodeInfoList ?? null);
    if (!Array.isArray(list)) continue;

    const out: RhNodeField[] = [];
    for (const item of list) {
      const o = item as Record<string, unknown>;
      const nodeId = o['nodeId'];
      const fieldName = o['fieldName'];
      if (typeof nodeId !== 'string' && typeof nodeId !== 'number') continue;
      if (typeof fieldName !== 'string' || !fieldName) continue;
      out.push({
        nodeId: String(nodeId),
        fieldName,
        description: typeof o['description'] === 'string' ? o['description'] : '',
        defaultValue: o['fieldValue'] === undefined || o['fieldValue'] === null ? '' : String(o['fieldValue'])
      });
    }
    if (out.length) return out;
  }

  throw new Error(
    '没能从粘贴的内容里找到 nodeInfoList。请到应用的 API 页面，把「提交请求 → 请求示例」那段 curl 整个复制过来。'
  );
}

/**
 * 哪一项是图片位。
 *
 * 判据按可靠性排序：字段名叫 image 最硬；其次是示例值看着像图片文件名；
 * 最后才看说明里有没有「上传/图」这类字眼。
 *
 * 认不出来时返回 null 而不是猜第一个 —— 猜错的后果是把图塞进一个数值字段，
 * 平台照跑不误，然后用作者的示例图出一张跟你输入无关的图。
 * 那种"看起来成功了"的结果比直接报错难查得多。
 */
export function pickRhImageField(fields: readonly RhNodeField[]): RhNodeField | null {
  return (
    fields.find((f) => /^image$/i.test(f.fieldName)) ??
    fields.find((f) => /image|img|photo|picture/i.test(f.fieldName)) ??
    fields.find((f) => /\.(png|jpe?g|webp)$/i.test(f.defaultValue)) ??
    fields.find((f) => /上传|图片|图像|产品图/.test(f.description)) ??
    null
  );
}

/* ============================ 从网址里认 ID ============================ */

/**
 * 用户粘进来的可能是整条网址，也可能就是那串 ID。两种都认。
 *
 * 各平台把 ID 藏在完全不同的地方，让用户自己去抠是不合理的：
 *
 *   RunningHub 工作流   .../zh-cn/workflow/2095750596867792898
 *   RunningHub AI 应用  .../zh-cn/ai-detail/1892509998193545217
 *   LiblibAI 工作流     .../comfy?open=...&comfyuuid=6a40234cc28b49de806ed9bac9eeb555
 *
 * LiblibAI 尤其隐蔽 —— 它页面上根本没有展示工作流 ID 的地方，只有在线
 * ComfyUI 打开那份工作流时地址栏里的 comfyuuid 参数。用户找不到是正常的。
 *
 * 认不出来就原样返回（去掉首尾空白）：也许他粘的本来就是纯 ID，
 * 交给服务端去判合不合法，比在这里猜错更好。
 */
export function extractCloudWorkflowId(raw: string): string {
  const text = raw.trim();
  if (!text) return '';
  // 不像网址就当成 ID 本身
  if (!/[?/=]/.test(text)) return text;

  // LiblibAI：comfyuuid=<32 位十六进制>
  const liblib = /[?&]comfyuuid=([0-9a-f]{16,})/i.exec(text);
  if (liblib?.[1]) return liblib[1];

  // RunningHub：/workflow/<数字> 或 /ai-detail/<数字>
  const rh = /\/(?:workflow|ai-detail|ai-app)\/(\d{6,})/.exec(text);
  if (rh?.[1]) return rh[1];

  /*
   * 认不出就**不猜**，原样返回。
   *
   * 这里原来有个兜底：挑网址里最长的那串十六进制。真机上立刻出事 ——
   * 用户粘的是 liblib.art/lib3?uuid=a9c9…&modelInfo=6a40…，两个参数都是
   * 32 位十六进制，兜底取了前面那个（页面 uuid），而工作流 uuid 是后面那个。
   * 界面还理直气壮地报了一句「已从网址里认出 ID」。
   *
   * 猜错的代价不是报错，是拿着一个错 ID 去提交，平台回一句「工作流不存在」——
   * 跟真正的原因（取错了参数）毫无关系。认不出来交给用户自己填，
   * 比给他一个看起来对的错答案强得多。
   */
  return text;
}
