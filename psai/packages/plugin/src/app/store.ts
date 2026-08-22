/**
 * 极小的响应式状态容器。
 * 页面订阅自己关心的键，Helper 推来的任务更新只重绘相关区域，不整页重刷。
 */

import type { JobRecord, AppSettings, GpuInfo, ProviderRuntimeStatus } from '@psai/shared';
import type { FeatureView, WorkflowSummary } from './api.js';

export interface HelperHealth {
  online: boolean;
  version: string | null;
  paired: boolean;
  activeJobs: number;
  comfyui: { configured: boolean; online: boolean; baseUrl: string; reason: string | null } | null;
  /** 离线时的原因，界面直接显示 */
  reason: string | null;
}

export interface DocContext {
  documentId: number;
  documentName: string;
  documentPath: string;
  width: number;
  height: number;
  colorMode: string;
  bitDepth: number;
  activeLayerName: string | null;
  activeLayerIds: number[];
  hasSelection: boolean;
  selectionBounds: { left: number; top: number; right: number; bottom: number } | null;
}

export interface AppState {
  booted: boolean;
  /** Photoshop 是否可用（浏览器预览时为 false） */
  inPhotoshop: boolean;
  psReason: string | null;
  health: HelperHealth;
  gpu: GpuInfo | null;
  doc: DocContext | null;
  page: 'comfyWeb' | 'generate' | 'history' | 'settings';
  featureId: string;
  features: FeatureView[];
  workflows: WorkflowSummary[];
  providers: ProviderRuntimeStatus[];
  settings: AppSettings | null;
  jobs: JobRecord[];
  /** 当前功能页的参数取值：featureId → values */
  paramValues: Record<string, Record<string, unknown>>;
  /** 当前功能页正在跟踪的任务 */
  activeJobId: string | null;
  toasts: Array<{ id: number; title: string; detail: string; kind: 'info' | 'warn' | 'error' }>;
}

type Listener = (state: AppState) => void;

const initial: AppState = {
  booted: false,
  inPhotoshop: false,
  psReason: null,
  health: { online: false, version: null, paired: false, activeJobs: 0, comfyui: null, reason: '尚未连接' },
  gpu: null,
  doc: null,
  page: 'generate',
  featureId: 'comfy.wash.portrait',
  features: [],
  workflows: [],
  providers: [],
  settings: null,
  jobs: [],
  paramValues: {},
  activeJobId: null,
  toasts: []
};

let state: AppState = { ...initial };
const listeners = new Map<string, Set<Listener>>();
let toastSeq = 0;

export function getState(): AppState {
  return state;
}

/**
 * 有些键每次都会拿到一个新对象，但内容其实没变（典型是每 5 秒轮询一次的 health、gpu）。
 * 只按引用比较的话，它们每次都算"变了"，订阅方就会整页重绘 ——
 * 正在输入的提示词、正在拖的立方体、滚动位置全被冲掉，面板看起来就像卡住点不动。
 * 所以这几个键改成按内容比较。
 */
const DEEP_COMPARE_KEYS = new Set(['health', 'gpu', 'doc']);

function sameValue(key: string, a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!DEEP_COMPARE_KEYS.has(key)) return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/** 更新状态并通知订阅了这些键的监听器。 */
export function setState(patch: Partial<AppState>): void {
  const changed: string[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!sameValue(k, (state as unknown as Record<string, unknown>)[k], v)) changed.push(k);
  }
  if (changed.length === 0) return;
  // 只把真正变了的键写进去：内容没变的键保持原引用，
  // 下游用 === 比较时才不会被"新对象"骗到
  const applied: Record<string, unknown> = {};
  for (const k of changed) applied[k] = (patch as Record<string, unknown>)[k];
  state = { ...state, ...(applied as Partial<AppState>) };
  const notified = new Set<Listener>();
  for (const key of changed) {
    for (const fn of listeners.get(key) ?? []) notified.add(fn);
  }
  for (const fn of listeners.get('*') ?? []) notified.add(fn);
  for (const fn of notified) fn(state);
}

/** 订阅指定键（'*' 表示任意变化）。返回取消订阅函数。 */
export function subscribe(keys: Array<keyof AppState | '*'>, fn: Listener): () => void {
  for (const k of keys) {
    let set = listeners.get(k as string);
    if (!set) {
      set = new Set();
      listeners.set(k as string, set);
    }
    set.add(fn);
  }
  return () => {
    for (const k of keys) listeners.get(k as string)?.delete(fn);
  };
}

export function resetStore(): void {
  state = { ...initial };
  listeners.clear();
}

/* ---------------- 参数取值 ---------------- */

export function paramsOf(featureId: string): Record<string, unknown> {
  return state.paramValues[featureId] ?? {};
}

export function setParam(featureId: string, paramId: string, value: unknown): void {
  const current = state.paramValues[featureId] ?? {};
  setState({
    paramValues: { ...state.paramValues, [featureId]: { ...current, [paramId]: value } }
  });
}

export function setParams(featureId: string, values: Record<string, unknown>): void {
  setState({ paramValues: { ...state.paramValues, [featureId]: values } });
}

/* ---------------- 任务 ---------------- */

export function upsertJob(job: JobRecord): void {
  const idx = state.jobs.findIndex((j) => j.id === job.id);
  const next = idx >= 0 ? state.jobs.map((j) => (j.id === job.id ? job : j)) : [job, ...state.jobs];
  setState({ jobs: next });
}

export function jobById(id: string | null): JobRecord | null {
  if (!id) return null;
  return state.jobs.find((j) => j.id === id) ?? null;
}

/* ---------------- 提示条 ---------------- */

export function toast(title: string, detail = '', kind: 'info' | 'warn' | 'error' = 'info'): void {
  const id = ++toastSeq;
  setState({ toasts: [...state.toasts, { id, title, detail, kind }] });
  setTimeout(() => {
    setState({ toasts: getState().toasts.filter((t) => t.id !== id) });
  }, kind === 'error' ? 8000 : 4000);
}

export function dismissToast(id: number): void {
  setState({ toasts: state.toasts.filter((t) => t.id !== id) });
}

/* ---------------- 功能查询 ---------------- */

export function featureView(id: string): FeatureView | null {
  return state.features.find((f) => f.id === id) ?? null;
}
