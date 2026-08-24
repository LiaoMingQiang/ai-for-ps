/**
 * LiblibAI 开放平台适配器。
 *
 * 协议是**拿真账号打出来的**，不是照文档抄的（写这段时手上没有文档）。
 * 每一条都有对应的真机响应，记在下面，方便以后对着官方文档复核：
 *
 *   base            https://openapi.liblibai.cloud
 *   鉴权            query: AccessKey / Signature / Timestamp / SignatureNonce
 *                   Signature = base64url(HMAC-SHA1(SecretKey, `${uri}&${ts}&${nonce}`)) 去掉结尾 '='
 *                   验证方式：拿一个不存在的任务 id 查状态，回 100051「生图任务不存在」
 *                   —— 能走到"任务不存在"就说明签名过了
 *   信封            { code, data, msg }，code 0 为成功
 *
 *   POST /api/generate/webui/text2img        托管模型·文生图      100050（缺参数）
 *   POST /api/generate/webui/img2img         托管模型·图生图      100050
 *   POST /api/generate/webui/text2img/ultra  同上 Ultra 档        100000「参数无效: templateUuid」
 *   POST /api/generate/webui/img2img/ultra   同上                 100000
 *   POST /api/generate/comfyui/app           云端 ComfyUI 工作流   100050
 *   POST /api/generate/webui/status          查状态（webui 系）    100051
 *   POST /api/generate/comfy/status          查状态（comfy 系）    100051
 *   POST /api/model/version/get              按 versionUuid 查模型 200001「model.notExist」
 *
 * 探到「不存在」的路由（别再试了）：/api/generate/comfy/app、/api/app/list、
 * /api/model/list、/api/userinfo、以及各种 upload 路径。
 *
 * 两个直接影响设计的结论：
 *
 * 1. **没有模型/工作流列表接口。** 所以 listModels() 不能凭空造一份清单出来。
 *    模型与工作流的 uuid 只能来自用户配置（和 RunningHub 让用户去网站上抄
 *    workflowId 是同一个产品逻辑），我们负责把它拿去 /api/model/version/get
 *    验一遍，验不过就明确说这个 id 在这个账号下不可用 —— 这就是"只暴露该账号
 *    真正有的东西"能做到的程度。
 *
 * 2. **没有上传接口。** 输入图怎么进去是这一版唯一还没验证到底的环节，
 *    见 sourceImageValue() 上的说明。
 */

import { createHmac, randomBytes } from 'node:crypto';
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
import { httpFetch, jsonOf, normalizeBaseUrl, ensureOk } from './http.js';
import type { Logger } from '../log.js';

export interface LiblibOptions {
  baseUrl: string;
  accessKey: string | null;
  secretKey: string | null;
  /** 云端工作流 uuid（对应 RunningHub 的 workflowId） */
  defaultWorkflowId: string;
  /** 托管模型的 templateUuid */
  defaultModel: string;
  /**
   * 云端 ComfyUI 应用的模板 id。
   * 和工作流 uuid 是两个值：真机上把工作流 uuid 当 templateUuid 发，
   * 平台回 template not found。这个常量在工作流页面的「API 参数示例」里。
   */
  comfyTemplateUuid: string;
  timeoutMs: number;
}

interface Envelope<T> {
  code?: number;
  msg?: string;
  data?: T;
}

/**
 * remoteId 的前缀。
 * 两条提交路径对应两个不同的查询接口，光靠 uuid 分不出该查哪个，
 * 所以把路由信息编进 remoteId 里 —— 重启恢复时也能靠它找回正确的查询方式。
 */
const RID_COMFY = 'liblib-comfy:';
const RID_WEBUI = 'liblib-webui:';

/** 真机见过的错误码。留着注释是因为 msg 是中文，光看码看不出所以然。 */
const CODE = {
  OK: 0,
  /** 参数完整度校验没过（body 缺字段） */
  PARAM_INCOMPLETE: 100050,
  /** 参数无效 / 路由不存在，靠 msg 区分 */
  PARAM_INVALID: 100000,
  /** 生图任务不存在 */
  TASK_NOT_FOUND: 100051,
  /** 模型不存在 */
  MODEL_NOT_FOUND: 200001,
  RATE_LIMITED: 429
} as const;

