/**
 * 把功能参数注入 ComfyUI 工作流。
 *
 * 输入是「参数 id → 已就绪的值」；图像参数在进来之前就已经被换成
 * ComfyUI 侧的文件名，宽高也已经由比例与分辨率算好。
 * 这里只负责按绑定表落位与做数值变换。
 */

import { PsaiError } from '@psai/shared';
import type { ComfyApiGraph, ParamBinding, BindingTransform } from '@psai/shared';

/** 由作业引擎准备好的注入值。`__width` / `__height` 是算好的出图尺寸。 */
export type BindingValues = Record<string, unknown> & {
  __width?: number;
  __height?: number;
};

export interface ApplyReport {
  applied: number;
  skipped: Array<{ paramId: string; why: string }>;
}

export function applyBindings(
  graph: ComfyApiGraph,
  bindings: readonly ParamBinding[],
  values: BindingValues
): { graph: ComfyApiGraph; report: ApplyReport } {
  const out: ComfyApiGraph = JSON.parse(JSON.stringify(graph)) as ComfyApiGraph;
  const report: ApplyReport = { applied: 0, skipped: [] };

  for (const b of bindings) {
    const node = out[b.nodeId];
    if (!node) {
      if (b.required) {
        throw new PsaiError('WORKFLOW_BINDING_INVALID', `绑定指向不存在的节点 ${b.nodeId}（参数 ${b.paramId}）`);
      }
      report.skipped.push({ paramId: b.paramId, why: `节点 ${b.nodeId} 不存在` });
      continue;
    }
    if (!(b.input in node.inputs)) {
      if (b.required) {
        throw new PsaiError(
          'WORKFLOW_BINDING_INVALID',
          `节点 ${b.nodeId}(${node.class_type}) 没有输入 ${b.input}（参数 ${b.paramId}）`
        );
      }
      report.skipped.push({ paramId: b.paramId, why: `节点 ${b.nodeId} 没有输入 ${b.input}` });
      continue;
    }
    // 该输入被连线占用时不能覆盖，否则会把图接断
    const existing = node.inputs[b.input];
    if (Array.isArray(existing)) {
      if (b.required) {
        throw new PsaiError(
          'WORKFLOW_BINDING_INVALID',
          `节点 ${b.nodeId}.${b.input} 是连线输入，不能被参数覆盖（参数 ${b.paramId}）`
        );
      }
      report.skipped.push({ paramId: b.paramId, why: '该输入被连线占用' });
      continue;
    }

    const raw = values[b.paramId];
    const transformed = transform(b.transform, raw, existing, values);

    if (transformed === undefined) {
      if (b.required) {
        throw new PsaiError('JOB_PARAM_INVALID', `必填参数 ${b.paramId} 缺少取值`);
      }
      report.skipped.push({ paramId: b.paramId, why: '取值为空' });
      continue;
    }

    node.inputs[b.input] = transformed;
    report.applied++;
  }

  return { graph: out, report };
}

function transform(
  t: BindingTransform | undefined,
  raw: unknown,
  existing: unknown,
  values: BindingValues
): unknown {
  if (t) {
    switch (t.type) {
      case 'const':
        return t.value;
      case 'sizeWidth':
        return values.__width;
      case 'sizeHeight':
        return values.__height;
      case 'appendText': {
        const add = toText(raw);
        if (!add) return existing;
        const base = toText(existing);
        return base ? base + t.separator + add : add;
      }
      case 'linear': {
        const n = toNumber(raw);
        if (n === undefined) return undefined;
        const span = t.inMax - t.inMin;
        const ratio = span === 0 ? 0 : (n - t.inMin) / span;
        const clamped = Math.min(1, Math.max(0, ratio));
        return t.outMin + clamped * (t.outMax - t.outMin);
      }
      case 'map': {
        // 映射不中就返回 undefined，让节点保持自己的默认值。
        // 硬塞一个不在枚举里的值，ComfyUI 会在提交时整个拒绝
        // （value_not_in_list），而且错误信息里看不出是哪个参数干的。
        const key = toText(raw);
        if (!key) return undefined;
        return Object.prototype.hasOwnProperty.call(t.map, key) ? t.map[key] : undefined;
      }
      case 'int': {
        const n = toNumber(raw);
        return n === undefined ? undefined : Math.round(n);
      }
      case 'number':
        return toNumber(raw);
      case 'not':
        return raw === undefined ? undefined : !raw;
    }
  }
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'string' && raw.length === 0) return undefined;
  return raw;
}

function toNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function toText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

/** 校验绑定表本身是否指向真实存在的节点与输入（保存绑定时用）。 */
export function validateBindings(graph: ComfyApiGraph, bindings: readonly ParamBinding[]): string[] {
  const problems: string[] = [];
  for (const b of bindings) {
    const node = graph[b.nodeId];
    if (!node) {
      problems.push(`参数 ${b.paramId}: 节点 ${b.nodeId} 不存在`);
      continue;
    }
    if (!(b.input in node.inputs)) {
      problems.push(`参数 ${b.paramId}: 节点 ${b.nodeId}(${node.class_type}) 没有输入 ${b.input}`);
      continue;
    }
    if (Array.isArray(node.inputs[b.input]) && b.transform?.type !== 'const') {
      problems.push(`参数 ${b.paramId}: 节点 ${b.nodeId}.${b.input} 是连线输入，不能绑定`);
    }
  }
  return problems;
}

/** RunningHub 的 nodeInfoList 一条。 */
export interface NodeInfo {
  nodeId: string;
  fieldName: string;
  fieldValue: unknown;
}

/**
 * 把绑定表变成 RunningHub 的 nodeInfoList。
 *
 * 做法是先在云端工作流的真实图上跑一遍 applyBindings，再和原图做差 ——
 * 这样节点存在性校验、连线输入保护、以及 sizeWidth / linear / appendText
 * 这些变换，云端和本地走的是同一套代码，不会两边行为不一致。
 *
 * 只有真正被改动的字段才会进 nodeInfoList：没变的值没必要覆盖，
 * 覆盖了反而在云端作者调整默认值时把用户锁死在旧值上。
 */
export function bindingsToNodeInfoList(
  graph: ComfyApiGraph,
  bindings: readonly ParamBinding[],
  values: BindingValues
): { nodeInfoList: NodeInfo[]; report: ApplyReport } {
  const { graph: applied, report } = applyBindings(graph, bindings, values);
  const nodeInfoList: NodeInfo[] = [];
  const seen = new Set<string>();
  for (const b of bindings) {
    const key = `${b.nodeId}\u0000${b.input}`;
    if (seen.has(key)) continue;
    const before = graph[b.nodeId]?.inputs?.[b.input];
    const after = applied[b.nodeId]?.inputs?.[b.input];
    if (after === undefined || Array.isArray(after)) continue;
    if (before === after) continue;
    seen.add(key);
    nodeInfoList.push({ nodeId: b.nodeId, fieldName: b.input, fieldValue: after });
  }
  return { nodeInfoList, report };
}
