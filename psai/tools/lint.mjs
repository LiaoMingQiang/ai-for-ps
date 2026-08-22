/**
 * 轻量 lint：不引入 eslint（UXP 侧本来就没有运行时依赖），只做真正会咬人的检查。
 *
 * 1. 每个 .ts / .mjs 文件语法可解析
 * 2. 插件源码里不得出现 UXP 不支持的浏览器 API
 * 3. 全仓不得出现"假成功"痕迹（mock success / TODO 假装完成）
 * 4. 插件源码不得直连第三方 AI 服务（所有外呼必须走 Helper）
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, dirname, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === '.git' || name === 'out') continue;
    const p = resolve(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const files = walk(root);
const tsFiles = files.filter((f) => extname(f) === '.ts');
const mjsFiles = files.filter((f) => ['.mjs', '.js'].includes(extname(f)));

/* ---- 1. .mjs 语法检查（node --check） ---- */
for (const f of mjsFiles) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (e) {
    problems.push(`语法错误 ${relative(root, f)}: ${String(e.stderr ?? e).slice(0, 300)}`);
  }
}

/* ---- 2/3/4. 内容规则 ---- */
const FORBIDDEN_IN_PLUGIN = [
  { re: /\blocalStorage\b/, why: 'UXP 没有 localStorage，请用 secureStorage 或 Helper 设置接口' },
  { re: /\bsessionStorage\b/, why: 'UXP 没有 sessionStorage' },
  { re: /<input[^>]+type=["']file["']/i, why: 'UXP 必须用 localFileSystem 选文件' },
  { re: /\bXMLHttpRequest\b/, why: 'UXP 请用 fetch' },
  { re: /transform-style\s*:\s*preserve-3d/, why: 'UXP 对 CSS 3D 变换支持不可靠，立方体请用 SVG 投影' },
  { re: /\bwindow\.open\s*\(/, why: 'UXP 请用 uxp.shell.openExternal' }
];

const THIRD_PARTY_HOSTS = [
  'api.openai.com',
  'generativelanguage.googleapis.com',
  'ark.cn-beijing.volces.com',
  'dashscope.aliyuncs.com',
  'api-inference.modelscope.cn',
  'ai.comfly.org',
  'www.runninghub.cn'
];

const FAKE_SUCCESS = [
  { re: /mock\s*success/i, why: '禁止 mock success' },
  { re: /\bfakeResult\b/i, why: '禁止伪造结果' },
  { re: /return\s+\{\s*ok:\s*true\s*\}\s*;?\s*\/\/\s*(TODO|占位|stub)/i, why: '禁止用假成功占位' }
];

for (const f of [...tsFiles, ...mjsFiles]) {
  const rel = relative(root, f).replaceAll('\\', '/');
  const src = readFileSync(f, 'utf8');
  const isPluginSrc = rel.startsWith('packages/plugin/src/');

  if (isPluginSrc) {
    for (const rule of FORBIDDEN_IN_PLUGIN) {
      if (rule.re.test(src)) problems.push(`${rel}: ${rule.why}`);
    }
    for (const host of THIRD_PARTY_HOSTS) {
      // 允许出现在注释里的说明；只拦截实际的 URL 字面量
      const re = new RegExp(`["'\`]https?://${host.replace(/\./g, '\\.')}`);
      if (re.test(src)) problems.push(`${rel}: 插件不得直连 ${host}，所有外呼必须经由 Helper`);
    }
  }

  // lint.mjs 自身含有这些正则字面量，跳过
  if (rel !== 'tools/lint.mjs') {
    for (const rule of FAKE_SUCCESS) {
      if (rule.re.test(src)) problems.push(`${rel}: ${rule.why}`);
    }
  }
}

if (problems.length) {
  for (const p of problems) console.error(`FAIL  ${p}`);
  process.exit(1);
}
console.log(`LINT-OK  ${tsFiles.length} 个 .ts / ${mjsFiles.length} 个 .mjs 通过`);
