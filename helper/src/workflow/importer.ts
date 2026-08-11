/* workflow/importer: 导入 + 版本管理 (规则十七/二十)
 * 链路: parse -> schema validate -> graph scan -> field detection -> output node detection
 *       -> dependency scan -> bindings -> 写 SQLite (workflows + workflow_versions + workflow_bindings + workflow_dependencies)
 * 任何一步失败: 明确报错, 不假成功 */
import crypto from "node:crypto";
import type { Store } from "../db.js";
import { scanWorkflow, defaultBindings, type ScanResult } from "./scanner.js";

export interface ImportResult {
  workflowId: string;
  version: string;
  scan: ScanResult;
  bindingsCount: number;
  dependenciesCount: number;
}

export function importWorkflow(store: Store, body: {
  name: string;
  json: unknown;
  category?: string;
  description?: string;
  provider?: string;
  author?: string;
}): ImportResult {
  const name = (body.name || "").trim();
  if (!name) throw new Error("WORKFLOW_NAME_MISSING: 缺少工作流名称");
  if (body.json === undefined || body.json === null) throw new Error("WORKFLOW_JSON_MISSING: 缺少工作流 JSON");

  /* 1. parse + 2. schema validate + 3-5. scan (字段/输出/依赖) */
  let scan: ScanResult;
  try {
    scan = scanWorkflow(body.json);
  } catch (e) {
    throw new Error("WORKFLOW_INVALID: " + String((e as Error).message));
  }
  if (!scan.outputNodes.length) {
    throw new Error("WORKFLOW_NO_OUTPUT: 未检测到输出节点 (SaveImage/PreviewImage)");
  }

  const now = Date.now();
  const workflowId = "wf_" + crypto.randomBytes(6).toString("hex");
  const jsonHash = crypto.createHash("sha256").update(JSON.stringify(body.json)).digest("hex");

  /* 6. 事务写入 */
  store.raw.exec("BEGIN;");
  try {
    store.raw.prepare(
      "INSERT INTO workflows (id, name, version, category, description, provider, source_json_hash, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)"
    ).run(workflowId, name, "1.0.0", body.category || "未分类", body.description || null,
      body.provider || "comfyui", jsonHash, now, now);

    store.raw.prepare(
      "INSERT INTO workflow_versions (id, workflow_id, version, workflow_json_hash, bindings_hash, lockfile_hash, changelog, author, created_at) VALUES (?,?,?,?,?,?,?,?,?)"
    ).run("wv_" + crypto.randomBytes(6).toString("hex"), workflowId, "1.0.0",
      jsonHash, null, JSON.stringify(scan.lockfile).length ? crypto.createHash("sha256").update(JSON.stringify(scan.lockfile)).digest("hex") : null,
      "初始导入", body.author || "import", now);

    const bindings = defaultBindings(scan);
    const insBinding = store.raw.prepare(
      "INSERT INTO workflow_bindings (id, workflow_id, field_key, node_id, input_key, field_type, label, sort_order, group_name, default_value, display_condition) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
    );
    for (const b of bindings) {
      insBinding.run("wb_" + crypto.randomBytes(6).toString("hex"), workflowId, b.fieldKey, b.nodeId, b.inputKey,
        b.fieldType, b.label, b.sortOrder, b.groupName,
        b.defaultValue === null ? null : JSON.stringify(b.defaultValue), b.displayCondition);
    }

    const insDep = store.raw.prepare(
      "INSERT INTO workflow_dependencies (id, workflow_id, kind, name, min_version, status, detail, created_at) VALUES (?,?,?,?,?,?,?,?)"
    );
    for (const d of scan.dependencies) {
      insDep.run("wd_" + crypto.randomBytes(6).toString("hex"), workflowId, d.kind, d.name, null, "unknown", null, now);
    }

    store.raw.exec("COMMIT;");
  } catch (e) {
    store.raw.exec("ROLLBACK;");
    throw new Error("WORKFLOW_SAVE_FAILED: " + String((e as Error).message));
  }

  return {
    workflowId,
    version: "1.0.0",
    scan,
    bindingsCount: defaultBindings(scan).length,
    dependenciesCount: scan.dependencies.length
  };
}

