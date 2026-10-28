import { describe, expect, it } from 'vitest';
import { applyOps } from '../ops';
import type { Category, Sticker, Tombstone } from '../types';
import { applySideOps, type ApplyDeps } from './apply';
import { mergeStates } from './merge';
import { buildSyncState, parseSyncState, sideOpsEmpty, type SyncCategory, type SyncState, type SyncSticker } from './protocol';

const NOW = 1_000_000;

function cat(id: string, name: string, extra: Partial<SyncCategory> = {}): SyncCategory {
  return { id, name, createdAt: 100, updatedAt: 100, order: 0, ...extra };
}

function st(id: string, name: string, extra: Partial<SyncSticker> = {}): SyncSticker {
  return {
    id,
    name,
    file: `stickers/${id}.png`,
    ext: 'png',
    size: 10,
    categoryId: null,
    tags: [],
    favorite: false,
    createdAt: 100,
    updatedAt: 100,
    ...extra,
  };
}

function state(id: string, categories: SyncCategory[] = [], stickers: SyncSticker[] = [], deleted: Tombstone[] = []): SyncState {
  return { proto: 1, device: { id, name: id }, categories, stickers, deleted };
}

describe('mergeStates', () => {
  it('两边一样时什么都不做', () => {
    const a = state('a', [cat('c1', '猫')], [st('s1', '开心', { categoryId: 'c1' })]);
    const b = state('b', [cat('c1', '猫')], [st('s1', '开心', { categoryId: 'c1' })]);
    const plan = mergeStates(a, b, NOW);
    expect(sideOpsEmpty(plan.local)).toBe(true);
    expect(sideOpsEmpty(plan.remote)).toBe(true);
  });

  it('各自新增的表情和分类互相补齐，图片要从对方取', () => {
    const a = state('a', [cat('c1', '猫')], [st('s1', 'A 的')]);
    const b = state('b', [cat('c2', '狗')], [st('s2', 'B 的')]);
    const plan = mergeStates(a, b, NOW);
    expect(plan.local.categories.map((c) => c.id)).toEqual(['c2']);
    expect(plan.remote.categories.map((c) => c.id)).toEqual(['c1']);
    expect(plan.local.stickers).toEqual([{ sticker: st('s2', 'B 的'), file: 'fetch' }]);
    expect(plan.remote.stickers).toEqual([{ sticker: st('s1', 'A 的'), file: 'fetch' }]);
    expect(plan.local.removeStickers).toEqual([]);
    expect(plan.remote.removeStickers).toEqual([]);
  });

  it('同一个表情两边都改过：改动时间更新的一方胜出，文件不用重传', () => {
    const a = state('a', [], [st('s1', 'A 改的', { updatedAt: 300, tags: ['x'] })]);
    const b = state('b', [], [st('s1', 'B 改的', { updatedAt: 200, favorite: true })]);
    const plan = mergeStates(a, b, NOW);
    expect(sideOpsEmpty(plan.local)).toBe(true);
    expect(plan.remote.stickers).toEqual([{ sticker: st('s1', 'A 改的', { updatedAt: 300, tags: ['x'] }), file: 'keep' }]);
  });

  it('改动时间相同时也能决出唯一的胜者，且与方向无关', () => {
    const a = state('a', [], [st('s1', '甲', { updatedAt: 300 })]);
    const b = state('b', [], [st('s1', '乙', { updatedAt: 300 })]);
    const ab = mergeStates(a, b, NOW);
    const ba = mergeStates(b, a, NOW);
    const winner = ab.local.stickers[0]?.sticker.name ?? ab.remote.stickers[0]?.sticker.name;
    const winner2 = ba.local.stickers[0]?.sticker.name ?? ba.remote.stickers[0]?.sticker.name;
    expect(winner).toBe(winner2);
    expect(ab.local.stickers.length + ab.remote.stickers.length).toBe(1);
  });

  it('一边删了的表情：删除记录比对方的记录新 → 对方也删；对方后来又改过 → 复活', () => {
    const a = state('a', [], [], [{ kind: 'sticker', id: 's1', at: 500 }, { kind: 'sticker', id: 's2', at: 150 }]);
    const b = state('b', [], [st('s1', '要被删', { updatedAt: 100 }), st('s2', '删后又改', { updatedAt: 400 })]);
    const plan = mergeStates(a, b, NOW);
    expect(plan.remote.removeStickers).toEqual(['s1']);
    expect(plan.local.stickers).toEqual([{ sticker: st('s2', '删后又改', { updatedAt: 400 }), file: 'fetch' }]);
    // 复活的那条删除记录被清掉，仍然生效的保留
    expect(plan.deleted).toEqual([{ kind: 'sticker', id: 's1', at: 500 }]);
  });

  it('删除分类：分类消失，里面的表情（对方没动过的）归到未分类', () => {
    const a = state('a', [], [st('s1', 'x', { categoryId: 'c1', updatedAt: 100 })], [{ kind: 'category', id: 'c1', at: 900 }]);
    const b = state('b', [cat('c1', '猫', { updatedAt: 100 })], [st('s1', 'x', { categoryId: 'c1', updatedAt: 100 })]);
    const plan = mergeStates(a, b, NOW);
    expect(plan.remote.removeCategories).toEqual(['c1']);
    expect(plan.remote.stickers).toEqual([{ sticker: st('s1', 'x', { categoryId: null, updatedAt: 100 }), file: 'keep' }]);
    expect(plan.local.stickers).toEqual([{ sticker: st('s1', 'x', { categoryId: null, updatedAt: 100 }), file: 'keep' }]);
  });

  it('两边各自导入过同一张图（hash 相同）：合并成一条，另一边改名复用自己的文件，不用传', () => {
    const a = state('a', [], [st('old', '先导入的', { hash: 'h1', createdAt: 100, updatedAt: 100 })]);
    const b = state('b', [], [st('new', '后导入但改过名', { hash: 'h1', createdAt: 200, updatedAt: 300, tags: ['t'] })]);
    const plan = mergeStates(a, b, NOW);
    // 保留 id 更早的 old，元信息取改动更新的 new 的
    expect(plan.local.stickers).toEqual([{ sticker: st('old', '后导入但改过名', { hash: 'h1', createdAt: 100, updatedAt: 300, tags: ['t'] }), file: 'keep' }]);
    expect(plan.remote.stickers).toEqual([
      { sticker: st('old', '后导入但改过名', { hash: 'h1', createdAt: 100, updatedAt: 300, tags: ['t'] }), file: { renameFrom: 'stickers/new.png' } },
    ]);
    expect(plan.remote.removeStickers).toEqual(['new']);
    expect(plan.deleted).toEqual([{ kind: 'sticker', id: 'new', at: NOW }]);
  });

  it('父分类不存在或成环时升为一级；表情的分类不存在时归到未分类', () => {
    const a = state('a', [cat('c1', '甲', { parentId: 'c2', updatedAt: 200 }), cat('c2', '乙', { parentId: 'c1', updatedAt: 200 })], [st('s1', 'x', { categoryId: 'gone' })]);
    const b = state('b');
    const plan = mergeStates(a, b, NOW);
    expect(plan.remote.categories.every((c) => c.parentId === undefined)).toBe(true);
    expect(plan.remote.stickers[0].sticker.categoryId).toBeNull();
    expect(plan.local.stickers[0]).toMatchObject({ sticker: { id: 's1', categoryId: null }, file: 'keep' });
  });

  it('合并结果是幂等的：再合一次没有差异', () => {
    const a = state('a', [cat('c1', '猫')], [st('s1', 'A', { categoryId: 'c1' }), st('d1', '重复', { hash: 'h' })], [{ kind: 'sticker', id: 'z', at: 10 }]);
    const b = state('b', [cat('c2', '狗')], [st('s2', 'B'), st('d2', '重复2', { hash: 'h', createdAt: 50 })], [{ kind: 'category', id: 'c1', at: 50 }]);
    const plan = mergeStates(a, b, NOW);
    const applyTo = (s: SyncState, ops: typeof plan.local): SyncState => {
      const cats = new Map(s.categories.map((c) => [c.id, c]));
      for (const c of ops.categories) cats.set(c.id, c);
      for (const id of ops.removeCategories) cats.delete(id);
      const sts = new Map(s.stickers.map((x) => [x.id, x]));
      for (const o of ops.stickers) sts.set(o.sticker.id, o.sticker);
      for (const id of ops.removeStickers) sts.delete(id);
      return { ...s, categories: [...cats.values()], stickers: [...sts.values()], deleted: plan.deleted };
    };
    const a2 = applyTo(a, plan.local);
    const b2 = applyTo(b, plan.remote);
    expect(a2.stickers.map((s) => s.id).sort()).toEqual(b2.stickers.map((s) => s.id).sort());
    expect(a2.stickers.filter((s) => s.hash === 'h')).toHaveLength(1);
    const again = mergeStates(a2, b2, NOW + 1);
    expect(sideOpsEmpty(again.local)).toBe(true);
    expect(sideOpsEmpty(again.remote)).toBe(true);
  });
});

