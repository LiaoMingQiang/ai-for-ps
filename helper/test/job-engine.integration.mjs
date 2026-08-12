/* job-engine.integration: JobEngine 全链路 (场景 6/7/13/14 + 规则五/十五)
 * 前置: comfy_stub 运行在 18189 (新版, 支持 queue/interrupt/WS)
 * 用法: node test/job-engine.integration.mjs */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HELPER_DIR = path.join(__dirname, "..");
const STUB = "http://127.0.0.1:18189";
const PORT = Number(process.argv[2] || 33159);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = path.join(os.tmpdir(), "a4p-je-smoke-" + process.pid);

let failures = 0;
const check = (name, cond, extra = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"} ${name}${extra ? " — " + extra : ""}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startHelper() {
  return spawn(process.execPath, [path.join(HELPER_DIR, "dist", "index.js")], {
    env: { ...process.env, A4P_PORT: String(PORT), A4P_HELPER_DIR: DATA, A4P_COMFY_URL: STUB },
    stdio: ["ignore", "pipe", "pipe"]
  });
}

let proc = startHelper();
let helperLog = "";
proc.stderr.on("data", (d) => (helperLog += String(d)));
proc.stdout.on("data", (d) => (helperLog += String(d)));
async function waitHealth() {
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(`${BASE}/v1/health`)).ok) return true; } catch (e) { /* retry */ }
    await sleep(250);
  }
  return false;
}

async function waitJob(jobId, want, timeoutMs = 30000) {
  const t0 = Date.now();
  const auth = await getAuth();
  while (Date.now() - t0 < timeoutMs) {
    const r = await (await fetch(`${BASE}/v1/jobs/${jobId}`, { headers: auth })).json();
    if (r.job && (r.job.status === want || ["failed", "cancelled", "provider_failure", "download_failure", "retryable_writeback_failure"].includes(r.job.status))) return r.job;
    await sleep(400);
  }
  return { status: "timeout" };
}

let _auth = null;
async function getAuth() {
  if (_auth) return _auth;
  const _pair_req = await (await fetch(`${BASE}/v1/pair/request`, { method: "POST" })).json();
  const pair = await (await fetch(`${BASE}/v1/pair/confirm`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ challenge: _pair_req.challenge }) })).json();
  _auth = { Authorization: "Bearer " + pair.token, "content-type": "application/json" };
  return _auth;
}

async function createJob(extra = {}) {
  const auth = await getAuth();
  const r = await fetch(`${BASE}/v1/jobs`, {
    method: "POST", headers: auth,
    body: JSON.stringify({
      providerId: "local-comfy",
      modelId: "stub-flux1-dev.safetensors",
      inputs: { prompt: "a red apple on white background", negativePrompt: "blurry" },
      parameters: { steps: 20, cfg: 7, seed: 424242, denoise: 0.65, width: 640, height: 480 },
      sourceDocumentId: "doc-001",
      sourceDocumentName: "product.psd",
      selectionBounds: { left: 10, top: 10, right: 330, bottom: 250 },
      canvasWidth: 1024, canvasHeight: 1024,
      ...extra
    })
  });
  return { status: r.status, body: await r.json() };
}

/* 实时获取 job 的 remote_job_id (create 返回的是异步提交前的快照) */
async function liveRemoteId(jobId) {
  const auth = await getAuth();
  const r = await (await fetch(`${BASE}/v1/jobs/${jobId}`, { headers: auth })).json();
  return r.job ? r.job.remote_job_id : null;
}

