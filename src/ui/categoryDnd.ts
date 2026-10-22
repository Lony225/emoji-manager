import type { Category } from '../core/types';
import { isSelfOrDescendant, sortedCategories } from '../core/selectors';

export const CATEGORY_DRAG_TYPE = 'application/x-emoji-category';

export type DropPos = 'before' | 'after' | 'into';

export interface DropTarget {
  parentId: string | null;
  index: number;
}

/** 根据指针在行内的位置决定放法：上 1/4 放前面、下 1/4 放后面、中间放进去（成为它的子分类） */
export function dropPosFor(clientY: number, rect: { top: number; height: number }): DropPos {
  const ratio = (clientY - rect.top) / Math.max(1, rect.height);
  if (ratio < 0.25) return 'before';
  if (ratio > 0.75) return 'after';
  return 'into';
}

function isLockedPack(c: Category): boolean {
  return !!c.subscriptionId && !!c.packKey && c.packKey !== 'root';
}

/**
 * 把“拖 dragId 到 targetId 的 pos 位置”换算成目标父分类和同级序号；不合法返回 null。
 * index 按不含被拖项的同级列表计算，和 store.reorderCategory 的约定一致。
 */
export function resolveDrop(categories: Category[], dragId: string, targetId: string, pos: DropPos): DropTarget | null {
  if (dragId === targetId) return null;
  const sorted = sortedCategories(categories);
  const drag = sorted.find((c) => c.id === dragId);
  const target = sorted.find((c) => c.id === targetId);
  if (!drag || !target) return null;

  let parentId: string | null;
  let index: number;
  if (pos === 'into') {
    parentId = target.id;
    index = sorted.filter((c) => c.parentId === target.id && c.id !== dragId).length;
  } else {
    parentId = target.parentId ?? null;
    const siblings = sorted.filter((c) => (c.parentId ?? null) === parentId && c.id !== dragId);
    index = siblings.findIndex((c) => c.id === target.id);
    if (index < 0) return null;
    if (pos === 'after') index++;
  }

  // 不能放到自己或自己的子孙下面（会成环）
  if (parentId && isSelfOrDescendant(categories, dragId, parentId)) return null;
  const parentChanged = (drag.parentId ?? null) !== parentId;
  if (parentChanged && isLockedPack(drag)) return null; // 订阅包固定在订阅分类下
  return { parentId, index };
}

/** 位置是否和现状一样（这种放下不用做任何事） */
export function isNoop(categories: Category[], dragId: string, target: DropTarget): boolean {
  const sorted = sortedCategories(categories);
  const drag = sorted.find((c) => c.id === dragId);
  if (!drag) return true;
  if ((drag.parentId ?? null) !== target.parentId) return false;
  const siblings = sorted.filter((c) => (c.parentId ?? null) === target.parentId);
  return siblings.findIndex((c) => c.id === dragId) === target.index;
}
