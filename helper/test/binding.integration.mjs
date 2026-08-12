/* binding.integration: PHASE 10 — Workflow Binding 真实应用到提交的 ComfyUI JSON
 * 链路: 导入 workflow (KSampler denoise=0.25) -> 保存 binding -> 创建 Job (denoise=0.42)
 *       -> stub 收到的 workflow JSON 中 node "3".inputs.denoise === 0.42
 * 并且: Helper 重启后 workflow/version/bindings 持久存在, 再次提交仍应用 binding。
 * 用法: node test/binding.integration.mjs  (需 stub @18189 运行) */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HELPER_DIR = path.join(__dirname, "..");
const PORT = Number(process.argv[2] || 33160);
const BASE = `http://127.0.0.1:${PORT}`;
const STUB = "http://127.0.0.1:18189";
const DATA = path.join(os.tmpdir(), "a4p-binding-" + process.pid);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, cond, extra = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"} ${name}${extra ? " — " + extra : ""}`);
  if (!cond) failures++;
};

function startHelper() {
  return spawn(process.execPath, [path.join(HELPER_DIR, "dist", "index.js")], {
    env: { ...process.env, A4P_PORT: String(PORT), A4P_HELPER_DIR: DATA, A4P_COMFY_URL: STUB },
    stdio: ["ignore", "pipe", "pipe"]
  });
}
let proc = startHelper();
async function waitHealth() {
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(`${BASE}/v1/health`)).ok) return true; } catch (e) { /* retry */ }
    await sleep(250);
  }
  return false;
}

/* 标准节点 workflow (stub KNOWN 节点集), KSampler denoise=0.25 */
const BINDING_WF = {
  "3": { class_type: "KSampler", inputs: { seed: 123456789, steps: 20, cfg: 7, sampler_name: "euler", scheduler: "normal", denoise: 0.25, model: ["4", 0], positive: ["6", 0], negative: ["7", 0], latent_image: ["5", 0] } },
  "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "stub-flux1-dev.safetensors" } },
  "5": { class_type: "EmptyLatentImage", inputs: { width: 640, height: 480, batch_size: 1 } },
  "6": { class_type: "CLIPTextEncode", inputs: { text: "professional product photo", clip: ["4", 1] } },
  "7": { class_type: "CLIPTextEncode", inputs: { text: "blurry", clip: ["4", 1] } },
  "8": { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["4", 2] } },
  "9": { class_type: "SaveImage", inputs: { images: ["8", 0], filename_prefix: "aiforps" } }
};

/* 从 stub 队列提取指定 remote_id 提交的 workflow JSON */
async function stubWorkflowOf(remoteId) {
  const q = await (await fetch(`${STUB}/queue`)).json();
  for (const row of (q.queue_running || []).concat(q.queue_pending || [])) {
    if (row[1] === remoteId) return row[2];
  }
  return null;
}

async function waitJobStatus(jobId, auth, want, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await sleep(500);
    const j = await (await fetch(`${BASE}/v1/jobs/${jobId}`, { headers: auth })).json();
    if (j.job && (j.job.status === want || ["failed", "provider_failure", "download_failure"].includes(j.job.status))) return j.job;
  }
  return null;
}

