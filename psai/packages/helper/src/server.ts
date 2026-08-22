/**
 * HTTP API。
 *
 * 约定：
 *  - 成功 { ok:true, ... }；失败 { ok:false, error:{ code, message, details, retryable } }
 *  - HTTP 状态码与 error.code 一一对应，不允许 200 里塞失败
 *  - 除 /v1/health 与配对两个端点外，全部要 Bearer token
 */

import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { statfsSync } from 'node:fs';
import {
  PSAI_VERSION,
  PSAI_SCHEMA_VERSION,
  PsaiError,
  toErrorShape,
  CATALOG,
  allFeatures,
  breadcrumb,
  featureDefaults,
  findFeature,
  PROVIDERS,
  findProvider
} from '@psai/shared';
import type { ErrorCode, JobListQuery, CreateJobRequest, FeatureBinding, AppSettings } from '@psai/shared';
import type { HelperConfig } from './config.js';
import type { Logger } from './log.js';
import type { Db } from './db.js';
import type { SettingsStore } from './settings.js';
import type { CredentialStore } from './credentials.js';
import type { PairingService } from './pairing.js';
import type { AssetStore } from './assets.js';
import type { PromptStore } from './prompts.js';
import type { WorkflowStore } from './workflows/store.js';
import type { ProviderManager } from './providers/manager.js';
import type { JobEngine } from './jobs/engine.js';
import type { EventHub } from './events.js';
import { readGpuInfo } from './gpu.js';
import { ComfyUiAdapter } from './providers/comfyui.js';

export interface ServerDeps {
  cfg: HelperConfig;
  log: Logger;
  db: Db;
  settings: SettingsStore;
  credentials: CredentialStore;
  pairing: PairingService;
  assets: AssetStore;
  prompts: PromptStore;
  workflows: WorkflowStore;
  providers: ProviderManager;
  jobs: JobEngine;
  events: EventHub;
  startedAt: number;
  migration: { fromVersion: number; toVersion: number; backupPath: string | null };
}

const STATUS_FOR: Partial<Record<ErrorCode, number>> = {
  HELPER_UNAUTHORIZED: 401,
  PROVIDER_AUTH_FAILED: 401,
  PROVIDER_NOT_CONFIGURED: 409,
  PROVIDER_DISABLED: 409,
  WORKFLOW_NOT_BOUND: 409,
  PROVIDER_RATE_LIMIT: 429,
  JOB_NOT_FOUND: 404,
  WORKFLOW_NOT_FOUND: 404,
  ASSET_NOT_FOUND: 404,
  JOB_PARAM_INVALID: 400,
  JOB_INPUT_MISSING: 400,
  WORKFLOW_INVALID_JSON: 400,
  WORKFLOW_NO_OUTPUT: 400,
  WORKFLOW_BINDING_INVALID: 400,
  ASSET_TOO_LARGE: 413,
  ASSET_UNSUPPORTED_TYPE: 415,
  PROVIDER_UNSUPPORTED: 501,
  NOT_IMPLEMENTED: 501,
  PROVIDER_UNREACHABLE: 502,
  PROVIDER_BAD_RESPONSE: 502,
  PROVIDER_TIMEOUT: 504
};

function fail(reply: FastifyReply, e: unknown): FastifyReply {
  const shape = toErrorShape(e);
  const status = STATUS_FOR[shape.code] ?? 500;
  return reply.status(status).send({ ok: false, error: shape });
}

