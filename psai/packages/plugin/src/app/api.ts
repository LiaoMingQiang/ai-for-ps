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
  WorkflowRecord,
  ParamBinding,
  PsaiErrorShape
} from '@psai/shared';

/**
 * Helper 地址候选。
 *
 * 不写死一个：UXP 的网络白名单、宿主的 DNS 解析、IPv4/IPv6 偏好在不同机器上都可能不同，
 * `127.0.0.1` 通不了而 `localhost` 通得了（或反过来）是真实会发生的。
 * 启动时逐个探，谁通用谁，结果缓存下来。
 */
const BASE_CANDIDATES = [
  `http://127.0.0.1:${HELPER_DEFAULT_PORT}`,
  `http://localhost:${HELPER_DEFAULT_PORT}`
];

let BASE = BASE_CANDIDATES[0]!;

/** 每个候选地址最近一次的探测结果，离线页面直接把它显示出来。 */
export interface ProbeResult {
  url: string;
  ok: boolean;
  detail: string;
}

let lastProbes: ProbeResult[] = [];

export function probeResults(): ProbeResult[] {
  return lastProbes;
}

export function currentBase(): string {
  return BASE;
}

/**
 * 逐个探候选地址，选中第一个能返回 /v1/health 的。
 * 全部失败时把每个的具体报错留在 lastProbes 里 —— 排查全靠这些原文，不能吞。
 */
export async function resolveBase(): Promise<{ ok: boolean; probes: ProbeResult[] }> {
  const probes: ProbeResult[] = [];
  for (const url of BASE_CANDIDATES) {
    try {
      const res = await fetch(`${url}/v1/health`);
      const text = await res.text();
      if (res.ok && text.includes('"online"')) {
        BASE = url;
        probes.push({ url, ok: true, detail: `HTTP ${res.status}` });
        lastProbes = probes;
        return { ok: true, probes };
      }
      probes.push({ url, ok: false, detail: `HTTP ${res.status} ${text.slice(0, 120)}` });
    } catch (e) {
      probes.push({ url, ok: false, detail: e instanceof Error ? `${e.name}: ${e.message}` : String(e) });
    }
  }
  lastProbes = probes;
  return { ok: false, probes };
}

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

/**
 * 直接指定 Helper 地址与已有 token，跳过探测与配对。
 *
 * 两个用处：
 *  - 用户把 Helper 跑在非默认端口时（PSAI_PORT），面板得能被指过去
 *  - 页面渲染冒烟测试要连自己起的那个临时 Helper，不能去碰用户真正在用的那一个
 */
export function useHelperAt(baseUrl: string, existingToken?: string): void {
  BASE = baseUrl.replace(/\/+$/, '');
  lastProbes = [{ url: BASE, ok: true, detail: '由调用方指定' }];
  if (existingToken) token = existingToken;
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

/**
 * 401 时自动重新配对，然后把这次请求重放一遍。
 *
 * 之前 ensurePaired() 只在「从离线变成在线」那一刻调用一次。
 * 于是 token 一旦失效（Helper 换了数据目录、用户点过「重新配对」把旧 token 吊销、
 * 重装过 Helper），插件就永远卡在 401 上：/v1/health 是免鉴权的，状态条照样显示
 * 绿色的「已连接」，可下面每一个卡片都是「未配对或配对已失效」。
 * 界面说连上了、功能全是坏的，这是最难自查的一种状态。
 *
 * 所以改成在请求层自愈：收到 401 就重新配对一次再重放。
 * pairingInFlight 保证并发的多个请求只会触发一次配对，
 * retried 保证只重放一次，配对完还是 401 就如实报错，不会打转。
 */
let pairingInFlight: Promise<boolean> | null = null;

async function repairPairing(): Promise<boolean> {
  if (!pairingInFlight) {
    pairingInFlight = (async () => {
      await clearToken();
      const req = await request<{ challenge: string }>('POST', '/v1/pair/request', { client: 'uxp' }, { auth: false });
      const confirm = await request<{ token: string }>(
        'POST',
        '/v1/pair/confirm',
        { challenge: req.challenge },
        { auth: false }
      );
      await saveToken(confirm.token);
      return true;
    })().finally(() => {
      pairingInFlight = null;
    });
  }
  return pairingInFlight;
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  opts: { auth?: boolean; retried?: boolean } = {}
): Promise<T> {
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
    // 把原始报错原样带上。fetch 失败的原因可能是 Helper 没起、UXP 网络白名单没放行、
    // 也可能是 CORS —— 这三种的处理方式完全不同，吞掉细节等于把排查线索一起吞了。
    const raw = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    throw new ApiError(
      {
        code: 'HELPER_OFFLINE',
        message: `连不上本地 Helper（${BASE}）`,
        details: raw,
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
    const shape = obj.error ?? { code: 'INTERNAL_ERROR', message: `HTTP ${res.status}`, retryable: false };
    // token 失效就地重新配对再重放一次；配对本身走的是免鉴权端点，不会递归
    if (shape.code === 'HELPER_UNAUTHORIZED' && opts.auth !== false && !opts.retried) {
      await repairPairing();
      return request<T>(method, path, body, { ...opts, retried: true });
    }
    throw new ApiError(shape, res.status);
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

/**
 * 自动配对：面板打开时静默完成，用户不需要做任何事。
 *
 * 已经有 token 就先拿一个真实请求验一下 —— 那个请求自己会在 401 时
 * 触发 repairPairing() 并重放，所以这里不用再写一遍失效处理。
 */
export async function ensurePaired(): Promise<boolean> {
  if (await loadToken()) {
    await request('GET', '/v1/settings');
    return true;
  }
  return repairPairing();
}

/* ---------------- 各资源 ---------------- */

export const api = {
  system: () => request<{ dataDir: string; logsDir: string; assetBytes: number; freeBytes: number | null; platform: string; node: string }>('GET', '/v1/system'),
  gpu: () => request<{ gpu: GpuInfo }>('GET', '/v1/gpu').then((r) => r.gpu),
  /** 按 Provider 汇总的用量，「关于」页展示 */
  usage: () =>
    request<{ usage: Array<{ providerId: string; runs: number; gpuMs: number; lastAt: number }> }>(
      'GET',
      '/v1/usage'
    ).then((r) => r.usage),

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
  workflow: (id: string) =>
    request<{ workflow: WorkflowRecord }>('GET', `/v1/workflows/${encodeURIComponent(id)}`).then((r) => r.workflow),
  /** 保存导入工作流的参数绑定。扫描器猜错的地方，用户在设置里改完存回来。 */
  saveWorkflowBindings: (id: string, bindings: ParamBinding[]) =>
    request<{ workflow: WorkflowRecord }>('PUT', `/v1/workflows/${encodeURIComponent(id)}/bindings`, {
      bindings
    }).then((r) => r.workflow),
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
export { BASE_CANDIDATES };
