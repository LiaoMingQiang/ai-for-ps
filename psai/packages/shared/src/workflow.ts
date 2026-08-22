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
  /** 取 resolveSize 的宽 */
  | { type: 'sizeWidth' }
  /** 取 resolveSize 的高 */
  | { type: 'sizeHeight' }
  /** 布尔取反 */
  | { type: 'not' };

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
