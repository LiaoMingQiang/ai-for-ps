/**
 * 工作流存储：内置工作流播种、导入、版本化、绑定、依赖预检。
 *
 * 版本化规则：同名工作流再次导入且 graph 哈希不同 → 次版本位 +1，旧版本保留。
 * 用户可能已经用某个版本出过一批图，覆盖掉就复现不了了。
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PsaiError, fixedComfyFeatures, PROVIDERS } from '@psai/shared';
import type {
  ComfyApiGraph,
  ParamBinding,
  ScanResult,
  WorkflowRecord,
  WorkflowKind,
  DependencyReport
} from '@psai/shared';
import type { Db } from './../db.js';
import { scanWorkflow, scanApiGraph } from './scanner.js';
import type { ObjectInfo } from './scanner.js';
import { validateBindings } from './bindings.js';
import type { Logger } from './../log.js';

export function graphHash(graph: ComfyApiGraph): string {
  return createHash('sha256').update(JSON.stringify(graph)).digest('hex');
}

export class WorkflowStore {
  constructor(
    private readonly db: Db,
    private readonly log: Logger
  ) {}

  /* ---------------- 内置工作流播种 ---------------- */

  /**
   * 从 psai/workflows/ 播种内置工作流。
   * 每个子目录一份：graph.json + binding.json + meta.json
   */
  seedBuiltins(workflowsDir: string): { seeded: number; missing: string[] } {
    const expected = new Set(fixedComfyFeatures().map((f) => f.defaultWorkflowId!));
    let seeded = 0;

    if (existsSync(workflowsDir)) {
      for (const name of readdirSync(workflowsDir)) {
        const dir = join(workflowsDir, name);
        if (!statSync(dir).isDirectory()) continue;
        const graphPath = join(dir, 'graph.json');
        const metaPath = join(dir, 'meta.json');
        const bindingPath = join(dir, 'binding.json');
        if (!existsSync(graphPath) || !existsSync(metaPath)) continue;

        try {
          const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as {
            id: string;
            name: string;
            version: string;
            featureId: string;
            notes?: string;
          };
          const graph = JSON.parse(readFileSync(graphPath, 'utf8')) as ComfyApiGraph;
          const bindings = existsSync(bindingPath)
            ? ((JSON.parse(readFileSync(bindingPath, 'utf8')) as { bindings: ParamBinding[] }).bindings ?? [])
            : [];
          const scan = scanApiGraph(graph);
          const hash = graphHash(graph);

          const existing = this.find(meta.id);
          // hash 只覆盖 graph.json —— 光比 hash 会漏掉 binding.json 的改动。
          //
          // 真踩过：改完 binding.json 重启，播种这一步认为"没变"直接跳过，
          // 库里还是旧绑定，于是参数怎么调都不生效，而日志里一个字都没有。
          // 工作流作者会以为是绑定写错了，其实是根本没被读进去。
          // 绑定也参与比较，任一改动都重新播种。
          const sameBindings = existing ? JSON.stringify(existing.bindings ?? []) === JSON.stringify(bindings) : false;
          if (existing && existing.hash === hash && sameBindings) {
            expected.delete(meta.id);
            continue;
          }

          const now = Date.now();
          this.db
            .prepare(
              `INSERT INTO workflows(id, name, version, source, format, graph_json, bindings_json,
                                     output_nodes_json, required_nodes_json, required_models_json,
                                     hash, feature_id, notes, created_at, updated_at)
               VALUES(?, ?, ?, 'builtin', 'api', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET
                 name = excluded.name, version = excluded.version, graph_json = excluded.graph_json,
                 bindings_json = excluded.bindings_json, output_nodes_json = excluded.output_nodes_json,
                 required_nodes_json = excluded.required_nodes_json, required_models_json = excluded.required_models_json,
                 hash = excluded.hash, notes = excluded.notes, updated_at = excluded.updated_at`
            )
            .run(
              meta.id,
              meta.name,
              meta.version,
              JSON.stringify(graph),
              JSON.stringify(bindings),
              JSON.stringify(scan.outputNodeIds),
              JSON.stringify(scan.requiredNodeTypes),
              JSON.stringify(scan.requiredModels),
              hash,
              meta.featureId,
              meta.notes ?? '',
              now,
              now
            );
          seeded++;
          expected.delete(meta.id);
        } catch (e) {
          this.log.error(`内置工作流 ${name} 播种失败`, String(e));
        }
      }
    }

    const missing = [...expected];
    if (missing.length) {
      this.log.warn('以下内置工作流尚未提供，对应功能会显示未绑定', { missing });
    }
    return { seeded, missing };
  }

  /* ---------------- 查询 ---------------- */

  list(): WorkflowRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM workflows ORDER BY source DESC, name, version DESC')
      .all() as Array<Record<string, unknown>>;
    return rows.map(rowToWorkflow);
  }

  find(id: string): WorkflowRecord | null {
    const row = this.db.prepare('SELECT * FROM workflows WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToWorkflow(row) : null;
  }

  get(id: string): WorkflowRecord {
    const wf = this.find(id);
    if (!wf) throw new PsaiError('WORKFLOW_NOT_FOUND', id);
    return wf;
  }

  versionsOf(name: string): WorkflowRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM workflows WHERE name = ? ORDER BY version DESC')
      .all(name) as Array<Record<string, unknown>>;
    return rows.map(rowToWorkflow);
  }

  /* ---------------- 导入 ---------------- */

  scan(json: unknown, objectInfo: ObjectInfo | null): ScanResult {
    return scanWorkflow(json, objectInfo).result;
  }

  import(input: {
    json: unknown;
    name: string;
    objectInfo: ObjectInfo | null;
    bindings?: ParamBinding[];
    notes?: string;
  }): { workflow: WorkflowRecord; scan: ScanResult; versionBumped: boolean } {
    const { graph, result } = scanWorkflow(input.json, input.objectInfo);
    const hash = graphHash(graph);

    const sameName = this.versionsOf(input.name);
    const identical = sameName.find((w) => w.hash === hash);
    if (identical) {
      return { workflow: identical, scan: result, versionBumped: false };
    }

    const version = sameName.length === 0 ? '1.0.0' : bumpMinor(sameName[0]!.version);
    const bindings = input.bindings ?? result.suggestedBindings;
    const problems = validateBindings(graph, bindings);
    if (problems.length) {
      throw new PsaiError('WORKFLOW_BINDING_INVALID', problems.join('; '));
    }

    const id = `wf.user.${slug(input.name)}.${version.replace(/\./g, '_')}`;
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO workflows(id, name, version, source, format, graph_json, bindings_json,
                               output_nodes_json, required_nodes_json, required_models_json,
                               hash, feature_id, notes, created_at, updated_at)
         VALUES(?, ?, ?, 'imported', ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`
      )
      .run(
        id,
        input.name,
        version,
        result.format,
        JSON.stringify(graph),
        JSON.stringify(bindings),
        JSON.stringify(result.outputNodeIds),
        JSON.stringify(result.requiredNodeTypes),
        JSON.stringify(result.requiredModels),
        hash,
        input.notes ?? '',
        now,
        now
      );

    return { workflow: this.get(id), scan: result, versionBumped: sameName.length > 0 };
  }

  /**
   * 登记一条**云端**工作流：只记名字和平台侧的 ID，本机没有图。
   *
   * 和 import() 的区别不只是少了图。云端条目上扫不出字段、做不了依赖检查，
   * 参数怎么喂由平台那边的工作流自己决定 —— 我们能保证的只有
   * 「提交时把这个 ID 发过去」。所以这里**不**碰 bindings，也不跑 validateBindings，
   * 那两个东西对着一份空图跑出来的结论没有意义。
   *
   * 不在这里联网校验 ID 存不存在：登记和验证是两件事。断网、平台抽风、
   * key 还没填 —— 任何一个都不该挡着用户先把 ID 记下来。要验证有单独的按钮。
   */
  importCloud(input: {
    name: string;
    providerId: string;
    remoteId: string;
    notes?: string;
    remoteKind?: 'workflow' | 'aiApp';
    nodeInfo?: Array<{ nodeId: string; fieldName: string; description: string; defaultValue: string }>;
    bindings?: ParamBinding[];
  }): {
    workflow: WorkflowRecord;
    versionBumped: boolean;
  } {
    const name = input.name.trim();
    const remoteId = input.remoteId.trim();
    if (!name) throw new PsaiError('JOB_PARAM_INVALID', '缺少工作流名称');
    if (!remoteId) throw new PsaiError('JOB_PARAM_INVALID', '缺少云端工作流 ID');

    const desc = PROVIDERS.find((p) => p.id === input.providerId);
    if (!desc) throw new PsaiError('JOB_PARAM_INVALID', `未知的 Provider：${input.providerId}`);
    if (!desc.capabilities.includes('workflow') || desc.kind === 'comfyui') {
      throw new PsaiError('JOB_PARAM_INVALID', `${desc.label} 不是以工作流为单位的平台，不能登记云端工作流 ID`);
    }

    /*
     * AI 应用必须带 nodeInfoList，否则不许登记。
     *
     * 少了它，提交时 nodeInfoList 会是空的 —— RunningHub **照跑不误**，
     * 用作者预置的示例图出一张图。那是一张跟用户输入毫无关系、
     * 却带着 SUCCESS 状态回来的图，而且是花了钱才拿到的。
     * 这种假成功比登记时就被拦下难查得多，所以拦在这里。
     */
    /*
     * 「AI 应用」是 RunningHub 独有的东西（它有一套 v2 接口：
     * /openapi/v2/run/ai-app/{id}）。别的平台没有这个概念 ——
     * 让用户在 LiblibAI 下面选「AI 应用」，存进去的节点表不会有任何人读，
     * 提交时按工作流那条路走，报出来的错跟真正的原因毫无关系。
     * 所以在这里拦死，而不是等到提交。
     */
    if (input.remoteKind === 'aiApp' && input.providerId !== 'runninghub') {
      throw new PsaiError(
        'JOB_PARAM_INVALID',
        `「AI 应用」是 RunningHub 特有的类型，${desc.label} 没有这个概念。请把类型改成「云端工作流」。`
      );
    }

    if (input.remoteKind === 'aiApp' && !(input.nodeInfo && input.nodeInfo.length)) {
      throw new PsaiError(
        'JOB_PARAM_INVALID',
        'AI 应用必须带上节点参数表：请到平台该应用的 API 页面，把「提交请求 → 请求示例」那段 curl 复制过来。' +
          '（AI 应用的节点号没有任何接口能查到，只能这样带进来。）'
      );
    }

    // 哈希用「平台 + ID」而不是图：同一个 ID 重复登记应当被认作同一条
    const hash = createHash('sha256').update(`${input.providerId}:${remoteId}`).digest('hex');
    const sameName = this.versionsOf(name);
    const identical = sameName.find((w) => w.hash === hash);
    if (identical) return { workflow: identical, versionBumped: false };

    const version = sameName.length === 0 ? '1.0.0' : bumpMinor(sameName[0]!.version);
    const id = `wf.cloud.${slug(name)}.${version.replace(/\./g, '_')}`;
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO workflows(id, name, version, source, kind, provider_id, remote_id, remote_kind,
                               node_info_json, format, graph_json, bindings_json, output_nodes_json,
                               required_nodes_json, required_models_json, hash, feature_id, notes,
                               created_at, updated_at)
         VALUES(?, ?, ?, 'imported', 'cloud', ?, ?, ?, ?, 'api', '{}', ?, '[]', '[]', '[]', ?, NULL, ?, ?, ?)`
      )
      .run(
        id,
        name,
        version,
        input.providerId,
        remoteId,
        input.remoteKind ?? 'workflow',
        input.nodeInfo ? JSON.stringify(input.nodeInfo) : null,
        JSON.stringify(input.bindings ?? []),
        hash,
        input.notes ?? '',
        now,
        now
      );

    return { workflow: this.get(id), versionBumped: sameName.length > 0 };
  }

  saveBindings(id: string, bindings: ParamBinding[]): WorkflowRecord {
    const wf = this.get(id);
    // 云端条目没有图，绑定要绑到的节点根本不在本机。validateBindings 对着
    // 空图会把每一条都判成「节点不存在」，报出来的错完全是误导。
    if (wf.kind === 'cloud') {
      throw new PsaiError('JOB_PARAM_INVALID', '云端工作流的参数由平台侧的工作流决定，本机不做参数绑定');
    }
    const problems = validateBindings(wf.graph, bindings);
    if (problems.length) throw new PsaiError('WORKFLOW_BINDING_INVALID', problems.join('; '));
    this.db
      .prepare('UPDATE workflows SET bindings_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(bindings), Date.now(), id);
    return this.get(id);
  }

  remove(id: string): void {
    const wf = this.get(id);
    if (wf.source === 'builtin') {
      throw new PsaiError('INTERNAL_ERROR', '内置工作流不可删除，只能恢复默认');
    }
    this.db.prepare('DELETE FROM workflows WHERE id = ?').run(id);
  }

  /* ---------------- 依赖预检 ---------------- */

  checkDependencies(
    id: string,
    installedNodes: Set<string>,
    availableModels: Record<string, Set<string>>,
    checkedAgainst: string
  ): DependencyReport {
    const wf = this.get(id);
    const missingNodes = wf.requiredNodeTypes.filter((t) => !installedNodes.has(t));
    const missingModels = wf.requiredModels.filter((m) => {
      const pool = availableModels[m.kind];
      if (!pool || pool.size === 0) return false; // 不知道就不冤枉它
      return !pool.has(m.name);
    });
    return {
      workflowId: id,
      ok: missingNodes.length === 0 && missingModels.length === 0,
      missingNodes,
      missingModels,
      checkedAgainst,
      checkedAt: Date.now()
    };
  }
}

