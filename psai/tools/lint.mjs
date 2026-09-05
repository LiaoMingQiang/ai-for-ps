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
  { re: /\bwindow\.open\s*\(/, why: 'UXP 请用 uxp.shell.openExternal' },
  // 下面两条是真机上踩出来的：UXP 的 DOM 是浏览器 DOM 的子集，
  // 调用不存在的方法会当场抛错，整个页面白屏，而且只有装进 Photoshop 才复现。
  {
    re: /\.toggleAttribute\s*\(/,
    why: 'UXP 没有 Element.toggleAttribute（会整页白屏），请用 dom.ts 的 setAttr(el, name, on)'
  },
  {
    re: /\.classList\.toggle\s*\([^)]*,/,
    why: 'UXP 对 classList.toggle(name, force) 两参数形式不可靠，请用 dom.ts 的 toggleClass(el, name, on)'
  }
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

/**
 * 去掉注释再做内容检查。
 * 解释"我们为什么不用某个 API"的注释不该被判成违规 ——
 * 否则唯一的修法是删掉那条解释，正好把最该留下的信息删了。
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

for (const f of [...tsFiles, ...mjsFiles]) {
  const rel = relative(root, f).replaceAll('\\', '/');
  const src = readFileSync(f, 'utf8');
  const code = stripComments(src);
  const isPluginSrc = rel.startsWith('packages/plugin/src/');

  // dom.ts 是这些封装的实现处，注释与实现里必然提到被禁的 API，豁免它
  const isDomHelper = rel === 'packages/plugin/src/app/dom.ts';

  if (isPluginSrc && !isDomHelper) {
    for (const rule of FORBIDDEN_IN_PLUGIN) {
      if (rule.re.test(code)) problems.push(`${rel}: ${rule.why}`);
    }
    for (const host of THIRD_PARTY_HOSTS) {
      const re = new RegExp(`["'\`]https?://${host.replace(/\./g, '\\.')}`);
      if (re.test(code)) problems.push(`${rel}: 插件不得直连 ${host}，所有外呼必须经由 Helper`);
    }
  }

  // lint.mjs 自身含有这些正则字面量，跳过
  if (rel !== 'tools/lint.mjs') {
    for (const rule of FAKE_SUCCESS) {
      if (rule.re.test(code)) problems.push(`${rel}: ${rule.why}`);
    }
  }
}


/* ---- 5. UXP flexbox：纵向容器的子项必须禁止压缩 ---- */
/*
 * 浏览器里 flex 子项有「自动最小尺寸」（min-height: auto）兜底，内容再多也不会被
 * 压得比内容还矮。UXP 没有实现这条规则。
 *
 * 后果在真机上非常难认：历史页几十条记录会被按比例压扁到刚好塞满一屏，
 * 每行只剩几个像素高，文字全部溢出、上下重叠成一团；设置页的平台卡片同理。
 * 浏览器里预览一切正常 —— 这个 bug 只在 Photoshop 里出现。
 *
 * 所以每加一个 flex-direction: column 的容器，都必须同时给它的直接子项
 * 加上 flex-shrink: 0。这条规则就是来盯着这件事的。
 */
{
  const cssPath = resolve(root, 'packages/plugin/styles/app.css');
  const css = readFileSync(cssPath, 'utf8');

  /** 这些容器**应该**能被压缩，逐个说明理由。 */
  const SHRINK_ALLOWED = new Map([
    ['.psai-root', '它就是那一屏，本来就该等于视口高度'],
    ['.page-host', '唯一该被压缩的：缩到状态条和导航剩下的空间里，然后在内部滚动']
  ]);

  // 收集所有声明了 flex-direction: column 的选择器
  const columns = [];
  for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const sel = m[1].replace(/\/\*[\s\S]*?\*\//g, '').trim().replace(/\s+/g, ' ');
    if (/flex-direction:\s*column/.test(m[2])) columns.push(sel);
  }

  // 收集所有已经写了 flex-shrink: 0 的「直接子项」选择器
  const guarded = new Set();
  for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (!/flex-shrink:\s*0/.test(m[2])) continue;
    for (const part of m[1].split(',')) {
      const s = part.replace(/\/\*[\s\S]*?\*\//g, '').trim();
      const hit = /^(\.[A-Za-z0-9_-]+)\s*>\s*\*$/.exec(s);
      if (hit) guarded.add(hit[1]);
    }
  }

  for (const sel of columns) {
    // 只看单一类选择器；组合选择器由它的基础类覆盖
    const cls = /(^|\s)(\.[A-Za-z0-9_-]+)$/.exec(sel)?.[2];
    if (!cls) continue;
    if (SHRINK_ALLOWED.has(cls)) continue;
    if (!guarded.has(cls)) {
      problems.push(
        `packages/plugin/styles/app.css: ${cls} 是纵向 flex 容器，但没有 \`${cls} > * { flex-shrink: 0 }\` —— ` +
          `UXP 里它的子项会被压扁、文字重叠（浏览器里看不出来）`
      );
    }
  }
}

/*
 * 工具类必须能赢过组件类。
 *
 * `.hidden { display: none }` 和 `.setting { display: flex }` 都是单类选择器，
 * 同权重时**后写的赢**。真机上出过：.setting 写在 .hidden 后面，于是
 * 任何 .setting 行加上 hidden 都藏不住 —— JS 那边 toggleClass 明明调了、
 * 类也加上了，查半天都在怀疑逻辑，其实是 CSS 顺序。
 *
 * 靠"记得把工具类写在最后"是靠不住的，所以让 lint 盯着：这几个
 * 切换显隐的工具类必须带 !important。
 */
{
  const css = readFileSync(resolve(root, 'packages/plugin/styles/app.css'), 'utf8');
  for (const cls of ['hidden']) {
    const m = new RegExp(String.raw`^\.${cls}\s*\{([^}]*)\}`, 'm').exec(css);
    if (!m) {
      problems.push(`packages/plugin/styles/app.css: 找不到 .${cls} 这条工具类`);
      continue;
    }
    if (!/display:\s*none\s*!important/.test(m[1])) {
      problems.push(
        `packages/plugin/styles/app.css: .${cls} 的 display 必须带 !important —— ` +
          `否则写在它后面的组件类（如 .setting { display: flex }）会赢，元素藏不住`
      );
    }
  }
}

/* ---- 统一收尾：所有检查跑完再报告，不能先喊 OK 再喊 FAIL ---- */
if (problems.length) {
  for (const p of problems) console.error(`FAIL  ${p}`);
  process.exit(1);
}
console.log(`LINT-OK  ${tsFiles.length} 个 .ts / ${mjsFiles.length} 个 .mjs 通过`);