export class LiblibAdapter implements ProviderAdapter {
  readonly id = 'liblib';

  constructor(
    private opts: LiblibOptions,
    private readonly log: Logger
  ) {}

  updateOptions(opts: LiblibOptions): void {
    this.opts = opts;
  }

  private base(): string {
    return normalizeBaseUrl(this.opts.baseUrl);
  }

  isConfigured(): boolean {
    return /^https?:\/\/.+/.test(this.opts.baseUrl.trim()) && !!this.opts.accessKey && !!this.opts.secretKey;
  }

  notConfiguredReason(): string {
    if (!/^https?:\/\/.+/.test(this.opts.baseUrl.trim())) return 'LiblibAI 接口地址未填写';
    if (!this.opts.accessKey) return 'LiblibAI Access Key 未配置';
    // 两个都要，缺一个签不出名字。分开说，别让用户以为填了一个就算配好了。
    if (!this.opts.secretKey) return 'LiblibAI Secret Key 未配置（签名需要它，只填 Access Key 不够）';
    return '';
  }

  private requireConfigured(): void {
    if (!this.isConfigured()) throw new PsaiError('PROVIDER_NOT_CONFIGURED', this.notConfiguredReason());
  }

  async capabilities(): Promise<ProviderCapability[]> {
    return ['workflow', 'textToImage', 'imageToImage', 'progress', 'listModels'];
  }

  /**
   * 签名。
   *
   * 注意签的是 **uri**（不含 query、不含域名）。把完整 URL 拿去签是最常见的错法，
   * 结果是每次都 401 而看不出哪里错 —— 这里单独抽出来，测试直接对着它测。
   */
  private signedUrl(uri: string): string {
    const timestamp = Date.now();
    const nonce = randomBytes(8).toString('hex').slice(0, 10);
    const signature = createHmac('sha1', this.opts.secretKey ?? '')
      .update(`${uri}&${timestamp}&${nonce}`)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const q = new URLSearchParams({
      AccessKey: this.opts.accessKey ?? '',
      Signature: signature,
      Timestamp: String(timestamp),
      SignatureNonce: nonce
    });
    return `${this.base()}${uri}?${q.toString()}`;
  }

