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


/**
 * 这个模型认不认 `response_format` 参数。
 *
 * OpenAI 新一代的 gpt-image-* 一律**只**返回 base64，并且把 `response_format`
 * 当成未知参数直接拒掉：HTTP 400 Unknown parameter: 'response_format'。
 * 而 dall-e-* 这些老接口反过来需要它，不给就返回 URL。
 *
 * 我们以前无条件发这个参数，结果整个 gpt-image 系列全军覆没 ——
 * 而那恰好是画得最好的一批。实测：去掉之后 gpt-image-1 / gpt-image-1.5 都正常出图。
 */
function acceptsResponseFormat(model: string): boolean {
  return !/^gpt-image/i.test(model.trim());
}


/**
 * 各家闭源生图模型只认固定的几种尺寸。
 *
 * 面板上的「生图比例 + 分辨率」能算出任意尺寸（比如 1280×1280），
 * 而 gpt-image-* 只收 1024x1024 / 1024x1536 / 1536x1024 / auto，
 * 给别的直接 HTTP 400：Invalid size '1280x1280'。
 * 用户拖了分辨率、点了生成、然后失败 —— 一个看得见摸得着却用不了的旋钮。
 *
 * 所以这里按模型族把请求尺寸吸附到最接近的**合法**尺寸上，
 * 挑选依据是长宽比而不是像素数：用户选 3:4 竖图，就该给竖的那个，
 * 而不是因为面积接近给个横的。
 *
 * 不认识的模型（各家 flux、seedream 等）原样透传 —— 它们大多接受任意尺寸，
 * 我们不该替不了解的平台做限制。
 */
const FIXED_SIZES: Array<{ match: RegExp; sizes: Array<[number, number]> }> = [
  // OpenAI 新一代
  { match: /^gpt-image/i, sizes: [[1024, 1024], [1024, 1536], [1536, 1024]] },
  { match: /^dall-e-3/i, sizes: [[1024, 1024], [1024, 1792], [1792, 1024]] },
  { match: /^dall-e-2/i, sizes: [[256, 256], [512, 512], [1024, 1024]] }
];

export function snapSize(model: string, width: number, height: number): string {
  const rule = FIXED_SIZES.find((r) => r.match.test(model.trim()));
  if (!rule) return `${width}x${height}`;

  const want = width / Math.max(1, height);
  const wantArea = width * height;
  let best = rule.sizes[0]!;
  let bestRatio = Infinity;
  let bestArea = Infinity;
  for (const [w, h] of rule.sizes) {
    // 先比长宽比：用对数差，这样 2:1 和 1:2 的偏离程度是对称的
    const ratioDiff = Math.abs(Math.log(w / h) - Math.log(want));
    // 长宽比一样时再比面积。dall-e-2 三个档位全是正方形，
    // 只看长宽比的话三者并列，永远选中第一个 —— 用户要 900×900 会被压到 256×256。
    const areaDiff = Math.abs(Math.log(w * h) - Math.log(Math.max(1, wantArea)));
    const closer = ratioDiff < bestRatio - 1e-9 || (Math.abs(ratioDiff - bestRatio) <= 1e-9 && areaDiff < bestArea);
    if (closer) {
      bestRatio = ratioDiff;
      bestArea = areaDiff;
      best = [w, h];
    }
  }
  return `${best[0]}x${best[1]}`;
}


/**
 * 反推提示词 / 优化提示词要走 chat/completions，得挑一个**看得懂图**的模型。
 *
 * 以前这里直接用 opts.defaultModel —— 那是「生图默认模型」。
 * 用户把它设成 flux-2-max 之类的生图模型，反推这一步就会拿生图模型去发聊天请求，
 * 报一个和「反推」八竿子打不着的错。洗图/去噪默认开着反推，
 * 于是整条路径在用户看来就是「闭源模型没有任何结果」。
 *
 * 这里按偏好顺序在该平台**实际有的**模型里挑一个，挑不到才退回默认模型。
 * 顺序上小而快的优先：反推只是给生图打个底，不值得用最贵的模型。
 */
const VISION_PREFERENCE: RegExp[] = [
  /^gpt-4o-mini$/i,
  /^gpt-4o$/i,
  /^gpt-5-mini$/i,
  /^gpt-5$/i,
  /^qwen-vl-max$/i,
  /^qwen2?\.?5?-vl/i,
  /^gemini-[\d.]+-flash$/i,
  /^glm-4v/i,
  /^claude-.*sonnet/i
];

export function pickVisionModel(models: readonly string[]): string | null {
  for (const re of VISION_PREFERENCE) {
    const hit = models.find((m) => re.test(m));
    if (hit) return hit;
  }
  return null;
}

