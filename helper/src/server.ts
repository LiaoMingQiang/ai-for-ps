/* server: Fastify 实例 + 全部路由 + WS /v1/events + Bearer 认证
 * 规则八: 默认 127.0.0.1; token 认证除公开端点外全部启用 */
import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { WebSocketServer, type WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { loadConfig, VERSION } from "./config.js";
import { Store } from "./db.js";
import * as pairing from "./pairing.js";
import { readGpuInfo } from "./gpu.js";
import { listProviders, seedProviders } from "./providers/registry.js";
import { CredentialService } from "./credentials.js";
import { scanWorkflow } from "./workflow/scanner.js";
import { importWorkflow, saveWorkflowVersion, checkDependencies } from "./workflow/importer.js";

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
  app.register(multipart, { limits: { fileSize: 200 * 1024 * 1024, files: 12 } });
  const credentials = new CredentialService(store, cfg);
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

  /* ---- workflows (PHASE 8: 导入/扫描/Studio/版本/依赖) ---- */
  app.get("/v1/workflows", async () => {
    const rows = store.raw.prepare("SELECT id, name, version, category, provider, created_at, updated_at FROM workflows ORDER BY updated_at DESC").all();
    return { workflows: rows };
  });
  app.get("/v1/workflows/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = store.raw.prepare("SELECT * FROM workflows WHERE id=?").get(id);
    if (!row) return reply.code(404).send({ error: { code: "WORKFLOW_NOT_FOUND", message: "工作流不存在: " + id } });
    const bindings = store.raw.prepare("SELECT field_key, node_id, input_key, field_type, label, sort_order, group_name, default_value, display_condition FROM workflow_bindings WHERE workflow_id=? ORDER BY sort_order").all(id);
    const versions = store.raw.prepare("SELECT id, version, workflow_json_hash, bindings_hash, lockfile_hash, changelog, author, created_at FROM workflow_versions WHERE workflow_id=? ORDER BY created_at DESC").all(id);
    return { workflow: row, bindings, versions };
  });

  app.post("/v1/workflows/import", async (req, reply) => {
    const body = (req.body || {}) as Record<string, unknown>;
    try {
      const result = importWorkflow(store, {
        name: String(body.name || ""),
        json: body.json,
        category: body.category ? String(body.category) : undefined,
        description: body.description ? String(body.description) : undefined,
        provider: body.provider ? String(body.provider) : undefined,
        author: body.author ? String(body.author) : undefined
      });
      broadcast({ type: "workflow:imported", workflowId: result.workflowId });
      return reply.code(201).send({
        workflowId: result.workflowId,
        version: result.version,
        fields: result.scan.fields.map((f) => ({ nodeId: f.nodeId, nodeType: f.nodeType, inputKey: f.inputKey, fieldType: f.fieldType, semantic: f.semantic || null, advanced: f.advanced })),
        bindingsCount: result.bindingsCount,
        dependenciesCount: result.dependenciesCount,
        outputNodes: result.scan.outputNodes
      });
    } catch (e) {
      const msg = String((e as Error).message);
      const code = /^([A-Z_]+):/.exec(msg)?.[1] || "WORKFLOW_IMPORT_FAILED";
      return reply.code(400).send({ error: { code, message: msg.replace(/^[A-Z_]+:\s*/, "") } });
    }
  });

  app.post("/v1/workflows/:id/validate", async (req, reply) => {
    const body = (req.body || {}) as Record<string, unknown>;
    try {
      const scan = scanWorkflow(body.json);
      return { ok: true, fields: scan.fields.length, outputNodes: scan.outputNodes.length, dependencies: scan.dependencies };
    } catch (e) {
      return reply.code(400).send({ ok: false, error: { code: "WORKFLOW_INVALID", message: String((e as Error).message) } });
    }
  });

  app.post("/v1/workflows/:id/bindings", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body || {}) as Record<string, unknown>;
    try {
      const r = saveWorkflowVersion(store, id, {
        json: body.json !== undefined ? body.json : undefined,
        bindings: Array.isArray(body.bindings) ? (body.bindings as Array<Record<string, unknown>>).map((b) => ({
          fieldKey: String(b.fieldKey), nodeId: String(b.nodeId), inputKey: String(b.inputKey),
          fieldType: String(b.fieldType || "STRING"), label: String(b.label || b.fieldKey),
          sortOrder: Number(b.sortOrder || 0), groupName: String(b.groupName || "其他"), defaultValue: b.defaultValue
        })) : undefined,
        changelog: body.changelog ? String(body.changelog) : undefined,
        author: body.author ? String(body.author) : undefined
      });
      broadcast({ type: "workflow:updated", workflowId: id, version: r.version });
      return { workflowId: id, version: r.version };
    } catch (e) {
      const msg = String((e as Error).message);
      const code = /^([A-Z_]+):/.exec(msg)?.[1] || "WORKFLOW_SAVE_FAILED";
      return reply.code(400).send({ error: { code, message: msg.replace(/^[A-Z_]+:\s*/, "") } });
    }
  });

  app.get("/v1/workflows/:id/dependencies", async (req, reply) => {
    const { id } = req.params as { id: string };
    const wf = store.raw.prepare("SELECT * FROM workflows WHERE id=?").get(id) as Record<string, unknown> | undefined;
    if (!wf) return reply.code(404).send({ error: { code: "WORKFLOW_NOT_FOUND", message: "工作流不存在: " + id } });
    const comfy = (store.raw.prepare("SELECT base_url FROM providers WHERE id='local-comfy'").get() as { base_url: string | null } | undefined)?.base_url || "http://127.0.0.1:8188";
    const deps = await checkDependencies(store, id, comfy);
    return { workflowId: id, dependencies: deps };
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

  /* ---- credentials (规则六: API Key 只存 Helper, DPAPI/Keychain) ---- */
  app.post("/v1/providers/:id/credentials", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body || {}) as Record<string, unknown>;
    const apiKey = typeof body.apiKey === "string" && body.apiKey.trim() ? body.apiKey.trim() : null;
    if (!apiKey) return reply.code(400).send({ error: { code: "INVALID_CREDENTIAL", message: "缺少 apiKey" } });
    const p = listProviders(store).find((x) => x.id === id);
    if (!p) return reply.code(404).send({ error: { code: "PROVIDER_NOT_FOUND", message: "Provider 不存在: " + id } });
    if (p.type === "comfyui") return reply.code(400).send({ error: { code: "CREDENTIAL_NOT_NEEDED", message: "ComfyUI 本地 Provider 不需要 API Key" } });
    try {
      await credentials.set(id, apiKey);
      broadcast({ type: "provider:update", providerId: id, configured: true });
      return { ok: true, providerId: id, kind: await credentials.kind() };
    } catch (e) {
      return reply.code(500).send({ error: { code: "CREDENTIAL_STORE_FAILED", message: "凭据存储失败: " + String((e as Error).message) } });
    }
  });

  app.delete("/v1/providers/:id/credentials", async (req, reply) => {
    const { id } = req.params as { id: string };
    await credentials.delete(id);
    broadcast({ type: "provider:update", providerId: id, configured: false });
    return { ok: true, providerId: id };
  });

  /* ---- projects (规则二十二: PSD Project Context) ---- */
  app.post("/v1/projects", async (req, reply) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const docPath = body.documentPath ? String(body.documentPath) : null;
    const docPersistentId = body.documentPersistentId ? String(body.documentPersistentId) : null;
    if (!docPath && !docPersistentId) {
      return reply.code(400).send({ error: { code: "PROJECT_KEY_MISSING", message: "需要 documentPath 或 documentPersistentId" } });
    }
    const now = Date.now();
    let existing: Record<string, unknown> | undefined;
    if (docPersistentId) {
      existing = store.raw.prepare("SELECT * FROM projects WHERE document_persistent_id=?").get(docPersistentId) as Record<string, unknown> | undefined;
    }
    if (!existing && docPath) {
      existing = store.raw.prepare("SELECT * FROM projects WHERE document_path=?").get(docPath) as Record<string, unknown> | undefined;
    }
    if (existing) {
      const id = String(existing.id);
      store.raw.prepare("UPDATE projects SET document_path=?, document_name=?, updated_at=? WHERE id=?").run(
        docPath || String(existing.document_path || ""), body.documentName ? String(body.documentName) : String(existing.document_name || ""), now, id
      );
      const project = store.raw.prepare("SELECT * FROM projects WHERE id=?").get(id);
      return { project, created: false };
    }
    const id = randomUUID();
    store.raw.prepare("INSERT INTO projects (id, document_persistent_id, document_path, document_name, default_writeback, created_at, updated_at) VALUES (?,?,?,?,?,?,?)").run(
      id, docPersistentId, docPath, body.documentName ? String(body.documentName) : null, "smartObject", now, now
    );
    const project = store.raw.prepare("SELECT * FROM projects WHERE id=?").get(id);
    return reply.code(201).send({ project, created: true });
  });

  /* ---- assets (规则二十八: 结果持久缓存到 Helper Asset Store) ---- */
  app.post("/v1/assets", async (req, reply) => {
    const parts = req.parts();
    const fields: Record<string, string> = {};
    let fileBuf: Buffer | null = null;
    let fileName = "";
    for await (const part of parts) {
      if (part.type === "file") {
        const chunks: Buffer[] = [];
        for await (const c of part.file) chunks.push(c as Buffer);
        fileBuf = Buffer.concat(chunks);
        fileName = part.filename || "upload.png";
      } else {
        fields[part.fieldname] = String(part.value);
      }
    }
    if (!fileBuf) return reply.code(400).send({ error: { code: "ASSET_FILE_MISSING", message: "缺少文件" } });
    const hash = crypto.createHash("sha256").update(fileBuf).digest("hex");
    /* hash 去重 (settings.storage.hashDedup): 同 hash 返回已有资产 */
    if (fields.hashDedup !== "false") {
      const dup = store.raw.prepare("SELECT * FROM assets WHERE hash=?").get(hash) as Record<string, unknown> | undefined;
      if (dup) return { asset: dup, deduped: true };
    }
    let width: number | null = null;
    let height: number | null = null;
    let mime = "image/png";
    try {
      const sharp = (await import("sharp")).default;
      const meta = await sharp(fileBuf).metadata();
      width = meta.width || null;
      height = meta.height || null;
      if (meta.format === "jpeg") mime = "image/jpeg";
      else if (meta.format === "webp") mime = "image/webp";
      else if (meta.format === "tiff") mime = "image/tiff";
    } catch (e) { /* 非图像: 保持默认 */ }
    const ext = mime === "image/jpeg" ? ".jpg" : mime === "image/webp" ? ".webp" : mime === "image/tiff" ? ".tiff" : ".png";
    const assetId = randomUUID();
    const storagePath = path.join(cfg.assetsDir, assetId + ext);
    fs.writeFileSync(storagePath, fileBuf);
    const now = Date.now();
    store.raw.prepare("INSERT INTO assets (id, job_id, mime_type, width, height, size, hash, storage_path, kind, role, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(
      assetId,
      fields.jobId || null,
      mime, width, height, fileBuf.length, hash, storagePath,
      fields.kind || "result", fields.role || null, now
    );
    const asset = store.raw.prepare("SELECT * FROM assets WHERE id=?").get(assetId);
    /* 任务结果资产关联: job_outputs */
    if (fields.jobId && fields.kind === "result") {
      store.raw.prepare("INSERT OR IGNORE INTO job_outputs (id, job_id, asset_id, label, favorite, created_at) VALUES (?,?,?,?,0,?)").run(
        randomUUID(), fields.jobId, assetId, fields.label || fileName, now
      );
      store.raw.prepare("UPDATE jobs SET result_assets_json=? WHERE id=?").run(
        JSON.stringify((store.raw.prepare("SELECT asset_id FROM job_outputs WHERE job_id=?").all(fields.jobId) as Array<{ asset_id: string }>).map((r) => r.asset_id)),
        fields.jobId
      );
    }
    /* 快照输入资产: snapshots 表 */
    if (fields.snapshotId) {
      store.raw.prepare("INSERT OR IGNORE INTO snapshots (id, document_id, document_path, layer_ids_json, selection_bounds_json, width, height, color_mode, bit_depth, input_asset_ids_json, workflow_id, workflow_version, provider_id, model_id, parameters_json, prompt_version, temp_file, content_hash, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
        String(fields.snapshotId), fields.documentId || null, fields.documentPath || null,
        fields.layerIds || "[]", fields.selectionBounds || null,
        width, height, fields.colorMode || null, fields.bitDepth ? Number(fields.bitDepth) : null,
        JSON.stringify([assetId]), fields.workflowId || null, fields.workflowVersion || null,
        fields.providerId || null, fields.modelId || null, fields.parameters || "{}",
        fields.promptVersion || null, storagePath, hash, now
      );
    }
    broadcast({ type: "asset:created", assetId, jobId: fields.jobId || null });
    return reply.code(201).send({ asset });
  });

  app.get("/v1/snapshots/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = store.raw.prepare("SELECT * FROM snapshots WHERE id=?").get(id);
    if (!row) return reply.code(404).send({ error: { code: "SNAPSHOT_NOT_FOUND", message: "快照不存在: " + id } });
    return { snapshot: row };
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
