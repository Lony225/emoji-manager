import { describe, expect, it } from 'vitest';
import { migrate } from './migrate';

describe('migrate', () => {
  it('补全缺失字段，解除悬空引用', () => {
    const lib = migrate({
      subscriptions: [{ id: 'sub1', url: 'https://x.com/a.json' }],
      categories: [
        { id: 'c1', name: '猫' },
        { id: 'c2', name: '孤儿', subscriptionId: 'gone', packKey: 'root' },
      ],
      stickers: [
        { id: 's1', file: 'stickers/s1.gif' },
        { id: 's2', file: 'stickers/s2.png', categoryId: 'missing', tags: ['a', 'a', 3], favorite: 'yes' },
        {
          id: 's3',
          file: 'stickers/s3.png',
          source: { type: 'subscription', subscriptionId: 'gone', packKey: 'root', remoteId: 'x' },
        },
        {
          id: 's4',
          file: 'stickers/s4.png',
          source: { type: 'subscription', subscriptionId: 'sub1', packKey: 'root', remoteId: 'x' },
        },
        { id: 's4', file: 'dup.png' },
        { notAnId: true },
      ],
      settings: { theme: 'purple', gridSize: 'large', copyMode: 'file', autoSyncOnStart: 'no' },
    });
    expect(lib.subscriptions[0]).toMatchObject({
      id: 'sub1',
      name: 'https://x.com/a.json',
      deleteRemoved: true,
      autoSync: true,
      stickerCount: 0,
    });
    expect(lib.categories[0]).toMatchObject({ id: 'c1', order: 0 });
    expect(lib.categories[1].subscriptionId).toBeUndefined();
    expect(lib.stickers).toHaveLength(4);
    expect(lib.stickers[0]).toMatchObject({
      name: '表情',
      ext: 'gif',
      size: 0,
      tags: [],
      favorite: false,
      categoryId: null,
      source: { type: 'local' },
    });
    expect(lib.stickers[1]).toMatchObject({ categoryId: null, tags: ['a'], favorite: false });
    expect(lib.stickers[2].source).toEqual({ type: 'local' });
    expect(lib.stickers[3].source).toMatchObject({
      type: 'subscription',
      subscriptionId: 'sub1',
      remoteTags: [],
      remoteName: '',
    });
    expect(lib.settings).toEqual({
      theme: 'system',
      gridSize: 'large',
      copyMode: 'file',
      autoSyncOnStart: true,
      animateInGrid: true,
      floatHotkey: 'Alt+Shift+E',
      closeToTray: true,
      showNames: true,
      checkUpdatesOnStart: true,
      skippedVersion: '',
    });
  });

  it('分类可以任意多级；父不存在、指向自己或成环的升为一级', () => {
    const lib = migrate({
      categories: [
        { id: 'a', name: 'A' },
        { id: 'b', name: 'B', parentId: 'a' },
        { id: 'c', name: 'C', parentId: 'b' },
        { id: 'd', name: 'D', parentId: 'nope' },
        { id: 'e', name: 'E', parentId: 'e' },
        { id: 'x', name: 'X', parentId: 'y' },
        { id: 'y', name: 'Y', parentId: 'x' },
      ],
    });
    const parent = (id: string) => lib.categories.find((c) => c.id === id)!.parentId;
    expect(parent('b')).toBe('a');
    expect(parent('c')).toBe('b');
    expect(parent('d')).toBeUndefined();
    expect(parent('e')).toBeUndefined();
    expect(parent('x')).toBeUndefined();
    expect(parent('y')).toBeUndefined();
  });

  it('非对象直接报错', () => {
    expect(() => migrate('nope')).toThrow();
    expect(() => migrate(null)).toThrow();
  });
});
