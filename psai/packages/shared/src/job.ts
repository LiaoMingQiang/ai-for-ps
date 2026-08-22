/**
 * 作业契约与状态机。
 *
 * 核心原则：
 *  1. AI 出图成功 与 写回 Photoshop 成功 是两件事，状态上严格分离。
 *     写回失败 → retryable_writeback_failure，结果永久保留在资产库，可随时重试。
 *  2. Helper 重启后恢复任务时，先去远端查真实状态，绝不盲目重新提交。
 *  3. 任何"不支持"都必须显式落到状态与错误码上，不允许伪装成功。
 */

import type { ErrorCode, PsaiErrorShape } from './errors.js';
import type { WritebackMode } from './params.js';

/* ============================ 状态 ============================ */

export const JOB_STATES = [
  'created',
  'inputs_uploading',
  'inputs_ready',
  'queued_local',
  'submitting',
  'submitted',
  'remote_queued',
  'running',
  'downloading',
  'result_ready',
  'writeback_pending',
  'writeback_running',
  'succeeded',
  'cancel_requested',
  'cancelled',
  'failed',
  'retryable_writeback_failure',
  'lost'
] as const;

export type JobState = (typeof JOB_STATES)[number];

export const JOB_STATE_LABELS: Record<JobState, string> = {
  created: '已创建',
  inputs_uploading: '上传输入中',
  inputs_ready: '输入就绪',
  queued_local: '本地排队中',
  submitting: '提交中',
  submitted: '已提交',
  remote_queued: '远端排队中',
  running: '生成中',
  downloading: '下载结果中',
  result_ready: '结果就绪',
  writeback_pending: '等待写回',
  writeback_running: '写回中',
  succeeded: '已完成',
  cancel_requested: '取消中',
  cancelled: '已取消',
  failed: '失败',
  retryable_writeback_failure: '写回失败（结果已保留）',
  lost: '状态丢失'
};

/** 终态：不会再自动流转。 */
export const TERMINAL_STATES: ReadonlySet<JobState> = new Set<JobState>([
  'succeeded',
  'cancelled',
  'failed',
  'lost',
  'retryable_writeback_failure'
]);

/** 活动态：占用并发额度、需要轮询/监听。 */
export const ACTIVE_STATES: ReadonlySet<JobState> = new Set<JobState>([
  'inputs_uploading',
  'inputs_ready',
  'queued_local',
  'submitting',
  'submitted',
  'remote_queued',
  'running',
  'downloading',
  'cancel_requested'
]);

/** AI 侧已经出图成功（无论写回如何）。 */
export const AI_SUCCEEDED_STATES: ReadonlySet<JobState> = new Set<JobState>([
  'result_ready',
  'writeback_pending',
  'writeback_running',
  'succeeded',
  'retryable_writeback_failure'
]);

export const JOB_TRANSITIONS: Record<JobState, readonly JobState[]> = {
  created: ['inputs_uploading', 'inputs_ready', 'failed', 'cancel_requested'],
  inputs_uploading: ['inputs_ready', 'failed', 'cancel_requested'],
  inputs_ready: ['queued_local', 'failed', 'cancel_requested'],
  queued_local: ['submitting', 'cancel_requested', 'failed'],
  submitting: ['submitted', 'failed', 'cancel_requested'],
  submitted: ['remote_queued', 'running', 'downloading', 'failed', 'cancel_requested', 'lost'],
  remote_queued: ['running', 'cancel_requested', 'failed', 'lost'],
  running: ['downloading', 'result_ready', 'failed', 'cancel_requested', 'lost'],
  downloading: ['result_ready', 'failed', 'lost'],
  result_ready: ['writeback_pending', 'succeeded', 'failed'],
  writeback_pending: ['writeback_running', 'succeeded', 'retryable_writeback_failure'],
  writeback_running: ['succeeded', 'retryable_writeback_failure'],
  succeeded: [],
  cancel_requested: ['cancelled', 'running', 'result_ready', 'failed'],
  cancelled: [],
  failed: ['queued_local'],
  retryable_writeback_failure: ['writeback_running'],
  lost: []
};

