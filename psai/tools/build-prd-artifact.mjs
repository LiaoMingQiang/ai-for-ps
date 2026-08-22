/**
 * 把 docs/PRD.md 渲染成可发布的单页 HTML。
 * 从 Markdown 生成而不是手写，PRD 改了重跑一次就同步，不会两边打架。
 *
 * 用法：node tools/build-prd-artifact.mjs
 * 输出：tools/.artifacts/prd.html
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, '../docs/PRD.md');
const OUT_DIR = resolve(here, '.artifacts');
const OUT = resolve(OUT_DIR, 'prd.html');

const md = readFileSync(SRC, 'utf8');

/* ---------- 收集章节，生成侧栏目录 ---------- */

const chapters = [];
let currentChapter = null;

function slug(text, index) {
  const base = text
    .replace(/[^\p{L}\p{N}\s.·/-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
  return `s-${index}-${base}`.slice(0, 80);
}

let headingIndex = 0;
const renderer = new marked.Renderer();

renderer.heading = function ({ tokens, depth }) {
  const text = this.parser.parseInline(tokens);
  const plain = text.replace(/<[^>]+>/g, '');
  const id = slug(plain, headingIndex++);

  // 一级章节（"## 3. 信息架构"）进侧栏；二级（"### 4.2 ..."）作为子项
  const chapterMatch = depth === 2 && /^(\d+)\.\s+(.*)$/.exec(plain);
  const appendixMatch = depth === 2 && /^附录\s*([A-Z])\s*·\s*(.*)$/.exec(plain);

  if (chapterMatch) {
    currentChapter = { num: chapterMatch[1], title: chapterMatch[2], id, children: [] };
    chapters.push(currentChapter);
  } else if (appendixMatch) {
    currentChapter = { num: appendixMatch[1], title: appendixMatch[2], id, children: [], appendix: true };
    chapters.push(currentChapter);
  } else if (depth === 3 && currentChapter) {
    const sub = /^([\d.]+)\s+(.*)$/.exec(plain);
    currentChapter.children.push({ num: sub ? sub[1] : '', title: sub ? sub[2] : plain, id });
  }

  return `<h${depth} id="${id}"><a class="anchor" href="#${id}" aria-label="链接到本节">#</a>${text}</h${depth}>\n`;
};

// 宽表格必须自己横向滚动，页面主体不能左右晃
renderer.table = function (token) {
  const header = token.header
    .map((cell) => `<th align="${cell.align ?? 'left'}">${this.parser.parseInline(cell.tokens)}</th>`)
    .join('');
  const body = token.rows
    .map(
      (row) =>
        '<tr>' +
        row.map((cell) => `<td align="${cell.align ?? 'left'}">${this.parser.parseInline(cell.tokens)}</td>`).join('') +
        '</tr>'
    )
    .join('\n');
  return `<div class="table-wrap"><table><thead><tr>${header}</tr></thead><tbody>\n${body}\n</tbody></table></div>\n`;
};

const body = marked.parse(md, { renderer, gfm: true, breaks: false });

/* ---------- 侧栏 ---------- */

const nav = chapters
  .map(
    (c) => `      <li>
        <a href="#${c.id}" data-target="${c.id}"><span class="num">${c.num}</span><span>${escapeHtml(c.title)}</span></a>
      </li>`
  )
  .join('\n');

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ---------- 顶部事实条（数字都取自 PRD 与目录本身） ---------- */

const featureCount = (md.match(/^\| `(comfy|cloud)\./gm) ?? []).length;
const facts = [
  { k: '功能', v: '17', note: '可执行叶子节点' },
  { k: '导航', v: '5 级', note: 'ComfyUI / 生成 / 历史 / 设置' },
  { k: '作业状态', v: '18', note: '含写回失败可重试态' },
  { k: '边界情况', v: '25', note: '逐条给出期望行为' },
  { k: 'Provider', v: '8', note: '本地 · 云端 · 闭源' }
];

const factHtml = facts
  .map(
    (f) => `      <div class="fact">
        <div class="fact-v">${f.v}</div>
        <div class="fact-k">${f.k}</div>
        <div class="fact-n">${f.note}</div>
      </div>`
  )
  .join('\n');

/* ---------- 页面 ---------- */

const html = `<title>AI for PS 产品需求文档</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@300;400;500;700&family=Noto+Serif+SC:wght@500;700&family=JetBrains+Mono:wght@400;600&display=swap">
<style>
:root {
  --paper:      #FBFAF8;
  --surface:    #FFFFFF;
  --surface-2:  #F3F1EC;
  --ink:        #1A1D23;
  --ink-soft:   #454B56;
  --ink-mute:   #767D8A;
  --rule:       #E3DFD8;
  --rule-soft:  #EFEBE4;
  --accent:     #B26A28;
  --accent-dim: #F0E2D0;
  --good:       #2E6F5E;
  --shadow:     0 1px 2px rgba(26,29,35,.05), 0 8px 24px -12px rgba(26,29,35,.12);

  --sans: "Noto Sans SC", -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  --serif: "Noto Serif SC", Georgia, "Songti SC", serif;
  --mono: "JetBrains Mono", ui-monospace, "Cascadia Code", Consolas, monospace;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --paper:      #16181C;
    --surface:    #1C1F24;
    --surface-2:  #22262C;
    --ink:        #E6E4E0;
    --ink-soft:   #B8B5AF;
    --ink-mute:   #8A8983;
    --rule:       #2C3037;
    --rule-soft:  #242830;
    --accent:     #E0A050;
    --accent-dim: #3A2E20;
    --good:       #5FAF97;
    --shadow:     0 1px 2px rgba(0,0,0,.3), 0 8px 24px -12px rgba(0,0,0,.5);
  }
}

:root[data-theme="dark"] {
  --paper:      #16181C;
  --surface:    #1C1F24;
  --surface-2:  #22262C;
  --ink:        #E6E4E0;
  --ink-soft:   #B8B5AF;
  --ink-mute:   #8A8983;
  --rule:       #2C3037;
  --rule-soft:  #242830;
  --accent:     #E0A050;
  --accent-dim: #3A2E20;
  --good:       #5FAF97;
  --shadow:     0 1px 2px rgba(0,0,0,.3), 0 8px 24px -12px rgba(0,0,0,.5);
}

* { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--paper);
  color: var(--ink);
  font-family: var(--sans);
  font-weight: 400;
  font-size: 15px;
  line-height: 1.75;
  -webkit-font-smoothing: antialiased;
}

.shell { display: flex; align-items: flex-start; gap: 0; }

/* ---------- 侧栏 ---------- */
.rail {
  position: sticky;
  top: 0;
  flex: 0 0 264px;
  height: 100vh;
  overflow-y: auto;
  padding: 28px 20px 40px 28px;
  border-right: 1px solid var(--rule);
  background: var(--surface-2);
}
.brand { margin-bottom: 22px; }
.brand-mark {
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: .16em;
  text-transform: uppercase;
  color: var(--accent);
  font-weight: 600;
}
.brand-name {
  font-family: var(--serif);
  font-size: 19px;
  font-weight: 700;
  line-height: 1.3;
  margin-top: 4px;
}
.brand-meta {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--ink-mute);
  margin-top: 6px;
}
.rail nav ol { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 1px; }
.rail nav a {
  display: flex;
  gap: 10px;
  align-items: baseline;
  padding: 5px 8px;
  border-radius: 4px;
  color: var(--ink-soft);
  text-decoration: none;
  font-size: 13.5px;
  line-height: 1.45;
  border-left: 2px solid transparent;
}
.rail nav a:hover { background: var(--surface); color: var(--ink); }
.rail nav a.active {
  color: var(--accent);
  border-left-color: var(--accent);
  background: var(--surface);
  font-weight: 500;
}
.rail nav .num {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--ink-mute);
  min-width: 17px;
  font-variant-numeric: tabular-nums;
}
.rail nav a.active .num { color: var(--accent); }

