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

import { PsaiError, toErrorShape, rhPresetByWorkflowId, pickRhImageField } from '@psai/shared';
import { checkUsableMask } from '../mask.js';
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
// 云端工作流拉回图之后要扫一遍推导绑定，用的是导入本机工作流那同一套扫描器
import { scanApiGraph } from '../workflows/scanner.js';
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

/**
 * AI 应用任务号的前缀。
 *
 * poll() 和 fetchResults() 只拿得到 remoteId，光看一串数字分不出这条任务
 * 是走 v1（/task/openapi/status + outputs）还是 v2（/openapi/v2/query）。
 * 查错的表现很隐蔽：任务永远停在"运行中"，图其实早就出来了，
 * 只是没人去对的地方取。前缀跟着 remote_id 存进库，重启后照样分得清。
 */
const AIAPP_PREFIX = 'aiapp:';

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

  private async post<T>(
    path: string,
    body: Record<string, unknown>,
    timeoutMs?: number,
    signal?: AbortSignal
  ): Promise<T> {
    const url = `${this.base()}${path}`;
    const res = await httpFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Host: hostOf(this.base()) },
      body: JSON.stringify({ apiKey: this.opts.apiKey, ...body }),
      timeoutMs: timeoutMs ?? this.opts.timeoutMs,
      // 提交进行中被取消时中止请求 —— 那是唯一能真正省下这次费用的时机
      ...(signal ? { signal } : {})
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
      /*
       * 把实测见过的两个码翻成人话。
       *
       * 平台回的是 WORKFLOW_NOT_SAVED_OR_NOT_RUNNING 这种英文常量，
       * 原样端到界面上，用户既不知道它什么意思，也不知道该做什么 ——
       * 这两个码正是把上一轮排查带偏的东西：看着像"我们没绑定"，
       * 其实一个是"你还没在平台上跑过这份工作流"，另一个是"你填的
       * 根本不是工作流 ID"。
       *
       * 只翻这两个：其余的码没有实际观测过，凭猜写出来的说明比英文原文更坏。
       */
      const explained = /WORKFLOW_NOT_SAVED_OR_NOT_RUNNING/i.test(msg)
        ? `这份云端工作流还没在 RunningHub 上保存并成功运行过一次，平台不会给出它的接口格式。` +
          `请到 RunningHub 打开这份工作流，点一次「运行」，跑成功之后再回来提交。（平台原文：${msg}）`
        : /WORKFLOW_NOT_EXISTS/i.test(msg)
          ? `RunningHub 上没有这个工作流 ID。如果你填的是「AI 应用」的 ID（页面地址里带 /ai-detail/），` +
            `请到「设置 → 工作流 → 添加云端工作流」把类型改成「AI 应用」—— 两者接口不同，工作流接口不认识应用 ID。` +
            `（平台原文：${msg}）`
          : `RunningHub: ${msg}`;
      throw new PsaiError(code, explained);
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

  async uploadImage(buf: Buffer, filename: string, mime: string, signal?: AbortSignal): Promise<string> {
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
        timeoutMs: Math.max(this.opts.timeoutMs, 120_000),
        // 提交进行中被取消时中止请求 —— 那是唯一能真正省下这次费用的时机
        ...(signal ? { signal } : {})
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
  private async remoteGraph(workflowId: string, signal?: AbortSignal): Promise<ComfyApiGraph> {
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

  /* ---------------- AI 应用（v2 接口） ---------------- */

  /**
   * v2 的请求和 v1 完全不是一套：Bearer 认证、ID 在路径里、响应是扁平对象
   * （没有 {code,msg,data} 外壳）。所以不能复用 post()。
   */
  private async postV2<T>(path: string, body: unknown, timeoutMs?: number, signal?: AbortSignal): Promise<T> {
    const url = `${this.base()}${path}`;
    const res = await httpFetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.opts.apiKey}`,
        Host: hostOf(this.base())
      },
      body: JSON.stringify(body),
      timeoutMs: timeoutMs ?? this.opts.timeoutMs,
      ...(signal ? { signal } : {})
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new PsaiError(codeForStatus(res.status), `RunningHub HTTP ${res.status}: ${t.slice(0, 500)}`);
    }
    return jsonOf<T>(res, url);
  }

  /**
   * v2 的图片上传。和 v1 的 /task/openapi/upload 是两个接口，
   * 返回的字段名也不同（data.fileName），认证走 Bearer。
   */
  private async uploadImageV2(
    buf: Buffer,
    filename: string,
    mime: string,
    signal?: AbortSignal
  ): Promise<string> {
    const url = `${this.base()}/openapi/v2/media/upload/binary`;
    const { body, contentType } = buildMultipart([{ name: 'file', filename, mime, data: buf }]);
    const res = await httpFetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': contentType,
        Authorization: `Bearer ${this.opts.apiKey}`,
        Host: hostOf(this.base())
      },
      body,
      timeoutMs: Math.max(this.opts.timeoutMs, 120_000),
      ...(signal ? { signal } : {})
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new PsaiError(codeForStatus(res.status), `RunningHub 上传失败 HTTP ${res.status}: ${t.slice(0, 300)}`);
    }
    const j = await jsonOf<{ code?: number; msg?: string; message?: string; data?: { fileName?: string } }>(res, url);
    const name = j.data?.fileName;
    if (!name) {
      throw new PsaiError('PROVIDER_BAD_RESPONSE', `RunningHub 上传没有返回 fileName：${j.msg ?? j.message ?? ''}`);
    }
    return name;
  }

  private async submitAiApp(ctx: SubmitContext, appId: string): Promise<SubmitResult> {
    const wf = ctx.remoteWorkflow;
    const fields = wf?.nodeInfo ?? [];
    if (!fields.length) {
      throw new PsaiError(
        'WORKFLOW_NOT_BOUND',
        `AI 应用 ${appId} 没有节点参数表。请到「设置 → 工作流」重新登记，并把平台 API 页面上的「请求示例」粘贴进来。`
      );
    }

    const imageField = pickRhImageField(fields);
    type NodeField = { nodeId: string; fieldName: string; description: string; defaultValue: string };
    /*
     * 有输入图却认不出该塞进哪个字段时，必须停下。
     *
     * 硬塞进第一个字段的话，平台照跑不误 —— 用作者预置的示例图出一张图，
     * 带着 SUCCESS 回来。用户花了钱，拿到一张跟自己输入毫无关系的图，
     * 而界面上没有任何地方能看出哪里不对。
     */
    if (ctx.inputs.length > 0 && !imageField) {
      throw new PsaiError(
        'WORKFLOW_BINDING_INVALID',
        `AI 应用 ${appId} 的节点参数表里认不出哪个字段收图（字段：${fields.map((x: NodeField) => x.fieldName).join('、')}）。` +
          `没有这个映射就只能拿作者的示例图出图，结果和你的输入无关，所以这里直接停下。`
      );
    }

    const nodeInfoList: Array<{ nodeId: string; fieldName: string; fieldValue: string }> = [];
    for (const f of fields) {
      const ff: NodeField = f;
      if (imageField && ff.nodeId === imageField.nodeId && ff.fieldName === imageField.fieldName) continue;
      // 其余字段用平台示例里的值；用户在参数区改过的，按字段名覆盖
      const override = ctx.params[`rh.${ff.nodeId}.${ff.fieldName}`];
      nodeInfoList.push({
        nodeId: ff.nodeId,
        fieldName: ff.fieldName,
        fieldValue: override === undefined || override === null ? ff.defaultValue : String(override)
      });
    }

    if (imageField && ctx.inputs[0]) {
      const img = ctx.inputs[0];
      const fileName = await this.uploadImageV2(img.buffer, img.filename, img.mime, ctx.signal);
      nodeInfoList.push({ nodeId: imageField.nodeId, fieldName: imageField.fieldName, fieldValue: fileName });
    }

    const data = await this.postV2<{ taskId?: string; status?: string; errorCode?: string; errorMessage?: string }>(
      `/openapi/v2/run/ai-app/${encodeURIComponent(appId)}`,
      { nodeInfoList, instanceType: 'default', usePersonalQueue: false },
      Math.max(this.opts.timeoutMs, 60_000),
      ctx.signal
    );
    if (!data.taskId) {
      throw new PsaiError(
        'PROVIDER_BAD_RESPONSE',
        `RunningHub 没有返回 taskId${data.errorMessage ? `：${data.errorMessage}` : ''}`
      );
    }
    this.log.info('RunningHub AI 应用已提交', {
      jobId: ctx.jobId,
      appId,
      taskId: data.taskId,
      覆盖字段数: nodeInfoList.length
    });
    /*
     * 前缀标记走的是哪一套接口。
     *
     * poll() 只拿得到 remoteId，光看一串数字分不出该查 v1 的
     * /task/openapi/status 还是 v2 的 /openapi/v2/query。查错的表现是
     * 任务永远停在"运行中"—— 图其实早就出来了，只是没人去对的地方取。
     * 前缀存进库里，重启之后照样分得清。
     */
    return { remoteId: `${AIAPP_PREFIX}${data.taskId}` };
  }

  async submit(ctx: SubmitContext): Promise<SubmitResult> {
    this.requireConfigured();
    // AI 应用走 v2，和工作流是两套完全不同的接口
    if (ctx.remoteWorkflow?.remoteKind === 'aiApp' && ctx.remoteWorkflow.remoteId) {
      return this.submitAiApp(ctx, ctx.remoteWorkflow.remoteId);
    }
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
    let bindings = preset?.bindings ?? ctx.workflow?.bindings ?? [];

    /*
     * 用户自己登记的云端工作流：本机没有绑定表，但**平台给得出图** ——
     * 拉回来扫一遍就能推导出绑定，用的是导入本机工作流时那同一套扫描器。
     *
     * 这一步是「填个 ID 就能用」对工作流成立的原因。AI 应用没有这条路
     * （它的 ID 拉不回图，实测回 380 WORKFLOW_NOT_EXISTS），所以那边
     * 只能让用户粘节点表 —— 两类的差别就落在这里。
     *
     * 注意平台有个前置条件：工作流必须先在 RunningHub 上保存并成功跑过
     * 一次，否则这里会拿到 810，那句话已经翻译成"去点一次运行"了。
     */
    if (bindings.length === 0 && ctx.remoteWorkflow?.remoteKind === 'workflow') {
      const graph = await this.remoteGraph(workflowId, ctx.signal);
      bindings = scanApiGraph(graph).suggestedBindings;
      this.log.info('云端工作流按平台返回的图自动推导了绑定', {
        jobId: ctx.jobId,
        workflowId,
        绑定数: bindings.length,
        参数: bindings.map((b) => b.paramId).join(',')
      });
    }

    if (bindings.length === 0) {
      throw new PsaiError(
        'WORKFLOW_NOT_BOUND',
        `云端工作流 ${workflowId} 没有参数绑定表。它不是内置预设，也没有对应的本地工作流绑定 —— ` +
          `直接提交会让云端拿作者的示例图出图，结果和你的输入无关。请在设置里选一个内置预设，或先导入这份工作流并完成绑定。`
      );
    }

    if (preset?.needsMask) {
      /*
       * 这里要过两道，缺一不可。
       *
       * 第一道：这份 alpha **是不是**一次明确的选区遮罩。
       *
       *   「有没有 alpha 通道」根本不够格。透明背景的图层、抠过图的素材、
       *   带透明边的 PNG —— 全都天生有 alpha，而且往往"有可编辑区"，
       *   于是能轻松骗过任何只看像素的检查。
       *   更要命的是选区遮罩**读失败**的那条路：界面会退回外接矩形并提示一句，
       *   但图照样能提交 —— 如果这张图碰巧自带透明，那片天然透明
       *   就会被当成用户圈的选区，模型去改一片他完全没碰过的地方。
       *   用户要等花完钱、拿回结果才看得出不对，而那时候他只会觉得模型不行。
       *
       *   所以判据是资产上记着的那个事实：合成的时候真的收到过选区灰度。
       *
       * 第二道：这份遮罩里**有没有可编辑区**。
       *
       *   按这一族的约定（docs/RUNNINGHUB.md）透明处即处理区。
       *   一张全不透明的图表达的是"整张都保留"，下游什么都不会做，
       *   用户等几分钟拿回一张没变的图。
       *   注意反过来那种（整张都可编辑）是**合法**的：
       *   按外接矩形裁过之后，一个普通矩形选区就正好是整张都可编辑。
       */
      const declared = ctx.inputs.filter((i) => i.hasSelectionMask);
      if (declared.length === 0) {
        const strayAlpha = ctx.inputs.some((i) => i.hasAlpha);
        throw new PsaiError(
          'JOB_PARAM_INVALID',
          `「${preset.label}」靠选区遮罩识别处理区域，但这次的输入图没有带上选区。` +
            (strayAlpha
              ? '（这张图虽然有透明通道，但那是它自己的透明度，不是你圈出来的区域 —— ' +
                '拿它当选区用会改到你没碰过的地方。）'
              : '') +
            `请在 Photoshop 里先建立选区再捕获；如果刚才提示过「选区已按外接矩形处理」，` +
            `说明遮罩没读上来，请重试一次捕获。`
        );
      }

      const usable = declared.find((i) => checkUsableMask(i.buffer).ok);
      if (!usable) {
        const why = checkUsableMask(declared[0]!.buffer).reason;
        throw new PsaiError(
          'JOB_PARAM_INVALID',
          `「${preset.label}」的输入图带了选区，但这份遮罩不可用：${why}。` +
            `请重新建立选区再提交。`
        );
      }
    }

    // 输入图先传上去，拿到云端文件名再按绑定落位
    const values: BindingValues = { ...ctx.params };
    for (const img of ctx.inputs) {
      const name = await this.uploadImage(img.buffer, img.filename, img.mime, ctx.signal);
      for (const key of imageAliases(img.paramId, img.index)) values[key] = name;
    }

    // 这一步会拉整份云端工作流（可能不小），同样归取消管
    const graph = await this.remoteGraph(workflowId, ctx.signal);
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
      Math.max(this.opts.timeoutMs, 60_000),
      ctx.signal
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

  /** 认领时规范化任务号。RunningHub 的 taskId 是一串纯数字。 */
  normalizeRemoteId(raw: string): string {
    const v = raw.trim();
    if (/^[0-9]{6,}$/.test(v)) return v;
    throw new PsaiError('JOB_PARAM_INVALID', `RunningHub 的任务号是一串数字（taskId），收到的是「${v}」。`);
  }

  async poll(remoteId: string): Promise<PollResult> {
    this.requireConfigured();
    if (remoteId.startsWith(AIAPP_PREFIX)) return this.pollAiApp(remoteId.slice(AIAPP_PREFIX.length));
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

  /** v2 的状态查询。响应是扁平对象，状态字段就叫 status。 */
  private async pollAiApp(taskId: string): Promise<PollResult> {
    try {
      const d = await this.postV2<{ status?: string; errorMessage?: string }>('/openapi/v2/query', { taskId });
      switch ((d.status ?? '').toUpperCase()) {
        case 'QUEUED':
          return { state: 'queued', progress: progressFor(0, '云端排队中') };
        case 'RUNNING':
          return { state: 'running', progress: progressFor(0.5, '云端生成中（该平台不提供细粒度进度）') };
        case 'SUCCESS':
          return { state: 'done', progress: progressFor(1, '已完成') };
        case 'FAILED':
          return {
            state: 'failed',
            error: toErrorShape(new PsaiError('JOB_FAILED', d.errorMessage || 'RunningHub 报告任务失败'))
          };
        default:
          return { state: 'unknown' };
      }
    } catch (e) {
      const shape = toErrorShape(e);
      if (shape.retryable) return { state: 'unknown' };
      return { state: 'failed', error: shape };
    }
  }

  /**
   * v2 的结果就在状态响应里（results 数组），不像 v1 要单独打一次 outputs。
   *
   * 注意那些 URL **只有 24 小时有效期**，所以这里当场把图下下来，
   * 不存 URL。资产库存的是图本身，隔几天回历史页还看得到。
   */
  private async fetchResultsAiApp(taskId: string, signal?: AbortSignal): Promise<ResultImage[]> {
    const d = await this.postV2<{ results?: Array<{ url?: string; outputType?: string }> }>(
      '/openapi/v2/query',
      { taskId },
      Math.max(this.opts.timeoutMs, 60_000),
      signal
    );
    const out: ResultImage[] = [];
    for (const item of d.results ?? []) {
      if (!item.url) continue;
      const res = await ensureOk(await httpFetch(item.url, { timeoutMs: 180_000, ...(signal ? { signal } : {}) }), item.url);
      const ct = res.headers.get('content-type') ?? 'image/png';
      if (!ct.startsWith('image/')) continue;
      out.push({ buffer: Buffer.from(await res.arrayBuffer()), mime: ct.split(';')[0] ?? 'image/png' });
    }
    if (out.length === 0) {
      throw new PsaiError('WORKFLOW_NO_OUTPUT', 'RunningHub AI 应用任务完成，但结果里没有图像输出');
    }
    return out;
  }

  async fetchResults(remoteId: string, signal?: AbortSignal): Promise<ResultImage[]> {
    this.requireConfigured();
    if (remoteId.startsWith(AIAPP_PREFIX)) {
      return this.fetchResultsAiApp(remoteId.slice(AIAPP_PREFIX.length), signal);
    }
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
      const res = await ensureOk(await httpFetch(url, { timeoutMs: 180_000, ...(signal ? { signal } : {}) }), url);
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
