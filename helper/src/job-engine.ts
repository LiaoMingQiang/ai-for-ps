/* job-engine: 任务状态机 (规则十四/十五/七/十三)
 * 状态: created -> validating -> snapshotting -> uploading -> queued -> running
 *       -> downloading -> result_ready -> writeback_pending -> writing_back -> completed
 *       cancel_requested -> cancelled
 *       provider_failure | download_failure | retryable_writeback_failure | rollback_uncertain | failed
 * - 每次状态变化写 job_events
 * - 恢复: 有 remoteJobId 先 provider.recover(), 绝不无条件重新 submit
 * - 取消: 经 adapter (queued->队列删除 / running->确认后 interrupt) */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Store } from "./db.js";
import type { ProviderManager } from "./providers/manager.js";
import type { GenerationRequest } from "./providers/sdk.js";
import { PROVIDER_ERROR_CODES as EC } from "./providers/sdk.js";
import type { HelperContext } from "./server.js";
import { imageMeta, mimeFromFormat } from "./image-meta.js";
import { applyWorkflowBindings } from "./workflow/importer.js";

export const JOB_STATUSES = [
  "created", "validating", "snapshotting", "uploading", "queued", "running",
  "downloading", "result_ready", "writeback_pending", "writing_back", "completed",
  "cancel_requested", "cancelled",
  "provider_failure", "download_failure", "retryable_writeback_failure", "rollback_uncertain", "failed"
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const TERMINAL: ReadonlySet<string> = new Set(["completed", "cancelled", "failed", "provider_failure", "download_failure", "retryable_writeback_failure", "rollback_uncertain"]);
export const RETRYABLE_FAILURES: ReadonlySet<string> = new Set(["provider_failure", "download_failure", "failed", "retryable_writeback_failure"]);

type JobRow = Record<string, unknown>;

export class JobEngine {
  private activeRuns = new Map<string, { stopProgress?: () => void; pollTimer?: NodeJS.Timeout }>();
  private concurrency = 0;
  private maxConcurrency = 4;

  constructor(
    private store: Store,
    private manager: ProviderManager,
    private cfg: { assetsDir: string },
    private ctx: HelperContext
  ) {}

  /* ---------- 状态迁移 ---------- */
  private transition(jobId: string, from: string | null, to: JobStatus, detail: string) {
    const now = Date.now();
    this.store.raw.prepare("UPDATE jobs SET status=?, updated_at=? WHERE id=?").run(to, now, jobId);
    this.store.raw.prepare("INSERT INTO job_events (job_id, from_status, to_status, detail, created_at) VALUES (?,?,?,?,?)")
      .run(jobId, from, to, detail, now);
    const job = this.store.raw.prepare("SELECT * FROM jobs WHERE id=?").get(jobId);
    this.ctx.broadcast({ type: "job:update", job });
    return job as JobRow;
  }

  private fail(jobId: string, from: string, code: string, message: string, retryable: boolean) {
    const to: JobStatus = retryable ? "provider_failure" : "failed";
    const now = Date.now();
    this.store.raw.prepare("UPDATE jobs SET status=?, error_json=?, updated_at=? WHERE id=?").run(to, JSON.stringify({ code, message, retryable, diagnosticId: crypto.randomBytes(4).toString("hex") }), now, jobId);
    this.store.raw.prepare("INSERT INTO job_events (job_id, from_status, to_status, detail, created_at) VALUES (?,?,?,?,?)").run(jobId, from, to, message, now);
    const job = this.store.raw.prepare("SELECT * FROM jobs WHERE id=?").get(jobId);
    this.ctx.broadcast({ type: "job:update", job });
    return job as JobRow;
  }

  private job(jobId: string): JobRow {
    const j = this.store.raw.prepare("SELECT * FROM jobs WHERE id=?").get(jobId);
    if (!j) throw new Error("JOB_NOT_FOUND:" + jobId);
    return j as JobRow;
  }

  /* ---------- 创建 + 启动 ---------- */
  async create(body: Record<string, unknown>): Promise<JobRow> {
    const id = crypto.randomUUID();
    const providerId = String(body.providerId || "local-comfy");
    const view = this.manager.view(providerId);
    if (!view) throw new Error("PROVIDER_NOT_FOUND:" + providerId);
    if (!view.enabled && !view.configured) throw new Error("PROVIDER_NOT_CONFIGURED:" + providerId);
    const now = Date.now();
    this.store.raw.prepare(`INSERT INTO jobs (id, status, provider_id, provider_type, workflow_id, model_id, inputs_json, parameters_json, snapshot_json, snapshot_id, project_id, source_document_id, source_document_name, source_document_path, source_layer_ids_json, selection_bounds_json, canvas_width, canvas_height, color_mode, bit_depth, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, "created", providerId, view.type,
      body.workflowId ? String(body.workflowId) : null,
      body.modelId ? String(body.modelId) : null,
      JSON.stringify(body.inputs || {}), JSON.stringify(body.parameters || {}),
      JSON.stringify(body.snapshot || {}),
      (body.snapshot as { id?: unknown } | undefined)?.id ? String((body.snapshot as { id: unknown }).id) : null,
      body.projectId ? String(body.projectId) : null,
      body.sourceDocumentId ? String(body.sourceDocumentId) : null,
      body.sourceDocumentName ? String(body.sourceDocumentName) : null,
      body.sourceDocumentPath ? String(body.sourceDocumentPath) : null,
      JSON.stringify(body.sourceLayerIds || []),
      body.selectionBounds ? JSON.stringify(body.selectionBounds) : null,
      body.canvasWidth ? Number(body.canvasWidth) : null,
      body.canvasHeight ? Number(body.canvasHeight) : null,
      body.colorMode ? String(body.colorMode) : null,
      body.bitDepth ? Number(body.bitDepth) : null,
      now, now
    );
    this.store.raw.prepare("INSERT INTO job_events (job_id, from_status, to_status, detail, created_at) VALUES (?,?,?,?,?)").run(id, null, "created", "job created", now);
    const job = this.store.raw.prepare("SELECT * FROM jobs WHERE id=?").get(id) as JobRow;
    /* 并发闸 (规则三十: Helper 控制并发) */
    if (this.concurrency >= this.maxConcurrency) {
      /* 排队: 由定时器在并发释放后启动 */
      this.transition(id, "created", "created", "waiting for concurrency slot");
      this.scheduleQueued(id);
      return job;
    }
    this.concurrency++;
    this.run(id).finally(() => { this.concurrency = Math.max(0, this.concurrency - 1); });
    return job;
  }

  private pendingStart = new Set<string>();
  private scheduleQueued(jobId: string) {
    if (this.pendingStart.has(jobId)) return;
    this.pendingStart.add(jobId);
    const timer = setInterval(() => {
      if (this.concurrency < this.maxConcurrency) {
        clearInterval(timer);
        this.pendingStart.delete(jobId);
        const j = this.job(jobId);
        if (String(j.status) === "created") {
          this.concurrency++;
          this.run(jobId).finally(() => { this.concurrency = Math.max(0, this.concurrency - 1); });
        }
      }
    }, 2000);
  }

  /* ---------- 主执行管线 ----------
   * resumeFrom: 恢复模式 (规则十五) — "downloading" 跳过提交直接下载; "running" 恢复监控 */
  async run(jobId: string, resumeFrom?: "downloading" | "running"): Promise<void> {
    const job0 = this.job(jobId);
    const providerId = String(job0.provider_id);
    const view = this.manager.view(providerId);
    if (!view) { this.fail(jobId, String(job0.status), "PROVIDER_NOT_FOUND", "Provider 不存在: " + providerId, false); return; }
    let adapter;
    try {
      adapter = await this.manager.adapter(providerId);
    } catch (e) {
      this.fail(jobId, String(job0.status), (e as Error & { code?: string }).code || "PROVIDER_FAILED", (e as Error).message, true);
      return;
    }

    let request: GenerationRequest;
    let remoteJobId: string | null;

    if (resumeFrom === "downloading") {
      /* 恢复: 远端已完成, 直接下载 (绝不重新 submit) */
      request = this.buildRequest(job0, view);
      remoteJobId = job0.remote_job_id ? String(job0.remote_job_id) : null;
      if (!remoteJobId) { this.fail(jobId, String(job0.status), "JOB_LOST", "恢复失败: 缺少 remoteJobId", true); return; }
      await this.downloadPhase(jobId, adapter, remoteJobId, request);
      return;
    }

    if (resumeFrom === "running") {
      /* 恢复: 远端仍在执行, 恢复监控 */
      request = this.buildRequest(job0, view);
      remoteJobId = job0.remote_job_id ? String(job0.remote_job_id) : null;
      if (!remoteJobId) { this.fail(jobId, String(job0.status), "JOB_LOST", "恢复失败: 缺少 remoteJobId", true); return; }
      const runState: { stopProgress?: () => void } = {};
      this.activeRuns.set(jobId, runState);
      try {
        await this.pollUntilDone(jobId, adapter, remoteJobId, runState);
      } catch (e) {
        const err = e as Error & { code?: string };
        this.fail(jobId, "running", err.code || "PROVIDER_FAILED", err.message, true);
        return;
      }
      const j = this.job(jobId);
      if (String(j.status) !== "running") return; /* 已在轮询中失败/取消 */
      await this.downloadPhase(jobId, adapter, remoteJobId, request);
      return;
    }

    /* 1. validating */
    this.transition(jobId, String(job0.status), "validating", "校验 Provider 与输入");
    request = this.buildRequest(job0, view);
    try {
      const v = await adapter.validate(request);
      if (!v.ok) {
        this.fail(jobId, "validating", v.errors[0]?.code || "WORKFLOW_INVALID", v.errors.map((e) => e.message).join("; "), false);
        return;
      }
    } catch (e) {
      this.fail(jobId, "validating", (e as Error & { code?: string }).code || "PROVIDER_FAILED", (e as Error).message, true);
      return;
    }

    /* 2. snapshotting (UXP 已上传快照资产; 此处校验) */
    this.transition(jobId, "validating", "snapshotting", "检查快照资产");
    const inputAssetIds = (request.inputs.imageAssetIds || []).filter(Boolean) as string[];
    for (const aid of inputAssetIds) {
      const a = this.store.raw.prepare("SELECT storage_path FROM assets WHERE id=?").get(aid) as { storage_path: string } | undefined;
      if (!a || !fs.existsSync(a.storage_path)) {
        this.fail(jobId, "snapshotting", "ASSET_MISSING", "输入资产不存在: " + aid, false);
        return;
      }
    }

    /* 3. uploading (ComfyUI: 上传输入图) */
    try {
      if (view.type === "comfyui" && inputAssetIds.length) {
        this.transition(jobId, "snapshotting", "uploading", "上传输入图像 (" + inputAssetIds.length + ")");
        const comfy = adapter as unknown as { uploadImage(bytes: Uint8Array, filename: string): Promise<string> };
        const uploaded: string[] = [];
        for (const aid of inputAssetIds) {
          const a = this.store.raw.prepare("SELECT storage_path, mime_type FROM assets WHERE id=?").get(aid) as { storage_path: string; mime_type: string } | undefined;
          if (!a) continue;
          const bytes = new Uint8Array(fs.readFileSync(a.storage_path));
          const ext = a.mime_type === "image/jpeg" ? ".jpg" : a.mime_type === "image/webp" ? ".webp" : ".png";
          const name = await comfy.uploadImage(bytes, aid + ext);
          uploaded.push(name);
        }
        request.inputs.imageAssetIds = uploaded; /* LoadImage 使用上传名 */
      }
    } catch (e) {
      this.fail(jobId, "uploading", (e as Error & { code?: string }).code || "UPLOAD_FAILED", (e as Error).message, true);
      return;
    }

    /* 4. submit -> queued */
    this.transition(jobId, inputAssetIds.length ? "uploading" : "snapshotting", "queued", "提交到 " + providerId);
    try {
      const remote = await adapter.submit(request);
      remoteJobId = remote.remoteJobId;
      this.store.raw.prepare("UPDATE jobs SET remote_job_id=? WHERE id=?").run(remoteJobId, jobId);
    } catch (e) {
      const err = e as Error & { code?: string; retryable?: boolean };
      this.fail(jobId, "queued", err.code || "SUBMIT_FAILED", err.message, err.retryable !== false);
      return;
    }

    /* 5. running: 轮询 + progress */
    this.transition(jobId, "queued", "running", "远端执行中");
    const runState: { stopProgress?: () => void } = {};
    this.activeRuns.set(jobId, runState);
    try {
      await this.pollUntilDone(jobId, adapter, remoteJobId, runState);
    } catch (e) {
      const err = e as Error & { code?: string };
      this.fail(jobId, "running", err.code || "PROVIDER_FAILED", err.message, true);
      return;
    }

    const jAfter = this.job(jobId);
    if (String(jAfter.status) !== "running") return; /* 已在轮询中失败/取消 */
    await this.downloadPhase(jobId, adapter, remoteJobId, request);
  }

  /* 下载阶段 (步骤 6-8) */
  private async downloadPhase(jobId: string, adapter: Awaited<ReturnType<ProviderManager["adapter"]>>, remoteJobId: string, request: GenerationRequest): Promise<void> {
    /* 6. downloading */
    this.transition(jobId, String(this.job(jobId).status), "downloading", "下载结果");
    let results;
    try {
      results = await adapter.downloadResults(remoteJobId);
    } catch (e) {
      const err = e as Error & { code?: string };
      this.fail(jobId, "downloading", err.code || "ASSET_DOWNLOAD_FAILED", err.message, true);
      return;
    }
    if (!results.length) {
      this.fail(jobId, "downloading", "COMFY_NO_OUTPUT", "任务完成但无输出图像", false);
      return;
    }

    /* 7. 结果资产持久化 (规则二十八: 结果不丢) */
    const assetIds: string[] = [];
    for (const r of results) {
      if (!r.bytes) continue;
      const assetId = crypto.randomUUID();
      const hash = crypto.createHash("sha256").update(Buffer.from(r.bytes)).digest("hex");
      const ext = r.filename.toLowerCase().endsWith(".jpg") || r.filename.toLowerCase().endsWith(".jpeg") ? ".jpg" : r.filename.toLowerCase().endsWith(".webp") ? ".webp" : ".png";
      const storagePath = path.join(this.cfg.assetsDir, assetId + ext);
      fs.writeFileSync(storagePath, Buffer.from(r.bytes));
      let width: number | null = null, height: number | null = null, mime = "image/png";
      const meta = imageMeta(r.bytes);
      if (meta.format) {
        width = meta.width;
        height = meta.height;
        mime = mimeFromFormat(meta.format);
      }
      this.store.raw.prepare("INSERT INTO assets (id, job_id, mime_type, width, height, size, hash, storage_path, kind, role, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
        .run(assetId, jobId, mime, width, height, r.bytes.length, hash, storagePath, "result", null, Date.now());
      this.store.raw.prepare("INSERT INTO job_outputs (id, job_id, asset_id, label, seed, width, height, favorite, created_at) VALUES (?,?,?,?,?,?,?,0,?)")
        .run(crypto.randomUUID(), jobId, assetId, r.filename, this.seedOf(jobId), width, height, Date.now());
      assetIds.push(assetId);
    }
    const jNow = this.job(jobId);
    this.store.raw.prepare("UPDATE jobs SET result_assets_json=?, duration_ms=? WHERE id=?").run(JSON.stringify(assetIds), Date.now() - Number(jNow.created_at || Date.now()), jobId);

    /* 成本/用量记录 (规则三十二: 本地记 GPU 时长, 云记费用; 不虚构货币) */
    const usageId = crypto.randomUUID();
    const duration = Date.now() - Number(jNow.created_at || Date.now());
    this.store.raw.prepare(
      "INSERT INTO usage_records (id, job_id, provider_id, provider_type, model_id, estimated_cost, actual_cost, currency, duration_ms, gpu_duration_ms, tokens_in, tokens_out, images_count, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
    ).run(
      usageId, jobId, String(jNow.provider_id), String(jNow.provider_type), jNow.model_id ? String(jNow.model_id) : null,
      null, null, null, duration,
      String(jNow.provider_type) === "comfyui" ? duration : null,
      null, null, assetIds.length, Date.now()
    );

    /* 8. result_ready (等待 UXP 写回或 writeback-ready) */
    this.transition(jobId, "downloading", "result_ready", "结果已缓存，等待写回");
    this.activeRuns.delete(jobId);
    this.ctx.broadcast({ type: "job:result", jobId, assetIds });
  }

  private seedOf(jobId: string): number | null {
    try {
      const j = this.job(jobId);
      const p = JSON.parse(String(j.parameters_json || "{}")) as { seed?: number };
      return typeof p.seed === "number" ? p.seed : null;
    } catch (e) { return null; }
  }

  private buildRequest(job: JobRow, view: { type: string }): GenerationRequest {
    let inputs: Record<string, unknown> = {};
    let params: Record<string, unknown> = {};
    try { inputs = JSON.parse(String(job.inputs_json || "{}")); } catch (e) { /* noop */ }
    try { params = JSON.parse(String(job.parameters_json || "{}")); } catch (e) { /* noop */ }

    /* PHASE 10: 已导入 Workflow -> 加载最新 workflow_json + bindings, 应用任务参数到真实 JSON */
    let workflowJson: Record<string, unknown> | undefined;
    if (job.workflow_id) {
      try {
        const wf = this.store.raw.prepare("SELECT workflow_json FROM workflows WHERE id=?").get(String(job.workflow_id)) as { workflow_json: string | null } | undefined;
        if (wf?.workflow_json) {
          const parsed = JSON.parse(String(wf.workflow_json)) as Record<string, unknown>;
          const bindings = this.store.raw.prepare(
            "SELECT field_key, node_id, input_key, field_type, default_value FROM workflow_bindings WHERE workflow_id=?"
          ).all(String(job.workflow_id)) as Array<{ field_key: string; node_id: string; input_key: string; field_type: string; default_value: string | null }>;
          workflowJson = applyWorkflowBindings(parsed, bindings, params);
        }
      } catch (e) { /* workflow 应用失败: 回退到模板构建 (不阻断任务) */ }
    }

    return {
      providerId: String(job.provider_id),
      workflowId: job.workflow_id ? String(job.workflow_id) : undefined,
      workflowJson,
      modelId: job.model_id ? String(job.model_id) : undefined,
      inputs: {
        prompt: inputs.prompt ? String(inputs.prompt) : undefined,
        negativePrompt: inputs.negativePrompt ? String(inputs.negativePrompt) : undefined,
        imageAssetIds: Array.isArray(inputs.imageAssetIds) ? (inputs.imageAssetIds as string[]) : undefined,
        maskAssetId: inputs.maskAssetId ? String(inputs.maskAssetId) : undefined,
        referenceImages: Array.isArray(inputs.referenceImages) ? (inputs.referenceImages as GenerationRequest["inputs"]["referenceImages"]) : undefined
      },
      parameters: params as GenerationRequest["parameters"]
    };
  }

  /* 轮询直到 completed (或失败/取消) */
  private pollUntilDone(jobId: string, adapter: Awaited<ReturnType<ProviderManager["adapter"]>>, remoteJobId: string, runState: { stopProgress?: () => void }): Promise<void> {
    return new Promise((resolve, reject) => {
      const stopProgress = "connectProgress" in adapter
        ? (adapter as { connectProgress(id: string, cb: (f: number) => void): () => void }).connectProgress(remoteJobId, (f) => {
          const j = this.job(jobId);
          if (String(j.status) === "running") {
            this.store.raw.prepare("UPDATE jobs SET updated_at=? WHERE id=?").run(Date.now(), jobId);
            this.ctx.broadcast({ type: "job:progress", jobId, progress: Math.round(f * 100) });
          }
        })
        : undefined;
      runState.stopProgress = stopProgress;
      const timer = setInterval(async () => {
        const j = this.job(jobId);
        const status = String(j.status);
        if (status === "cancel_requested") {
          clearInterval(timer);
          if (stopProgress) { try { stopProgress(); } catch (e) { /* noop */ } }
          this.doCancel(jobId, remoteJobId).then(() => resolve()).catch((e) => reject(e));
          return;
        }
        if (status !== "running") {
          clearInterval(timer);
          if (stopProgress) { try { stopProgress(); } catch (e) { /* noop */ } }
          resolve();
          return;
        }
        try {
          const st = await adapter.getStatus(remoteJobId);
          if (st.status === "completed") {
            clearInterval(timer);
            if (stopProgress) { try { stopProgress(); } catch (e) { /* noop */ } }
            this.transition(jobId, "running", "running", "远端完成");
            resolve();
          } else if (st.status === "failed") {
            clearInterval(timer);
            if (stopProgress) { try { stopProgress(); } catch (e) { /* noop */ } }
            const err = st.error || { code: "PROVIDER_FAILED", message: "远端执行失败" };
            /* OOM 特判 (场景 9) */
            const code = /OOM|out of memory/i.test(err.message) ? EC.COMFY_OOM : err.code;
            this.fail(jobId, "running", code, err.message, false);
            resolve();
          } else if (st.status === "unknown") {
            clearInterval(timer);
            if (stopProgress) { try { stopProgress(); } catch (e) { /* noop */ } }
            this.fail(jobId, "running", "JOB_LOST", "远端任务丢失: " + remoteJobId, true);
            resolve();
          }
          /* queued/running: 继续等 */
        } catch (e) {
          /* 瞬时错误: 继续轮询 (Provider Retry) */
        }
      }, 2000);
    });
  }

  /* ---------- 取消 (规则十三: 经 adapter 安全取消) ---------- */
  async cancel(jobId: string): Promise<JobRow> {
    const job = this.job(jobId);
    const status = String(job.status);
    if (TERMINAL.has(status)) throw new Error("JOB_NOT_CANCELLABLE:" + status);
    this.transition(jobId, status, "cancel_requested", "取消请求已记录");
    if (this.activeRuns.has(jobId)) {
      /* 轮询循环会处理 cancel_requested */
      return this.job(jobId);
    }
    /* 未在运行中: 直接取消 */
    const remoteJobId = job.remote_job_id ? String(job.remote_job_id) : null;
    if (remoteJobId) {
      await this.doCancel(jobId, remoteJobId);
    } else {
      this.transition(jobId, "cancel_requested", "cancelled", "未提交远端, 直接取消");
    }
    return this.job(jobId);
  }

  private async doCancel(jobId: string, remoteJobId: string): Promise<void> {
    try {
      const view = this.manager.view(String(this.job(jobId).provider_id));
      const adapter = await this.manager.adapter(String(view?.id || this.job(jobId).provider_id));
      const r = await adapter.cancel(remoteJobId);
      this.transition(jobId, "cancel_requested", "cancelled", "已取消: " + (r.message || ""));
    } catch (e) {
      this.transition(jobId, "cancel_requested", "cancelled", "取消请求已接受 (远端确认失败: " + String((e as Error).message) + ")");
    }
  }

  /* ---------- 重试 ---------- */
  async retry(jobId: string): Promise<JobRow> {
    const job = this.job(jobId);
    const status = String(job.status);
    if (!RETRYABLE_FAILURES.has(status) && status !== "cancelled") throw new Error("JOB_NOT_RETRYABLE:" + status);
    this.store.raw.prepare("UPDATE jobs SET status='created', remote_job_id=NULL, error_json=NULL, result_assets_json='[]', updated_at=? WHERE id=?").run(Date.now(), jobId);
    this.store.raw.prepare("INSERT INTO job_events (job_id, from_status, to_status, detail, created_at) VALUES (?,?,?,?,?)").run(jobId, status, "created", "retry requested", Date.now());
    const j2 = this.job(jobId);
    this.ctx.broadcast({ type: "job:update", job: j2 });
    if (this.concurrency < this.maxConcurrency) {
      this.concurrency++;
      this.run(jobId).finally(() => { this.concurrency = Math.max(0, this.concurrency - 1); });
    } else {
      this.scheduleQueued(jobId);
    }
    return j2;
  }

  /* ---------- 写回状态 (规则五: AI 成功与写回成功严格区分) ---------- */
  async markWriteback(jobId: string, body: { success?: boolean; layerId?: string | null; layerName?: string | null; error?: string }): Promise<JobRow> {
    const job = this.job(jobId);
    const status = String(job.status);
    if (status !== "result_ready" && status !== "writeback_pending" && status !== "retryable_writeback_failure") {
      throw new Error("JOB_NOT_WRITEBACKABLE:" + status);
    }
    if (body.success) {
      this.transition(jobId, status, "completed", "写回成功" + (body.layerName ? ": " + body.layerName : ""));
    } else {
      this.transition(jobId, status, "retryable_writeback_failure", "写回失败: " + (body.error || "未知原因") + " (结果保留, 可重新写回)");
    }
    return this.job(jobId);
  }

  /* ---------- 恢复 (规则十五/七) ---------- */
  async recoverAll(): Promise<number> {
    const rows = this.store.raw.prepare(
      "SELECT id, status, remote_job_id, provider_id FROM jobs WHERE status NOT IN ('completed','cancelled','failed','provider_failure','download_failure','retryable_writeback_failure','rollback_uncertain')"
    ).all() as Array<{ id: string; status: string; remote_job_id: string | null; provider_id: string }>;
    let recovered = 0;
    for (const row of rows) {
      recovered++;
      const jobId = row.id;
      if (row.status === "cancel_requested") {
        /* 继续取消 */
        if (row.remote_job_id) await this.doCancel(jobId, row.remote_job_id);
        else this.transition(jobId, "cancel_requested", "cancelled", "恢复: 完成取消");
        continue;
      }
      if (!row.remote_job_id) {
        /* 从未提交到远端: 标记恢复后安全重跑 (未产生远端副作用) */
        this.transition(jobId, row.status, "created", "恢复: 任务从未提交, 重新执行");
        this.concurrency++;
        this.run(jobId).finally(() => { this.concurrency = Math.max(0, this.concurrency - 1); });
        continue;
      }
      /* 有 remoteJobId: 先查询远端状态 (绝不无条件重新 submit) */
      try {
        const view = this.manager.view(row.provider_id);
        if (!view) { this.fail(jobId, row.status, "PROVIDER_NOT_FOUND", "Provider 不存在", false); continue; }
        const adapter = await this.manager.adapter(row.provider_id);
        const st = await adapter.recover(row.remote_job_id);
        if (st.status === "completed") {
          this.transition(jobId, row.status, "downloading", "恢复: 远端已完成, 下载结果 (不重新提交)");
          this.concurrency++;
          this.run(jobId, "downloading").finally(() => { this.concurrency = Math.max(0, this.concurrency - 1); });
        } else if (st.status === "running" || st.status === "queued") {
          this.transition(jobId, row.status, "running", "恢复: 远端仍在执行 (不重新提交)");
          this.concurrency++;
          this.run(jobId, "running").finally(() => { this.concurrency = Math.max(0, this.concurrency - 1); });
        } else if (st.status === "failed") {
          this.fail(jobId, row.status, st.error?.code || "PROVIDER_FAILED", st.error?.message || "远端执行失败", false);
        } else {
          this.fail(jobId, row.status, "JOB_LOST", "远端任务不存在 (provider_lost)", true);
        }
      } catch (e) {
        this.fail(jobId, row.status, (e as Error & { code?: string }).code || "RECOVER_FAILED", (e as Error).message, true);
      }
    }
    return recovered;
  }

  activeCount(): number {
    const row = this.store.raw.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status NOT IN ('completed','cancelled','failed','provider_failure','download_failure','retryable_writeback_failure','rollback_uncertain')").get() as { n: number };
    return Number(row.n);
  }
}
