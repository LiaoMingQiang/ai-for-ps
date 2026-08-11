/* server: Fastify 实例 + 全部路由 + WS /v1/events + Bearer 认证
 * 规则八: 默认 127.0.0.1; token 认证除公开端点外全部启用 */
import Fastify, { type FastifyInstance } from "fastify";
import { WebSocketServer, type WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, VERSION } from "./config.js";
import { Store } from "./db.js";
import * as pairing from "./pairing.js";
import { readGpuInfo } from "./gpu.js";
import { listProviders, seedProviders } from "./providers/registry.js";

const PUBLIC_PATHS = new Set(["/v1/health", "/v1/pair", "/v1/system"]);

export interface HelperContext {
  store: Store;
  cfg: ReturnType<typeof loadConfig>;
  wsClients: Set<WebSocket>;
  broadcast: (msg: unknown) => void;
}

export function buildServer(): FastifyInstance {
  const cfg = loadConfig();
  const store = new Store(cfg);
  seedProviders(store);
  if (!pairing.getToken(store)) pairing.generateToken(store);

  const app = Fastify({ logger: { level: process.env.A4P_LOG_LEVEL || "info" } });
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<WebSocket>();
  const broadcast = (msg: unknown) => {
    const s = JSON.stringify(msg);
    for (const c of clients) { try { if (c.readyState === 1) c.send(s); } catch (e) { /* noop */ } }
  };
  const ctx: HelperContext = { store, cfg, wsClients: clients, broadcast };

  /* ---- 认证: 除公开端点外都需要 Bearer token ---- */
  app.addHook("onRequest", async (req, reply) => {
    const url = (req.url || "").split("?")[0];
    if (PUBLIC_PATHS.has(url)) return;
    if (!pairing.verifyToken(store, req.headers.authorization)) {
      reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "未配对: 请在插件中重新配对" } });
    }
  });

  /* ---- WS /v1/events (token 校验) ---- */
  app.server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "", "http://localhost");
    if (url.pathname !== "/v1/events") { socket.destroy(); return; }
    const tok = url.searchParams.get("token") || "";
    if (!tok || tok !== (pairing.getToken(store) || "")) { socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n"); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      clients.add(ws);
      ws.on("close", () => clients.delete(ws));
      ws.send(JSON.stringify({ type: "connected", version: VERSION }));
    });
  });

  /* ---- 路由 ---- */
  app.get("/v1/health", async () => ({
    online: true,
    version: VERSION,
    schemaVersion: store.schemaVersion,
    pingMs: 0,
    host: cfg.host,
    lanMode: cfg.host !== "127.0.0.1"
  }));

  app.post("/v1/pair", async (req) => {
    const body = (req.body || {}) as Record<string, unknown>;
    if (body.rotate === true) { const t = pairing.rotateToken(store); return { paired: true, token: t, rotated: true }; }
    const t = pairing.getToken(store) || pairing.generateToken(store);
    return { paired: true, token: t, version: VERSION };
  });

  app.get("/v1/system", async () => {
    const gpu = await readGpuInfo();
    return {
      version: VERSION,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      uptimeSec: Math.round(process.uptime()),
      dataDir: cfg.dataDir,
      gpu: gpu.gpuName,
      vramTotalMb: gpu.vramTotalMb,
      dbSchema: store.schemaVersion
    };
  });

  app.get("/v1/gpu", async () => readGpuInfo());

  app.get("/v1/providers", async () => ({ providers: listProviders(store) }));

  app.get("/v1/providers/:id/models", async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = listProviders(store).find((x) => x.id === id);
    if (!p) return reply.code(404).send({ error: { code: "PROVIDER_NOT_FOUND", message: "Provider 不存在: " + id } });
    if (!p.enabled && !p.configured) {
      return reply.code(409).send({ error: { code: "PROVIDER_NOT_CONFIGURED", message: "Provider 尚未配置", providerId: id } });
    }
    /* PHASE 6/7: 真实模型列表; 当前返回空列表 + configured 状态 */
    return { providerId: id, models: [], configured: p.configured };
  });

  app.get("/v1/providers/:id/capabilities", async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = listProviders(store).find((x) => x.id === id);
    if (!p) return reply.code(404).send({ error: { code: "PROVIDER_NOT_FOUND", message: "Provider 不存在: " + id } });
    return { providerId: id, capabilities: p.capabilities };
  });

  app.post("/v1/providers/:id/test", async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = listProviders(store).find((x) => x.id === id);
    if (!p) return reply.code(404).send({ error: { code: "PROVIDER_NOT_FOUND", message: "Provider 不存在: " + id } });
    /* PHASE 6/7: 真实连通性测试; 当前: 未配置即失败 */
    if (!p.configured) {
      return { ok: false, providerId: id, error: { code: "PROVIDER_NOT_CONFIGURED", message: "Provider 尚未配置" } };
    }
    return { ok: true, providerId: id, message: "配置存在" };
  });

  /* ---- workflows (PHASE 8 完整实现; 当前骨架) ---- */
  app.get("/v1/workflows", async () => {
    const rows = store.raw.prepare("SELECT id, name, version, category, provider, created_at, updated_at FROM workflows ORDER BY updated_at DESC").all();
    return { workflows: rows };
  });
  app.get("/v1/workflows/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = store.raw.prepare("SELECT * FROM workflows WHERE id=?").get(id);
    if (!row) return reply.code(404).send({ error: { code: "WORKFLOW_NOT_FOUND", message: "工作流不存在: " + id } });
    return { workflow: row };
  });

  /* ---- jobs (PHASE 9 完整引擎; 当前: 表 CRUD + 状态机) ---- */
  app.post("/v1/jobs", async (req, reply) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const id = randomUUID();
    const providerId = String(body.providerId || "local-comfy");
    const now = Date.now();
    store.raw.prepare(`INSERT INTO jobs (id, status, provider_id, provider_type, workflow_id, model_id, inputs_json, parameters_json, snapshot_json, project_id, source_document_id, source_document_name, source_document_path, source_layer_ids_json, selection_bounds_json, canvas_width, canvas_height, color_mode, bit_depth, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, "created", providerId,
      (listProviders(store).find((p) => p.id === providerId)?.type) || "comfyui",
      body.workflowId ? String(body.workflowId) : null,
      body.modelId ? String(body.modelId) : null,
      JSON.stringify(body.inputs || {}), JSON.stringify(body.parameters || {}),
      JSON.stringify(body.snapshot || {}),
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
    store.raw.prepare("INSERT INTO job_events (job_id, from_status, to_status, detail, created_at) VALUES (?,?,?,?,?)").run(id, null, "created", "job created", now);
    const job = store.raw.prepare("SELECT * FROM jobs WHERE id=?").get(id);
    broadcast({ type: "job:update", job });
    return reply.code(201).send({ job });
  });

  app.get("/v1/jobs", async (req) => {
    const q = (req.query || {}) as Record<string, string>;
    let sql = "SELECT * FROM jobs";
    const params: string[] = [];
    if (q.status) { sql += " WHERE status=?"; params.push(q.status); }
    if (q.projectId) { sql += (params.length ? " AND " : " WHERE ") + "project_id=?"; params.push(q.projectId); }
    sql += " ORDER BY created_at DESC LIMIT 200";
    return { jobs: store.raw.prepare(sql).all(...params) };
  });

  app.get("/v1/jobs/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = store.raw.prepare("SELECT * FROM jobs WHERE id=?").get(id);
    if (!job) return reply.code(404).send({ error: { code: "JOB_NOT_FOUND", message: "任务不存在: " + id } });
    const events = store.raw.prepare("SELECT * FROM job_events WHERE job_id=? ORDER BY created_at ASC").all(id);
    return { job, events };
  });

  app.post("/v1/jobs/:id/cancel", async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = store.raw.prepare("SELECT * FROM jobs WHERE id=?").get(id) as Record<string, unknown> | undefined;
    if (!job) return reply.code(404).send({ error: { code: "JOB_NOT_FOUND", message: "任务不存在: " + id } });
    const status = String(job.status);
    if (["completed", "failed", "cancelled", "retryable_writeback_failure"].includes(status)) {
      return reply.code(409).send({ error: { code: "JOB_NOT_CANCELLABLE", message: "任务已处于终态: " + status } });
    }
    store.raw.prepare("UPDATE jobs SET status='cancel_requested', updated_at=? WHERE id=?").run(Date.now(), id);
    store.raw.prepare("INSERT INTO job_events (job_id, from_status, to_status, detail, created_at) VALUES (?,?,?,?,?)").run(id, status, "cancel_requested", "cancel requested", Date.now());
    const j2 = store.raw.prepare("SELECT * FROM jobs WHERE id=?").get(id);
    broadcast({ type: "job:update", job: j2 });
    return { job: j2 };
  });

  app.post("/v1/jobs/:id/retry", async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = store.raw.prepare("SELECT * FROM jobs WHERE id=?").get(id) as Record<string, unknown> | undefined;
    if (!job) return reply.code(404).send({ error: { code: "JOB_NOT_FOUND", message: "任务不存在: " + id } });
    store.raw.prepare("UPDATE jobs SET status='created', remote_job_id=NULL, error_json=NULL, updated_at=? WHERE id=?").run(Date.now(), id);
    store.raw.prepare("INSERT INTO job_events (job_id, from_status, to_status, detail, created_at) VALUES (?,?,?,?,?)").run(id, String(job.status), "created", "retry requested", Date.now());
    const j2 = store.raw.prepare("SELECT * FROM jobs WHERE id=?").get(id);
    broadcast({ type: "job:update", job: j2 });
    return { job: j2 };
  });

  app.post("/v1/jobs/:id/writeback-ready", async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = store.raw.prepare("SELECT * FROM jobs WHERE id=?").get(id) as Record<string, unknown> | undefined;
    if (!job) return reply.code(404).send({ error: { code: "JOB_NOT_FOUND", message: "任务不存在: " + id } });
    store.raw.prepare("UPDATE jobs SET status='writeback_pending', updated_at=? WHERE id=?").run(Date.now(), id);
    const j2 = store.raw.prepare("SELECT * FROM jobs WHERE id=?").get(id);
    broadcast({ type: "job:update", job: j2 });
    return { job: j2 };
  });

  /* ---- assets (PHASE 4 完整 Asset Store; 当前: 元数据注册 + 文件读取) ---- */
  app.post("/v1/assets", async (req, reply) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const parts = (req as unknown as { parts?: () => Promise<unknown> }).parts;
    if (parts) {
      return reply.code(501).send({ error: { code: "NOT_IMPLEMENTED_YET", message: "资产文件上传将在 PHASE 4 提供" } });
    }
    const id = randomUUID();
    const now = Date.now();
    store.raw.prepare("INSERT INTO assets (id, job_id, mime_type, width, height, size, hash, storage_path, kind, role, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(
      id, body.jobId ? String(body.jobId) : null, String(body.mimeType || "image/png"),
      body.width ? Number(body.width) : null, body.height ? Number(body.height) : null,
      Number(body.size || 0), body.hash ? String(body.hash) : null,
      String(body.storagePath || ""), String(body.kind || "result"), body.role ? String(body.role) : null, now
    );
    return reply.code(201).send({ asset: store.raw.prepare("SELECT * FROM assets WHERE id=?").get(id) });
  });

  app.get("/v1/assets/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = store.raw.prepare("SELECT * FROM assets WHERE id=?").get(id);
    if (!row) return reply.code(404).send({ error: { code: "ASSET_NOT_FOUND", message: "资产不存在: " + id } });
    const a = row as Record<string, unknown>;
    const filePath = String(a.storage_path);
    if (fs.existsSync(filePath)) {
      const buf = fs.readFileSync(filePath);
      return reply.header("content-type", String(a.mime_type || "image/png")).header("content-length", String(buf.length)).send(buf);
    }
    return { asset: row };
  });

  /* ---- projects ---- */
  app.get("/v1/projects", async () => {
    const rows = store.raw.prepare("SELECT * FROM projects ORDER BY updated_at DESC").all();
    return { projects: rows };
  });
  app.get("/v1/projects/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = store.raw.prepare("SELECT * FROM projects WHERE id=?").get(id);
    if (!row) return reply.code(404).send({ error: { code: "PROJECT_NOT_FOUND", message: "项目不存在: " + id } });
    return { project: row };
  });

  /* ---- session ---- */
  app.post("/v1/session/refresh", async () => ({ ok: true, refreshedAt: Date.now() }));

  /* 未匹配路由: 404 JSON */
  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({ error: { code: "NOT_FOUND", message: "未知端点: " + req.url } });
  });

  return app;
}

export function serverErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((err: unknown, req, reply) => {
    const e = err as { message?: string; statusCode?: number };
    req.log.error(e);
    reply.code(e.statusCode || 500).send({
      error: { code: "INTERNAL", message: e.message || "内部错误", diagnosticId: randomUUID().slice(0, 8) }
    });
  });
}
