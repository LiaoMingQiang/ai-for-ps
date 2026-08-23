/**
 * 对着真实的 RunningHub API 校验内置云端工作流预设。
 *
 * 内置预设写的是**别人账号下的公开工作流**的节点号。作者随时可能改图，
 * 一改我们的 nodeInfoList 就会打到不存在的节点上 —— RunningHub 不会报错，
 * 它只是默默忽略那条覆盖，于是用户拿到一张「参数全都没生效」的图。
 * 这是最难被发现的一类失败，所以必须主动去比对。
 *
 * 每个预设逐条检查：
 *   1. workflowId 还能拉到图（没被删/没转私有）
 *   2. 每个 binding 的 nodeId 存在
 *   3. 该节点确实有这个字段，且是标量（不是从别的节点连过来的链接）
 *   4. outputNodeIds 存在且是出图节点
 *   5. needsMask 与图里 LoadImage 的 MASK 输出实际用法一致
 *
 * 用法：
 *   RUNNINGHUB_API_KEY=xxx node tools/verify-runninghub.mjs
 *   node tools/verify-runninghub.mjs --from-helper   （从本机 Helper 借已存的密钥）
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'https://www.runninghub.cn';

const IMAGE_OUT = new Set(['SaveImage', 'PreviewImage', 'Image Save', 'SaveImageWebsocket']);

/** 从 TS 源里读预设，避免为了跑一个校验脚本先把 shared 编译一遍。 */
async function loadPresets() {
  const src = readFileSync(resolve(root, 'packages/shared/src/runninghub.ts'), 'utf8');
  // 把 TS 直接改成可执行的 mjs：去掉类型层，保留数据与两个纯函数
  const js = src
    .replace(/^import type[\s\S]*?;$/m, '')
    .replace(/^export type RhCategory[\s\S]*?;$/m, '')
    .replace(/^export interface RunningHubPreset \{[\s\S]*?^\}$/m, '')
    .replace(/: readonly RunningHubPreset\[\]/g, '')
    .replace(/: Record<RhCategory, string>/g, '')
    .replace(/\(paramId: string, nodeId: string, input: string, required = false\): ParamBinding/g,
      '(paramId, nodeId, input, required = false)')
    .replace(/\(id: string\): RunningHubPreset \| null/g, '(id)')
    .replace(/\(workflowId: string\): RunningHubPreset \| null/g, '(workflowId)')
    .replace(/\(featureId: string\): RunningHubPreset\[\]/g, '(featureId)')
    .replace(/\(workflowId: string\): string/g, '(workflowId)');
  const mod = await import(
    'data:text/javascript;base64,' + Buffer.from(js, 'utf8').toString('base64')
  );
  return mod.RUNNINGHUB_PRESETS;
}

function apiKey() {
  const fromEnv = process.env['RUNNINGHUB_API_KEY'];
  if (fromEnv) return fromEnv.trim();
  return null;
}

async function keyFromHelper() {
  const port = process.env['PSAI_HELPER_PORT'] ?? '34117';
  const token = process.env['PSAI_HELPER_TOKEN'];
  if (!token) return null;
  const r = await fetch(`http://127.0.0.1:${port}/v1/providers/runninghub/credentials/reveal`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` }
  }).catch(() => null);
  if (!r || !r.ok) return null;
  const j = await r.json().catch(() => null);
  return j?.apiKey ?? null;
}

async function fetchGraph(key, workflowId) {
  const r = await fetch(`${BASE}/api/openapi/getJsonApiFormat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Host: 'www.runninghub.cn' },
    body: JSON.stringify({ apiKey: key, workflowId }),
    signal: AbortSignal.timeout(30000)
  });
  const j = await r.json();
  if (j.code !== 0) return { ok: false, msg: `${j.code} ${j.msg}` };
  try {
    return { ok: true, graph: JSON.parse(j.data.prompt) };
  } catch {
    return { ok: false, msg: 'prompt 不是合法 JSON' };
  }
}

/**
 * 已知会把文本吞掉的节点类型。
 *
 * 目前只列了实测证实的：ArgosTranslateTextNode 在 RunningHub 上不工作，
 * 提交后节点输出空串。其余第三方翻译/反推节点没有实测过，不臆断、不入表；
 * 谁踩到了再加，每加一条都要附上是怎么证实的。
 * RunningHub 自家的 RH_Translator / RH_Captioner / RH_Prompter 实测可用，不在此列。
 */
const TEXT_EATERS = [/^ArgosTranslate/i];

/**
 * 从某个节点顺着连线往下走，看能不能走到 CLIPTextEncode。
 * 返回 null 表示走不到；否则返回沿途遇到的可疑节点。
 */
function pathToTextEncoder(graph, startId) {
  // 反向索引：nodeId → 消费它的 [消费者 id, 消费者节点]
  const consumers = new Map();
  for (const [id, node] of Object.entries(graph)) {
    for (const v of Object.values(node.inputs ?? {})) {
      if (!Array.isArray(v)) continue;
      const src = String(v[0]);
      if (!consumers.has(src)) consumers.set(src, []);
      consumers.get(src).push([id, node]);
    }
  }

  const seen = new Set();
  const risky = [];
  const queue = [startId];
  let reached = false;
  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    const node = graph[id];
    if (!node) continue;
    const ct = node.class_type ?? '';
    if (id !== startId && /CLIPTextEncode/i.test(ct)) {
      reached = true;
      continue;
    }
    if (TEXT_EATERS.some((re) => re.test(ct))) risky.push(`${id}(${ct})`);
    for (const [cid] of consumers.get(id) ?? []) queue.push(cid);
  }
  // 绑定点本身就是 CLIPTextEncode 也算到达
  if (/CLIPTextEncode/i.test(graph[startId]?.class_type ?? '')) reached = true;
  return reached ? { risky } : null;
}

