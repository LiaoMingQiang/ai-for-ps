/* scripts/validate.js — PHASE 1 校验:
 * 1. manifest.json 结构 (manifestVersion 5, host.minVersion, permissions)
 * 2. manifest entrypoint ID 与 src/entry.js entrypoints.setup 注册 ID 一致
 * 3. icons / main 文件存在
 * 4. index.html script 引用文件全部存在
 */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
let errors = 0;
const fail = (m) => { errors++; console.error("  FAIL " + m); };
const ok = (m) => console.log("  ok   " + m);

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));

console.log("[validate] manifest.json");
if (manifest.manifestVersion !== 5) fail("manifestVersion !== 5"); else ok("manifestVersion=5");
if (!/^\d+\.\d+\.\d+$/.test(manifest.version || "")) fail("version 非 semver: " + manifest.version); else ok("version=" + manifest.version);
if (manifest.host && manifest.host.app === "PS") ok("host.app=PS"); else fail("host.app !== PS");
if (manifest.host && manifest.host.minVersion) ok("minVersion=" + manifest.host.minVersion); else fail("缺少 host.minVersion");
if (manifest.main && fs.existsSync(path.join(ROOT, manifest.main))) ok("main=" + manifest.main); else fail("main 不存在: " + manifest.main);

const perms = manifest.requiredPermissions || {};
if (perms.network && Array.isArray(perms.network.domains)) ok("network.domains=" + perms.network.domains.join(",")); else fail("缺少 network.domains");
if (perms.localFileSystem === "request" || perms.localFileSystem === "fullAccess") ok("localFileSystem=" + perms.localFileSystem); else fail("localFileSystem 权限缺失");
if (perms.clipboard) ok("clipboard=" + perms.clipboard); else fail("clipboard 权限缺失");

console.log("[validate] entrypoints ID 一致性");
const entryIds = (manifest.entrypoints || []).map((e) => e.id);
if (!entryIds.length) fail("manifest 无 entrypoints");
const entrySrc = fs.readFileSync(path.join(ROOT, "src", "entry.js"), "utf8");
for (const id of entryIds) {
  if (entrySrc.includes("panels:") && entrySrc.includes(id)) ok("panel/command id 已注册: " + id);
  else if (entrySrc.includes("commands:") && entrySrc.includes(id)) ok("panel/command id 已注册: " + id);
  else fail("entry.js 未注册 id: " + id);
}
// 提取 entry.js 中 panels/commands 注册的 key (仅匹配对象形式: key: {)
const panelKeys = [...entrySrc.matchAll(/panels:\s*\{(.*?)\n\s*\}/gs)].flatMap((m) => [...m[1].matchAll(/(\w+)\s*:\s*\{/g)].map((x) => x[1]));
const cmdKeys = [...entrySrc.matchAll(/commands:\s*\{(.*?)\n\s*\}/gs)].flatMap((m) => [...m[1].matchAll(/(\w+)\s*:\s*\{/g)].map((x) => x[1]));
const registered = [...new Set([...panelKeys, ...cmdKeys])];
for (const id of registered) {
  if (!entryIds.includes(id)) fail("entry.js 注册了 manifest 未声明的 id: " + id); else ok("注册一致: " + id);
}

console.log("[validate] 文件完整性");
for (const icon of (manifest.icons || [])) {
  const p = path.join(ROOT, icon.path);
  if (fs.existsSync(p)) ok("icon: " + icon.path); else fail("icon 缺失: " + icon.path);
}
for (const ep of (manifest.entrypoints || [])) {
  for (const icon of (ep.icons || [])) {
    const p = path.join(ROOT, icon.path);
    if (fs.existsSync(p)) ok("entry icon: " + icon.path); else fail("entry icon 缺失: " + icon.path);
  }
}

const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const refs = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
for (const r of refs) {
  const p = path.join(ROOT, r);
  if (fs.existsSync(p)) ok("script: " + r); else fail("script 缺失: " + r);
}

console.log(errors === 0 ? "[validate] ALL PASS" : "[validate] " + errors + " ERROR(S)");
process.exit(errors === 0 ? 0 : 1);
