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
import {
  PsaiError,
  toErrorShape,
  imageRouteFor,
  normalizeMidjourneyPrompt,
  pickPromptModel,
  planImageSize,
  DEFAULT_PROMPT_MODEL
} from '@psai/shared';
import type { ProviderCapability, ErrorCode } from '@psai/shared';
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
import {
  httpFetch,
  ensureOk,
  jsonOf,
  normalizeBaseUrl,
  buildMultipart,
  safeEndpoint,
  sanitizeExternalText
} from './http.js';
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
 * MJ 任务的 remoteId 前缀。
 * 同一个适配器现在既有同步结果（放在内存 map 里，id 是 oai_*），
 * 又有异步任务（id 是平台给的 taskId）。靠前缀区分，不必额外存一张表。
 */
const MJ_PREFIX = 'mj:';

/** MJ 代理 /mj/task/{id}/fetch 的响应。字段名沿用平台的写法。 */
interface MjTask {
  status?: 'NOT_START' | 'SUBMITTED' | 'IN_PROGRESS' | 'SUCCESS' | 'FAILURE' | string;
  progress?: string;
  failReason?: string;
  imageUrl?: string;
}

/**
 * 生图请求的超时下限。
 *
 * 这一族是同步接口：提交完就一直挂着连接等图，慢是常态。
 * 实测同一个 gpt-image-1.5、同样的提示词，三次分别是 101s / 174s / 162s ——
 * 原来的 180s 上限贴着实测值，稍微抖一下就会在快出图的时候把连接掐掉，
 * 用户白等三分钟还只看到一句「超时」，和「闭源模型没有任何结果」是同一种体感。
 *
 * 留到 5 分钟：真卡住了照样会超时，但正常的慢不会被误杀。
 * 任务引擎本来就异步跑，等久一点不占用户的操作，面板上也一直有进度。
 */
const IMAGE_TIMEOUT_MS = 300_000;


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
  // 只有 1 代是固定档位。gpt-image-2 实测认任意尺寸：
  //   size=3000x1777 → 3008x1792（按 64 对齐）、size=2048x2048 → 2048x2048
  // 以前这里写的是 /^gpt-image/，把 2 代一起按死在 1536 以内 ——
  // 用户拿 4000px 原图去洗，回来最多 1536px，还找不到是谁砍的。
  { match: /^gpt-image-1/i, sizes: [[1024, 1024], [1024, 1536], [1536, 1024]] },
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

/**
 * 把上游的错误响应翻译成一句用户能照着做的话。
 *
 * 三种情况都见过真机：
 *   1. 有正经 message  —— 直接用，比如「所有分组对于模型 X 不支持此 API 路径」
 *   2. message 是空白  —— 实测 gpt-image-1.5-2025-12-16 回的是 {"message":" "}。
 *      把这坨 JSON 原样摆给用户毫无价值，里面本来就没有信息，
 *      面板上会显示成「Comfly HTTP 503：」后面一片空白，看着像我们把错误吞了。
 *   3. 压根不是 JSON   —— 截断原文，至少留个线索。
 *
 * 另外「无可用渠道 / 模型不存在 / 未开通 / 不支持此 API 路径」这一类要单独拎出来：
 * 平台在线、Key 也对，纯粹是这个模型用不了，换一个立刻能继续 ——
 * 和「平台挂了」是完全不同的两件事，报同一个码会把排查方向带偏。
 */
