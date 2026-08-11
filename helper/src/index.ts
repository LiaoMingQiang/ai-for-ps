/* index: Helper 入口
 * - 单实例锁 -> 端口绑定 (冲突=已有实例) -> Fastify 启动 (127.0.0.1)
 * - 优雅退出 */
import { loadConfig, acquireSingleInstance, releaseSingleInstance } from "./config.js";
import { buildServer, serverErrorHandler } from "./server.js";

const cfg = loadConfig();
const inst = acquireSingleInstance(cfg);
if (!inst.ok) {
  console.error("[helper] " + (inst.reason || "已有实例运行"));
  process.exit(2);
}

const app = buildServer();
serverErrorHandler(app);

app.listen({ port: cfg.port, host: cfg.host }).then(() => {
  console.log(`[helper] AI-for-PS-Helper ${process.env.npm_package_version || "0.9.0"} listening on http://${cfg.host}:${cfg.port}`);
  console.log(`[helper] data dir: ${cfg.dataDir}`);
  console.log(`[helper] LAN mode: ${cfg.host !== "127.0.0.1" ? "ON (explicit)" : "OFF (loopback only)"}`);
}).catch((err: unknown) => {
  const msg = String((err as { message?: string })?.message || err);
  if (/EADDRINUSE/.test(msg)) {
    console.error(`[helper] 端口 ${cfg.port} 已被占用 — 已有 Helper 实例在运行?`);
    process.exit(2);
  }
  console.error("[helper] 启动失败:", msg);
  process.exit(1);
});

function shutdown() {
  try { app.close(); } catch (e) { /* noop */ }
  releaseSingleInstance(cfg);
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
