/**
 * 工作流存储：内置工作流播种、导入、版本化、绑定、依赖预检。
 *
 * 版本化规则：同名工作流再次导入且 graph 哈希不同 → 次版本位 +1，旧版本保留。
 * 用户可能已经用某个版本出过一批图，覆盖掉就复现不了了。
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PsaiError, fixedComfyFeatures } from '@psai/shared';
import type { ComfyApiGraph, ParamBinding, ScanResult, WorkflowRecord, DependencyReport } from '@psai/shared';
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
          if (existing && existing.hash === hash) {
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

  saveBindings(id: string, bindings: ParamBinding[]): WorkflowRecord {
    const wf = this.get(id);
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
