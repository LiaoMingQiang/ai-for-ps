#!/usr/bin/env node
/* e2e-core: 真实管线端到端测试 —— 直接加载生产代码 js/core/comfyui.js，
 * 对 test/comfy_stub.py 桩服务器执行全部真实调用并断言结果。
 * 用法: node test/e2e-core.mjs [port=18188] [base=http://127.0.0.1:18188]
 * 前置: python3 test/comfy_stub.py --port 18188 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PORT = process.argv[2] || "18188";
const BASE = process.argv[3] || `http://127.0.0.1:${PORT}`;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
function ok(cond, label, extra) {
  if (cond) console.log("  PASS  " + label);
  else { failures++; console.log("  FAIL  " + label + (extra ? " :: " + extra : "")); }
}

/* ---- 沙箱：加载生产 comfyui.js ---- */
globalThis.A4P = {
  settings: {
    get: (section, key) => (section === "connection" && key === "comfyuiUrl" ? BASE : null)
  },
  utils: {},
  comfyui: {}
};
const src = fs.readFileSync(path.join(root, "uxp-plugin", "js", "core", "comfyui.js"), "utf8");
eval(src);
const C = globalThis.A4P.comfyui;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function pngBytes(bytes) {
  return bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
}

async function main() {
  console.log(`[e2e-core] base=${BASE}`);

  /* 1. ping */
  console.log("[1] ping /system_stats");
  const st = await C.ping();
  ok(st.ok === true, "ping ok");
  ok(/stub/.test(st.version || ""), "version from stub", JSON.stringify(st.version));
  ok(st.vram > 0, "vram present", String(st.vram));

  /* 2. listCheckpoints */
  console.log("[2] listCheckpoints");
  const ck = await C.listCheckpoints();
  ok(Array.isArray(ck) && ck.length >= 2, "checkpoint list real", JSON.stringify(ck));

  /* 3. upload */
  console.log("[3] uploadImage");
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const blob = new Blob([png], { type: "image/png" });
  const up = await C.uploadImage(blob, "e2e-input.png");
  ok(up && up.name === "e2e-input.png", "upload echoed", JSON.stringify(up));

  /* 4. buildWorkflow + submit (t2i) */
  console.log("[4] buildWorkflow t2i + submit");
  const wf = C.buildWorkflow({
    prompt: "a red chair on white background",
    negative: "blur",
    params: { denoise: 1, cfg: 4.5, steps: 20, seed: 42, size: "1024 × 1024", sampler: "euler", scheduler: "normal" },
    inputImage: null,
    checkpoint: "stub-flux1-dev.safetensors"
  });
  ok(!!wf["9"] && wf["9"].class_type === "SaveImage", "workflow has SaveImage");
  const sub = await C.submitWorkflow(wf);
  ok(!!sub.promptId, "prompt_id", sub.promptId || "none");

  /* 5. i2i upload + buildWorkflow i2i + submit */
  console.log("[5] buildWorkflow i2i + submit");
  const up2 = await C.uploadImage(blob, "e2i-input.png");
  const wf2 = C.buildWorkflow({
    prompt: "keep structure, change lighting",
    params: { denoise: 0.35, cfg: 4, steps: 18, size: "768 × 1024" },
    inputImage: { name: up2.name, upload: up2 },
    checkpoint: "stub-flux1-dev.safetensors"
  });
  ok(!!wf2["1"] && wf2["1"].class_type === "LoadImage", "i2i workflow LoadImage");
  const sub2 = await C.submitWorkflow(wf2);
  ok(!!sub2.promptId, "i2i prompt_id", sub2.promptId || "none");

  /* 6. connectProgress -> done */
  console.log("[6] connectProgress (t2i, polling fallback)");
  const hist = await new Promise((resolve, reject) => {
    const stop = C.connectProgress(sub.promptId,
      () => {},
      (h) => { stop(); resolve(h); },
      (e) => { stop(); reject(e); },
      15000
    );
  });
  ok(!!hist && hist.status.status_str === "success", "history success");

  /* 7. outputs + downloadImage PNG 校验 */
  console.log("[7] downloadImage");
  let images = [];
  Object.values(hist.outputs || {}).forEach((v) => { if (v && v.images) images = images.concat(v.images); });
  ok(images.length >= 1, "output images found", images.length + " image(s)");
  const d = await C.downloadImage(images[0]);
  ok(pngBytes(new Uint8Array(d.bytes)), "downloaded bytes are real PNG");
  ok(typeof d.url === "string" && d.url.length > 20, "object/data URL ready");
  ok(d.filename.indexOf(".png") > 0, "filename", d.filename);

  /* 8. node_errors 拒绝（错误工作流） */
  console.log("[8] node_errors rejection");
  const badWf = { "1": { class_type: "NoSuchNodeStub", inputs: {} } };
  let rejected = false;
  try { await C.submitWorkflow(badWf); } catch (e) { rejected = e && e.code === "COMFY_NODE_ERROR"; }
  ok(rejected, "unknown node -> COMFY_NODE_ERROR");

  console.log(failures ? `\n[e2e-core] ${failures} FAILURE(S)` : "\n[e2e-core] ALL PASS");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error("[e2e-core] fatal", e); process.exit(2); });