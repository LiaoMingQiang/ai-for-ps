/* openai.integration: OpenAI Compatible Adapter 集成测试 (规则十二/场景 10)
 * 本地 mock 端点: /models, /images/generations (401 / 200 路径)
 * 用法: node test/openai.integration.mjs */
import http from "node:http";
import { OpenAICompatibleAdapter } from "../dist/providers/openai.js";

let failures = 0;
const check = (name, cond, extra = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"} ${name}${extra ? " — " + extra : ""}`);
  if (!cond) failures++;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeServer() {
  const calls = { models: 0, gens: 0, edits: 0 };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const auth = req.headers.authorization || "";
    if (url.pathname === "/models") {
      calls.models++;
      if (auth === "Bearer sk-bad") { res.writeHead(401); res.end(JSON.stringify({ error: { message: "bad key" } })); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "gpt-image-1" }, { id: "dall-e-3" }] }));
      return;
    }
    if (url.pathname === "/images/generations") {
      calls.gens++;
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (auth === "Bearer sk-bad") { res.writeHead(401); res.end(JSON.stringify({ error: { message: "bad key" } })); return; }
        const parsed = JSON.parse(body);
        if (parsed.prompt === "rate-limit-me") { res.writeHead(429); res.end(JSON.stringify({ error: { message: "rate limited" } })); return; }
        /* 1x1 PNG b64 */
        const b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ b64_json: b64 }] }));
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  return { server, calls };
}

async function main() {
  const { server, calls } = makeServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  /* 1. 认证失败 -> PROVIDER_AUTH_FAILED (场景 10) */
  const bad = new OpenAICompatibleAdapter("openai-compatible", base, "sk-bad");
  const e1 = await bad.listModels().catch((e) => e);
  check("auth failed -> PROVIDER_AUTH_FAILED", e1 && e1.code === "PROVIDER_AUTH_FAILED", e1 && e1.code);

  /* 2. 未配置 -> NOT_CONFIGURED */
  const none = new OpenAICompatibleAdapter("openai-compatible", base, null);
  const e2 = await none.listModels().catch((e) => e);
  check("no key -> PROVIDER_NOT_CONFIGURED", e2 && e2.code === "PROVIDER_NOT_CONFIGURED", e2 && e2.code);

  /* 3. 正常模型列表 */
  const good = new OpenAICompatibleAdapter("openai-compatible", base, "sk-good");
  const models = await good.listModels();
  check("listModels", models.length === 2, "n=" + models.length);

  /* 4. 提交 -> 完成 -> 下载 (同步 API, 后台执行) */
  const job = await good.submit({
    providerId: "openai-compatible", modelId: "gpt-image-1",
    inputs: { prompt: "a cat" }, parameters: { size: "1024x1024" }
  });
  check("submit remoteJobId", /^sync-/.test(job.remoteJobId), job.remoteJobId);
  let st = await good.getStatus(job.remoteJobId);
  for (let i = 0; i < 40 && st.status !== "completed" && st.status !== "failed"; i++) { await sleep(200); st = await good.getStatus(job.remoteJobId); }
  check("completed", st.status === "completed", st.status + (st.error ? " " + st.error.message : ""));
  const assets = await good.downloadResults(job.remoteJobId);
  check("download PNG bytes", assets.length === 1 && assets[0].bytes[0] === 0x89 && assets[0].bytes[1] === 0x50);

  /* 5. 429 -> PROVIDER_RATE_LIMIT */
  const j2 = await good.submit({ providerId: "openai-compatible", modelId: "m", inputs: { prompt: "rate-limit-me" }, parameters: {} });
  let st2 = await good.getStatus(j2.remoteJobId);
  for (let i = 0; i < 40 && st2.status !== "failed" && st2.status !== "completed"; i++) { await sleep(200); st2 = await good.getStatus(j2.remoteJobId); }
  check("rate limit -> PROVIDER_RATE_LIMIT", st2.status === "failed" && st2.error && st2.error.code === "PROVIDER_RATE_LIMIT", st2.error && st2.error.code);

  /* 6. cancel 明确不支持 (诚实失败, 不假成功) */
  const c = await good.cancel(job.remoteJobId);
  check("cancel unsupported (honest)", c.ok === false && /不支持/.test(c.message));

  /* 7. 重启后状态丢失 (同步 API 限制, 诚实上报) */
  const lost = await good.getStatus("sync-nonexistent");
  check("recover lost -> unknown+JOB_LOST", lost.status === "unknown" && lost.error && lost.error.code === "JOB_LOST");

  server.close();
  console.log(failures === 0 ? "[openai.integration] ALL PASS" : `[openai.integration] ${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("[openai.integration] ERR", e); process.exit(1); });
