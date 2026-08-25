/**
 * 工作流与参数绑定。
 *
 * 内置工作流以 ComfyUI 的 API 格式（/prompt 直接可提交的那种）存放在 psai/workflows/ 下，
 * 每份工作流配一张绑定表，把 FeatureSpec 的参数 id 映射到具体节点输入。
 * 用户导入的工作流由 scanner 自动扫描出可绑定字段，再由用户在设置里确认绑定。
 */

/** ComfyUI API 格式：{ [nodeId]: { class_type, inputs, _meta? } } */
export interface ComfyApiNode {
  class_type: string;
  inputs: Record<string, unknown>;
  _meta?: { title?: string };
}

export type ComfyApiGraph = Record<string, ComfyApiNode>;

/* ============================ 绑定 ============================ */

export type BindingTransform =
  /** 把 UI 的 [inMin,inMax] 线性映射到节点期望的 [outMin,outMax] */
  | { type: 'linear'; inMin: number; inMax: number; outMin: number; outMax: number }
  /** 固定值，忽略 UI 取值 */
  | { type: 'const'; value: string | number | boolean }
  /** 拼接到节点已有文本后面（用于把机位片段/预设追加进提示词） */
  | { type: 'appendText'; separator: string }
  /** 覆盖为整数 */
  | { type: 'int' }
  /** 强制转成数字（分段控件的值是字符串，但节点要的是 FLOAT/INT） */
  | { type: 'number' }
  /** 取 resolveSize 的宽 */
  | { type: 'sizeWidth' }
  /** 取 resolveSize 的高 */
  | { type: 'sizeHeight' }
  /** 布尔取反 */
  | { type: 'not' }
  /**
   * 枚举值映射：把界面上的取值换成节点认识的那一个。
   *
   * 节点的枚举词是给 ComfyUI 用户看的，不是给产品用户看的 ——
   * BiRefNetRMBG 的 background 只认 'Color' / 'Alpha'，而面板上该写
   * 「纯白底（电商主图）」「透明」。没有这层映射就只能二选一：
   * 要么把 'Color' 直接摆到用户面前，要么给每个枚举单独写一个工作流。
   *
   * 映射不中时返回 undefined（该字段保持节点原值），不硬塞一个非法值进去 ——
   * 非法枚举会让 ComfyUI 在提交时整个拒绝，错误信息还指不到是哪个参数。
   */
  | { type: 'map'; map: Record<string, string | number | boolean> };

export interface ParamBinding {
  /** FeatureSpec.params 里的 id */
  paramId: string;
  /** ComfyApiGraph 的节点 key */
  nodeId: string;
  /** 该节点 inputs 下的字段名 */
  input: string;
  transform?: BindingTransform;
  /** 该绑定缺失时是否阻断提交 */
  required: boolean;
}

export interface WorkflowRecord {
  id: string;
  name: string;
  /** 语义化版本；同名工作流再次导入且内容变化 → 版本号递增，旧版本保留 */
  version: string;
  source: 'builtin' | 'imported';
  /** 导入时的原始格式 */
  format: 'api' | 'ui';
  graph: ComfyApiGraph;
  bindings: ParamBinding[];
  /** 取图的输出节点（SaveImage / PreviewImage） */
  outputNodeIds: string[];
  requiredNodeTypes: string[];
  /** 工作流引用到的模型文件名（checkpoint / lora / upscale / controlnet） */
  requiredModels: Array<{ kind: string; name: string }>;
  /** graph 的 sha256，用于判定版本是否变化 */
  hash: string;
  /** 该工作流为哪个功能出厂绑定（内置工作流才有） */
  featureId: string | null;
  notes: string;
  createdAt: number;
  updatedAt: number;
}

/* ============================ 扫描 ============================ */