/* ---------- 正文 ---------- */
main { flex: 1 1 auto; min-width: 0; padding: 0 0 120px; }
.doc { max-width: 74ch; margin: 0 auto; padding: 44px 32px 0; }

.masthead { border-bottom: 2px solid var(--ink); padding-bottom: 20px; margin-bottom: 8px; }
.eyebrow {
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: .18em;
  text-transform: uppercase;
  color: var(--accent);
  font-weight: 600;
}
.masthead h1 {
  font-family: var(--serif);
  font-size: clamp(30px, 4.4vw, 42px);
  line-height: 1.2;
  font-weight: 700;
  margin: 10px 0 8px;
  text-wrap: balance;
}
.masthead p { color: var(--ink-soft); margin: 0; max-width: 60ch; }

.facts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(112px, 1fr));
  gap: 1px;
  background: var(--rule);
  border: 1px solid var(--rule);
  margin: 26px 0 34px;
}
.fact { background: var(--surface); padding: 13px 14px; }
.fact-v {
  font-family: var(--serif);
  font-size: 25px;
  font-weight: 700;
  line-height: 1.1;
  font-variant-numeric: tabular-nums;
  color: var(--accent);
}
.fact-k { font-size: 12.5px; font-weight: 500; margin-top: 3px; }
.fact-n { font-size: 11px; color: var(--ink-mute); line-height: 1.4; margin-top: 1px; }

/* 标题 */
.doc h2 {
  font-family: var(--serif);
  font-size: 25px;
  font-weight: 700;
  line-height: 1.3;
  margin: 56px 0 14px;
  padding-top: 22px;
  border-top: 1px solid var(--rule);
  text-wrap: balance;
  scroll-margin-top: 20px;
}
.doc h3 {
  font-family: var(--sans);
  font-size: 17.5px;
  font-weight: 700;
  margin: 34px 0 10px;
  text-wrap: balance;
  scroll-margin-top: 20px;
}
.doc h4 {
  font-size: 15px;
  font-weight: 700;
  color: var(--accent);
  margin: 26px 0 8px;
  scroll-margin-top: 20px;
}
.doc h1 { display: none; }