function checkPreset(p, graph) {
  const problems = [];
  const notes = [];
  const count = Object.keys(graph).length;
  if (count !== p.nodeCount) {
    notes.push(`节点数 ${p.nodeCount} → ${count}（作者改过图，绑定需要复核）`);
  }

  for (const bind of p.bindings) {
    const node = graph[bind.nodeId];
    if (!node) {
      problems.push(`绑定 ${bind.paramId} 指向节点 ${bind.nodeId}，云端已无此节点`);
      continue;
    }
    if (!(bind.input in (node.inputs ?? {}))) {
      problems.push(
        `节点 ${bind.nodeId}(${node.class_type}) 没有字段 ${bind.input}（${bind.paramId}）`
      );
      continue;
    }
    if (Array.isArray(node.inputs[bind.input])) {
      problems.push(
        `节点 ${bind.nodeId}(${node.class_type}).${bind.input} 现在是连线输入，覆盖标量会被忽略（${bind.paramId}）`
      );
    }
  }

  for (const outId of p.outputNodeIds) {
    const node = graph[outId];
    if (!node) problems.push(`出图节点 ${outId} 不存在`);
    else if (!IMAGE_OUT.has(node.class_type)) problems.push(`节点 ${outId} 是 ${node.class_type}，不是出图节点`);
  }

  // 提示词必须能顺着连线走到文本编码器。
  //
  // 这条检查是拿真金白银换来的：早先的预设把提示词接在 ArgosTranslateTextNode 上，
  // 那个第三方节点在 RunningHub 环境里不工作、输出空串，任务照样"成功"，
  // 出来的却是 Flux 拿空提示词乱画的图。接口全绿，只有看图才发现提示词没生效。
  for (const bind of p.bindings) {
    if (bind.paramId !== 'prompt' && bind.paramId !== 'negativePrompt') continue;
    const path = pathToTextEncoder(graph, bind.nodeId);
    if (!path) {
      problems.push(
        `${bind.paramId} 绑在节点 ${bind.nodeId}(${graph[bind.nodeId]?.class_type})，但顺着连线走不到任何 CLIPTextEncode ——` +
          ` 这个提示词不会生效，任务却会"成功"出一张与提示词无关的图`
      );
    } else if (path.risky.length) {
      problems.push(
        `${bind.paramId} 从节点 ${bind.nodeId} 到文本编码器要经过 ${path.risky.join(' / ')}，` +
          ` 这类节点在 RunningHub 上会把文本吞掉，请换一个提示词直连 CLIPTextEncode 的工作流`
      );
    }
  }

  // needsMask 与图里的实际用法对齐
  const loadIds = Object.entries(graph)
    .filter(([, n]) => n.class_type === 'LoadImage')
    .map(([i]) => i);
  let usesMask = false;
  for (const n of Object.values(graph)) {
    for (const v of Object.values(n.inputs ?? {})) {
      if (Array.isArray(v) && loadIds.includes(String(v[0])) && v[1] === 1) usesMask = true;
    }
  }
  if (usesMask !== p.needsMask) {
    problems.push(
      `needsMask 标成 ${p.needsMask}，但云端图里 LoadImage 的 MASK 输出${usesMask ? '被用到了' : '并没有被用到'}`
    );
  }

  return { problems, notes };
}

/* ------------------------------ main ------------------------------ */

const wantHelper = process.argv.includes('--from-helper');
const key = apiKey() ?? (wantHelper ? await keyFromHelper() : null);
if (!key) {
  console.error(
    '没有 RunningHub API Key。设置环境变量 RUNNINGHUB_API_KEY 后重跑；\n' +
      '这个校验必须打真实接口，没有 key 就跳过，绝不假装通过。'
  );
  process.exit(2);
}

const presets = await loadPresets();
console.log(`校验 ${presets.length} 条 RunningHub 内置预设（真实接口）\n`);

let failed = 0;
let changed = 0;
for (const p of presets) {
  const g = await fetchGraph(key, p.workflowId);
  if (!g.ok) {
    console.error(`FAIL  ${p.id.padEnd(22)} ${p.workflowId}  拉不到工作流：${g.msg}`);
    failed++;
    continue;
  }
  const { problems, notes } = checkPreset(p, g.graph);
  if (problems.length) {
    console.error(`FAIL  ${p.id.padEnd(22)} ${p.workflowId}  ${p.label}`);
    for (const x of problems) console.error(`        · ${x}`);
    failed++;
  } else {
    console.log(
      `OK    ${p.id.padEnd(22)} ${p.workflowId}  ${String(p.bindings.length).padStart(2)} 条绑定全部命中  ${p.label}`
    );
  }
  for (const n of notes) {
    console.log(`      注意 ${n}`);
    changed++;
  }
}

console.log('');
if (failed) {
  console.error(`${failed}/${presets.length} 条预设校验不通过 —— 云端工作流已变化，必须重新核对绑定后再发版。`);
  process.exit(1);
}
console.log(`全部 ${presets.length} 条预设与云端一致${changed ? `（${changed} 条有非致命变化，见上）` : ''}。`);
