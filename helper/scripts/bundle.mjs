/* scripts/bundle.mjs: Helper 单文件打包 (esbuild bundle) + Node SEA 单 exe
 * 产出: dist-bundle/helper.cjs  (纯 JS 单文件, 零 node_modules 依赖)
 *       dist-bundle/AI-for-PS-Helper.exe  (Node SEA 单 exe, sharp 为可选能力)
 * 用法: npm run bundle */
import { build } from "esbuild";
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "dist-bundle");

fs.mkdirSync(OUT, { recursive: true });

/* 1. tsc 编译 (ESM) */
execSync("npx tsc -p tsconfig.json", { cwd: ROOT, stdio: "inherit" });

/* 2. esbuild bundle (CJS, sharp external -> 可选能力) */
await build({
  entryPoints: [path.join(ROOT, "dist", "index.js")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  outfile: path.join(OUT, "helper.cjs"),
  external: ["sharp"],
  /* CJS bundle 中 import.meta.dirname 不可用 -> 映射到 esbuild 注入的 __dirname */
  define: { "import.meta.dirname": "__dirname" },
  banner: { js: "/* AI-for-PS-Helper bundle */" },
  sourcemap: false,
  minify: false
});
console.log("[bundle] helper.cjs:", fs.statSync(path.join(OUT, "helper.cjs")).size, "bytes");

/* 3. 复制 dpapi.ps1 到 exe 同目录 scripts/ */
const scriptsDir = path.join(OUT, "scripts");
fs.mkdirSync(scriptsDir, { recursive: true });
fs.copyFileSync(path.join(ROOT, "scripts", "dpapi.ps1"), path.join(scriptsDir, "dpapi.ps1"));
console.log("[bundle] scripts/dpapi.ps1 copied");

/* 4. Node SEA 单 exe */
const NODE = process.execPath;
const EXE = path.join(OUT, "AI-for-PS-Helper.exe");
const BLOB = path.join(OUT, "helper.blob");
const FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
const seaCfg = { main: path.join(OUT, "helper.cjs"), output: BLOB, disableExperimentalSEAWarning: true };
fs.writeFileSync(path.join(OUT, "sea-config.json"), JSON.stringify(seaCfg));

try {
  execSync(`node --experimental-sea-config "${path.join(OUT, "sea-config.json")}"`, { stdio: "inherit" });
  fs.copyFileSync(NODE, EXE);
  const injectScript = path.join(OUT, "inject.cjs");
  fs.writeFileSync(injectScript, `const { inject } = require("postject");\nconst fs = require("node:fs");\nconst blob = fs.readFileSync(${JSON.stringify(BLOB)});\ninject(${JSON.stringify(EXE)}, "NODE_SEA_BLOB", blob, { sentinelFuse: ${JSON.stringify(FUSE)} });\n`);
  execSync(`node "${injectScript}"`, { stdio: "inherit" });
  fs.rmSync(injectScript, { force: true });
  console.log("[bundle] AI-for-PS-Helper.exe:", fs.statSync(EXE).size, "bytes");
} catch (e) {
  console.error("[bundle] SEA 打包失败 (保留 helper.cjs + node 启动器):", String(e).slice(0, 300));
  /* fallback: 启动器 */
  fs.writeFileSync(path.join(OUT, "run-helper.bat"),
    `@echo off\r\n"%~dp0helper.cjs" 由 node 运行:\r\nnode "%~dp0helper.cjs" %*\r\n`);
}

console.log("[bundle] done");