.anchor {
  float: left;
  margin-left: -1.1em;
  width: 1.1em;
  color: var(--rule);
  text-decoration: none;
  font-family: var(--mono);
  font-weight: 400;
  opacity: 0;
  transition: opacity .12s;
}
h2:hover .anchor, h3:hover .anchor, h4:hover .anchor { opacity: 1; }
.anchor:hover { color: var(--accent); }

.doc p { margin: 0 0 14px; }
.doc ul, .doc ol { margin: 0 0 16px; padding-left: 1.35em; }
.doc li { margin-bottom: 5px; }
.doc li::marker { color: var(--ink-mute); }

.doc a { color: var(--accent); text-decoration-thickness: 1px; text-underline-offset: 2px; }

.doc strong { font-weight: 700; }

.doc hr { border: none; border-top: 1px solid var(--rule); margin: 40px 0; }

.doc blockquote {
  margin: 18px 0;
  padding: 2px 0 2px 16px;
  border-left: 3px solid var(--accent);
  color: var(--ink-soft);
}

/* 代码 */
.doc code {
  font-family: var(--mono);
  font-size: .86em;
  background: var(--surface-2);
  border: 1px solid var(--rule-soft);
  border-radius: 3px;
  padding: .1em .38em;
  word-break: break-word;
}
.doc pre {
  background: var(--surface-2);
  border: 1px solid var(--rule);
  border-radius: 5px;
  padding: 14px 16px;
  overflow-x: auto;
  margin: 0 0 18px;
  line-height: 1.6;
}
.doc pre code { background: none; border: none; padding: 0; font-size: 12.5px; }

/* 表格 */
.table-wrap {
  overflow-x: auto;
  margin: 0 0 20px;
  border: 1px solid var(--rule);
  border-radius: 5px;
  background: var(--surface);
}
.doc table { border-collapse: collapse; width: 100%; font-size: 13.5px; }
.doc th {
  text-align: left;
  font-weight: 700;
  font-size: 11.5px;
  letter-spacing: .06em;
  text-transform: uppercase;
  color: var(--ink-mute);
  padding: 9px 13px;
  border-bottom: 1px solid var(--rule);
  background: var(--surface-2);
  white-space: nowrap;
}
.doc td {
  padding: 9px 13px;
  border-bottom: 1px solid var(--rule-soft);
  vertical-align: top;
  line-height: 1.6;
}
.doc tbody tr:last-child td { border-bottom: none; }
.doc td code { font-size: 12px; white-space: nowrap; }

/* 移动端 */
@media (max-width: 900px) {
  .shell { flex-direction: column; }
  .rail {
    position: static;
    flex: none;
    width: 100%;
    height: auto;
    max-height: none;
    border-right: none;
    border-bottom: 1px solid var(--rule);
    padding: 22px 20px;
  }
  .rail nav ol {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 0;
  }
  .doc { padding: 30px 20px 0; }
}

@media (prefers-reduced-motion: reduce) {
  * { animation: none !important; transition: none !important; scroll-behavior: auto !important; }
}

:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 2px; }

html { scroll-behavior: smooth; }
</style>

<div class="shell">
  <aside class="rail">
    <div class="brand">
      <div class="brand-mark">产品需求文档</div>
      <div class="brand-name">AI for PS</div>
      <div class="brand-meta">v1.0.0 · 2026-08-22</div>
    </div>
    <nav aria-label="章节目录">
      <ol>
${nav}
      </ol>
    </nav>
  </aside>

  <main>
    <div class="doc">
      <header class="masthead">
        <div class="eyebrow">Photoshop UXP 插件 + 本机 Helper</div>
        <h1>在 Photoshop 里直接调度 AI 生图的电商视觉工作台</h1>
        <p>设计师不离开 Photoshop，就能把当前图层或选区送进本地 ComfyUI 或云端模型，拿回结果并安全写回画布。</p>
      </header>

      <div class="facts">
${factHtml}
      </div>

${body}
    </div>
  </main>
</div>

<script>
// 侧栏高亮跟随阅读位置
const links = [...document.querySelectorAll('.rail nav a')];
const targets = links
  .map((a) => document.getElementById(a.dataset.target))
  .filter(Boolean);

const setActive = (id) => {
  for (const a of links) a.classList.toggle('active', a.dataset.target === id);
};

if ('IntersectionObserver' in window && targets.length) {
  const seen = new Map();
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) seen.set(e.target.id, e.isIntersecting ? e.boundingClientRect.top : Infinity);
      const visible = targets.filter((t) => seen.get(t.id) !== Infinity && seen.has(t.id));
      if (visible.length) setActive(visible[0].id);
    },
    { rootMargin: '0px 0px -75% 0px', threshold: 0 }
  );
  for (const t of targets) io.observe(t);
  setActive(targets[0].id);
}
</script>
`;

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT, html, 'utf8');
console.log(`PRD-ARTIFACT-OK  ${OUT}`);
console.log(`  章节 ${chapters.length} 个 · ${(html.length / 1024).toFixed(0)}KB · 功能表行 ${featureCount}`);
