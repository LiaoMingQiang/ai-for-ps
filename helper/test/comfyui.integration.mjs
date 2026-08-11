/* comfyui.integration: ComfyUI Adapter 集成测试 (规则十二)
 * 场景: connect / queue / upload / submit / progress / complete / history /
 *       download / cancel queued / cancel running / error / disconnect / reconnect
 * 用法: node test/comfyui.integration.mjs [port]  (需先 npm run build + stub @18189)
 */
import { ComfyUIAdapter } from "../dist/providers/comfyui.js";

const PORT = Number(process.argv[2] || 18189);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (name, cond, extra = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"} ${name}${extra ? " — " + extra : ""}`);
  if (!cond) failures++;
};

const req = (request) => ({
  providerId: "local-comfy",
  inputs: { prompt: "a product photo, white background", negativePrompt: "blurry" },
  parameters: { steps: 20, cfg: 7, seed: 12345, denoise: 0.65, width: 640, height: 480 },
  ...request
});

async function waitStatus(adapter, id, want, timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const st = await adapter.getStatus(id);
    if (st.status === want || ["failed", "unknown"].includes(st.status)) return st;
    await sleep(300);
  }
  return { status: "timeout" };
}

async function main() {
  const adapter = new ComfyUIAdapter("local-comfy", BASE);

  /* 1. connect (ping via validate->listModels path + /system_stats) */
  try {
    const models = await adapter.listModels();
    check("connect: listModels", Array.isArray(models) && models.length >= 3, "n=" + models.length);
  } catch (e) {
    check("connect: listModels", false, String(e));
  }

  /* 2. queue 初始为空 */
  const q0 = await fetch(BASE + "/queue").then((r) => r.json());
  check("queue: initial", Array.isArray(q0.queue_running) && Array.isArray(q0.queue_pending));

  /* 3. upload */
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const upName = await adapter.uploadImage(new Uint8Array(png), "input-test.png");
  check("upload: name returned", typeof upName === "string" && upName.length > 0, upName);

  /* 4. submit (t2i) + progress + complete + history + download */
  const r1 = await adapter.submit(req({}));
  check("submit: remoteJobId", !!(r1.remoteJobId && r1.status === "queued"), r1.remoteJobId);
  const progressFrames = [];
  const stop = adapter.connectProgress(r1.remoteJobId, (f) => progressFrames.push(f));
  const done = await waitStatus(adapter, r1.remoteJobId, "completed");
  check("complete: status", done.status === "completed", done.status);
  check("progress: WS official structure received", progressFrames.length > 0, "frames=" + progressFrames.length);
  check("progress: monotonic", progressFrames.every((f, i) => i === 0 || f >= progressFrames[i - 1]));
  stop();

  const hist = await adapter.getStatus(r1.remoteJobId);
  check("history: outputs present", !!(hist.outputs && hist.outputs.length), JSON.stringify(hist.outputs));
  const assets = await adapter.downloadResults(r1.remoteJobId);
  check("download: bytes are PNG", assets.length >= 1 && assets[0].bytes && assets[0].bytes[0] === 0x89 && assets[0].bytes[1] === 0x50, "n=" + assets.length);

  /* 5. cancel queued: 提交一个任务(占用 running), 再提交一个进 pending, 取消 pending 那个 */
  const r2 = await adapter.submit(req({})); // 此时 r1 已结束, r2 开始 running
  await sleep(300);
  const r3 = await adapter.submit(req({})); // pending (r2 在跑)
  await sleep(300);
  const q1 = await fetch(BASE + "/queue").then((r) => r.json());
  check("queue: r3 pending", (q1.queue_pending || []).some((x) => x[1] === r3.remoteJobId), "pending=" + JSON.stringify((q1.queue_pending || []).map((x) => x[1])));
  const c1 = await adapter.cancel(r3.remoteJobId);
  check("cancel queued: ok", c1.ok === true, c1.message);
  await sleep(300);
  const q2 = await fetch(BASE + "/queue").then((r) => r.json());
  check("cancel queued: removed from pending", !(q2.queue_pending || []).some((x) => x[1] === r3.remoteJobId));
  check("cancel queued: running untouched", (q2.queue_running || []).some((x) => x[1] === r2.remoteJobId));
  await waitStatus(adapter, r2.remoteJobId, "completed", 20000);

  /* 6. cancel running: 只 interrupt 当前任务 */
  const r4 = await adapter.submit(req({})); // running
  await sleep(400);
  const st4 = await adapter.getStatus(r4.remoteJobId);
  check("running: status running", st4.status === "running", st4.status);
  const c2 = await adapter.cancel(r4.remoteJobId);
  check("cancel running: ok", c2.ok === true, c2.message);
  await sleep(600);
  const st4b = await adapter.getStatus(r4.remoteJobId);
  check("cancel running: interrupted (failed/unknown)", ["failed", "unknown"].includes(st4b.status), st4b.status + " | " + JSON.stringify((await fetch(BASE + "/history").then(r => r.json()))[r4.remoteJobId] || "no-history") + " | queue=" + JSON.stringify(await fetch(BASE + "/queue").then(r => r.json())).slice(0, 200));
  await sleep(300);

  /* 7. error: 未知节点 -> node_errors (submitRaw 抛 ProviderError COMFY_NODE_MISSING) */
  const bad = await adapter.submitRaw({ "1": { class_type: "NoSuchNode", inputs: {} } }).catch((e) => e);
  check("error: bad node -> ProviderError", bad && bad.code === "COMFY_NODE_MISSING", bad && bad.code);

  /* 8. recover: 已完成任务 -> recover 返回 completed (不重新 submit) */
  const rec = await adapter.recover(r1.remoteJobId);
  check("recover: completed job", rec.status === "completed", rec.status);
  const recLost = await adapter.recover("nonexistent-9999");
  check("recover: lost job -> unknown", recLost.status === "unknown", recLost.status);

  /* 9. disconnect/reconnect: connectProgress WS 断开后轮询回退 (stub WS 会关闭) */
  const r5 = await adapter.submit(req({}));
  const frames5 = [];
  const stop5 = adapter.connectProgress(r5.remoteJobId, (f) => frames5.push(f));
  /* 不主动关闭 WS: stub 会在任务完成后关闭连接; 验证轮询回退能拿到 completed */
  const done5 = await waitStatus(adapter, r5.remoteJobId, "completed", 20000);
  check("reconnect: completed via polling fallback", done5.status === "completed", done5.status);
  stop5();

  console.log(failures === 0 ? "[comfyui.integration] ALL PASS" : `[comfyui.integration] ${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("[comfyui.integration] ERR", e); process.exit(1); });
