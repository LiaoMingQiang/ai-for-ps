/**
 * 工作流扫描器：识别格式、找输出节点、扫可绑定字段、推断语义、给出绑定建议。
 *
 * UI 格式（ComfyUI 界面导出的那种）→ API 格式的转换需要节点的输入顺序，
 * 而输入顺序只有 /object_info 知道。所以没有可用的 ComfyUI 时，
 * 我们如实告诉用户"请导出 API 格式"，而不是猜一个可能跑不通的图。
 */

import { PsaiError } from '@psai/shared';
import type { ComfyApiGraph, ScanResult, ScannedField, ScannedSemantic, ParamBinding } from '@psai/shared';

const OUTPUT_CLASSES = new Set(['SaveImage', 'PreviewImage', 'SaveImageWebsocket', 'SaveAnimatedWEBP', 'SaveAnimatedPNG']);

const MODEL_INPUTS: Record<string, string> = {
  ckpt_name: 'checkpoint',
  lora_name: 'lora',
  model_name: 'upscale',
  control_net_name: 'controlnet',
  vae_name: 'vae',
  clip_name: 'clip',
  unet_name: 'unet',
  style_model_name: 'style_model'
};

export function detectFormat(json: unknown): 'api' | 'ui' | 'unknown' {
  if (!json || typeof json !== 'object') return 'unknown';
  const obj = json as Record<string, unknown>;
  if (Array.isArray(obj['nodes']) && (Array.isArray(obj['links']) || Array.isArray(obj['extra']))) return 'ui';
  const values = Object.values(obj);
  if (values.length === 0) return 'unknown';
  const looksApi = values.every(
    (v) => !!v && typeof v === 'object' && typeof (v as Record<string, unknown>)['class_type'] === 'string'
  );
  return looksApi ? 'api' : 'unknown';
}

/* ---------------- UI → API ---------------- */

interface UiNode {
  id: number | string;
  type: string;
  title?: string;
  widgets_values?: unknown[];
  inputs?: Array<{ name: string; link: number | null; widget?: { name: string } }>;
  mode?: number;
}

interface UiGraph {
  nodes: UiNode[];
  links?: Array<[number, number | string, number, number | string, number, string]>;
}

/** 从 /object_info 里取某个节点类型的输入名顺序（必填在前，可选在后）。 */
export type ObjectInfo = Record<string, unknown>;

function widgetInputNames(objectInfo: ObjectInfo, classType: string): string[] {
  const node = objectInfo[classType] as
    | { input?: { required?: Record<string, unknown>; optional?: Record<string, unknown> }; input_order?: Record<string, string[]> }
    | undefined;
  if (!node?.input) return [];
  const order: string[] = [];
  const push = (group: Record<string, unknown> | undefined, names?: string[]): void => {
    if (!group) return;
    const keys = names ?? Object.keys(group);
    for (const k of keys) {
      const spec = group[k];
      // 连线型输入（值是单个类型字符串，如 "MODEL"）不占 widget 位
      if (Array.isArray(spec)) {
        const first = spec[0];
        if (Array.isArray(first)) {
          order.push(k); // 枚举下拉
        } else if (typeof first === 'string' && /^(INT|FLOAT|STRING|BOOLEAN)$/.test(first)) {
          order.push(k);
          // 带 control_after_generate 的整数会额外多占一个 widget 位
          const opts = spec[1] as Record<string, unknown> | undefined;
          if (opts && opts['control_after_generate']) order.push(`${k}__control`);
        }
      }
    }
  };
  push(node.input.required, node.input_order?.['required']);
  push(node.input.optional, node.input_order?.['optional']);
  return order;
}

export function convertUiToApi(json: unknown, objectInfo: ObjectInfo | null): ComfyApiGraph {
  const ui = json as UiGraph;
  if (!Array.isArray(ui.nodes)) throw new PsaiError('WORKFLOW_INVALID_JSON', 'UI 格式缺少 nodes 数组');
  if (!objectInfo || Object.keys(objectInfo).length === 0) {
    throw new PsaiError(
      'WORKFLOW_INVALID_JSON',
      'UI 格式的工作流需要连接 ComfyUI 才能转换（要读取节点输入顺序）。请先连上 ComfyUI，或在 ComfyUI 里用「导出(API)」再导入。'
    );
  }

  // link id → [来源节点 id, 来源槽位]
  const linkMap = new Map<number, [string, number]>();
  for (const l of ui.links ?? []) {
    if (!Array.isArray(l) || l.length < 3) continue;
    linkMap.set(Number(l[0]), [String(l[1]), Number(l[2])]);
  }

  const out: ComfyApiGraph = {};
  for (const n of ui.nodes) {
    // mode 4 = 静音, mode 2 = 绕过；这些节点不进 API 图
    if (n.mode === 2 || n.mode === 4) continue;
    if (n.type === 'Note' || n.type === 'Reroute' || n.type === 'PrimitiveNode') continue;

    const inputs: Record<string, unknown> = {};

    // 1. 连线输入
    for (const inp of n.inputs ?? []) {
      if (inp.link === null || inp.link === undefined) continue;
      const src = linkMap.get(Number(inp.link));
      if (src) inputs[inp.name] = [src[0], src[1]];
    }

    // 2. widget 输入按顺序回填
    const names = widgetInputNames(objectInfo, n.type);
    const values = n.widgets_values ?? [];
    if (Array.isArray(values)) {
      for (let i = 0, vi = 0; i < names.length && vi < values.length; i++) {
        const name = names[i]!;
        const v = values[vi++];
        if (name.endsWith('__control')) continue; // control_after_generate，不进 API
        if (name in inputs) continue; // 已被连线占用
        inputs[name] = v;
      }
    }

    out[String(n.id)] = {
      class_type: n.type,
      inputs,
      ...(n.title ? { _meta: { title: n.title } } : {})
    };
  }

  if (Object.keys(out).length === 0) throw new PsaiError('WORKFLOW_INVALID_JSON', '转换后没有任何节点');
  return out;
}

