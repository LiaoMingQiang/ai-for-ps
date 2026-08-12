/* workflow.integration: Workflow 导入/扫描/Studio/版本 (场景 11/12/17)
 * 自托管 helper 进程 (需先 npm run build)
 * 用法: node test/workflow.integration.mjs */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HELPER_DIR = path.join(__dirname, "..");
const PORT = Number(process.argv[2] || 33158);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = path.join(os.tmpdir(), "a4p-wf-smoke-" + process.pid);

const proc = spawn(process.execPath, [path.join(HELPER_DIR, "dist", "index.js")], {
  env: { ...process.env, A4P_PORT: String(PORT), A4P_HELPER_DIR: DATA },
  stdio: ["ignore", "pipe", "pipe"]
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitHealth() {
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(`${BASE}/v1/health`)).ok) return true; } catch (e) { /* retry */ }
    await sleep(250);
  }
  return false;
}

let failures = 0;
const check = (name, cond, extra = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"} ${name}${extra ? " — " + extra : ""}`);
  if (!cond) failures++;
};

/* 标准 ComfyUI API workflow (场景 11 要求的所有字段) */
const SAMPLE_WF = {
  "3": { class_type: "KSampler", inputs: { seed: 123456789, steps: 20, cfg: 7, sampler_name: "euler", scheduler: "normal", denoise: 0.25, model: ["4", 0], positive: ["6", 0], negative: ["7", 0], latent_image: ["5", 0] } },
  "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "flux1-dev-fp8.safetensors" } },
  "5": { class_type: "EmptyLatentImage", inputs: { width: 1024, height: 1024, batch_size: 1 } },
  "6": { class_type: "CLIPTextEncode", inputs: { text: "professional product photo", clip: ["4", 1] } },
  "7": { class_type: "CLIPTextEncode", inputs: { text: "blurry, low quality", clip: ["4", 1] } },
  "8": { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["4", 2] } },
  "9": { class_type: "SaveImage", inputs: { images: ["8", 0], filename_prefix: "aiforps" } },
  "10": { class_type: "LoadImage", inputs: { image: "input.png" } },
  "11": { class_type: "LoadImageMask", inputs: { mask: "mask.png" } },
  "12": { class_type: "LoraLoader", inputs: { lora_name: "product_detail_v3.safetensors", strength_model: 0.8, strength_clip: 0.8, model: ["4", 0], clip: ["4", 1] } }
};

