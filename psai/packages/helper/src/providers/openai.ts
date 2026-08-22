/**
 * OpenAI 兼容族适配器：Comfly / 魔搭 ModelScope / 火山方舟 / 阿里百炼 / 自定义网站。
 *
 * 这些平台协议一致但字段细节有差异，差异都收敛在这里：
 *   文生图  POST {base}/images/generations
 *   图生图  POST {base}/images/edits        （multipart，部分平台走 generations + image 字段）
 *   视觉    POST {base}/chat/completions    （image_url 传 data URI）
 *   模型    GET  {base}/models
 *
 * 这一族都是同步接口：提交即等结果，没有服务端任务 id，也没有取消接口。
 * 所以 submit() 直接把结果带回来，cancel() 如实报告不支持。
 */

import { randomUUID } from 'node:crypto';
import { PsaiError, toErrorShape } from '@psai/shared';
import type { ProviderCapability } from '@psai/shared';
import type {
  ProviderAdapter,
  SubmitContext,
  SubmitResult,
  PollResult,
  ResultImage,
  TestResult,
  CancelResult,
  TextCompleteInput
} from './types.js';
import { emptyProgress } from './types.js';
import { httpFetch, ensureOk, jsonOf, normalizeBaseUrl, buildMultipart } from './http.js';
import type { Logger } from '../log.js';

export interface OpenAiOptions {
  id: string;
  label: string;
  baseUrl: string;
  apiKey: string | null;
  defaultModel: string;
  timeoutMs: number;
  capabilities: ProviderCapability[];
}

interface ImagePayload {
  b64_json?: string;
  url?: string;
  /** 部分平台把图放在 image 字段 */
  image?: string;
}

interface ImagesResponse {
  data?: ImagePayload[];
  /** 火山/百炼有时用 output 包一层 */
  output?: { results?: ImagePayload[]; choices?: unknown[] };
  error?: { message?: string; code?: string };
}

const RESULT_TTL_MS = 30 * 60 * 1000;

export class OpenAiCompatibleAdapter implements ProviderAdapter {
  readonly id: string;
  private results = new Map<string, { at: number; images: ResultImage[] }>();

  constructor(
    private opts: OpenAiOptions,
    private readonly log: Logger
  ) {
    this.id = opts.id;
  }

  updateOptions(opts: OpenAiOptions): void {
    this.opts = opts;
  }

  private base(): string {
    return normalizeBaseUrl(this.opts.baseUrl);
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { ...extra };
    if (this.opts.apiKey) h['Authorization'] = `Bearer ${this.opts.apiKey}`;
    return h;
  }

  isConfigured(): boolean {
    return /^https?:\/\/.+/.test(this.opts.baseUrl.trim()) && !!this.opts.apiKey;
  }

  notConfiguredReason(): string {
    if (!/^https?:\/\/.+/.test(this.opts.baseUrl.trim())) return `${this.opts.label} 的接口地址未填写`;
    if (!this.opts.apiKey) return `${this.opts.label} 的 API Key 未配置`;
    return '';
  }

  private requireConfigured(): void {
    if (!this.isConfigured()) throw new PsaiError('PROVIDER_NOT_CONFIGURED', this.notConfiguredReason());
  }

  async capabilities(): Promise<ProviderCapability[]> {
    return this.opts.capabilities;
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
    const url = `${this.base()}/models`;
    const t0 = Date.now();
    try {
      const res = await ensureOk(
        await httpFetch(url, { headers: this.headers(), timeoutMs: this.opts.timeoutMs }),
        url
      );
      const json = await jsonOf<{ data?: Array<{ id?: string }> }>(res, url);
      const n = json.data?.length ?? 0;
      const latency = Date.now() - t0;
      return { ok: true, latencyMs: latency, detail: `鉴权通过 · ${n} 个模型 · ${latency}ms`, info: { models: n } };
    } catch (e) {
      const shape = toErrorShape(e, 'PROVIDER_UNREACHABLE');
      return { ok: false, latencyMs: null, detail: shape.details ?? shape.message, error: shape };
    }
  }

  async listModels(): Promise<string[]> {
    this.requireConfigured();
    const url = `${this.base()}/models`;
    const res = await ensureOk(await httpFetch(url, { headers: this.headers(), timeoutMs: this.opts.timeoutMs }), url);
    const json = await jsonOf<{ data?: Array<{ id?: string }> }>(res, url);
    return (json.data ?? []).map((m) => m.id).filter((x): x is string => !!x);
  }

