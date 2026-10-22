import type { Category, Sticker, StickerSourceSubscription, Subscription } from '../types';
import type { LibraryOp } from '../ops';
import type { Platform } from '../../platform/types';
import { extFromContentType, extFromName } from '../images';
import { parseManifestText, parsePack, type RemotePack, type RemoteSticker } from './manifest';

export interface SyncDeps {
  platform: Pick<Platform, 'fetchText' | 'download' | 'remove' | 'rename'>;
  now: () => number;
  newId: () => string;
  /** 把操作应用到资料库（同步过程中会被多次调用） */
  apply: (ops: LibraryOp[]) => void;
  concurrency?: number;
}

export interface SyncProgress {
  phase: 'fetch' | 'download' | 'cleanup' | 'done';
  done: number;
  total: number;
}

export interface SyncResult {
  added: number;
  updated: number;
  removed: number;
  failed: number;
  errors: string[];
  packs: number;
}

export interface SyncSnapshot {
  categories: Category[];
  stickers: Sticker[];
}

type Task =
  | { kind: 'new'; rs: RemoteSticker; pack: RemotePack; cat: Category; remoteTags: string[] }
  | {
      kind: 'redownload';
      rs: RemoteSticker;
      pack: RemotePack;
      cat: Category;
      remoteTags: string[];
      cur: Sticker;
      patch: Partial<Sticker>;
      source: StickerSourceSubscription;
    };

/** 订阅内表情的唯一键：包 + 远端 id */
export const stickerKey = (packKey: string, remoteId: string) => `${packKey}\u0000${remoteId}`;

function nameFromRefUrl(url: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop() ?? '';
    const stem = decodeURIComponent(last).replace(/\.json$/i, '');
    return stem && stem !== 'index' ? stem : u.hostname;
  } catch {
    return '表情包';
  }
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