async function main() {
  if (!(await waitHealth())) {
    console.log("[workflow.integration] FAIL: helper did not start");
    proc.kill();
    process.exit(1);
  }
  /* 0. token */
  const _pair_req = await (await fetch(`${BASE}/v1/pair/request`, { method: "POST" })).json();
  const pair = await (await fetch(`${BASE}/v1/pair/confirm`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ challenge: _pair_req.challenge }) })).json();
  const auth = { Authorization: "Bearer " + pair.token, "content-type": "application/json" };

  /* 1. 导入 (场景 11: 识别全部标准字段) */
  const imp = await fetch(`${BASE}/v1/workflows/import`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ name: "product-cleanup-test", json: SAMPLE_WF, category: "产品", author: "test" })
  });
  check("import 201", imp.status === 201, "status=" + imp.status);
  const impBody = await imp.json();
  check("import workflowId", typeof impBody.workflowId === "string" && impBody.workflowId.startsWith("wf_"), impBody.workflowId);
  check("import version 1.0.0", impBody.version === "1.0.0");
  const fields = impBody.fields || [];
  const types = fields.map((f) => f.fieldType);
  const semantics = fields.map((f) => f.semantic);
  check("field: Prompt", semantics.includes("prompt"));
  check("field: Model (checkpoint)", semantics.includes("model"));
  check("field: Seed", semantics.includes("seed"));
  check("field: Steps/CFG (sampler)", semantics.includes("sampler") && fields.some((f) => f.inputKey === "steps"));
  check("field: Denoise", fields.some((f) => f.inputKey === "denoise" && f.fieldType === "FLOAT"));
  check("field: Width/Height (size)", semantics.includes("size") && fields.some((f) => f.inputKey === "width"));
  check("field: Image", semantics.includes("image"));
  check("field: Mask", semantics.includes("mask"));
  check("field: LoRA", semantics.includes("lora"));
  check("field: Sampler/Scheduler (ENUM-ish)", fields.some((f) => f.inputKey === "sampler_name" && f.fieldType === "SAMPLER") && fields.some((f) => f.inputKey === "scheduler" && f.fieldType === "SCHEDULER"));
  check("output node detected", impBody.outputNodes && impBody.outputNodes.length >= 1 && impBody.outputNodes[0].classType === "SaveImage");

  /* 2. 数据库持久化 */
  const wf = await (await fetch(`${BASE}/v1/workflows/${impBody.workflowId}`, { headers: auth })).json();
  check("db: bindings persisted", Array.isArray(wf.bindings) && wf.bindings.length >= 8, "bindings=" + wf.bindings.length);
  check("db: versions persisted", Array.isArray(wf.versions) && wf.versions.length === 1);
  check("db: dependency checkpoint", wf.bindings.some((b) => b.field_key === "ckpt_name"));

  /* 3. 依赖检查 (ComfyUI 8188 在线则 matched) */
  const deps = await (await fetch(`${BASE}/v1/workflows/${impBody.workflowId}/dependencies`, { headers: auth })).json();
  check("dependencies reported", Array.isArray(deps.dependencies) && deps.dependencies.length >= 2, "n=" + deps.dependencies.length + " kinds=" + deps.dependencies.map((d) => d.kind).join(","));

  /* 4. Studio 修改 denoise -> 保存新版本 (场景 12: 真实 JSON 字段变化) */
  const wfJson = JSON.parse(JSON.stringify(SAMPLE_WF));
  wfJson["3"].inputs.denoise = 0.55;  /* Studio 改 Denoise */
  const upd = await fetch(`${BASE}/v1/workflows/${impBody.workflowId}/bindings`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ json: wfJson, changelog: "denoise 0.25 -> 0.55", author: "test" })
  });
  check("version save", upd.status === 200, "status=" + upd.status);
  const updBody = await upd.json();
  check("new version 1.1.0", updBody.version === "1.1.0", updBody.version);

  /* 场景 12 核心: 运行 Job 时使用保存的 workflow JSON, denoise 必须已变化 */
  const wf2 = await (await fetch(`${BASE}/v1/workflows/${impBody.workflowId}`, { headers: auth })).json();
  check("version history: 2 versions (不覆盖旧版)", wf2.versions.length === 2, "n=" + wf2.versions.length);
  check("versions ordered", wf2.versions[0].version === "1.1.0" && wf2.versions[1].version === "1.0.0");
  const storedHash = wf2.versions[0].workflow_json_hash;
  const crypto = await import("node:crypto");
  const expectHash = crypto.createHash("sha256").update(JSON.stringify(wfJson)).digest("hex");
  check("workflow_json_hash matches modified json", storedHash === expectHash);

  /* 5. 坏 JSON -> 明确报错 (不假成功) */
  const bad = await fetch(`${BASE}/v1/workflows/import`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ name: "bad", json: { "1": { inputs: {} } } })
  });
  check("bad json -> 400 + code", bad.status === 400, "status=" + bad.status);
  const badBody = await bad.json();
  check("bad json -> WORKFLOW_INVALID", badBody.error && badBody.error.code === "WORKFLOW_INVALID", badBody.error && badBody.error.code);

  const noOutput = await fetch(`${BASE}/v1/workflows/import`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ name: "no-out", json: { "1": { class_type: "KSampler", inputs: { steps: 5 } } } })
  });
  const noOutBody = await noOutput.json();
  check("no output node -> WORKFLOW_NO_OUTPUT", noOutBody.error && noOutBody.error.code === "WORKFLOW_NO_OUTPUT", noOutBody.error && noOutBody.error.code);

  /* 6. UI 格式导入 */
  const uiWf = {
    nodes: [
      { id: 1, type: "CheckpointLoaderSimple", widgets_values: ["sdxl.safetensors"] },
      { id: 2, type: "CLIPTextEncode", widgets_values: ["a red apple"], inputs: { clip: { link: 1 } } },
      { id: 3, type: "KSampler", widgets_values: [12345, 25, 8, "euler", "karras", 0.5], inputs: { model: { link: 1 }, positive: { link: 2 } } },
      { id: 4, type: "SaveImage", widgets_values: ["out"] }
    ],
    links: []
  };
  const uiImp = await fetch(`${BASE}/v1/workflows/import`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ name: "ui-format", json: uiWf })
  });
  check("UI format import", uiImp.status === 201, "status=" + uiImp.status);

  console.log(failures === 0 ? "[workflow.integration] ALL PASS" : `[workflow.integration] ${failures} FAILURE(S)`);
  proc.kill();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("[workflow.integration] ERR", e); process.exit(1); });