/* ---------------- 工具 ---------------- */

function rowToWorkflow(r: Record<string, unknown>): WorkflowRecord {
  return {
    id: String(r['id']),
    name: String(r['name']),
    version: String(r['version']),
    source: String(r['source']) as 'builtin' | 'imported',
    // 老库里这一列不存在（ensureColumn 补的默认值只对新写入生效），
    // 所以读的时候也要兜一次 'comfy'，否则升级后旧记录会变成 undefined
    kind: (r['kind'] === 'cloud' ? 'cloud' : 'comfy') as WorkflowKind,
    providerId: r['provider_id'] === null || r['provider_id'] === undefined ? null : String(r['provider_id']),
    remoteId: r['remote_id'] === null || r['remote_id'] === undefined ? null : String(r['remote_id']),
    remoteKind:
      r['remote_kind'] === null || r['remote_kind'] === undefined
        ? null
        : (String(r['remote_kind']) as 'workflow' | 'aiApp'),
    nodeInfo: r['node_info_json'] ? safeParse(String(r['node_info_json']), null) : null,
    format: String(r['format']) as 'api' | 'ui',
    graph: safeParse<ComfyApiGraph>(String(r['graph_json']), {}),
    bindings: safeParse<ParamBinding[]>(String(r['bindings_json'] ?? '[]'), []),
    outputNodeIds: safeParse<string[]>(String(r['output_nodes_json'] ?? '[]'), []),
    requiredNodeTypes: safeParse<string[]>(String(r['required_nodes_json'] ?? '[]'), []),
    requiredModels: safeParse<Array<{ kind: string; name: string }>>(String(r['required_models_json'] ?? '[]'), []),
    hash: String(r['hash']),
    featureId: r['feature_id'] === null || r['feature_id'] === undefined ? null : String(r['feature_id']),
    notes: String(r['notes'] ?? ''),
    createdAt: Number(r['created_at']),
    updatedAt: Number(r['updated_at'])
  };
}

function safeParse<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

function bumpMinor(v: string): string {
  const parts = v.split('.').map((x) => Number(x) || 0);
  const major = parts[0] ?? 1;
  const minor = (parts[1] ?? 0) + 1;
  return `${major}.${minor}.0`;
}

function slug(s: string): string {
  const cleaned = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || createHash('sha256').update(s).digest('hex').slice(0, 8);
}