export async function buildServer(d: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 96 * 1024 * 1024 });
  await app.register(multipart, { limits: { fileSize: 64 * 1024 * 1024, files: 12 } });

  const PUBLIC = new Set(['/v1/health', '/v1/pair/request', '/v1/pair/confirm']);

  /**
   * CORS。
   *
   * UXP 的 fetch 会按 CORS 规则走，而插件的来源不是普通网页来源
   * （常见是 `null` 或某个非 http 方案）。这类来源必须放行，否则面板连不上 Helper。
   *
   * 但**绝不能**顺手放行 http(s) 网页来源：/v1/pair/request 和 /v1/pair/confirm
   * 是公开端点，任何网页只要能跨域调它们就能给自己配一个 token，
   * 从而拿到用户的显卡和已保存的 API Key。所以网页来源默认一律不给 CORS 头，
   * 只有显式开了开发预览（devCors）才放行本机网页来源。
   */
  const isWebOrigin = (origin: string): boolean => /^https?:\/\//i.test(origin);
  const isLocalWebOrigin = (origin: string): boolean =>
    /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(origin);

  if (d.cfg.devCors) {
    d.log.warn('开发 CORS 已开启：额外放行 127.0.0.1 / localhost 网页来源，请勿在正式环境使用');
  }

  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;

    if (typeof origin === 'string' && origin.length > 0) {
      const allowed = !isWebOrigin(origin) || (d.cfg.devCors && isLocalWebOrigin(origin));
      if (allowed) {
        void reply.header('Access-Control-Allow-Origin', origin);
        void reply.header('Vary', 'Origin');
        void reply.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
        void reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
        void reply.header('Access-Control-Max-Age', '600');
      } else {
        // 用 throttled：被拒的客户端往往卡在重试循环里，每次都写一行会把日志刷爆
        d.log.throttled('warn', `cors:${origin}`, '拒绝跨域来源（网页来源不给 CORS，避免被网页私自配对）', {
          origin
        });
      }
    }

    // 预检直接结束，别往下走鉴权 —— 预检请求不带 Authorization 头
    if (req.method === 'OPTIONS') {
      void reply.status(204).send();
    }
  });

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const path = (req.raw.url ?? '').split('?')[0] ?? '';
    if (PUBLIC.has(path)) return;
    const auth = req.headers.authorization ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!d.pairing.verify(token)) {
      void fail(reply, new PsaiError('HELPER_UNAUTHORIZED'));
    }
  });

  app.setErrorHandler((err, _req, reply) => {
    d.log.error('未捕获的请求错误', String(err));
    void fail(reply, err);
  });

  /* ---------------- 健康 / 系统 ---------------- */

  app.get('/v1/health', async () => {
    const comfy = d.providers.status('comfyui');
    return {
      ok: true,
      online: true,
      version: PSAI_VERSION,
      schemaVersion: PSAI_SCHEMA_VERSION,
      uptimeMs: Date.now() - d.startedAt,
      paired: d.pairing.hasAnyPairing(),
      activeJobs: d.jobs.activeCount(),
      migration: d.migration,
      comfyui: { configured: comfy.configured, online: comfy.online, baseUrl: comfy.baseUrl, reason: comfy.reason }
    };
  });

  app.post('/v1/pair/request', async (req) => {
    const body = (req.body ?? {}) as { client?: string };
    return { ok: true, ...d.pairing.request(body.client ?? 'uxp') };
  });

  app.post('/v1/pair/confirm', async (req, reply) => {
    const body = (req.body ?? {}) as { challenge?: string };
    const res = d.pairing.confirm(body.challenge ?? '');
    if ('error' in res) return fail(reply, new PsaiError('HELPER_PAIR_FAILED', res.error));
    return { ok: true, token: res.token };
  });

  app.get('/v1/system', async () => {
    let freeBytes: number | null = null;
    try {
      const st = statfsSync(d.cfg.dataDir);
      freeBytes = Number(st.bavail) * Number(st.bsize);
    } catch {
      /* 部分文件系统不支持 */
    }
    return {
      ok: true,
      platform: process.platform,
      node: process.version,
      dataDir: d.cfg.dataDir,
      logsDir: d.cfg.logsDir,
      assetBytes: d.assets.totalBytes(),
      freeBytes,
      lanMode: d.cfg.lanMode,
      wsClients: d.events.clientCount
    };
  });

  app.get('/v1/gpu', async () => ({ ok: true, gpu: readGpuInfo() }));

  /* ---------------- 设置 ---------------- */

  app.get('/v1/settings', async () => ({ ok: true, settings: d.settings.get() }));

  app.patch('/v1/settings', async (req) => {
    const patch = (req.body ?? {}) as Partial<AppSettings>;
    const next = d.settings.patch(patch);
    d.providers.refresh();
    return { ok: true, settings: next };
  });

  /* ---------------- Provider ---------------- */

  app.get('/v1/providers', async () => ({
    ok: true,
    providers: d.providers.allStatus().map((s) => {
      const desc = findProvider(s.id)!;
      return {
        ...s,
        label: desc.label,
        kind: desc.kind,
        consoleUrl: desc.consoleUrl,
        description: desc.description,
        recommended: desc.recommended,
        cancelSupport: desc.cancelSupport,
        credentialFields: desc.credentials.map((c) => ({
          ...c,
          masked: c.secret ? d.credentials.mask(s.id, c.key) : null
        }))
      };
    })
  }));

  app.patch('/v1/providers/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!findProvider(id)) return fail(reply, new PsaiError('PROVIDER_NOT_CONFIGURED', `未知 Provider: ${id}`));
    const body = (req.body ?? {}) as { enabled?: boolean; baseUrl?: string; defaultModel?: string };
    const next = d.settings.upsertProvider({ id, ...body });
    // ComfyUI 的地址以「设置 → 本地」的连接分组为准，这里同步过去避免两处不一致
    if (id === 'comfyui' && typeof body.baseUrl === 'string' && body.baseUrl.trim()) {
      d.settings.patch({ comfy: { baseUrl: body.baseUrl.trim() } as never });
    }
    d.providers.refresh();
    return { ok: true, provider: next, status: d.providers.status(id) };
  });

  app.post('/v1/providers/:id/credentials', async (req, reply) => {
    const { id } = req.params as { id: string };
    const desc = findProvider(id);
    if (!desc) return fail(reply, new PsaiError('PROVIDER_NOT_CONFIGURED', `未知 Provider: ${id}`));
    const body = (req.body ?? {}) as Record<string, string>;
    let wrote = 0;
    for (const field of desc.credentials) {
      const v = body[field.key];
      if (typeof v === 'string' && v.trim()) {
        d.credentials.set(id, field.key, v.trim());
        wrote++;
      }
    }
    if (wrote === 0) return fail(reply, new PsaiError('JOB_PARAM_INVALID', '没有提供任何有效的凭据字段'));
    d.settings.upsertProvider({ id, hasCredentials: true, enabled: true });
    d.providers.refresh();
    return { ok: true, status: d.providers.status(id) };
  });

  app.delete('/v1/providers/:id/credentials', async (req) => {
    const { id } = req.params as { id: string };
    d.credentials.clear(id);
    d.settings.upsertProvider({ id, hasCredentials: false });
    d.providers.refresh();
    return { ok: true, status: d.providers.status(id) };
  });

  app.post('/v1/providers/:id/test', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const status = await d.providers.probe(id);
      const result = await d.providers.adapter(id).testConnection();
      d.events.broadcast({
        type: 'provider:status',
        providerId: id,
        online: status.online,
        detail: result.detail
      });
      return { ok: true, result, status };
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.get('/v1/providers/:id/models', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const models = await d.providers.adapter(id).listModels();
      return { ok: true, models };
    } catch (e) {
      return fail(reply, e);
    }
  });

  /* ---------------- ComfyUI 专用 ---------------- */

  app.get('/v1/comfy/object-info', async (_req, reply) => {
    try {
      const comfy = d.providers.comfy();
      const [samplers, schedulers, checkpoints, upscaleModels] = await Promise.all([
        comfy.enumOf('KSampler', 'sampler_name'),
        comfy.enumOf('KSampler', 'scheduler'),
        comfy.enumOf('CheckpointLoaderSimple', 'ckpt_name'),
        comfy.enumOf('UpscaleModelLoader', 'model_name')
      ]);
      const nodes = await comfy.installedNodeTypes();
      return {
        ok: true,
        samplers,
        schedulers,
        checkpoints,
        upscaleModels,
        nodeCount: nodes.size
      };
    } catch (e) {
      return fail(reply, e);
    }
  });

  /* ---------------- 功能目录 ---------------- */

  app.get('/v1/features', async () => {
    const bindings = d.settings.get().featureBindings;
    const statuses = new Map(d.providers.allStatus().map((s) => [s.id, s]));
    const features = allFeatures().map((f) => {
      const b = bindings.find((x) => x.featureId === f.id) ?? null;
      const providerId = b?.providerId ?? (f.engine === 'comfy-workflow' ? 'comfyui' : null);
      const ps = providerId ? statuses.get(providerId) : undefined;
      const workflowId = b?.workflowId ?? f.defaultWorkflowId;
      const wf = workflowId ? d.workflows.find(workflowId) : null;

      let ready = true;
      let reason: string | null = null;
      if (f.engine === 'comfy-workflow' && f.id !== 'comfy.custom') {
        if (!wf) {
          ready = false;
          reason = '未绑定工作流';
        }
      }
      if (ready && providerId && ps && !ps.configured) {
        ready = false;
        reason = ps.reason ?? 'Provider 未配置';
      }
      if (ready && providerId && ps && !ps.enabled) {
        ready = false;
        reason = 'Provider 已禁用';
      }
      if (ready && f.engine !== 'comfy-workflow' && !providerId) {
        ready = false;
        reason = '未配置任何闭源模型 Provider';
      }

      return {
        id: f.id,
        label: f.label,
        description: f.description,
        branch: f.branch,
        engine: f.engine,
        breadcrumb: breadcrumb(f.id),
        params: f.params,
        defaults: featureDefaults(f.id),
        writeback: f.writeback,
        acceptance: f.acceptance,
        binding: b,
        providerId,
        workflowId: wf?.id ?? null,
        workflowName: wf?.name ?? null,
        ready,
        reason
      };
    });
    return { ok: true, catalog: CATALOG, features };
  });

  app.put('/v1/features/:id/binding', async (req, reply) => {
    const { id } = req.params as { id: string };
    const f = findFeature(id);
    if (!f) return fail(reply, new PsaiError('JOB_PARAM_INVALID', `未知功能: ${id}`));
    const body = (req.body ?? {}) as Partial<FeatureBinding>;
    const current = d.settings.binding(id);
    const next: FeatureBinding = {
      featureId: id,
      providerId: body.providerId ?? current?.providerId ?? (f.engine === 'comfy-workflow' ? 'comfyui' : ''),
      workflowId: body.workflowId ?? current?.workflowId ?? f.defaultWorkflowId,
      remoteWorkflowId: body.remoteWorkflowId ?? current?.remoteWorkflowId ?? null,
      model: body.model ?? current?.model ?? null,
      enabled: body.enabled ?? current?.enabled ?? true
    };
    if (next.workflowId && !d.workflows.find(next.workflowId)) {
      return fail(reply, new PsaiError('WORKFLOW_NOT_FOUND', next.workflowId));
    }
    return { ok: true, binding: d.settings.upsertBinding(next) };
  });

  app.post('/v1/features/:id/binding/reset', async (req) => {
    const { id } = req.params as { id: string };
    return { ok: true, binding: d.settings.resetBinding(id) };
  });

  /* ---------------- 工作流 ---------------- */

  app.get('/v1/workflows', async () => ({
    ok: true,
    workflows: d.workflows.list().map((w) => ({
      id: w.id,
      name: w.name,
      version: w.version,
      source: w.source,
      format: w.format,
      nodeCount: Object.keys(w.graph).length,
      outputNodeIds: w.outputNodeIds,
      requiredNodeTypes: w.requiredNodeTypes,
      requiredModels: w.requiredModels,
      featureId: w.featureId,
      bindingCount: w.bindings.length,
      notes: w.notes,
      updatedAt: w.updatedAt
    }))
  }));

  app.get('/v1/workflows/:id', async (req, reply) => {
    try {
      return { ok: true, workflow: d.workflows.get((req.params as { id: string }).id) };
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post('/v1/workflows/scan', async (req, reply) => {
    try {
      const body = (req.body ?? {}) as { json?: unknown };
      const oi = await objectInfoSafe(d);
      return { ok: true, scan: d.workflows.scan(body.json, oi) };
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post('/v1/workflows/import', async (req, reply) => {
    try {
      const body = (req.body ?? {}) as { json?: unknown; name?: string; bindings?: never; notes?: string };
      if (!body.name?.trim()) throw new PsaiError('JOB_PARAM_INVALID', '缺少工作流名称');
      const oi = await objectInfoSafe(d);
      const input: Parameters<WorkflowStore['import']>[0] = {
        json: body.json,
        name: body.name.trim(),
        objectInfo: oi
      };
      if (body.bindings) input.bindings = body.bindings;
      if (body.notes) input.notes = body.notes;
      const res = d.workflows.import(input);
      return { ok: true, workflow: res.workflow, scan: res.scan, versionBumped: res.versionBumped };
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.put('/v1/workflows/:id/bindings', async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const body = (req.body ?? {}) as { bindings?: never[] };
      return { ok: true, workflow: d.workflows.saveBindings(id, body.bindings ?? []) };
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.delete('/v1/workflows/:id', async (req, reply) => {
    try {
      d.workflows.remove((req.params as { id: string }).id);
      return { ok: true };
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.get('/v1/workflows/:id/dependencies', async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const comfy = d.providers.comfy();
      const nodes = await comfy.installedNodeTypes();
      const [checkpoints, loras, upscales, controlnets] = await Promise.all([
        comfy.enumOf('CheckpointLoaderSimple', 'ckpt_name'),
        comfy.enumOf('LoraLoader', 'lora_name'),
        comfy.enumOf('UpscaleModelLoader', 'model_name'),
        comfy.enumOf('ControlNetLoader', 'control_net_name')
      ]);
      const report = d.workflows.checkDependencies(
        id,
        nodes,
        {
          checkpoint: new Set(checkpoints),
          lora: new Set(loras),
          upscale: new Set(upscales),
          controlnet: new Set(controlnets)
        },
        d.providers.status('comfyui').baseUrl
      );
      return { ok: true, report };
    } catch (e) {
      return fail(reply, e);
    }
  });

  /* ---------------- 资产 ---------------- */

  app.post('/v1/assets', async (req, reply) => {
    try {
      const parts = req.parts();
      const saved: unknown[] = [];
      let kind: 'input' | 'reference' = 'input';
      for await (const part of parts) {
        if (part.type === 'field' && part.fieldname === 'kind') {
          const v = String(part.value);
          if (v === 'reference') kind = 'reference';
          continue;
        }
        if (part.type === 'file') {
          const buf = await part.toBuffer();
          saved.push(d.assets.put(buf, kind));
        }
      }
      if (saved.length === 0) throw new PsaiError('JOB_INPUT_MISSING', '没有收到任何文件');
      return { ok: true, assets: saved };
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.get('/v1/assets/:id', async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const rec = d.assets.get(id);
      return reply.header('Content-Type', rec.mime).header('Cache-Control', 'private, max-age=3600').send(d.assets.read(id));
    } catch (e) {
      return fail(reply, e);
    }
  });

  /* ---------------- 任务 ---------------- */

  app.post('/v1/jobs', async (req, reply) => {
    try {
      const body = (req.body ?? {}) as CreateJobRequest;
      const job = await d.jobs.create(body);
      return { ok: true, job };
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.get('/v1/jobs', async (req) => {
    const q = req.query as Record<string, string>;
    const query: JobListQuery = {};
    if (q['state']) query.state = q['state'] as JobListQuery['state'];
    if (q['featureId']) query.featureId = q['featureId'];
    if (q['documentId']) query.documentId = Number(q['documentId']);
    if (q['limit']) query.limit = Number(q['limit']);
    if (q['offset']) query.offset = Number(q['offset']);
    return { ok: true, jobs: d.jobs.list(query) };
  });

  app.get('/v1/jobs/:id', async (req, reply) => {
    try {
      return { ok: true, job: d.jobs.get((req.params as { id: string }).id) };
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.get('/v1/jobs/:id/events', async (req) => ({
    ok: true,
    events: d.jobs.eventsOf((req.params as { id: string }).id)
  }));

  app.post('/v1/jobs/:id/cancel', async (req, reply) => {
    try {
      const res = await d.jobs.cancel((req.params as { id: string }).id);
      return { ok: res.ok, cancelled: res.ok, reason: res.reason, job: d.jobs.get((req.params as { id: string }).id) };
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post('/v1/jobs/:id/discard', async (req, reply) => {
    try {
      return { ok: true, job: d.jobs.discard((req.params as { id: string }).id) };
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post('/v1/jobs/:id/retry', async (req, reply) => {
    try {
      return { ok: true, job: d.jobs.retry((req.params as { id: string }).id) };
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post('/v1/jobs/:id/rerun', async (req, reply) => {
    try {
      return { ok: true, job: d.jobs.rerun((req.params as { id: string }).id) };
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post('/v1/jobs/:id/writeback', async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const body = (req.body ?? {}) as { mode?: never; layerName?: string };
      return { ok: true, job: d.jobs.requestWriteback(id, body.mode, body.layerName) };
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post('/v1/jobs/:id/writeback-result', async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const body = (req.body ?? {}) as { ok?: boolean; detail?: string; code?: string };
      return { ok: true, job: d.jobs.reportWriteback(id, !!body.ok, body.detail ?? '', body.code) };
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.delete('/v1/jobs/:id', async (req, reply) => {
    try {
      d.jobs.remove((req.params as { id: string }).id);
      return { ok: true };
    } catch (e) {
      return fail(reply, e);
    }
  });

  /* ---------------- 提示词 ---------------- */

  app.get('/v1/prompts', async (req) => {
    const q = req.query as Record<string, string>;
    return { ok: true, presets: d.prompts.list(q['featureId'], q['kind'] as never) };
  });

  app.post('/v1/prompts', async (req, reply) => {
    try {
      const body = (req.body ?? {}) as Parameters<PromptStore['create']>[0];
      return { ok: true, preset: d.prompts.create(body) };
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.put('/v1/prompts/:id', async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const body = (req.body ?? {}) as { restore?: boolean } & Parameters<PromptStore['update']>[1];
      return { ok: true, preset: body.restore ? d.prompts.restore(id) : d.prompts.update(id, body) };
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.delete('/v1/prompts/:id', async (req, reply) => {
    try {
      d.prompts.remove((req.params as { id: string }).id);
      return { ok: true };
    } catch (e) {
      return fail(reply, e);
    }
  });

  /* ---------------- 文本能力 ---------------- */

  app.post('/v1/text/complete', async (req, reply) => {
    try {
      const body = (req.body ?? {}) as {
        presetId?: string;
        userText?: string;
        assetIds?: string[];
        featureId?: string;
      };
      const preset = body.presetId ? d.prompts.get(body.presetId) : null;
      if (!preset) throw new PsaiError('JOB_PARAM_INVALID', '缺少 presetId');
      const binding = body.featureId ? d.settings.binding(body.featureId) : null;
      const { adapter, providerId } = d.providers.resolveTextProvider(binding?.providerId);
      if (!adapter.textComplete) throw new PsaiError('PROVIDER_UNSUPPORTED', '当前后端不支持文本/视觉能力');
      const input: Parameters<NonNullable<typeof adapter.textComplete>>[0] = { instruction: preset.prompt };
      if (body.userText) input.userText = body.userText;
      if (body.assetIds?.length) {
        input.images = body.assetIds.map((id) => {
          const rec = d.assets.get(id);
          return { buffer: d.assets.read(id), mime: rec.mime };
        });
      }
      if (binding?.model) input.model = binding.model;
      const text = await adapter.textComplete(input);
      return { ok: true, text, providerId };
    } catch (e) {
      return fail(reply, e);
    }
  });

  return app;
}

async function objectInfoSafe(d: ServerDeps): Promise<Record<string, unknown> | null> {
  try {
    const comfy = d.providers.adapter('comfyui');
    if (comfy instanceof ComfyUiAdapter && comfy.isConfigured()) return await comfy.objectInfo();
  } catch {
    /* 连不上 ComfyUI 时 UI 格式转换会给出明确提示 */
  }
  return null;
}
