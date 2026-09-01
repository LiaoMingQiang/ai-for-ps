/**
 * 资产库：输入图与结果图的唯一落地点。
 *
 * 按 sha256 去重 —— 同一张图反复使用不会占两份空间，也不会重复上传到 ComfyUI。
 * 结果资产是"再次写回"能力的基础，所以引用计数归零前绝不物理删除。
 */

import { createHash } from 'node:crypto';
import { writeFileSync, readFileSync, existsSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PsaiError } from '@psai/shared';
import type { Db } from './db.js';
import { ensureDir } from './config.js';
import { parseImageMeta } from './image-meta.js';

export type AssetKind = 'input' | 'result' | 'reference' | 'thumb';

export interface AssetRecord {
  id: string;
  sha256: string;
  mime: string;
  bytes: number;
  width: number;
  height: number;
  relPath: string;
  kind: AssetKind;
  createdAt: number;
  refCount: number;
  /**
   * alpha 通道是不是一次**明确的选区遮罩**。
   *
   * 只有上传时真的带了选区灰度、并且合成进 alpha 的那一张才是 true。
   * 天然带透明的图（透明背景图层、抠过的素材、带透明边的 PNG）是 false ——
   * 它们同样有 alpha 通道，但那不是用户圈出来的处理区。
   */
  hasSelectionMask: boolean;
}

const MAX_BYTES = 64 * 1024 * 1024;
const ALLOWED = new Set(['image/png', 'image/jpeg', 'image/webp']);

function extOf(mime: string): string {
  if (mime === 'image/png') return 'png';
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/webp') return 'webp';
  return 'bin';
}

export class AssetStore {
  constructor(
    private readonly db: Db,
    private readonly assetsDir: string
  ) {}

  /**
   * @param opts.selectionMask 这份字节的 alpha 是不是一次明确的选区遮罩。
   *   传 true 的只有一处：/v1/assets 真的收到了选区灰度并合成过。
   */
  put(buf: Buffer, kind: AssetKind = 'input', opts: { selectionMask?: boolean } = {}): AssetRecord {
    if (buf.length === 0) throw new PsaiError('ASSET_UNSUPPORTED_TYPE', '空文件');
    if (buf.length > MAX_BYTES) {
      throw new PsaiError('ASSET_TOO_LARGE', `${(buf.length / 1048576).toFixed(1)}MB 超过 64MB 上限`);
    }
    const meta = parseImageMeta(buf);
    if (!meta) throw new PsaiError('ASSET_UNSUPPORTED_TYPE', '无法识别的图像格式（仅支持 PNG / JPEG / WebP）');
    if (!ALLOWED.has(meta.mime)) throw new PsaiError('ASSET_UNSUPPORTED_TYPE', meta.mime);

    const sha = createHash('sha256').update(buf).digest('hex');
    const existing = this.db.prepare('SELECT * FROM assets WHERE sha256 = ?').get(sha) as
      | Record<string, unknown>
      | undefined;
    if (existing) {
      /*
       * 去重命中。这时候要补一件事：这次带着选区遮罩来，
       * 而库里那条旧记录可能是"当初没带遮罩"存下的。
       *
       * 内容寻址保证字节完全一样，所以"这份 alpha 是选区遮罩"这个事实
       * 对两条路径同样成立 —— 之前只是没人告诉过我们。补上，
       * 否则用户重新捕获一次同样的选区，反而会被判成"没有可用遮罩"。
       * 反方向不做：从来不把 true 改回 false。
       */
      if (opts.selectionMask && Number(existing['has_selection_mask']) !== 1) {
        this.db.prepare('UPDATE assets SET has_selection_mask = 1 WHERE sha256 = ?').run(sha);
        existing['has_selection_mask'] = 1;
      }
      const rec = rowToAsset(existing);
      // 文件被外部删掉时补写回去，保证记录与磁盘一致
      const abs = join(this.assetsDir, rec.relPath);
      if (!existsSync(abs)) {
        ensureDir(join(this.assetsDir, sha.slice(0, 2)));
        writeFileSync(abs, buf);
      }
      return rec;
    }

    const shard = sha.slice(0, 2);
    ensureDir(join(this.assetsDir, shard));
    const relPath = `${shard}/${sha}.${extOf(meta.mime)}`;
    writeFileSync(join(this.assetsDir, relPath), buf);

    const id = `as_${sha.slice(0, 24)}`;
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO assets(id, sha256, mime, bytes, width, height, rel_path, kind, created_at, ref_count,
                            has_selection_mask)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
      )
      .run(id, sha, meta.mime, buf.length, meta.width, meta.height, relPath, kind, now, opts.selectionMask ? 1 : 0);

