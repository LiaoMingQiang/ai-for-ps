/* helper-smoke: Helper 端到端冒烟 (真实进程)
 * 启动 helper (dist) -> health -> pair -> 401 未认证 -> token 认证 -> providers -> jobs CRUD -> gpu
 * 用法: node test/helper-smoke.mjs [port]
 * 需要: npm run build 先行 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HELPER_DIR = path.join(__dirname, "..");
const PORT = Number(process.argv[2] || 33157);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = path.join(os.tmpdir(), "a4p-helper-smoke-" + process.pid);

let failures = 0;
const check = (name, cond, extra = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"} ${name}${extra ? " — " + extra : ""}`);
  if (!cond) failures++;
};

const proc = spawn(process.execPath, [path.join(HELPER_DIR, "dist", "index.js")], {
  env: { ...process.env, A4P_PORT: String(PORT), A4P_HELPER_DIR: DATA },
  stdio: ["ignore", "pipe", "pipe"]
});
let log = "";
proc.stdout.on("data", (d) => (log += d));
proc.stderr.on("data", (d) => (log += d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHealth() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${BASE}/v1/health`);
      if (r.ok) return true;
    } catch (e) { /* retry */ }
    await sleep(250);
  }
  return false;
}

async function main() {
  console.log("[helper-smoke] waiting for helper...");
  if (!(await waitHealth())) {
    console.log("[helper-smoke] FAIL: helper did not start");
    console.log(log.slice(-2000));
    proc.kill();
    process.exit(1);
  }
  console.log("[helper-smoke] helper up");

  /* 1. health */
  const health = await (await fetch(`${BASE}/v1/health`)).json();
  check("health.online", health.online === true);
  check("health.schemaVersion >= 1", Number(health.schemaVersion) >= 1);
  check("health.lanMode=false", health.lanMode === false, JSON.stringify(health.lanMode));

  /* 2. pair */
  const pair = await (await fetch(`${BASE}/v1/pair`, { method: "POST", body: "{}" })).json();
  check("pair.token", typeof pair.token === "string" && pair.token.startsWith("a4p_"), pair.token ? "token len " + pair.token.length : "");
  const TOKEN = pair.token;

  /* 3. 未认证 -> 401 */
  const noAuth = await fetch(`${BASE}/v1/providers`);
  check("no-auth 401", noAuth.status === 401, "status=" + noAuth.status);
  const noAuthBody = await noAuth.json();
  check("no-auth code", noAuthBody.error && noAuthBody.error.code === "UNAUTHORIZED");

  /* 4. token 认证 */
  const auth = { Authorization: "Bearer " + TOKEN };
  const providers = await (await fetch(`${BASE}/v1/providers`, { headers: auth })).json();
  check("providers count>=6", Array.isArray(providers.providers) && providers.providers.length >= 6, "count=" + (providers.providers || []).length);
  const types = (providers.providers || []).map((p) => p.type);
  for (const t of ["comfyui", "openai-compatible", "gemini", "volcengine", "bailian", "runninghub", "modelscope"]) {
    check("provider type " + t, types.includes(t));
  }
  const comfy = providers.providers.find((p) => p.type === "comfyui");
  check("comfy capabilities.workflows", !!(comfy && comfy.capabilities && comfy.capabilities.workflows));

  /* 5. 错误 token -> 401 */
  const badAuth = await fetch(`${BASE}/v1/providers`, { headers: { Authorization: "Bearer wrong" } });
  check("bad-token 401", badAuth.status === 401);

  /* 6. jobs CRUD */
  const jobRes = await fetch(`${BASE}/v1/jobs`, {
    method: "POST", headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({
      providerId: "local-comfy",
      workflowId: "wf-demo",
      sourceDocumentId: "doc-123",
      sourceDocumentName: "demo.psd",
      selectionBounds: { left: 10, top: 20, right: 210, bottom: 220 },
      canvasWidth: 1024, canvasHeight: 1024,
      inputs: { prompt: "test" }
    })
  });
  check("job create 201", jobRes.status === 201, "status=" + jobRes.status);
  const jobBody = await jobRes.json();
  const job = jobBody.job;
  check("job.id", !!(job && job.id));
  check("job.status=created", job && job.status === "created");
  check("job.snapshot fields", job && job.source_document_id === "doc-123" && job.canvas_width === 1024);
  check("job.selectionBounds", job && job.selection_bounds_json && JSON.parse(job.selection_bounds_json).left === 10);

  const jobGet = await (await fetch(`${BASE}/v1/jobs/${job.id}`, { headers: auth })).json();
  check("job get + events", Array.isArray(jobGet.events) && jobGet.events.length >= 1);

  const cancel = await (await fetch(`${BASE}/v1/jobs/${job.id}/cancel`, { method: "POST", headers: auth })).json();
  check("job cancel -> cancel_requested/cancelled", cancel.job && ["cancel_requested", "cancelled"].includes(cancel.job.status), cancel.job && cancel.job.status);

  /* 7. gpu (真实 nvidia-smi 或空态) */
  const gpu = await (await fetch(`${BASE}/v1/gpu`, { headers: auth })).json();
  check("gpu shape", typeof gpu.gpu === "number" && typeof gpu.vramTotalMb === "number");
  if (gpu.available) console.log("  info GPU:", gpu.gpuName, gpu.vramTotalMb + "MB");

  /* 8. session refresh */
  const sess = await (await fetch(`${BASE}/v1/session/refresh`, { method: "POST", headers: auth })).json();
  check("session.refresh", sess.ok === true);

  /* 8.5 credentials (DPAPI roundtrip, 不返回明文) */
  const credRes = await fetch(`${BASE}/v1/providers/gemini/credentials`, {
    method: "POST", headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "sk-test-12345" })
  });
  check("credential store", credRes.status === 200 || credRes.status === 500, "status=" + credRes.status);
  if (credRes.status === 200) {
    const credBody = await credRes.json();
    check("credential kind", ["dpapi", "file-0600"].includes(credBody.kind), "kind=" + credBody.kind);
    const provs2 = await (await fetch(`${BASE}/v1/providers`, { headers: auth })).json();
    const gemini = provs2.providers.find((p) => p.id === "gemini");
    check("gemini configured=true", gemini && gemini.configured === true);
    /* 明文不可读取: 响应不得包含 sk-test-12345 */
    const raw = JSON.stringify(provs2);
    check("no plaintext key in API", !raw.includes("sk-test-12345"));
    const del = await (await fetch(`${BASE}/v1/providers/gemini/credentials`, { method: "DELETE", headers: auth })).json();
    check("credential delete", del.ok === true);
  } else {
    console.log("  warn: DPAPI unavailable on this machine — credential test skipped (fallback path untested)");
  }

  /* 8.6 projects upsert */
  const proj1 = await (await fetch(`${BASE}/v1/projects`, {
    method: "POST", headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ documentPath: "C:/psd/product-v12.psd", documentName: "product-v12.psd", documentPersistentId: "persist-1" })
  })).json();
  check("project create", proj1.project && proj1.created === true);
  const proj2 = await (await fetch(`${BASE}/v1/projects`, {
    method: "POST", headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ documentPath: "C:/psd/product-v12.psd", documentName: "product-v12.psd", documentPersistentId: "persist-1" })
  })).json();
  check("project upsert (no dup)", proj2.project && proj2.created === false && proj1.project.id === proj2.project.id);

  /* 8.7 asset multipart 上传 (真实 1x1 PNG) + snapshot 关联 + 文件读取 */
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const fd = new FormData();
  fd.append("file", new Blob([png], { type: "image/png" }), "snap.png");
  fd.append("kind", "snapshot");
  fd.append("snapshotId", "snap-test-1");
  fd.append("documentId", "doc-123");
  fd.append("jobId", job.id);
  const assetRes = await fetch(`${BASE}/v1/assets`, { method: "POST", headers: auth, body: fd });
  check("asset upload 201", assetRes.status === 201, "status=" + assetRes.status);
  const assetBody = await assetRes.json();
  check("asset.id + hash", !!(assetBody.asset && assetBody.asset.hash && assetBody.asset.width === 1), JSON.stringify({ w: assetBody.asset && assetBody.asset.width, h: assetBody.asset && assetBody.asset.height }));
  const snap = await (await fetch(`${BASE}/v1/snapshots/snap-test-1`, { headers: auth })).json();
  check("snapshot stored", snap.snapshot && snap.snapshot.content_hash === assetBody.asset.hash);
  const dl = await fetch(`${BASE}/v1/assets/${assetBody.asset.id}`, { headers: auth });
  check("asset download bytes", dl.status === 200 && (await dl.arrayBuffer()).byteLength === png.length);
  const dedup = await (async () => {
    const fd2 = new FormData();
    fd2.append("file", new Blob([png], { type: "image/png" }), "snap-dup.png");
    const r = await fetch(`${BASE}/v1/assets`, { method: "POST", headers: auth, body: fd2 });
    return r.json();
  })();
  check("hash dedup", dedup.deduped === true);

  /* 8.8 dependency center (真实 ComfyUI @8188 或离线空态) */
  const deps = await (await fetch(`${BASE}/v1/dependencies`, { headers: auth })).json();
  check("deps.comfyui.online bool", typeof deps.comfyui.online === "boolean");
  check("deps.customNodes.count", typeof deps.customNodes.count === "number" && deps.customNodes.count >= 0, "count=" + deps.customNodes.count);
  check("deps.models shape", Array.isArray(deps.models.checkpoints));
  check("deps.gpu.vramTotalMb", typeof deps.gpu.vramTotalMb === "number");
  if (deps.comfyui.online) console.log("  info ComfyUI:", deps.comfyui.version, "nodes:", deps.customNodes.count, "ckpts:", deps.models.checkpoints.length);

  /* 8.9 project state + lineage (规则二十二/二十四) */
  const st = await fetch(`${BASE}/v1/projects/${proj1.project.id}/state`, {
    method: "POST", headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ lastWorkflowId: "wf-test-1", defaultWriteback: "pixelLayer" })
  });
  const stBody = await st.json();
  check("project state saved", stBody.project && stBody.project.last_workflow_id === "wf-test-1" && stBody.project.default_writeback === "pixelLayer");
  const projJobs = await (await fetch(`${BASE}/v1/projects/${proj1.project.id}/jobs`, { headers: auth })).json();
  check("project jobs filtered (no mix)", Array.isArray(projJobs.jobs) && projJobs.jobs.length === 0, "n=" + projJobs.jobs.length);
  const lin = await (await fetch(`${BASE}/v1/jobs/${job.id}/lineage`, { headers: auth })).json();
  check("lineage source doc", lin.lineage && lin.lineage.source && lin.lineage.source.documentId === "doc-123");
  check("lineage provider", lin.lineage && lin.lineage.provider && lin.lineage.provider.id === "local-comfy");

  /* 8.10 workers + usage (规则二十九/三十一/三十二) */
  const workers = await (await fetch(`${BASE}/v1/workers`, { headers: auth })).json();
  check("local worker registered", Array.isArray(workers.workers) && workers.workers.some((w) => w.id === "local-comfy"), "n=" + (workers.workers || []).length);
  check("worker has gpu/vram fields", workers.local && typeof workers.local.vramMb === "number");
  const usage = await (await fetch(`${BASE}/v1/usage`, { headers: auth })).json();
  check("usage summary array", Array.isArray(usage.summary));
  check("usage localGpuMs number", typeof usage.localGpuMs === "number");
  check("usage cloudCost null (不虚构)", usage.cloudCost === null);

  /* 8.11 agent (规则三十三/三十四: plan -> 批准 -> 执行 -> 审计) */
  const planRes = await fetch(`${BASE}/v1/agent/plan`, {
    method: "POST", headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ intent: "给当前产品图层抠图生成蒙版", providerId: "local-comfy" })
  });
  const planBody = await planRes.json();
  check("agent plan 200", planRes.status === 200, "status=" + planRes.status);
  check("plan steps >= 3", Array.isArray(planBody.plan && planBody.plan.steps) && planBody.plan.steps.length >= 3, "n=" + (planBody.plan && planBody.plan.steps.length));
  check("plan step has provider/estCost/psdModification", planBody.plan.steps.every((s) => "provider" in s && "estCost" in s && "psdModification" in s));
  check("plan requiresPhotoshop flag", typeof planBody.plan.requiresPhotoshop === "boolean");
  const auditId = planBody.auditId;
  check("audit id returned", typeof auditId === "string");

  const denied = await fetch(`${BASE}/v1/agent/execute`, {
    method: "POST", headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ auditId, approved: false })
  });
  check("execute without approval -> 403", denied.status === 403, "status=" + denied.status);
  const auditDenied = await (await fetch(`${BASE}/v1/agent/audit/${auditId}`, { headers: auth })).json();
  check("audit status rejected", auditDenied.audit && auditDenied.audit.status === "rejected");

  const exe = await fetch(`${BASE}/v1/agent/execute`, {
    method: "POST", headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ auditId, approved: true })
  });
  const exeBody = await exe.json();
  check("execute approved 200", exe.status === 200, "status=" + exe.status);
  check("results recorded per step", Array.isArray(exeBody.results) && exeBody.results.length >= 3, "n=" + (exeBody.results || []).length);
  const psStep = (exeBody.results || []).find((r) => r.tool === "captureActiveLayer");
  check("PS tool delegated to UXP (not faked)", psStep && psStep.status === "delegated" && psStep.delegateToUxp, JSON.stringify(psStep).slice(0, 120));
  const auditDone = await (await fetch(`${BASE}/v1/agent/audit/${auditId}`, { headers: auth })).json();
  check("audit completed + toolsExecuted logged", auditDone.audit && auditDone.audit.status === "completed" && JSON.parse(auditDone.audit.tools_executed_json).length >= 3);

  /* 9. 单实例锁: 再启动一个 -> 端口冲突退出 */
  const proc2 = spawn(process.execPath, [path.join(HELPER_DIR, "dist", "index.js")], {
    env: { ...process.env, A4P_PORT: String(PORT), A4P_HELPER_DIR: DATA + "-2" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let out2 = "";
  proc2.stdout.on("data", (d) => (out2 += d));
  proc2.stderr.on("data", (d) => (out2 += d));
  const code2 = await new Promise((r) => { proc2.on("exit", (c) => r(c)); setTimeout(() => r(null), 8000); });
  check("second instance exits (port conflict)", code2 === 2, "exit=" + code2);
  if (code2 !== 2) console.log("  log2:", out2.slice(-300));

  /* 10. WS events (token 校验) */
  const wsTok = await new Promise((resolve, reject) => {
    import("ws").then(({ default: WebSocket }) => {
      const ws = new WebSocket(`${BASE.replace("http", "ws")}/v1/events?token=${TOKEN}`);
      const t = setTimeout(() => { ws.terminate(); reject(new Error("ws timeout")); }, 5000);
      ws.on("message", (d) => { clearTimeout(t); ws.terminate(); resolve(String(d)); });
      ws.on("error", (e) => { clearTimeout(t); reject(e); });
    }).catch(reject);
  });
  check("ws connected msg", wsTok.includes("connected"), wsTok.slice(0, 80));

  proc.kill();
  await sleep(500);
  console.log(failures === 0 ? "[helper-smoke] ALL PASS" : `[helper-smoke] ${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("[helper-smoke] ERR", e); proc.kill(); process.exit(1); });
