import type { Category, Library, Sticker, Subscription, Tombstone } from './types';

/**
 * 对资料库的原子修改。同步过程会分批产出这些操作，由 store 逐步应用，
 * 这样下载过程中界面就能实时看到新表情。
 */
export type LibraryOp =
  | { op: 'upsertCategory'; category: Category }
  | { op: 'addSticker'; sticker: Sticker }
  | { op: 'patchSticker'; id: string; patch: Partial<Sticker> }
  /** 给 at 则同时留下删除记录（局域网同步据此知道这是删除而不是对方新增） */
  | { op: 'removeStickers'; ids: string[]; at?: number }
  | { op: 'patchSubscription'; id: string; patch: Partial<Subscription> }
  | { op: 'removeCategories'; ids: string[]; at?: number }
  /** 同步后整体替换删除记录 */
  | { op: 'setDeleted'; deleted: Tombstone[] };

type LibraryData = Pick<Library, 'categories' | 'stickers' | 'subscriptions' | 'deleted'>;

function withTombstones(list: Tombstone[], kind: Tombstone['kind'], ids: string[], at: number): Tombstone[] {
  const idSet = new Set(ids);
  return [...list.filter((t) => !(t.kind === kind && idSet.has(t.id))), ...ids.map((id) => ({ kind, id, at }))];
}

export function applyOps<T extends LibraryData>(state: T, ops: LibraryOp[]): T {
  if (ops.length === 0) return state;
  let categories = state.categories;
  let stickers = state.stickers;
  let subscriptions = state.subscriptions;
  let deleted = state.deleted;

  for (const op of ops) {
    switch (op.op) {
      case 'upsertCategory': {
        // 整条替换（调用方给的都是完整的分类；合并的话去掉 parentId 这种改动就丢了）
        const idx = categories.findIndex((c) => c.id === op.category.id);
        categories = idx >= 0 ? categories.map((c, i) => (i === idx ? op.category : c)) : [...categories, op.category];
        break;
      }
      case 'addSticker': {
        if (stickers.some((s) => s.id === op.sticker.id)) break;
        stickers = [...stickers, op.sticker];
        break;
      }
      case 'patchSticker': {
        stickers = stickers.map((s) => (s.id === op.id ? { ...s, ...op.patch } : s));
        break;
      }
      case 'removeStickers': {
        const ids = new Set(op.ids);
        stickers = stickers.filter((s) => !ids.has(s.id));
        if (op.at !== undefined) deleted = withTombstones(deleted, 'sticker', op.ids, op.at);
        break;
      }
      case 'patchSubscription': {
        subscriptions = subscriptions.map((s) => (s.id === op.id ? { ...s, ...op.patch } : s));
        break;
      }
      case 'removeCategories': {
        const ids = new Set(op.ids);
        categories = categories.filter((c) => !ids.has(c.id));
        if (op.at !== undefined) deleted = withTombstones(deleted, 'category', op.ids, op.at);
        break;
      }
      case 'setDeleted': {
        deleted = op.deleted;
        break;
      }
    }
  }
  return { ...state, categories, stickers, subscriptions, deleted };
}