describe('parseSyncState', () => {
  it('过滤掉不合法的条目', () => {
    const s = parseSyncState({
      proto: 1,
      device: { id: 'x', name: 'y' },
      categories: [cat('c1', '猫'), { id: 'bad' }, cat('self', '自己指自己', { parentId: 'self' })],
      stickers: [st('s1', 'ok'), st('s2', '路径不对', { file: '../etc/passwd' }), st('s3', '扩展名不对', { ext: 'P NG' }), 'junk'],
      deleted: [{ kind: 'sticker', id: 'a', at: 1 }, { kind: 'x', id: 'b', at: 1 }],
    });
    expect(s.categories.map((c) => c.id)).toEqual(['c1', 'self']);
    expect(s.categories[1].parentId).toBeUndefined();
    expect(s.stickers.map((x) => x.id)).toEqual(['s1']);
    expect(s.deleted).toEqual([{ kind: 'sticker', id: 'a', at: 1 }]);
  });

  it('协议版本不对时报错', () => {
    expect(() => parseSyncState({ proto: 99 })).toThrow(/不兼容/);
  });
});

describe('applySideOps', () => {
  function harness(categories: Category[], stickers: Sticker[], files: string[]) {
    const fs = new Set(files);
    let lib = { categories, stickers, subscriptions: [], deleted: [] as Tombstone[] };
    const deps: ApplyDeps = {
      platform: {
        async exists(rel) {
          return fs.has(rel);
        },
        async rename(from, to) {
          if (!fs.has(from)) throw new Error('missing');
          fs.delete(from);
          fs.add(to);
        },
        async remove(rel) {
          fs.delete(rel);
        },
      },
      getState: () => lib,
      apply: (ops) => {
        lib = applyOps(lib, ops);
      },
      now: () => NOW,
    };
    return { deps, fs, get lib() { return lib; } };
  }

  const localSticker = (id: string, extra: Partial<Sticker> = {}): Sticker => ({
    id,
    name: id,
    file: `stickers/${id}.png`,
    ext: 'png',
    size: 10,
    categoryId: null,
    tags: [],
    favorite: false,
    createdAt: 100,
    updatedAt: 100,
    source: { type: 'local' },
    ...extra,
  });

  it('新增 / 更新 / 删除 / 改名复用文件，缺文件的跳过', async () => {
    const h = harness(
      [{ id: 'c1', name: '旧名', createdAt: 1, order: 0 }],
      [localSticker('s1', { thumb: 'thumbs/s1.webp' }), localSticker('dup')],
      ['stickers/s1.png', 'thumbs/s1.webp', 'stickers/dup.png', 'stickers/n1.png'],
    );
    const r = await applySideOps(
      {
        categories: [cat('c1', '新名', { updatedAt: 500 }), cat('c2', '新分类')],
        removeCategories: [],
        stickers: [
          { sticker: st('s1', '改了名', { updatedAt: 500, categoryId: 'c2' }), file: 'keep' },
          { sticker: st('n1', '新来的'), file: 'keep' },
          { sticker: st('keep', '合并后保留的', { hash: 'h' }), file: { renameFrom: 'stickers/dup.png' } },
          { sticker: st('missing', '没传过来'), file: 'fetch' },
        ],
        removeStickers: ['dup'],
      },
      [{ kind: 'sticker', id: 'dup', at: NOW }],
      h.deps,
    );
    expect(r).toMatchObject({ added: 2, updated: 1, removed: 1, skipped: 1, categories: 2 });
    expect(r.errors[0]).toMatch(/没传过来/);
    expect(h.lib.categories.map((c) => c.name).sort()).toEqual(['新分类', '新名']);
    const s1 = h.lib.stickers.find((s) => s.id === 's1')!;
    expect(s1).toMatchObject({ name: '改了名', categoryId: 'c2', thumb: 'thumbs/s1.webp', source: { type: 'local' } });
    expect(h.lib.stickers.find((s) => s.id === 'keep')!.file).toBe('stickers/keep.png');
    expect(h.fs.has('stickers/keep.png')).toBe(true);
    expect(h.fs.has('stickers/dup.png')).toBe(false);
    expect(h.lib.stickers.some((s) => s.id === 'dup')).toBe(false);
    expect(h.lib.stickers.some((s) => s.id === 'missing')).toBe(false);
    expect(h.lib.deleted).toEqual([{ kind: 'sticker', id: 'dup', at: NOW }]);
  });

  it('同步期间本机新产生的删除记录不会被合并结果覆盖', async () => {
    const h = harness([], [localSticker('s1')], ['stickers/s1.png']);
    h.deps.apply([{ op: 'removeStickers', ids: ['s1'], at: NOW + 50 }]);
    await applySideOps({ categories: [], removeCategories: [], stickers: [], removeStickers: [] }, [{ kind: 'sticker', id: 'old', at: NOW - 10 }], h.deps, NOW);
    expect(h.lib.deleted).toEqual(expect.arrayContaining([{ kind: 'sticker', id: 'old', at: NOW - 10 }, { kind: 'sticker', id: 's1', at: NOW + 50 }]));
    expect(h.lib.deleted).toHaveLength(2);
  });

  it('删除分类时里面的表情归到未分类', async () => {
    const h = harness([{ id: 'c1', name: '猫', createdAt: 1, order: 0 }], [localSticker('s1', { categoryId: 'c1' })], ['stickers/s1.png']);
    await applySideOps({ categories: [], removeCategories: ['c1'], stickers: [], removeStickers: [] }, [], h.deps);
    expect(h.lib.categories).toEqual([]);
    expect(h.lib.stickers[0].categoryId).toBeNull();
  });
});

describe('buildSyncState', () => {
  it('只带同步需要的字段', () => {
    const s = buildSyncState(
      { id: 'me', name: '我' },
      {
        categories: [{ id: 'c1', name: '猫', createdAt: 1, order: 0, subscriptionId: 'sub', packKey: 'root' }],
        stickers: [localSticker('s1', { thumb: 'thumbs/x.webp', hash: 'h' })],
        deleted: [],
      },
    );
    expect(s.categories[0]).toEqual({ id: 'c1', name: '猫', createdAt: 1, updatedAt: 1, order: 0 });
    expect(s.stickers[0]).toEqual({ id: 's1', name: 's1', file: 'stickers/s1.png', ext: 'png', size: 10, hash: 'h', categoryId: null, tags: [], favorite: false, createdAt: 100, updatedAt: 100 });
  });
  const localSticker = (id: string, extra: Partial<Sticker> = {}): Sticker => ({
    id,
    name: id,
    file: `stickers/${id}.png`,
    ext: 'png',
    size: 10,
    categoryId: null,
    tags: [],
    favorite: false,
    createdAt: 100,
    updatedAt: 100,
    source: { type: 'local' },
    ...extra,
  });
});