  private async post<T>(uri: string, body: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    const url = this.signedUrl(uri);
    const res = await httpFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      timeoutMs: timeoutMs ?? this.opts.timeoutMs
    });
    // 这个平台业务错误也走 HTTP 200，真正的判定在 envelope 的 code 上。
    // 只有非 2xx 才是传输层的问题。
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new PsaiError('PROVIDER_BAD_RESPONSE', `LiblibAI HTTP ${res.status}: ${t.slice(0, 300)}`);
    }
    const json = await jsonOf<Envelope<T>>(res, url);
    if (json.code !== undefined && json.code !== CODE.OK) throw explainLiblibCode(json.code, json.msg ?? '', uri);
    if (json.data === undefined || json.data === null) {
      throw new PsaiError('PROVIDER_BAD_RESPONSE', `LiblibAI ${uri} 没有返回 data`);
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
      // 没有账户信息接口，用「查一个不存在的任务」当鉴权探针：
      // 签名不对会是鉴权错，签名对了才会走到「任务不存在」。
      // 这是这个平台上代价最小、且一定不计费的一次有效调用。
      await this.post<unknown>('/api/generate/webui/status', { generateUuid: PROBE_UUID });
      const latency = Date.now() - t0;
      return { ok: true, latencyMs: latency, detail: `鉴权通过 · ${latency}ms` };
    } catch (e) {
      const shape = toErrorShape(e, 'PROVIDER_UNREACHABLE');
      // 走到「任务不存在」就说明签名是对的 —— 这才是我们要的结论
      if (shape.code === 'JOB_LOST') {
        const latency = Date.now() - t0;
        return { ok: true, latencyMs: latency, detail: `鉴权通过 · ${latency}ms` };
      }
      return { ok: false, latencyMs: null, detail: shape.details ?? shape.message, error: shape };
    }
  }

  /**
   * 该账号能用哪些模型。
   *
   * 平台没有列表接口（/api/model/list、/api/www/model/list 都是 404），
   * 所以这里**不造清单**：只把用户配过的 uuid 拿去 /api/model/version/get 验一遍，
   * 验得过的才算这个账号真能用的。
   *
   * 造一份假清单是很有诱惑力的做法 —— 下拉里立刻就有东西可选了 ——
   * 但用户选中一个他账号里根本没有的模型，换来的是提交时一句看不懂的报错。
   * 宁可下拉是空的并告诉他去哪填，也不给一个必然失败的选项。
   */
  async listModels(): Promise<string[]> {
    this.requireConfigured();
    const configured = [this.opts.defaultModel].map((s) => s.trim()).filter(Boolean);
    if (configured.length === 0) return [];
    const usable: string[] = [];
    for (const uuid of configured) {
      try {
        await this.post<unknown>('/api/model/version/get', { versionUuid: uuid });
        usable.push(uuid);
      } catch (e) {
        this.log.debug('LiblibAI 模型不可用，已从列表剔除', { uuid, error: String(e) });
      }
    }
    return usable;
  }

  /**
   * 输入图怎么送进去。
   *
   * 这是这一版**唯一没有真机验证到底**的环节：平台没有上传接口
   * （试过 /api/generate/upload、/api/image/upload、/api/oss/upload 等，全是 404），
   * 而验证 sourceImage 取值需要一个真实的 templateUuid 才能越过模板校验，
   * 探测时手上没有。
   *
   * 先按 data URI 发。真机上如果这条不通，报错会明确指向 sourceImage 字段，
   * 改这一个函数即可，不影响其它任何环节 —— 这也是把它单独抽出来的原因。
   */
  private sourceImageValue(img: { buffer: Buffer; mime: string }): string {
    return `data:${img.mime};base64,${img.buffer.toString('base64')}`;
  }

  async submit(ctx: SubmitContext): Promise<SubmitResult> {
    this.requireConfigured();

    const workflowUuid = (ctx.remoteWorkflowId || this.opts.defaultWorkflowId).trim();
    const templateUuid = (ctx.model || this.opts.defaultModel).trim();

    // 两条路：有工作流走云端 ComfyUI，否则走托管模型。
    // 和 RunningHub 的产品逻辑一致 —— 工作流优先，它更具体。
    if (workflowUuid) return this.submitWorkflow(workflowUuid, ctx);
    if (templateUuid) return this.submitHostedModel(templateUuid, ctx);

    throw new PsaiError(
      'WORKFLOW_NOT_BOUND',
      'LiblibAI 需要先在设置里填一个云端工作流 uuid，或者选一个托管模型。' +
        '这两个 id 都在 liblib.art 上你自己的作品/应用页面里，我们不会替你猜。'
    );
  }

  /**
   * 云端 ComfyUI 工作流。
   *
   * 校验顺序是探出来的（每一步都对应一条真机响应）：
   *   generateParams 为空                     → 100050 参数完整度校验
   *   generateParams 非空但没有 workflowUuid  → 100000「参数无效: workflowUuid」
   *   两者都有但 templateUuid 不对             → 100000「template not found, templateUuid: xxx」
   *
   * 所以 templateUuid 和 generateParams.workflowUuid 是**两个不同的东西**，都必填：
   * 前者是平台侧 ComfyUI 应用模板的常量 id，后者才是用户那份工作流。
   * 一开始我把工作流 uuid 同时塞给两边，平台直接回 template not found。
   */
  private async submitWorkflow(workflowUuid: string, ctx: SubmitContext): Promise<SubmitResult> {
    const templateUuid = this.opts.comfyTemplateUuid.trim();
    if (!templateUuid) {
      throw new PsaiError(
        'WORKFLOW_NOT_BOUND',
        'LiblibAI 云端工作流还需要一个「ComfyUI 模板 ID」。它在工作流页面「查看 API 参数」里的参数示例中，' +
          '是 templateUuid 那一项 —— 和工作流 ID 是两个值。填到「设置 → 云端 → LiblibAI」里。'
      );
    }

    const generateParams: Record<string, unknown> = { workflowUuid };
    const prompt = (ctx.prompt ?? '').trim();
    if (prompt) generateParams['prompt'] = prompt;
    if (ctx.inputs.length > 0) {
      generateParams['sourceImage'] = this.sourceImageValue(ctx.inputs[0]!);
    }

    const data = await this.post<{ generateUuid?: string }>(
      '/api/generate/comfyui/app',
      { templateUuid, generateParams },
      Math.max(this.opts.timeoutMs, 60_000)
    );
    const uuid = data.generateUuid;
    if (!uuid) throw new PsaiError('PROVIDER_BAD_RESPONSE', 'LiblibAI 没有返回 generateUuid');
    this.log.info('LiblibAI 工作流已提交', { jobId: ctx.jobId, workflowUuid, generateUuid: uuid });
    return { remoteId: `${RID_COMFY}${uuid}` };
  }

  private async submitHostedModel(templateUuid: string, ctx: SubmitContext): Promise<SubmitResult> {
    const prompt = (ctx.prompt ?? '').trim();
    if (!prompt) throw new PsaiError('JOB_PARAM_INVALID', '提示词为空');

    const width = Number(ctx.params['__width'] ?? 1024);
    const height = Number(ctx.params['__height'] ?? 1024);
    const generateParams: Record<string, unknown> = { prompt, width, height, imgCount: 1 };
    const neg = (ctx.negativePrompt ?? '').trim();
    if (neg) generateParams['negativePrompt'] = neg;
    const seed = ctx.params['seed'];
    if (typeof seed === 'number') generateParams['seed'] = seed;

    const i2i = ctx.inputs.length > 0;
    if (i2i) generateParams['sourceImage'] = this.sourceImageValue(ctx.inputs[0]!);

    const uri = i2i ? '/api/generate/webui/img2img' : '/api/generate/webui/text2img';
    const data = await this.post<{ generateUuid?: string }>(
      uri,
      { templateUuid, generateParams },
      Math.max(this.opts.timeoutMs, 60_000)
    );
    const uuid = data.generateUuid;
    if (!uuid) throw new PsaiError('PROVIDER_BAD_RESPONSE', 'LiblibAI 没有返回 generateUuid');
    this.log.info('LiblibAI 生图已提交', { jobId: ctx.jobId, templateUuid, uri, generateUuid: uuid });
    return { remoteId: `${RID_WEBUI}${uuid}` };
  }

  private statusUri(remoteId: string): { uri: string; uuid: string } {
    if (remoteId.startsWith(RID_COMFY)) {
      return { uri: '/api/generate/comfy/status', uuid: remoteId.slice(RID_COMFY.length) };
    }
    return { uri: '/api/generate/webui/status', uuid: remoteId.slice(RID_WEBUI.length) };
  }

  async poll(remoteId: string): Promise<PollResult> {
    this.requireConfigured();
    const { uri, uuid } = this.statusUri(remoteId);
    try {
      const data = await this.post<LiblibStatus>(uri, { generateUuid: uuid });
      const state = normalizeStatus(data.generateStatus);
      const pct = typeof data.percentCompleted === 'number' ? clamp01(data.percentCompleted) : null;
      switch (state) {
        case 'queued':
          return { state: 'queued', progress: { ...emptyProgress('LiblibAI 排队中'), value: pct } };
        case 'running':
          return { state: 'running', progress: { ...emptyProgress('LiblibAI 生成中'), value: pct } };
        case 'done':
          return { state: 'done', progress: { ...emptyProgress('已完成'), value: 1 } };
        case 'failed':
          // 失败原因在 generateMsg 里。不带上它的话，面板上只有一句
          // 「任务失败」，用户完全不知道是提示词违规、积分不够还是工作流报错。
          return {
            state: 'failed',
            error: toErrorShape(
              new PsaiError(
                'JOB_FAILED',
                `LiblibAI 报告任务失败${data.generateMsg ? `：${data.generateMsg}` : '（平台没有给出原因）'}`
              )
            )
          };
        default:
          return { state: 'unknown' };
      }
    } catch (e) {
      const shape = toErrorShape(e);
      // 可重试的（限流、网络抖动）报 unknown，让引擎继续轮询，别判死
      if (shape.retryable) return { state: 'unknown' };
      return { state: 'failed', error: shape };
    }
  }

  async fetchResults(remoteId: string): Promise<ResultImage[]> {
    this.requireConfigured();
    const { uri, uuid } = this.statusUri(remoteId);
    const data = await this.post<LiblibStatus>(uri, { generateUuid: uuid }, Math.max(this.opts.timeoutMs, 60_000));
    const images = data.images ?? [];
    const out: ResultImage[] = [];
    for (const img of images) {
      const url = img?.imageUrl;
      if (!url) continue;
      // 只收审核通过（3）的。平台文档写着 images「只返回审核通过的图片」，
      // 但我们不能只信这句：真出现别的状态时，写回 Photoshop 的会是一张
      // 随时可能被撤下的图，用户却以为已经成了。
      if (!auditPassed(img.auditStatus)) {
        this.log.warn('LiblibAI 有图未通过内容审核，已跳过', { generateUuid: uuid, auditStatus: img.auditStatus });
        continue;
      }
      const res = await ensureOk(await httpFetch(url, { timeoutMs: 180_000 }), url);
      const ct = res.headers.get('content-type') ?? 'image/png';
      if (!ct.startsWith('image/')) continue;
      out.push({ buffer: Buffer.from(await res.arrayBuffer()), mime: ct.split(';')[0] ?? 'image/png' });
    }
    if (out.length === 0) {
      // 出视频的工作流是一种很具体的误配：任务成功、平台也扣了分，
      // 但产出写不回 Photoshop 图层。说清楚比一句"没有输出"有用得多。
      if ((data.videos ?? []).length > 0) {
        throw new PsaiError(
          'WORKFLOW_NO_OUTPUT',
          'LiblibAI 这个工作流产出的是视频，不是图片，写不回 Photoshop 图层。请换一个出图的工作流。'
        );
      }
      throw new PsaiError(
        'WORKFLOW_NO_OUTPUT',
        images.length > 0
          ? 'LiblibAI 任务完成，但产出的图没有通过内容审核'
          : 'LiblibAI 任务完成但没有图像输出'
      );
    }
    // 积分消耗如实记下来 —— 云端出图是花钱的，用户该能在日志里对账
    this.log.info('LiblibAI 取回结果', {
      generateUuid: uuid,
      images: out.length,
      pointsCost: data.pointsCost,
      accountBalance: data.accountBalance
    });
    return out;
  }

  async cancel(): Promise<CancelResult> {
    // 和 RunningHub 一样：官方没有取消接口，如实说，别让用户以为省下了钱
    return {
      ok: false,
      reason: 'LiblibAI 没有提供取消接口，任务会继续在云端执行并计费。你可以丢弃结果，但费用无法撤销。'
    };
  }
}

