import { describe, expect, it } from 'vitest';
import { applyOps } from '../ops';
import type { Category, Sticker, Tombstone } from '../types';
import { runSync, SyncResponder, type SessionDeps, type Transport } from './session';

/** 一台内存里的设备：资料 + 文件 */
class Device {
  lib: { categories: Category[]; stickers: Sticker[]; subscriptions: never[]; deleted: Tombstone[] } = { categories: [], stickers: [], subscriptions: [], deleted: [] };
  files = new Map<string, Uint8Array>();
  deps: SessionDeps;
  responder: SyncResponder;
  seq = 0;
  flushes = 0;

  constructor(
    readonly id: string,
    readonly clock: () => number,
  ) {
    this.deps = {
      identity: { id, name: id },
      platform: {
        exists: async (rel) => this.files.has(rel),
        rename: async (from, to) => {
          const v = this.files.get(from);
          if (!v) throw new Error('missing');
          this.files.delete(from);
          this.files.set(to, v);
        },
        remove: async (rel) => {
          this.files.delete(rel);
        },
      },
      getState: () => this.lib,
      apply: (ops) => {
        this.lib = applyOps(this.lib, ops);
      },
      now: clock,
      flush: async () => {
        this.flushes++;
      },
      concurrency: 2,
    };
    this.responder = new SyncResponder(this.deps, () => `sess${++this.seq}`);
  }

  addSticker(id: string, name: string, extra: Partial<Sticker> = {}, bytes = new Uint8Array([1, 2, 3])): void {
    const t = this.clock();
    const file = `stickers/${id}.png`;
    this.files.set(file, bytes);
    this.lib = applyOps(this.lib, [
      { op: 'addSticker', sticker: { id, name, file, ext: 'png', size: bytes.length, categoryId: null, tags: [], favorite: false, createdAt: t, updatedAt: t, source: { type: 'local' }, ...extra } },
    ]);
  }

  addCategory(id: string, name: string, extra: Partial<Category> = {}): void {
    const t = this.clock();
    this.lib = applyOps(this.lib, [{ op: 'upsertCategory', category: { id, name, createdAt: t, updatedAt: t, order: 0, ...extra } }]);
  }

  patch(id: string, patch: Partial<Sticker>): void {
    this.lib = applyOps(this.lib, [{ op: 'patchSticker', id, patch: { ...patch, updatedAt: this.clock() } }]);
  }

  delete(id: string): void {
    const s = this.lib.stickers.find((x) => x.id === id)!;
    this.files.delete(s.file);
    this.lib = applyOps(this.lib, [
      { op: 'removeStickers', ids: [id] },
      { op: 'setDeleted', deleted: [...this.lib.deleted, { kind: 'sticker', id, at: this.clock() }] },
    ]);
  }
}

/** 直接把请求交给对方的 responder，文件在两台设备的 Map 之间拷贝 */
function transportTo(from: Device, to: Device, opts: { failFiles?: Set<string> } = {}): Transport {
  return {
    async request(path, body) {
      const kind = path.slice(1) as 'begin' | 'apply' | 'end';
      return to.responder.handle({ kind, body: JSON.parse(JSON.stringify(body)) });
    },
    async upload(_path, rel) {
      if (opts.failFiles?.has(rel)) return 500;
      const v = from.files.get(rel);
      if (!v) return 404;
      to.files.set(rel, v);
      return 200;
    },
    async download(_path, rel) {
      if (opts.failFiles?.has(rel)) return 500;
      const v = to.files.get(rel);
      if (!v) return 404;
      from.files.set(rel, v);
      return 200;
    },
  };
}

function world() {
  let t = 1000;
  const clock = () => ++t;
  const a = new Device('A', clock);
  const b = new Device('B', clock);
  return { a, b, clock };
}

const ids = (d: Device) => d.lib.stickers.map((s) => s.id).sort();