export class OpenAiCompatibleAdapter implements ProviderAdapter {
  readonly id: string;
  private results = new Map<string, { at: number; images: ResultImage[] }>();
  /** 模型列表缓存：挑视觉模型要用，不必每次反推都去拉一遍。 */
  private modelsCache: { at: number; models: string[] } | null = null;

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
    // 吸附到该模型认的尺寸，否则面板上的分辨率滑杆会直接把请求撞成 HTTP 400
    const size = snapSize(model, width, height);
    if (size !== `${width}x${height}`) {
      this.log.debug('生图尺寸已吸附到该模型支持的档位', {
        jobId: ctx.jobId,
        model,
        requested: `${width}x${height}`,
        used: size
      });
    }
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
      n: 1
    };
    if (acceptsResponseFormat(a.model)) body['response_format'] = 'b64_json';
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
      { name: 'n', value: '1' }
    ];
    if (acceptsResponseFormat(a.model)) parts.push({ name: 'response_format', value: 'b64_json' });
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
      image: dataUris.length === 1 ? dataUris[0] : dataUris
    };
    if (acceptsResponseFormat(a.model)) body['response_format'] = 'b64_json';
    const res = await httpFetch(url, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
      timeoutMs: Math.max(this.opts.timeoutMs, 180_000)
    });
    return this.readImages(await this.okJson(res, url), url);
  }

  /**
   * 非 2xx 时把上游的错误**读懂**再抛，而不是把整个 JSON 原样塞进消息里。
   *
   * 之前这里一律走 codeForStatus()，于是 503 被映射成 PROVIDER_BAD_RESPONSE，
   * 用户看到的是「服务返回了无法解析的响应」加一坨原始 JSON。
   * 可那个响应解析得好好的，里面写得清清楚楚：
   *   当前分组 [default] 下对于模型 [flux-2-max] 无可用渠道，请联系管理员
   * 明明有一句能照做的话，却告诉用户"解析不了" —— 这是在误导排查方向。
   *
   * 所以：能解出 error.message 就用它当消息；再按状态码和文案判断这到底是
   * 「模型不可用」（换个模型就行）还是「服务不行」（等一等再试）。
   */
  private async okJson(res: Response, url: string): Promise<ImagesResponse> {
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let upstream = '';
      try {
        const j = JSON.parse(text) as { error?: { message?: string }; message?: string };
        upstream = j.error?.message ?? j.message ?? '';
      } catch {
        /* 上游没给 JSON，下面用原文截断 */
      }
      const detail = upstream || text.slice(0, 300);

      // 「无可用渠道 / 模型不存在 / 未开通」这一类：平台在线、Key 也对，就是这个模型用不了。
      // 换一个模型立刻能继续，所以要和「服务挂了」区分开。
      const modelGone =
        /无可用渠道|无可用的渠道|模型不存在|不支持该模型|未开通|no available channel|model_not_found|does not exist|not available/i.test(
          detail
        );
      // PsaiError 的第二个参数是 details、第三个才是消息覆盖。
      // 这里都只给 details，消息用错误码自带的那句 —— 那句本身就说清楚了是什么问题。
      if (modelGone) {
        throw new PsaiError(
          'PROVIDER_MODEL_UNAVAILABLE',
          `${this.opts.label}：${detail}。到「参数设置 → 模型」换一个再试，下拉里的列表是从该平台实时拉取的。`
        );
      }

      const { codeForStatus } = await import('./http.js');
      throw new PsaiError(codeForStatus(res.status), `${this.opts.label} HTTP ${res.status}：${detail}`);
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
    const model = input.model || (await this.visionModel());
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
    // 和生图走同一套错误翻译：把上游那句人话读出来，别再报「无法解析的响应」
    if (!res.ok) await this.okJson(res, url);
    const json = await jsonOf<{ choices?: Array<{ message?: { content?: string } }> }>(res, url);
    const out = json.choices?.[0]?.message?.content?.trim();
    if (!out) throw new PsaiError('PROVIDER_BAD_RESPONSE', '模型没有返回文本');
    return out;
  }

  /**
   * 挑一个能看图的模型：显式配的优先，否则在平台实际有的模型里按偏好挑。
   * 拉列表失败就退回生图默认模型 —— 至少还有机会成功，总比直接报错强。
   */
  private async visionModel(): Promise<string> {
    const fresh = this.modelsCache && Date.now() - this.modelsCache.at < 10 * 60 * 1000;
    if (!fresh) {
      try {
        this.modelsCache = { at: Date.now(), models: await this.listModels() };
      } catch {
        this.modelsCache = null;
      }
    }
    const picked = this.modelsCache ? pickVisionModel(this.modelsCache.models) : null;
    if (picked) return picked;
    return this.opts.defaultModel;
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