export function canTransition(from: JobState, to: JobState): boolean {
  return JOB_TRANSITIONS[from].includes(to);
}

export function isTerminal(s: JobState): boolean {
  return TERMINAL_STATES.has(s);
}

export function isActive(s: JobState): boolean {
  return ACTIVE_STATES.has(s);
}

/* ============================ 输入 / 输出 ============================ */

export interface JobImageInput {
  /** 对应 ParamSpec.id */
  paramId: string;
  assetId: string;
  /** 该图在 imageList 中的次序 */
  index: number;
  source: string;
  width: number;
  height: number;
  sha256: string;
}

/** 提交时冻结的 Photoshop 上下文，写回时用它校验，不依赖"当前"状态。 */
export interface PhotoshopTarget {
  documentId: number;
  documentName: string;
  documentPath: string;
  canvasWidth: number;
  canvasHeight: number;
  sourceLayerIds: number[];
  sourceLayerNames: string[];
  /** 选区任务：提交那一刻的选区边界 */
  selectionBounds: { left: number; top: number; right: number; bottom: number } | null;
  colorMode: string;
  bitDepth: number;
}

export interface JobResultAsset {
  assetId: string;
  width: number;
  height: number;
  bytes: number;
  sha256: string;
  mime: string;
  /** 该结果在一次生成里的序号（批量出图） */
  index: number;
}

export interface JobProgress {
  /** 0..1，未知时为 null */
  value: number | null;
  /** 当前步 / 总步 */
  step: number | null;
  total: number | null;
  /** 当前正在执行的节点（ComfyUI） */
  node: string | null;
  message: string;
}

/* ============================ 作业 ============================ */

export interface JobRecord {
  id: string;
  featureId: string;
  /** 实际选用的 Provider（本地 comfyui / runninghub / volcengine …） */
  providerId: string;
  /** comfy-workflow 引擎才有 */
  workflowId: string | null;
  workflowVersion: string | null;
  state: JobState;
  progress: JobProgress;
  params: Record<string, unknown>;
  /** 归一化并注入种子/尺寸之后的最终参数，用于复现 */
  resolvedParams: Record<string, unknown>;
  inputs: JobImageInput[];
  results: JobResultAsset[];
  target: PhotoshopTarget | null;
  writeback: { mode: WritebackMode; layerName: string } | null;
  error: PsaiErrorShape | null;
  /** Provider 侧的任务 id（ComfyUI prompt_id / RunningHub taskId） */
  remoteId: string | null;
  /** 这条任务由哪条任务重跑而来 */
  parentJobId: string | null;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  /** 本地 GPU 占用时长（毫秒），云任务为 null */
  gpuMs: number | null;
}

export interface JobEvent {
  jobId: string;
  at: number;
  from: JobState | null;
  to: JobState;
  note: string;
  errorCode: ErrorCode | null;
}

/* ============================ API 载荷 ============================ */

export interface CreateJobRequest {
  featureId: string;
  params: Record<string, unknown>;
  inputs: Array<{ paramId: string; assetId: string; index: number; source: string }>;
  target: PhotoshopTarget | null;
  writeback: { mode: WritebackMode; layerName?: string } | null;
  /** 覆盖设置里的默认 Provider；不传则按功能的绑定解析 */
  providerId?: string;
  /** 覆盖功能的默认工作流绑定 */
  workflowId?: string;
}

export interface JobListQuery {
  state?: JobState;
  featureId?: string;
  documentId?: number;
  limit?: number;
  offset?: number;
}

/** WS 推送的事件。 */
export type HelperEvent =
  | { type: 'job:update'; job: JobRecord }
  | { type: 'job:event'; event: JobEvent }
  | { type: 'provider:status'; providerId: string; online: boolean; detail: string }
  | { type: 'gpu'; gpu: GpuInfo }
  | { type: 'hello'; version: string; schemaVersion: number };

export interface GpuInfo {
  available: boolean;
  name: string | null;
  vramTotalMb: number | null;
  vramUsedMb: number | null;
  utilizationPct: number | null;
  temperatureC: number | null;
  /** 读取失败时的原因，UI 直接显示 */
  reason: string | null;
}