/** 查询一个不可能存在的任务 —— 用来验签名，且一定不计费。 */
const PROBE_UUID = '00000000000000000000000000000000';

/** /api/generate/comfy|webui/status 的 data。字段名与平台「返回值说明」一致。 */
interface LiblibStatus {
  generateStatus?: number;
  /** 0..1 的浮点数（平台文档明确是这个量纲） */
  percentCompleted?: number;
  /** 生图信息，失败原因在这里 */
  generateMsg?: string;
  /** 本次消耗的积分 */
  pointsCost?: number;
  /** 账户余额 */
  accountBalance?: number;
  images?: Array<{ imageUrl?: string; auditStatus?: number; nodeId?: string; outputName?: string } | null>;
  /** 出视频的工作流会走这里；我们只处理图，但要能认出"出的是视频"这种情况 */
  videos?: Array<{ videoUrl?: string } | null>;
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/**
 * generateStatus 的数字含义 —— 已按平台「返回值说明」核对：
 *   1 等待执行   2 执行中   3 已生成   4 审核中   5 任务成功   6 任务失败
 *
 * 注意 3「已生成」和 4「审核中」都**不是**终态：图已经出来了，但还要过内容审核，
 * 审核不过一样拿不到。所以这两档归到 running 继续轮询，
 * 而不是看到「已生成」就去取图 —— 那时候 images 还是空的。
 *
 * 没列出来的码一律 unknown（继续轮询），不猜成 failed：
 * 判死会把一个还在跑、还在计费的云端任务从界面上抹掉，那是不可逆的。
 */
export function normalizeStatus(code: number | undefined): 'queued' | 'running' | 'done' | 'failed' | 'unknown' {
  switch (code) {
    case 1:
      return 'queued';
    case 2:
    case 3:
    case 4:
      return 'running';
    case 5:
      return 'done';
    case 6:
      return 'failed';
    default:
      return 'unknown';
  }
}

/**
 * auditStatus：1 待审核  2 审核中  3 审核通过  4 审核拒绝  5 审核失败
 *
 * 只有 3 才算能用。之前写成「!==3 && !==1 才跳过」，等于把「待审核」也放行了 ——
 * 那张图还没过审，地址可能拿不到、也可能随后被撤下，写回 Photoshop 之后
 * 用户以为成了，实际拿到的是一张随时会失效的图。
 */
export function auditPassed(status: number | undefined): boolean {
  return status === undefined || status === 3;
}

/**
 * 把 LiblibAI 的业务错误码翻译成我们的标准错误码。
 *
 * 全部对应真机响应：
 *   100050 生图参数未通过参数完整度校验
 *   100000 参数无效: xxx  /  No static resource xxx.（路由不存在）
 *   100051 生图任务不存在
 *   200001 model.notExist
 *   429    请求过多，请稍后重试
 */
export function explainLiblibCode(code: number, msg: string, uri: string): PsaiError {
  // 限流是"再等等"，不是失败。归到可重试，引擎会退避重试；
  // 判死的话用户看到的是一次莫名其妙的报错，手动重试一下又好了。
  //
  // 正则必须写死一点：一开始图省事写了 /rate/i，结果 "No static resource
  // api/gene**rate**/comfy/app" 也被判成限流 —— 这个平台几乎每个 uri 里都有
  // "generate"，于是一大半真错误都会被当成限流无限重试，任务永远不结束。
  // 被测试抓出来了。
  if (code === CODE.RATE_LIMITED || /请求过多|too many requests|rate limit|限流/i.test(msg)) {
    return new PsaiError('PROVIDER_RATE_LIMIT', `LiblibAI 限流：${msg || '请求过多'}`);
  }
  // 鉴权和额度要排在通用的参数校验前面：它们更具体。
  // 反过来的话，"签名验证失败"会先被 code=100000 那条笼统地判成"参数不对"，
  // 用户会去检查提示词，而真正该做的是重填密钥。
  if (/签名验证失败|auth|sign|鉴权|unauthorized|accesskey|secretkey/i.test(msg)) {
    return new PsaiError('PROVIDER_AUTH_FAILED', `LiblibAI 鉴权失败：${msg}`);
  }
  if (/balance|quota|余额|额度|积分不足/i.test(msg)) {
    return new PsaiError('PROVIDER_QUOTA_EXCEEDED', `LiblibAI：${msg}`);
  }
  if (code === CODE.TASK_NOT_FOUND) {
    return new PsaiError('JOB_LOST', `LiblibAI：${msg || '生图任务不存在'}`);
  }
  if (code === CODE.MODEL_NOT_FOUND || /model\.notExist/i.test(msg)) {
    return new PsaiError(
      'PROVIDER_MODEL_UNAVAILABLE',
      `LiblibAI：这个模型在当前账号下不可用（${msg}）。到「设置 → LiblibAI」换一个 uuid 再试。`
    );
  }
  if (/No static resource/i.test(msg)) {
    // 这个平台把"路由不存在"也塞进 100000，和"参数不对"混在一起。
    // 分开报很重要：路由不对是我们的 bug，参数不对是用户能自己改的。
    return new PsaiError('PROVIDER_BAD_RESPONSE', `LiblibAI 接口 ${uri} 不存在（${msg}）—— 这是插件侧的问题，请反馈。`);
  }
  if (/template not found/i.test(msg)) {
    return new PsaiError(
      'PROVIDER_MODEL_UNAVAILABLE',
      `LiblibAI：${msg}。工作流/模型 uuid 要从 liblib.art 上你自己的应用页面复制，填错了平台找不到。`
    );
  }
  if (code === CODE.PARAM_INCOMPLETE || code === CODE.PARAM_INVALID) {
    return new PsaiError('JOB_PARAM_INVALID', `LiblibAI：${msg || `参数校验未通过（code=${code}）`}`);
  }
  return new PsaiError('PROVIDER_BAD_RESPONSE', `LiblibAI（code=${code}）：${msg || '平台没有说明原因'}`);
}

export function progressFor(value: number, message: string): JobProgress {
  return { ...emptyProgress(message), value };
}