describe('runSync（两台内存设备）', () => {
  it('双向补齐：各自新增的表情和分类互相同步，图片跟着走', async () => {
    const { a, b } = world();
    a.addCategory('c1', '猫');
    a.addSticker('s1', 'A 的', { categoryId: 'c1' }, new Uint8Array([9, 9]));
    b.addSticker('s2', 'B 的');
    const r = await runSync(transportTo(a, b), a.deps);
    expect(r.sent).toBe(1);
    expect(r.received).toBe(1);
    expect(r.local).toMatchObject({ added: 1, updated: 0, removed: 0, skipped: 0 });
    expect(r.remote).toMatchObject({ added: 1, updated: 0, removed: 0, skipped: 0, categories: 1 });
    expect(ids(a)).toEqual(['s1', 's2']);
    expect(ids(b)).toEqual(['s1', 's2']);
    expect(b.files.get('stickers/s1.png')).toEqual(new Uint8Array([9, 9]));
    expect(b.lib.categories[0]).toMatchObject({ id: 'c1', name: '猫' });
    expect(b.lib.stickers.find((s) => s.id === 's1')).toMatchObject({ categoryId: 'c1', source: { type: 'local' } });
    expect(a.flushes).toBeGreaterThan(0);
    expect(b.flushes).toBeGreaterThan(0);
    // 再同步一次：没有变化
    const r2 = await runSync(transportTo(a, b), a.deps);
    expect(r2).toMatchObject({ sent: 0, received: 0, local: { added: 0, updated: 0, removed: 0 }, remote: { added: 0, updated: 0, removed: 0 } });
  });

  it('改名、删除、反向发起都正确传播', async () => {
    const { a, b } = world();
    a.addSticker('s1', '原名');
    a.addSticker('s2', '要删的');
    await runSync(transportTo(a, b), a.deps);
    b.patch('s1', { name: 'B 改的名', favorite: true });
    a.delete('s2');
    // 这次由 B 发起
    const r = await runSync(transportTo(b, a), b.deps);
    expect(r.local).toMatchObject({ removed: 1 });
    expect(r.remote).toMatchObject({ updated: 1 });
    expect(a.lib.stickers).toHaveLength(1);
    expect(a.lib.stickers[0]).toMatchObject({ name: 'B 改的名', favorite: true });
    expect(b.lib.stickers).toHaveLength(1);
    expect(b.files.has('stickers/s2.png')).toBe(false);
    expect(b.lib.deleted).toEqual(a.lib.deleted);
  });

  it('图片传输失败的表情这次跳过，两边都不动，下次再补', async () => {
    const { a, b } = world();
    a.addSticker('ok', '能传');
    a.addSticker('bad', '传不动');
    const r = await runSync(transportTo(a, b, { failFiles: new Set(['stickers/bad.png']) }), a.deps);
    expect(r.sent).toBe(1);
    expect(r.errors[0]).toMatch(/传不动/);
    expect(ids(b)).toEqual(['ok']);
    expect(ids(a)).toEqual(['bad', 'ok']);
    const r2 = await runSync(transportTo(a, b), a.deps);
    expect(r2.sent).toBe(1);
    expect(ids(b)).toEqual(['bad', 'ok']);
  });

  it('对方正忙时报错；会话过期后可以重新开始', async () => {
    const { a, b } = world();
    const first = await b.responder.handle({ kind: 'begin', body: { proto: 1, device: { id: 'x', name: 'x' } } });
    expect(first.status).toBe(200);
    await expect(runSync(transportTo(a, b), a.deps)).rejects.toThrow(/正在和别的设备同步/);
    await b.responder.handle({ kind: 'end', body: {} });
    await expect(runSync(transportTo(a, b), a.deps)).resolves.toBeTruthy();
  });

  it('三台设备、同一张图各自导入：最终只剩一条，文件不重复传', async () => {
    const { a, b, clock } = world();
    const c = new Device('C', clock);
    const bytes = new Uint8Array([7, 7, 7]);
    a.addSticker('a1', '同一张', { hash: 'same' }, bytes);
    b.addSticker('b1', '同一张', { hash: 'same' }, bytes);
    c.addSticker('c1', '同一张', { hash: 'same' }, bytes);
    const r1 = await runSync(transportTo(a, b), a.deps);
    expect(r1.sent + r1.received).toBe(0);
    expect(ids(a)).toEqual(['a1']);
    expect(ids(b)).toEqual(['a1']);
    expect(b.files.has('stickers/a1.png')).toBe(true);
    const r2 = await runSync(transportTo(c, b), c.deps);
    expect(r2.sent + r2.received).toBe(0);
    expect(ids(c)).toEqual(['a1']);
    // 第三台再和第一台同步：没有变化，被合并掉的 id 不会复活
    const r3 = await runSync(transportTo(c, a), c.deps);
    expect(r3).toMatchObject({ sent: 0, received: 0, local: { added: 0, removed: 0 }, remote: { added: 0, removed: 0 } });
    expect(ids(a)).toEqual(['a1']);
  });
});