export function explainHttpError(
  status: number,
  rawBody: string,
  label: string,
  fallbackCode: ErrorCode
): PsaiError {
  /*
   * 响应正文是外部文本。网关和代理很爱把它收到的完整请求 URL 回显在错误里
   * （"failed to proxy https://…?AccessKey=…&Signature=…" 这种），
   * 而那串东西会一路进错误消息、进 error_json、进用户截的图。
   * 在这里清一次，后面拼什么都安全。
   */
  const body = sanitizeExternalText(rawBody, 800);
  let upstream = '';
  let parsed = false;
  try {
    const j = JSON.parse(body) as { error?: { message?: string }; message?: string };
    parsed = true;
    upstream = (j.error?.message ?? j.message ?? '').trim();
  } catch {
    /* 上游没给 JSON，下面用原文截断 */
  }

  const detail =
    upstream ||
    (parsed
      ? '平台没有说明原因，通常是这个模型的上游线路临时不可用，可以换一个模型或稍后重试'
      : body.trim().slice(0, 300) || '平台没有返回任何内容');

  const modelGone =
    /无可用渠道|无可用的渠道|模型不存在|不支持该模型|未开通|不支持此 ?API ?路径|不支持此接口|no available channel|model_not_found|does not exist|not available|unsupported.*endpoint/i.test(
      detail
    );

  // PsaiError 的第二个参数是 details、第三个才是消息覆盖。
  // 这里都只给 details，消息用错误码自带的那句 —— 那句本身就说清楚了是什么问题。
  if (modelGone) {
    return new PsaiError(
      'PROVIDER_MODEL_UNAVAILABLE',
      `${label}：${detail}。到「参数设置 → 模型」换一个再试，下拉里的列表是从该平台实时拉取的。`
    );
  }
  return new PsaiError(fallbackCode, `${label} HTTP ${status}：${detail}`);
}

export class OpenAiCompatibleAdapter implements ProviderAdapter {
  readonly id: string;
  private results = new Map<string, { at: number; images: ResultImage[] }>();
  /** 模型列表缓存：挑内置提示词模型要用，不必每次反推都去拉一遍。 */
  private modelsCache: { at: number; models: string[] } | null = null;
  /** 最近一次 textComplete 用的模型，供 UI 如实显示。 */
  private lastText: string | null = null;

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

