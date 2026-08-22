/**
 * Helper 客户端：REST + WebSocket。
 *
 * 插件只跟本机 Helper 说话，绝不直连任何第三方 AI 服务
 * （manifest 的网络白名单里也只有 Helper 的地址）。
 * 配对 token 存 UXP secureStorage，内存里留一份缓存。
 */

import { HELPER_DEFAULT_PORT, PSAI_VERSION } from '@psai/shared';
import type {
  JobRecord,
  JobEvent,
  AppSettings,
  ProviderRuntimeStatus,
  GpuInfo,
  CatalogNode,
  ParamSpec,
  WritebackMode,
  PhotoshopTarget,
  HelperEvent,
  FeatureBinding,
  ScanResult,
  DependencyReport,
  PsaiErrorShape
} from '@psai/shared';

const BASE = `http://127.0.0.1:${HELPER_DEFAULT_PORT}`;
const TOKEN_KEY = 'psai.helperToken';

/* ---------------- 类型 ---------------- */

export interface FeatureView {
  id: string;
  label: string;
  description: string;
  branch: 'comfyui' | 'cloud';
  engine: string;
  breadcrumb: string[];
  params: ParamSpec[];
  defaults: Record<string, unknown>;
  writeback: { modes: WritebackMode[]; default: WritebackMode };
  acceptance: string[];
  binding: FeatureBinding | null;
  providerId: string | null;
  workflowId: string | null;
  workflowName: string | null;
  ready: boolean;
  reason: string | null;
}

export interface WorkflowSummary {
  id: string;
  name: string;
  version: string;
  source: 'builtin' | 'imported';
  format: 'api' | 'ui';
  nodeCount: number;
  requiredNodeTypes: string[];
  requiredModels: Array<{ kind: string; name: string }>;
  featureId: string | null;
  bindingCount: number;
  notes: string;
  updatedAt: number;
}

export interface ProviderView extends ProviderRuntimeStatus {
  label: string;
  kind: string;
  consoleUrl: string | null;
  description: string;
  recommended: boolean;
  cancelSupport: 'full' | 'queuedOnly' | 'none';
  credentialFields: Array<{ key: string; label: string; secret: boolean; placeholder: string; required: boolean; masked: string | null }>;
}

export class ApiError extends Error {
  readonly shape: PsaiErrorShape;
  readonly status: number;
  constructor(shape: PsaiErrorShape, status: number) {
    super(shape.message);
    this.name = 'ApiError';
    this.shape = shape;
    this.status = status;
  }
  /** 面板上展示用：主消息 + 细节 */
  get display(): string {
    return this.shape.details ? `${this.shape.message}（${this.shape.details}）` : this.shape.message;
  }
}

/* ---------------- token ---------------- */

let token: string | null = null;

function secureStorage(): { getItem(k: string): Promise<string>; setItem(k: string, v: string): Promise<void>; removeItem(k: string): Promise<void> } | null {
  try {
    const uxp = (globalThis as { require?: (m: string) => { storage?: { secureStorage?: unknown } } }).require?.('uxp');
    return (uxp?.storage?.secureStorage as never) ?? null;
  } catch {
    return null;
  }
}

async function loadToken(): Promise<string | null> {
  if (token) return token;
  const store = secureStorage();
  if (!store) return null;
  try {
    const v = await store.getItem(TOKEN_KEY);
    if (v) token = v;
  } catch {
    /* 没存过就是没配对过 */
  }
  return token;
}

async function saveToken(value: string): Promise<void> {
  token = value;
  try {
    await secureStorage()?.setItem(TOKEN_KEY, value);
  } catch {
    /* 存不进去也能用完本次会话 */
  }
}

export async function clearToken(): Promise<void> {
  token = null;
  try {
    await secureStorage()?.removeItem(TOKEN_KEY);
  } catch {
    /* noop */
  }
}

/* ---------------- 请求 ---------------- */