/** 扫描器识别出的一个可绑定字段。 */
export interface ScannedField {
  nodeId: string;
  classType: string;
  title: string;
  input: string;
  /** 当前值，作为默认值回填 UI */
  value: string | number | boolean;
  valueType: 'string' | 'number' | 'boolean';
  /** 猜测出的语义，用于自动绑定到同名参数 */
  semantic: ScannedSemantic | null;
}

export type ScannedSemantic =
  | 'prompt'
  | 'negativePrompt'
  | 'seed'
  | 'steps'
  | 'cfg'
  | 'denoise'
  | 'sampler'
  | 'scheduler'
  | 'width'
  | 'height'
  | 'image'
  | 'mask'
  | 'checkpoint'
  | 'lora'
  | 'upscaleModel'
  | 'controlnet'
  | 'batchSize';

export interface ScanResult {
  ok: boolean;
  format: 'api' | 'ui';
  nodeCount: number;
  fields: ScannedField[];
  outputNodeIds: string[];
  requiredNodeTypes: string[];
  requiredModels: Array<{ kind: string; name: string }>;
  /** 自动推导出的绑定建议 */
  suggestedBindings: ParamBinding[];
  warnings: string[];
}

/* ============================ 依赖预检 ============================ */

export interface DependencyReport {
  workflowId: string;
  ok: boolean;
  missingNodes: string[];
  missingModels: Array<{ kind: string; name: string }>;
  /** 检查时连接的 ComfyUI 地址 */
  checkedAgainst: string;
  checkedAt: number;
}

/* ============================ 功能绑定 ============================ */

/** 「设置 → 固定功能」里的一条绑定。 */
export interface FeatureBinding {
  featureId: string;
  /** 走哪个 Provider（comfyui / runninghub / volcengine …） */
  providerId: string;
  /** comfy 类 Provider 时的本地工作流 id */
  workflowId: string | null;
  /** RunningHub 云端工作流 id */
  remoteWorkflowId: string | null;
  /** 闭源模型的模型名 */
  model: string | null;
  enabled: boolean;
}

/**
 * 用户可以绑到工作流节点上的参数，以及它们的中文名。
 *
 * 导入的工作流靠扫描器猜绑定，猜错了用户得能改 —— 改的时候要有一份
 * 「可以绑什么」的清单。这份清单同时是设置页绑定编辑器的下拉选项，
 * 所以放在 shared 里，界面和校验用同一份，不会各写各的。
 *
 * `image` / `mask` 走的是图像输入通道（提交前会被换成 Provider 认的文件名），
 * 其余都是普通标量参数。宽高不单列 —— 它们由「生图比例 + 分辨率」算出来，
 * 通过 sizeWidth / sizeHeight 变换落位。
 */
export const BINDABLE_PARAMS: ReadonlyArray<{ id: string; label: string; hint?: string }> = [
  { id: 'image', label: '输入图', hint: '提交前会被替换成后端认的文件名' },
  { id: 'reference', label: '参考图 / 第二张图' },
  { id: 'prompt', label: '提示词' },
  { id: 'negativePrompt', label: '负向提示词' },
  { id: 'seed', label: '随机种子' },
  { id: 'steps', label: '步数' },
  { id: 'cfg', label: 'CFG' },
  { id: 'denoise', label: '重绘幅度' },
  { id: 'sampler', label: '采样器' },
  { id: 'scheduler', label: '调度器' },
  { id: 'strength', label: '强度' },
  { id: 'upscaleFactor', label: '放大倍数' },
  { id: 'batchSize', label: '批量数' }
];

/** 扫描器猜出的语义 → 对应的参数 id（猜中了就直接预选上）。 */
export const SEMANTIC_TO_PARAM: Readonly<Record<string, string>> = {
  prompt: 'prompt',
  negativePrompt: 'negativePrompt',
  seed: 'seed',
  steps: 'steps',
  cfg: 'cfg',
  denoise: 'denoise',
  sampler: 'sampler',
  scheduler: 'scheduler',
  image: 'image',
  mask: 'image',
  batchSize: 'batchSize'
};