  /* ---------------- 生图 ---------------- */

  async submit(ctx: SubmitContext): Promise<SubmitResult> {
    this.requireConfigured();
    const model = ctx.model || this.opts.defaultModel;
    if (!model) throw new PsaiError('JOB_PARAM_INVALID', `${this.opts.label}: 未选择模型`);

    const width = Number(ctx.params['__width'] ?? 1024);
    const height = Number(ctx.params['__height'] ?? 1024);
    const size = `${width}x${height}`;
    const prompt = (ctx.prompt ?? '').trim();
    if (!prompt) throw new PsaiError('JOB_PARAM_INVALID', '提示词为空');

    const images = ctx.inputs;
    if (images.length > 1 && !this.opts.capabilities.includes('multiImageInput')) {
      throw new PsaiError(
        'PROVIDER_UNSUPPORTED',
        `${this.opts.label} 不支持多图输入（收到 ${images.length} 张）。请只用第 1 张，或换一个支持多图的后端。`
      );
    }

    const remoteId = `oai_${randomUUID()}`;
    const out = images.length === 0
      ? await this.textToImage({ model, prompt, size, ctx })
      : await this.imageToImage({ model, prompt, size, ctx });

    this.results.set(remoteId, { at: Date.now(), images: out });
    this.gc();
    return { remoteId, immediateResults: out };
  }

