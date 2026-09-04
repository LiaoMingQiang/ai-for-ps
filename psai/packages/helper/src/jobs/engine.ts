/**
 * 作业引擎：18 态状态机 + 本地并发闸 + 重启恢复 + 取消。
 *
 * 三条铁律：
 *  1. AI 出图成功 与 写回 Photoshop 成功 严格分离。写回失败 → retryable_writeback_failure，
 *     结果永久留在资产库，用户随时可以再写回。
 *  2. 重启恢复时先查远端真实状态，绝不盲目重新提交（会重复占卡、重复计费）。
 *  3. 并发额度的释放必须幂等 —— 重复释放会让计数漂移，最终把队列永久卡死。
 */

import { randomUUID, createHash } from 'node:crypto';
import { RequestAbortedError, sanitizeExternalText } from '../providers/http.js';
import {
  PsaiError,
  toErrorShape,
  canTransition,
  isTerminal,
  isActive,
  findFeature,
  renderLayerName,
  breadcrumb,
  rhPresetByWorkflowId,
  JOB_TRANSITIONS
} from '@psai/shared';
import type {
  JobRecord,
  JobState,
  JobProgress,
  JobEvent,
  CreateJobRequest,
  JobListQuery,
  PhotoshopTarget,
  JobResultAsset,
  JobImageInput,
  FeatureSpec,
  WritebackMode
} from '@psai/shared';
import type { Db } from '../db.js';
import { withTransaction } from '../db.js';
import type { Logger } from '../log.js';
import type { AssetStore } from '../assets.js';
import type { SettingsStore } from '../settings.js';
import type { PromptStore } from '../prompts.js';
import type { WorkflowStore } from '../workflows/store.js';
import type { ProviderManager } from '../providers/manager.js';
import type { EventHub } from '../events.js';
import type { InputImage, RemoteState, ProviderAdapter } from '../providers/types.js';
import { parseImageMeta } from '../image-meta.js';
import { resolveJobParams, reversePresetOf, wantsEnhance } from './resolve.js';
import type { ResolveOptions } from './resolve.js';

interface RunningEntry {
  jobId: string;
  unsubscribe: (() => void) | null;
  pollTimer: NodeJS.Timeout | null;
  cancelled: boolean;
  /**
   * 提交请求的中止句柄。
   *
   * 提交进行中被取消时，中止那个还没发完的 HTTP 请求是**唯一**能真正省下这次
   * 费用的时机 —— 等 remoteId 回来再去取消，钱已经花了。
   * 只在提交期间有值，提交一结束就置回 null。
   */
  abort: AbortController | null;
  /** unknown 状态第一次出现的时间，用于判定"真的丢了" */
  unknownSince: number | null;
}

/**
 * 写回租约的有效期。
 *
 * 写回是插件那边干的活，Helper 只能等它回报。插件可能在中途被关掉、
 * Photoshop 可能卡在一个模态框上 —— 那条 running 记录就永远不会有结论。
 * 不给过期时间的话，这条任务从此再也写不回去了。
 * 定成 2 分钟：比任何一次正常写回都长得多（大图也就几秒），
 * 又不至于让用户对着一个卡住的任务干等太久。
 */
const WRITEBACK_LEASE_MS = 120_000;

const UNKNOWN_GRACE_MS = 45_000;
const POLL_INTERVAL_MS = 1200;
/**
 * 提交遇到远端队列已满时的退避节奏（毫秒）。
 * 云端一个任务通常跑几十秒到两三分钟，所以退避拉到分钟级才有意义，
 * 每两秒重试一次只会把限流打得更死。总共等约 6 分钟还排不上就如实报失败。
 */
const SUBMIT_RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 120_000, 120_000];

export class JobEngine {
  private queue: string[] = [];
  private running = new Map<string, RunningEntry>();
  private released = new Set<string>();
  private stopped = false;

  constructor(
    private readonly db: Db,
    private readonly log: Logger,
    private readonly assets: AssetStore,
    private readonly settings: SettingsStore,
    private readonly prompts: PromptStore,
    private readonly workflows: WorkflowStore,
    private readonly providers: ProviderManager,
    private readonly events: EventHub
  ) {}

  /* ================= 创建 ================= */

  async create(req: CreateJobRequest): Promise<JobRecord> {
    const feature = findFeature(req.featureId);
    if (!feature) throw new PsaiError('JOB_PARAM_INVALID', `未知功能: ${req.featureId}`);

    // 先校验用户这次填的东西，再去解析后端。
    // 顺序反了的话，"上传了 11 张图" 会被报成 "没有配置 Provider"，
    // 用户按提示去配 Key 也解决不了真正的问题。
    const inputSpec = feature.params.find((p) => p.kind === 'image' || p.kind === 'imageList');
    if (inputSpec) {
      const provided = req.inputs.filter((i) => i.paramId === inputSpec.id);
      if (inputSpec.kind === 'image' && inputSpec.required && provided.length === 0) {
        throw new PsaiError('JOB_INPUT_MISSING', `「${inputSpec.label}」是必需的`);
      }
      if (inputSpec.kind === 'imageList') {
        if (provided.length < inputSpec.min) {
          throw new PsaiError('JOB_INPUT_MISSING', `「${inputSpec.label}」至少需要 ${inputSpec.min} 张`);
        }
        if (provided.length > inputSpec.max) {
          throw new PsaiError('JOB_PARAM_INVALID', `「${inputSpec.label}」最多 ${inputSpec.max} 张，收到 ${provided.length} 张`);
        }
      }
    }
    for (const i of req.inputs) {
      if (!this.assets.find(i.assetId)) throw new PsaiError('ASSET_NOT_FOUND', i.assetId);
    }

    /*
     * 同一个 (paramId, index) 只能有一张图。
     *
     * job_inputs 的主键就是 (job_id, param_id, idx)，重复的话数据库自己会拦 ——
     * 但那是在**循环中途**拦的：第一张已经写进去、引用计数也加过了，
     * 第二张才撞 UNIQUE。虽然现在整段包在事务里会回滚，
     * 这里仍然先查一遍，因为报错质量差很多：
     * 数据库给的是 "UNIQUE constraint failed: job_inputs.job_id, ..."，
     * 而用户需要知道的是"第 2 个位置重复提交了"。
     */
    const seenSlots = new Set<string>();
    for (const i of req.inputs) {
      const slot = `${i.paramId}#${i.index}`;
      if (seenSlots.has(slot)) {
        throw new PsaiError(
          'JOB_PARAM_INVALID',
          `同一个输入位置提交了多张图：${i.paramId}[${i.index}]。每个位置只能放一张。`
        );
      }
      seenSlots.add(slot);
    }

    // 输入没问题了，再决定这次用哪个后端
    const { providerId } = this.providers.resolveProvider(req.featureId, req.providerId);

    // 工作流解析（comfy 类必须有）
    let workflowId: string | null = null;
    let workflowVersion: string | null = null;
    /*
     * 先看这次点名的是不是一条**云端**工作流条目。
     *
     * 「自定义工作流」的工作流是每次提交时在生成页选的，选到云端条目时
     * 走的是云端平台，不该套本机图的那套校验（节点在平台那边，本机没有图）。
     * 记下 id 就够了 —— 跑的时候按 id 取回它的 remoteId 发给平台。
     *
     * 放在下面那个 if 之前判：那个分支的条件里有 `providerId !== 'runninghub'`，
     * 云端条目多半正好落在被排除的那一侧，写在后面就永远走不到，
     * workflowId 会留在 null，于是选了等于没选。
     */
    const requestedWorkflowId =
      req.workflowId ?? this.settings.binding(req.featureId)?.workflowId ?? feature.defaultWorkflowId;
    const requestedRecord =
      feature.engine === 'comfy-workflow' && requestedWorkflowId ? this.workflows.find(requestedWorkflowId) : null;
    const requestedCloud = requestedRecord?.kind === 'cloud' ? requestedRecord : null;

    if (requestedCloud) {
      workflowId = requestedCloud.id;
      workflowVersion = requestedCloud.version;
    } else if (feature.engine === 'comfy-workflow' && providerId !== 'runninghub') {
      const binding = this.settings.binding(req.featureId);
      workflowId = req.workflowId ?? binding?.workflowId ?? feature.defaultWorkflowId;
      if (!workflowId) {
        throw new PsaiError('WORKFLOW_NOT_BOUND', `「${breadcrumb(feature.id).join(' / ')}」尚未绑定工作流`);
      }
      const wf = this.workflows.find(workflowId);
      if (!wf) {
        // 绑定指向了一个库里没有的工作流（内置工作流缺失，或用户删掉了导入的那份）。
        // 对用户来说这就是"没绑好"，所以报 WORKFLOW_NOT_BOUND 并说清楚是哪一个。
        throw new PsaiError(
          'WORKFLOW_NOT_BOUND',
          `「${breadcrumb(feature.id).join(' / ')}」绑定的工作流 ${workflowId} 不在工作流库中，请到 设置 → 固定功能 重新绑定`
        );
      }
      workflowVersion = wf.version;
    }

    const id = `job_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
    const now = Date.now();
    const writebackMode: WritebackMode = req.writeback?.mode ?? feature.writeback.default;
    const layerName =
      req.writeback?.layerName ??
      renderLayerName(this.settings.get().generation.layerNameTemplate, { feature: feature.label });
    /*
     * 「自动写回」在**创建这一刻**定下来，跟着任务走，之后不再看设置。
     *
     * 每次现读当前设置的话：用户在任务跑的这几分钟里把开关关了，
     * 结果回来时还是自己写进了他的文档 —— 他明确说过不要。
     * 反过来也一样，中途打开开关不该让一堆已经在等的任务突然自己动起来。
     * 一条任务该不该自动写回，用户是在按下「生成」那一刻决定的。
     */
    const autoWriteback = this.settings.get().generation.autoWriteback;

    /*
     * 写回方式要在**创建时**就校验，不能等到写回那一步。
     *
     * 等到写回才发现不对，图已经生成完了 —— 云端那一次是真金白银付过的。
     * 用户拿到的是"任务成功，但写不回去"，而这本来在按下「开始处理」
     * 那一刻就能拦住，一分钱不花。
     *
     * 两件事一起查：
     *   1. 这个功能允不允许这种写回方式
     *   2. 选了原位写回的话，有没有冻结下来的选区
     */
    if (!feature.writeback.modes.includes(writebackMode)) {
      throw new PsaiError(
        'JOB_PARAM_INVALID',
        `「${feature.label}」不支持「${writebackMode}」写回方式（允许：${feature.writeback.modes.join(' / ')}）`
      );
    }
    if (writebackMode === 'inPlaceSelection' && !req.target?.selectionBounds) {
      throw new PsaiError(
        'JOB_PARAM_INVALID',
        '选择了「选区原位」写回，但这次没有记录选区。请先在 Photoshop 里建立选区，或改用「智能对象图层」/「像素图层」。'
      );
    }

    /*
     * 任务行、输入、资产引用计数、文档记录、created 事件 —— 一个事务里做完。
     *
     * 以前是顺序裸写，中途失败会留下一个 created 状态的孤儿任务、半份输入，
     * 以及**已经加上去但永远不会减回来的资产引用计数**（那些资产从此删不掉）。
     * 更糟的是 Helper 重启后 recover() 会看到这个孤儿任务并尝试执行它 ——
     * 一次失败的创建请求，最后变成了一次真的提交。
     *
     * 现在失败就整体回滚：库里查不到这个 id，恢复流程自然也看不到它。
     */
    let createdEvent: JobEvent | null = null;
    withTransaction(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO jobs(id, feature_id, provider_id, workflow_id, workflow_version, state, progress_json,
                            params_json, resolved_params_json, target_json, writeback_json, error_json,
                            remote_id, parent_job_id, document_id, created_at, updated_at, started_at, finished_at, gpu_ms)
           VALUES(?, ?, ?, ?, ?, 'created', ?, ?, '{}', ?, ?, NULL, NULL, ?, ?, ?, ?, NULL, NULL, NULL)`
        )
        .run(
          id,
          req.featureId,
          providerId,
          workflowId,
          workflowVersion,
          JSON.stringify(emptyProgressRecord('已创建')),
          JSON.stringify(req.params ?? {}),
          req.target ? JSON.stringify(req.target) : null,
          JSON.stringify({ mode: writebackMode, layerName, auto: autoWriteback }),
          null,
          req.target?.documentId ?? null,
          now,
          now
        );

      const insInput = this.db.prepare(
        'INSERT INTO job_inputs(job_id, param_id, asset_id, idx, source) VALUES(?, ?, ?, ?, ?)'
      );
      for (const i of req.inputs) {
        insInput.run(id, i.paramId, i.assetId, i.index, i.source ?? '');
        this.assets.addRef(i.assetId);
      }

      if (req.target) this.touchDocument(req.target);