/* 保存新版本 (规则二十: 不覆盖旧版本, 创建新版本指针) */
export function saveWorkflowVersion(store: Store, workflowId: string, body: {
  json?: unknown;
  bindings?: Array<{ fieldKey: string; nodeId: string; inputKey: string; fieldType: string; label: string; sortOrder: number; groupName: string; defaultValue: unknown }>;
  changelog?: string;
  author?: string;
}): { version: string; workflowId: string } {
  const wf = store.raw.prepare("SELECT * FROM workflows WHERE id=?").get(workflowId) as Record<string, unknown> | undefined;
  if (!wf) throw new Error("WORKFLOW_NOT_FOUND: 工作流不存在: " + workflowId);

  const now = Date.now();
  const oldMajor = String(wf.version || "1.0.0").split(".").map(Number);
  const newVersion = [oldMajor[0] || 1, (oldMajor[1] || 0) + 1, 0].join(".");
  let jsonHash: string | null = null;

  store.raw.exec("BEGIN;");
  try {
    if (body.json !== undefined) {
      const scan = scanWorkflow(body.json);
      jsonHash = crypto.createHash("sha256").update(JSON.stringify(body.json)).digest("hex");
      store.raw.prepare("UPDATE workflows SET source_json_hash=?, updated_at=? WHERE id=?").run(jsonHash, now, workflowId);
      /* 依赖重建 */
      store.raw.prepare("DELETE FROM workflow_dependencies WHERE workflow_id=?").run(workflowId);
      const insDep = store.raw.prepare(
        "INSERT INTO workflow_dependencies (id, workflow_id, kind, name, min_version, status, detail, created_at) VALUES (?,?,?,?,?,?,?,?)"
      );
      for (const d of scan.dependencies) {
        insDep.run("wd_" + crypto.randomBytes(6).toString("hex"), workflowId, d.kind, d.name, null, "unknown", null, now);
      }
    }
    if (body.bindings) {
      store.raw.prepare("DELETE FROM workflow_bindings WHERE workflow_id=?").run(workflowId);
      const insBinding = store.raw.prepare(
        "INSERT INTO workflow_bindings (id, workflow_id, field_key, node_id, input_key, field_type, label, sort_order, group_name, default_value, display_condition) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
      );
      for (const b of body.bindings) {
        insBinding.run("wb_" + crypto.randomBytes(6).toString("hex"), workflowId, b.fieldKey, b.nodeId, b.inputKey,
          b.fieldType, b.label, b.sortOrder, b.groupName,
          b.defaultValue === null ? null : JSON.stringify(b.defaultValue), null);
      }
    }
    const bindingsHash = crypto.createHash("sha256").update(
      JSON.stringify((store.raw.prepare("SELECT field_key,node_id,input_key FROM workflow_bindings WHERE workflow_id=?").all(workflowId)))
    ).digest("hex");
    store.raw.prepare(
      "INSERT INTO workflow_versions (id, workflow_id, version, workflow_json_hash, bindings_hash, lockfile_hash, changelog, author, created_at) VALUES (?,?,?,?,?,?,?,?,?)"
    ).run("wv_" + crypto.randomBytes(6).toString("hex"), workflowId, newVersion, jsonHash, bindingsHash, null,
      body.changelog || "更新", body.author || "studio", now);
    store.raw.prepare("UPDATE workflows SET version=?, updated_at=? WHERE id=?").run(newVersion, now, workflowId);
    store.raw.exec("COMMIT;");
  } catch (e) {
    store.raw.exec("ROLLBACK;");
    throw new Error("WORKFLOW_VERSION_SAVE_FAILED: " + String((e as Error).message));
  }
  return { version: newVersion, workflowId };
}

/* 依赖状态: 与 ComfyUI 实际环境对比 (规则二十一/场景 8) */
export async function checkDependencies(store: Store, workflowId: string, comfyBaseUrl: string): Promise<Array<{ kind: string; name: string; status: string; detail: string }>> {
  const rows = store.raw.prepare("SELECT kind, name FROM workflow_dependencies WHERE workflow_id=?").all(workflowId) as Array<{ kind: string; name: string }>;
  if (!rows.length) return [];
  let objectInfo: Record<string, unknown> = {};
  try {
    const res = await fetch(comfyBaseUrl + "/object_info");
    if (res.ok) objectInfo = (await res.json()) as Record<string, unknown>;
  } catch (e) { /* offline */ }
  const known = new Set<string>();
  const collect = (cls: string) => {
    const info = objectInfo[cls] as { input?: { required?: Record<string, unknown> } } | undefined;
    const req = (info?.input?.required || {}) as Record<string, unknown>;
    for (const k of Object.keys(req)) {
      const v = req[k];
      if (Array.isArray(v) && Array.isArray(v[0])) {
        for (const item of v[0] as unknown[]) if (typeof item === "string") known.add(item);
      }
    }
  };
  for (const cls of ["CheckpointLoaderSimple", "CheckpointLoader", "UNETLoader", "VAELoader", "LoraLoader"]) collect(cls);

  return rows.map((d) => {
    if (!known.size) return { kind: d.kind, name: d.name, status: "unknown", detail: "ComfyUI 离线或未检测" };
    const matched = known.has(d.name);
    return {
      kind: d.kind,
      name: d.name,
      status: matched ? "matched" : "missing",
      detail: matched ? "已匹配" : "ComfyUI 中缺失"
    };
  });
}
