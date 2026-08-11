/* cloud.integration: 云 Provider 协议测试 (PHASE 12)
 * - Gemini: generateContent 协议 (mock 端点, 401/成功路径)
 * - RunningHub: task/create + task/status 轮询 (mock 端点)
 * - 未配置 Provider -> 409 PROVIDER_NOT_CONFIGURED (不假运行)
 * 用法: node test/cloud.integration.mjs */
import http from "node:http";
import { GeminiAdapter } from "../dist/providers/gemini.js";
import { RunningHubAdapter } from "../dist/providers/runninghub.js";

let failures = 0;
const check = (name, cond, extra = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"} ${name}${extra ? " — " + extra : ""}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

function geminiMock() {
  let mode = "ok";
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const key = req.headers["x-goog-api-key"] || "";
    if (url.pathname.endsWith(":generateContent")) {
      if (mode === "401") { res.writeHead(401); res.end(JSON.stringify({ error: { message: "bad key" } })); return; }
      if (key === "sk-bad") { res.writeHead(401); res.end(JSON.stringify({ error: { message: "bad key" } })); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        candidates: [{ content: { parts: [{ text: "here is your image" }, { inlineData: { mimeType: "image/png", data: PNG.toString("base64") } }] } }]
      }));
      return;
    }
    res.writeHead(404); res.end();
  });
  return { server, setMode: (m) => (mode = m) };
}

function rhMock() {
  const tasks = new Map();
  let seq = 0;
  let port = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const token = req.headers.authorization || "";
    if (url.pathname === "/api/v1/task/create") {
      if (token === "token sk-bad") { res.writeHead(401); res.end(JSON.stringify({ code: 401 })); return; }
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seq++;
        const id = "rh-" + seq;
        tasks.set(id, 2);
        setTimeout(() => { tasks.set(id, 3); }, 1500); /* 1.5s 后 success */
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: 200, data: { task_id: id } }));
      });
      return;
    }
    if (url.pathname === "/api/v1/task/status") {
      const id = url.searchParams.get("task_id");
      const st = tasks.get(id) ?? 4;
      const body = st === 3
        ? { code: 200, data: { task_status: 3, task_result: [{ url: `http://127.0.0.1:${port}/img.png` }] } }
        : { code: 200, data: { task_status: st, task_result: [] } };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }
    if (url.pathname === "/img.png") { res.writeHead(200, { "content-type": "image/png" }); res.end(PNG); return; }
    res.writeHead(404); res.end();
  });
  server.on("listening", () => { port = server.address().port; });
  return { server };
}

async function main() {
  /* ---- Gemini ---- */
  console.log("[gemini]");
  const g = geminiMock();
  await new Promise((r) => g.server.listen(0, "127.0.0.1", r));
  const gBase = `http://127.0.0.1:${g.server.address().port}`;

  const gBad = new GeminiAdapter("gemini", "sk-bad", gBase);
  const jb = await gBad.submit({ providerId: "gemini", inputs: { prompt: "x" }, parameters: {} });
  let stb = await gBad.getStatus(jb.remoteJobId);
  for (let i = 0; i < 30 && !["failed", "completed"].includes(stb.status); i++) { await sleep(200); stb = await gBad.getStatus(jb.remoteJobId); }
  check("auth failed -> PROVIDER_AUTH_FAILED", stb.status === "failed" && stb.error && stb.error.code === "PROVIDER_AUTH_FAILED", stb.error && stb.error.code);

  const gOk = new GeminiAdapter("gemini", "sk-good", gBase);
  const j = await gOk.submit({ providerId: "gemini", modelId: "gemini-2.0-flash", inputs: { prompt: "cat photo" }, parameters: {} });
  let st = await gOk.getStatus(j.remoteJobId);
  for (let i = 0; i < 30 && !["failed", "completed"].includes(st.status); i++) { await sleep(200); st = await gOk.getStatus(j.remoteJobId); }
  check("completed", st.status === "completed", st.status + (st.error ? " " + st.error.message : ""));
  const assets = await gOk.downloadResults(j.remoteJobId);
  check("download PNG", assets.length === 1 && assets[0].bytes[0] === 0x89, "n=" + assets.length);
  check("models list", (await gOk.listModels()).length >= 3);
  g.server.close();

  /* ---- RunningHub ---- */
  console.log("[runninghub]");
  const r = rhMock();
  await new Promise((res) => r.server.listen(0, "127.0.0.1", res));
  const rBase = `http://127.0.0.1:${r.server.address().port}`;

  const rhBad = new RunningHubAdapter("runninghub", "sk-bad", rBase);
  const e1 = await rhBad.submit({ providerId: "runninghub", workflowId: "w", inputs: { prompt: "x" }, parameters: {} }).catch((e) => e);
  check("auth failed -> PROVIDER_AUTH_FAILED", e1 && e1.code === "PROVIDER_AUTH_FAILED", e1 && e1.code);

  const rh = new RunningHubAdapter("runninghub", "sk-good", rBase);
  const rj = await rh.submit({ providerId: "runninghub", workflowId: "rh-product-cleanup", inputs: { prompt: "cleanup" }, parameters: {} });
  check("submit task_id", /^rh-\d+$/.test(rj.remoteJobId), rj.remoteJobId);
  let rst = await rh.getStatus(rj.remoteJobId);
  for (let i = 0; i < 30 && !["failed", "completed"].includes(rst.status); i++) { await sleep(300); rst = await rh.getStatus(rj.remoteJobId); }
  check("completed via polling", rst.status === "completed", rst.status + " error=" + JSON.stringify(rst.error || null));
  const rassets = await rh.downloadResults(rj.remoteJobId);
  check("download PNG", rassets.length === 1 && rassets[0].bytes[0] === 0x89);
  r.server.close();

  console.log(failures === 0 ? "[cloud.integration] ALL PASS" : `[cloud.integration] ${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("[cloud.integration] ERR", e); process.exit(1); });