async function request<T>(method: string, path: string, body?: unknown, opts: { auth?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.auth !== false) {
    const t = await loadToken();
    if (t) headers['Authorization'] = `Bearer ${t}`;
  }
  let payload: string | undefined;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  let res: Response;
  try {
    res = await fetch(BASE + path, { method, headers, body: payload });
  } catch (e) {
    throw new ApiError(
      {
        code: 'HELPER_OFFLINE',
        message: '本地 Helper 未运行',
        details: e instanceof Error ? e.message : String(e),
        retryable: true
      },
      0
    );
  }

  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new ApiError(
      { code: 'PROVIDER_BAD_RESPONSE', message: 'Helper 返回了无法解析的响应', details: text.slice(0, 200), retryable: false },
      res.status
    );
  }

  const obj = json as { ok?: boolean; error?: PsaiErrorShape };
  if (!res.ok || obj.ok === false) {
    throw new ApiError(
      obj.error ?? { code: 'INTERNAL_ERROR', message: `HTTP ${res.status}`, retryable: false },
      res.status
    );
  }
  return json as T;
}

/* ---------------- 配对 ---------------- */

export async function health(): Promise<{
  online: boolean;
  version: string;
  schemaVersion: number;
  paired: boolean;
  activeJobs: number;
  comfyui: { configured: boolean; online: boolean; baseUrl: string; reason: string | null };
}> {
  return request('GET', '/v1/health', undefined, { auth: false });
}

/** 自动配对：面板打开时静默完成，用户不需要做任何事。 */
export async function ensurePaired(): Promise<boolean> {
  const existing = await loadToken();
  if (existing) {
    try {
      await request('GET', '/v1/settings');
      return true;
    } catch (e) {
      if (!(e instanceof ApiError) || e.shape.code !== 'HELPER_UNAUTHORIZED') throw e;
      // token 失效，往下重新配对
      await clearToken();
    }
  }
  const req = await request<{ challenge: string }>('POST', '/v1/pair/request', { client: 'uxp' }, { auth: false });
  const confirm = await request<{ token: string }>('POST', '/v1/pair/confirm', { challenge: req.challenge }, { auth: false });
  await saveToken(confirm.token);
  return true;
}

/* ---------------- 各资源 ---------------- */

