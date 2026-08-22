/**
 * ComfyUI 适配器（本地 / 远程 / 本地服务器）。
 *
 * 官方接口：
 *   GET  /system_stats            健康与版本
 *   GET  /object_info             全部节点与输入枚举（采样器 / 模型列表 / 依赖预检）
 *   POST /upload/image            multipart 上传输入图
 *   POST /prompt                  提交 {prompt, client_id} → {prompt_id}
 *   WS   /ws?clientId=            进度：status / progress / executing / executed / execution_error
 *   GET  /history/{prompt_id}     取结果
 *   GET  /view?filename=&...      下载结果图
 *   GET  /queue                   队列快照
 *   POST /queue {delete:[id]}     删除排队中的任务
 *   POST /interrupt               中断正在执行的任务
 *
 * 恢复纪律：Helper 重启后先查 /history 与 /queue，**绝不重复提交**。
 */

import { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { PsaiError, toErrorShape } from '@psai/shared';
import type { JobProgress, ProviderCapability } from '@psai/shared';
import type {
  ProviderAdapter,
  SubmitContext,
  SubmitResult,
  PollResult,
  ResultImage,
  TestResult,
  CancelResult,
  RemoteState
} from './types.js';
import { emptyProgress } from './types.js';
import { httpFetch, ensureOk, jsonOf, buildMultipart, normalizeBaseUrl } from './http.js';
import { applyBindings } from '../workflows/bindings.js';
import type { BindingValues } from '../workflows/bindings.js';
import type { Logger } from '../log.js';

interface ComfyHistoryEntry {
  status?: { completed?: boolean; status_str?: string; messages?: unknown[] };
  outputs?: Record<string, { images?: Array<{ filename: string; subfolder: string; type: string }> }>;
}

interface ComfyQueue {
  queue_running?: unknown[][];
  queue_pending?: unknown[][];
}

export interface ComfyOptions {
  baseUrl: string;
  timeoutMs: number;
}

type ProgressListener = (p: JobProgress) => void;

export class ComfyUiAdapter implements ProviderAdapter {
  readonly id = 'comfyui';

  private clientId = randomUUID();
  private ws: WebSocket | null = null;
  private wsReady = false;
  private listeners = new Map<string, Set<ProgressListener>>();
  /** prompt_id → 最近一次进度，供轮询兜底 */
  private lastProgress = new Map<string, JobProgress>();
  private remoteErrors = new Map<string, string>();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor(
    private opts: ComfyOptions,
    private readonly log: Logger
  ) {}

  updateOptions(opts: ComfyOptions): void {
    const changed = opts.baseUrl !== this.opts.baseUrl;
    this.opts = opts;
    if (changed) {
      this.closeWs();
      this.lastProgress.clear();
      this.remoteErrors.clear();
    }
  }

  private base(): string {
    return normalizeBaseUrl(this.opts.baseUrl);
  }

  isConfigured(): boolean {
    return /^https?:\/\/.+/.test(this.opts.baseUrl.trim());
  }

  notConfiguredReason(): string {
    return this.isConfigured() ? '' : 'ComfyUI 地址未填写或格式不正确';
  }

  /* ---------------- 健康与能力 ---------------- */

  async testConnection(): Promise<TestResult> {
    if (!this.isConfigured()) {
      return {
        ok: false,
        latencyMs: null,
        detail: this.notConfiguredReason(),
        error: toErrorShape(new PsaiError('PROVIDER_NOT_CONFIGURED', this.notConfiguredReason()))
      };
    }
    const url = `${this.base()}/system_stats`;
    const t0 = Date.now();
    try {
      const res = await ensureOk(await httpFetch(url, { timeoutMs: this.opts.timeoutMs }), url);
      const stats = await jsonOf<{ system?: { comfyui_version?: string; os?: string } }>(res, url);
      const latency = Date.now() - t0;
      let nodeCount: number | null = null;
      try {
        nodeCount = Object.keys(await this.objectInfo()).length;
      } catch {
        /* 拿不到节点数不影响连通性判定 */
      }
      const version = stats.system?.comfyui_version ?? '未知';
      return {
        ok: true,
        latencyMs: latency,
        detail: `ComfyUI ${version}${nodeCount === null ? '' : ` · ${nodeCount} 个节点`} · ${latency}ms`,
        info: { version, nodeCount, os: stats.system?.os ?? null }
      };
    } catch (e) {
      const shape = toErrorShape(e, 'PROVIDER_UNREACHABLE');
      return { ok: false, latencyMs: null, detail: shape.details ?? shape.message, error: shape };
    }
  }

  async capabilities(): Promise<ProviderCapability[]> {
    return ['workflow', 'textToImage', 'imageToImage', 'multiImageInput', 'imageEdit', 'cancel', 'progress', 'listModels'];
  }

  private objectInfoCache: { at: number; data: Record<string, unknown> } | null = null;

  async objectInfo(force = false): Promise<Record<string, unknown>> {
    if (!force && this.objectInfoCache && Date.now() - this.objectInfoCache.at < 30_000) {
      return this.objectInfoCache.data;
    }
    const url = `${this.base()}/object_info`;
    const res = await ensureOk(await httpFetch(url, { timeoutMs: Math.max(this.opts.timeoutMs, 30_000) }), url);
    const data = await jsonOf<Record<string, unknown>>(res, url);
    this.objectInfoCache = { at: Date.now(), data };
    return data;
  }

  /** 从 /object_info 里抽出某个节点某个输入的枚举列表（采样器、checkpoint、放大模型…）。 */
  async enumOf(classType: string, inputName: string): Promise<string[]> {
    const info = await this.objectInfo();
    const node = info[classType] as
      | { input?: { required?: Record<string, unknown>; optional?: Record<string, unknown> } }
      | undefined;
    if (!node?.input) return [];
    const slot = node.input.required?.[inputName] ?? node.input.optional?.[inputName];
    if (Array.isArray(slot) && Array.isArray(slot[0])) return (slot[0] as unknown[]).map(String);
    return [];
  }

  async listModels(): Promise<string[]> {
    // ComfyUI 的"模型"就是 checkpoint 列表
    return this.enumOf('CheckpointLoaderSimple', 'ckpt_name');
  }

  async installedNodeTypes(): Promise<Set<string>> {
    return new Set(Object.keys(await this.objectInfo()));
  }

  /* ---------------- 上传与提交 ---------------- */

  async uploadImage(buf: Buffer, filename: string, mime: string): Promise<string> {
    const url = `${this.base()}/upload/image`;
    const { body, contentType } = buildMultipart([
      { name: 'image', filename, mime, data: buf },
      { name: 'overwrite', value: 'true' },
      { name: 'type', value: 'input' }
    ]);
    const res = await ensureOk(
      await httpFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': contentType },
        body,
        timeoutMs: Math.max(this.opts.timeoutMs, 60_000)
      }),
      url
    );
    const json = await jsonOf<{ name?: string; subfolder?: string }>(res, url);
    if (!json.name) throw new PsaiError('PROVIDER_BAD_RESPONSE', '上传成功但没有返回文件名');
    return json.subfolder ? `${json.subfolder}/${json.name}` : json.name;
  }

  async submit(ctx: SubmitContext): Promise<SubmitResult> {
    if (!ctx.workflow) throw new PsaiError('WORKFLOW_NOT_BOUND', `功能 ${ctx.featureId} 没有可用的工作流`);
    if (ctx.workflow.outputNodeIds.length === 0) {
      throw new PsaiError('WORKFLOW_NO_OUTPUT', ctx.workflow.name);
    }

    // 1. 输入图上传到 ComfyUI，替换成它认识的文件名
    const values: BindingValues = { ...ctx.params };
    for (const img of ctx.inputs) {
      const name = await this.uploadImage(img.buffer, img.filename, img.mime);
      if (img.index === 0) values[img.paramId] = name;
      values[`${img.paramId}[${img.index}]`] = name;
    }

    // 2. 按绑定表注入
    const { graph, report } = applyBindings(ctx.workflow.graph, ctx.workflow.bindings, values);
    if (report.skipped.length) {
      this.log.debug('部分绑定被跳过', { jobId: ctx.jobId, skipped: report.skipped });
    }

    // 3. 提交
    await this.ensureWs();
    const url = `${this.base()}/prompt`;
    const res = await httpFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: graph, client_id: this.clientId }),
      timeoutMs: Math.max(this.opts.timeoutMs, 60_000)
    });
    if (!res.ok) {
      // ComfyUI 的 400 会带完整的节点校验信息，原样透出去对排错至关重要
      const text = await res.text().catch(() => '');
      throw new PsaiError(
        res.status === 400 ? 'JOB_PARAM_INVALID' : 'PROVIDER_BAD_RESPONSE',
        `ComfyUI 拒绝了提交 (HTTP ${res.status}): ${text.slice(0, 1200)}`
      );
    }
    const json = await jsonOf<{ prompt_id?: string; error?: unknown }>(res, url);
    if (!json.prompt_id) {
      throw new PsaiError('PROVIDER_BAD_RESPONSE', `提交没有返回 prompt_id: ${JSON.stringify(json).slice(0, 500)}`);
    }
    this.lastProgress.set(json.prompt_id, emptyProgress('已提交'));
    return { remoteId: json.prompt_id };
  }

  /* ---------------- 状态与结果 ---------------- */

  async poll(remoteId: string): Promise<PollResult> {
    const err = this.remoteErrors.get(remoteId);
    if (err) {
      return { state: 'failed', error: toErrorShape(new PsaiError('JOB_FAILED', err)) };
    }

    const hist = await this.history(remoteId);
    if (hist) {
      const failed = hist.status?.status_str === 'error';
      if (failed) {
        const detail = JSON.stringify(hist.status?.messages ?? []).slice(0, 800);
        return { state: 'failed', error: toErrorShape(new PsaiError('JOB_FAILED', detail)) };
      }
      if (hist.status?.completed || countImages(hist) > 0) {
        return { state: 'done', progress: { ...emptyProgress('已完成'), value: 1 } };
      }
    }

    const q = await this.queue();
    if (q.running.includes(remoteId)) {
      return { state: 'running', progress: this.lastProgress.get(remoteId) ?? emptyProgress('生成中') };
    }
    if (q.pending.includes(remoteId)) {
      const idx = q.pending.indexOf(remoteId);
      return { state: 'queued', progress: emptyProgress(`远端排队中 · 前面还有 ${idx} 个`) };
    }

    // 既不在队列也没有历史：可能刚提交还没进队，也可能真的丢了。由上层结合时间判定。
    return { state: 'unknown' };
  }

  private async history(promptId: string): Promise<ComfyHistoryEntry | null> {
    const url = `${this.base()}/history/${encodeURIComponent(promptId)}`;
    const res = await httpFetch(url, { timeoutMs: this.opts.timeoutMs });
    if (!res.ok) return null;
    const json = await jsonOf<Record<string, ComfyHistoryEntry>>(res, url);
    return json[promptId] ?? null;
  }

  private async queue(): Promise<{ running: string[]; pending: string[] }> {
    const url = `${this.base()}/queue`;
    try {
      const res = await ensureOk(await httpFetch(url, { timeoutMs: this.opts.timeoutMs }), url);
      const json = await jsonOf<ComfyQueue>(res, url);
      return {
        running: (json.queue_running ?? []).map(promptIdOfQueueItem).filter((x): x is string => !!x),
        pending: (json.queue_pending ?? []).map(promptIdOfQueueItem).filter((x): x is string => !!x)
      };
    } catch {
      return { running: [], pending: [] };
    }
  }

  async fetchResults(remoteId: string): Promise<ResultImage[]> {
    const hist = await this.history(remoteId);
    if (!hist) throw new PsaiError('PROVIDER_BAD_RESPONSE', `历史中找不到 ${remoteId}`);
    const out: ResultImage[] = [];
    for (const nodeOut of Object.values(hist.outputs ?? {})) {
      for (const img of nodeOut.images ?? []) {
        // temp 类型是预览图，只有在没有正式输出时才用
        const params = new URLSearchParams({
          filename: img.filename,
          subfolder: img.subfolder ?? '',
          type: img.type ?? 'output'
        });
        const url = `${this.base()}/view?${params.toString()}`;
        const res = await ensureOk(await httpFetch(url, { timeoutMs: 120_000 }), url);
        const buf = Buffer.from(await res.arrayBuffer());
        out.push({ buffer: buf, mime: guessMime(img.filename) });
      }
    }
    if (out.length === 0) throw new PsaiError('WORKFLOW_NO_OUTPUT', `${remoteId} 执行完成但没有产出图像`);
    return out;
  }

  async cancel(remoteId: string, currentState: RemoteState): Promise<CancelResult> {
    try {
      if (currentState === 'running') {
        const url = `${this.base()}/interrupt`;
        await ensureOk(await httpFetch(url, { method: 'POST', timeoutMs: this.opts.timeoutMs }), url);
        return { ok: true, reason: '已中断正在执行的任务' };
      }
      const url = `${this.base()}/queue`;
      await ensureOk(
        await httpFetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ delete: [remoteId] }),
          timeoutMs: this.opts.timeoutMs
        }),
        url
      );
      return { ok: true, reason: '已从队列中移除' };
    } catch (e) {
      return { ok: false, reason: toErrorShape(e).message };
    }
  }

  /* ---------------- WebSocket 进度 ---------------- */

  subscribe(remoteId: string, onProgress: ProgressListener): () => void {
    let set = this.listeners.get(remoteId);
    if (!set) {
      set = new Set();
      this.listeners.set(remoteId, set);
    }
    set.add(onProgress);
    void this.ensureWs();
    return () => {
      set!.delete(onProgress);
      if (set!.size === 0) this.listeners.delete(remoteId);
    };
  }

  private async ensureWs(): Promise<void> {
    if (this.disposed) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    const wsUrl = `${this.base().replace(/^http/, 'ws')}/ws?clientId=${encodeURIComponent(this.clientId)}`;
    try {
      const ws = new WebSocket(wsUrl);
      this.ws = ws;
      ws.on('open', () => {
        this.wsReady = true;
        this.log.debug('ComfyUI WS 已连接', { wsUrl });
      });
      ws.on('message', (raw) => this.onWsMessage(raw));
      ws.on('close', () => {
        this.wsReady = false;
        this.scheduleReconnect();
      });
      ws.on('error', (e) => {
        this.wsReady = false;
        this.log.debug('ComfyUI WS 错误', String(e));
      });
    } catch (e) {
      this.log.debug('ComfyUI WS 建立失败，退化为轮询', String(e));
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.listeners.size > 0) void this.ensureWs();
    }, 3000);
  }

  private onWsMessage(raw: unknown): void {
    let msg: { type?: string; data?: Record<string, unknown> };
    try {
      const text = typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString('utf8') : '';
      if (!text || !text.startsWith('{')) return; // 二进制预览帧，忽略
      msg = JSON.parse(text) as typeof msg;
    } catch {
      return;
    }
    const d = msg.data ?? {};
    const promptId = typeof d['prompt_id'] === 'string' ? (d['prompt_id'] as string) : null;

    switch (msg.type) {
      case 'progress': {
        if (!promptId) return;
        const value = Number(d['value'] ?? 0);
        const max = Number(d['max'] ?? 0);
        const p: JobProgress = {
          value: max > 0 ? Math.min(1, value / max) : null,
          step: Number.isFinite(value) ? value : null,
          total: Number.isFinite(max) && max > 0 ? max : null,
          node: typeof d['node'] === 'string' ? (d['node'] as string) : null,
          message: max > 0 ? `生成中 ${value}/${max}` : '生成中'
        };
        this.emit(promptId, p);
        break;
      }
      case 'executing': {
        if (!promptId) return;
        const node = d['node'];
        const p: JobProgress = {
          ...(this.lastProgress.get(promptId) ?? emptyProgress()),
          node: typeof node === 'string' ? node : null,
          message: node === null ? '执行完成' : `执行节点 ${String(node)}`
        };
        this.emit(promptId, p);
        break;
      }
      case 'execution_error': {
        if (!promptId) return;
        const detail = [d['node_type'], d['exception_type'], d['exception_message']]
          .filter(Boolean)
          .map(String)
          .join(' · ');
        this.remoteErrors.set(promptId, detail || 'ComfyUI 执行出错');
        break;
      }
      case 'status': {
        // 队列长度变化，无 prompt_id，忽略
        break;
      }
      default:
        break;
    }
  }

  private emit(promptId: string, p: JobProgress): void {
    this.lastProgress.set(promptId, p);
    const set = this.listeners.get(promptId);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(p);
      } catch {
        /* 监听器异常不能影响别的监听器 */
      }
    }
  }

  private closeWs(): void {
    this.wsReady = false;
    try {
      this.ws?.close();
    } catch {
      /* noop */
    }
    this.ws = null;
  }

  get wsConnected(): boolean {
    return this.wsReady;
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.closeWs();
    this.listeners.clear();
  }
}

function promptIdOfQueueItem(item: unknown): string | null {
  // ComfyUI 的队列项形如 [number, prompt_id, prompt, extra, outputs]
  if (Array.isArray(item) && typeof item[1] === 'string') return item[1];
  return null;
}

function countImages(h: ComfyHistoryEntry): number {
  let n = 0;
  for (const out of Object.values(h.outputs ?? {})) n += out.images?.length ?? 0;
  return n;
}

function guessMime(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  return 'image/png';
}
