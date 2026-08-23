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

import { PsaiError, toErrorShape, rhPresetByWorkflowId } from '@psai/shared';
import type { JobProgress, ProviderCapability, ComfyApiGraph } from '@psai/shared';
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
import { bindingsToNodeInfoList } from '../workflows/bindings.js';
import type { BindingValues } from '../workflows/bindings.js';
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

  /** workflowId → 云端 API 格式图；进程内缓存，updateOptions 时清空 */
  private graphCache = new Map<string, ComfyApiGraph>();

  constructor(
    private opts: RunningHubOptions,
    private readonly log: Logger
  ) {}

  updateOptions(opts: RunningHubOptions): void {
    const keyChanged = opts.apiKey !== this.opts.apiKey || opts.baseUrl !== this.opts.baseUrl;
    this.opts = opts;
    if (keyChanged) this.graphCache.clear();
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
      // TASK_QUEUE_MAXED 是 RunningHub 的并发上限（NORMAL 账号同时只能跑 1 个任务）。
      // 它不是错误，是"再等等"—— 必须归到可重试那一类，否则第二个任务会直接判死，
      // 而用户看到的是一次莫名其妙的失败，重试一下又好了。
      const code = /TASK_QUEUE_MAXED|limit|频繁|排队|too many|busy/i.test(msg)
        ? 'PROVIDER_RATE_LIMIT'
        : /key|auth|token/i.test(msg)
          ? 'PROVIDER_AUTH_FAILED'
          : /balance|quota|余额|额度|coins/i.test(msg)
            ? 'PROVIDER_QUOTA_EXCEEDED'
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

  /**
   * 拉云端工作流的 ComfyUI API 格式图。
   *
   * 有了真图才能在提交前校验绑定、复用本地那套变换逻辑，
   * 并且只把**真正改动过**的字段放进 nodeInfoList。
   * 同一个 workflowId 在进程内缓存，避免每次提交都多打一次接口。
   */
  private async remoteGraph(workflowId: string): Promise<ComfyApiGraph> {
    const cached = this.graphCache.get(workflowId);
    if (cached) return cached;
    const data = await this.post<{ prompt?: string }>('/api/openapi/getJsonApiFormat', { workflowId });
    if (!data.prompt) {
      throw new PsaiError('PROVIDER_BAD_RESPONSE', `RunningHub 没有返回工作流 ${workflowId} 的 API 格式图`);
    }
    let graph: ComfyApiGraph;
    try {
      graph = JSON.parse(data.prompt) as ComfyApiGraph;
    } catch {
      throw new PsaiError('PROVIDER_BAD_RESPONSE', `RunningHub 返回的工作流 ${workflowId} 不是合法 JSON`);
    }
    this.graphCache.set(workflowId, graph);
    return graph;
  }

  async submit(ctx: SubmitContext): Promise<SubmitResult> {
    this.requireConfigured();
    const workflowId = ctx.remoteWorkflowId || this.opts.defaultWorkflowId;
    if (!workflowId) {
      throw new PsaiError('WORKFLOW_NOT_BOUND', 'RunningHub 需要先在设置里选一个云端工作流预设，或填写工作流 ID');
    }

    // 绑定表的来源，优先级很关键：
    //   1. 内置预设 —— 节点号是对着云端真图核对过的，最可靠
    //   2. 用户自己导入的工作流的绑定表 —— 只有当他的本地工作流就是这份云端工作流时才成立
    // 两者都没有就必须报错。空的 nodeInfoList 提交上去 RunningHub 会照跑不误，
    // 用作者预置的示例图出一张图 —— 那是一张跟用户输入毫无关系、却看起来"成功了"的图，
    // 这种假成功比直接失败危险得多。
    const preset = rhPresetByWorkflowId(workflowId);
    const bindings = preset?.bindings ?? ctx.workflow?.bindings ?? [];
    if (bindings.length === 0) {
      throw new PsaiError(
        'WORKFLOW_NOT_BOUND',
        `云端工作流 ${workflowId} 没有参数绑定表。它不是内置预设，也没有对应的本地工作流绑定 —— ` +
          `直接提交会让云端拿作者的示例图出图，结果和你的输入无关。请在设置里选一个内置预设，或先导入这份工作流并完成绑定。`
      );
    }

    if (preset?.needsMask && !ctx.inputs.some((i) => i.hasAlpha)) {
      throw new PsaiError(
        'JOB_PARAM_INVALID',
        `「${preset.label}」靠输入图的 alpha 通道识别处理区域，但这次的输入图没有透明通道。` +
          `请在 Photoshop 里先建立选区（或给图层加蒙版）再提交。`
      );
    }

    // 输入图先传上去，拿到云端文件名再按绑定落位
    const values: BindingValues = { ...ctx.params };
    for (const img of ctx.inputs) {
      const name = await this.uploadImage(img.buffer, img.filename, img.mime);
      for (const key of imageAliases(img.paramId, img.index)) values[key] = name;
    }

    const graph = await this.remoteGraph(workflowId);
    const { nodeInfoList, report } = bindingsToNodeInfoList(graph, bindings, values);
    if (report.skipped.length) {
      this.log.debug('部分云端绑定被跳过', { jobId: ctx.jobId, workflowId, skipped: report.skipped });
    }
    // 图必须真的落进去了，否则又是"跑作者的示例图"那种假成功
    const imageBindings = bindings.filter((b) => b.paramId === 'image' || b.paramId.startsWith('image['));
    if (ctx.inputs.length > 0 && imageBindings.length > 0) {
      const landed = nodeInfoList.some((n) => imageBindings.some((b) => b.nodeId === n.nodeId && b.input === n.fieldName));
      if (!landed) {
        throw new PsaiError(
          'WORKFLOW_BINDING_INVALID',
          `输入图没能写进云端工作流 ${workflowId} 的任何节点，提交会变成用作者的示例图出图。` +
            `多半是云端作者改了图，请运行 npm run verify:rh 复核绑定。`
        );
      }
    }

    const data = await this.post<{ taskId?: string; taskStatus?: string }>(
      '/task/openapi/create',
      { workflowId, nodeInfoList },
      Math.max(this.opts.timeoutMs, 60_000)
    );
    if (!data.taskId) throw new PsaiError('PROVIDER_BAD_RESPONSE', 'RunningHub 没有返回 taskId');
    this.log.info('RunningHub 已提交', {
      jobId: ctx.jobId,
      workflowId,
      preset: preset?.id ?? '(自定义绑定)',
      taskId: data.taskId,
      覆盖字段数: nodeInfoList.length
    });
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

/**
 * 一张输入图在绑定表里可能被叫成什么。
 *
 * 内置预设是按**语义**写绑定的（第一张图叫 image，第二张参考图叫 reference），
 * 而功能目录里同一个位置可能叫 image、images、background……
 * 云端预设要能挂到不同功能上，就得让这些名字互相认得。
 *
 * 只做别名，不做猜测：第 0 张永远是主图，第 1 张永远是参考图/背景图，
 * 位置语义是稳定的，不会把两张图弄反。
 */
function imageAliases(paramId: string, index: number): string[] {
  const keys = new Set<string>([`${paramId}[${index}]`]);
  if (index === 0) {
    keys.add(paramId);
    keys.add('image');
    keys.add('images');
    keys.add('image[0]');
    keys.add('images[0]');
  } else if (index === 1) {
    keys.add('reference');
    keys.add('background');
    keys.add('image[1]');
    keys.add('images[1]');
  }
  return [...keys];
}
