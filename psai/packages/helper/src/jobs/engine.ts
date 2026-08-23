/**
 * 作业引擎：18 态状态机 + 本地并发闸 + 重启恢复 + 取消。
 *
 * 三条铁律：
 *  1. AI 出图成功 与 写回 Photoshop 成功 严格分离。写回失败 → retryable_writeback_failure，
 *     结果永久留在资产库，用户随时可以再写回。
 *  2. 重启恢复时先查远端真实状态，绝不盲目重新提交（会重复占卡、重复计费）。
 *  3. 并发额度的释放必须幂等 —— 重复释放会让计数漂移，最终把队列永久卡死。
 */

import { randomUUID } from 'node:crypto';
import {
  PsaiError,
  toErrorShape,
  canTransition,
  isTerminal,
  isActive,
  findFeature,
  renderLayerName,
  breadcrumb,
  rhPresetByWorkflowId
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
  /** unknown 状态第一次出现的时间，用于判定"真的丢了" */
  unknownSince: number | null;
}

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

    // 输入没问题了，再决定这次用哪个后端
    const { providerId } = this.providers.resolveProvider(req.featureId, req.providerId);

    // 工作流解析（comfy 类必须有）
    let workflowId: string | null = null;
    let workflowVersion: string | null = null;
    if (feature.engine === 'comfy-workflow' && providerId !== 'runninghub') {
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
        JSON.stringify({ mode: writebackMode, layerName }),
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

    this.event(id, null, 'created', `功能 ${feature.id} · Provider ${providerId}`);
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
      const entry: RunningEntry = { jobId, unsubscribe: null, pollTimer: null, cancelled: false, unknownSince: null };
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
      reverseText = await this.runTextTask(feature, reverse.presetId, images, '');
    }

    // 3. 优化提示词（需要时）
    let enhanced: string | undefined;
    if (wantsEnhance(feature, job.params)) {
      const userPrompt = typeof job.params['prompt'] === 'string' ? (job.params['prompt'] as string) : '';
      if (userPrompt.trim()) {
        this.setProgress(jobId, { ...emptyProgressRecord('正在优化提示词'), value: null });
        enhanced = await this.runTextTask(feature, 'preset.skills.promptEnhance', [], userPrompt);
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
    const ctx = {
      jobId,
      featureId: job.featureId,
      params: resolved.values,
      inputs: images,
      prompt: resolved.prompt,
      negativePrompt: resolved.negativePrompt,
      ...(job.workflowId ? { workflow: this.workflows.get(job.workflowId) } : {}),
      ...(binding?.model ? { model: binding.model } : {}),
      ...(typeof resolved.values['model'] === 'string' && resolved.values['model']
        ? { model: resolved.values['model'] as string }
        : {}),
      ...(binding?.remoteWorkflowId ? { remoteWorkflowId: binding.remoteWorkflowId } : {})
    };

    const entry = this.running.get(jobId);
    if (entry?.cancelled) {
      this.transition(jobId, 'cancelled', '提交前已取消');
      this.release(jobId);
      return;
    }

    const started = Date.now();
    this.db.prepare('UPDATE jobs SET started_at = ? WHERE id = ?').run(started, jobId);
    const submitted = await this.submitWithBackoff(adapter, ctx, jobId);
    this.db.prepare('UPDATE jobs SET remote_id = ? WHERE id = ?').run(submitted.remoteId, jobId);
    this.transition(jobId, 'submitted', `远端任务 ${submitted.remoteId}`);

    // 同步型 Provider 提交即出结果
    if (submitted.immediateResults?.length) {
      this.transition(jobId, 'downloading', '正在保存结果');
      await this.storeResults(jobId, submitted.immediateResults, started);
      return;
    }

    // 6. 订阅进度 + 轮询兜底
    if (entry && typeof adapter.subscribe === 'function') {
      entry.unsubscribe = adapter.subscribe(submitted.remoteId, (p) => this.setProgress(jobId, p));
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
        await new Promise((r) => setTimeout(r, wait));
        if (this.running.get(jobId)?.cancelled || this.stopped) {
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
          const images = await adapter.fetchResults(remoteId);
          await this.storeResults(jobId, images, startedAt);
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

  private async storeResults(
    jobId: string,
    images: Array<{ buffer: Buffer; mime: string }>,
    startedAt: number
  ): Promise<void> {
    const ins = this.db.prepare('INSERT INTO job_results(job_id, asset_id, idx) VALUES(?, ?, ?)');
    let idx = 0;
    for (const img of images) {
      const rec = this.assets.put(img.buffer, 'result');
      ins.run(jobId, rec.id, idx++);
      this.assets.addRef(rec.id);
    }

    const job = this.get(jobId);
    const gpuMs = job.providerId === 'comfyui' ? Date.now() - startedAt : null;
    this.db
      .prepare('UPDATE jobs SET finished_at = ?, gpu_ms = ? WHERE id = ?')
      .run(Date.now(), gpuMs, jobId);
    this.db
      .prepare('INSERT INTO usage(job_id, provider_id, at, gpu_ms, note) VALUES(?, ?, ?, ?, ?)')
      .run(jobId, job.providerId, Date.now(), gpuMs, job.providerId === 'comfyui' ? '本地 GPU 时长' : '云端调用（费用以平台账单为准）');

    this.transition(jobId, 'result_ready', `${images.length} 张结果已保存`);

    const auto = this.settings.get().generation.autoWriteback;
    const hasTarget = !!job.target;
    if (hasTarget && job.writeback && job.writeback.mode !== 'assetOnly') {
      this.transition(jobId, 'writeback_pending', auto ? '等待插件写回' : '等待用户确认写回');
    } else {
      this.transition(jobId, 'succeeded', '仅保存到资产库');
    }
    this.release(jobId);
  }

  private async runTextTask(
    feature: FeatureSpec,
    presetId: string,
    images: InputImage[],
    userText: string
  ): Promise<string> {
    const preset = this.prompts.find(presetId);
    if (!preset) throw new PsaiError('INTERNAL_ERROR', `提示词预设不存在: ${presetId}`);
    const binding = this.settings.binding(feature.id);
    const { adapter } = this.providers.resolveTextProvider(binding?.providerId);
    if (!adapter.textComplete) {
      throw new PsaiError('PROVIDER_UNSUPPORTED', '当前后端不支持文本/视觉能力');
    }
    const input: {
      instruction: string;
      userText?: string;
      images?: Array<{ buffer: Buffer; mime: string }>;
      model?: string;
    } = { instruction: preset.prompt };
    if (userText) input.userText = userText;
    if (images.length) input.images = images.map((i) => ({ buffer: i.buffer, mime: i.mime }));
    if (binding?.model) input.model = binding.model;
    return adapter.textComplete(input);
  }

  /* ================= 取消 / 重试 / 写回 ================= */

  async cancel(jobId: string): Promise<{ ok: boolean; reason: string }> {
    const job = this.get(jobId);
    if (isTerminal(job.state)) return { ok: false, reason: `任务已经是终态（${job.state}），无法取消` };

    const entry = this.running.get(jobId);
    if (entry) entry.cancelled = true;
    this.transition(jobId, 'cancel_requested', '用户请求取消');

    if (!job.remoteId) {
      this.transition(jobId, 'cancelled', '尚未提交到远端，已直接取消');
      this.release(jobId);
      return { ok: true, reason: '已取消' };
    }

    const adapter = this.providers.adapter(job.providerId);
    const remoteState: RemoteState = job.state === 'running' ? 'running' : 'queued';
    const res = await adapter.cancel(job.remoteId, remoteState);
    if (res.ok) {
      this.transition(jobId, 'cancelled', res.reason);
      this.release(jobId);
      return { ok: true, reason: res.reason };
    }
    // 不支持取消：如实告知，任务继续跑
    this.setError(jobId, toErrorShape(new PsaiError('JOB_CANCEL_UNSUPPORTED', res.reason)));
    this.transition(jobId, job.state === 'running' ? 'running' : 'remote_queued', `取消未生效：${res.reason}`);
    return { ok: false, reason: res.reason };
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

  retry(jobId: string): JobRecord {
    const job = this.get(jobId);
    if (job.state !== 'failed' && job.state !== 'lost') {
      throw new PsaiError('JOB_PARAM_INVALID', `只有失败或丢失的任务可以重试（当前 ${job.state}）`);
    }
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

  /** 用同一套参数重跑，产出一条新任务并记录血缘。 */
  rerun(jobId: string): JobRecord {
    return this.cloneAndQueue(this.get(jobId));
  }

  private cloneAndQueue(job: JobRecord): JobRecord {
    const id = `job_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
    const now = Date.now();
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
    const ins = this.db.prepare('INSERT INTO job_inputs(job_id, param_id, asset_id, idx, source) VALUES(?, ?, ?, ?, ?)');
    for (const i of job.inputs) {
      ins.run(id, i.paramId, i.assetId, i.index, i.source);
      this.assets.addRef(i.assetId);
    }
    this.event(id, null, 'created', `由 ${job.id} 重跑`);
    this.transition(id, 'inputs_ready', '输入已就绪');
    this.enqueue(id);
    return this.get(id);
  }

  /** 插件上报写回结果。AI 成功与写回成功严格分离。 */
  reportWriteback(jobId: string, ok: boolean, detail: string, code?: string): JobRecord {
    const job = this.get(jobId);
    if (job.state === 'writeback_pending' || job.state === 'retryable_writeback_failure') {
      this.transition(jobId, 'writeback_running', '插件开始写回');
    }
    if (ok) {
      this.transition(jobId, 'succeeded', detail || '写回成功');
    } else {
      this.setError(
        jobId,
        toErrorShape({ code: code ?? 'WRITEBACK_FAILED', message: detail || '写回失败' }, 'WRITEBACK_FAILED')
      );
      this.transition(jobId, 'retryable_writeback_failure', detail || '写回失败，结果已保留');
    }
    return this.get(jobId);
  }

  /** 让一条写回失败/等待写回的任务重新进入待写回状态。 */
  requestWriteback(jobId: string, mode?: WritebackMode, layerName?: string): JobRecord {
    const job = this.get(jobId);
    if (!job.target) throw new PsaiError('WRITEBACK_TARGET_INVALID', '该任务没有记录 Photoshop 目标');
    if (job.results.length === 0) throw new PsaiError('ASSET_NOT_FOUND', '该任务没有可写回的结果');
    if (mode || layerName) {
      this.db
        .prepare('UPDATE jobs SET writeback_json = ?, updated_at = ? WHERE id = ?')
        .run(
          JSON.stringify({
            mode: mode ?? job.writeback?.mode ?? 'smartObject',
            layerName: layerName ?? job.writeback?.layerName ?? ''
          }),
          Date.now(),
          jobId
        );
    }
    if (job.state === 'succeeded') {
      // 已成功的任务再写回：开一条不占并发的写回流程
      this.forceState(jobId, 'writeback_pending', '用户请求再次写回');
    } else if (job.state !== 'writeback_pending') {
      this.forceState(jobId, 'writeback_pending', '等待写回');
    }
    return this.get(jobId);
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
          const images = await adapter.fetchResults(r.remote_id);
          await this.storeResults(r.id, images, r.started_at ?? Date.now());
          resumed++;
        } else if (res.state === 'queued' || res.state === 'running') {
          this.forceState(r.id, res.state === 'running' ? 'running' : 'remote_queued', 'Helper 重启：远端仍在执行，继续监听');
          const entry: RunningEntry = {
            jobId: r.id,
            unsubscribe: null,
            pollTimer: null,
            cancelled: false,
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

  private transition(jobId: string, to: JobState, note: string): void {
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
    const job = this.find(jobId);
    if (!job || job.state === to) return;
    this.writeState(jobId, job.state, to, note);
  }

  private writeState(jobId: string, from: JobState, to: JobState, note: string): void {
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
    this.setError(jobId, shape);
    const job = this.find(jobId);
    if (job && !isTerminal(job.state)) {
      this.forceState(jobId, 'failed', `${shape.code}: ${shape.message}`);
    }
    this.release(jobId);
  }

  private setError(jobId: string, shape: ReturnType<typeof toErrorShape>): void {
    this.db.prepare('UPDATE jobs SET error_json = ?, updated_at = ? WHERE id = ?').run(
      JSON.stringify(shape),
      Date.now(),
      jobId
    );
    this.log.warn('任务错误', { jobId, ...shape });
  }

  private setProgress(jobId: string, p: JobProgress): void {
    this.db.prepare('UPDATE jobs SET progress_json = ?, updated_at = ? WHERE id = ?').run(
      JSON.stringify(p),
      Date.now(),
      jobId
    );
    const job = this.find(jobId);
    if (job) this.emit(job);
  }

  private event(jobId: string, from: JobState | null, to: JobState, note: string): void {
    const at = Date.now();
    this.db
      .prepare('INSERT INTO job_events(job_id, at, from_state, to_state, note, error_code) VALUES(?, ?, ?, ?, ?, NULL)')
      .run(jobId, at, from, to, note);
    const ev: JobEvent = { jobId, at, from, to, note, errorCode: null };
    this.events.broadcast({ type: 'job:event', event: ev });
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
    for (const i of job.inputs) this.assets.release(i.assetId);
    for (const r of job.results) this.assets.release(r.assetId);
    this.db.prepare('DELETE FROM job_inputs WHERE job_id = ?').run(id);
    this.db.prepare('DELETE FROM job_results WHERE job_id = ?').run(id);
    this.db.prepare('DELETE FROM job_events WHERE job_id = ?').run(id);
    this.db.prepare('DELETE FROM jobs WHERE id = ?').run(id);
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
      writeback:
        r['writeback_json'] === null
          ? null
          : parse<{ mode: WritebackMode; layerName: string } | null>(String(r['writeback_json']), null),
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
    }
    this.running.clear();
    this.queue = [];
  }
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
