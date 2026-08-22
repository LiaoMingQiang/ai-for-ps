/**
 * 用功能目录重新生成 PRD 的 §4.2（ComfyUI 固定功能）与附录 A。
 *
 * 这两段是纯参数表，手写必然和 catalog.ts 漂移，而漂移的 PRD 比没有 PRD 更坏。
 * 其余章节是人写的分析与规格，脚本不碰。
 *
 * 用法：node tools/sync-prd-features.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PRD = resolve(here, '../docs/PRD.md');
const WF_ROOT = resolve(here, '../workflows');

const { fixedComfyFeatures, allFeatures, breadcrumb, findFeature, WRITEBACK_MODE_LABELS, SEED_MODE_LABELS } =
  await import(pathToFileURL(resolve(here, '../packages/shared/dist/index.js')).href);

const BEGIN = '<!-- BEGIN:GENERATED-FEATURES -->';
const END = '<!-- END:GENERATED-FEATURES -->';
const BEGIN_A = '<!-- BEGIN:GENERATED-APPENDIX-A -->';
const END_A = '<!-- END:GENERATED-APPENDIX-A -->';

function bindingsOf(workflowId) {
  try {
    return JSON.parse(readFileSync(join(WF_ROOT, workflowId, 'binding.json'), 'utf8')).bindings;
  } catch {
    return [];
  }
}

function transformNote(t) {
  if (!t) return '';
  switch (t.type) {
    case 'linear':
      return `映射到 ${t.outMin}–${t.outMax}`;
    case 'appendText':
      return '追加到提示词';
    case 'sizeWidth':
      return '推导宽';
    case 'sizeHeight':
      return '推导高';
    case 'number':
      return '转数字';
    default:
      return t.type;
  }
}

/** 参数 → 它在工作流里的落点，写进表格最后一列。 */
function landingOf(bindings, paramId) {
  const hits = bindings.filter((b) => b.paramId === paramId);
  if (hits.length === 0) return '—';
  return hits
    .map((b) => {
      const note = transformNote(b.transform);
      return `\`${b.nodeId}.${b.input}\`${note ? ` · ${note}` : ''}`;
    })
    .join('<br>');
}

function rangeOf(p) {
  switch (p.kind) {
    case 'slider':
      return `${p.min}–${p.max}，步 ${p.step}`;
    case 'resolution':
      return `${p.min}–${p.max}，步 ${p.step}`;
    case 'seed':
      return '0–4294967295';
    case 'select':
    case 'segmented':
      return p.options.map((o) => `\`${o.value}\``).join(' / ');
    case 'toggle':
      return '开 / 关';
    case 'camera':
      return '水平 −180°–180° · 垂直 −90°–90°';
    case 'image':
      return p.sources.map((s) => s).join(' / ');
    case 'imageList':
      return `${p.min}–${p.max} 张`;
    default:
      return '—';
  }
}

function defaultOf(p) {
  switch (p.kind) {
    case 'slider':
    case 'resolution':
      return String(p.defaultValue);
    case 'seed':
      return SEED_MODE_LABELS[p.defaultValue.mode];
    case 'select':
    case 'segmented':
      return `\`${p.defaultValue}\``;
    case 'toggle':
      return p.defaultValue ? '开' : '关';
    case 'camera':
      return '0° / 0°';
    case 'prompt':
    case 'negativePrompt':
      return p.defaultValue ? `\`${p.defaultValue}\`` : '空';
    case 'image':
      return p.defaultSource;
    case 'imageList':
      return '空';
    default:
      return '—';
  }
}

function kindLabel(p) {
  const map = {
    image: '图像输入',
    imageList: '图像列表',
    prompt: '多行文本 + ✨优化',
    negativePrompt: '多行文本',
    seed: '三态 + 数值',
    slider: '滑杆',
    select: '下拉',
    segmented: '分段',
    toggle: '开关',
    aspect: '比例选择器',
    resolution: '滑杆',
    camera: '3D 立方体',
    model: '下拉',
    text: '文本'
  };
  return map[p.kind] ?? p.kind;
}

/* ---------------- §4.2 ---------------- */

const out = [];
out.push('');
out.push(
  '> 以下 11 节由 `node tools/sync-prd-features.mjs` 从 `packages/shared/src/catalog.ts` 与 `psai/workflows/` 生成，'
);
out.push('> 保证参数表与代码、与实际工作流绑定三者永不漂移。不要手工编辑这一段。');
out.push('');
out.push('**关于「转不动的旋钮」**：参考图谱把「真实感 / 光影 / 强度」画成一排共享参数，');
out.push('但同一个滑杆在不同功能里未必都有对应的节点输入。摆一个调了不起作用的控件比不摆更糟，');
out.push('因此每个功能只保留能真正接上的那几个，每张表的「落点」列写明它接到了工作流的哪个节点输入。');
out.push('完整映射见 [WORKFLOWS.md](WORKFLOWS.md)。');
out.push('');