  private async textToImage(a: { model: string; prompt: string; size: string; ctx: SubmitContext }): Promise<ResultImage[]> {
    const url = `${this.base()}/images/generations`;
    const body: Record<string, unknown> = {
      model: a.model,
      prompt: a.prompt,
      size: a.size,
      n: 1,
      response_format: 'b64_json'
    };
    const neg = (a.ctx.negativePrompt ?? '').trim();
    if (neg) body['negative_prompt'] = neg;
    const seed = a.ctx.params['seed'];
    if (typeof seed === 'number') body['seed'] = seed;

    const res = await httpFetch(url, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
      timeoutMs: Math.max(this.opts.timeoutMs, 180_000)
    });
    return this.readImages(await this.okJson(res, url), url);
  }

  private async imageToImage(a: { model: string; prompt: string; size: string; ctx: SubmitContext }): Promise<ResultImage[]> {
    // 优先走 /images/edits（multipart）；平台不支持时回退到 generations + image data URI
    const url = `${this.base()}/images/edits`;
    const parts: Array<{ name: string; value: string } | { name: string; filename: string; mime: string; data: Buffer }> = [
      { name: 'model', value: a.model },
      { name: 'prompt', value: a.prompt },
      { name: 'size', value: a.size },
      { name: 'n', value: '1' },
      { name: 'response_format', value: 'b64_json' }
    ];
    a.ctx.inputs.forEach((img, i) => {
      parts.push({
        name: a.ctx.inputs.length > 1 ? 'image[]' : 'image',
        filename: img.filename || `input_${i}.png`,
        mime: img.mime,
        data: img.buffer
      });
    });
    const { body, contentType } = buildMultipart(parts);

    const res = await httpFetch(url, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': contentType }),
      body,
      timeoutMs: Math.max(this.opts.timeoutMs, 180_000)
    });

    if (res.status === 404 || res.status === 405) {
      this.log.debug(`${this.opts.label} 没有 /images/edits，回退到 generations + image`, { status: res.status });
      return this.editViaGenerations(a);
    }
    return this.readImages(await this.okJson(res, url), url);
  }

  private async editViaGenerations(a: { model: string; prompt: string; size: string; ctx: SubmitContext }): Promise<ResultImage[]> {
    const url = `${this.base()}/images/generations`;
    const dataUris = a.ctx.inputs.map((i) => `data:${i.mime};base64,${i.buffer.toString('base64')}`);
    const body: Record<string, unknown> = {
      model: a.model,
      prompt: a.prompt,
      size: a.size,
      n: 1,
      response_format: 'b64_json',
      image: dataUris.length === 1 ? dataUris[0] : dataUris
    };
    const res = await httpFetch(url, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
      timeoutMs: Math.max(this.opts.timeoutMs, 180_000)
    });
    return this.readImages(await this.okJson(res, url), url);
  }

  private async okJson(res: Response, url: string): Promise<ImagesResponse> {
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const { codeForStatus } = await import('./http.js');
      throw new PsaiError(codeForStatus(res.status), `${this.opts.label} HTTP ${res.status}: ${text.slice(0, 600)}`);
    }
    return jsonOf<ImagesResponse>(res, url);
  }

  private async readImages(json: ImagesResponse, url: string): Promise<ResultImage[]> {
    if (json.error?.message) throw new PsaiError('PROVIDER_BAD_RESPONSE', json.error.message);
    const payloads = json.data ?? json.output?.results ?? [];
    const out: ResultImage[] = [];
    for (const p of payloads) {
      const b64 = p.b64_json ?? (p.image && !p.image.startsWith('http') ? p.image : undefined);
      if (b64) {
        out.push({ buffer: Buffer.from(stripDataUri(b64), 'base64'), mime: 'image/png' });
        continue;
      }
      const link = p.url ?? (p.image?.startsWith('http') ? p.image : undefined);
      if (link) {
        const res = await ensureOk(await httpFetch(link, { timeoutMs: 120_000 }), link);
        const ct = res.headers.get('content-type') ?? 'image/png';
        out.push({ buffer: Buffer.from(await res.arrayBuffer()), mime: ct.split(';')[0] ?? 'image/png' });
      }
    }
    if (out.length === 0) {
      throw new PsaiError('PROVIDER_BAD_RESPONSE', `${url} 没有返回任何图像`);
    }
    return out;
  }

  /* ---------------- 视觉 / 文本 ---------------- */

  async textComplete(input: TextCompleteInput): Promise<string> {
    this.requireConfigured();
    if (!this.opts.capabilities.includes('vision') && (input.images?.length ?? 0) > 0) {
      throw new PsaiError('PROVIDER_UNSUPPORTED', `${this.opts.label} 不支持图像理解`);
    }
    const model = input.model || this.opts.defaultModel;
    if (!model) throw new PsaiError('JOB_PARAM_INVALID', `${this.opts.label}: 未选择模型`);

    const content: unknown[] = [];
    for (const img of input.images ?? []) {
      content.push({
        type: 'image_url',
        image_url: { url: `data:${img.mime};base64,${img.buffer.toString('base64')}` }
      });
    }
    const text = [input.instruction, input.userText].filter(Boolean).join('\n\n');
    content.push({ type: 'text', text });

    const url = `${this.base()}/chat/completions`;
    const res = await httpFetch(url, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content }],
        max_tokens: input.maxTokens ?? 800,
        temperature: 0.4
      }),
      timeoutMs: Math.max(this.opts.timeoutMs, 120_000)
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      const { codeForStatus } = await import('./http.js');
      throw new PsaiError(codeForStatus(res.status), `${this.opts.label} HTTP ${res.status}: ${t.slice(0, 500)}`);
    }
    const json = await jsonOf<{ choices?: Array<{ message?: { content?: string } }> }>(res, url);
    const out = json.choices?.[0]?.message?.content?.trim();
    if (!out) throw new PsaiError('PROVIDER_BAD_RESPONSE', '模型没有返回文本');
    return out;
  }

  /* ---------------- 状态 ---------------- */

  async poll(remoteId: string): Promise<PollResult> {
    const hit = this.results.get(remoteId);
    if (hit) return { state: 'done', progress: { ...emptyProgress('已完成'), value: 1 } };
    return { state: 'unknown' };
  }

  async fetchResults(remoteId: string): Promise<ResultImage[]> {
    const hit = this.results.get(remoteId);
    if (!hit) throw new PsaiError('JOB_LOST', '同步型云接口的结果已过期，请重新提交');
    return hit.images;
  }

  async cancel(): Promise<CancelResult> {
    return {
      ok: false,
      reason: `${this.opts.label} 是同步接口，请求发出后无法取消；本地会停止等待，但费用可能已经产生。`
    };
  }

  private gc(): void {
    const cutoff = Date.now() - RESULT_TTL_MS;
    for (const [k, v] of this.results) if (v.at < cutoff) this.results.delete(k);
  }
}

function stripDataUri(s: string): string {
  const i = s.indexOf('base64,');
  return i >= 0 ? s.slice(i + 7) : s;
}
