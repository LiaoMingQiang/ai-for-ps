/**
 * RunningHub 云端 ComfyUI 适配器。
 *
 *   POST /task/openapi/upload            上传输入图，拿 fileName
 *   POST /task/openapi/create            用云端 workflowId + nodeInfoList 创建任务 → taskId
 *   POST /task/openapi/status            查状态
 *   POST /task/openapi/outputs           取结果（图片 URL 列表）
 *
 * 官方没有取消接口 —— cancel() 如实返回不支持，并告诉用户任务会继续在云端执行并计费。
 * 这一点必须诚实，否则用户以为取消了却继续被扣费。
 */

import { PsaiError, toErrorShape } from '@psai/shared';
import type { JobProgress, ProviderCapability } from '@psai/shared';
import type {
  ProviderAdapter,
  SubmitContext,
  SubmitResult,
  PollResult,
  ResultImage,
  TestResult,
  CancelResult
} from './types.js';
import { emptyProgress } from './types.js';
import { httpFetch, jsonOf, normalizeBaseUrl, codeForStatus, buildMultipart, ensureOk } from './http.js';
import type { Logger } from '../log.js';

export interface RunningHubOptions {
  baseUrl: string;
  apiKey: string | null;
  defaultWorkflowId: string;
  timeoutMs: number;
}

interface RhEnvelope<T> {
  code?: number;
  msg?: string;
  data?: T;
}

export class RunningHubAdapter implements ProviderAdapter {
  readonly id = 'runninghub';

  constructor(
    private opts: RunningHubOptions,
    private readonly log: Logger
  ) {}

  updateOptions(opts: RunningHubOptions): void {
    this.opts = opts;
  }

  private base(): string {
    return normalizeBaseUrl(this.opts.baseUrl);
  }

  isConfigured(): boolean {
    return /^https?:\/\/.+/.test(this.opts.baseUrl.trim()) && !!this.opts.apiKey;
  }

  notConfiguredReason(): string {
    if (!/^https?:\/\/.+/.test(this.opts.baseUrl.trim())) return 'RunningHub 接口地址未填写';
    if (!this.opts.apiKey) return 'RunningHub API Key 未配置';
    return '';
  }

  private requireConfigured(): void {
    if (!this.isConfigured()) throw new PsaiError('PROVIDER_NOT_CONFIGURED', this.notConfiguredReason());
  }

  async capabilities(): Promise<ProviderCapability[]> {
    return ['workflow', 'textToImage', 'imageToImage', 'multiImageInput', 'progress', 'listModels'];
  }