const features = fixedComfyFeatures();
features.forEach((f, i) => {
  const crumbs = breadcrumb(f.id);
  const bindings = bindingsOf(f.defaultWorkflowId);

  out.push(`#### 4.2.${i + 1} ${crumbs.slice(2).join(' / ')} \`${f.id}\``);
  out.push('');
  out.push(`- **入口**：${crumbs.join(' → ')}`);
  out.push(`- **说明**：${f.description}`);
  const imgs = f.params.filter((p) => p.kind === 'image' || p.kind === 'imageList');
  out.push(
    `- **输入**：${imgs.map((p) => `${p.label}（${p.required === false ? '可选' : '必需'}，默认取${p.kind === 'image' ? p.defaultSource : '上传'}）`).join('；') || '无'}`
  );
  out.push(`- **内置工作流**：\`${f.defaultWorkflowId}\``);
  out.push(`- **依赖节点**：${f.requiredNodeTypes.map((n) => `\`${n}\``).join('、')}`);
  out.push('');
  out.push('| 参数 | 控件 | 取值 | 默认 | 落点 |');
  out.push('|---|---|---|---|---|');
  for (const p of f.params) {
    const adv = p.advanced ? '（高级）' : '';
    out.push(
      `| ${p.label} \`${p.id}\` | ${kindLabel(p)}${adv} | ${rangeOf(p)} | ${defaultOf(p)} | ${landingOf(bindings, p.id)} |`
    );
  }
  out.push('');
  out.push(`- **写回**：${f.writeback.modes.map((m) => WRITEBACK_MODE_LABELS[m]).join(' / ')}（默认${WRITEBACK_MODE_LABELS[f.writeback.default]}）`);
  out.push('- **验收标准**：');
  f.acceptance.forEach((a, n) => out.push(`  ${n + 1}. ${a}`));
  out.push('');
});

/* ---------------- 附录 A ---------------- */

const appendix = [];
appendix.push('');
appendix.push('| 功能 ID | 路径 | 引擎 | 内置工作流 | 参数数 |');
appendix.push('|---|---|---|---|---|');
for (const f of allFeatures()) {
  appendix.push(
    `| \`${f.id}\` | ${breadcrumb(f.id).join('/')} | ${f.engine} | ${f.defaultWorkflowId ? `\`${f.defaultWorkflowId}\`` : '—'} | ${f.params.length} |`
  );
}
appendix.push('');

/* ---------------- 写回 PRD ---------------- */

let md = readFileSync(PRD, 'utf8');

function splice(text, begin, end, body, anchorRegex) {
  if (text.includes(begin) && text.includes(end)) {
    const a = text.indexOf(begin) + begin.length;
    const b = text.indexOf(end);
    return text.slice(0, a) + '\n' + body.join('\n') + '\n' + text.slice(b);
  }
  const m = anchorRegex.exec(text);
  if (!m) throw new Error(`找不到插入锚点: ${anchorRegex}`);
  return (
    text.slice(0, m.index) + begin + '\n' + body.join('\n') + '\n' + end + '\n\n' + text.slice(m.index)
  );
}

// §4.2 的正文替换：从 "#### 4.2.1" 到 "### 4.3"
if (md.includes(BEGIN)) {
  md = splice(md, BEGIN, END, out, /### 4\.3 /);
} else {
  const startIdx = md.indexOf('#### 4.2.1');
  const endIdx = md.indexOf('### 4.3 ');
  if (startIdx < 0 || endIdx < 0) throw new Error('找不到 §4.2 的边界');
  md = md.slice(0, startIdx) + BEGIN + '\n' + out.join('\n') + '\n' + END + '\n\n' + md.slice(endIdx);
}

// 附录 A
if (md.includes(BEGIN_A)) {
  md = splice(md, BEGIN_A, END_A, appendix, /## 附录 B /);
} else {
  const startIdx = md.indexOf('## 附录 A · 功能与参数索引');
  const endIdx = md.indexOf('## 附录 B ');
  if (startIdx < 0 || endIdx < 0) throw new Error('找不到附录 A 的边界');
  const heading = '## 附录 A · 功能与参数索引\n\n';
  md =
    md.slice(0, startIdx) + heading + BEGIN_A + '\n' + appendix.join('\n') + '\n' + END_A + '\n\n' + md.slice(endIdx);
}

writeFileSync(PRD, md, 'utf8');
console.log(`PRD-SYNC-OK  §4.2 (${features.length} 个功能) 与附录 A (${allFeatures().length} 条) 已与 catalog 同步`);