function uniq(list: string[]): string[] {
  return Array.from(new Set(list));
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

async function runPool<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

/** 把远端图片下载到 stickers/ 目录，返回文件信息 */
async function downloadSticker(
  url: string,
  deps: SyncDeps,
): Promise<{ file: string; ext: string; size: number }> {
  const id = deps.newId();
  let ext = extFromName(new URL(url).pathname);
  let rel = ext ? `stickers/${id}.${ext}` : `tmp/${id}.part`;
  const r = await deps.platform.download(url, rel, 60000);
  const ct = r.contentType?.toLowerCase() ?? '';
  if (ct.startsWith('text/') || ct.startsWith('application/json')) {
    await deps.platform.remove(rel).catch(() => undefined);
    throw new Error('服务器返回的不是图片');
  }
  if (!ext) {
    ext = extFromContentType(r.contentType);
    if (!ext) {
      await deps.platform.remove(rel).catch(() => undefined);
      throw new Error('无法识别图片格式');
    }
    const final = `stickers/${id}.${ext}`;
    await deps.platform.rename(rel, final);
    rel = final;
  }
  return { file: rel, ext, size: r.size };
}

/**
 * 同步一个订阅。过程中通过 deps.apply 逐步修改资料库；
 * 抛出的异常表示整个同步失败（清单无法获取/解析），此时订阅的 lastError 已更新。
 */
export async function syncSubscription(
  sub: Subscription,
  snap: SyncSnapshot,
  deps: SyncDeps,
  onProgress?: (p: SyncProgress) => void,
): Promise<SyncResult> {
  const { platform, now, newId, apply } = deps;
  onProgress?.({ phase: 'fetch', done: 0, total: 0 });

  // 1. 获取并解析清单
  let manifest;
  try {
    const res = await platform.fetchText(sub.url, 30000);
    if (!res.ok) throw new Error(`下载订阅失败（HTTP ${res.status}）`);
    manifest = parseManifestText(res.text, res.finalUrl || sub.url);
  } catch (e) {
    apply([{ op: 'patchSubscription', id: sub.id, patch: { lastSyncAt: now(), lastError: errorMessage(e) } }]);
    throw e;
  }

  const errors: string[] = [];
  const packs: RemotePack[] = [...manifest.packs];
  /** 抓取失败的子包：这次不动它们的表情（尤其不能当作“远端已移除”而删掉） */
  const failedPackKeys = new Set<string>();
  for (const ref of manifest.packRefs) {
    try {
      const res = await platform.fetchText(ref.url, 30000);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      let json: unknown;
      try {
        json = JSON.parse(res.text.replace(/^﻿/, ''));
      } catch {
        throw new Error('不是有效的 JSON');
      }
      packs.push(parsePack(json, res.finalUrl || ref.url, ref.key, nameFromRefUrl(ref.url)));
    } catch (e) {
      failedPackKeys.add(ref.key);
      errors.push(`子包 ${ref.url}：${errorMessage(e)}`);
    }
  }
  if (packs.length === 0) {
    const message = errors[0] ?? '订阅中没有任何表情';
    apply([{ op: 'patchSubscription', id: sub.id, patch: { lastSyncAt: now(), lastError: message } }]);
    throw new Error(message);
  }

  // 2. 为每个包准备分类：
  //    单包订阅 → 一个分类；多包订阅 → 订阅名是一级分类，每个包是它下面的二级分类。
  const catOps: LibraryOp[] = [];
  const packCategory = new Map<string, Category>();
  const usedCats = new Set<string>();
  let maxOrder = snap.categories.reduce((m, c) => Math.max(m, c.order), -1);
  const multiPack = packs.some((p) => p.key !== 'root');

  /**
   * 找到 / 认领 / 新建某个包对应的分类。
   * forceParent 为 true 时把它放到 parentId 下（undefined 即一级）；否则保留用户放的位置。
   */
  const ensureCategory = (key: string, name: string, parentId: string | undefined, forceParent: boolean): Category => {
    let cat = snap.categories.find((c) => c.subscriptionId === sub.id && c.packKey === key);
    if (cat) {
      let next = cat;
      if (next.remoteName === next.name && next.name !== name) next = { ...next, name, remoteName: name };
      else if (next.remoteName !== name) next = { ...next, remoteName: name };
      if (forceParent && (next.parentId ?? undefined) !== parentId) next = { ...next, parentId };
      if (next !== cat) catOps.push({ op: 'upsertCategory', category: next });
      cat = next;
    } else {
      const adopt = snap.categories.find((c) => !c.subscriptionId && c.name === name && !usedCats.has(c.id));
      if (adopt) {
        cat = { ...adopt, subscriptionId: sub.id, packKey: key, remoteName: name };
        if (forceParent) cat = { ...cat, parentId };
      } else {
        cat = {
          id: newId(),
          name,
          createdAt: now(),
          order: ++maxOrder,
          parentId,
          subscriptionId: sub.id,
          packKey: key,
          remoteName: name,
        };
      }
      catOps.push({ op: 'upsertCategory', category: cat });
    }
    usedCats.add(cat.id);
    return cat;
  };

  const rootPack = packs.find((p) => p.key === 'root');
  let rootCat: Category | undefined;
  if (rootPack || multiPack) {
    // 多包时根分类必须是一级（它要当父分类）；单包时尊重用户把它放在哪
    rootCat = ensureCategory('root', manifest.name, undefined, multiPack);
    if (rootPack) packCategory.set('root', rootCat);
  }
  // 包上的 group 是相对订阅分类的父分类路径（“一级 / 二级”）：按它在订阅分类下逐级放；
  // 路径指向的如果正好是另一个包，就放到那个包的分类下，否则建一个只起容器作用的分类
  const groupPath = (g: string | undefined) =>
    (g ?? '')
      .split(' / ')
      .map((s) => s.trim())
      .filter(Boolean)
      .join(' / ');
  const pathOf = (p: RemotePack) => {
    const g = groupPath(p.group);
    return g ? `${g} / ${p.name}` : p.name;
  };
  const packByPath = new Map<string, RemotePack>();
  for (const p of packs) if (p.key !== 'root' && !packByPath.has(pathOf(p))) packByPath.set(pathOf(p), p);
  const pathCategory = new Map<string, Category>();
  const ensurePath = (path: string): Category => {
    const hit = pathCategory.get(path);
    if (hit) return hit;
    const segs = path.split(' / ');
    const parent = segs.length > 1 ? ensurePath(segs.slice(0, -1).join(' / ')) : rootCat!;
    const pack = packByPath.get(path);
    const cat = pack
      ? ensureCategory(pack.key, pack.name, parent.id, true)
      : ensureCategory(`group:${path}`, segs[segs.length - 1], parent.id, true);
    pathCategory.set(path, cat);
    return cat;
  };
  for (const pack of packs) {
    if (pack.key === 'root') continue;
    packCategory.set(pack.key, ensurePath(pathOf(pack)));
  }
  apply(catOps);
  const validCatIds = new Set([...snap.categories.map((c) => c.id), ...usedCats]);

  // 3. 对比远端与本地
  const existing = snap.stickers.filter(
    (s): s is Sticker & { source: StickerSourceSubscription } =>
      s.source.type === 'subscription' && s.source.subscriptionId === sub.id,
  );
  const byKey = new Map(existing.map((s) => [stickerKey(s.source.packKey, s.source.remoteId), s]));
  const seen = new Set<string>();
  const hidden = new Set(sub.hiddenKeys ?? []);
  const tasks: Task[] = [];
  const immediate: LibraryOp[] = [];
  let updated = 0;

  for (const pack of packs) {
    const cat = packCategory.get(pack.key)!;
    for (const rs of pack.stickers) {
      const k = stickerKey(pack.key, rs.remoteId);
      if (seen.has(k)) continue;
      seen.add(k);
      if (hidden.has(k)) continue; // 用户删过的表情不再拉回
      const remoteTags = uniq([...pack.tags, ...rs.tags]);
      const cur = byKey.get(k);
      if (!cur) {
        tasks.push({ kind: 'new', rs, pack, cat, remoteTags });
        continue;
      }
      const src = cur.source;
      const patch: Partial<Sticker> = {};
      const oldRemote = new Set(src.remoteTags);
      const newTags = uniq([...cur.tags.filter((t) => !oldRemote.has(t)), ...remoteTags]);
      if (!sameList(newTags, cur.tags)) patch.tags = newTags;
      if (cur.name === src.remoteName && rs.name !== cur.name) patch.name = rs.name;
      // 只有原分类已被删除时才重新归入包的分类；用户主动移到别处（含未分类）则保留
      if (cur.categoryId !== null && !validCatIds.has(cur.categoryId)) patch.categoryId = cat.id;
      const source: StickerSourceSubscription = { ...src, url: rs.url, remoteName: rs.name, remoteTags };
      if (src.url !== rs.url) {
        tasks.push({ kind: 'redownload', rs, pack, cat, remoteTags, cur, patch, source });
        continue;
      }
      const sourceChanged = src.remoteName !== rs.name || !sameList(src.remoteTags, remoteTags);
      if (Object.keys(patch).length > 0 || sourceChanged) {
        immediate.push({ op: 'patchSticker', id: cur.id, patch: { ...patch, source, updatedAt: now() } });
        updated++;
      }
    }
  }
  apply(immediate);

  // 4. 下载
  const total = tasks.length;
  let done = 0;
  let added = 0;
  let failed = 0;
  onProgress?.({ phase: 'download', done, total });
  await runPool(tasks, deps.concurrency ?? 4, async (task) => {
    const { rs } = task;
    try {
      const dl = await downloadSticker(rs.url, deps);
      const t = now();
      if (task.kind === 'new') {
        const sticker: Sticker = {
          id: newId(),
          name: rs.name,
          file: dl.file,
          ext: dl.ext,
          size: dl.size,
          categoryId: task.cat.id,
          tags: task.remoteTags,
          favorite: false,
          createdAt: t,
          updatedAt: t,
          source: {
            type: 'subscription',
            subscriptionId: sub.id,
            packKey: task.pack.key,
            remoteId: rs.remoteId,
            url: rs.url,
            remoteName: rs.name,
            remoteTags: task.remoteTags,
          },
        };
        apply([{ op: 'addSticker', sticker }]);
        added++;
      } else {
        apply([
          {
            op: 'patchSticker',
            id: task.cur.id,
            patch: { ...task.patch, file: dl.file, ext: dl.ext, size: dl.size, source: task.source, updatedAt: t },
          },
        ]);
        updated++;
        if (task.cur.file !== dl.file) await platform.remove(task.cur.file).catch(() => undefined);
      }
    } catch (e) {
      failed++;
      errors.push(`${rs.name}：${errorMessage(e)}`);
    }
    done++;
    onProgress?.({ phase: 'download', done, total });
  });

  // 5. 清理远端已移除的表情
  let removed = 0;
  const gone = existing.filter(
    (s) => !failedPackKeys.has(s.source.packKey) && !seen.has(stickerKey(s.source.packKey, s.source.remoteId)),
  );
  if (sub.deleteRemoved && gone.length > 0) {
    onProgress?.({ phase: 'cleanup', done: total, total });
    apply([{ op: 'removeStickers', ids: gone.map((s) => s.id) }]);
    for (const s of gone) await platform.remove(s.file).catch(() => undefined);
    removed = gone.length;
  }

  // 6. 更新订阅信息
  const t = now();
  const summary =
    errors.length === 0
      ? undefined
      : errors.slice(0, 3).join('；') + (errors.length > 3 ? `（共 ${errors.length} 个错误）` : '');
  apply([
    {
      op: 'patchSubscription',
      id: sub.id,
      patch: {
        name: manifest.name,
        description: manifest.description,
        homepage: manifest.homepage,
        remoteVersion: manifest.version,
        lastSyncAt: t,
        lastSuccessAt: t,
        lastError: summary,
        stickerCount: existing.length - removed + added,
      },
    },
  ]);
  onProgress?.({ phase: 'done', done: total, total });
  return { added, updated, removed, failed, errors, packs: packs.length };
}
