/**
 * 把合并算出来的“这一侧要做的事”真正应用到资料库：建 / 改 / 删分类和表情，处理图片文件的改名与清理。
 * 发起方和被同步方都用这一个函数（各自应用各自那份 SideOps）。
 */
import type { Platform } from '../../platform/types';
import type { LibraryOp } from '../ops';
import type { Category, Sticker, Tombstone } from '../types';
import { pruneTombstones } from '../migrate';
import { canon } from './merge';
import type { ApplyResult, SideOps, SyncCategory, SyncSticker } from './protocol';

export interface ApplyDeps {
  platform: Pick<Platform, 'exists' | 'rename' | 'remove'>;
  /** 当前资料（每次调用都取最新的） */
  getState: () => { categories: Category[]; stickers: Sticker[]; deleted: Tombstone[] };
  apply: (ops: LibraryOp[]) => void;
  now: () => number;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function toCategory(c: SyncCategory, cur: Category | undefined): Category {
  const out: Category = { ...(cur ?? { id: c.id, createdAt: c.createdAt }), name: c.name, createdAt: c.createdAt, updatedAt: c.updatedAt, order: c.order };
  if (c.parentId) out.parentId = c.parentId;
  else delete out.parentId;
  return out;
}

function toSticker(s: SyncSticker, cur: Sticker | undefined): Sticker {
  const out: Sticker = {
    ...(cur ?? { id: s.id, source: { type: 'local' } as const }),
    name: s.name,
    file: s.file,
    ext: s.ext,
    size: s.size,
    categoryId: s.categoryId,
    tags: s.tags,
    favorite: s.favorite,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
  if (s.hash) out.hash = s.hash;
  else delete out.hash;
  return out;
}

/**
 * @param deleted 合并后的删除记录；同步开始之后本机新产生的删除记录（at >= keepSince）会保留下来，不被它覆盖
 */
export async function applySideOps(ops: SideOps, deleted: Tombstone[], deps: ApplyDeps, keepSince = Number.POSITIVE_INFINITY): Promise<ApplyResult> {
  const { platform, getState, apply } = deps;
  const result: ApplyResult = { added: 0, updated: 0, removed: 0, skipped: 0, categories: 0, errors: [] };
  const trash: string[] = [];

  // 1. 分类：先建 / 改，再删；删掉的分类里的表情（同步清单里没提到的）放到未分类
  const catOps: LibraryOp[] = [];
  const curCats = new Map(getState().categories.map((c) => [c.id, c]));
  for (const c of ops.categories) {
    const cur = curCats.get(c.id);
    // 同步开始之后这边又改过（更新）：这次不动，下次同步再合并
    if (cur && (cur.updatedAt ?? cur.createdAt) > c.updatedAt) continue;
    const next = toCategory(c, cur);
    if (cur && canon(cur) === canon(next)) continue;
    catOps.push({ op: 'upsertCategory', category: next });
    result.categories++;
  }
  const removeCats = ops.removeCategories.filter((id) => curCats.has(id));
  if (removeCats.length) {
    catOps.push({ op: 'removeCategories', ids: removeCats });
    result.categories += removeCats.length;
  }
  apply(catOps);
  const validCats = new Set(getState().categories.map((c) => c.id));
  const orphanOps: LibraryOp[] = [];
  for (const s of getState().stickers) {
    if (s.categoryId !== null && !validCats.has(s.categoryId)) orphanOps.push({ op: 'patchSticker', id: s.id, patch: { categoryId: null } });
  }
  apply(orphanOps);

  // 2. 表情
  for (const { sticker, file } of ops.stickers) {
    try {
      const cur = getState().stickers.find((s) => s.id === sticker.id);
      if (cur && cur.updatedAt > sticker.updatedAt) continue;
      if (typeof file === 'object') {
        if (file.renameFrom !== sticker.file) {
          if (!(await platform.exists(file.renameFrom))) throw new Error('要复用的图片文件不存在');
          await platform.rename(file.renameFrom, sticker.file);
        }
      } else if (!(await platform.exists(sticker.file))) {
        throw new Error('图片文件没有传过来');
      }
      const next = toSticker(sticker, cur);
      if (sticker.categoryId !== null && !validCats.has(sticker.categoryId)) next.categoryId = null;
      if (cur) {
        if (cur.file !== next.file) {
          // 图片换了：旧文件和缩略图作废
          if (cur.file !== sticker.file) trash.push(cur.file);
          if (cur.thumb) trash.push(cur.thumb);
          delete next.thumb;
        }
        if (canon(cur) === canon(next)) continue;
        apply([{ op: 'patchSticker', id: cur.id, patch: next }]);
        result.updated++;
      } else {
        apply([{ op: 'addSticker', sticker: next }]);
        result.added++;
      }
    } catch (e) {
      result.skipped++;
      result.errors.push(`${sticker.name}：${errorMessage(e)}`);
    }
  }

  // 3. 删除表情：文件只有在没有别的表情再用它时才删（被合并掉的那张图已经改名给保留的表情了）
  const victims = getState().stickers.filter((s) => ops.removeStickers.includes(s.id));
  if (victims.length) {
    apply([{ op: 'removeStickers', ids: victims.map((v) => v.id) }]);
    result.removed += victims.length;
    const inUse = new Set(getState().stickers.map((s) => s.file));
    for (const v of victims) {
      if (!inUse.has(v.file)) trash.push(v.file);
      if (v.thumb) trash.push(v.thumb);
    }
  }

  // 4. 删除记录（同步期间本机又删了东西的话，那些记录要留着）
  const fresh = getState().deleted.filter((t) => t.at >= keepSince);
  const next = fresh.length ? pruneTombstones([...deleted, ...fresh], deps.now()) : deleted;
  if (canon(getState().deleted) !== canon(next)) apply([{ op: 'setDeleted', deleted: next }]);

  for (const rel of trash) await platform.remove(rel).catch(() => undefined);
  return result;
}
