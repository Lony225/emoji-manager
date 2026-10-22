import type { Category, Sticker } from './types';
import type { UsageMap } from '../platform/types';

export type View =
  | { kind: 'all' }
  | { kind: 'recent' }
  | { kind: 'favorites' }
  | { kind: 'uncategorized' }
  | {
      kind: 'category';
      id: string;
      /** 只看直接放在这个分类里的表情（分类顶部的“未分类”页签），不含子分类里的 */
      own?: boolean;
    }
  | { kind: 'subscription'; id: string };

export type SortKey = 'newest' | 'oldest' | 'name';

export interface Filter {
  view: View;
  tags: string[];
  query: string;
  sort: SortKey;
}

/** 同一个视图（分类视图不区分“全部”和“未分类”页签，侧栏高亮用） */
export function sameView(a: View, b: View): boolean {
  if (a.kind !== b.kind) return false;
  if ('id' in a && 'id' in b) return a.id === b.id;
  return true;
}

// ---------------------------------------------------------------- 分类树（任意多级，像文件夹）

export function sortedCategories(categories: Category[]): Category[] {
  return [...categories].sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
}

/** 一级分类（按顺序） */
export function topCategories(categories: Category[]): Category[] {
  return sortedCategories(categories).filter((c) => !c.parentId);
}

/** 某个分类的直接子分类（按顺序） */
export function childCategories(categories: Category[], parentId: string): Category[] {
  return sortedCategories(categories).filter((c) => c.parentId === parentId);
}

export interface CategoryNode {
  category: Category;
  children: CategoryNode[];
}

function buildChildren(sorted: Category[], byParent: Map<string | null, Category[]>, parentId: string | null, seen: Set<string>): CategoryNode[] {
  return (byParent.get(parentId) ?? [])
    .filter((c) => !seen.has(c.id))
    .map((c) => {
      seen.add(c.id);
      return { category: c, children: buildChildren(sorted, byParent, c.id, seen) };
    });
}

/** 整棵分类树（一级分类及其任意深度的子分类，均按 order 排序） */
export function categoryTree(categories: Category[]): CategoryNode[] {
  const sorted = sortedCategories(categories);
  const ids = new Set(sorted.map((c) => c.id));
  const byParent = new Map<string | null, Category[]>();
  for (const c of sorted) {
    // 父分类不存在的当作一级
    const key = c.parentId && ids.has(c.parentId) ? c.parentId : null;
    const list = byParent.get(key) ?? [];
    list.push(c);
    byParent.set(key, list);
  }
  return buildChildren(sorted, byParent, null, new Set());
}

/** 树形顺序的扁平列表（父在前，紧跟它的子孙），depth 从 0 起，用于下拉框等 */
export function flattenTree(categories: Category[]): { category: Category; depth: number }[] {
  const out: { category: Category; depth: number }[] = [];
  const walk = (nodes: CategoryNode[], depth: number) => {
    for (const n of nodes) {
      out.push({ category: n.category, depth });
      walk(n.children, depth + 1);
    }
  };
  walk(categoryTree(categories), 0);
  return out;
}

/** 某个分类的所有子孙分类 id（不含自己） */
export function descendantIds(categories: Category[], id: string): string[] {
  const out: string[] = [];
  const queue = [id];
  const seen = new Set<string>([id]);
  while (queue.length) {
    const cur = queue.shift()!;
    for (const c of categories) {
      if (c.parentId === cur && !seen.has(c.id)) {
        seen.add(c.id);
        out.push(c.id);
        queue.push(c.id);
      }
    }
  }
  return out;
}

/** 一个分类本身加上它所有子孙分类的 id */
export function categoryIdsIncludingChildren(categories: Category[], id: string): string[] {
  return [id, ...descendantIds(categories, id)];
}

/** b 是否是 a 的子孙（或就是 a 自己） */
export function isSelfOrDescendant(categories: Category[], a: string, b: string): boolean {
  return a === b || descendantIds(categories, a).includes(b);
}

