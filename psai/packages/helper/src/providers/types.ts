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
  /** 是否带 alpha 通道；靠遮罩工作的工作流在提交前要据此拦截 */
  hasAlpha: boolean;
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
  fetchResults(remoteId: string): Promise<ResultImage[]>;
  cancel(remoteId: string, currentState: RemoteState): Promise<CancelResult>;
  /** 订阅进度（可选，没有的话上层退化为轮询） */
  subscribe?(remoteId: string, onProgress: (p: JobProgress) => void): () => void;
  /**
   * 文本/视觉补全：用于「反推提示词」与「优化提示词」。
   * 不具备该能力的 Provider 不实现此方法，上层据此禁用 UI 上的入口并说明原因。
   */
  textComplete?(input: TextCompleteInput): Promise<string>;
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
}

export function emptyProgress(message = ''): JobProgress {
  return { value: null, step: null, total: null, node: null, message };
}
