import { describe, expect, it } from 'vitest';
import type { Category, Sticker } from './types';
import {
  categoryCountsWithChildren,
  categoryIdsIncludingChildren,
  categoryLabel,
  categoryDepth,
  categoryTree,
  descendantIds,
  filterStickers,
  flattenTree,
  isSelfOrDescendant,
  rootCategoryOf,
} from './selectors';

const cats: Category[] = [
  { id: 'p', name: '动物', createdAt: 0, order: 1 },
  { id: 'c1', name: '猫', createdAt: 0, order: 3, parentId: 'p' },
  { id: 'c2', name: '狗', createdAt: 0, order: 2, parentId: 'p' },
  { id: 'g1', name: '橘猫', createdAt: 0, order: 0, parentId: 'c1' },
  { id: 'q', name: '工作', createdAt: 0, order: 0 },
  { id: 'orphan', name: '孤儿', createdAt: 0, order: 9, parentId: 'nope' },
];

function sticker(id: string, categoryId: string | null, extra: Partial<Sticker> = {}): Sticker {
  return {
    id,
    name: id,
    file: `stickers/${id}.png`,
    ext: 'png',
    size: 1,
    categoryId,
    tags: [],
    favorite: false,
    createdAt: 0,
    updatedAt: 0,
    source: { type: 'local' },
    ...extra,
  };
}

const stickers = [sticker('a', 'p'), sticker('b', 'c1'), sticker('c', 'c2'), sticker('d', 'q'), sticker('e', null), sticker('f', 'g1')];

describe('多级分类', () => {
  it('树按 order 排序，任意深度；父分类不存在的当作一级', () => {
    const tree = categoryTree(cats);
    expect(tree.map((n) => n.category.id)).toEqual(['q', 'p', 'orphan']);
    const p = tree[1];
    expect(p.children.map((c) => c.category.id)).toEqual(['c2', 'c1']);
    expect(p.children[1].children.map((c) => c.category.id)).toEqual(['g1']);
    expect(flattenTree(cats).map((n) => `${n.depth}:${n.category.id}`)).toEqual(['0:q', '0:p', '1:c2', '1:c1', '2:g1', '0:orphan']);
  });

  it('查看分类时包含所有子孙分类里的表情；own 只看直接放在里面的', () => {
    const f = (view: Parameters<typeof filterStickers>[1]['view']) => filterStickers(stickers, { view, tags: [], query: '', sort: 'oldest' }, {}, cats);
    expect(f({ kind: 'category', id: 'p' }).map((s) => s.id)).toEqual(['a', 'b', 'c', 'f']);
    expect(f({ kind: 'category', id: 'c1' }).map((s) => s.id)).toEqual(['b', 'f']);
    expect(f({ kind: 'category', id: 'p', own: true }).map((s) => s.id)).toEqual(['a']);
    expect(categoryIdsIncludingChildren(cats, 'p').sort()).toEqual(['c1', 'c2', 'g1', 'p']);
    expect(descendantIds(cats, 'c1')).toEqual(['g1']);
  });

  it('计数：父分类把所有子孙的都算上', () => {
    const counts = categoryCountsWithChildren(stickers, cats);
    expect(counts.get('p')).toBe(4);
    expect(counts.get('c1')).toBe(2);
    expect(counts.get('g1')).toBe(1);
    expect(counts.get('q')).toBe(1);
  });

  it('路径、深度、根、祖先判断', () => {
    expect(categoryLabel(cats, 'g1')).toBe('动物 / 猫 / 橘猫');
    expect(categoryLabel(cats, 'q')).toBe('工作');
    expect(categoryLabel(cats, null)).toBe('未分类');
    expect(categoryDepth(cats, 'g1')).toBe(2);
    expect(rootCategoryOf(cats, 'g1')?.id).toBe('p');
    expect(rootCategoryOf(cats, 'p')?.id).toBe('p');
    expect(isSelfOrDescendant(cats, 'p', 'g1')).toBe(true);
    expect(isSelfOrDescendant(cats, 'c1', 'c2')).toBe(false);
    expect(isSelfOrDescendant(cats, 'p', 'p')).toBe(true);
  });
});
