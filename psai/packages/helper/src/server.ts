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
  findProvider,
  filterModelsByScope,
  isModelScope,
  parseRhNodeInfo
} from '@psai/shared';
import type {
  ErrorCode,
  JobListQuery,
  CreateJobRequest,
  FeatureBinding,
  AppSettings,
  ModelScope,
  PhotoshopTarget
} from '@psai/shared';
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
import { join } from 'node:path';
import { thumbnailFor, PREVIEW_MAX_EDGE } from './thumbs.js';
import { composeAlpha, checkUsableMask } from './mask.js';

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
  // 选区数据本身不自洽（比如遮罩尺寸和画面对不上）是客户端发错了，
  // 不是服务端出错 —— 回 500 会让面板按"重试也许能好"来处理，而它永远不会好
  PHOTOSHOP_SELECTION_INVALID: 400,
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

  /**
   * 用量汇总：按 Provider 聚合跑过多少次、本地 GPU 累计多久、最近一次是什么时候。
   *
   * 数据来自 usage 表 —— 那张表一直在写，但在这个接口出现之前从来没人读过。
   * 只写不读的表不会报错，只会安静地长大；要么给它接个消费者，要么就别写。
   * 这里选择接上：本地跑还是云端跑，用户是靠这组数字决定的。
   */
  app.get('/v1/usage', async () => {
    const rows = d.db
      .prepare(
        `SELECT provider_id AS providerId,
                COUNT(*)    AS runs,
                COALESCE(SUM(gpu_ms), 0) AS gpuMs,
                MAX(at)     AS lastAt
           FROM usage
          GROUP BY provider_id
          ORDER BY runs DESC`
      )
      .all() as Array<{ providerId: string; runs: number; gpuMs: number; lastAt: number }>;
    return { ok: true, usage: rows };
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
      // 缓存里存的是平台全量目录；给 UI 的默认口径是认可的生图模型。
      // total 一并带上，设置页才能如实说「筛出 N 个 / 平台共 M 个」。
      const picked = filterModelsByScope(s.models, 'approved');
      return {
        ...s,
        models: picked.models,
        modelsScope: picked.scope,
        modelsTotal: picked.total,
        label: desc.label,
        kind: desc.kind,
        consoleUrl: desc.consoleUrl,
        description: desc.description,
        recommended: desc.recommended,
        cancelSupport: desc.cancelSupport,
        // 设置页要显示「当前用的是哪个模型」。以前没这个字段，
        // 下拉永远停在「尚未拉取模型」，用户看不出自己配过什么。
        defaultModel: d.settings.providerSettings(s.id).defaultModel,
        defaultWorkflowId: d.settings.providerSettings(s.id).defaultWorkflowId,
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
    const body = (req.body ?? {}) as { enabled?: boolean; baseUrl?: string; defaultModel?: string; defaultWorkflowId?: string };
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

    /**
     * 配好 Key 就顺手把模型拉回来。
     *
     * 以前保存完 Key 什么也不发生：设置页的模型下拉停在「尚未拉取模型」，
     * 生成页的模型下拉也是空的，用户得自己想到再去点一次「拉取模型」。
     * 可"配好了接口就该知道有哪些模型"是这一步的题中之义，不该让用户补一次操作。
     *
     * probe 失败**不**让保存失败 —— Key 已经存进去了，网络抖一下不该表现成
     * 「保存失败」让用户重填一遍。这里如实把 probe 的结果一起带回去，
     * UI 据此显示「已保存，但没拉到模型：<原因>」。
     */
    let models: string[] = [];
    let total = 0;
    let modelsError: string | null = null;
    try {
      const probed = await d.providers.probe(id);
      const picked = filterModelsByScope(probed.models, 'approved');
      models = picked.models;
      total = picked.total;
      d.events.broadcast({ type: 'provider:status', providerId: id, online: probed.online, detail: probed.reason ?? '' });
    } catch (e) {
      modelsError = toErrorShape(e).message;
      d.log.warn('保存密钥后自动拉取模型失败', { providerId: id, error: modelsError });
    }
    return { ok: true, status: d.providers.status(id), models, total, modelsError };
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

  /**
   * 模型列表。默认只给认可的生图模型，`?scope=all` 才给平台全量目录。
   *
   * 默认口径收窄的理由：Comfly 一次回 858 个，绝大多数是聊天/语音/视频模型，
   * 拿去生图一律失败。把全量目录摆进下拉，等于让用户在 858 个选项里
   * 猜哪 4 个能用 —— 猜错就是一次「点了没反应」。
   *
   * 但收窄不能变成锁死：用户点「拉取全部模型」就走 scope=all，
   * 想试冷门模型随时能试。返回里带上 scope 与 total，
   * UI 据此如实说明"这是筛过的"，而不是假装平台就这么几个模型。
   */
  app.get('/v1/providers/:id/models', async (req, reply) => {
    const { id } = req.params as { id: string };
    const raw = String((req.query as { scope?: unknown })?.scope ?? 'approved');
    const want: ModelScope = isModelScope(raw) ? raw : 'approved';
    try {
      const all = await d.providers.adapter(id).listModels();
      const picked = filterModelsByScope(all, want);
      return { ok: true, models: picked.models, scope: picked.scope, requestedScope: want, total: picked.total };
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
      // 用和提交时同一套解析，别再自己算一遍 —— 两边算法不同就会出现
      // 「界面说这个功能不能用，实际提交却跑得通」这种自相矛盾的状态。
      const providerId = d.providers.resolveProviderIdOrNull(f.id);
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

      /*
       * 闭源模型这一族：**Provider 配好了不等于这个功能能跑**。
       *
       * 真机上出过一次很难查的状态：设置页里「闭源模型 / 文生图」显示绿色的
       * 「就绪」，点生成却立刻报 WORKFLOW_NOT_BOUND —— 因为它绑的是 LiblibAI，
       * 而 LiblibAI 要么给一个云端工作流 uuid、要么给一个托管模型，两个都没填。
       * 密钥是配好的，所以 ps.configured 为真，上面那几道全都放行了。
       *
       * 「界面说能用、点下去必然失败」比直接标成未就绪坏得多：用户会反复
       * 怀疑是自己参数填错了，而真正缺的东西界面上一个字都没提。
       *
       * 所以这里补一道：以工作流为单位的平台（LiblibAI / RunningHub），
       * 走闭源模型功能时必须有一个能提交的东西 ——
       * 绑定里的模型、绑定里的云端工作流、或者 Provider 上的默认值。
       */
      if (ready && f.engine !== 'comfy-workflow' && providerId && ps) {
        const desc = findProvider(providerId);
        const workflowStyle = !!desc && desc.capabilities.includes('workflow') && desc.kind !== 'comfyui';
        if (workflowStyle) {
          const pset = d.settings.providerSettings(providerId);
          const hasSomething =
            !!b?.model?.trim() ||
            !!b?.remoteWorkflowId?.trim() ||
            !!pset.defaultModel?.trim() ||
            !!pset.defaultWorkflowId?.trim();
          if (!hasSomething) {
            ready = false;
            reason =
              `${desc!.label} 还没有可提交的目标：要么在这一行绑一个云端工作流 / 模型，` +
              `要么在「推荐平台」里给它填一个默认工作流 ID 或默认模型。`;
          }
        }
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
      kind: w.kind,
      providerId: w.providerId,
      remoteId: w.remoteId,
      // 界面要靠它分辨这条是「AI 应用」还是「ComfyUI 工作流」——
      // 两者接口不同，列表里不给的话前端只能猜
      remoteKind: w.remoteKind,
      nodeInfo: w.nodeInfo,
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

  /**
   * 登记一条云端工作流（RunningHub / LiblibAI 的工作流 / webapp ID）。
   *
   * 和 /import 分成两个路由而不是共用一个：两者的必填项、校验、失败原因
   * 完全不同 —— 一个要图，一个要平台和 ID。挤在一起就得靠 if 分叉，
   * 错误信息也只能说得含糊。
   */
  app.post('/v1/workflows/cloud', async (req, reply) => {
    try {
      const body = (req.body ?? {}) as {
        name?: string;
        providerId?: string;
        remoteId?: string;
        notes?: string;
        remoteKind?: 'workflow' | 'aiApp';
        /** AI 应用：用户从平台 API 页面复制来的「请求示例」原文 */
        nodeInfoRaw?: string;
        /** AI 应用：界面上逐项填好的节点表（不经过剪贴板，粘贴被截断时用这条） */
        nodeInfo?: Array<{ nodeId?: unknown; fieldName?: unknown; description?: unknown; defaultValue?: unknown }>;
      };
      /*
       * AI 应用的节点参数表由用户粘贴带进来，在这里解析。
       *
       * 解析放服务端而不是界面层：解析失败要说清怎么办，而那句话
       * 该和存储层的校验用同一套口径 —— 两边各写一套的话，
       * 界面放行的东西存储层可能照样拒，用户会看到两条互相矛盾的提示。
       */
      let nodeInfo: ReturnType<typeof parseRhNodeInfo> | undefined;
      if (body.remoteKind === 'aiApp') {
        /*
         * 两条路都收：界面逐项填好的数组，或者整段 curl 原文。
         *
         * 为什么不能只留粘贴那条：真机上 UXP 的文本框粘贴会被截断
         * （用户粘完只剩开头几行，解析必然失败），而那是宿主的行为，
         * 我们改不了。逐项填写不经过剪贴板，是唯一稳的那条路。
         */
        if (Array.isArray(body.nodeInfo) && body.nodeInfo.length) {
          nodeInfo = body.nodeInfo
            .filter((f) => f && String(f.nodeId ?? '').trim() && String(f.fieldName ?? '').trim())
            .map((f) => ({
              nodeId: String(f.nodeId).trim(),
              fieldName: String(f.fieldName).trim(),
              description: String(f.description ?? ''),
              defaultValue: String(f.defaultValue ?? '')
            }));
          if (!nodeInfo.length) {
            throw new PsaiError('JOB_PARAM_INVALID', '节点参数表里每一行都要填「节点号」和「字段名」。');
          }
        } else {
          try {
            nodeInfo = parseRhNodeInfo(String(body.nodeInfoRaw ?? ''));
          } catch (e) {
            throw new PsaiError('JOB_PARAM_INVALID', e instanceof Error ? e.message : String(e));
          }
        }
      }
      const res = d.workflows.importCloud({
        name: String(body.name ?? ''),
        providerId: String(body.providerId ?? ''),
        remoteId: String(body.remoteId ?? ''),
        ...(body.remoteKind ? { remoteKind: body.remoteKind } : {}),
        ...(nodeInfo ? { nodeInfo } : {}),
        ...(body.notes ? { notes: body.notes } : {})
      });
      return { ok: true, workflow: res.workflow, versionBumped: res.versionBumped };
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
      /*
       * 云端工作流没有本机图，依赖检查无从谈起：节点装在平台那边，
       * 模型也在平台那边。对着一份空图跑检查会得到「全部就绪」——
       * 一个看起来通过、实际什么都没查的结论，比报错更糟。
       */
      const wf = d.workflows.get(id);
      if (wf.kind === 'cloud') {
        throw new PsaiError('JOB_PARAM_INVALID', '云端工作流跑在平台上，本机查不了它的节点和模型依赖');
      }
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

  /**
   * 上传资产。
   *
   * 可以额外带一个 `mask` 文件 + `maskWidth` / `maskHeight` 两个字段：
   * 那是 Photoshop 的选区灰度（0 未选中 / 255 完全选中 / 中间值是羽化）。
   * 带了就把它合成进图像的 alpha 通道再落库。
   *
   * 为什么合成放在这边：PNG 编解码这边已经有了（缩略图用的那一套），
   * 而插件跑在 UXP 里，既没有这套代码、也没法被自动化测试覆盖。
   */
  app.post('/v1/assets', async (req, reply) => {
    try {
      const parts = req.parts();
      const files: Buffer[] = [];
      let kind: 'input' | 'reference' = 'input';
      let mask: Buffer | null = null;
      let maskWidth = 0;
      let maskHeight = 0;

      for await (const part of parts) {
        if (part.type === 'field') {
          const v = String(part.value);
          if (part.fieldname === 'kind' && v === 'reference') kind = 'reference';
          if (part.fieldname === 'maskWidth') maskWidth = Number(v) || 0;
          if (part.fieldname === 'maskHeight') maskHeight = Number(v) || 0;
          continue;
        }
        if (part.type === 'file') {
          const buf = await part.toBuffer();
          if (part.fieldname === 'mask') mask = buf;
          else files.push(buf);
        }
      }
      if (files.length === 0) throw new PsaiError('JOB_INPUT_MISSING', '没有收到任何文件');

      const saved: unknown[] = [];
      for (const [i, buf] of files.entries()) {
        // 遮罩只作用在第一张上：一次捕获只有一个选区
        const composed = i === 0 && !!mask;
        const withMask = composed ? composeAlpha(buf, mask!, maskWidth, maskHeight) : buf;
        /*
         * 记下"这张图的 alpha 是一次明确的选区遮罩"。
         *
         * 只有真的合成过的那一张才算。别的图哪怕带着 alpha 通道，
         * 那也只是它自己的透明度 —— 不是用户圈出来的处理区。
         */
        saved.push(d.assets.put(withMask, kind, { selectionMask: composed }));
      }

      /*
       * 合成完立刻体检一遍，把结果如实带回去。
       *
       * 不在这里拦死：拦不拦得住是**功能**说了算 —— 局部重绘那一族没有可用遮罩
       * 就是废的，而普通图生图带不带遮罩都能跑。这里只负责把事实测出来，
       * 判断留给创建任务那一步（它才知道这张图要喂给哪个功能）。
       */
      const maskInfo = mask ? checkUsableMask(d.assets.read(String((saved[0] as { id: string }).id))) : null;
      if (maskInfo && !maskInfo.ok) {
        d.log.warn('选区遮罩体检没过', { reason: maskInfo.reason, stats: maskInfo.stats });
      }
      return { ok: true, assets: saved, ...(maskInfo ? { mask: maskInfo } : {}) };
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.get('/v1/assets/:id', async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const rec = d.assets.get(id);

      // ?thumb=1 给缩略图。历史页一屏几十个 46×46 的小方块，
      // 以前每个都在拉原图（平均 1.59MB、最大 15.4MB）再由插件在 UXP 的
      // JS 线程上转 base64 —— 面板卡顿掉帧就是这么来的。
      // 缩放放在这边做，只做一次、结果落盘缓存。
      // ?preview=1 是给生成页结果预览的中间档（1280 长边）：
      // 看得清效果，又不会让 UXP 线程去转一张十几兆的原图。
      const q = req.query as { thumb?: string; preview?: string };
      if (q.thumb || q.preview) {
        const thumb = thumbnailFor(
          d.assets.absPathOf(rec),
          join(d.cfg.dataDir, 'thumbs'),
          rec.sha256,
          q.preview ? PREVIEW_MAX_EDGE : undefined
        );
        if (thumb) {
          return reply
            .header('Content-Type', thumb.mime)
            // 内容寻址：同一个 id 的缩略图永远不会变，可以放心长缓存
            .header('Cache-Control', 'private, max-age=604800, immutable')
            .send(thumb.bytes);
        }
        // 缩不动就老老实实发原图，不返回一张错的图
      }

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

  /**
   * 取消。
   *
   * ok 只表示"这个请求处理成功了"，取消到底生没生效看 cancelled。
   * 以前把业务结论塞进 ok：远端不支持取消时返回 200 + ok:false，
   * 于是客户端那套统一的错误处理会把它当成一次**失败的调用**报出去 ——
   * 而它其实是一次成功的调用，只是答案是"取消不了"。
   * pending 表示提交还在飞，结论稍后由任务状态给出。
   */
  app.post('/v1/jobs/:id/cancel', async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const res = await d.jobs.cancel(id);
      return { ok: true, cancelled: res.cancelled, pending: res.pending, reason: res.reason, job: d.jobs.get(id) };
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

  /**
   * 处置「提交结果未知」的任务。
   *
   * 这个状态是终态，普通的 retry / rerun 一律不该碰它 ——
   * 那两条路会在用户没意识到风险的情况下再发一次请求，
   * 而上一次可能已经在平台侧计费了。所以单独开一个接口，
   * 且 retry 分支强制要求 confirmedDuplicateBillingRisk。
   */
  app.post('/v1/jobs/:id/resolve-submission', async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const body = (req.body ?? {}) as {
        decision?: 'retry' | 'abandon' | 'adopt';
        remoteId?: string;
        confirmedDuplicateBillingRisk?: boolean;
      };
      if (!body.decision || !['retry', 'abandon', 'adopt'].includes(body.decision)) {
        throw new PsaiError('JOB_PARAM_INVALID', 'decision 必须是 retry / abandon / adopt 之一');
      }
      const job = d.jobs.resolveSubmissionUnknown(id, body.decision, {
        ...(body.remoteId ? { remoteId: body.remoteId } : {}),
        // 严格转发布尔值，不做 truthy 转换 —— 字符串 "false" 也是 truthy，
        // 在这里悄悄变成 true 的话，引擎那边的严格校验就形同虚设
        ...(body.confirmedDuplicateBillingRisk === true ? { confirmedDuplicateBillingRisk: true } : {})
      });
      return { ok: true, job };
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post('/v1/jobs/:id/writeback', async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const body = (req.body ?? {}) as {
        mode?: never;
        layerName?: string;
        auto?: boolean;
        assetId?: string;
        /** 显式改绑写回目标：把这条任务的结果写进**另一份**（或第一份）文档 */
        target?: PhotoshopTarget;
      };
      /*
       * 这个端点不只是"把任务放回待写回"，它同时是一次**执行权的领取**：
       * 返回的 attemptId 是凭据，插件回报结果时必须带回来。
       * 没有它的话，两个面板实例会各写一遍，用户文档里凭空多一个图层。
       */
      const { job, attemptId } = d.jobs.requestWriteback(id, body.mode, body.layerName, {
        auto: body.auto === true,
        ...(body.assetId ? { assetId: body.assetId } : {}),
        ...(body.target ? { rebindTarget: body.target } : {})
      });
      return { ok: true, job, attemptId };
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post('/v1/jobs/:id/writeback-result', async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const body = (req.body ?? {}) as { ok?: boolean; detail?: string; code?: string; attemptId?: string };
      return {
        ok: true,
        job: d.jobs.reportWriteback(id, !!body.ok, body.detail ?? '', body.code, body.attemptId)
      };
    } catch (e) {
      return fail(reply, e);
    }
  });

  /**
   * 续租。
   *
   * 写一张 8K 智能对象可能要几十秒，而租约只有两分钟。没有这个端点的话，
   * 一次**正在正常进行**的写回会被当成卡死让位，另一个写手接手 ——
   * 用户文档里就多了一个图层。插件在写的过程中定期来续一次。
   */
  app.post('/v1/jobs/:id/writeback/renew', async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const body = (req.body ?? {}) as { attemptId?: string };
      if (!body.attemptId) throw new PsaiError('JOB_PARAM_INVALID', '续租需要 attemptId');
      const res = d.jobs.renewWriteback(id, body.attemptId);
      return { ok: true, renewed: res.ok, reason: res.reason };
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
      // 同 engine.runTextTask：不把功能绑定的**生图**模型传进文本能力，
      // 优化/反推一律用适配器内置的语言模型（GPT-5.6 一族）。
      const text = await adapter.textComplete(input);
      return { ok: true, text, providerId, model: adapter.lastTextModel?.() ?? null };
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