export const api = {
  system: () => request<{ dataDir: string; logsDir: string; assetBytes: number; freeBytes: number | null; platform: string; node: string }>('GET', '/v1/system'),
  gpu: () => request<{ gpu: GpuInfo }>('GET', '/v1/gpu').then((r) => r.gpu),

  settings: () => request<{ settings: AppSettings }>('GET', '/v1/settings').then((r) => r.settings),
  patchSettings: (patch: Partial<AppSettings>) =>
    request<{ settings: AppSettings }>('PATCH', '/v1/settings', patch).then((r) => r.settings),

  providers: () => request<{ providers: ProviderView[] }>('GET', '/v1/providers').then((r) => r.providers),
  patchProvider: (id: string, patch: { enabled?: boolean; baseUrl?: string; defaultModel?: string }) =>
    request<{ status: ProviderRuntimeStatus }>('PATCH', `/v1/providers/${encodeURIComponent(id)}`, patch),
  setCredentials: (id: string, fields: Record<string, string>) =>
    request<{ status: ProviderRuntimeStatus }>('POST', `/v1/providers/${encodeURIComponent(id)}/credentials`, fields),
  clearCredentials: (id: string) => request<{ ok: true }>('DELETE', `/v1/providers/${encodeURIComponent(id)}/credentials`),
  testProvider: (id: string) =>
    request<{ result: { ok: boolean; latencyMs: number | null; detail: string }; status: ProviderRuntimeStatus }>(
      'POST',
      `/v1/providers/${encodeURIComponent(id)}/test`
    ),
  listModels: (id: string) => request<{ models: string[] }>('GET', `/v1/providers/${encodeURIComponent(id)}/models`).then((r) => r.models),

  comfyObjectInfo: () =>
    request<{ samplers: string[]; schedulers: string[]; checkpoints: string[]; upscaleModels: string[]; nodeCount: number }>(
      'GET',
      '/v1/comfy/object-info'
    ),

  features: () => request<{ catalog: CatalogNode[]; features: FeatureView[] }>('GET', '/v1/features'),
  setBinding: (featureId: string, binding: Partial<FeatureBinding>) =>
    request<{ binding: FeatureBinding }>('PUT', `/v1/features/${encodeURIComponent(featureId)}/binding`, binding),
  resetBinding: (featureId: string) =>
    request<{ binding: FeatureBinding | null }>('POST', `/v1/features/${encodeURIComponent(featureId)}/binding/reset`),

  workflows: () => request<{ workflows: WorkflowSummary[] }>('GET', '/v1/workflows').then((r) => r.workflows),
  workflow: (id: string) => request<{ workflow: unknown }>('GET', `/v1/workflows/${encodeURIComponent(id)}`),
  scanWorkflow: (json: unknown) => request<{ scan: ScanResult }>('POST', '/v1/workflows/scan', { json }).then((r) => r.scan),
  importWorkflow: (json: unknown, name: string) =>
    request<{ workflow: WorkflowSummary; scan: ScanResult; versionBumped: boolean }>('POST', '/v1/workflows/import', { json, name }),
  deleteWorkflow: (id: string) => request<{ ok: true }>('DELETE', `/v1/workflows/${encodeURIComponent(id)}`),
  dependencies: (id: string) =>
    request<{ report: DependencyReport }>('GET', `/v1/workflows/${encodeURIComponent(id)}/dependencies`).then((r) => r.report),

  jobs: (query: Record<string, string | number> = {}) => {
    const qs = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)])).toString();
    return request<{ jobs: JobRecord[] }>('GET', `/v1/jobs${qs ? `?${qs}` : ''}`).then((r) => r.jobs);
  },
  job: (id: string) => request<{ job: JobRecord }>('GET', `/v1/jobs/${encodeURIComponent(id)}`).then((r) => r.job),
  jobEvents: (id: string) => request<{ events: JobEvent[] }>('GET', `/v1/jobs/${encodeURIComponent(id)}/events`).then((r) => r.events),
  createJob: (payload: {
    featureId: string;
    params: Record<string, unknown>;
    inputs: Array<{ paramId: string; assetId: string; index: number; source: string }>;
    target: PhotoshopTarget | null;
    writeback: { mode: WritebackMode; layerName?: string } | null;
  }) => request<{ job: JobRecord }>('POST', '/v1/jobs', payload).then((r) => r.job),
  cancelJob: (id: string) =>
    request<{ ok: boolean; reason: string; job: JobRecord }>('POST', `/v1/jobs/${encodeURIComponent(id)}/cancel`),
  discardJob: (id: string) => request<{ job: JobRecord }>('POST', `/v1/jobs/${encodeURIComponent(id)}/discard`).then((r) => r.job),
  retryJob: (id: string) => request<{ job: JobRecord }>('POST', `/v1/jobs/${encodeURIComponent(id)}/retry`).then((r) => r.job),
  rerunJob: (id: string) => request<{ job: JobRecord }>('POST', `/v1/jobs/${encodeURIComponent(id)}/rerun`).then((r) => r.job),
  requestWriteback: (id: string, mode?: WritebackMode, layerName?: string) =>
    request<{ job: JobRecord }>('POST', `/v1/jobs/${encodeURIComponent(id)}/writeback`, { mode, layerName }).then((r) => r.job),
  reportWriteback: (id: string, ok: boolean, detail: string, code?: string) =>
    request<{ job: JobRecord }>('POST', `/v1/jobs/${encodeURIComponent(id)}/writeback-result`, { ok, detail, code }).then((r) => r.job),
  deleteJob: (id: string) => request<{ ok: true }>('DELETE', `/v1/jobs/${encodeURIComponent(id)}`),

  prompts: (featureId?: string, kind?: string) => {
    const qs = new URLSearchParams();
    if (featureId) qs.set('featureId', featureId);
    if (kind) qs.set('kind', kind);
    const s = qs.toString();
    return request<{ presets: Array<{ id: string; label: string; kind: string; prompt: string; negativePrompt: string; builtin: boolean; customized: boolean; description: string }> }>(
      'GET',
      `/v1/prompts${s ? `?${s}` : ''}`
    ).then((r) => r.presets);
  },
  updatePrompt: (id: string, patch: { prompt?: string; negativePrompt?: string; label?: string; restore?: boolean }) =>
    request<{ preset: unknown }>('PUT', `/v1/prompts/${encodeURIComponent(id)}`, patch),

  textComplete: (payload: { presetId: string; userText?: string; assetIds?: string[]; featureId?: string }) =>
    request<{ text: string; providerId: string }>('POST', '/v1/text/complete', payload),

  /** 上传一张图，返回资产。二进制走 multipart，不走 JSON。 */
  uploadAsset: async (data: ArrayBuffer | Uint8Array, filename: string, mime = 'image/png') => {
    const t = await loadToken();
    const form = new FormData();
    const buffer = data instanceof Uint8Array ? data.slice().buffer : data;
    form.append('file', new Blob([buffer], { type: mime }), filename);
    const res = await fetch(`${BASE}/v1/assets`, {
      method: 'POST',
      headers: t ? { Authorization: `Bearer ${t}` } : {},
      body: form
    });
    const json = (await res.json()) as { ok?: boolean; error?: PsaiErrorShape; assets?: Array<{ id: string; width: number; height: number; bytes: number; mime: string; sha256: string }> };
    if (!res.ok || json.ok === false || !json.assets?.length) {
      throw new ApiError(json.error ?? { code: 'INTERNAL_ERROR', message: '上传失败', retryable: false }, res.status);
    }
    return json.assets[0]!;
  },

  assetUrl: (assetId: string) => `${BASE}/v1/assets/${encodeURIComponent(assetId)}`,

  /** 取资产字节（写回时需要落到临时文件） */
  assetBytes: async (assetId: string): Promise<ArrayBuffer> => {
    const t = await loadToken();
    const res = await fetch(`${BASE}/v1/assets/${encodeURIComponent(assetId)}`, {
      headers: t ? { Authorization: `Bearer ${t}` } : {}
    });
    if (!res.ok) throw new ApiError({ code: 'ASSET_NOT_FOUND', message: '取结果失败', retryable: false }, res.status);
    return res.arrayBuffer();
  }
};