async function main() {
  if (!(await waitHealth())) { console.log("[job-engine.integration] FAIL: helper not started"); proc.kill(); process.exit(1); }
  const auth = await getAuth();

  /* ---- 场景 1: 全链路 t2i -> result_ready (真实 stub 执行) ---- */
  console.log("[1] 全链路 (validate->queued->running->download->result_ready)");
  const j1 = await createJob();
  check("create 201", j1.status === 201, "status=" + j1.status);
  const job1 = j1.body.job;
  check("job status=created", job1.status === "created");
  check("snapshot fields stored", job1.source_document_id === "doc-001" && job1.canvas_width === 1024 && job1.selection_bounds_json && JSON.parse(job1.selection_bounds_json).left === 10);
  const done1 = await waitJob(job1.id, "result_ready", 40000);
  check("reaches result_ready", done1.status === "result_ready", done1.status);
  check("remote_job_id persisted", typeof done1.remote_job_id === "string" && done1.remote_job_id.startsWith("stub-"), done1.remote_job_id);
  const assets = JSON.parse(done1.result_assets_json || "[]");
  check("result assets persisted", Array.isArray(assets) && assets.length === 1, "n=" + assets.length);
  const assetResp = await fetch(`${BASE}/v1/assets/${assets[0]}`, { headers: auth });
  const assetBuf = Buffer.from(await assetResp.arrayBuffer());
  check("asset binary is PNG", assetResp.status === 200 && assetBuf[0] === 0x89 && assetBuf[1] === 0x50, "status=" + assetResp.status + " size=" + assetBuf.length);
  const jobDetail = await (await fetch(`${BASE}/v1/jobs/${job1.id}`, { headers: auth })).json();
  const eventChain = (jobDetail.events || []).map((e) => e.to_status);
  check("event chain complete", ["validating", "snapshotting", "queued", "running", "downloading", "result_ready"].every((s) => eventChain.includes(s)), eventChain.join("->"));
  check("no duplicate submit in events", eventChain.filter((s) => s === "queued").length === 1);

  /* ---- 场景 2: 写回成功 -> completed (规则五: 区分 AI 成功与写回成功) ---- */
  console.log("[2] writeback-ready success -> completed");
  const wb = await fetch(`${BASE}/v1/jobs/${job1.id}/writeback-ready`, {
    method: "POST", headers: auth, body: JSON.stringify({ success: true, layerId: 77, layerName: "AI Result" })
  });
  check("writeback-ready 200", wb.status === 200, "status=" + wb.status);
  const wbJob = (await wb.json()).job;
  check("completed", wbJob.status === "completed", wbJob.status);

  /* ---- 场景 3: 写回失败 -> retryable_writeback_failure (结果保留) ---- */
  console.log("[3] writeback failure -> retryable (结果不丢)");
  const j3 = await createJob();
  const done3 = await waitJob(j3.body.job.id, "result_ready", 40000);
  check("result_ready again", done3.status === "result_ready");
  const wb3 = await fetch(`${BASE}/v1/jobs/${j3.body.job.id}/writeback-ready`, {
    method: "POST", headers: auth, body: JSON.stringify({ success: false, error: "PHOTOSHOP_DOCUMENT_NOT_FOUND" })
  });
  const wb3Job = (await wb3.json()).job;
  check("retryable_writeback_failure", wb3Job.status === "retryable_writeback_failure", wb3Job.status);
  const j3Detail = await (await fetch(`${BASE}/v1/jobs/${j3.body.job.id}`, { headers: auth })).json();
  check("result assets kept after wb failure", (JSON.parse(j3Detail.job.result_assets_json || "[]")).length === 1);
  /* retry writeback: 重新标记成功 */
  const wb3b = await fetch(`${BASE}/v1/jobs/${j3.body.job.id}/writeback-ready`, {
    method: "POST", headers: auth, body: JSON.stringify({ success: true, layerName: "AI Result v2" })
  });
  check("retry writeback -> completed", (await wb3b.json()).job.status === "completed");

  /* ---- 场景 4: 取消 queued (场景 13: 不 interrupt 其他任务) ---- */
  console.log("[4] cancel queued job (不影响 running)");
  const j4a = await createJob();
  /* 等 j4a 进入 stub running 队列 (显式顺序: 保证 j4b 一定是 queued) */
  let j4aRunning = false;
  for (let i = 0; i < 25; i++) {
    await sleep(200);
    const rid = await liveRemoteId(j4a.body.job.id);
    if (!rid) continue;
    const q = await fetch(`${STUB}/queue`).then((r) => r.json());
    if ((q.queue_running || []).some((x) => x[1] === rid)) { j4aRunning = true; break; }
  }
  check("j4a is running on stub", j4aRunning);
  const j4b = await createJob();
  let j4bPending = false;
  let j4bRemote = null;
  for (let i = 0; i < 25; i++) {
    await sleep(200);
    j4bRemote = await liveRemoteId(j4b.body.job.id);
    if (!j4bRemote) continue;
    const q = await fetch(`${STUB}/queue`).then((r) => r.json());
    if ((q.queue_pending || []).some((x) => x[1] === j4bRemote)) { j4bPending = true; break; }
  }
  check("j4b is pending (queued)", j4bPending, "remote=" + j4bRemote + " pending=" + JSON.stringify((await fetch(`${STUB}/queue`).then((r) => r.json())).queue_pending || []).slice(0, 150));
  const c4 = await fetch(`${BASE}/v1/jobs/${j4b.body.job.id}/cancel`, { method: "POST", headers: auth });
  check("cancel queued 200", c4.status === 200, "status=" + c4.status + " body=" + JSON.stringify(await c4.clone().json()).slice(0, 150));
  /* cancel 返回后立即检查: j4a (running) 必须未被 interrupt */
  const qAfter = await fetch(`${STUB}/queue`).then((r) => r.json());
  const j4aRemote = await liveRemoteId(j4a.body.job.id);
  const qAfterRunning = (qAfter.queue_running || []).map((x) => x[1]);
  check("running job untouched by cancel", qAfterRunning.includes(j4aRemote), "running=" + JSON.stringify(qAfterRunning) + " j4a=" + j4aRemote);
  const c4Done = await waitJob(j4b.body.job.id, "cancelled", 15000);
  check("queued job -> cancelled", c4Done.status === "cancelled", c4Done.status);
  await waitJob(j4a.body.job.id, "result_ready", 40000);

  /* ---- 场景 5: 取消 running (场景 14) ---- */
  console.log("[5] cancel running job");
  const j5 = await createJob();
  await sleep(800);
  const c5 = await fetch(`${BASE}/v1/jobs/${j5.body.job.id}/cancel`, { method: "POST", headers: auth });
  const c5Job = (await c5.json()).job;
  check("cancel running accepted", c5Job.status === "cancel_requested" || c5Job.status === "cancelled", c5Job.status);
  const c5Done = await waitJob(j5.body.job.id, "cancelled", 15000);
  check("running job -> cancelled", c5Done.status === "cancelled", c5Done.status);

  /* ---- 场景 6: Helper 重启恢复 (场景 7: remoteId 保留, 不重新 submit) ---- */
  console.log("[6] helper restart recovery (不重新 submit)");
  const j6 = await createJob();
  await sleep(500); /* 已提交, 运行中 */
  const j6Before = await (await fetch(`${BASE}/v1/jobs/${j6.body.job.id}`, { headers: auth })).json();
  const remoteId6 = j6Before.job.remote_job_id;
  check("remoteId present before restart", typeof remoteId6 === "string" && remoteId6.startsWith("stub-"), remoteId6);
  proc.kill();
  await sleep(800);
  helperLog = "";
  proc = startHelper();
  proc.stderr.on("data", (d) => (helperLog += String(d)));
  proc.stdout.on("data", (d) => (helperLog += String(d)));
  if (!(await waitHealth())) { console.log("  FAIL: helper restart"); failures++; }
  else {
    /* 诊断: 重启后立即查看 j6 状态 (recoverAll 500ms 后触发) */
    await sleep(2500);
    const j6AfterStart = await (await fetch(`${BASE}/v1/jobs/${j6.body.job.id}`, { headers: auth })).json();
    const rec = await waitJob(j6.body.job.id, "result_ready", 40000);
    check("recovered to result_ready", rec.status === "result_ready", rec.status + " | afterStart=" + (j6AfterStart.job ? j6AfterStart.job.status : "no-job") + " | events=" + (j6AfterStart.events || []).map((e) => e.to_status).join(",") + " | helperLog=" + helperLog.slice(-400));
    check("remoteId preserved (same)", rec.remote_job_id === remoteId6, rec.remote_job_id + " vs " + remoteId6);
    /* stub history 里该 prompt 只有一个执行 (无重复提交) */
    const hist = await fetch(`${STUB}/history`).then((r) => r.json());
    check("no duplicate remote execution", !!hist[remoteId6] && hist[remoteId6].status.completed === true);
  }

  console.log(failures === 0 ? "[job-engine.integration] ALL PASS" : `[job-engine.integration] ${failures} FAILURE(S)`);
  try { proc.kill(); } catch (e) { /* noop */ }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("[job-engine.integration] ERR", e); try { proc.kill(); } catch (e2) { /* noop */ } process.exit(1); });
