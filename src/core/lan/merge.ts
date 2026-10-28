/**
 * 两台设备资料的合并算法（纯函数，和网络无关）。
 *
 * 规则：
 * - 同一个 id 两边都有时，updatedAt 更新的一方胜出（整条记录一起算，不按字段拆）；时间相同按内容定一个确定的胜者
 * - 删除记录（墓碑）比现有记录新（或同时）→ 两边都删；比记录旧 → 记录复活（删了之后另一边又改过）
 * - 两边各自导入过同一张图片（sha256 相同、id 不同）：合并成一条，保留创建更早的那个 id，元信息取改动更新的一方，
 *   另一边把自己那张的文件改名复用，不用再传一遍；被合并掉的 id 记一条删除记录，免得第三台设备再把它带回来
 * - 分类的父分类必须存在且不成环，表情的分类必须存在，否则自动放到一级 / 未分类
 *
 * 算出的是“两边最终应该长什么样”，再分别和两边当前的样子做 diff，得到各自要做的事。
 * 算法对称：无论谁发起、发起几次，结果都一样；两边没有差异时不产生任何操作。
 */
import type { Tombstone } from '../types';
import { pruneTombstones } from '../migrate';
import { emptySideOps, type FileSource, type SideOps, type SyncCategory, type SyncState, type SyncSticker } from './protocol';

export interface MergePlan {
  local: SideOps;
  remote: SideOps;
  deleted: Tombstone[];
}

/** 键顺序固定的序列化，用来比较两条记录是否相同、以及时间相同时决出胜者 */
export function canon(v: unknown): string {
  return JSON.stringify(v, (_k, val) => {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      const o = val as Record<string, unknown>;
      return Object.keys(o)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          if (o[k] !== undefined) acc[k] = o[k];
          return acc;
        }, {});
    }
    return val as unknown;
  });
}

function newer<T extends { updatedAt: number }>(a: T | undefined, b: T | undefined): T | undefined {
  if (!a) return b;
  if (!b) return a;
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? a : b;
  return canon(a) >= canon(b) ? a : b;
}

const tombKey = (kind: Tombstone['kind'], id: string) => `${kind}:${id}`;

/** 父分类不存在的升为一级；成环的全部升为一级 */
function fixParents(cats: Map<string, SyncCategory>): void {
  for (const c of cats.values()) {
    if (c.parentId !== undefined && !cats.has(c.parentId)) delete c.parentId;
  }
  const detach = new Set<string>();
  for (const c of cats.values()) {
    const seen = new Set<string>([c.id]);
    let cur = c.parentId ? cats.get(c.parentId) : undefined;
    while (cur) {
      if (seen.has(cur.id)) {
        detach.add(c.id);
        break;
      }
      seen.add(cur.id);
      cur = cur.parentId ? cats.get(cur.parentId) : undefined;
    }
  }
  for (const id of detach) delete cats.get(id)!.parentId;
}

export function mergeStates(local: SyncState, remote: SyncState, now: number): MergePlan {
  // 1. 删除记录：两边合起来，同一条目取最新
  const tomb = new Map<string, Tombstone>();
  for (const t of [...local.deleted, ...remote.deleted]) {
    const k = tombKey(t.kind, t.id);
    const prev = tomb.get(k);
    if (!prev || prev.at < t.at) tomb.set(k, t);
  }

  // 2. 分类
  const lCats = new Map(local.categories.map((c) => [c.id, c]));
  const rCats = new Map(remote.categories.map((c) => [c.id, c]));
  const finalCats = new Map<string, SyncCategory>();
  for (const id of new Set([...lCats.keys(), ...rCats.keys()])) {
    const win = newer(lCats.get(id), rCats.get(id))!;
    const t = tomb.get(tombKey('category', id));
    if (t && t.at >= win.updatedAt) continue;
    if (t) tomb.delete(tombKey('category', id));
    finalCats.set(id, { ...win });
  }
  fixParents(finalCats);

  // 3. 表情
  const lSt = new Map(local.stickers.map((s) => [s.id, s]));
  const rSt = new Map(remote.stickers.map((s) => [s.id, s]));
  const finalSt = new Map<string, SyncSticker>();
  for (const id of new Set([...lSt.keys(), ...rSt.keys()])) {
    const win = newer(lSt.get(id), rSt.get(id))!;
    const t = tomb.get(tombKey('sticker', id));
    if (t && t.at >= win.updatedAt) continue;
    if (t) tomb.delete(tombKey('sticker', id));
    finalSt.set(id, { ...win });
  }

  // 3b. 内容相同的表情合并成一条（被合并掉的 id → 保留的 id）
  const aliases = new Map<string, string>();
  const byHash = new Map<string, SyncSticker[]>();
  for (const s of finalSt.values()) {
    if (!s.hash) continue;
    const list = byHash.get(s.hash) ?? [];
    list.push(s);
    byHash.set(s.hash, list);
  }
  for (const group of byHash.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
    const keep = group[0];
    const meta = group.reduce((m, s) => newer(m, s)!);
    finalSt.set(keep.id, { ...meta, id: keep.id, file: keep.file, ext: keep.ext, size: keep.size, hash: keep.hash, createdAt: keep.createdAt });
    for (const dup of group.slice(1)) {
      finalSt.delete(dup.id);
      aliases.set(dup.id, keep.id);
      tomb.set(tombKey('sticker', dup.id), { kind: 'sticker', id: dup.id, at: now });
    }
  }
  for (const s of finalSt.values()) {
    if (s.categoryId !== null && !finalCats.has(s.categoryId)) s.categoryId = null;
  }

  // 4. 两边各自和“最终样子”的差异
  const diff = (cats: Map<string, SyncCategory>, stickers: Map<string, SyncSticker>): SideOps => {
    const ops = emptySideOps();
    for (const c of finalCats.values()) {
      const cur = cats.get(c.id);
      if (!cur || canon(cur) !== canon(c)) ops.categories.push(c);
    }
    for (const id of cats.keys()) if (!finalCats.has(id)) ops.removeCategories.push(id);
    /** 这一侧将被合并掉的表情：保留的 id → 它的文件 */
    const dupFiles = new Map<string, string>();
    for (const s of stickers.values()) {
      const keep = aliases.get(s.id);
      if (keep && !stickers.has(keep)) dupFiles.set(keep, s.file);
    }
    for (const f of finalSt.values()) {
      const cur = stickers.get(f.id);
      let file: FileSource;
      if (cur) {
        if (cur.file === f.file) {
          if (canon(cur) === canon(f)) continue;
          file = 'keep';
        } else file = 'fetch';
      } else {
        const from = dupFiles.get(f.id);
        file = from ? { renameFrom: from } : 'fetch';
      }
      ops.stickers.push({ sticker: f, file });
    }
    for (const id of stickers.keys()) if (!finalSt.has(id)) ops.removeStickers.push(id);
    return ops;
  };

  return { local: diff(lCats, lSt), remote: diff(rCats, rSt), deleted: pruneTombstones(Array.from(tomb.values()), now) };
}