/** 带 token 的资产 URL，供 <img src> 使用（UXP 的 img 不带 Authorization 头）。 */
export async function assetImgSrc(assetId: string): Promise<string> {
  const buf = await api.assetBytes(assetId);
  const bytes = new Uint8Array(buf);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return `data:image/png;base64,${btoa(bin)}`;
}

/* ---------------- WebSocket ---------------- */

type EventHandler = (ev: HelperEvent) => void;

let ws: WebSocket | null = null;
let backoff = 1000;
let handlers = new Set<EventHandler>();
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let closedByUs = false;

export function onHelperEvent(fn: EventHandler): () => void {
  handlers.add(fn);
  return () => handlers.delete(fn);
}

export async function connectEvents(): Promise<void> {
  const t = await loadToken();
  if (!t) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  closedByUs = false;

  try {
    ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/v1/events?token=${encodeURIComponent(t)}`);
  } catch {
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    backoff = 1000;
  };
  ws.onmessage = (e: MessageEvent) => {
    try {
      const msg = JSON.parse(String(e.data)) as HelperEvent;
      for (const fn of handlers) fn(msg);
    } catch {
      /* 忽略无法解析的消息 */
    }
  };
  ws.onclose = () => {
    ws = null;
    if (!closedByUs) scheduleReconnect();
  };
  ws.onerror = () => {
    try {
      ws?.close();
    } catch {
      /* noop */
    }
  };
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    backoff = Math.min(backoff * 2, 5000);
    void connectEvents();
  }, backoff);
}

export function disconnectEvents(): void {
  closedByUs = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  try {
    ws?.close();
  } catch {
    /* noop */
  }
  ws = null;
  handlers = new Set();
}

export const CLIENT_VERSION = PSAI_VERSION;
export const HELPER_BASE = BASE;