      // 只写行，不广播 —— 广播在事务外面
      createdEvent = this.writeEventRow(id, null, 'created', `功能 ${feature.id} · Provider ${providerId}`);
    });

    // 提交之后才对外广播。事务里发 WebSocket 事件的话，
    // 回滚了消息也收不回来 —— 面板上会出现一个数据库里并不存在的任务。
    if (createdEvent) this.events.broadcast({ type: 'job:event', event: createdEvent });
    const job = this.get(id);
    this.emit(job);

    this.transition(id, 'inputs_ready', '输入已就绪');
    this.enqueue(id);
    return this.get(id);
  }

  /* ================= 队列 ================= */

  private enqueue(jobId: string): void {
    this.transition(jobId, 'queued_local', '进入本地队列');
    this.queue.push(jobId);
    this.pump();
  }

  private maxConcurrency(): number {
    return Math.max(1, Math.min(8, this.settings.get().generation.maxConcurrency));
  }

  private pump(): void {
    if (this.stopped) return;
    while (this.running.size < this.maxConcurrency() && this.queue.length > 0) {
      const jobId = this.queue.shift()!;
      const job = this.find(jobId);
      if (!job || job.state !== 'queued_local') continue;
      const entry: RunningEntry = {
        jobId,
        unsubscribe: null,
        pollTimer: null,
        cancelled: false,
        abort: null,
        unknownSince: null
      };
      this.running.set(jobId, entry);
      this.released.delete(jobId);
      void this.run(jobId).catch((e) => {
        this.fail(jobId, e);
      });
    }
    this.updateQueuePositions();
  }

  /** 幂等释放：同一个任务多次调用只生效一次。 */
  private release(jobId: string): void {
    if (this.released.has(jobId)) return;
    this.released.add(jobId);
    const entry = this.running.get(jobId);
    if (entry) {
      entry.unsubscribe?.();
      if (entry.pollTimer) clearTimeout(entry.pollTimer);
      this.running.delete(jobId);
    }
    this.queue = this.queue.filter((x) => x !== jobId);
    this.pump();
  }

  private updateQueuePositions(): void {
    this.queue.forEach((jobId, i) => {
      const job = this.find(jobId);
      if (!job || job.state !== 'queued_local') return;
      this.setProgress(jobId, { ...job.progress, message: `本地排队中 · 前面还有 ${i} 个` });
    });
  }

  /* ================= 执行 ================= */

  private async run(jobId: string): Promise<void> {
    const job = this.get(jobId);
    const feature = findFeature(job.featureId);
    if (!feature) throw new PsaiError('JOB_PARAM_INVALID', `未知功能 ${job.featureId}`);

    const adapter = this.providers.adapter(job.providerId);
    if (!adapter.isConfigured()) {
      throw new PsaiError('PROVIDER_NOT_CONFIGURED', adapter.notConfiguredReason());
    }

    this.transition(jobId, 'submitting', '正在准备提交');

    /*
     * 取消的闸门。
     *
     * 提交之前这一段里有好几次 await：反推提示词、优化提示词，
     * 每一次都可能跑几十秒。老代码只在**最后**、真正提交前查了一次取消，
     * 而且查的是一个在函数开头之后才取的 entry —— 用户在反推期间点取消时，
     * cancel() 会把任务判成 cancelled 并 release()（entry 从 running 里删掉），
     * 于是 run() 走到那次检查时 `this.running.get(jobId)` 已经是 undefined，
     * `entry?.cancelled` 是 undefined —— falsy，于是**照常提交**。
     * 一条界面上写着"已取消"的任务被提交到付费平台，用户被扣了钱。
     *
     * 所以：闸门以数据库里的状态为准（那个不会因为释放而消失），
     * 并且每一次 await 之后都过一遍。
     */
    const entry = this.running.get(jobId);
    const abort = new AbortController();
    if (entry) entry.abort = abort;

    /** 这一刻是不是已经不该再往下走了。 */
    const stopNow = (): boolean => {
      if (entry?.cancelled) return true;
      const st = this.stateOf(jobId);
      return st === 'cancel_requested' || isTerminal(st);
    };

    /** 提交之前被取消：干脆地收尾。还没联系过上游，说"已取消"名副其实。 */
    const finishCancelled = (note: string): void => {
      if (!isTerminal(this.stateOf(jobId))) this.forceState(jobId, 'cancelled', note);
      this.release(jobId);
    };

    /**
     * 跑一段提交前的准备工作，并把"被我们自己掐断"和"真的失败了"分开。
     *
     * 中止会让 fetch 抛错，一路冒到外层就会被判成 failed —— 用户点了取消，
     * 界面上却弹出一个报错。取消是用户自己要的结果，不该表现成故障。
     */
    const prepare = async <T>(what: string, fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> => {
      try {
        const value = await fn();
        if (stopNow()) {
          finishCancelled(`${what}期间已取消，未提交`);
          return { ok: false };
        }
        return { ok: true, value };
      } catch (e) {
        if (abort.signal.aborted || stopNow()) {
          finishCancelled(`${what}期间已取消，未提交`);
          return { ok: false };
        }
        throw e;
      }
    };

    // 1. 输入图
    const inputs = this.inputsOf(jobId);
    const images: InputImage[] = inputs.map((i) => {
      const rec = this.assets.get(i.assetId);
      const buffer = this.assets.read(i.assetId);
      return {
        paramId: i.paramId,
        index: i.index,
        buffer,
        mime: rec.mime,
        hasAlpha: parseImageMeta(buffer)?.hasAlpha ?? false,
        hasSelectionMask: rec.hasSelectionMask,
        // 用内容哈希命名，不要用任务 id。
        // ComfyUI 会把整份 prompt（含输入文件名）写进输出 PNG 的元数据，
        // 文件名带任务 id 会让同输入同参数的两次运行产出不同字节，
        // 无损放大这类确定性功能就不再确定；内容寻址还能让远端复用同一份上传。
        filename: `psai_${rec.sha256.slice(0, 16)}.${extOf(rec.mime)}`
      };
    });

    // 2. 反推（需要时）
    let reverseText: string | undefined;
    const reverse = reversePresetOf(feature, job.params);
    if (reverse) {
      this.setProgress(jobId, { ...emptyProgressRecord('正在反推提示词'), value: null });
      const r = await prepare('反推提示词', () =>
        this.runTextTask(feature, reverse.presetId, images, '', abort.signal, jobId)
      );
      if (!r.ok) return;
      reverseText = r.value;
    }

    // 3. 优化提示词（需要时）
    let enhanced: string | undefined;
    if (wantsEnhance(feature, job.params)) {
      const userPrompt = typeof job.params['prompt'] === 'string' ? (job.params['prompt'] as string) : '';
      if (userPrompt.trim()) {
        this.setProgress(jobId, { ...emptyProgressRecord('正在优化提示词'), value: null });
        const r = await prepare('优化提示词', () =>
          this.runTextTask(feature, 'preset.skills.promptEnhance', [], userPrompt, abort.signal, jobId)
        );
        if (!r.ok) return;
        enhanced = r.value;
      }
    }

    // 4. 归一化参数
    const opts: ResolveOptions = {};
    if (reverseText !== undefined) opts.reverseText = reverseText;
    if (enhanced !== undefined) opts.enhancedPrompt = enhanced;
    // 图生图按输入图的比例缩放，而不是把竖图压成正方形
    const primary = inputs.find((i) => i.index === 0) ?? inputs[0];
    if (primary && primary.width > 0 && primary.height > 0) {
      opts.inputSize = { width: primary.width, height: primary.height };
    }
    // 云端预设可以给出比功能默认值更合适的取值。
    // 例：「质感加强」的重绘幅度默认 0.22（保结构，对它自己是对的），
    // 但挂上 Flux Fill 局部重绘时 0.22 意味着遮罩区几乎没变化 —— 用户会以为插件坏了。
    // 只填补用户没给的键，用户填过的一律以用户为准。
    const presetDefaults = rhPresetByWorkflowId(this.settings.binding(job.featureId)?.remoteWorkflowId ?? '')
      ?.paramDefaults;
    const paramsWithPresetDefaults = presetDefaults
      ? { ...presetDefaults, ...stripUndefined(job.params) }
      : job.params;
    const resolved = resolveJobParams(feature, paramsWithPresetDefaults, this.prompts, opts);
    this.db
      .prepare('UPDATE jobs SET resolved_params_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify({ ...resolved.values, __promptBreakdown: resolved.promptBreakdown }), Date.now(), jobId);

    // 5. 提交
    const binding = this.settings.binding(job.featureId);
    /*
     * job.workflowId 可能指向两类东西：本机图，或者一条云端条目。
     *
     * 本机图 → 整份图发给 ComfyUI。
     * 云端条目 → 本机没有图，要发的是它记着的那个平台侧 ID。
     *
     * 用 find 而不是 get：get 找不到会抛，而这里已经在跑作业了 ——
     * 工作流在提交后被删掉是可能的，那时候该按"没绑工作流"往下走，
     * 而不是抛一个没人接的异常把整条作业卡在中间态。
     */
    const jobWorkflow = job.workflowId ? this.workflows.find(job.workflowId) : null;
    const cloudRemoteId = jobWorkflow?.kind === 'cloud' ? jobWorkflow.remoteId : null;
    const ctx = {
      jobId,
      featureId: job.featureId,
      params: resolved.values,
      inputs: images,
      prompt: resolved.prompt,
      negativePrompt: resolved.negativePrompt,
      ...(jobWorkflow && jobWorkflow.kind !== 'cloud' ? { workflow: jobWorkflow } : {}),
      // 云端条目整条带过去：AI 应用的节点参数表只存在这条记录里，
      // 平台没有任何接口能查到它
      ...(jobWorkflow?.kind === 'cloud' ? { remoteWorkflow: jobWorkflow } : {}),
      ...(binding?.model ? { model: binding.model } : {}),
      ...(typeof resolved.values['model'] === 'string' && resolved.values['model']
        ? { model: resolved.values['model'] as string }
        : {}),
      /*
       * 这一次点名的云端条目优先于功能上的固定绑定。
       *
       * 顺序不能反：「自定义工作流」是每次提交现选的，如果让固定绑定盖过它，
       * 用户在下拉里选了 A、跑出来的却是别处绑的 B —— 而界面上没有任何
       * 地方能看出这件事。现选的永远赢。
       */
      ...(cloudRemoteId
        ? { remoteWorkflowId: cloudRemoteId }
        : binding?.remoteWorkflowId
          ? { remoteWorkflowId: binding.remoteWorkflowId }
          : {})
    };

    if (stopNow()) {
      finishCancelled('提交前已取消');
      return;
    }

    const started = Date.now();
    this.db.prepare('UPDATE jobs SET started_at = ? WHERE id = ?').run(started, jobId);

    /*
     * 联系上游**之前**先把这次尝试落库。
     *
     * 这条记录是崩溃之后唯一能回答"钱花没花"的证据。没有它的话，
     * 重启后看到一个停在 submitting、没有 remote_id 的任务，
     * 我们分不清是"还没发出去"还是"已经发出去但没等到回复"——
     * 而这两种情况的正确处理**完全相反**：前者该重来，后者重来就是重复扣费。
     *
     * 必须单独提交（不能和后面的更新合成一个事务），否则崩溃时这条记录本身也没了。
     */
    const attemptId = randomUUID();
    const chargeable = isChargeableProvider(job.providerId);
    // 幂等键：上游支持时，同一个键重复提交只会计一次费。
    // 用 attemptId 而不是 jobId —— 用户明确选择"重来一次"时应该是一次新的计费，
    // 而崩溃恢复重放的是同一个 attempt，用同一个键。
    const idempotencyKey = `psai-${attemptId}`;
    withTransaction(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO submission_attempts(attempt_id, job_id, provider_id, chargeable, idempotency_key, outcome, started_at)
           VALUES(?, ?, ?, ?, ?, 'pending', ?)`
        )
        .run(attemptId, jobId, job.providerId, chargeable ? 1 : 0, idempotencyKey, Date.now());
    });

    let submitted: Awaited<ReturnType<ProviderAdapter['submit']>>;
    try {
      submitted = await this.submitWithBackoff(adapter, { ...ctx, idempotencyKey, signal: abort.signal }, jobId);
    } catch (e) {
      if (entry) entry.abort = null;

      /*
       * 先分清"是我们自己掐的"还是"上游那边出的事"。
       *
       * 中止的结果本身是模糊的：请求可能已经完整送到上游了。
       * 所以免费的本地 ComfyUI 直接判 cancelled（重跑一次不花钱，说取消就是取消），
       * 付费平台则落到 submission_unknown —— 说"已取消"会让用户以为不会被扣钱，
       * 而我们并不知道。
       */
      if (abort.signal.aborted || entry?.cancelled) {
        if (chargeable) {
          this.db
            // outcome 保持 pending：那是"钱可能已经花了"的证据，不能因为用户点了取消就抹掉
            .prepare('UPDATE submission_attempts SET detail = ? WHERE attempt_id = ?')
            .run('用户在提交进行中取消，已中止请求', attemptId);
          this.forceState(jobId, 'submission_unknown', '提交进行中被取消，无法确认平台是否已接单');
          this.setError(
            jobId,
            toErrorShape(
              new PsaiError(
                'SUBMISSION_UNKNOWN',
                `取消时这次请求已经在发往 ${job.providerId} 的路上，我们把它掐断了，` +
                  '但平台可能已经收下并计费。请到平台账单确认后再决定怎么处置。'
              )
            )
          );
          this.release(jobId);
          return;
        }
        this.db
          .prepare("UPDATE submission_attempts SET outcome = 'failed', detail = ?, finished_at = ? WHERE attempt_id = ?")
          .run('用户在提交进行中取消，已中止请求', Date.now(), attemptId);
        this.forceState(jobId, 'cancelled', '提交进行中被取消，请求已中止');
        this.release(jobId);
        return;
      }

      // 上游**明确拒绝**才算 failed —— 那种情况没有产生费用，可以放心重试。
      // 网络中断/超时这类"不知道对面收没收"的，留在 pending，
      // 交给 recover() 判成 submission_unknown。
      const shape = toErrorShape(e);
      const definitelyNotCharged =
        shape.code === 'PROVIDER_NOT_CONFIGURED' ||
        shape.code === 'PROVIDER_AUTH_FAILED' ||
        shape.code === 'JOB_PARAM_INVALID' ||
        shape.code === 'PROVIDER_MODEL_UNAVAILABLE' ||
        shape.code === 'WORKFLOW_NOT_BOUND';

      if (definitelyNotCharged) {
        this.db
          .prepare("UPDATE submission_attempts SET outcome = 'failed', detail = ?, finished_at = ? WHERE attempt_id = ?")
          .run(shape.message.slice(0, 300), Date.now(), attemptId);
        throw e;
      }

      /*
       * 到这里就是「不知道对面收没收」：超时、连接中断、5xx…
       *
       * **不能**把它抛出去。抛出去会被外层 catch 判成 failed，
       * 而 failed → queued_local 是合法转移 —— 用户在界面上点一下「重试」
       * 立刻就能再发一次，根本不用等重启。如果上游其实已经收下了，
       * 这一下就是第二次计费，而且比"崩溃后自动恢复"更容易发生：
       * 用户看到失败，本能就会去点重试。
       *
       * 付费 Provider 一律直接落到 submission_unknown（终态），
       * attempt 保持 pending 作为"钱可能已经花了"的证据，
       * 并把并发额度正常释放掉 —— 停在这里的任务不该继续占着名额。
       */
      if (chargeable) {
        this.forceState(
          jobId,
          'submission_unknown',
          `提交过程中断（${shape.code}），无法确认平台是否已接单`
        );
        this.setError(
          jobId,
          toErrorShape(
            new PsaiError(
              'SUBMISSION_UNKNOWN',
              `请求已经发往 ${job.providerId}，但没等到回复（${shape.message}）。` +
                '平台可能已经接单并计费，也可能没有 —— 本地无法判断。' +
                '请先到平台账单确认，再决定是否重跑；直接重跑有重复扣费的风险。'
            )
          )
        );
        this.release(jobId);
        return;
      }
      throw e;
    }
    if (entry) entry.abort = null;

    /*
     * 提交回来了，但用户在这期间点了取消。
     *
     * 这一刻最容易被写错，因为"取消"已经在本地生效了 —— 老代码里 cancel() 看到
     * remote_id 还是空的，就直接判 cancelled 并 release()。可上游其实已经接单了：
     * 卡照占、钱照扣，而本地再也没人管这条任务。用户界面上写着"已取消"，
     * 平台上那个任务跑到天亮。
     *
     * 正确的做法是**先把 remote_id 落库**（不落库就永远找不回来了），
     * 再去补一刀远端取消：
     *   补上了 → 说 cancelled，名副其实
     *   补不上 → 不能说 cancelled。继续轮询跟到底，直到知道它的最终状态；
     *            用户想彻底不管了可以用「丢弃」，那句话会明说远端可能还在跑。
     */
    if (entry?.cancelled) {
      await this.cancelAfterSubmit(jobId, adapter, submitted, attemptId, started);
      return;
    }

    /*
     * 同步型 Provider（OpenAI 兼容族、Gemini）提交即出结果。
     *
     * 这些结果只活在适配器的内存 map 里，remoteId 是我们自己编的 `oai_<uuid>`——
     * 重启之后那个 map 是空的，谁也拿不回来。所以**必须**在同一个持久化边界里
     * 连结果一起落库：钱已经花了，图不能因为一次崩溃就没了。
     *
     * 异步型（有真实远端任务号的）走下面的轮询路径，那条路重启后还能查回来。
     */
    const immediate = submitted.immediateResults ?? [];
    if (immediate.length > 0) {
      /*
       * remote_id、attempt 结论、结果、用量、终态 —— 一个事务。
       *
       * 分成两个事务写过一版，中间那道缝就是钱和图一起丢的地方：
       * 先提交了 remote_id = `oai_<uuid>` 和 attempt = accepted，然后崩。
       * 重启后适配器的内存 map 是空的，那个 remoteId 谁也查不回来 ——
       * 恢复流程拿它去 poll，得到 unknown，把一条**已经付过钱**的任务判成 lost。
       *
       * 合成一个事务之后只剩两种结局，两种都是诚实的：
       *   提交成功 → 结果在库里，任务是成功的
       *   崩在提交前 → 状态还是 submitting、attempt 还是 pending
       *               → recover() 判成 submission_unknown，交给用户决定
       */
      this.finalizeResults(jobId, immediate, started, { remoteId: submitted.remoteId, attemptId });
      return;
    }

    // 异步型：把 remote_id 和 attempt 结果一起落库。
    // 两者必须同时可见，否则又会出现"有远端任务但本地不知道"的窗口。
    withTransaction(this.db, () => {
      this.db.prepare('UPDATE jobs SET remote_id = ? WHERE id = ?').run(submitted.remoteId, jobId);
      this.db
        .prepare("UPDATE submission_attempts SET outcome = 'accepted', remote_id = ?, finished_at = ? WHERE attempt_id = ?")
        .run(submitted.remoteId, Date.now(), attemptId);
    });
    this.transition(jobId, 'submitted', `远端任务 ${submitted.remoteId}`);

    // 6. 订阅进度 + 轮询兜底
    if (entry && typeof adapter.subscribe === 'function') {
      entry.unsubscribe = adapter.subscribe(submitted.remoteId, (p) => this.setProgress(jobId, p));
    }
    this.schedulePoll(jobId, submitted.remoteId, started);
  }

  /**
   * 提交已经成功、但本地已经取消 —— 去补一刀远端取消。
   *
   * 无论补没补上，remote_id 都必须先落库：它是这条任务在平台上的唯一线索，
   * 丢了就再也查不到、也退不了。
   */
  private async cancelAfterSubmit(
    jobId: string,
    adapter: ProviderAdapter,
    submitted: Awaited<ReturnType<ProviderAdapter['submit']>>,
    attemptId: string,
    started: number
  ): Promise<void> {
    /*
     * 同步型 Provider 提交即出结果：图已经在手上、钱也已经花了，
     * 这时候"取消"没有任何东西可取消。落库比丢掉更对用户有利。
     *
     * 走带 submission 的那条路 —— remote_id、attempt 结论、结果、终态
     * 必须在**同一个事务**里。分两步写的话，中间崩掉会留下一个
     * 「已接单」但没有结果的记录，而 remoteId 是内存里编的、重启后查不回来，
     * 一条已经付过钱的任务就被判成丢失了。
     */
    const immediate = submitted.immediateResults ?? [];
    if (immediate.length > 0) {
      this.finalizeResults(jobId, immediate, started, { remoteId: submitted.remoteId, attemptId });
      return;
    }

    // 异步型：remote_id 得先落库，它是这条任务在平台上唯一的线索，丢了就查不到也退不了
    withTransaction(this.db, () => {
      this.db.prepare('UPDATE jobs SET remote_id = ? WHERE id = ?').run(submitted.remoteId, jobId);
      this.db
        .prepare("UPDATE submission_attempts SET outcome = 'accepted', remote_id = ?, finished_at = ? WHERE attempt_id = ?")
        .run(submitted.remoteId, Date.now(), attemptId);
    });

    if (this.stateOf(jobId) !== 'cancel_requested') {
      this.forceState(jobId, 'cancel_requested', `远端已接单（${submitted.remoteId}），正在补发取消`);
    }

    let res: { ok: boolean; reason: string };
    try {
      res = await adapter.cancel(submitted.remoteId, 'queued');
    } catch (e) {
      res = { ok: false, reason: toErrorShape(e).message };
    }

    if (res.ok) {
      this.forceState(jobId, 'cancelled', `取消晚于提交，已在远端撤销：${res.reason}`);
      this.release(jobId);
      return;
    }

    /*
     * 远端撤不掉。**不能**就此说"已取消" —— 那条任务还在平台上跑着、还在计费。
     * 回到正常的跟踪路径，直到知道它的最终状态为止。
     */
    this.setError(
      jobId,
      toErrorShape(
        new PsaiError(
          'JOB_CANCEL_UNSUPPORTED',
          `取消慢了一步：请求已经被 ${submitted.remoteId} 接单，远端撤销没成功（${res.reason}）。` +
            '任务会继续跟踪到结束；如果不想要结果，可以直接「丢弃」。'
        )
      )
    );
    this.forceState(jobId, 'submitted', `取消未生效，继续跟踪远端任务 ${submitted.remoteId}`);

    const entry = this.running.get(jobId);
    if (entry) {
      // 取消标志得清掉，否则轮询里那些 `if (cancelled)` 分支会把它当成"已取消"处理
      entry.cancelled = false;
      if (typeof adapter.subscribe === 'function') {
        entry.unsubscribe = adapter.subscribe(submitted.remoteId, (p) => this.setProgress(jobId, p));
      }
    }
    this.schedulePoll(jobId, submitted.remoteId, started);
  }

  /**
   * 提交时遇到「限流 / 远端队列已满」不该判死，要退避重试。
   *
   * RunningHub 的 NORMAL 账号同时只允许跑一个任务，第二个提交会收到 TASK_QUEUE_MAXED。
   * 那不是失败，是"再等等"—— 直接判失败的话，用户看到的是一次莫名其妙的报错，
   * 手动重试一下又好了，这种失败最消耗信任。
   *
   * 只对可重试的错误码退避；鉴权失败、额度耗尽、绑定错误这些重试多少次都是一样的结果，
   * 立刻抛出去让用户看到真正的原因。
   */
  private async submitWithBackoff(
    adapter: ProviderAdapter,
    ctx: Parameters<ProviderAdapter['submit']>[0],
    jobId: string
  ): Promise<Awaited<ReturnType<ProviderAdapter['submit']>>> {
    const delays = SUBMIT_RETRY_DELAYS_MS;
    for (let attempt = 0; ; attempt++) {
      try {
        return await adapter.submit(ctx);
      } catch (e) {
        const shape = toErrorShape(e);
        const canWait = shape.code === 'PROVIDER_RATE_LIMIT' && attempt < delays.length;
        if (!canWait) throw e;
        const wait = delays[attempt]!;
        this.log.info('远端队列已满，退避后重试提交', { jobId, attempt: attempt + 1, waitMs: wait });
        this.setProgress(jobId, {
          ...emptyProgressRecord(`远端队列已满，${Math.round(wait / 1000)} 秒后重试（第 ${attempt + 1} 次）`),
          value: null
        });
        /*
         * 这一等最长两分钟，必须能被打断。
         *
         * 老写法是一个光秃秃的 setTimeout：用户点了取消，界面立刻显示
         * 「取消中」，而这边还要干等两分钟才醒过来看一眼标志位。
         * 关 Helper 时更糟 —— stop() 等不到它，进程要么挂着要么被硬杀，
         * 而那时候数据库已经关了。
         */
        await sleepUnlessAborted(wait, ctx.signal);
        if (ctx.signal?.aborted || this.running.get(jobId)?.cancelled || this.stopped) {
          throw new PsaiError('JOB_CANCELLED', '等待远端队列期间任务已取消');
        }
      }
    }
  }

  private schedulePoll(jobId: string, remoteId: string, startedAt: number): void {
    const entry = this.running.get(jobId);
    if (!entry || this.stopped) return;
    entry.pollTimer = setTimeout(() => {
      void this.pollOnce(jobId, remoteId, startedAt);
    }, POLL_INTERVAL_MS);
  }

  private async pollOnce(jobId: string, remoteId: string, startedAt: number): Promise<void> {
    const entry = this.running.get(jobId);
    if (!entry || this.stopped) return;
    const job = this.find(jobId);
    if (!job || isTerminal(job.state)) {
      this.release(jobId);
      return;
    }

    try {
      const adapter = this.providers.adapter(job.providerId);
      const res = await adapter.poll(remoteId);

      switch (res.state) {
        case 'queued':
          entry.unknownSince = null;
          if (job.state !== 'remote_queued') this.transition(jobId, 'remote_queued', '远端排队中');
          if (res.progress) this.setProgress(jobId, res.progress);
          break;
        case 'running':
          entry.unknownSince = null;
          if (job.state !== 'running') this.transition(jobId, 'running', '开始生成');
          if (res.progress) this.setProgress(jobId, res.progress);
          break;
        case 'done': {
          entry.unknownSince = null;
          this.transition(jobId, 'downloading', '正在下载结果');
          // 下载结果可能是几十兆，同样要能被取消 —— 用户点了取消却还在下，
          // 界面停着而带宽在跑，这种"取消了但没停"最消耗信任
          const images = await adapter.fetchResults(remoteId, entry.abort?.signal);
          this.finalizeResults(jobId, images, startedAt);
          return;
        }
        case 'failed':
          this.failWithShape(jobId, res.error ?? toErrorShape(new PsaiError('JOB_FAILED')));
          return;
        case 'unknown': {
          entry.unknownSince ??= Date.now();
          if (Date.now() - entry.unknownSince > UNKNOWN_GRACE_MS) {
            this.transition(jobId, 'lost', '远端查不到该任务，状态已丢失');
            this.setError(jobId, toErrorShape(new PsaiError('JOB_LOST', `远端 ${remoteId} 查不到`)));
            this.release(jobId);
            return;
          }
          break;
        }
      }
    } catch (e) {
      const shape = toErrorShape(e);
      if (shape.retryable) {
        this.log.debug('轮询失败但可重试，继续', { jobId, code: shape.code });
      } else {
        this.failWithShape(jobId, shape);
        return;
      }
    }

    this.schedulePoll(jobId, remoteId, startedAt);
  }

  /**
   * 收尾：结果 + 用量 + 终态 + 状态事件，一次做完，且可以重复调用。
   *
   * 这里连着写 job_results、资产引用计数、jobs 的完成时间、usage 与状态行。
   * 中途失败（多张结果里第二张写不进去、磁盘满了…）会留下
   * 半份结果 + 对不上的引用计数 + 没有 usage 记录的"已完成"任务。
   * 用户看到的是一个成功的任务少了几张图，而账目里查不到这次调用。
   * （assets.put() 里的写盘回滚不了，但落单的文件是无害的 ——
   * 没有任何行引用它，可被回收；落单的**引用计数**才有害：资产永远删不掉。）
   *
   * 为什么还必须是一个**原子**操作 —— 真机上踩过：
   * 老写法先提交结果和 usage，**再**在事务外做状态迁移。
   * 崩在这两步中间的话，库里已经有结果了，可任务状态还停在 remote_queued。
   * 重启后 recover() 看到一个非终态任务，去查远端 → 远端说 done →
   * 再走一遍落库 → `UNIQUE constraint failed: job_results.job_id, idx`
   * → 这条本来已经成功的任务被判成 JOB_LOST。
   * 沿途还会打出一串 `remote_queued → downloading` 之类的非法转移告警，
   * 因为恢复路径跳过了中间状态。
   *
   * 幂等的做法：先看结果在不在。在就说明上次已经落过库了，
   * 这次只把状态补齐，绝不重新下载、更不重复插入。
   */
  private finalizeResults(
    jobId: string,
    images: Array<{ buffer: Buffer; mime: string }> | null,
    startedAt: number,
    /** 同步型 Provider 专用：把这次提交的结论也并进同一个事务，中间不留缝。 */
    submission?: { remoteId: string; attemptId: string }
  ): boolean {
    if (this.stopped) return false;
    const job = this.get(jobId);

    /*
     * 「结果已经落好了吗」这个问题，不能用 COUNT(job_results) > 0 来回答。
     *
     * 那个条件分不清"三张图全在"和"写到第二张时崩了"。新代码是整体落库的，
     * 自己不会产生半份；但老版本（非原子那一版）留下的库还在用户机器上。
     * 把半份当成完整收尾的话，用户永远少了几张图，而且不会有任何提示 ——
     * 他只会觉得"这次出图好像少了"，然后怀疑是模型的问题。
     *
     * 所以看两个耐久标记：
     *   finalized_at 非空          → 确定完整，可以放心跳过重下
     *   results_expected 对得上数量 → 也算完整（新代码写的，只是标记那次没落上）
     * 两者都没有而库里有结果 → 只能当成**可能不完整**：手上有新图就整体替换，
     * 没有新图就如实说"收不了尾"，交给调用方去重新取。
     */
    const marker = this.db
      .prepare('SELECT finalized_at, results_expected FROM jobs WHERE id = ?')
      .get(jobId) as { finalized_at: number | null; results_expected: number | null };
    const have = (this.db.prepare('SELECT COUNT(*) n FROM job_results WHERE job_id = ?').get(jobId) as { n: number }).n;

    const definitelyComplete =
      marker.finalized_at !== null ||
      (marker.results_expected !== null && marker.results_expected === have && have > 0);

    const incoming = images ?? [];

    /*
     * 手上没有新图、库里也没有旧图 —— 这条任务根本没有结果，收什么尾。
     *
     * 少了这道判断，恢复流程会把一条还没出图的任务一路推到 succeeded，
     * 而它的结果列表是空的：用户看到「已完成」，点开一张图都没有。
     * 这个守卫放在这里而不是调用方，是因为忘记它的代价太大，
     * 而调用方有好几个。
     */
    if (!definitelyComplete && incoming.length === 0 && have === 0) return false;

    if (!definitelyComplete && incoming.length === 0 && have > 0) {
      // 库里有半份来历不明的结果，手上又没有新图 —— 补不齐，也不能假装齐了。
      this.log.warn('结果可能不完整，且手上没有新的结果可用，无法收尾', {
        jobId,
        have,
        expected: marker.results_expected
      });
      return false;
    }
    // 已经确定完整就不再插入，只把状态补齐（幂等）
    const willInsert = !definitelyComplete && incoming.length > 0;

    const gpuMs = job.providerId === 'comfyui' ? Date.now() - startedAt : null;
    // 用任务上冻结的那个值，不是当前设置 —— 见 create() 里的说明
    const auto = job.writeback?.auto === true;
    const needsWriteback = !!job.target && !!job.writeback && job.writeback.mode !== 'assetOnly';
    const finalState: JobState = needsWriteback ? 'writeback_pending' : 'succeeded';
    /*
     * 「仅保存到资产库」这句话要分清是**谁**的选择。
     *
     * 用户在设置里选了「仅存资产库」，和"这次根本没有可写回的目标"
     * （不在 Photoshop 里、没有打开文档）是两回事，可它们最后都走到这里。
     * 用同一句话打发的话，第二种情况下用户会以为是自己设置错了，
     * 跑去设置页翻半天 —— 而实际原因是提交时没有打开的文档。
     */
    const finalNote = needsWriteback
      ? auto
        ? '等待插件写回'
        : '等待用户确认写回'
      : !job.target
        ? '没有可写回的 Photoshop 文档，结果已存入资产库（可在历史页写回）'
        : '按设置「仅存资产库」保存，未写回文档';

    // 状态事件在事务里写，广播留到提交之后 —— 回滚了消息可收不回来。
    const pending: Array<{ from: JobState; to: JobState; note: string }> = [];

    withTransaction(this.db, () => {
      if (submission) {
        this.db.prepare('UPDATE jobs SET remote_id = ? WHERE id = ?').run(submission.remoteId, jobId);
        this.db
          .prepare(
            "UPDATE submission_attempts SET outcome = 'accepted', remote_id = ?, finished_at = ? WHERE attempt_id = ?"
          )
          .run(submission.remoteId, Date.now(), submission.attemptId);
      }
      if (willInsert) {
        /*
         * 有半份旧结果就先整体清掉再重写。
         *
         * 不清的话会撞 job_results 的主键 (job_id, idx)，整个事务回滚，
         * 一条本来能救回来的任务被判成失败。而"保留旧的那几张 + 补上缺的"
         * 也不对：我们并不知道旧的那几张是不是这一次的产物。
         * 引用计数要跟着一起还回去，否则那些资产从此永远删不掉。
         */
        if (have > 0) {
          const olds = this.db.prepare('SELECT asset_id FROM job_results WHERE job_id = ?').all(jobId) as Array<{
            asset_id: string;
          }>;
          for (const o of olds) this.assets.release(o.asset_id);
          this.db.prepare('DELETE FROM job_results WHERE job_id = ?').run(jobId);
          this.log.warn('丢弃来历不明的半份旧结果，用新取回的整体替换', { jobId, dropped: olds.length });
        }
        const ins = this.db.prepare('INSERT INTO job_results(job_id, asset_id, idx) VALUES(?, ?, ?)');
        let idx = 0;
        for (const img of incoming) {
          const rec = this.assets.put(img.buffer, 'result');
          ins.run(jobId, rec.id, idx++);
          this.assets.addRef(rec.id);
        }
        this.db
          .prepare('INSERT INTO usage(job_id, provider_id, at, gpu_ms, note) VALUES(?, ?, ?, ?, ?)')
          .run(
            jobId,
            job.providerId,
            Date.now(),
            gpuMs,
            job.providerId === 'comfyui' ? '本地 GPU 时长' : '云端调用（费用以平台账单为准）'
          );
      }
      /*
       * 收尾时把陈旧的错误清掉。
       *
       * 典型现场：用户点了取消，远端不支持，我们如实记了一条
       * JOB_CANCEL_UNSUPPORTED；然后任务照常跑完出了图。
       * 不清的话，一条成功的任务永远挂着一条红色的错误信息，
       * 用户看到「已完成」旁边写着「取消未生效」，不知道该信哪个。
       */
      /*
       * finalized_at 是这条任务"结果已完整落库"的耐久凭据，
       * 和结果行在同一个事务里写 —— 它出现，就说明那些行也全都在。
       */
      this.db
        .prepare(
          'UPDATE jobs SET finished_at = ?, gpu_ms = ?, error_json = NULL, finalized_at = ?, ' +
            'results_expected = COALESCE(?, results_expected) WHERE id = ?'
        )
        .run(Date.now(), gpuMs, Date.now(), willInsert ? incoming.length : null, jobId);

      // 把提交出去的那次尝试标记成已完成 —— 结果都拿到了，
      // 它不该再被恢复流程当成"结果未知"。
      this.db
        .prepare("UPDATE submission_attempts SET outcome = 'completed', finished_at = ? WHERE job_id = ? AND outcome IN ('pending','accepted')")
        .run(Date.now(), jobId);

      // 状态一路补到终态。恢复场景下当前状态可能是 remote_queued 甚至 submitted，
      // 直接跳到 writeback_pending 会被 canTransition 判成非法 ——
      // 所以这里显式按合法路径逐级走，而不是硬跳。
      let cur = this.stateOf(jobId);
      for (const step of pathToFinal(cur, finalState)) {
        this.writeStateRow(jobId, cur, step, step === finalState ? finalNote : '恢复：补齐中间状态');
        pending.push({ from: cur, to: step, note: step === finalState ? finalNote : '恢复：补齐中间状态' });
        cur = step;
      }
    });

    // 提交之后再广播
    for (const p of pending) {
      this.events.broadcast({
        type: 'job:event',
        event: { jobId, at: Date.now(), from: p.from, to: p.to, note: p.note, errorCode: null }
      });
    }
    this.emit(this.get(jobId));
    this.release(jobId);
    return true;
  }

  /** 只读当前状态，不带整条记录的组装开销。 */
  private stateOf(jobId: string): JobState {
    const row = this.db.prepare('SELECT state FROM jobs WHERE id = ?').get(jobId) as { state: string } | undefined;
    return (row?.state ?? 'created') as JobState;
  }

  /** 只写状态行与事件行，不广播 —— 供事务内部使用。 */
  private writeStateRow(jobId: string, from: JobState, to: JobState, note: string): void {
    const now = Date.now();
    const finished = isTerminal(to) ? now : null;
    this.db
      .prepare('UPDATE jobs SET state = ?, updated_at = ?, finished_at = COALESCE(finished_at, ?) WHERE id = ?')
      .run(to, now, finished, jobId);
    this.db
      .prepare('INSERT INTO job_events(job_id, at, from_state, to_state, note, error_code) VALUES(?, ?, ?, ?, ?, NULL)')
      .run(jobId, now, from, to, note);
  }

  /**
   * 跑一次文本类调用（反推提示词 / 优化提示词），带耐久记录和结果缓存。
   *
   * 这两步跑在**图像提交之前**，而且在付费平台上是真金白银的一次模型调用。
   * 以前它们裸跑，没有任何落盘记录，于是有两个漏洞：
   *
   *  一、崩在反推中途 → 重启后任务重新入队，反推再跑一遍。又付一次钱，
   *      而且没有任何地方记得上一次可能已经扣过了。
   *  二、图像提交失败、用户点重试 → 反推和优化跟着重跑。
   *      用户以为自己重试的是"生图"，实际上把前面那两次也重新买了一遍。
   *
   * 现在：同样的输入先查缓存（同输入必然同结果，命中就一分钱不花）；
   * 没命中就先落一条 pending 再发请求 —— 那条记录是崩溃之后
   * 唯一能回答"这次文本调用的钱花没花"的证据。
   */
  private async runTextTask(
    feature: FeatureSpec,
    presetId: string,
    images: InputImage[],
    userText: string,
    signal?: AbortSignal,
    jobId?: string
  ): Promise<string> {
    const preset = this.prompts.find(presetId);
    if (!preset) throw new PsaiError('INTERNAL_ERROR', `提示词预设不存在: ${presetId}`);
    const binding = this.settings.binding(feature.id);
    const { providerId, adapter } = this.providers.resolveTextProvider(binding?.providerId);
    if (!adapter.textComplete) {
      throw new PsaiError('PROVIDER_UNSUPPORTED', '当前后端不支持文本/视觉能力');
    }

    /*
     * 缓存键 = 预设文本 + 用户文本 + 每张输入图的内容哈希。
     *
     * 用图的**内容**而不是资产 id：同一张图重新上传会得到新的资产 id，
     * 但内容一样，模型的输出也一样 —— 没道理让用户为同一件事付两次钱。
     * 输入图的 filename 本身就是内容寻址的（psai_<sha16>），直接拿来用。
     */
    const cacheKey = createHash('sha256')
      // 各段之间用 \\u0000 隔开：普通分隔符会被内容本身撞上，
      // 不同的输入组合就可能算出同一个键 —— 那会让一次调用复用到别处的结果。
      .update(
        [providerId, presetId, preset.prompt, userText, images.map((i) => i.filename).join(',')].join('\\u0000')
      )
      .digest('hex');

    const cached = this.db
      .prepare("SELECT text FROM text_tasks WHERE cache_key = ? AND outcome = 'succeeded' AND text IS NOT NULL LIMIT 1")
      .get(cacheKey) as { text: string } | undefined;
    if (cached) {
      this.log.debug('复用已有的文本调用结果，不重复计费', { jobId, presetId });
      return cached.text;
    }

    const attemptId = randomUUID();
    const chargeable = isChargeableProvider(providerId);
    // 单独提交：和后面的更新合成一个事务的话，崩溃时这条证据本身也没了
    withTransaction(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO text_tasks(attempt_id, job_id, preset_id, cache_key, chargeable, outcome, started_at)
           VALUES(?, ?, ?, ?, ?, 'pending', ?)`
        )
        .run(attemptId, jobId ?? '', presetId, cacheKey, chargeable ? 1 : 0, Date.now());
    });

    const input: {
      instruction: string;
      userText?: string;
      images?: Array<{ buffer: Buffer; mime: string }>;
      model?: string;
      signal?: AbortSignal;
    } = { instruction: preset.prompt };
    // 反推 / 优化也可能跑几十秒，用户在那段时间里点了取消就该把请求掐掉
    if (signal) input.signal = signal;
    if (userText) input.userText = userText;
    if (images.length) input.images = images.map((i) => ({ buffer: i.buffer, mime: i.mime }));
    // 这里**不**传 binding.model。那是这个功能的「生图模型」，
    // 传进来就等于拿 gpt-image-2 / flux-2-max 去发 chat 请求 —— 必然失败，
    // 而且报的错跟提示词毫无关系。反推/优化用适配器内置的语言模型（GPT-5.6 一族），
    // 用户不需要、也不应该为了用「✨ 优化提示词」先去配一个语言模型。
    try {
      const text = await adapter.textComplete(input);
      this.db
        .prepare("UPDATE text_tasks SET outcome = 'succeeded', text = ?, finished_at = ? WHERE attempt_id = ?")
        .run(text, Date.now(), attemptId);
      return text;
    } catch (e) {
      const shape = toErrorShape(e);
      /*
       * 只有**明确没花钱**的失败才记成 failed。
       *
       * 超时、连接中断这种"不知道对面收没收"的，留在 pending —— 那正是
       * "钱可能已经花了"的证据。记成 failed 的话，下一次重试会以为
       * 上一次确定没扣钱，于是心安理得地再买一次。
       */
      const definitelyFree =
        // 请求在发出去之前就被我们掐了 —— 一个字节都没出去，确定没花钱
        e instanceof RequestAbortedError ||
        shape.code === 'PROVIDER_NOT_CONFIGURED' ||
        shape.code === 'PROVIDER_AUTH_FAILED' ||
        shape.code === 'PROVIDER_UNSUPPORTED' ||
        shape.code === 'JOB_PARAM_INVALID';
      if (definitelyFree || !chargeable) {
        this.db
          .prepare("UPDATE text_tasks SET outcome = 'failed', detail = ?, finished_at = ? WHERE attempt_id = ?")
          .run(shape.message.slice(0, 300), Date.now(), attemptId);
      } else {
        this.db
          .prepare('UPDATE text_tasks SET detail = ? WHERE attempt_id = ?')
          .run(`结果未知：${shape.message.slice(0, 240)}`, attemptId);
      }
      throw e;
    }
  }

  /* ================= 取消 / 重试 / 写回 ================= */

  /**
   * 取消。
   *
   * 返回的是**业务结论**，不是请求成败：cancelled 表示这一刻任务是不是真的停了。
   * "远端不支持取消"是一个正常的、可预期的结果，不是错误 ——
   * 所以它走的是 cancelled=false，而不是 HTTP 层的失败。
   *
   * 三种局面必须分开处理，混在一起就会产生"界面说已取消、平台还在计费"：
   *   还没开始提交 → 直接取消，干净利落
   *   正在提交     → 中止请求，但**不释放资源**，等 run() 那边定论
   *   已经有远端号 → 去远端撤销；撤不掉就如实说撤不掉
   */
  async cancel(jobId: string): Promise<{ cancelled: boolean; pending: boolean; reason: string }> {
    const job = this.get(jobId);
    if (isTerminal(job.state)) {
      return { cancelled: false, pending: false, reason: `任务已经是终态（${job.state}），无法取消` };
    }

    const entry = this.running.get(jobId);
    if (entry) entry.cancelled = true;
    /*
     * 记下进 cancel_requested 之前**确切**的状态。
     *
     * 远端撤不掉时要原样退回去。老代码退的是
     * `job.state === 'running' ? 'running' : 'remote_queued'` ——
     * 一个只有两种可能的猜测，而实际状态可能是 submitted、downloading。
     * 猜错了 transition() 会判成非法转移直接拒绝，任务就永远卡在
     * 「取消中」：不再轮询、也没人推进，用户对着一个转圈的任务干等。
     */
    const prevState = job.state;
    this.transition(jobId, 'cancel_requested', '用户请求取消');

    if (!job.remoteId) {
      /*
       * 没有 remote_id 有两种截然不同的含义，老代码把它们当成了一种。
       *
       * 一种是"还没提交"—— 停在本地队列里，取消它没有任何代价。
       * 另一种是"正在提交"—— 请求已经在飞了，只是回执还没到。
       * 老代码对后者也直接判 cancelled 并 release()：上游随后接单，
       * 卡照占、钱照扣，而本地已经没人管这条任务了。
       * 界面上写着"已取消"，平台上那个任务跑到天亮。
       *
       * 所以正在提交时只做两件事：掐断请求、把资源**继续占着**。
       * 定论交给 run() 里提交返回之后的那段代码 —— 只有它知道上游到底收没收。
       */
      if (entry?.abort) {
        entry.abort.abort();
        return {
          cancelled: false,
          pending: true,
          reason: '正在中止提交请求，稍后会确认平台是否已经接单'
        };
      }
      this.transition(jobId, 'cancelled', '尚未提交到远端，已直接取消');
      this.release(jobId);
      return { cancelled: true, pending: false, reason: '已取消' };
    }

    const adapter = this.providers.adapter(job.providerId);
    const remoteState: RemoteState = job.state === 'running' ? 'running' : 'queued';
    const res = await adapter.cancel(job.remoteId, remoteState);
    if (res.ok) {
      this.transition(jobId, 'cancelled', res.reason);
      this.release(jobId);
      return { cancelled: true, pending: false, reason: res.reason };
    }
    /*
     * 撤不掉：原样退回取消之前的状态，任务继续跑、继续跟踪。
     *
     * 用 forceState 而不是 transition：cancel_requested 的合法出边只有
     * cancelled / running / result_ready / failed 四个，而我们要退回去的
     * 可能是 submitted 或 downloading。用 transition 的话它会拒绝，
     * 任务就卡死在「取消中」了 —— 那正是这里要修的毛病，
     * 不能靠"猜一个转移表允许的状态"绕过去。
     */
    if (entry) entry.cancelled = false;
    this.setError(jobId, toErrorShape(new PsaiError('JOB_CANCEL_UNSUPPORTED', res.reason)));
    this.forceState(jobId, prevState, `取消未生效，已退回原状态：${res.reason}`);
    return { cancelled: false, pending: false, reason: res.reason };
  }

  /** 云端不支持取消时，用户仍可选择"丢弃结果"。 */
  discard(jobId: string): JobRecord {
    const job = this.get(jobId);
    if (isTerminal(job.state)) return job;
    this.transition(jobId, 'cancel_requested', '用户选择丢弃结果');
    this.transition(jobId, 'cancelled', '已丢弃（远端可能仍在执行并计费）');
    this.release(jobId);
    return this.get(jobId);
  }

  /**
   * 这条任务能不能走"普通重来"这条路（重试 / 重跑）。
   *
   * 不能的两种情况，都是钱的问题：
   *   pending    有一次提交发出去了但没等到回复 —— 平台可能已经接单并计费。
   *              再发一次就是第二次扣费，而用户点的是一个看起来无害的「重试」。
   *   abandoned  用户已经在处置面板上明确说过"放弃这一次"，那句话的前提是
   *              "我知道上一次可能已经计费了"。让他之后随手一点「重跑」
   *              就绕开那次确认，等于那个面板白做了。
   *
   * 两种都要求走 resolve-submission —— 那条路上有明确的重复计费确认。
   */
  private billingGate(jobId: string): void {
    const rows = this.db
      .prepare("SELECT outcome, COUNT(*) n FROM submission_attempts WHERE job_id = ? AND outcome IN ('pending','abandoned') GROUP BY outcome")
      .all(jobId) as Array<{ outcome: string; n: number }>;
    if (rows.length === 0) return;
    const pending = rows.find((r) => r.outcome === 'pending');
    throw new PsaiError(
      'SUBMISSION_UNKNOWN',
      pending
        ? '这条任务有一次提交发出去了但没等到回复，平台可能已经计费。' +
          '请在「提交结果未知」的处置面板里确认重复计费风险后再重来，不要走普通重试。'
        : '这条任务的上一次提交被你标记为「放弃」，当时的前提是它可能已经计费。' +
          '要再发一次的话，请走处置面板重新确认一遍风险。'
    );
  }

  retry(jobId: string): JobRecord {
    const job = this.get(jobId);
    if (job.state !== 'failed' && job.state !== 'lost') {
      throw new PsaiError('JOB_PARAM_INVALID', `只有失败或丢失的任务可以重试（当前 ${job.state}）`);
    }
    this.billingGate(jobId);
    // finished_at / gpu_ms 必须一起清掉。
    // transition() 写的是 finished_at = COALESCE(finished_at, ?)，只认第一次；
    // 重试时 started_at 会被刷成新的时间，而 finished_at 还停在上一次失败的时刻，
    // 于是「耗时」算出来是负数 —— 真机上见过 -299170ms。
    this.db
      .prepare(
        'UPDATE jobs SET error_json = NULL, remote_id = NULL, finished_at = NULL, gpu_ms = NULL, updated_at = ? WHERE id = ?'
      )
      .run(Date.now(), jobId);
    if (job.state === 'lost') {
      // lost 是终态，用一条新任务承接，保留血缘
      return this.cloneAndQueue(job);
    }
    this.enqueue(jobId);
    return this.get(jobId);
  }

  /**
   * 用同一套参数重跑，产出一条新任务并记录血缘。
   *
   * 同样要过计费闸门：新任务是新的一次计费，而"上一次到底扣没扣"还没弄清楚。
   * 界面上这个按钮和别处那些「重跑」长得一模一样，用户会顺手点 ——
   * 挡在这里，让他先去处置面板把上一次的账认了。
   */
  rerun(jobId: string): JobRecord {
    this.billingGate(jobId);
    return this.cloneAndQueue(this.get(jobId));
  }

  private cloneAndQueue(job: JobRecord): JobRecord {
    const id = `job_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
    const now = Date.now();
    // 重跑/克隆和新建走同一套原子保证：要么整条新任务都在，要么什么都没有。
    // 半条克隆任务尤其难查 —— 它带着 parent_job_id，看起来像是原任务的一部分。
    let clonedEvent: JobEvent | null = null;
    withTransaction(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO jobs(id, feature_id, provider_id, workflow_id, workflow_version, state, progress_json,
                            params_json, resolved_params_json, target_json, writeback_json, error_json,
                            remote_id, parent_job_id, document_id, created_at, updated_at, started_at, finished_at, gpu_ms)
           VALUES(?, ?, ?, ?, ?, 'created', ?, ?, '{}', ?, ?, NULL, NULL, ?, ?, ?, ?, NULL, NULL, NULL)`
        )
        .run(
          id,
          job.featureId,
          job.providerId,
          job.workflowId,
          job.workflowVersion,
          JSON.stringify(emptyProgressRecord('已创建')),
          JSON.stringify(job.params),
          job.target ? JSON.stringify(job.target) : null,
          job.writeback ? JSON.stringify(job.writeback) : null,
          job.id,
          job.target?.documentId ?? null,
          now,
          now
        );
      const ins = this.db.prepare(
        'INSERT INTO job_inputs(job_id, param_id, asset_id, idx, source) VALUES(?, ?, ?, ?, ?)'
      );
      for (const i of job.inputs) {
        ins.run(id, i.paramId, i.assetId, i.index, i.source);
        this.assets.addRef(i.assetId);
      }
      clonedEvent = this.writeEventRow(id, null, 'created', `由 ${job.id} 重跑`);
    });
    // 同 create()：广播必须在提交之后，否则回滚了消息收不回来
    if (clonedEvent) this.events.broadcast({ type: 'job:event', event: clonedEvent });
    this.transition(id, 'inputs_ready', '输入已就绪');
    this.enqueue(id);
    return this.get(id);
  }

  /** 插件上报写回结果。AI 成功与写回成功严格分离。 */
  /**
   * 插件回报写回结果。
   *
   * attemptId 是 requestWriteback() 发的凭据。带着**过期**凭据回来的那一次会被丢掉：
   * 它多半是一次已经被顶替的写回（面板卡住很久之后才回过神），
   * 让它去改任务状态的话，会把后来那次成功的写回覆盖成失败。
   *
   * 老参数形态（不带 attemptId）仍然接受 —— 手动写回和旧版插件都走那条路。
   */
  /**
   * 插件回报写回结果。
   *
   * attemptId 是**必填**。以前它可选，于是任何一个没带凭据的回报都能直接改状态 ——
   * 一个卡了很久才回过神的面板、一次重放的请求，都能把后来那次成功的写回
   * 覆盖成失败。用户看到"写回失败"，而图其实好好地躺在文档里。
   *
   * 整个收尾（尝试结论 + 任务状态 + 清错误 + 事件）在一个事务里做完，
   * 广播留到提交之后 —— 半截状态会让面板显示"写回中"却再也不动。
   */
  reportWriteback(jobId: string, ok: boolean, detail: string, code?: string, attemptId?: string): JobRecord {
    const job = this.get(jobId);
    if (!attemptId) {
      throw new PsaiError(
        'JOB_PARAM_INVALID',
        '回报写回结果必须带上 attemptId（领取执行权时发放的凭据）—— 没有它就无法确认这次回报对应的是哪一次写回。'
      );
    }

    const row = this.db
      .prepare('SELECT outcome FROM writeback_attempts WHERE attempt_id = ? AND job_id = ?')
      .get(attemptId, jobId) as { outcome: string } | undefined;
    if (!row) {
      throw new PsaiError('WRITEBACK_FAILED', `写回凭据 ${attemptId} 不属于这条任务`);
    }
    if (row.outcome !== 'running') {
      // 已经有结论了（被顶替、或者重复回报）。如实返回当前状态，什么都不改。
      this.log.warn('忽略过期的写回回报', { jobId, attemptId, outcome: row.outcome });
      return job;
    }

    const errShape = ok
      ? null
      : toErrorShape({ code: code ?? 'WRITEBACK_FAILED', message: detail || '写回失败' }, 'WRITEBACK_FAILED');
    const pending: Array<{ from: JobState; to: JobState; note: string }> = [];

    withTransaction(this.db, () => {
      /*
       * 「不确定」要单独记成一种结局，不能混进 failed。
       *
       * failed 的含义是文档没被动过、放心重试。而 WRITEBACK_UNKNOWN
       * 意味着文档**可能已经被动过了** —— 事后对账时这两者的处理完全不同，
       * 混在一起就再也分不开了。
       */
      const outcome = ok ? 'succeeded' : code === 'WRITEBACK_UNKNOWN' ? 'unknown' : 'failed';
      this.db
        .prepare('UPDATE writeback_attempts SET outcome = ?, detail = ?, finished_at = ? WHERE attempt_id = ?')
        .run(outcome, sanitizeExternalText(detail, 300), Date.now(), attemptId);

      const walk = (to: JobState, note: string): void => {
        const from = this.stateOf(jobId);
        if (from === to) return;
        this.writeStateRow(jobId, from, to, note);
        pending.push({ from, to, note });
      };

      const cur = this.stateOf(jobId);
      if (cur === 'writeback_pending' || cur === 'retryable_writeback_failure') {
        walk('writeback_running', '插件开始写回');
      }

      if (ok) {
        /*
         * 成功要连着把 error_json 清掉。
         *
         * 上一次写回失败留下的那条错误不会自己消失：任务显示「已完成」，
         * 旁边却挂着一行红色的「写回失败」。用户不知道该信哪个 ——
         * 而实际情况是图已经在文档里了。
         */
        this.db.prepare('UPDATE jobs SET error_json = NULL, updated_at = ? WHERE id = ?').run(Date.now(), jobId);
        walk('succeeded', detail || '写回成功');
      } else {
        /*
         * 写回失败**不等于**生成失败。
         *
         * 图已经出来了、钱也花了，结果一直留在资产库里。这里进的是
         * retryable_writeback_failure —— 它在 AI_SUCCEEDED_STATES 里，
         * 统计和界面都当作"AI 那边成功了"，只是还没落进文档。
         * 判成 failed 的话，用户会以为要重跑一次（再花一次钱），
         * 而实际上只要再点一次「写回」。
         */
        this.db
          .prepare('UPDATE jobs SET error_json = ?, updated_at = ? WHERE id = ?')
          .run(JSON.stringify(errShape), Date.now(), jobId);
        walk('retryable_writeback_failure', detail || '写回失败，结果已保留');
      }
    });

    // 提交之后再广播 —— 回滚了消息可收不回来
    for (const ev of pending) {
      this.events.broadcast({
        type: 'job:event',
        event: { jobId, at: Date.now(), from: ev.from, to: ev.to, note: ev.note, errorCode: null }
      });
    }
    const fresh = this.get(jobId);
    this.emit(fresh);
    return fresh;
  }

  /**
   * 续租。
   *
   * 写回一张 8K 的智能对象可能要好几十秒，而租约只有两分钟 ——
   * 光靠"到期就让位"的话，一次**正在正常进行**的写回会被判成卡死，
   * 另一个写手接手，用户文档里就有了两个图层。
   * 插件在写的过程中定期来续一次，我们据此知道它还活着。
   */
  renewWriteback(jobId: string, attemptId: string): { ok: boolean; reason: string } {
    const row = this.db
      .prepare('SELECT outcome FROM writeback_attempts WHERE attempt_id = ? AND job_id = ?')
      .get(attemptId, jobId) as { outcome: string } | undefined;
    if (!row) return { ok: false, reason: '凭据不属于这条任务' };
    if (row.outcome !== 'running') return { ok: false, reason: `这次写回已经有结论了（${row.outcome}）` };
    this.db.prepare('UPDATE writeback_attempts SET started_at = ? WHERE attempt_id = ?').run(Date.now(), attemptId);
    return { ok: true, reason: '已续租' };
  }

  /**
   * 领取一次写回的执行权，拿到一个凭据。
   *
   * 写回真正发生在插件里（只有它能碰 Photoshop），Helper 只能授权和记账。
   * 所以"最多写回一次"必须靠一个落盘的租约来保证：
   * 没有它的话，两个面板实例、或者一次手抖的双击，会各自写一遍 ——
   * 用户的文档里凭空多出一个图层，而两次都回报"写回成功"。
   *
   * 租约会过期。插件可能在写回中途被关掉、Photoshop 可能卡死，
   * 那条 running 记录就永远不会有结论 —— 不给过期时间的话，
   * 这条任务从此再也写不回去了。超时的那次标成 superseded，允许新的一次接手。
   */
  requestWriteback(
    jobId: string,
    mode?: WritebackMode,
    layerName?: string,
    opts: { auto?: boolean; assetId?: string; rebindTarget?: PhotoshopTarget } = {}
  ): { job: JobRecord; attemptId: string } {
    let job = this.get(jobId);

    /*
     * 显式改绑写回目标。
     *
     * 用在一种很常见的情形：用户提交时没有打开任何文档（于是这条任务
     * 落成了「仅存资产库」，target 是空的），过一会儿他打开一份文档，
     * 想把那张结果放进去。没有改绑的话，那张图就永远只能待在资产库里 ——
     * 历史页上摆一个「再次写回」按钮却什么都写不进去，是在骗人。
     *
     * 必须是**调用方明确传进来**的目标，绝不由 Helper 自己去猜
     * "现在打开的是哪个文档"：Helper 根本看不见 Photoshop，
     * 而"写进哪里"是用户的决定，不该由我们代劳。
     */
    if (opts.rebindTarget) {
      const t = opts.rebindTarget;
      if (!t.documentId) throw new PsaiError('WRITEBACK_TARGET_INVALID', '改绑的写回目标缺少文档标识');
      withTransaction(this.db, () => {
        this.db
          .prepare('UPDATE jobs SET target_json = ?, document_id = ?, updated_at = ? WHERE id = ?')
          .run(JSON.stringify(t), t.documentId, Date.now(), jobId);
        // 改绑要留痕：事后查"这张图怎么会在这份文档里"时，这一行是唯一的线索
        this.writeEventRow(jobId, this.stateOf(jobId), this.stateOf(jobId), `写回目标已改绑到「${t.documentName}」`);
      });
      this.touchDocument(t);
      job = this.get(jobId);
    }
    if (job.results.length === 0) throw new PsaiError('ASSET_NOT_FOUND', '该任务没有可写回的结果');

    /*
     * 先把这次到底用哪种方式定下来，**再**决定要不要查目标。
     *
     * assetOnly 不碰文档，没有目标也照样成立 —— 而"提交时没有打开的文档"
     * 恰恰是最常落到 assetOnly 的那种情况（job.target 本来就是空的）。
     * 把"必须有目标"放在前面，等于让唯一一条不需要目标的路
     * 也必须先有目标，用户永远拿不到那张图。
     */
    const resolvedMode: WritebackMode = mode ?? job.writeback?.mode ?? 'smartObject';
    if (resolvedMode !== 'assetOnly' && !job.target) {
      throw new PsaiError('WRITEBACK_TARGET_INVALID', '该任务没有记录 Photoshop 目标');
    }

    /*
     * 写回方式必须是这个功能允许的那几种之一。
     *
     * 两边都要拦：插件那边挡的是误操作，这边挡的是"绕过插件直接打接口"。
     * 只在插件里拦的话，接口就成了一个可以让任意任务做任意事情的口子 ——
     * 比如让一个「文生图」任务去做"选区原位"，而它根本没有选区。
     */
    const feature = findFeature(job.featureId);
    const requested = mode ?? job.writeback?.mode;
    if (feature && requested && !feature.writeback.modes.includes(requested)) {
      throw new PsaiError(
        'JOB_PARAM_INVALID',
        `「${feature.label}」不支持「${requested}」写回方式（允许：${feature.writeback.modes.join(' / ')}）`
      );
    }

    /*
     * 原位写回必须有冻结下来的选区，而且要在**发凭据之前**查。
     *
     * 发完凭据才发现没选区的话，插件那边已经开始动文档了 ——
     * 图进去了才报错，用户看到的是"写回失败"外加一个凭空出现、
     * 还放错地方的图层。
     */
    if (requested === 'inPlaceSelection' && !job.target?.selectionBounds) {
      throw new PsaiError(
        'WRITEBACK_TARGET_INVALID',
        '该任务没有记录选区，无法原位写回。请改用「智能对象图层」或「像素图层」。'
      );
    }

    const now = Date.now();
    const attemptId = randomUUID();
    const nextMode = resolvedMode;
    const nextLayer = layerName ?? job.writeback?.layerName ?? '';

    /*
     * 写的是哪一张。
     *
     * 必须校验它真的属于这条任务 —— 否则一个手写的请求就能让我们把
     * **别的任务**的资产记成这一次写回的内容，事后对账时那条记录是错的。
     * 不属于就如实报错，而不是默默换成第一张：调用方以为自己指定了，
     * 结果写进去的是另一张，那种不一致比直接失败难查得多。
     */
    let targetAsset = job.results[0]?.assetId ?? null;
    if (opts.assetId) {
      if (!job.results.some((r) => r.assetId === opts.assetId)) {
        throw new PsaiError(
          'ASSET_NOT_FOUND',
          `资产 ${opts.assetId} 不属于任务 ${jobId}，不能拿它写回`
        );
      }
      targetAsset = opts.assetId;
    }

    let taken = false;
    withTransaction(this.db, () => {
      // 过期的 running 先让位
      this.db
        .prepare(
          "UPDATE writeback_attempts SET outcome = 'superseded', detail = ?, finished_at = ? " +
            "WHERE job_id = ? AND outcome = 'running' AND started_at < ?"
        )
        .run('等待插件回报超时，已被新的一次写回顶替', now, jobId, now - WRITEBACK_LEASE_MS);

      const live = this.db
        .prepare("SELECT attempt_id FROM writeback_attempts WHERE job_id = ? AND outcome = 'running' LIMIT 1")
        .get(jobId) as { attempt_id: string } | undefined;
      if (live) return; // taken 保持 false，事务外面再抛

      this.db
        .prepare(
          `INSERT INTO writeback_attempts(attempt_id, job_id, mode, layer_name, asset_id, auto, outcome, started_at)
           VALUES(?, ?, ?, ?, ?, ?, 'running', ?)`
        )
        .run(attemptId, jobId, nextMode, nextLayer, targetAsset, opts.auto ? 1 : 0, now);

      this.db
        .prepare('UPDATE jobs SET writeback_json = ?, updated_at = ? WHERE id = ?')
        .run(
          JSON.stringify({ mode: nextMode, layerName: nextLayer, auto: job.writeback?.auto ?? false }),
          now,
          jobId
        );
      taken = true;
    });

    if (!taken) {
      throw new PsaiError(
        'WRITEBACK_IN_PROGRESS',
        `任务 ${jobId} 已经有一次写回正在进行。等它结束，或者稍后再试。`
      );
    }

    if (job.state === 'succeeded') {
      // 已成功的任务再写回：开一条不占并发的写回流程
      this.forceState(jobId, 'writeback_pending', '用户请求再次写回');
    } else if (job.state !== 'writeback_pending') {
      this.forceState(jobId, 'writeback_pending', '等待写回');
    }
    return { job: this.get(jobId), attemptId };
  }

  /** 这条任务当前有没有正在进行、且还没过期的写回。 */
  writebackInFlight(jobId: string): boolean {
    const row = this.db
      .prepare("SELECT started_at FROM writeback_attempts WHERE job_id = ? AND outcome = 'running' ORDER BY started_at DESC LIMIT 1")
      .get(jobId) as { started_at: number } | undefined;
    return !!row && Date.now() - row.started_at < WRITEBACK_LEASE_MS;
  }

  /* ================= 恢复 ================= */

  /** Helper 启动时调用。先查远端，绝不盲目重提。 */
  async recover(): Promise<{ requeued: number; resumed: number; lost: number; kept: number }> {
    const rows = this.db.prepare('SELECT id, state, remote_id, started_at FROM jobs').all() as Array<{
      id: string;
      state: string;
      remote_id: string | null;
      started_at: number | null;
    }>;

    let requeued = 0;
    let resumed = 0;
    let lost = 0;
    let kept = 0;

    for (const r of rows) {
      const state = r.state as JobState;
      if (isTerminal(state)) continue;

      if (['created', 'inputs_uploading', 'inputs_ready', 'queued_local'].includes(state)) {
        this.forceState(r.id, 'queued_local', 'Helper 重启后重新入队');
        this.queue.push(r.id);
        requeued++;
        continue;
      }

      if (state === 'submitting' && !r.remote_id) {
        /*
         * 这里是整个恢复流程里最危险的一个分支。
         *
         * 以前无条件重新入队 —— 等于说"没有 remote_id 就是没提交成功"。
         * 但崩溃可能发生在「HTTP 请求已经发到 OpenAI」和「remote_id 落库」之间，
         * 那时候上游其实已经收下并开始计费了。自动重来一次 = 用户被扣两次。
         *
         * 现在看 submission_attempts 里那条 pending 记录来判断：
         *   - 没有 pending 记录       → 确实还没发出去，可以安全重来
         *   - 有 pending 但不计费     → 本地 ComfyUI 之类，重来无成本
         *   - 有 pending 且会计费     → 不知道钱花没花，停在 submission_unknown 等人决定
         */
        const pending = this.db
          .prepare(
            "SELECT attempt_id, chargeable FROM submission_attempts WHERE job_id = ? AND outcome = 'pending' ORDER BY started_at DESC LIMIT 1"
          )
          .get(r.id) as { attempt_id: string; chargeable: number } | undefined;

        if (pending && pending.chargeable === 1) {
          this.forceState(
            r.id,
            'submission_unknown',
            'Helper 重启：请求已发往付费平台但没等到回复，无法确认是否已计费'
          );
          this.setError(
            r.id,
            toErrorShape(
              new PsaiError(
                'SUBMISSION_UNKNOWN',
                '上一次提交发出去了，但 Helper 在收到回复前退出了。' +
                  '平台可能已经接单并计费，也可能没有 —— 本地无法判断。' +
                  '请到平台账单确认后再决定是否重跑；直接重跑有重复扣费的风险。'
              )
            )
          );
          lost++;
          continue;
        }

        this.forceState(r.id, 'queued_local', 'Helper 重启：尚未提交，重新入队');
        this.queue.push(r.id);
        requeued++;
        continue;
      }

      if (['writeback_pending', 'writeback_running'].includes(state)) {
        this.forceState(r.id, 'writeback_pending', 'Helper 重启：等待插件写回');
        kept++;
        continue;
      }

      /*
       * 结果已经落库了 —— 上次崩在"结果写完"和"状态迁移完"之间。
       *
       * 这条分支必须排在查远端之前。真机上就是没有它：恢复流程照常去查远端、
       * 拿到 done、再走一遍 storeResults，然后撞
       * `UNIQUE constraint failed: job_results.job_id, job_results.idx`，
       * 一条本来已经出图成功的任务被判成 JOB_LOST，
       * 沿途还刷了一串 `remote_queued → downloading` 的非法转移告警。
       *
       * 结果**确定完整**才直接收尾，不下载、不插入、不联网。
       *
       * "确定"很重要：光看有没有结果行是不够的，那分不清完整和半份。
       * 半份是老版本（非原子那一版）留下的库里真实存在的东西 ——
       * 当成完整收尾的话，用户永远少了几张图，而且没有任何提示。
       * 所以收不了尾就往下走，让查远端那条路重新取一份完整的回来。
       */
      if (this.finalizeResults(r.id, null, r.started_at ?? Date.now())) {
        resumed++;
        continue;
      }

      // 已经提交出去的：查远端
      if (!r.remote_id) {
        this.forceState(r.id, 'lost', 'Helper 重启：没有远端任务号，无法恢复');
        this.setError(r.id, toErrorShape(new PsaiError('JOB_LOST', '没有远端任务号')));
        lost++;
        continue;
      }

      const job = this.get(r.id);
      try {
        const adapter = this.providers.adapter(job.providerId);
        const res = await adapter.poll(r.remote_id);
        if (res.state === 'done') {
          this.forceState(r.id, 'downloading', 'Helper 重启：远端已完成，直接取结果');
          const images = await adapter.fetchResults(r.remote_id, this.running.get(r.id)?.abort?.signal);
          // finalizeResults 是幂等的，而且会按合法路径把状态补齐，不刷非法转移告警。
          // 手上有完整的一份，它会把库里那份来历不明的半份整体替换掉。
          if (!this.finalizeResults(r.id, images, r.started_at ?? Date.now())) {
            this.forceState(r.id, 'lost', 'Helper 重启：结果不完整且无法补齐');
            this.setError(r.id, toErrorShape(new PsaiError('JOB_LOST', '库里的结果不完整，远端也补不回来')));
            lost++;
            continue;
          }
          resumed++;
        } else if (res.state === 'queued' || res.state === 'running') {
          this.forceState(r.id, res.state === 'running' ? 'running' : 'remote_queued', 'Helper 重启：远端仍在执行，继续监听');
          const entry: RunningEntry = {
            jobId: r.id,
            unsubscribe: null,
            pollTimer: null,
            cancelled: false,
            abort: null,
            unknownSince: null
          };
          this.running.set(r.id, entry);
          this.released.delete(r.id);
          if (typeof adapter.subscribe === 'function') {
            entry.unsubscribe = adapter.subscribe(r.remote_id, (p) => this.setProgress(r.id, p));
          }
          this.schedulePoll(r.id, r.remote_id, r.started_at ?? Date.now());
          resumed++;
        } else if (res.state === 'failed') {
          this.forceState(r.id, 'failed', 'Helper 重启：远端报告失败');
          this.setError(r.id, res.error ?? toErrorShape(new PsaiError('JOB_FAILED')));
        } else {
          this.forceState(r.id, 'lost', 'Helper 重启：远端查不到该任务');
          this.setError(r.id, toErrorShape(new PsaiError('JOB_LOST', `远端 ${r.remote_id} 查不到`)));
          lost++;
        }
      } catch (e) {
        this.forceState(r.id, 'lost', 'Helper 重启：无法连接远端确认状态');
        this.setError(r.id, toErrorShape(e, 'JOB_LOST'));
        lost++;
      }
    }

    this.pump();
    this.log.info('任务恢复完成', { requeued, resumed, lost, kept });
    return { requeued, resumed, lost, kept };
  }

  /* ================= 状态机 ================= */

  /*
   * 下面这一组写入口都以 `if (this.stopped) return;` 开头。
   *
   * stop() 之后数据库就关了，但**还在飞的请求收不回来**：一次挂在半空的提交
   * 可能几十秒后才失败，那时它的错误处理会照常去写状态、写事件 ——
   * 打在一个已经关掉的连接上，得到 "database is not open"。
   * 关机路径上这表现为一串刺眼的日志，还会盖住真正的错误；
   * 但更重要的是这些写入本来就不该发生：引擎已经停了，
   * 它对这条任务不再有话语权。该说什么，交给下次启动的 recover() 去说。
   */
  private transition(jobId: string, to: JobState, note: string): void {
    if (this.stopped) return;
    const job = this.find(jobId);
    if (!job) return;
    if (job.state === to) return;
    if (!canTransition(job.state, to)) {
      this.log.warn('非法状态转移被拒绝', { jobId, from: job.state, to, note });
      return;
    }
    this.writeState(jobId, job.state, to, note);
  }

  /** 恢复流程用：跳过转移表约束，但一样落审计。 */
  private forceState(jobId: string, to: JobState, note: string): void {
    if (this.stopped) return;
    const job = this.find(jobId);
    if (!job || job.state === to) return;
    this.writeState(jobId, job.state, to, note);
  }

  private writeState(jobId: string, from: JobState, to: JobState, note: string): void {
    if (this.stopped) return;
    const now = Date.now();
    const finished = isTerminal(to) ? now : null;
    this.db
      .prepare('UPDATE jobs SET state = ?, updated_at = ?, finished_at = COALESCE(finished_at, ?) WHERE id = ?')
      .run(to, now, finished, jobId);
    this.event(jobId, from, to, note);
    if (isTerminal(to)) this.release(jobId);
    this.emit(this.get(jobId));
  }

  private fail(jobId: string, e: unknown): void {
    this.failWithShape(jobId, toErrorShape(e));
  }

  private failWithShape(jobId: string, shape: ReturnType<typeof toErrorShape>): void {
    if (this.stopped) return;
    this.setError(jobId, shape);
    const job = this.find(jobId);
    if (job && !isTerminal(job.state)) {
      this.forceState(jobId, 'failed', `${shape.code}: ${shape.message}`);
    }
    this.release(jobId);
  }

  /**
   * 把错误落到任务上。
   *
   * 这里是外部文本进入**耐久存储**的最后一道关，所以无条件清一遍。
   * error_json 会出现在接口响应、面板、诊断包、用户随手截的图里 ——
   * 上游或中间代理把我们那个带签名的 URL 原样回显在错误正文里是很常见的事，
   * 而那段文本我们一个字都没参与拼装。日志那边有 redact() 兜底，
   * 数据库这边只有这一处。
   */
  private setError(jobId: string, shape: ReturnType<typeof toErrorShape>): void {
    if (this.stopped) return;
    const clean = {
      ...shape,
      message: sanitizeExternalText(shape.message, 600),
      ...(shape.details === undefined ? {} : { details: sanitizeExternalText(shape.details, 600) })
    };
    this.db.prepare('UPDATE jobs SET error_json = ?, updated_at = ? WHERE id = ?').run(
      JSON.stringify(clean),
      Date.now(),
      jobId
    );
    this.log.warn('任务错误', { jobId, ...clean });
  }

  private setProgress(jobId: string, p: JobProgress): void {
    if (this.stopped) return;
    this.db.prepare('UPDATE jobs SET progress_json = ?, updated_at = ? WHERE id = ?').run(
      JSON.stringify(p),
      Date.now(),
      jobId
    );
    const job = this.find(jobId);
    if (job) this.emit(job);
  }

  /** 只写事件行，不广播 —— 供事务内部使用，广播留到提交之后。 */
  private writeEventRow(jobId: string, from: JobState | null, to: JobState, note: string): JobEvent {
    const at = Date.now();
    this.db
      .prepare('INSERT INTO job_events(job_id, at, from_state, to_state, note, error_code) VALUES(?, ?, ?, ?, ?, NULL)')
      .run(jobId, at, from, to, note);
    return { jobId, at, from, to, note, errorCode: null };
  }

  private event(jobId: string, from: JobState | null, to: JobState, note: string): void {
    this.events.broadcast({ type: 'job:event', event: this.writeEventRow(jobId, from, to, note) });
  }

  private emit(job: JobRecord): void {
    this.events.broadcast({ type: 'job:update', job });
  }

  /* ================= 读取 ================= */

  find(id: string): JobRecord | null {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.hydrate(row) : null;
  }

  get(id: string): JobRecord {
    const j = this.find(id);
    if (!j) throw new PsaiError('JOB_NOT_FOUND', id);
    return j;
  }

  list(q: JobListQuery = {}): JobRecord[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (q.state) {
      where.push('state = ?');
      args.push(q.state);
    }
    if (q.featureId) {
      where.push('feature_id = ?');
      args.push(q.featureId);
    }
    if (q.documentId !== undefined) {
      where.push('document_id = ?');
      args.push(q.documentId);
    }
    const sql =
      'SELECT * FROM jobs' +
      (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
      ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    args.push(Math.min(500, q.limit ?? 100), q.offset ?? 0);
    const rows = this.db.prepare(sql).all(...(args as never[])) as Array<Record<string, unknown>>;
    return rows.map((r) => this.hydrate(r));
  }

  eventsOf(jobId: string): JobEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM job_events WHERE job_id = ? ORDER BY at, id')
      .all(jobId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      jobId: String(r['job_id']),
      at: Number(r['at']),
      from: r['from_state'] === null ? null : (String(r['from_state']) as JobState),
      to: String(r['to_state']) as JobState,
      note: String(r['note'] ?? ''),
      errorCode: r['error_code'] === null ? null : (String(r['error_code']) as JobEvent['errorCode'])
    }));
  }

  remove(id: string): void {
    const job = this.get(id);
    if (isActive(job.state)) throw new PsaiError('JOB_PARAM_INVALID', '请先取消正在进行的任务');
    // 删除本身也要原子：删到一半留下的孤儿行会一直挂在库里，
    // 而资产引用计数已经减过了 —— 计数和实际引用从此对不上。
    withTransaction(this.db, () => {
      for (const i of job.inputs) this.assets.release(i.assetId);
      for (const r of job.results) this.assets.release(r.assetId);
      this.db.prepare('DELETE FROM job_inputs WHERE job_id = ?').run(id);
      this.db.prepare('DELETE FROM job_results WHERE job_id = ?').run(id);
      this.db.prepare('DELETE FROM job_events WHERE job_id = ?').run(id);
      // 提交尝试记录跟着任务走。留着的话，任务都没了却还有一条 pending，
      // 以后按 outcome 统计"有多少次不确定的提交"时会一直多出这一笔。
      this.db.prepare('DELETE FROM submission_attempts WHERE job_id = ?').run(id);
      this.db.prepare('DELETE FROM writeback_attempts WHERE job_id = ?').run(id);
      this.db.prepare('DELETE FROM text_tasks WHERE job_id = ?').run(id);
      this.db.prepare('DELETE FROM jobs WHERE id = ?').run(id);
    });
  }

  /* ================= submission_unknown 的处置 ================= */

  /**
   * 用户对「提交结果未知」做出的决定。
   *
   * 这个状态是终态，唯一的出口就是人明确选一个：
   *  - retry   ：确认过账单，愿意承担可能重复计费的风险，重来一次（新的 attempt、新的幂等键）
   *  - abandon ：放弃这次，任务判失败
   *  - adopt   ：在平台上找到了这次任务，把 remote_id 填回来接着轮询
   *
   * 决定会写进 submission_attempts 和事件流 —— 以后对账时能看到
   * "谁在什么时候、基于什么判断做了这个选择"。
   */
  resolveSubmissionUnknown(
    jobId: string,
    decision: 'retry' | 'abandon' | 'adopt',
    opts: { remoteId?: string; confirmedDuplicateBillingRisk?: boolean } = {}
  ): JobRecord {
    const job = this.get(jobId);
    if (job.state !== 'submission_unknown') {
      throw new PsaiError('JOB_PARAM_INVALID', `只有「提交结果未知」的任务需要处置（当前 ${job.state}）`);
    }

    const note = (d: string): string => `用户处置：${d}`;

    /*
     * 先把所有参数校验做完，再动数据库。
     *
     * 顺序反过来写过一版：进门就把 pending 的 attempt 改成 resolved/accepted，
     * 然后才检查"认领有没有给任务号""重来有没有确认风险"。于是一次**被拒绝**的
     * 请求会把那条 pending 记录消掉 —— 而它正是"钱可能已经花了"的唯一证据。
     * 用户什么也没做成，审计里却留下一句"已处置"。
     */
    let remoteId = (opts.remoteId ?? '').trim();
    if (decision === 'adopt') {
      if (!remoteId) {
        throw new PsaiError('JOB_PARAM_INVALID', '认领已提交的任务需要提供平台上的任务号');
      }
      /*
       * 任务号必须按这个平台的规矩规范化，而且要在写库**之前**。
       *
       * 用户抄回来的是平台界面上的样子，而我们内部存的往往带前缀
       * （liblib-comfy: / mj: 之类）。原样存进去的话，poll() 会拿着一个
       * 自己都不认识的 id 去查，得到 unknown，最后把一条其实好好的、
       * 已经付过钱的任务判成丢失 —— 用户以为救回来了，结果更糟。
       */
      const adapter = this.providers.adapter(job.providerId);
      if (typeof adapter.normalizeRemoteId !== 'function') {
        throw new PsaiError(
          'PROVIDER_UNSUPPORTED',
          `${job.providerId} 的任务号是本地临时编号，认领它没有意义。请选择「放弃」或确认风险后重新提交。`
        );
      }
      const normalized = adapter.normalizeRemoteId(remoteId);
      if (normalized === null) {
        throw new PsaiError(
          'PROVIDER_UNSUPPORTED',
          `${job.providerId} 不支持认领已提交的任务。请选择「放弃」或确认风险后重新提交。`
        );
      }
      remoteId = normalized;
    }

    /*
     * retry：必须**严格等于 true** 才放行。
     *
     * 写成 `!opts.confirmedDuplicateBillingRisk` 的话，JSON 里传字符串
     * "false" 就能过 —— 非空字符串是 truthy。一个手写 curl、
     * 或者哪天某个客户端把布尔值序列化成字符串，就悄悄绕过了这道确认，
     * 而这道确认是整个 submission_unknown 状态存在的全部意义。
     */
    if (decision === 'retry' && opts.confirmedDuplicateBillingRisk !== true) {
      throw new PsaiError(
        'JOB_PARAM_INVALID',
        '重新提交前必须确认已知晓重复计费风险（confirmedDuplicateBillingRisk 必须是布尔值 true）：' +
          '上一次可能已经在平台侧计费，重跑会再产生一次费用。'
      );
    }

    /*
     * 处置结论落库。
     *
     * outcome 分得比以前细：abandon 写 abandoned、retry 写 retried。
     * 以前两者都写 resolved，于是事后分不清"用户放弃了"和"用户确认风险后重来了"——
     * 而普通重试/重跑的闸门正要靠这个区别：放弃过的任务不许再走普通那条路。
     */
    const outcome = decision === 'adopt' ? 'accepted' : decision === 'abandon' ? 'abandoned' : 'retried';
    withTransaction(this.db, () => {
      this.db
        .prepare(
          "UPDATE submission_attempts SET outcome = ?, detail = ?, finished_at = ?, remote_id = COALESCE(?, remote_id) " +
            "WHERE job_id = ? AND outcome = 'pending'"
        )
        .run(
          outcome,
          `用户选择 ${decision}`,
          Date.now(),
          // 只有认领才带任务号；COALESCE 保证其余两种决定不会把已有的号抹掉
          decision === 'adopt' ? remoteId : (null as unknown as string),
          jobId
        );
      if (decision === 'adopt') {
        this.db.prepare('UPDATE jobs SET remote_id = ? WHERE id = ?').run(remoteId, jobId);
      }
    });

    if (decision === 'abandon') {
      this.forceState(jobId, 'failed', note('放弃这次提交'));
      return this.get(jobId);
    }

    if (decision === 'adopt') {
      this.forceState(jobId, 'submitted', note(`认领远端任务 ${remoteId}`));
      // 接着按正常流程轮询它
      const entry: RunningEntry = {
        jobId,
        unsubscribe: null,
        pollTimer: null,
        cancelled: false,
        abort: null,
        unknownSince: null
      };
      this.running.set(jobId, entry);
      this.released.delete(jobId);
      this.schedulePoll(jobId, remoteId, job.startedAt ?? Date.now());
      return this.get(jobId);
    }

    this.forceState(jobId, 'queued_local', note('确认风险后重新提交'));
    this.queue.push(jobId);
    this.pump();
    return this.get(jobId);
  }

  activeCount(): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM jobs WHERE state IN
         ('inputs_uploading','inputs_ready','queued_local','submitting','submitted','remote_queued','running','downloading','cancel_requested')`
      )
      .get() as { n: number };
    return row.n;
  }

  private inputsOf(jobId: string): JobImageInput[] {
    const rows = this.db
      .prepare('SELECT * FROM job_inputs WHERE job_id = ? ORDER BY param_id, idx')
      .all(jobId) as Array<Record<string, unknown>>;
    return rows.map((r) => {
      const asset = this.assets.find(String(r['asset_id']));
      return {
        paramId: String(r['param_id']),
        assetId: String(r['asset_id']),
        index: Number(r['idx']),
        source: String(r['source'] ?? ''),
        width: asset?.width ?? 0,
        height: asset?.height ?? 0,
        sha256: asset?.sha256 ?? ''
      };
    });
  }

  private resultsOf(jobId: string): JobResultAsset[] {
    const rows = this.db
      .prepare('SELECT * FROM job_results WHERE job_id = ? ORDER BY idx')
      .all(jobId) as Array<Record<string, unknown>>;
    return rows.map((r) => {
      const asset = this.assets.find(String(r['asset_id']));
      return {
        assetId: String(r['asset_id']),
        index: Number(r['idx']),
        width: asset?.width ?? 0,
        height: asset?.height ?? 0,
        bytes: asset?.bytes ?? 0,
        sha256: asset?.sha256 ?? '',
        mime: asset?.mime ?? 'image/png'
      };
    });
  }

  private touchDocument(t: PhotoshopTarget): void {
    this.db
      .prepare(
        `INSERT INTO documents(document_id, name, path, last_seen_at) VALUES(?, ?, ?, ?)
         ON CONFLICT(document_id) DO UPDATE SET name = excluded.name, path = excluded.path, last_seen_at = excluded.last_seen_at`
      )
      .run(t.documentId, t.documentName, t.documentPath, Date.now());
  }

  private hydrate(r: Record<string, unknown>): JobRecord {
    const id = String(r['id']);
    return {
      id,
      featureId: String(r['feature_id']),
      providerId: String(r['provider_id']),
      workflowId: r['workflow_id'] === null ? null : String(r['workflow_id']),
      workflowVersion: r['workflow_version'] === null ? null : String(r['workflow_version']),
      state: String(r['state']) as JobState,
      progress: parse(String(r['progress_json'] ?? '{}'), emptyProgressRecord('')),
      params: parse<Record<string, unknown>>(String(r['params_json'] ?? '{}'), {}),
      resolvedParams: parse<Record<string, unknown>>(String(r['resolved_params_json'] ?? '{}'), {}),
      inputs: this.inputsOf(id),
      results: this.resultsOf(id),
      target: r['target_json'] === null ? null : parse<PhotoshopTarget | null>(String(r['target_json']), null),
      writeback: hydrateWriteback(r['writeback_json']),
      error: r['error_json'] === null ? null : parse(String(r['error_json']), null),
      remoteId: r['remote_id'] === null ? null : String(r['remote_id']),
      parentJobId: r['parent_job_id'] === null ? null : String(r['parent_job_id']),
      createdAt: Number(r['created_at']),
      updatedAt: Number(r['updated_at']),
      startedAt: r['started_at'] === null ? null : Number(r['started_at']),
      finishedAt: r['finished_at'] === null ? null : Number(r['finished_at']),
      gpuMs: r['gpu_ms'] === null ? null : Number(r['gpu_ms'])
    };
  }

  stop(): void {
    this.stopped = true;
    for (const entry of this.running.values()) {
      entry.unsubscribe?.();
      if (entry.pollTimer) clearTimeout(entry.pollTimer);
      /*
       * 把还在飞的请求都掐掉。
       *
       * 不掐的话它们会在数据库关掉之后才失败，然后去写一个已经关闭的连接；
       * 更要紧的是关 Helper 时得等它们自己超时（最长几分钟），
       * 用户看到的是"关不掉"。掐断之后 run() 那边会认出是我们自己掐的，
       * 走"结果未知"那条诚实的路，不会误判成失败。
       */
      entry.abort?.abort();
    }
    this.running.clear();
    this.queue = [];
  }
}

/**
 * 读出任务上的写回配置。
 *
 * `auto` 是后加的字段，老库里的任务没有它 —— 缺失时按 false 处理。
 * 不能"缺失就读当前设置"：那等于让一条几个月前的任务跟着今天的开关走，
 * 用户一打开自动写回，历史里一堆早就结束的任务会突然往文档里写东西。
 */
function hydrateWriteback(raw: unknown): JobRecord['writeback'] {
  if (raw === null || raw === undefined) return null;
  const v = parse<{ mode?: WritebackMode; layerName?: string; auto?: boolean } | null>(String(raw), null);
  if (!v || !v.mode) return null;
  return { mode: v.mode, layerName: v.layerName ?? '', auto: v.auto === true };
}

/**
 * 睡一会儿，但信号一 abort 就立刻醒。
 *
 * 光秃秃的 setTimeout 在这里是有害的：退避最长要等两分钟，
 * 那两分钟里用户点了取消也没人理，关 Helper 也得干等。
 */
function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

function emptyProgressRecord(message: string): JobProgress {
  return { value: null, step: null, total: null, node: null, message };
}

function parse<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

function extOf(mime: string): string {
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/webp') return 'webp';
  return 'png';
}

/**
 * 去掉值为 undefined 的键。
 *
 * 展开合并时 `{...defaults, ...user}` 里 user 的 undefined 会把 default 打掉，
 * 结果是"用户什么都没填，默认值也没了"。这个函数保证只有真正给了值的键才参与覆盖。
 */
function stripUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out;
}


/**
 * 这个 Provider 会不会产生费用。
 *
 * 决定崩溃恢复时敢不敢自动重来：本地 ComfyUI 重跑一次只是多花点显卡时间，
 * 而云端平台重跑一次是真金白银。名单按「不确定就当会计费」的方向取舍 ——
 * 猜错的代价不对称：把免费的当付费，最多让用户多点一次确认；
 * 把付费的当免费，用户会被扣两次而且不知道为什么。
 */
export function isChargeableProvider(providerId: string): boolean {
  return providerId !== 'comfyui';
}


/**
 * 从当前状态走到目标终态的**合法**路径。
 *
 * 恢复场景下当前状态可能停在 submitted / remote_queued / running 任意一处，
 * 而目标是 writeback_pending 或 succeeded。直接跳过去会被 canTransition 拒掉，
 * 日志里刷出一串「非法状态转移被拒绝」，状态则永远停在原地 ——
 * 真机上就是这么把一条已经出图的任务拖成 JOB_LOST 的。
 *
 * 这里用广度优先在转移表里找一条最短合法路径，逐级走过去。
 * 找不到路径时返回空数组，调用方保持原状 —— 硬写一个非法状态比停着更糟。
 */
export function pathToFinal(from: JobState, to: JobState): JobState[] {
  if (from === to) return [];
  const seen = new Set<JobState>([from]);
  const queue: Array<{ at: JobState; path: JobState[] }> = [{ at: from, path: [] }];
  while (queue.length > 0) {
    const { at, path } = queue.shift()!;
    for (const next of JOB_TRANSITIONS[at] ?? []) {
      if (seen.has(next)) continue;
      const nextPath = [...path, next];
      if (next === to) return nextPath;
      seen.add(next);
      queue.push({ at: next, path: nextPath });
    }
  }
  return [];
}
