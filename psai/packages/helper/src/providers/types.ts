/**
 * Provider 适配器契约。
 *
 * 铁律：任何"不支持"都必须显式返回错误码，绝不能返回一个假的成功。
 * 上层（作业引擎）只认这套接口，不认任何厂商细节。
 */

import type { JobProgress, ProviderCapability, PsaiErrorShape } from '@psai/shared';
import type { WorkflowRecord } from '@psai/shared';

export interface InputImage {
  paramId: string;
  index: number;
  buffer: Buffer;
  mime: string;
  filename: string;
  /** 是否带 alpha 通道。注意：**这不足以**判断"带没带选区"，见下一个字段 */
  hasAlpha: boolean;
  /**
   * alpha 通道是不是一次明确的选区遮罩。
   *
   * 靠遮罩工作的工作流（局部重绘那一族）必须看这个，不能看 hasAlpha。
   * 透明背景的图层、抠过图的素材、带透明边的 PNG 全都天生有 alpha ——
   * 拿它们的天然透明当选区用，模型会去改一片用户完全没圈过的区域，
   * 而这要等花完钱、拿回结果才看得出来。
   */
  hasSelectionMask: boolean;
}

export interface SubmitContext {
  jobId: string;
  featureId: string;
  /** 已归一化并解析过的参数（种子已定、宽高已算好） */
  params: Record<string, unknown>;
  inputs: InputImage[];
  /** comfy 类 Provider 使用 */
  workflow?: WorkflowRecord;
  /** 闭源 Provider 使用 */
  model?: string;
  /** 组装好的最终提示词 */
  prompt?: string;
  negativePrompt?: string;
  /** 云端工作流 id（RunningHub） */
  remoteWorkflowId?: string;
  /**
   * 用户登记的那条云端工作流记录。
   *
   * 光有 remoteWorkflowId 不够：RunningHub 上「AI 应用」和「ComfyUI 工作流」
   * 走两套完全不同的接口，而且 AI 应用的节点参数表只存在这条记录里
   * （平台没有任何接口能查到它）。
   */
  remoteWorkflow?: WorkflowRecord;
  /**
   * 幂等键。上游支持时带上，同一个键重复提交只会计一次费。
   *
   * 崩溃恢复重放的是**同一个** attempt、用同一个键；
   * 用户明确选择"重来一次"时是新的 attempt、新的键（那本来就该是一次新计费）。
   * 不支持幂等的平台忽略它即可，不影响功能。
   */
  idempotencyKey?: string;
  /**
   * 取消信号。用户在提交进行中点了取消时会被触发。
   *
   * 适配器应该把它传给提交路径上的每一次 httpFetch —— 中止一个还没发完的请求
   * 是唯一能真正省下这次费用的时机；等 remoteId 回来再去取消，钱已经花了。
   *
   * 注意中止的**结果是模糊的**：请求可能已经完整送达上游。付费平台上，
   * 引擎会据此把任务落到 submission_unknown 而不是 cancelled ——
   * 那是诚实的说法，"已取消"会让用户以为不会被扣钱。
   */
  signal?: AbortSignal;
}

export interface SubmitResult {
  remoteId: string;
  /** 有些同步型 Provider 提交即出结果 */
  immediateResults?: ResultImage[];
}

export type RemoteState = 'queued' | 'running' | 'done' | 'failed' | 'unknown';

export interface PollResult {
  state: RemoteState;
  progress?: JobProgress;
  error?: PsaiErrorShape;
}

export interface ResultImage {
  buffer: Buffer;
  mime: string;
}

export interface TestResult {
  ok: boolean;
  latencyMs: number | null;
  detail: string;
  error?: PsaiErrorShape;
  /** 探测到的附加信息，例如 ComfyUI 版本、节点数 */
  info?: Record<string, unknown>;
}

export interface CancelResult {
  ok: boolean;
  /** 不支持取消时必须给出人话解释 */
  reason: string;
}

export interface ProviderAdapter {
  readonly id: string;
  /** 是否已配置到可用状态（地址/密钥齐全） */
  isConfigured(): boolean;
  /** 未配置时的原因，UI 直接显示 */
  notConfiguredReason(): string;
  testConnection(): Promise<TestResult>;
  listModels(): Promise<string[]>;
  capabilities(): Promise<ProviderCapability[]>;
  submit(ctx: SubmitContext): Promise<SubmitResult>;
  poll(remoteId: string): Promise<PollResult>;
  /**
   * 取结果。signal 用来在下载途中取消 —— 结果图动辄几十兆，
   * 用户点了取消却还在下，界面停着而带宽在跑，这种"取消了但没停"最消耗信任。
   */
  fetchResults(remoteId: string, signal?: AbortSignal): Promise<ResultImage[]>;
  cancel(remoteId: string, currentState: RemoteState): Promise<CancelResult>;
  /** 订阅进度（可选，没有的话上层退化为轮询） */
  subscribe?(remoteId: string, onProgress: (p: JobProgress) => void): () => void;
  /**
   * 文本/视觉补全：用于「反推提示词」与「优化提示词」。
   * 不具备该能力的 Provider 不实现此方法，上层据此禁用 UI 上的入口并说明原因。
   */
  textComplete?(input: TextCompleteInput): Promise<string>;
  /**
   * 最近一次 textComplete 实际用的模型。
   * 内置模型是适配器自己挑的，用户在设置里看不到 —— 那就至少在用完之后
   * 如实告诉他这次是谁改写的提示词，否则「优化」就成了一个黑箱。
   */
  lastTextModel?(): string | null;
  /**
   * 把用户手抄的平台任务号规范成我们内部用的 remoteId。
   *
   * 「认领」这条路上用：任务停在「提交结果未知」，用户到平台后台找到了那条任务，
   * 把号抄回来。抄回来的是**平台界面上的样子**，而我们内部存的往往带前缀
   * （liblib-comfy: / mj: 之类）—— 不规范化就直接存进去的话，
   * 后续 poll() 会拿着一个自己都不认识的 id 去查，得到 unknown，
   * 最后把一条其实好好的、已经付过钱的任务判成丢失。
   *
   * 返回 null 表示这个平台不支持认领（比如同步出图的、id 是我们自己编的）。
   * 抛错表示格式不对 —— 那要在写库**之前**告诉用户，别等到轮询时才发现。
   */
  normalizeRemoteId?(raw: string): string | null;
  dispose?(): void;
}

export interface TextCompleteInput {
  /** 系统级指令（预设文本） */
  instruction: string;
  /** 用户附加文本，可空 */
  userText?: string;
  /** 参与理解的图片，可空 */
  images?: Array<{ buffer: Buffer; mime: string }>;
  model?: string;
  maxTokens?: number;
  /**
   * 取消信号。反推 / 优化提示词也可能跑几十秒，
   * 用户在那段时间里点了取消，就该把请求掐掉而不是干等它回来。
   */
  signal?: AbortSignal;
}

export function emptyProgress(message = ''): JobProgress {
  return { value: null, step: null, total: null, node: null, message };
}
