/**
 * 提示词预设存储。
 * 出厂预设从 @psai/shared 播种进库；用户可编辑（存为覆盖）、可恢复默认、可新建自定义。
 * 出厂预设不可删除 —— 删掉之后功能页的下拉会空掉，属于不可逆的坏体验。
 */

import { PROMPT_PRESETS, PsaiError } from '@psai/shared';
import type { PromptPresetKind } from '@psai/shared';
import type { Db } from './db.js';

export interface StoredPreset {
  id: string;
  label: string;
  kind: PromptPresetKind;
  scope: string[];
  prompt: string;
  negativePrompt: string;
  builtin: boolean;
  description: string;
  /** 出厂预设被用户改过 */
  customized: boolean;
}

export class PromptStore {
  constructor(private readonly db: Db) {
    this.seed();
  }

  private seed(): void {
    const now = Date.now();
    const ins = this.db.prepare(
      `INSERT INTO prompt_presets(id, label, kind, scope_json, prompt, negative_prompt, builtin, description, created_at, updated_at)
       VALUES(?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`
    );
    for (const p of PROMPT_PRESETS) {
      ins.run(
        p.id,
        p.label,
        p.kind,
        JSON.stringify(p.scope),
        p.prompt,
        p.negativePrompt ?? '',
        p.description,
        now,
        now
      );
    }
  }

  list(featureId?: string, kind?: PromptPresetKind): StoredPreset[] {
    const rows = this.db.prepare('SELECT * FROM prompt_presets ORDER BY builtin DESC, label').all() as Array<
      Record<string, unknown>
    >;
    let out = rows.map((r) => this.toPreset(r));
    if (featureId) out = out.filter((p) => p.scope.includes(featureId));
    if (kind) out = out.filter((p) => p.kind === kind);
    return out;
  }

  get(id: string): StoredPreset {
    const row = this.db.prepare('SELECT * FROM prompt_presets WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) throw new PsaiError('INTERNAL_ERROR', `提示词预设不存在: ${id}`);
    return this.toPreset(row);
  }

  find(id: string): StoredPreset | null {
    const row = this.db.prepare('SELECT * FROM prompt_presets WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.toPreset(row) : null;
  }

  update(id: string, patch: { label?: string; prompt?: string; negativePrompt?: string; scope?: string[] }): StoredPreset {
    const cur = this.get(id);
    this.db
      .prepare(
        `UPDATE prompt_presets SET label = ?, prompt = ?, negative_prompt = ?, scope_json = ?, updated_at = ? WHERE id = ?`
      )
      .run(
        patch.label ?? cur.label,
        patch.prompt ?? cur.prompt,
        patch.negativePrompt ?? cur.negativePrompt,
        JSON.stringify(patch.scope ?? cur.scope),
        Date.now(),
        id
      );
    return this.get(id);
  }

  create(input: {
    label: string;
    kind: PromptPresetKind;
    scope: string[];
    prompt: string;
    negativePrompt?: string;
    description?: string;
  }): StoredPreset {
    const id = `preset.custom.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO prompt_presets(id, label, kind, scope_json, prompt, negative_prompt, builtin, description, created_at, updated_at)
         VALUES(?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
      )
      .run(
        id,
        input.label,
        input.kind,
        JSON.stringify(input.scope),
        input.prompt,
        input.negativePrompt ?? '',
        input.description ?? '',
        now,
        now
      );
    return this.get(id);
  }

  remove(id: string): void {
    const p = this.get(id);
    if (p.builtin) throw new PsaiError('INTERNAL_ERROR', '出厂预设不可删除，只能恢复默认');
    this.db.prepare('DELETE FROM prompt_presets WHERE id = ?').run(id);
  }

  /** 恢复出厂文本。 */
  restore(id: string): StoredPreset {
    const factory = PROMPT_PRESETS.find((p) => p.id === id);
    if (!factory) throw new PsaiError('INTERNAL_ERROR', `${id} 不是出厂预设`);
    this.db
      .prepare(
        'UPDATE prompt_presets SET label = ?, prompt = ?, negative_prompt = ?, scope_json = ?, updated_at = ? WHERE id = ?'
      )
      .run(factory.label, factory.prompt, factory.negativePrompt ?? '', JSON.stringify(factory.scope), Date.now(), id);
    return this.get(id);
  }

  private toPreset(r: Record<string, unknown>): StoredPreset {
    const id = String(r['id']);
    const factory = PROMPT_PRESETS.find((p) => p.id === id);
    const prompt = String(r['prompt']);
    const negative = String(r['negative_prompt'] ?? '');
    return {
      id,
      label: String(r['label']),
      kind: String(r['kind']) as PromptPresetKind,
      scope: safeParse<string[]>(String(r['scope_json'] ?? '[]'), []),
      prompt,
      negativePrompt: negative,
      builtin: Number(r['builtin']) === 1,
      description: String(r['description'] ?? ''),
      customized: !!factory && (factory.prompt !== prompt || (factory.negativePrompt ?? '') !== negative)
    };
  }
}

function safeParse<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}
