import type { Category, Library, Sticker, Subscription } from './types';

/**
 * 对资料库的原子修改。同步过程会分批产出这些操作，由 store 逐步应用，
 * 这样下载过程中界面就能实时看到新表情。
 */
export type LibraryOp =
  | { op: 'upsertCategory'; category: Category }
  | { op: 'addSticker'; sticker: Sticker }
  | { op: 'patchSticker'; id: string; patch: Partial<Sticker> }
  | { op: 'removeStickers'; ids: string[] }
  | { op: 'patchSubscription'; id: string; patch: Partial<Subscription> };

type LibraryData = Pick<Library, 'categories' | 'stickers' | 'subscriptions'>;

export function applyOps<T extends LibraryData>(state: T, ops: LibraryOp[]): T {
  if (ops.length === 0) return state;
  let categories = state.categories;
  let stickers = state.stickers;
  let subscriptions = state.subscriptions;

  for (const op of ops) {
    switch (op.op) {
      case 'upsertCategory': {
        const idx = categories.findIndex((c) => c.id === op.category.id);
        categories =
          idx >= 0
            ? categories.map((c, i) => (i === idx ? { ...c, ...op.category } : c))
            : [...categories, op.category];
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
        break;
      }
      case 'patchSubscription': {
        subscriptions = subscriptions.map((s) => (s.id === op.id ? { ...s, ...op.patch } : s));
        break;
      }
    }
  }
  return { ...state, categories, stickers, subscriptions };
}
