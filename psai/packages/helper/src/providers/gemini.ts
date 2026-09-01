/**
 * Google Gemini 适配器。
 *
 *   POST {base}/models/{model}:generateContent
 *        contents[].parts[] 里混合 { text } 与 { inline_data: { mime_type, data(base64) } }
 *        返回同样在 candidates[].content.parts[] 里，图片在 inline_data
 *   GET  {base}/models                模型列表
 *
 * 鉴权用 x-goog-api-key 头。同步接口，没有取消。
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
import { httpFetch, ensureOk, jsonOf, normalizeBaseUrl, codeForStatus } from './http.js';

export interface GeminiOptions {
  baseUrl: string;
  apiKey: string | null;
  defaultModel: string;
  timeoutMs: number;
}

interface GeminiPart {
  text?: string;
  inline_data?: { mime_type: string; data: string };
  inlineData?: { mimeType: string; data: string };
}

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: GeminiPart[] } }>;
  error?: { message?: string; status?: string };
}

const RESULT_TTL_MS = 30 * 60 * 1000;

export class GeminiAdapter implements ProviderAdapter {
  readonly id = 'gemini';
  private results = new Map<string, { at: number; images: ResultImage[] }>();

  constructor(private opts: GeminiOptions) {}

  updateOptions(opts: GeminiOptions): void {
    this.opts = opts;
  }

  private base(): string {
    return normalizeBaseUrl(this.opts.baseUrl);
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { ...extra };
    if (this.opts.apiKey) h['x-goog-api-key'] = this.opts.apiKey;
    return h;
  }

  isConfigured(): boolean {
    return /^https?:\/\/.+/.test(this.opts.baseUrl.trim()) && !!this.opts.apiKey;
  }

  notConfiguredReason(): string {
    if (!/^https?:\/\/.+/.test(this.opts.baseUrl.trim())) return 'Gemini 接口地址未填写';
    if (!this.opts.apiKey) return 'Gemini API Key 未配置';
    return '';
  }

  private requireConfigured(): void {
    if (!this.isConfigured()) throw new PsaiError('PROVIDER_NOT_CONFIGURED', this.notConfiguredReason());
  }

  async capabilities(): Promise<ProviderCapability[]> {
    return ['textToImage', 'imageToImage', 'multiImageInput', 'imageEdit', 'vision', 'listModels'];
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
      const json = await jsonOf<{ models?: unknown[] }>(res, url);
      const latency = Date.now() - t0;
      return {
        ok: true,
        latencyMs: latency,
        detail: `鉴权通过 · ${json.models?.length ?? 0} 个模型 · ${latency}ms`,
        info: { models: json.models?.length ?? 0 }
      };
    } catch (e) {
      const shape = toErrorShape(e, 'PROVIDER_UNREACHABLE');
      return { ok: false, latencyMs: null, detail: shape.details ?? shape.message, error: shape };
    }
  }

  async listModels(): Promise<string[]> {
    this.requireConfigured();
    const url = `${this.base()}/models`;
    const res = await ensureOk(await httpFetch(url, { headers: this.headers(), timeoutMs: this.opts.timeoutMs }), url);
    const json = await jsonOf<{ models?: Array<{ name?: string }> }>(res, url);
    return (json.models ?? [])
      .map((m) => (m.name ?? '').replace(/^models\//, ''))
      .filter((x) => x.length > 0);
  }

  private async generate(model: string, parts: GeminiPart[], signal?: AbortSignal): Promise<GeminiResponse> {
    const url = `${this.base()}/models/${encodeURIComponent(model)}:generateContent`;
    const res = await httpFetch(url, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ contents: [{ role: 'user', parts }] }),
      timeoutMs: Math.max(this.opts.timeoutMs, 180_000),
      // 提交进行中被取消时中止请求 —— 那是唯一能真正省下这次费用的时机
      ...(signal ? { signal } : {})
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new PsaiError(codeForStatus(res.status), `Gemini HTTP ${res.status}: ${t.slice(0, 600)}`);
    }
    const json = await jsonOf<GeminiResponse>(res, url);
    if (json.error?.message) throw new PsaiError('PROVIDER_BAD_RESPONSE', json.error.message);
    return json;
  }

  async submit(ctx: SubmitContext): Promise<SubmitResult> {
    this.requireConfigured();
    const model = ctx.model || this.opts.defaultModel;
    if (!model) throw new PsaiError('JOB_PARAM_INVALID', 'Gemini: 未选择模型');
    const prompt = (ctx.prompt ?? '').trim();
    if (!prompt) throw new PsaiError('JOB_PARAM_INVALID', '提示词为空');

    const parts: GeminiPart[] = [];
    for (const img of ctx.inputs) {
      parts.push({ inline_data: { mime_type: img.mime, data: img.buffer.toString('base64') } });
    }
    parts.push({ text: prompt });

    const json = await this.generate(model, parts, ctx.signal);
    const images = collectImages(json);
    if (images.length === 0) {
      const text = collectText(json).slice(0, 300);
      throw new PsaiError(
        'PROVIDER_BAD_RESPONSE',
        text ? `模型只返回了文本而没有图像：${text}` : 'Gemini 没有返回任何图像'
      );
    }

    const remoteId = `gem_${randomUUID()}`;
    this.results.set(remoteId, { at: Date.now(), images });
    this.gc();
    return { remoteId, immediateResults: images };
  }

  async textComplete(input: TextCompleteInput): Promise<string> {
    this.requireConfigured();
    const model = input.model || this.opts.defaultModel;
    if (!model) throw new PsaiError('JOB_PARAM_INVALID', 'Gemini: 未选择模型');
    const parts: GeminiPart[] = [];
    for (const img of input.images ?? []) {
      parts.push({ inline_data: { mime_type: img.mime, data: img.buffer.toString('base64') } });
    }
    parts.push({ text: [input.instruction, input.userText].filter(Boolean).join('\n\n') });
    const json = await this.generate(model, parts, input.signal);
    const text = collectText(json).trim();
    if (!text) throw new PsaiError('PROVIDER_BAD_RESPONSE', 'Gemini 没有返回文本');
    return text;
  }

  async poll(remoteId: string): Promise<PollResult> {
    return this.results.has(remoteId)
      ? { state: 'done', progress: { ...emptyProgress('已完成'), value: 1 } }
      : { state: 'unknown' };
  }

  async fetchResults(remoteId: string, signal?: AbortSignal): Promise<ResultImage[]> {
    void signal;
    const hit = this.results.get(remoteId);
    if (!hit) throw new PsaiError('JOB_LOST', 'Gemini 的结果已过期，请重新提交');
    return hit.images;
  }

  async cancel(): Promise<CancelResult> {
    return { ok: false, reason: 'Gemini 是同步接口，请求发出后无法取消。' };
  }

  private gc(): void {
    const cutoff = Date.now() - RESULT_TTL_MS;
    for (const [k, v] of this.results) if (v.at < cutoff) this.results.delete(k);
  }
}

function partsOf(json: GeminiResponse): GeminiPart[] {
  return json.candidates?.[0]?.content?.parts ?? [];
}

function collectImages(json: GeminiResponse): ResultImage[] {
  const out: ResultImage[] = [];
  for (const p of partsOf(json)) {
    const inline = p.inline_data ?? (p.inlineData ? { mime_type: p.inlineData.mimeType, data: p.inlineData.data } : undefined);
    if (inline?.data) {
      out.push({ buffer: Buffer.from(inline.data, 'base64'), mime: inline.mime_type || 'image/png' });
    }
  }
  return out;
}

function collectText(json: GeminiResponse): string {
  return partsOf(json)
    .map((p) => p.text ?? '')
    .join('\n')
    .trim();
}
