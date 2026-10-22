import { describe, expect, it } from 'vitest';
import type { Category } from '../core/types';
import { dropPosFor, isNoop, resolveDrop } from './categoryDnd';

const cats: Category[] = [
  { id: 'a', name: 'A', createdAt: 0, order: 0 },
  { id: 'a1', name: 'A1', createdAt: 0, order: 0, parentId: 'a' },
  { id: 'a2', name: 'A2', createdAt: 0, order: 1, parentId: 'a' },
  { id: 'a1x', name: 'A1X', createdAt: 0, order: 0, parentId: 'a1' },
  { id: 'b', name: 'B', createdAt: 0, order: 1 },
  { id: 'sub', name: '订阅', createdAt: 0, order: 2, subscriptionId: 's', packKey: 'root' },
  { id: 'pack', name: '包', createdAt: 0, order: 0, parentId: 'sub', subscriptionId: 's', packKey: 'p1' },
];

describe('分类拖拽（多级）', () => {
  it('按指针位置决定放前面 / 后面 / 放进去', () => {
    const rect = { top: 100, height: 40 };
    expect(dropPosFor(105, rect)).toBe('before');
    expect(dropPosFor(120, rect)).toBe('into');
    expect(dropPosFor(135, rect)).toBe('after');
  });

  it('拖到任意分类中间 → 成为它的最后一个子分类（不限层级）', () => {
    expect(resolveDrop(cats, 'b', 'a', 'into')).toEqual({ parentId: 'a', index: 2 });
    expect(resolveDrop(cats, 'b', 'a1x', 'into')).toEqual({ parentId: 'a1x', index: 0 });
    // 带子分类的也可以整棵挪进去
    expect(resolveDrop(cats, 'a', 'b', 'into')).toEqual({ parentId: 'b', index: 0 });
  });

  it('拖到某行前后 → 进入那一行所在的层级', () => {
    expect(resolveDrop(cats, 'a1', 'b', 'before')).toEqual({ parentId: null, index: 1 });
    expect(resolveDrop(cats, 'a1', 'b', 'after')).toEqual({ parentId: null, index: 2 });
    expect(resolveDrop(cats, 'b', 'a1', 'after')).toEqual({ parentId: 'a', index: 1 });
    expect(resolveDrop(cats, 'a2', 'a1', 'before')).toEqual({ parentId: 'a', index: 0 });
    expect(resolveDrop(cats, 'b', 'a', 'before')).toEqual({ parentId: null, index: 0 });
  });

  it('不合法的放法返回 null', () => {
    expect(resolveDrop(cats, 'a', 'a', 'into')).toBeNull();
    expect(resolveDrop(cats, 'a', 'a1', 'before')).toBeNull(); // 放到自己的子分类旁边 = 放到自己下面
    expect(resolveDrop(cats, 'a', 'a1x', 'into')).toBeNull(); // 放到自己的孙分类下面：成环
    expect(resolveDrop(cats, 'pack', 'b', 'before')).toBeNull(); // 订阅包不能离开订阅
    expect(resolveDrop(cats, 'pack', 'a', 'into')).toBeNull();
    expect(resolveDrop(cats, 'pack', 'sub', 'into')).toEqual({ parentId: 'sub', index: 0 }); // 留在订阅下可以
  });

  it('同一位置视为无变化', () => {
    expect(isNoop(cats, 'b', { parentId: null, index: 1 })).toBe(true);
    expect(isNoop(cats, 'b', { parentId: null, index: 0 })).toBe(false);
    expect(isNoop(cats, 'a2', { parentId: 'a', index: 1 })).toBe(true);
  });
});