  /**
   * 带幂等键的请求头。
   *
   * OpenAI 兼容族普遍认 `Idempotency-Key`：同一个键在一段时间内重复提交，
   * 上游只会真正执行并计费一次，后续请求直接回第一次的结果。
   * 这是"崩溃后不确定钱花没花"这个问题唯一的正解 ——
   * 有它在，即使我们重放了同一次尝试，用户也不会被扣两次。
   * 不认这个头的平台会忽略它，没有副作用。
   */
  private submitHeaders(ctx: SubmitContext, extra: Record<string, string> = {}): Record<string, string> {
    const h = this.headers(extra);
    if (ctx.idempotencyKey) h['Idempotency-Key'] = ctx.idempotencyKey;
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

    /**
     * 先把「想要多大」翻译成「这个平台该怎么发」。
     *
     * 关键在于：够不够 2K 不是靠 size 参数争取来的。nano-banana-pro 实测
     * 无论 size 写多大都只给 1376×768，真正的开关是模型名 —— `-2k` 那个 id 才有 2K。
     * 所以 planImageSize 可能会**改写模型名**，而且只在该平台确实有那个 id 时才改。
     */
    const plan = planImageSize(model, { width, height }, await this.ensureModels());
    const planned = plan.model;
    // 老一代固定档位模型再吸附一次，否则分辨率滑杆会直接把请求撞成 HTTP 400
    const size = snapSize(planned, width, height);
    if (planned !== model || size !== `${width}x${height}`) {
      this.log.debug('生图尺寸方案', {
        jobId: ctx.jobId,
        model,
        used: planned,
        requested: `${width}x${height}`,
        size,
        note: plan.note
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

    /**
     * 按模型决定走哪条协议。
     *
     * 这一步以前不存在 —— 所有模型一律打 /images/generations，于是认可名单里
     * 有两族根本出不了图，报的还是看不出所以然的错：
     *   gemini-3-pro-image → 503「不支持此 API 路径 [/v1/images/generations]」
     *   midjourney         → 400「The model `midjourney` does not exist」
     * 路由表在 @psai/shared，和「哪些模型可选」是同一份事实源：
     * 能选中的模型，必然有一条对应的路，不会出现"列出来了但打不通"。
     */
    const route = imageRouteFor(planned) ?? 'images';

    if (route === 'mj') {
      // 异步代理接口：这里只拿到 taskId，出图靠上层轮询 poll()
      return this.mjSubmit({ prompt, ctx });
    }

    const remoteId = `oai_${randomUUID()}`;
    const out =
      route === 'chat'
        ? await this.chatToImage({ model: planned, prompt, ctx })
        : images.length === 0
          ? await this.textToImage({ model: planned, prompt, size, ctx })
          : await this.imageToImage({ model: planned, prompt, size, ctx });

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
      headers: this.submitHeaders(a.ctx, { 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
      timeoutMs: Math.max(this.opts.timeoutMs, IMAGE_TIMEOUT_MS),
      // 提交进行中被取消时中止请求 —— 那是唯一能真正省下这次费用的时机
      ...(a.ctx.signal ? { signal: a.ctx.signal } : {})
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
      headers: this.submitHeaders(a.ctx, { 'Content-Type': contentType }),
      body,
      timeoutMs: Math.max(this.opts.timeoutMs, IMAGE_TIMEOUT_MS),
      // 提交进行中被取消时中止请求 —— 那是唯一能真正省下这次费用的时机
      ...(a.ctx.signal ? { signal: a.ctx.signal } : {})
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
      headers: this.submitHeaders(a.ctx, { 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
      timeoutMs: Math.max(this.opts.timeoutMs, IMAGE_TIMEOUT_MS),
      // 提交进行中被取消时中止请求 —— 那是唯一能真正省下这次费用的时机
      ...(a.ctx.signal ? { signal: a.ctx.signal } : {})
    });
    return this.readImages(await this.okJson(res, url), url);
  }

  /* ---------------- chat 路：Gemini 图像族 ---------------- */

  /**
   * 走 /chat/completions 出图。
   *
   * Gemini 的图像模型在这个网关上**只有**这一条路。真机实测：
   *   POST /v1/images/generations  gemini-3-pro-image → 503「不支持此 API 路径」
   *   POST /v1/chat/completions    gemini-3-pro-image → 200 · 27s
   * 200 的那次，图不在什么 data 数组里，而是拼在助手回复的正文里：
   *   "![image](https://files.closeai.fans/filesystem/output/…/xxx.jpg)"
   * 所以这里要从**一段自由文本**里把图捞出来，而不是读结构化字段。
   *
   * 注意这条路没有 size 参数可传 —— 尺寸由模型名决定（-2k / -4k / -512px），
   * 面板上的分辨率对它不起作用。硬塞一个它不认的参数只会把请求打成 400，
   * 不如不塞：出来的图尺寸如实是多少就是多少，写回时按实际像素走。
   */
  private async chatToImage(a: { model: string; prompt: string; ctx: SubmitContext }): Promise<ResultImage[]> {
    const url = `${this.base()}/chat/completions`;
    const content: unknown[] = [];
    for (const img of a.ctx.inputs) {
      content.push({
        type: 'image_url',
        image_url: { url: `data:${img.mime};base64,${img.buffer.toString('base64')}` }
      });
    }
    content.push({ type: 'text', text: a.prompt });

    const res = await httpFetch(url, {
      method: 'POST',
      // 这条路一样是真金白银的一次生图调用，幂等键不能漏。
      // 漏了的话，崩溃恢复重放这一次尝试就会变成第二次计费 ——
      // 而重放正是我们设计出来的行为，不是异常路径。
      headers: this.submitHeaders(a.ctx, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ model: a.model, messages: [{ role: 'user', content }] }),
      timeoutMs: Math.max(this.opts.timeoutMs, IMAGE_TIMEOUT_MS),
      // 提交进行中被取消时中止请求 —— 那是唯一能真正省下这次费用的时机
      ...(a.ctx.signal ? { signal: a.ctx.signal } : {})
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const { codeForStatus } = await import('./http.js');
      throw explainHttpError(res.status, text, this.opts.label, codeForStatus(res.status));
    }
    const json = await jsonOf<{ choices?: Array<{ message?: { content?: unknown } }> }>(res, url);
    const said = flattenChatContent(json.choices?.[0]?.message?.content);
    const refs = extractImageRefs(said);
    if (refs.length === 0) {
      // 模型答了话却没给图。把它说的那句带上 —— 通常是拒答理由（内容策略之类），
      // 那句话本身就是用户该看到的东西，比一句「没有返回任何图像」有用得多。
      throw new PsaiError(
        'PROVIDER_BAD_RESPONSE',
        `${this.opts.label}（${a.model}）没有返回图像${said ? `，它说：${said.slice(0, 300)}` : ''}`
      );
    }
    const out: ResultImage[] = [];
    for (const ref of refs) {
      if (ref.startsWith('data:')) {
        const buffer = Buffer.from(stripDataUri(ref), 'base64');
        out.push({ buffer, mime: sniffImageMime(ref, buffer) });
        continue;
      }
      const r = await ensureOk(await httpFetch(ref, { timeoutMs: 120_000 }), ref);
      const buffer = Buffer.from(await r.arrayBuffer());
      const ct = (r.headers.get('content-type') ?? '').split(';')[0];
      out.push({ buffer, mime: ct && ct.startsWith('image/') ? ct : sniffImageMime('', buffer) });
    }
    return out;
  }

  /* ---------------- mj 路：Midjourney 异步代理 ---------------- */

  /**
   * MJ 代理接口的根地址。
   *
   * 它**不在** /v1 底下：baseUrl 是 https://ai.comfly.org/v1，
   * 而提交要打 https://ai.comfly.org/mj/submit/imagine。
   * 照着 base() 拼会得到 /v1/mj/… ，404 之后看起来像"平台不支持 MJ"，
   * 其实只是我们把路径拼错了。
   */
  private mjRoot(): string {
    return this.base().replace(/\/v\d+(?:beta)?$/i, '');
  }

  private mjHeaders(ctx?: SubmitContext): Record<string, string> {
    const h = this.headers({ 'Content-Type': 'application/json' });
    // 这套代理认 mj-api-secret；同时带上 Authorization，两种网关配置都能过
    if (this.opts.apiKey) h['mj-api-secret'] = this.opts.apiKey;
    // 提交路径上要带幂等键。Midjourney 一次出图是几分钟、也是实打实的额度，
    // 重复提交的代价比别的模型还高。
    if (ctx?.idempotencyKey) h['Idempotency-Key'] = ctx.idempotencyKey;
    return h;
  }

  /**
   * 认领时规范化任务号。
   *
   * 这一族里只有 Midjourney 那条路有**真实的**远端任务号，认领才有意义。
   * 其余模型是同步出图：remoteId 是我们自己编的 `oai_<uuid>`，只在本进程的
   * 内存 map 里有意义，重启就没了 —— 让用户"认领"一个这样的 id 毫无用处，
   * 只会让他以为任务救回来了，然后在下一次轮询时被判成丢失。
   */
  normalizeRemoteId(raw: string): string {
    const v = raw.trim();
    if (v.startsWith(MJ_PREFIX)) return v;
    if (/^oai_/.test(v)) {
      throw new PsaiError(
        'JOB_PARAM_INVALID',
        '`oai_…` 是本地临时编号，不是平台上的任务号 —— 它只在当时那个进程里有效，认领它没有意义。'
      );
    }
    // Midjourney 代理返回的是一串数字 id，用户从后台抄回来时不会带前缀
    if (/^[0-9]{6,}$/.test(v)) return `${MJ_PREFIX}${v}`;
    throw new PsaiError(
      'JOB_PARAM_INVALID',
      `${this.opts.label} 只有 Midjourney 任务可以认领，任务号形如 ${MJ_PREFIX}<数字 id>。收到的是「${v}」。`
    );
  }

  private async mjSubmit(a: { prompt: string; ctx: SubmitContext }): Promise<SubmitResult> {
    if (a.ctx.inputs.length > 0) {
      throw new PsaiError(
        'PROVIDER_UNSUPPORTED',
        'Midjourney 的代理接口只接文生图，垫图要先把图传到公网并在提示词里给出链接。这一步我们还没做，先换一个支持图生图的模型。'
      );
    }
    // 认可名单要的是 v7 及以上，可版本号在提示词里而不在模型名里
    const { prompt, error } = normalizeMidjourneyPrompt(a.prompt);
    if (error) throw new PsaiError('JOB_PARAM_INVALID', error);

    const url = `${this.mjRoot()}/mj/submit/imagine`;
    const res = await httpFetch(url, {
      method: 'POST',
      headers: this.mjHeaders(a.ctx),
      body: JSON.stringify({ prompt }),
      timeoutMs: Math.max(this.opts.timeoutMs, 120_000),
      // 提交进行中被取消时中止请求 —— 那是唯一能真正省下这次费用的时机
      ...(a.ctx.signal ? { signal: a.ctx.signal } : {})
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const { codeForStatus } = await import('./http.js');
      throw explainHttpError(res.status, text, `${this.opts.label} · Midjourney`, codeForStatus(res.status));
    }
    const json = await jsonOf<{ code?: number; description?: string; result?: string }>(res, url);
    // code 1 = 提交成功；21 = 已存在（复用同一个任务）；其余都是没提交上去
    if (!json.result || (json.code !== 1 && json.code !== 21 && json.code !== 22)) {
      throw new PsaiError(
        'PROVIDER_BAD_RESPONSE',
        `${this.opts.label} · Midjourney 提交失败：${json.description ?? JSON.stringify(json).slice(0, 200)}`
      );
    }
    this.log.debug('Midjourney 任务已提交', { jobId: a.ctx.jobId, taskId: json.result, prompt });
    // 不带 immediateResults —— 上层据此转入轮询
    return { remoteId: `${MJ_PREFIX}${json.result}` };
  }

  private async mjFetch(taskId: string): Promise<MjTask> {
    const url = `${this.mjRoot()}/mj/task/${encodeURIComponent(taskId)}/fetch`;
    const res = await ensureOk(
      await httpFetch(url, { headers: this.mjHeaders(), timeoutMs: Math.max(this.opts.timeoutMs, 60_000) }),
      url
    );
    return jsonOf<MjTask>(res, url);
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
      const { codeForStatus } = await import('./http.js');
      throw explainHttpError(res.status, text, this.opts.label, codeForStatus(res.status));
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
        const buffer = Buffer.from(stripDataUri(b64), 'base64');
        out.push({ buffer, mime: sniffImageMime(b64, buffer) });
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
      throw new PsaiError('PROVIDER_BAD_RESPONSE', `${safeEndpoint(url)} 没有返回任何图像`);
    }
    return out;
  }

  /* ---------------- 视觉 / 文本 ---------------- */

  async textComplete(input: TextCompleteInput): Promise<string> {
    this.requireConfigured();
    if (!this.opts.capabilities.includes('vision') && (input.images?.length ?? 0) > 0) {
      throw new PsaiError('PROVIDER_UNSUPPORTED', `${this.opts.label} 不支持图像理解`);
    }
    const model = input.model || (await this.promptModel());
    if (!model) throw new PsaiError('JOB_PARAM_INVALID', `${this.opts.label}: 未选择模型`);
    this.lastText = model;

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
      timeoutMs: Math.max(this.opts.timeoutMs, 120_000),
      // 反推 / 优化也可能跑几十秒，取消时一样要能掐掉
      ...(input.signal ? { signal: input.signal } : {})
    });
    // 和生图走同一套错误翻译：把上游那句人话读出来，别再报「无法解析的响应」
    if (!res.ok) await this.okJson(res, url);
    const json = await jsonOf<{ choices?: Array<{ message?: { content?: string } }> }>(res, url);
    const out = json.choices?.[0]?.message?.content?.trim();
    if (!out) throw new PsaiError('PROVIDER_BAD_RESPONSE', '模型没有返回文本');
    return out;
  }

  /**
   * 反推 / 优化提示词内置用哪个模型。
   *
   * 出厂钉死在 GPT-5.6 一族，设置页不给这个旋钮 —— 这是给生图打底的内部工序，
   * 不该让用户先去配一个语言模型才能用「✨ 优化提示词」。
   *
   * 关键是**绝不**退回 opts.defaultModel。那是「生图默认模型」：
   * 用户把它设成 gpt-image-2 或 flux-2-max，这里拿它去发 chat 请求必然失败，
   * 而且报的错跟"提示词"毫无关系，用户根本猜不到是这一步坏了。
   * 洗图/去噪默认开着反推，于是整条路径看起来就是「闭源模型没有任何结果」。
   *
   * 真机实测三个 5.6 变体文本与视觉都正常（terra 2.2s / luna 2.8s / sol 7.0s），
   * 所以带图的反推和纯文本的优化用同一个模型就够，不必再分两套。
   */
  lastTextModel(): string | null {
    return this.lastText;
  }

  /**
   * 拿这个平台的模型列表（10 分钟缓存）。
   *
   * 两个地方要用：挑内置提示词模型，以及**定尺寸**。
   * 后者以前拿不到这份列表 —— 缓存只有 textComplete 走过才会填上，
   * 而纯生图任务根本不碰 textComplete。于是 planImageSize 每次都收到空数组，
   * 走「拿不到模型列表，不敢改写模型名」那一支，2K 兜底从来没生效过：
   * 真机上 nano-banana-pro 拿 1536×1024 的原图，出的是 1264×848。
   * 规则写了、测试也过了，就是没人给它该有的输入。
   */
  private async ensureModels(): Promise<readonly string[]> {
    const fresh = this.modelsCache && Date.now() - this.modelsCache.at < 10 * 60 * 1000;
    if (!fresh) {
      try {
        this.modelsCache = { at: Date.now(), models: await this.listModels() };
      } catch {
        this.modelsCache = null;
      }
    }
    return this.modelsCache?.models ?? [];
  }

  private async promptModel(): Promise<string> {
    await this.ensureModels();
    if (!this.modelsCache) return DEFAULT_PROMPT_MODEL;
    // 先按内置偏好挑 GPT-5.6 一族，再退到看得懂图的通用视觉模型
    return pickPromptModel(this.modelsCache.models) ?? pickVisionModel(this.modelsCache.models) ?? DEFAULT_PROMPT_MODEL;
  }

  /* ---------------- 状态 ---------------- */

  async poll(remoteId: string): Promise<PollResult> {
    if (remoteId.startsWith(MJ_PREFIX)) return this.mjPoll(remoteId.slice(MJ_PREFIX.length));
    const hit = this.results.get(remoteId);
    if (hit) return { state: 'done', progress: { ...emptyProgress('已完成'), value: 1 } };
    return { state: 'unknown' };
  }

  /**
   * MJ 任务状态。真机上跑过一轮完整的：
   *   IN_PROGRESS 8% → 21% → 35% → 47% → 58% → 66% → 77% → SUCCESS 100%（约 54s）
   * progress 是 "77%" 这样的字符串，要转成 0..1 才能喂给进度条。
   */
  private async mjPoll(taskId: string): Promise<PollResult> {
    const t = await this.mjFetch(taskId);
    const pct = /(\d+(?:\.\d+)?)\s*%/.exec(t.progress ?? '');
    const value = pct ? Math.min(1, Math.max(0, Number(pct[1]) / 100)) : null;
    switch (t.status) {
      case 'SUCCESS':
        return { state: 'done', progress: { ...emptyProgress('已完成'), value: 1 } };
      case 'FAILURE':
        return {
          state: 'failed',
          error: toErrorShape(
            new PsaiError(
              'PROVIDER_UPSTREAM_ERROR',
              `Midjourney 任务失败：${t.failReason || '平台没有说明原因，可以稍后重试或换一个模型'}`
            )
          )
        };
      case 'NOT_START':
      case 'SUBMITTED':
        return { state: 'queued', progress: { ...emptyProgress('Midjourney 排队中'), value } };
      default:
        return { state: 'running', progress: { ...emptyProgress('Midjourney 生成中'), value } };
    }
  }

  async fetchResults(remoteId: string, signal?: AbortSignal): Promise<ResultImage[]> {
    void signal;
    if (remoteId.startsWith(MJ_PREFIX)) {
      const t = await this.mjFetch(remoteId.slice(MJ_PREFIX.length));
      if (!t.imageUrl) throw new PsaiError('PROVIDER_BAD_RESPONSE', 'Midjourney 任务已完成但没有给出图片地址');
      // 这个地址在网关自己域名下（/mj/image/<taskId>），照样要带鉴权头
      const res = await ensureOk(
        await httpFetch(t.imageUrl, { headers: this.mjHeaders(), timeoutMs: 180_000 }),
        t.imageUrl
      );
      const buffer = Buffer.from(await res.arrayBuffer());
      const ct = (res.headers.get('content-type') ?? '').split(';')[0];
      return [{ buffer, mime: ct && ct.startsWith('image/') ? ct : sniffImageMime('', buffer) }];
    }
    const hit = this.results.get(remoteId);
    if (!hit) throw new PsaiError('JOB_LOST', '同步型云接口的结果已过期，请重新提交');
    return hit.images;
  }

  async cancel(remoteId: string): Promise<CancelResult> {
    if (remoteId.startsWith(MJ_PREFIX)) {
      // MJ 代理没有撤销接口。本地停止等待可以，但那边照跑照扣，必须说清楚。
      return {
        ok: false,
        reason: 'Midjourney 的代理接口没有取消能力；本地会停止等待，但任务仍在平台上继续，费用照常产生。'
      };
    }
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

/**
 * chat 回复的 content 可能是字符串，也可能是 [{type:'text',text:…}, …]。
 * 两种都见过，这里统一压成一段文本再去里面找图。
 */
export function flattenChatContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      const p = part as { text?: unknown; image_url?: { url?: unknown } };
      if (typeof p.text === 'string') return p.text;
      if (typeof p.image_url?.url === 'string') return p.image_url.url;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

/**
 * 从一段自由文本里把图片地址捞出来。
 *
 * Gemini 图像族回的是 markdown：`![image](https://files.closeai.fans/…/xxx.jpg)`。
 * 但不能只认 markdown —— 换个模型/换个网关就可能回裸链接或 data URI，
 * 那时候「没找到图」会被归到「模型没出图」，排查方向直接跑偏。
 * 三种写法都认，按出现顺序去重返回。
 */
export function extractImageRefs(text: string): string[] {
  const out: string[] = [];
  const push = (s: string | undefined): void => {
    const v = s?.trim();
    if (v && !out.includes(v)) out.push(v);
  };
  // 1. markdown 图片
  for (const m of text.matchAll(/!\[[^\]]*\]\(\s*([^)\s]+)/g)) push(m[1]);
  // 2. data URI
  for (const m of text.matchAll(/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi)) push(m[0]);
  // 3. 裸链接（结尾是图片扩展名的才算，否则会把正文里随便一个网址当成图）
  for (const m of text.matchAll(/https?:\/\/[^\s)<>"']+\.(?:png|jpe?g|webp|gif)(?:\?[^\s)<>"']*)?/gi)) push(m[0]);
  return out;
}

function stripDataUri(s: string): string {
  const i = s.indexOf('base64,');
  return i >= 0 ? s.slice(i + 7) : s;
}

/**
 * 认出这坨字节到底是什么图。
 *
 * 起因是 nano-banana-pro：它的 b64_json 回的是一整条 data URI，
 * 而且内容是 **JPEG** —— `data:image/jpeg;base64,/9j/…`。
 * 我们以前无条件标成 image/png，于是一张 JPEG 被存成 .png：
 * 资产库缩略图、写回 Photoshop 的图层、导出的文件名全都对不上真实格式。
 *
 * 先信 data URI 自己声明的类型，没有就看magic bytes，两个都认不出才退回 png。
 */
export function sniffImageMime(b64: string, buf: Buffer): string {
  const declared = /^data:(image\/[a-z0-9.+-]+);base64,/i.exec(b64.trim());
  if (declared?.[1]) return declared[1].toLowerCase();
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return 'image/png';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') {
    return 'image/webp';
  }
  if (buf.length >= 6 && buf.subarray(0, 6).toString('latin1').startsWith('GIF8')) return 'image/gif';
  return 'image/png';
}