  private async post<T>(path: string, body: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    const url = `${this.base()}${path}`;
    const res = await httpFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Host: hostOf(this.base()) },
      body: JSON.stringify({ apiKey: this.opts.apiKey, ...body }),
      timeoutMs: timeoutMs ?? this.opts.timeoutMs
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new PsaiError(codeForStatus(res.status), `RunningHub HTTP ${res.status}: ${t.slice(0, 500)}`);
    }
    const json = await jsonOf<RhEnvelope<T>>(res, url);
    if (json.code !== undefined && json.code !== 0) {
      const msg = json.msg ?? `code=${json.code}`;
      const code = /key|auth|token/i.test(msg)
        ? 'PROVIDER_AUTH_FAILED'
        : /balance|quota|余额|额度/i.test(msg)
          ? 'PROVIDER_QUOTA_EXCEEDED'
          : /limit|频繁|排队/i.test(msg)
            ? 'PROVIDER_RATE_LIMIT'
            : 'PROVIDER_BAD_RESPONSE';
      throw new PsaiError(code, `RunningHub: ${msg}`);
    }
    if (json.data === undefined) {
      throw new PsaiError('PROVIDER_BAD_RESPONSE', `RunningHub ${path} 没有返回 data`);
    }
    return json.data;
  }

  async testConnection(): Promise<TestResult> {
    if (!this.isConfigured()) {
      const reason = this.notConfiguredReason();
      return {
        ok: false,
        latencyMs: null,
        detail: reason,
        error: toErrorShape(new PsaiError('PROVIDER_NOT_CONFIGURED', reason))
      };
    }
    const t0 = Date.now();
    try {
      // 用账户信息接口做最小代价的鉴权验证
      await this.post<unknown>('/uc/openapi/accountStatus', {});
      const latency = Date.now() - t0;
      return { ok: true, latencyMs: latency, detail: `鉴权通过 · ${latency}ms` };
    } catch (e) {
      const shape = toErrorShape(e, 'PROVIDER_UNREACHABLE');
      return { ok: false, latencyMs: null, detail: shape.details ?? shape.message, error: shape };
    }
  }

  async listModels(): Promise<string[]> {
    // RunningHub 以工作流为单位，不暴露模型列表
    throw new PsaiError('PROVIDER_UNSUPPORTED', 'RunningHub 以云端工作流为单位，没有可拉取的模型列表');
  }

  async uploadImage(buf: Buffer, filename: string, mime: string): Promise<string> {
    this.requireConfigured();
    const url = `${this.base()}/task/openapi/upload`;
    const { body, contentType } = buildMultipart([
      { name: 'apiKey', value: this.opts.apiKey! },
      { name: 'fileType', value: 'image' },
      { name: 'file', filename, mime, data: buf }
    ]);
    const res = await ensureOk(
      await httpFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': contentType },
        body,
        timeoutMs: Math.max(this.opts.timeoutMs, 120_000)
      }),
      url
    );
    const json = await jsonOf<RhEnvelope<{ fileName?: string }>>(res, url);
    if (json.code !== undefined && json.code !== 0) {
      throw new PsaiError('PROVIDER_BAD_RESPONSE', `RunningHub 上传失败: ${json.msg ?? json.code}`);
    }
    const name = json.data?.fileName;
    if (!name) throw new PsaiError('PROVIDER_BAD_RESPONSE', 'RunningHub 上传后没有返回 fileName');
    return name;
  }

  async submit(ctx: SubmitContext): Promise<SubmitResult> {
    this.requireConfigured();
    const workflowId = ctx.remoteWorkflowId || this.opts.defaultWorkflowId;
    if (!workflowId) {
      throw new PsaiError('WORKFLOW_NOT_BOUND', 'RunningHub 需要先在设置里填写云端工作流 ID');
    }

    // 输入图先传上去，再按绑定表把 fileName 写进对应节点
    const uploaded: Record<string, string> = {};
    for (const img of ctx.inputs) {
      uploaded[`${img.paramId}[${img.index}]`] = await this.uploadImage(img.buffer, img.filename, img.mime);
      if (img.index === 0) uploaded[img.paramId] = uploaded[`${img.paramId}[${img.index}]`]!;
    }

    // nodeInfoList 来自本地工作流的绑定表：告诉云端要覆盖哪些节点的哪些字段
    const nodeInfoList: Array<{ nodeId: string; fieldName: string; fieldValue: unknown }> = [];
    for (const b of ctx.workflow?.bindings ?? []) {
      const value = uploaded[b.paramId] ?? ctx.params[b.paramId];
      if (value === undefined || value === null || value === '') continue;
      nodeInfoList.push({ nodeId: b.nodeId, fieldName: b.input, fieldValue: value });
    }

    const data = await this.post<{ taskId?: string; taskStatus?: string }>(
      '/task/openapi/create',
      { workflowId, nodeInfoList },
      Math.max(this.opts.timeoutMs, 60_000)
    );
    if (!data.taskId) throw new PsaiError('PROVIDER_BAD_RESPONSE', 'RunningHub 没有返回 taskId');
    return { remoteId: data.taskId };
  }

  async poll(remoteId: string): Promise<PollResult> {
    this.requireConfigured();
    try {
      const raw = await this.post<unknown>('/task/openapi/status', { taskId: remoteId });
      const status = normalizeStatus(raw);
      switch (status) {
        case 'QUEUED':
          return { state: 'queued', progress: progressFor(0, '云端排队中') };
        case 'RUNNING':
          return { state: 'running', progress: progressFor(0.5, '云端生成中（该平台不提供细粒度进度）') };
        case 'SUCCESS':
          return { state: 'done', progress: progressFor(1, '已完成') };
        case 'FAILED':
          return { state: 'failed', error: toErrorShape(new PsaiError('JOB_FAILED', 'RunningHub 报告任务失败')) };
        default:
          return { state: 'unknown' };
      }
    } catch (e) {
      const shape = toErrorShape(e);
      if (shape.retryable) return { state: 'unknown' };
      return { state: 'failed', error: shape };
    }
  }

  async fetchResults(remoteId: string): Promise<ResultImage[]> {
    this.requireConfigured();
    const data = await this.post<Array<{ fileUrl?: string; fileType?: string }> | { files?: Array<{ fileUrl?: string }> }>(
      '/task/openapi/outputs',
      { taskId: remoteId },
      Math.max(this.opts.timeoutMs, 60_000)
    );
    const list = Array.isArray(data) ? data : (data.files ?? []);
    const out: ResultImage[] = [];
    for (const item of list) {
      const url = item.fileUrl;
      if (!url) continue;
      const res = await ensureOk(await httpFetch(url, { timeoutMs: 180_000 }), url);
      const ct = res.headers.get('content-type') ?? 'image/png';
      if (!ct.startsWith('image/')) continue;
      out.push({ buffer: Buffer.from(await res.arrayBuffer()), mime: ct.split(';')[0] ?? 'image/png' });
    }
    if (out.length === 0) throw new PsaiError('WORKFLOW_NO_OUTPUT', 'RunningHub 任务完成但没有图像输出');
    return out;
  }

  async cancel(): Promise<CancelResult> {
    this.log.info('RunningHub 取消请求：官方无取消接口，如实告知用户');
    return {
      ok: false,
      reason: 'RunningHub 没有提供取消接口，任务会继续在云端执行并计费。你可以选择丢弃结果，但费用无法撤销。'
    };
  }
}

function progressFor(value: number, message: string): JobProgress {
  return { ...emptyProgress(message), value };
}

function normalizeStatus(raw: unknown): 'QUEUED' | 'RUNNING' | 'SUCCESS' | 'FAILED' | 'UNKNOWN' {
  const s = (typeof raw === 'string' ? raw : ((raw as { taskStatus?: string })?.taskStatus ?? '')).toUpperCase();
  if (['QUEUED', 'QUEUE', 'WAITING', 'PENDING'].includes(s)) return 'QUEUED';
  if (['RUNNING', 'PROCESSING', 'EXECUTING'].includes(s)) return 'RUNNING';
  if (['SUCCESS', 'SUCCEED', 'SUCCEEDED', 'COMPLETED', 'FINISHED'].includes(s)) return 'SUCCESS';
  if (['FAILED', 'FAIL', 'ERROR', 'CANCELED', 'CANCELLED'].includes(s)) return 'FAILED';
  return 'UNKNOWN';
}

function hostOf(base: string): string {
  try {
    return new URL(base).host;
  } catch {
    return '';
  }
}
