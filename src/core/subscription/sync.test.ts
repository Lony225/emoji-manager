import { describe, expect, it } from 'vitest';
import { applyOps } from '../ops';
import type { Category, Sticker, Subscription, Tombstone } from '../types';
import { syncSubscription, type SyncDeps } from './sync';

/** 内存里的假平台：routes 表示远端文件，files 表示本地数据目录 */
function fakePlatform(routes: Record<string, string | Uint8Array>) {
  const files = new Map<string, Uint8Array>();
  const requests: string[] = [];
  const platform: SyncDeps['platform'] = {
    async fetchText(url) {
      requests.push(url);
      const body = routes[url];
      if (body === undefined) return { ok: false, status: 404, text: '', finalUrl: url };
      return { ok: true, status: 200, text: typeof body === 'string' ? body : '', finalUrl: url };
    },
    async download(url, rel) {
      requests.push(url);
      const body = routes[url];
      if (body === undefined) throw new Error('HTTP 404');
      const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
      files.set(rel, bytes);
      const ct = url.endsWith('.gif') ? 'image/gif' : url.endsWith('.png') ? 'image/png' : url.endsWith('.txt') ? 'text/plain' : 'image/webp';
      return { size: bytes.length, contentType: ct };
    },
    async remove(rel) {
      files.delete(rel);
    },
    async rename(from, to) {
      const v = files.get(from);
      if (!v) throw new Error('missing');
      files.set(to, v);
      files.delete(from);
    },
  };
  return { platform, files, requests, routes };
}

interface World {
  categories: Category[];
  stickers: Sticker[];
  subscriptions: Subscription[];
  deleted: Tombstone[];
}

function makeSub(url: string, extra: Partial<Subscription> = {}): Subscription {
  return { id: 'sub1', url, name: 'x', addedAt: 0, stickerCount: 0, deleteRemoved: true, autoSync: true, ...extra };
}

function harness(routes: Record<string, string | Uint8Array>, world?: Partial<World>) {
  const fp = fakePlatform(routes);
  let state: World = { categories: [], stickers: [], subscriptions: [makeSub(MANIFEST)], deleted: [], ...world };
  let seq = 0;
  let clock = 1000;
  const deps: SyncDeps = {
    platform: fp.platform,
    now: () => ++clock,
    newId: () => `id${++seq}`,
    apply: (ops) => {
      state = applyOps(state, ops);
    },
    concurrency: 2,
  };
  return {
    ...fp,
    deps,
    get state() {
      return state;
    },
    run: (sub?: Subscription) => syncSubscription(sub ?? state.subscriptions[0], state, deps),
  };
}

const MANIFEST = 'https://h.test/p/pack.json';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8]);

const v1 = JSON.stringify({
  name: '猫猫',
  version: '1',
  tags: ['猫'],
  stickers: [
    { id: 'a', url: 'a.png', name: '开心', tags: ['开心'] },
    { id: 'b', url: 'b.gif', name: '哭' },
  ],
});