async function main() {
  if (!(await waitHealth())) { console.log("[binding.integration] FAIL: helper start"); process.exit(1); }
  const pair = await (await fetch(`${BASE}/v1/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
  const auth = { Authorization: "Bearer " + pair.token, "content-type": "application/json" };

  /* 1. 导入 workflow */
  console.log("[1] import workflow (denoise=0.25)");
  const imp = await (await fetch(`${BASE}/v1/workflows/import`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ name: "binding-test", json: BINDING_WF, author: "test" })
  })).json();
  check("import workflowId", typeof imp.workflowId === "string", imp.workflowId);
  const wfId = imp.workflowId;

  /* 2. bindings 存在 (denoise -> node 3) */
  console.log("[2] bindings present");
  const det = await (await fetch(`${BASE}/v1/workflows/${wfId}`, { headers: auth })).json();
  const denoiseBinding = (det.bindings || []).find((b) => b.input_key === "denoise");
  check("denoise binding exists", !!denoiseBinding && denoiseBinding.node_id === "3", JSON.stringify(denoiseBinding || null).slice(0, 120));
  check("version recorded", Array.isArray(det.versions) && det.versions.length >= 1 && det.versions[0].version === "1.0.0");

  /* 3. 创建 Job, parameters.denoise=0.42 */
  console.log("[3] job with denoise=0.42");
  const job = await (await fetch(`${BASE}/v1/jobs`, {
    method: "POST", headers: auth,
    body: JSON.stringify({
      providerId: "local-comfy", workflowId: wfId,
      inputs: { prompt: "binding test" },
      parameters: { denoise: 0.42, steps: 20, seed: 42 },
      sourceDocumentId: "doc-bind-1"
    })
  })).json();
  check("job created", !!job.job && !!job.job.id, JSON.stringify(job).slice(0, 100));

  /* 4. stub 收到的 workflow JSON: node 3 denoise === 0.42 (真实断言) */
  let submitted = null;
  for (let i = 0; i < 40 && !submitted; i++) {
    await sleep(300);
    const live = await (await fetch(`${BASE}/v1/jobs/${job.job.id}`, { headers: auth })).json();
    if (live.job && live.job.remote_job_id) {
      submitted = await stubWorkflowOf(live.job.remote_job_id);
    }
  }
  check("workflow submitted to stub", !!submitted, "submitted=" + !!submitted);
  const denoiseSent = submitted ? submitted["3"] && submitted["3"].inputs && submitted["3"].inputs.denoise : undefined;
  check("denoise applied in real JSON (0.25 -> 0.42)", denoiseSent === 0.42, "denoise=" + JSON.stringify(denoiseSent));

  /* 5. 任务完成 (链路未被破坏) */
  const done = await waitJobStatus(job.job.id, auth, "result_ready", 40000);
  check("job completes result_ready", !!done && done.status === "result_ready", done && done.status);

  /* 6. Helper 重启: workflow/version/bindings 持久化 */
  console.log("[4] helper restart persistence");
  proc.kill();
  await sleep(800);
  proc = startHelper();
  if (!(await waitHealth())) { check("helper restart", false, "no health"); }
  else {
    const pair2 = await (await fetch(`${BASE}/v1/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
    const auth2 = { Authorization: "Bearer " + pair2.token, "content-type": "application/json" };
    const after = await (await fetch(`${BASE}/v1/workflows/${wfId}`, { headers: auth2 })).json();
    check("workflow persists after restart", !!after.workflow && after.workflow.id === wfId, after.workflow && after.workflow.id);
    check("version persists", Array.isArray(after.versions) && after.versions.length >= 1);
    const b2 = (after.bindings || []).find((b) => b.input_key === "denoise");
    check("denoise binding persists", !!b2 && b2.node_id === "3");

    /* 7. 重启后再提交: 仍应用 binding */
    const job2 = await (await fetch(`${BASE}/v1/jobs`, {
      method: "POST", headers: auth2,
      body: JSON.stringify({ providerId: "local-comfy", workflowId: wfId, inputs: { prompt: "again" }, parameters: { denoise: 0.42 } })
    })).json();
    let submitted2 = null;
    for (let i = 0; i < 40 && !submitted2; i++) {
      await sleep(300);
      const live = await (await fetch(`${BASE}/v1/jobs/${job2.job.id}`, { headers: auth2 })).json();
      if (live.job && live.job.remote_job_id) submitted2 = await stubWorkflowOf(live.job.remote_job_id);
    }
    const d2 = submitted2 ? submitted2["3"] && submitted2["3"].inputs && submitted2["3"].inputs.denoise : undefined;
    check("binding still applied after restart", d2 === 0.42, "denoise=" + JSON.stringify(d2));
  }

  console.log(failures === 0 ? "[binding.integration] ALL PASS" : `[binding.integration] ${failures} FAILURE(S)`);
  proc.kill();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("[binding.integration] ERR", e); proc.kill(); process.exit(1); });