/** 从根到该分类的路径（含自己） */
export function categoryPath(categories: Category[], id: string): Category[] {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const path: Category[] = [];
  const seen = new Set<string>();
  let cur = byId.get(id);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    path.unshift(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return path;
}

/** 分类深度：一级为 0 */
export function categoryDepth(categories: Category[], id: string): number {
  return Math.max(0, categoryPath(categories, id).length - 1);
}

/** 顶层分类：沿着父分类一路往上找到的根 */
export function rootCategoryOf(categories: Category[], id: string): Category | undefined {
  return categoryPath(categories, id)[0];
}

/** “一级 / 二级 / 三级”形式的完整路径名 */
export function categoryLabel(categories: Category[], id: string | null): string {
  if (id === null) return '未分类';
  const path = categoryPath(categories, id);
  if (path.length === 0) return '未知分类';
  return path.map((c) => c.name).join(' / ');
}

// ---------------------------------------------------------------- 过滤与计数

/**
 * 按视图、标签、关键词过滤并排序。
 * 查看分类时包含它所有子孙分类里的表情（own 为 true 时只看直接放在里面的）；“最近使用”固定按最近一次使用时间排序。
 */
export function filterStickers(stickers: Sticker[], f: Filter, usage: UsageMap = {}, categories: Category[] = []): Sticker[] {
  const terms = f.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const catIds =
    f.view.kind === 'category'
      ? new Set(f.view.own ? [f.view.id] : categoryIdsIncludingChildren(categories, f.view.id))
      : null;
  const list = stickers.filter((s) => {
    switch (f.view.kind) {
      case 'recent':
        if (!usage[s.id]) return false;
        break;
      case 'favorites':
        if (!s.favorite) return false;
        break;
      case 'uncategorized':
        if (s.categoryId !== null) return false;
        break;
      case 'category':
        if (s.categoryId === null || !catIds!.has(s.categoryId)) return false;
        break;
      case 'subscription':
        if (s.source.type !== 'subscription' || s.source.subscriptionId !== f.view.id) return false;
        break;
      default:
        break;
    }
    if (f.tags.length > 0 && !f.tags.every((t) => s.tags.includes(t))) return false;
    if (terms.length > 0) {
      const hay = `${s.name} ${s.tags.join(' ')}`.toLowerCase();
      if (!terms.every((t) => hay.includes(t))) return false;
    }
    return true;
  });
  if (f.view.kind === 'recent') {
    list.sort((a, b) => (usage[b.id]?.last ?? 0) - (usage[a.id]?.last ?? 0));
    return list;
  }
  switch (f.sort) {
    case 'newest':
      list.sort((a, b) => b.createdAt - a.createdAt);
      break;
    case 'oldest':
      list.sort((a, b) => a.createdAt - b.createdAt);
      break;
    case 'name':
      list.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
      break;
  }
  return list;
}

export interface TagCount {
  tag: string;
  count: number;
}

export function tagCounts(stickers: Sticker[]): TagCount[] {
  const counts = new Map<string, number>();
  for (const s of stickers) for (const t of s.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  return Array.from(counts, ([tag, count]) => ({ tag, count })).sort(
    (a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'zh-Hans-CN'),
  );
}

/** 每个分类里直接包含的表情数量；键 null 表示未分类 */
export function categoryCounts(stickers: Sticker[]): Map<string | null, number> {
  const counts = new Map<string | null, number>();
  for (const s of stickers) counts.set(s.categoryId, (counts.get(s.categoryId) ?? 0) + 1);
  return counts;
}

/** 每个分类的数量，把所有子孙分类里的也算上 */
export function categoryCountsWithChildren(stickers: Sticker[], categories: Category[]): Map<string, number> {
  const direct = categoryCounts(stickers);
  const byId = new Map(categories.map((c) => [c.id, c]));
  const out = new Map<string, number>();
  for (const c of categories) out.set(c.id, 0);
  for (const c of categories) {
    const n = direct.get(c.id) ?? 0;
    if (n === 0) continue;
    // 沿父链一路加上去
    const seen = new Set<string>();
    let cur: Category | undefined = c;
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      out.set(cur.id, (out.get(cur.id) ?? 0) + n);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
  }
  return out;
}

export function subscriptionCounts(stickers: Sticker[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const s of stickers) {
    if (s.source.type === 'subscription') {
      counts.set(s.source.subscriptionId, (counts.get(s.source.subscriptionId) ?? 0) + 1);
    }
  }
  return counts;
}
