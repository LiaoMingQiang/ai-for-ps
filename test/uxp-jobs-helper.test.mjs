/* uxp-jobs-helper.test: PHASE 1 验收 — UXP RemoteJobStore 真实链路
 * 在 Node 中加载真实 UXP 代码 (helper-client.js + jobs.js), 配合真实 Helper + ComfyUI stub:
 * 1) A4P.jobs.create() 必须 POST /v1/jobs (Helper), 不得调用 A4P.comfyui (旧链路调用数=0)
 * 2) 任务状态由 Helper 驱动 (镜像同步), 达到 result_ready
 * 3) localStorage 不得写入 job (规则: 不以 localStorage 为 Job Store)
 * 4) cancel/retry 走 Helper API
 * 用法: node test/uxp-jobs-helper.test.mjs  (需 stub @18189 运行) */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const UXP = path.join(ROOT, "uxp-plugin");
const HELPER = path.join(ROOT, "helper");
const STUB = "http://127.0.0.1:18189";
const PORT = 33259;
const DATA = path.join(process.env.TEMP || "/tmp", "a4p-uxp-test-" + process.pid);

let failures = 0;
const check = (name, cond, extra = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"} ${name}${extra ? " — " + extra : ""}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 记录所有 fetch 请求, 用于断言旧链路未被调用 */
const fetchLog = [];
const realFetch = globalThis.fetch;

/* ---- 启动 Helper (真实, 指向 stub ComfyUI) ---- */
const helperProc = spawn(process.execPath, [path.join(HELPER, "dist", "index.js")], {
  env: { ...process.env, A4P_PORT: String(PORT), A4P_HELPER_DIR: DATA, A4P_COMFY_URL: STUB },
  stdio: ["ignore", "pipe", "pipe"]
});
let helperLog = "";
helperProc.stderr.on("data", (d) => (helperLog += String(d)));

async function waitHealth() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/v1/health`);
      if (r.ok) return true;
    } catch (e) { /* retry */ }
    await sleep(250);
  }
  return false;
}

/* ---- 模拟 UXP 浏览器环境 ---- */
const localStorageData = {};
const sandbox = {
  console,
  fetch: async (url, opts) => {
    const u = String(url);
    fetchLog.push({ url: u, method: (opts && opts.method) || "GET" });
    return realFetch(u, opts);
  },
  FormData, Blob, URLSearchParams, WebSocket: undefined,
  URL: globalThis.URL,
  setTimeout, clearTimeout, Promise,
  window: { localStorage: { setItem: (k, v) => { localStorageData[k] = v; }, getItem: (k) => (k in localStorageData ? localStorageData[k] : null), removeItem: (k) => { delete localStorageData[k]; } }, location: { href: "http://127.0.0.1:8877/index.html" } },
  localStorage: null,
  require: function () { return {}; }
};
sandbox.window.window = sandbox.window;
vm.createContext(sandbox);

function loadUxpJs(file) {
  const src = fs.readFileSync(path.join(UXP, file), "utf8");
  vm.runInContext(src, sandbox, { filename: file });
}

/* 装配 A4P 最小环境 (与 index.html 加载顺序一致) */
function bootA4P() {
  sandbox.A4P = {};
  loadUxpJs("js/utils.js");
  loadUxpJs("js/i18n.js");
  loadUxpJs("js/state.js");
  loadUxpJs("js/core/settings.js");
  loadUxpJs("js/core/helper-client.js");
  loadUxpJs("js/core/jobs.js");
  /* ps/comfyui mock: 记录调用, 断言旧链路不被使用 */
  sandbox.A4P.comfyui = {
    calls: [],
    ping: async () => { sandbox.A4P.comfyui.calls.push("ping"); return { ok: true }; },
    uploadImage: async () => { sandbox.A4P.comfyui.calls.push("uploadImage"); return null; },
    submitWorkflow: async () => { sandbox.A4P.comfyui.calls.push("submitWorkflow"); return { promptId: "x" }; },
    connectProgress: () => { sandbox.A4P.comfyui.calls.push("connectProgress"); return function () {}; },
    downloadImage: async () => { sandbox.A4P.comfyui.calls.push("downloadImage"); return { url: "", filename: "x.png" }; }
  };
  sandbox.A4P.ps = { init: () => Promise.resolve(), writeResult: () => Promise.reject({ code: "NO_BRIDGE" }) };
  sandbox.A4P.store.load();
}

async function main() {
  if (!(await waitHealth())) {
    console.log("  FAIL helper start:", helperLog.slice(-300));
    process.exit(1);
  }
  /* 配对 */
  const pair = await (await realFetch(`http://127.0.0.1:${PORT}/v1/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
  const token = pair.token;

  bootA4P();
  const A4P = sandbox.A4P;
  A4P.settings.set("connection", "helperUrl", `http://127.0.0.1:${PORT}`);
  A4P.settings.set("connection", "helperToken", token);

  /* ---- 1. create -> POST /v1/jobs ---- */
  console.log("[1] create job -> Helper (非 ComfyUI)");
  fetchLog.length = 0;
  const job = A4P.jobs.create({
    label: "UXP-Test", providerId: "local-comfy", modelId: "stub-flux1-dev.safetensors",
    inputs: { prompt: "uxp helper test", imageAssetIds: [] },
    parameters: { steps: 10, cfg: 7, seed: 42, denoise: 0.5 },
    sourceDocumentId: "doc-uxp-1", sourceDocumentName: "test.psd",
    selectionBounds: { left: 10, top: 10, right: 330, bottom: 250 }
  });
  check("create returns pending mirror", !!job && !!job.id && job.status === "DRAFT", job.status);
  const postsJobs = fetchLog.filter((f) => f.url.includes("/v1/jobs") && f.method === "POST");
  check("POST /v1/jobs fired", postsJobs.length === 1, "n=" + postsJobs.length);
  const comfyDirect = fetchLog.filter((f) => /:8188|\/prompt|\/upload/.test(f.url));
  check("no direct ComfyUI calls", comfyDirect.length === 0, JSON.stringify(comfyDirect.slice(0, 2)));
  check("comfyui module not used", A4P.comfyui.calls.length === 0, A4P.comfyui.calls.join(","));

  /* ---- 2. Helper 驱动状态 -> result_ready ---- */
  console.log("[2] Helper-driven state");
  /* 等异步提交完成 (镜像 id 被替换为 Helper job id) */
  let helperId = null;
  const tempId = job.id;
  for (let i = 0; i < 20 && !helperId; i++) {
    await sleep(300);
    const mir = A4P.jobs.find(tempId);
    /* 提交成功 = 镜像已绑定 Helper job id (本地 id 保持稳定) */
    if (mir && !mir._pending && mir.helperId) helperId = mir.helperId;
    if (mir && mir.error) { console.log("  [dbg] mirror error:", JSON.stringify(mir.error).slice(0, 200)); break; }
  }
  const mirFinal = A4P.jobs.find(tempId);
  check("submitted (helper job id assigned)", !!helperId, "mirrorId=" + (mirFinal || {}).id + " status=" + (mirFinal || {}).status + " err=" + JSON.stringify((mirFinal || {}).error || null).slice(0, 160));
  let reached = null;
  for (let i = 0; i < 120; i++) {
    await sleep(500);
    const hj = await (await realFetch(`http://127.0.0.1:${PORT}/v1/jobs/${helperId}`, { headers: { authorization: "Bearer " + token } })).json();
    if (hj.job) {
      A4P.jobs.onRemoteUpdate(hj.job);
      reached = hj.job.status;
      if (["result_ready", "completed", "failed", "provider_failure"].includes(hj.job.status)) break;
    }
  }
  check("reaches result_ready", reached === "result_ready", reached);

  /* ---- 3. 无 localStorage Job Store ---- */
  console.log("[3] no localStorage job store");
  const keys = Object.keys(localStorageData);
  check("localStorage has no job store", !keys.some((k) => /job|task/i.test(k)), keys.join(","));
  const dumped = JSON.stringify(localStorageData);
  check("no helperToken in localStorage", dumped.indexOf(token) < 0);

  /* ---- 4. cancel / retry via Helper ---- */
  console.log("[4] cancel via Helper");
  const mir = A4P.jobs.find(job.id);
  await A4P.jobs.cancel(mir);
  check("cancel does not call comfyui", A4P.comfyui.calls.length === 0);
  const cposts = fetchLog.filter((f) => f.url.includes("/cancel"));
  check("POST /v1/jobs/:id/cancel fired", cposts.length === 1);

  console.log(failures === 0 ? "[uxp-jobs-helper] ALL PASS" : `[uxp-jobs-helper] ${failures} FAILURE(S)`);
  helperProc.kill();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("[uxp-jobs-helper] ERR", e); helperProc.kill(); process.exit(1); });