describe('syncSubscription', () => {
  it('首次同步：创建分类、下载表情、合并包标签', async () => {
    const h = harness({ [MANIFEST]: v1, 'https://h.test/p/a.png': PNG, 'https://h.test/p/b.gif': PNG });
    const r = await h.run();
    expect(r).toMatchObject({ added: 2, updated: 0, removed: 0, failed: 0, packs: 1 });
    expect(h.state.categories).toHaveLength(1);
    const cat = h.state.categories[0];
    expect(cat).toMatchObject({ name: '猫猫', subscriptionId: 'sub1', packKey: 'root', remoteName: '猫猫', order: 0 });
    const a = h.state.stickers.find((s) => s.source.type === 'subscription' && s.source.remoteId === 'a')!;
    expect(a).toMatchObject({ name: '开心', ext: 'png', categoryId: cat.id, tags: ['猫', '开心'] });
    expect(a.file).toMatch(/^stickers\/id\d+\.png$/);
    expect(h.files.has(a.file)).toBe(true);
    expect(h.state.subscriptions[0]).toMatchObject({ name: '猫猫', remoteVersion: '1', stickerCount: 2, lastError: undefined });
  });

  it('再次同步：无变化时不下载；远端改名/改标签时保留用户的修改', async () => {
    const h = harness({ [MANIFEST]: v1, 'https://h.test/p/a.png': PNG, 'https://h.test/p/b.gif': PNG });
    await h.run();
    const before = h.requests.length;
    const r2 = await h.run();
    expect(r2).toMatchObject({ added: 0, updated: 0, removed: 0 });
    expect(h.requests.length).toBe(before + 1); // 只拉了清单

    // 用户改名 + 加标签 + 移到别的分类
    const a = h.state.stickers.find((s) => s.source.type === 'subscription' && s.source.remoteId === 'a')!;
    const mine: Category = { id: 'mine', name: '我的', createdAt: 0, order: 5 };
    h.deps.apply([
      { op: 'upsertCategory', category: mine },
      { op: 'patchSticker', id: a.id, patch: { name: '我改的名', tags: [...a.tags, '自定义'], categoryId: 'mine' } },
    ]);
    const b = h.state.stickers.find((s) => s.source.type === 'subscription' && s.source.remoteId === 'b')!;
    h.deps.apply([{ op: 'patchSticker', id: b.id, patch: { categoryId: null } }]);

    // 远端：a 改了名字和标签，b 改了名字
    h.routes[MANIFEST] = JSON.stringify({
      name: '猫猫 2',
      tags: ['喵'],
      stickers: [
        { id: 'a', url: 'a.png', name: '远端新名', tags: ['开心', '新标签'] },
        { id: 'b', url: 'b.gif', name: '大哭' },
      ],
    });
    const r3 = await h.run();
    expect(r3).toMatchObject({ added: 0, updated: 2, removed: 0 });
    const a2 = h.state.stickers.find((s) => s.id === a.id)!;
    expect(a2.name).toBe('我改的名'); // 用户改过的名字保留
    expect(a2.tags).toEqual(['自定义', '喵', '开心', '新标签']); // 用户标签保留，远端标签以新清单为准（旧的"猫"被替换）
    expect(a2.categoryId).toBe('mine'); // 用户移动过的分类保留
    const b2 = h.state.stickers.find((s) => s.id === b.id)!;
    expect(b2.name).toBe('大哭'); // 没改过名字的跟随远端
    expect(b2.categoryId).toBeNull(); // 用户移到未分类的不拉回
    expect(h.state.categories.find((c) => c.packKey === 'root')!.name).toBe('猫猫 2'); // 分类名跟随远端
  });

  it('URL 变了会重新下载并删除旧文件', async () => {
    const h = harness({ [MANIFEST]: v1, 'https://h.test/p/a.png': PNG, 'https://h.test/p/b.gif': PNG, 'https://h.test/p/a2.png': PNG });
    await h.run();
    const a = h.state.stickers.find((s) => s.source.type === 'subscription' && s.source.remoteId === 'a')!;
    h.routes[MANIFEST] = v1.replace('"a.png"', '"a2.png"');
    const r = await h.run();
    expect(r.updated).toBe(1);
    const a2 = h.state.stickers.find((s) => s.id === a.id)!;
    expect(a2.file).not.toBe(a.file);
    expect(h.files.has(a.file)).toBe(false);
    expect(h.files.has(a2.file)).toBe(true);
    expect(a2.source).toMatchObject({ url: 'https://h.test/p/a2.png' });
  });

  it('远端移除：按订阅设置删除或保留', async () => {
    const h = harness({ [MANIFEST]: v1, 'https://h.test/p/a.png': PNG, 'https://h.test/p/b.gif': PNG });
    await h.run();
    h.routes[MANIFEST] = JSON.stringify({ name: '猫猫', stickers: [{ id: 'a', url: 'a.png' }] });
    const keep = await h.run({ ...h.state.subscriptions[0], deleteRemoved: false });
    expect(keep.removed).toBe(0);
    expect(h.state.stickers).toHaveLength(2);
    const del = await h.run();
    expect(del.removed).toBe(1);
    expect(h.state.stickers).toHaveLength(1);
    expect(h.files.size).toBe(1);
  });

  it('用户删除过的表情不再拉回（hiddenKeys）', async () => {
    const h = harness({ [MANIFEST]: v1, 'https://h.test/p/a.png': PNG, 'https://h.test/p/b.gif': PNG });
    await h.run();
    const b = h.state.stickers.find((s) => s.source.type === 'subscription' && s.source.remoteId === 'b')!;
    h.deps.apply([
      { op: 'removeStickers', ids: [b.id] },
      { op: 'patchSubscription', id: 'sub1', patch: { hiddenKeys: ['root\u0000b'] } },
    ]);
    const r = await h.run();
    expect(r.added).toBe(0);
    expect(h.state.stickers).toHaveLength(1);
  });

  it('单个图片失败不影响其他，错误汇总到订阅', async () => {
    const h = harness({ [MANIFEST]: v1, 'https://h.test/p/a.png': PNG });
    const r = await h.run();
    expect(r).toMatchObject({ added: 1, failed: 1 });
    expect(r.errors[0]).toMatch(/哭/);
    expect(h.state.subscriptions[0].lastError).toMatch(/哭/);
    expect(h.state.subscriptions[0].lastSuccessAt).toBeDefined();
  });

  it('下载到的不是图片时报错', async () => {
    const h = harness({
      [MANIFEST]: JSON.stringify({ stickers: [{ id: 'x', url: 'x.txt' }, { id: 'y', url: 'noext' }] }),
      'https://h.test/p/x.txt': 'hello',
      'https://h.test/p/noext': PNG,
    });
    const r = await h.run();
    expect(r.failed).toBe(1);
    expect(r.errors[0]).toMatch(/不是图片/);
    // 没有扩展名的按 content-type 识别，先下到 tmp 再改名
    const y = h.state.stickers[0];
    expect(y.ext).toBe('webp');
    expect(y.file).toMatch(/^stickers\//);
    expect([...h.files.keys()].some((k) => k.startsWith('tmp/'))).toBe(false);
  });

  it('清单拉取失败：抛错并记录 lastError，不动已有表情', async () => {
    const h = harness({ [MANIFEST]: v1, 'https://h.test/p/a.png': PNG, 'https://h.test/p/b.gif': PNG });
    await h.run();
    delete h.routes[MANIFEST];
    await expect(h.run()).rejects.toThrow(/HTTP 404/);
    expect(h.state.subscriptions[0].lastError).toMatch(/404/);
    expect(h.state.stickers).toHaveLength(2);
  });

  it('多包：每个包一个分类；子包抓取失败时不删它的表情', async () => {
    const root = JSON.stringify({
      name: '合集',
      packs: [
        { name: '狗狗', tags: ['狗'], stickers: [{ id: 'd1', url: 'dog/1.png' }] },
        { key: 'cats', url: 'cats.json' },
      ],
    });
    const h = harness({
      [MANIFEST]: root,
      'https://h.test/p/cats.json': JSON.stringify({ name: '猫猫', stickers: [{ id: 'c1', url: 'cat/1.png' }] }),
      'https://h.test/p/dog/1.png': PNG,
      'https://h.test/p/cat/1.png': PNG,
    });
    const r = await h.run();
    expect(r).toMatchObject({ added: 2, packs: 2 });
    // 订阅名成为一级分类，两个包是它的二级分类
    expect(h.state.categories.map((c) => c.name).sort()).toEqual(['合集', '狗狗', '猫猫']);
    const parent = h.state.categories.find((c) => c.name === '合集')!;
    expect(parent).toMatchObject({ packKey: 'root', subscriptionId: 'sub1' });
    expect(parent.parentId).toBeUndefined();
    for (const name of ['狗狗', '猫猫']) {
      expect(h.state.categories.find((c) => c.name === name)!.parentId).toBe(parent.id);
    }
    expect(h.state.stickers.every((s) => s.categoryId !== parent.id)).toBe(true);

    delete h.routes['https://h.test/p/cats.json'];
    const r2 = await h.run();
    expect(r2.removed).toBe(0);
    expect(r2.errors[0]).toMatch(/子包/);
    expect(h.state.stickers).toHaveLength(2);
  });

  it('订阅从单包变成多包：原分类升级为父分类，用户移到别处的子分类会被拉回', async () => {
    const h = harness({ [MANIFEST]: v1, 'https://h.test/p/a.png': PNG, 'https://h.test/p/b.gif': PNG, 'https://h.test/p/c.png': PNG });
    await h.run();
    const root = h.state.categories[0];
    // 用户把这个单包分类放到了自己的分类下
    h.deps.apply([
      { op: 'upsertCategory', category: { id: 'mine', name: '我的', createdAt: 0, order: 99 } },
      { op: 'upsertCategory', category: { ...root, parentId: 'mine' } },
    ]);
    h.routes[MANIFEST] = JSON.stringify({
      name: '猫猫',
      stickers: [{ id: 'a', url: 'a.png' }, { id: 'b', url: 'b.gif' }],
      packs: [{ key: 'extra', name: '番外', stickers: [{ id: 'c', url: 'c.png' }] }],
    });
    await h.run();
    const root2 = h.state.categories.find((c) => c.id === root.id)!;
    expect(root2.parentId).toBeUndefined(); // 多包后必须是一级
    const extra = h.state.categories.find((c) => c.packKey === 'extra')!;
    expect(extra.parentId).toBe(root.id);
    expect(h.state.stickers.find((s) => s.source.type === 'subscription' && s.source.remoteId === 'c')!.categoryId).toBe(extra.id);
  });

  it('多包：包上的 group 在订阅分类下逐级建出子分类，指向另一个包时就挂在那个包下', async () => {
    const root = JSON.stringify({
      name: '合集',
      stickers: [{ id: 'r1', url: 'r.png' }],
      packs: [
        { key: 'dogs', name: '狗狗', group: '动物', stickers: [{ id: 'd1', url: 'dog/1.png' }] },
        { key: 'shiba', name: '柴犬', group: '动物 / 狗狗', stickers: [{ id: 's1', url: 'shiba/1.png' }] },
        { key: 'misc', name: '其他', stickers: [{ id: 'm1', url: 'misc/1.png' }] },
      ],
    });
    const h = harness({
      [MANIFEST]: root,
      'https://h.test/p/r.png': PNG,
      'https://h.test/p/dog/1.png': PNG,
      'https://h.test/p/shiba/1.png': PNG,
      'https://h.test/p/misc/1.png': PNG,
    });
    const r = await h.run();
    expect(r).toMatchObject({ added: 4, failed: 0, packs: 4 });
    const byKey = (k: string) => h.state.categories.find((c) => c.packKey === k)!;
    const rootCat = byKey('root');
    const animals = byKey('group:动物');
    expect(animals).toMatchObject({ name: '动物', parentId: rootCat.id, subscriptionId: 'sub1' });
    expect(byKey('dogs').parentId).toBe(animals.id);
    expect(byKey('shiba').parentId).toBe(byKey('dogs').id); // “动物 / 狗狗”就是狗狗这个包，不另建分类
    expect(byKey('misc').parentId).toBe(rootCat.id);
    expect(h.state.categories.filter((c) => c.name === '狗狗')).toHaveLength(1);
    const st = (remoteId: string) => h.state.stickers.find((s) => s.source.type === 'subscription' && s.source.remoteId === remoteId)!;
    expect(st('r1').categoryId).toBe(rootCat.id);
    expect(st('d1').categoryId).toBe(byKey('dogs').id);
    expect(st('s1').categoryId).toBe(byKey('shiba').id);
    // 再同步：分类不会重复建
    const n = h.state.categories.length;
    await h.run();
    expect(h.state.categories).toHaveLength(n);
  });

  it('同名的本地分类会被订阅采用', async () => {
    const h = harness(
      { [MANIFEST]: v1, 'https://h.test/p/a.png': PNG, 'https://h.test/p/b.gif': PNG },
      { categories: [{ id: 'local', name: '猫猫', createdAt: 0, order: 0 }] },
    );
    await h.run();
    expect(h.state.categories).toHaveLength(1);
    expect(h.state.categories[0]).toMatchObject({ id: 'local', subscriptionId: 'sub1' });
  });
});