    return {
      id,
      sha256: sha,
      mime: meta.mime,
      bytes: buf.length,
      width: meta.width,
      height: meta.height,
      relPath,
      kind,
      createdAt: now,
      refCount: 0,
      hasSelectionMask: !!opts.selectionMask
    };
  }

  get(id: string): AssetRecord {
    const row = this.db.prepare('SELECT * FROM assets WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) throw new PsaiError('ASSET_NOT_FOUND', id);
    return rowToAsset(row);
  }

  /** 资产在磁盘上的绝对路径（缩略图生成要直接读它）。 */
  absPathOf(rec: { relPath: string }): string {
    return join(this.assetsDir, rec.relPath);
  }

  find(id: string): AssetRecord | null {
    const row = this.db.prepare('SELECT * FROM assets WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? rowToAsset(row) : null;
  }

  read(id: string): Buffer {
    const rec = this.get(id);
    const abs = join(this.assetsDir, rec.relPath);
    if (!existsSync(abs)) throw new PsaiError('ASSET_NOT_FOUND', `记录存在但文件缺失: ${rec.relPath}`);
    return readFileSync(abs);
  }

  absPath(id: string): string {
    return join(this.assetsDir, this.get(id).relPath);
  }

  addRef(id: string, n = 1): void {
    this.db.prepare('UPDATE assets SET ref_count = ref_count + ? WHERE id = ?').run(n, id);
  }

  release(id: string): void {
    this.db.prepare('UPDATE assets SET ref_count = MAX(0, ref_count - 1) WHERE id = ?').run(id);
  }

  /** 只删引用计数为 0 的资产。被任何任务引用的结果绝不物理删除。 */
  gc(): { removed: number; freedBytes: number } {
    const rows = this.db.prepare('SELECT * FROM assets WHERE ref_count <= 0').all() as Array<Record<string, unknown>>;
    let removed = 0;
    let freed = 0;
    for (const row of rows) {
      const rec = rowToAsset(row);
      const abs = join(this.assetsDir, rec.relPath);
      try {
        if (existsSync(abs)) {
          freed += statSync(abs).size;
          unlinkSync(abs);
        }
        this.db.prepare('DELETE FROM assets WHERE id = ?').run(rec.id);
        removed++;
      } catch {
        /* 文件被占用时跳过，下次再收 */
      }
    }
    return { removed, freedBytes: freed };
  }

  totalBytes(): number {
    const row = this.db.prepare('SELECT COALESCE(SUM(bytes),0) AS n FROM assets').get() as { n: number };
    return row.n;
  }
}

function rowToAsset(r: Record<string, unknown>): AssetRecord {
  return {
    id: String(r['id']),
    sha256: String(r['sha256']),
    mime: String(r['mime']),
    bytes: Number(r['bytes']),
    width: Number(r['width']),
    height: Number(r['height']),
    relPath: String(r['rel_path']),
    kind: String(r['kind']) as AssetKind,
    createdAt: Number(r['created_at']),
    refCount: Number(r['ref_count']),
    hasSelectionMask: Number(r['has_selection_mask'] ?? 0) === 1
  };
}
