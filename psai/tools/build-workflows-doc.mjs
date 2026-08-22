/**
 * 从 workflows/ 与功能目录生成 docs/WORKFLOWS.md。
 * 生成而不是手写：参数映射表一旦和实际绑定不一致，就是骗人的文档。
 *
 * 用法：node tools/build-workflows-doc.mjs
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const WF_ROOT = resolve(here, '../workflows');
const OUT = resolve(here, '../docs/WORKFLOWS.md');
const MEASURED = resolve(here, '.artifacts/workflows-timing.json');

const { fixedComfyFeatures, breadcrumb } = await import(
  pathToFileURL(resolve(here, '../packages/shared/dist/index.js')).href
);

const timing = existsSync(MEASURED) ? JSON.parse(readFileSync(MEASURED, 'utf8')) : {};

function load(id) {
  const dir = join(WF_ROOT, id);
  return {
    graph: JSON.parse(readFileSync(join(dir, 'graph.json'), 'utf8')),
    bindings: JSON.parse(readFileSync(join(dir, 'binding.json'), 'utf8')).bindings,
    meta: JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
  };
}

function describeTransform(t) {
  if (!t) return '直连';
  switch (t.type) {
    case 'linear':
      return `线性映射 ${t.inMin}–${t.inMax} → ${t.outMin}–${t.outMax}`;
    case 'appendText':
      return '追加到已有文本后';
    case 'sizeWidth':
      return '取推导出的宽';
    case 'sizeHeight':
      return '取推导出的高';
    case 'number':
      return '转为数字';
    case 'int':
      return '取整';
    case 'const':
      return `固定为 ${JSON.stringify(t.value)}`;
    case 'not':
      return '布尔取反';
    default:
      return t.type;
  }
}

const features = fixedComfyFeatures();

const lines = [];
lines.push('# 内置工作流');
lines.push('');
lines.push(
  '本文件由 `node tools/build-workflows-doc.mjs` 生成，数据来自 `psai/workflows/` 下的实际文件，不要手工编辑。'
);
lines.push('');
lines.push('## 为什么每个滑杆都必须有落点');
lines.push('');
lines.push(
  '参考图谱把「真实感 / 光影 / 强度」画成一排共享参数，看上去每个功能都该有这三个滑杆。'
);
lines.push(
  '但同一个滑杆在不同功能里未必都有对应的节点输入 —— 摆一个转不动的旋钮，比不摆更糟：用户会以为自己调了，实际什么也没发生。'
);
lines.push('');
lines.push(
  '所以这里的规则是：**功能声明的每个参数，都必须在它绑定的工作流里落到某个真实的节点输入上**。'
);
lines.push(
  '`packages/helper/test/builtin-workflows.test.mjs` 里的「面板上没有转不动的旋钮」这条测试会强制这一点。'
);
lines.push('');
lines.push('语义滑杆到节点输入的映射：');
lines.push('');
lines.push('| 滑杆 | 落到哪 | 映射区间 | 为什么这么接 |');
lines.push('|---|---|---|---|');
lines.push('| 真实感 | `KSampler.cfg` | 0–1 → 4.5–9 | 工作流的正向提示词里埋了写实细节词，CFG 越高越贴合这组词 |');
lines.push('| 质感强度 | `KSampler.cfg` | 0–1 → 5–10 | 同上，提示词种子换成材质微结构 |');
lines.push('| 光影 | `ICLightConditioning.multiplier` | 0–1 → 0.1–1.0 | IC-Light 自己就有重打光强度这个输入 |');
lines.push('| 精修强度 | `KSampler.denoise` | 0–1 → 0.05–0.5 | 精修就是低幅度重绘，量程收窄保证不会把画面重画 |');
lines.push('| 视角改动幅度 | `KSampler.denoise` | 0–1 → 0.4–0.95 | 改机位需要较高幅度才推得动 |');
lines.push('| 重绘幅度 | `KSampler.denoise` | 直连 | |');
lines.push('| 分辨率 | `ImageScale.width/height` | 按输入图比例推导 | 图生图保持原始长宽比，只把长边缩到该值 |');
lines.push('| 放大倍数 | `ImageScaleBy.scale_by` | 转为数字 | 分段控件的值是字符串 |');
lines.push('| 摄像机 | 正向提示词节点 | 追加 | 机位翻译成英文片段拼在用户提示词后，不覆盖 |');
lines.push('');
lines.push('## 出厂模型');
lines.push('');
lines.push('全部基于 SD1.5 系：显存友好、出图快，而且 IC-Light 只支持 SD1.5。');
lines.push('');
lines.push('| 用途 | 模型 |');
lines.push('|---|---|');
lines.push('| 写实（人像 / 产品 / 精修 / 放大 / 视角） | `majicmix_realistic_v7.safetensors` |');
lines.push('| 重打光底模 | `v1-5-pruned-emaonly-fp16.safetensors` + `IC-Light\\iclight_sd15_fbc.safetensors` |');
lines.push('');
lines.push(
  '换模型：在「设置 → 工作流」里改对应工作流的 `ckpt_name`，或者导入自己的工作流再到「设置 → 固定功能」重新绑定。'
);
lines.push('');
lines.push('## 清单');
lines.push('');
lines.push('| 功能 | 工作流 | 节点数 | 绑定数 | 实测 |');
lines.push('|---|---|---|---|---|');
for (const f of features) {
  const { graph, bindings } = load(f.defaultWorkflowId);
  const t = timing[f.id];
  lines.push(
    `| ${breadcrumb(f.id).slice(1).join(' / ')} | \`${f.defaultWorkflowId}\` | ${Object.keys(graph).length} | ${bindings.length} | ${t ? `${t.size} · ${t.secs}s` : '—'} |`
  );
}
lines.push('');

for (const f of features) {
  const { graph, bindings, meta } = load(f.defaultWorkflowId);
  lines.push(`## ${breadcrumb(f.id).slice(1).join(' / ')}`);
  lines.push('');
  lines.push(`- **功能 ID**：\`${f.id}\``);
  lines.push(`- **工作流**：\`${meta.id}\` v${meta.version}`);
  lines.push(`- **说明**：${meta.notes}`);
  lines.push('');
  lines.push('### 节点');
  lines.push('');
  lines.push('| ID | 类型 | 标题 |');
  lines.push('|---|---|---|');
  for (const [id, node] of Object.entries(graph)) {
    lines.push(`| \`${id}\` | \`${node.class_type}\` | ${node._meta?.title ?? ''} |`);
  }
  lines.push('');
  lines.push('### 参数绑定');
  lines.push('');
  lines.push('| 参数 | 节点.输入 | 变换 | 必填 |');
  lines.push('|---|---|---|---|');
  for (const b of bindings) {
    const label = f.params.find((p) => p.id === b.paramId)?.label ?? b.paramId;
    lines.push(
      `| ${label} \`${b.paramId}\` | \`${b.nodeId}.${b.input}\` | ${describeTransform(b.transform)} | ${b.required ? '是' : '否'} |`
    );
  }
  lines.push('');
}

lines.push('---');
lines.push('');
lines.push('## 验证方式');
lines.push('');
lines.push('```bash');
lines.push('npm test                      # 静态校验：绑定落点、依赖声明、无死旋钮');
lines.push('npm run test:workflows:real   # 逐个提交到真实 ComfyUI，确认都出得来图');
lines.push('```');
lines.push('');

writeFileSync(OUT, lines.join('\n'), 'utf8');
console.log(`WORKFLOWS-DOC-OK  ${OUT}  (${lines.length} 行 · ${features.length} 个功能)`);
