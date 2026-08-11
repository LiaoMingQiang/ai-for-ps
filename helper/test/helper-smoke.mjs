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
  check("job cancel->cancel_requested", cancel.job && cancel.job.status === "cancel_requested");

  /* 7. gpu (真实 nvidia-smi 或空态) */
  const gpu = await (await fetch(`${BASE}/v1/gpu`, { headers: auth })).json();
  check("gpu shape", typeof gpu.gpu === "number" && typeof gpu.vramTotalMb === "number");
  if (gpu.available) console.log("  info GPU:", gpu.gpuName, gpu.vramTotalMb + "MB");

  /* 8. session refresh */
  const sess = await (await fetch(`${BASE}/v1/session/refresh`, { method: "POST", headers: auth })).json();
  check("session.refresh", sess.ok === true);

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