/* ---------------- 语义推断 ---------------- */

export function inferSemantic(classType: string, input: string, title: string): ScannedSemantic | null {
  const t = `${title} ${classType}`.toLowerCase();
  switch (input) {
    case 'text':
    case 'prompt':
    case 'text_g':
    case 'text_l':
      return /negative|反向|负向/.test(t) ? 'negativePrompt' : 'prompt';
    case 'seed':
    case 'noise_seed':
      return 'seed';
    case 'steps':
      return 'steps';
    case 'cfg':
    case 'guidance':
      return 'cfg';
    case 'denoise':
      return 'denoise';
    case 'sampler_name':
      return 'sampler';
    case 'scheduler':
      return 'scheduler';
    case 'width':
      return 'width';
    case 'height':
      return 'height';
    case 'image':
      return 'image';
    case 'mask':
      return 'mask';
    case 'batch_size':
      return 'batchSize';
    default:
      break;
  }
  const m = MODEL_INPUTS[input];
  if (m === 'checkpoint') return 'checkpoint';
  if (m === 'lora') return 'lora';
  if (m === 'upscale') return 'upscaleModel';
  if (m === 'controlnet') return 'controlnet';
  return null;
}

/* ---------------- 扫描 ---------------- */

export function scanApiGraph(graph: ComfyApiGraph): ScanResult {
  const fields: ScannedField[] = [];
  const outputNodeIds: string[] = [];
  const requiredNodeTypes = new Set<string>();
  const requiredModels: Array<{ kind: string; name: string }> = [];
  const warnings: string[] = [];

  for (const [nodeId, node] of Object.entries(graph)) {
    if (!node || typeof node !== 'object' || typeof node.class_type !== 'string') {
      warnings.push(`节点 ${nodeId} 结构不正确，已跳过`);
      continue;
    }
    requiredNodeTypes.add(node.class_type);
    if (OUTPUT_CLASSES.has(node.class_type)) outputNodeIds.push(nodeId);

    const title = node._meta?.title ?? node.class_type;
    for (const [input, value] of Object.entries(node.inputs ?? {})) {
      // 连线输入不是可绑定字段
      if (Array.isArray(value)) continue;
      const vt = typeof value;
      if (vt !== 'string' && vt !== 'number' && vt !== 'boolean') continue;

      fields.push({
        nodeId,
        classType: node.class_type,
        title,
        input,
        value: value as string | number | boolean,
        valueType: vt as 'string' | 'number' | 'boolean',
        semantic: inferSemantic(node.class_type, input, title)
      });

      const kind = MODEL_INPUTS[input];
      if (kind && typeof value === 'string' && value.trim() !== '') {
        requiredModels.push({ kind, name: value });
      }
    }
  }

  const suggestedBindings = suggestBindings(fields);

  return {
    ok: outputNodeIds.length > 0,
    format: 'api',
    nodeCount: Object.keys(graph).length,
    fields,
    outputNodeIds,
    requiredNodeTypes: [...requiredNodeTypes].sort(),
    requiredModels,
    suggestedBindings,
    warnings
  };
}

/** 语义 → 功能参数 id 的默认映射。 */
const SEMANTIC_TO_PARAM: Partial<Record<ScannedSemantic, string>> = {
  prompt: 'prompt',
  negativePrompt: 'negativePrompt',
  seed: 'seed',
  steps: 'steps',
  cfg: 'cfg',
  denoise: 'denoise',
  sampler: 'sampler',
  scheduler: 'scheduler',
  image: 'image',
  upscaleModel: 'upscaleModel'
};

function suggestBindings(fields: readonly ScannedField[]): ParamBinding[] {
  const out: ParamBinding[] = [];
  const used = new Set<string>();

  for (const f of fields) {
    if (!f.semantic) continue;

    if (f.semantic === 'width' || f.semantic === 'height') {
      out.push({
        paramId: 'resolution',
        nodeId: f.nodeId,
        input: f.input,
        required: false,
        transform: { type: f.semantic === 'width' ? 'sizeWidth' : 'sizeHeight' }
      });
      continue;
    }

    const paramId = SEMANTIC_TO_PARAM[f.semantic];
    if (!paramId) continue;
    // 同一个参数只自动绑一次，多处同名让用户自己在绑定编辑器里决定
    const key = `${paramId}`;
    if (used.has(key)) continue;
    used.add(key);
    out.push({ paramId, nodeId: f.nodeId, input: f.input, required: paramId === 'image' });
  }
  return out;
}

/** 入口：任意 JSON → ScanResult。 */
export function scanWorkflow(json: unknown, objectInfo: ObjectInfo | null): { graph: ComfyApiGraph; result: ScanResult } {
  const format = detectFormat(json);
  if (format === 'unknown') {
    throw new PsaiError('WORKFLOW_INVALID_JSON', '既不是 ComfyUI 的 API 格式，也不是界面导出格式');
  }
  const graph = format === 'api' ? (json as ComfyApiGraph) : convertUiToApi(json, objectInfo);
  const result = scanApiGraph(graph);
  result.format = format;
  if (!result.ok) {
    throw new PsaiError('WORKFLOW_NO_OUTPUT', '没有找到 SaveImage / PreviewImage 之类的输出节点');
  }
  return { graph, result };
}
