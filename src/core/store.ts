import { create } from 'zustand';
import { platform } from '../platform';
import { newId } from './ids';
import { applyOps, type LibraryOp } from './ops';
import { errorMessage, syncSubscription as runSync, type SyncProgress, type SyncResult } from './subscription/sync';
import { extFromBytes, extFromName, fileStem, sha256Hex } from './images';
import { migrate, pruneTombstones } from './migrate';
import { SUBSCRIPTIONS_ENABLED } from './features';
import { stickerKey } from './subscription/sync';
import { emptyLibrary, type Category, type Library, type Settings, type Sticker, type Subscription, type Tombstone } from './types';
import type { UsageMap } from '../platform/types';
import { buildPackage, readPackage, type BuildPackageResult } from './package';
import { categoryIdsIncludingChildren, isSelfOrDescendant, sortedCategories } from './selectors';

export interface SyncStatus {
  running: boolean;
  progress?: SyncProgress;
}

export interface ImportResult {
  added: number;
  /** 内容相同的图片已经存在，这次把它移到了新指定的分类（不重复添加） */
  moved: number;
  skipped: number;
  failed: number;
  errors: string[];
}

export interface ImportFile {
  name: string;
  bytes: Uint8Array;
  /** 指定表情名（缺省用文件名） */
  displayName?: string;
  tags?: string[];
  /** 指定分类；undefined 表示用调用时给的默认分类 */
  categoryId?: string | null;
}

export interface PackageImportResult extends ImportResult {
  name: string;
  /** 压缩包清单里提到但缺少图片的数量 */
  missing: number;
  categoriesCreated: number;
}

export interface LibraryState extends Library {
  loaded: boolean;
  loadError?: string;
  /** 读取资料失败，或本窗口是只读的浮窗时禁止落盘，避免两个窗口互相覆盖 */
  saveBlocked: boolean;
  syncStatus: Record<string, SyncStatus>;
  /** 表情使用记录（“最近使用”） */
  usage: UsageMap;
  /** 浮窗快捷键是否注册成功（被其他程序占用时为 false） */
  hotkeyOk: boolean;

  load: () => Promise<void>;
  /** 其他窗口改写了资料文件后重新读取（浮窗用） */
  reloadFromDisk: () => Promise<void>;
  flush: () => Promise<void>;
  applyOps: (ops: LibraryOp[]) => void;
  recordUsage: (id: string) => void;

  /** 新建分类；给 parentId 则新建为该一级分类下的二级分类 */
  addCategory: (name: string, parentId?: string | null) => Category;
  /** 按名字找同一层级的分类，没有就新建；返回是否新建 */
  findOrCreateCategory: (name: string, parentId: string | null) => { category: Category; created: boolean };
  renameCategory: (id: string, name: string) => void;
  /** 删除分类（连同它的二级分类）；表情按 deleteStickers 删除或移到未分类 */
  deleteCategory: (id: string, deleteStickers: boolean) => Promise<void>;
  /** 在同级分类之间上下移动 */
  moveCategory: (id: string, direction: -1 | 1) => void;
  /** 把分类挪到某个一级分类下（null = 设为一级分类）；不合法时抛错 */
  setCategoryParent: (id: string, parentId: string | null) => void;
  /**
   * 拖拽用：把分类放到 parentId（null = 一级）下的第 index 个位置（index 按不含它自己的同级列表计）。
   * 不合法时抛错；位置没变化时什么也不做。
   */
  reorderCategory: (id: string, parentId: string | null, index: number) => void;

  importFiles: (files: ImportFile[], categoryId: string | null) => Promise<ImportResult>;
  /** 把表情导出成 zip（含名称、标签、分类） */
  exportPackage: (ids: string[], name: string, description?: string) => Promise<BuildPackageResult>;
  /** 导入别人导出的 zip 表情包 */
  importPackage: (bytes: Uint8Array) => Promise<PackageImportResult>;
  /** 批量命名：base 1、base 2…（只有一个时直接用 base） */
  renameStickers: (ids: string[], base: string) => void;
  /** 批量改名：逐个指定新名字（空名字忽略） */
  renameMany: (renames: { id: string; name: string }[]) => void;
  /** 记录生成好的缩略图 */
  setThumb: (id: string, thumb: string | undefined) => void;
  updateSticker: (id: string, patch: Partial<Pick<Sticker, 'name' | 'categoryId' | 'tags' | 'favorite'>>) => void;
  setCategoryFor: (ids: string[], categoryId: string | null) => void;
  addTagsTo: (ids: string[], tags: string[]) => void;
  removeTagFrom: (ids: string[], tag: string) => void;
  toggleFavorite: (id: string) => void;
  deleteStickers: (ids: string[]) => Promise<void>;
  renameTag: (from: string, to: string) => void;
  deleteTag: (tag: string) => void;

  addSubscription: (url: string) => Promise<{ subscription: Subscription; result: SyncResult }>;
  syncSubscription: (id: string) => Promise<SyncResult>;
  syncAll: (onlyAuto?: boolean) => Promise<void>;
  updateSubscription: (id: string, patch: Partial<Pick<Subscription, 'deleteRemoved' | 'autoSync'>>) => void;
  removeSubscription: (id: string, deleteStickers: boolean) => Promise<void>;
  /** 恢复这个订阅里被用户删除过的表情（清空忽略列表并重新同步） */
  restoreHidden: (id: string) => Promise<SyncResult>;

  updateSettings: (patch: Partial<Settings>) => void;
}

const LIBRARY_FILE = 'library.json';

function uniq(list: string[]): string[] {
  return Array.from(new Set(list));
}

function cleanTag(t: string): string {
  return t.trim().replace(/^#/, '').slice(0, 40);
}

// ---------------------------------------------------------------- 落盘

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let saving: Promise<void> = Promise.resolve();
let dirty = false;

function serialize(s: LibraryState): string {
  const lib: Library = {
    version: 1,
    categories: s.categories,
    stickers: s.stickers,
    subscriptions: s.subscriptions,
    settings: s.settings,
    deleted: s.deleted,
  };
  return JSON.stringify(lib);
}

function scheduleSave(): void {
  dirty = true;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void flushSave(), 300);
}

async function flushSave(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (!dirty) return saving;
  dirty = false;
  const text = serialize(useLibraryStore.getState());
  saving = saving
    .then(() => platform.writeText(LIBRARY_FILE, text))
    .catch((e) => {
      console.error('保存资料失败', e);
      dirty = true;
    });
  return saving;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------- Store

export const useLibraryStore = create<LibraryState>()((set, get) => {
  const setStatus = (id: string, status: SyncStatus) =>
    set((s) => ({ syncStatus: { ...s.syncStatus, [id]: status } }));

  const patchStickers = (ids: string[], fn: (s: Sticker) => Sticker) => {
    const idSet = new Set(ids);
    set((s) => ({ stickers: s.stickers.map((x) => (idSet.has(x.id) ? fn(x) : x)) }));
  };

  return {
    ...emptyLibrary(),
    loaded: false,
    saveBlocked: false,
    syncStatus: {},
    usage: {},
    hotkeyOk: true,

    load() {
      // React 严格模式下会被调用两次，只加载一次
      if (!loadPromise) loadPromise = doLoad();
      return loadPromise;
    },

    async reloadFromDisk() {
      const text = await platform.readText(LIBRARY_FILE);
      if (!text) return;
      try {
        const lib = migrate(JSON.parse(text));
        set({ categories: lib.categories, stickers: lib.stickers, subscriptions: lib.subscriptions, settings: lib.settings, deleted: lib.deleted });
      } catch {
        /* 主窗口正在写入时可能读到半截文件，等下一次通知 */
      }
    },

    flush: () => flushSave(),

    applyOps(ops) {
      set((s) => applyOps(s, ops));
    },

    recordUsage(id) {
      set((s) => ({ usage: { ...s.usage, [id]: { count: (s.usage[id]?.count ?? 0) + 1, last: Date.now() } } }));
      void platform.recordUsage(id).catch(() => undefined);
    },

    addCategory(name, parentId = null) {
      const clean = name.trim().slice(0, 50) || '新分类';
      const parent = parentId ? get().categories.find((c) => c.id === parentId) : undefined;
      if (parentId && !parent) throw new Error('父分类不存在');
      const order = get().categories.reduce((m, c) => Math.max(m, c.order), -1) + 1;
      const t = Date.now();
      const category: Category = { id: newId(), name: clean, createdAt: t, updatedAt: t, order };
      if (parent) category.parentId = parent.id;
      set((s) => ({ categories: [...s.categories, category] }));
      return category;
    },

    findOrCreateCategory(name, parentId) {
      const clean = name.trim().slice(0, 50) || '新分类';
      const found = get().categories.find((c) => c.name === clean && (c.parentId ?? null) === parentId);
      if (found) return { category: found, created: false };
      return { category: get().addCategory(clean, parentId), created: true };
    },

    renameCategory(id, name) {
      const clean = name.trim().slice(0, 50);
      if (!clean) return;
      set((s) => ({ categories: s.categories.map((c) => (c.id === id && c.name !== clean ? { ...c, name: clean, updatedAt: Date.now() } : c)) }));
    },

    async deleteCategory(id, deleteStickers) {
      // 连同所有子孙分类一起删
      const ids = new Set(categoryIdsIncludingChildren(get().categories, id));
      const inCategory = get().stickers.filter((s) => s.categoryId !== null && ids.has(s.categoryId));
      if (deleteStickers) {
        await get().deleteStickers(inCategory.map((s) => s.id));
      } else {
        patchStickers(
          inCategory.map((s) => s.id),
          (s) => ({ ...s, categoryId: null }),
        );
      }
      const t = Date.now();
      set((s) => ({
        categories: s.categories.filter((c) => !ids.has(c.id)),
        deleted: addTombstones(s.deleted, Array.from(ids, (id) => ({ kind: 'category' as const, id, at: t }))),
      }));
    },

    moveCategory(id, direction) {
      const sorted = sortedCategories(get().categories);
      const me = sorted.find((c) => c.id === id);
      if (!me) return;
      const siblings = sorted.filter((c) => (c.parentId ?? null) === (me.parentId ?? null));
      const idx = siblings.findIndex((c) => c.id === id);
      const target = idx + direction;
      if (target < 0 || target >= siblings.length) return;
      // 在全局顺序里交换这两个同级分类的位置，然后重新编号
      const a = sorted.indexOf(siblings[idx]);
      const b = sorted.indexOf(siblings[target]);
      [sorted[a], sorted[b]] = [sorted[b], sorted[a]];
      const t = Date.now();
      set({ categories: sorted.map((c, i) => (c.order === i ? c : { ...c, order: i, updatedAt: t })) });
    },

    setCategoryParent(id, parentId) {
      assertCanPlace(get().categories, id, parentId);
      set((s) => ({
        categories: s.categories.map((c) => {
          if (c.id !== id) return c;
          const next = { ...c, updatedAt: Date.now() };
          if (parentId) next.parentId = parentId;
          else delete next.parentId;
          return next;
        }),
      }));
    },

    reorderCategory(id, parentId, index) {
      const cats = get().categories;
      const me = cats.find((c) => c.id === id);
      if (!me) throw new Error('分类不存在');
      const oldParent = me.parentId ?? null;
      if (oldParent !== parentId) assertCanPlace(cats, id, parentId);
      const sorted = sortedCategories(cats);
      const siblings = sorted.filter((c) => c.id !== id && (c.parentId ?? null) === parentId);
      const at = Math.max(0, Math.min(index, siblings.length));
      const t = Date.now();
      const moved: Category = { ...me, updatedAt: t };
      if (parentId) moved.parentId = parentId;
      else delete moved.parentId;
      siblings.splice(at, 0, moved);
      // 只重排受影响的两组同级分类的 order，其他组保持原样
      const orders = new Map<string, number>();
      siblings.forEach((c, i) => orders.set(c.id, i));
      if (oldParent !== parentId) {
        sorted.filter((c) => c.id !== id && (c.parentId ?? null) === oldParent).forEach((c, i) => orders.set(c.id, i));
      }
      set((s) => ({
        categories: s.categories.map((c) => {
          if (c.id === id) return { ...moved, order: orders.get(id) ?? moved.order };
          const o = orders.get(c.id);
          return o === undefined || o === c.order ? c : { ...c, order: o, updatedAt: t };
        }),
      }));
    },

    async exportPackage(ids, name, description) {
      const idSet = new Set(ids);
      const stickers = get().stickers.filter((s) => idSet.has(s.id));
      if (stickers.length === 0) throw new Error('没有可导出的表情');
      return buildPackage({
        stickers,
        categories: get().categories,
        name,
        description,
        appVersion: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev',
        readFile: (rel) => platform.readBytes(rel),
      });
    },

    async importPackage(bytes) {
      const pkg = readPackage(bytes);
      const files: ImportFile[] = [];
      let categoriesCreated = 0;
      for (const pack of pkg.packs) {
        let categoryId: string | null = null;
        if (!pack.uncategorized) {
          // group 是父分类路径“一级 / 二级 / …”，沿着路径逐级找或建
          let parentId: string | null = null;
          for (const seg of (pack.group ?? '').split(' / ').map((s) => s.trim()).filter(Boolean)) {
            const g = get().findOrCreateCategory(seg, parentId);
            if (g.created) categoriesCreated++;
            parentId = g.category.id;
          }
          const c = get().findOrCreateCategory(pack.name, parentId);
          if (c.created) categoriesCreated++;
          categoryId = c.category.id;
        }
        for (const st of pack.stickers) {
          files.push({ name: st.fileName, bytes: st.bytes, displayName: st.name, tags: st.tags, categoryId });
        }
      }
      const r = await get().importFiles(files, null);
      return { ...r, name: pkg.name, missing: pkg.missing, categoriesCreated };
    },

    renameStickers(ids, base) {
      const clean = base.trim().slice(0, 70);
      if (!clean) return;
      if (ids.length === 1) {
        get().updateSticker(ids[0], { name: clean });
        return;
      }
      const index = new Map(ids.map((id, i) => [id, i + 1]));
      patchStickers(ids, (s) => ({ ...s, name: `${clean} ${index.get(s.id)}`, updatedAt: Date.now() }));
    },

    async importFiles(files, categoryId) {
      const byHash = new Map<string, string>();
      for (const s of get().stickers) if (s.hash && !byHash.has(s.hash)) byHash.set(s.hash, s.id);
      const result: ImportResult = { added: 0, moved: 0, skipped: 0, failed: 0, errors: [] };
      for (const f of files) {
        try {
          const ext = extFromBytes(f.bytes) ?? extFromName(f.name);
          if (!ext) {
            result.skipped++;
            result.errors.push(`${f.name}：不是支持的图片格式`);
            continue;
          }
          const hash = await sha256Hex(f.bytes);
          const target = f.categoryId === undefined ? categoryId : f.categoryId;
          const existingId = byHash.get(hash);
          if (existingId) {
            // 同样的图片已经有了：指定了分类就把原来那个移过去（保留名字、标签、收藏），不重复添加
            const existing = get().stickers.find((s) => s.id === existingId);
            if (existing && target !== null && existing.categoryId !== target) {
              patchStickers([existingId], (s) => ({ ...s, categoryId: target, updatedAt: Date.now() }));
              result.moved++;
            } else {
              result.skipped++;
            }
            continue;
          }
          const id = newId();
          const file = `stickers/${id}.${ext}`;
          await platform.writeBytes(file, f.bytes);
          const t = Date.now();
          const sticker: Sticker = {
            id,
            name: (f.displayName ?? '').trim().slice(0, 80) || fileStem(f.name),
            file,
            ext,
            size: f.bytes.length,
            categoryId: target,
            tags: uniq((f.tags ?? []).map(cleanTag).filter(Boolean)),
            favorite: false,
            createdAt: t,
            updatedAt: t,
            hash,
            source: { type: 'local' },
          };
          byHash.set(hash, id);
          get().applyOps([{ op: 'addSticker', sticker }]);
          result.added++;
        } catch (e) {
          result.failed++;
          result.errors.push(`${f.name}：${errorMessage(e)}`);
        }
      }
      return result;
    },

    renameMany(renames) {
      const map = new Map<string, string>();
      for (const r of renames) {
        const clean = r.name.trim().slice(0, 80);
        if (clean) map.set(r.id, clean);
      }
      if (map.size === 0) return;
      patchStickers(Array.from(map.keys()), (s) => (s.name === map.get(s.id) ? s : { ...s, name: map.get(s.id)!, updatedAt: Date.now() }));
    },

    setThumb(id, thumb) {
      patchStickers([id], (s) => {
        const next = { ...s };
        if (thumb) next.thumb = thumb;
        else delete next.thumb;
        return next;
      });
    },

    updateSticker(id, patch) {
      const clean: Partial<Sticker> = { ...patch, updatedAt: Date.now() };
      if (patch.name !== undefined) clean.name = patch.name.trim().slice(0, 80) || '表情';
      if (patch.tags !== undefined) clean.tags = uniq(patch.tags.map(cleanTag).filter(Boolean));
      patchStickers([id], (s) => ({ ...s, ...clean }));
    },

    setCategoryFor(ids, categoryId) {
      patchStickers(ids, (s) => ({ ...s, categoryId, updatedAt: Date.now() }));
    },

    addTagsTo(ids, tags) {
      const clean = tags.map(cleanTag).filter(Boolean);
      if (clean.length === 0) return;
      patchStickers(ids, (s) => ({ ...s, tags: uniq([...s.tags, ...clean]), updatedAt: Date.now() }));
    },

    removeTagFrom(ids, tag) {
      patchStickers(ids, (s) => ({ ...s, tags: s.tags.filter((t) => t !== tag), updatedAt: Date.now() }));
    },

    toggleFavorite(id) {
      patchStickers([id], (s) => ({ ...s, favorite: !s.favorite, updatedAt: Date.now() }));
    },

    async deleteStickers(ids) {
      const idSet = new Set(ids);
      const victims = get().stickers.filter((s) => idSet.has(s.id));
      // 记住删除过的订阅表情，下次同步不再拉回
      const hiddenBySub = new Map<string, string[]>();
      for (const v of victims) {
        if (v.source.type === 'subscription') {
          const list = hiddenBySub.get(v.source.subscriptionId) ?? [];
          list.push(stickerKey(v.source.packKey, v.source.remoteId));
          hiddenBySub.set(v.source.subscriptionId, list);
        }
      }
      const t = Date.now();
      set((s) => ({
        stickers: s.stickers.filter((x) => !idSet.has(x.id)),
        deleted: addTombstones(s.deleted, victims.map((v) => ({ kind: 'sticker' as const, id: v.id, at: t }))),
        subscriptions:
          hiddenBySub.size === 0
            ? s.subscriptions
            : s.subscriptions.map((sub) => {
                const extra = hiddenBySub.get(sub.id);
                if (!extra) return sub;
                return { ...sub, hiddenKeys: uniq([...(sub.hiddenKeys ?? []), ...extra]) };
              }),
      }));
      for (const v of victims) {
        await platform.remove(v.file).catch(() => undefined);
        if (v.thumb) await platform.remove(v.thumb).catch(() => undefined);
      }
    },

    renameTag(from, to) {
      const clean = cleanTag(to);
      if (!clean || clean === from) return;
      const t = Date.now();
      set((s) => ({
        stickers: s.stickers.map((x) =>
          x.tags.includes(from) ? { ...x, tags: uniq(x.tags.map((tag) => (tag === from ? clean : tag))), updatedAt: t } : x,
        ),
      }));
    },

    deleteTag(tag) {
      const t = Date.now();
      set((s) => ({
        stickers: s.stickers.map((x) => (x.tags.includes(tag) ? { ...x, tags: x.tags.filter((x2) => x2 !== tag), updatedAt: t } : x)),
      }));
    },

    async addSubscription(url) {
      const trimmed = url.trim();
      if (!/^https?:\/\/\S+$/i.test(trimmed)) throw new Error('请输入以 http:// 或 https:// 开头的地址');
      if (get().subscriptions.some((s) => s.url === trimmed)) throw new Error('这个订阅已经添加过了');
      const sub: Subscription = {
        id: newId(),
        url: trimmed,
        name: hostOf(trimmed),
        addedAt: Date.now(),
        stickerCount: 0,
        deleteRemoved: true,
        autoSync: true,
      };
      set((s) => ({ subscriptions: [...s.subscriptions, sub] }));
      try {
        const result = await get().syncSubscription(sub.id);
        return { subscription: get().subscriptions.find((x) => x.id === sub.id) ?? sub, result };
      } catch (e) {
        // 首次同步就失败（地址错、不是清单等）：撤销添加，让用户改地址重试
        set((s) => ({ subscriptions: s.subscriptions.filter((x) => x.id !== sub.id) }));
        throw e;
      }
    },

    async syncSubscription(id) {
      const sub = get().subscriptions.find((s) => s.id === id);
      if (!sub) throw new Error('订阅不存在');
      if (get().syncStatus[id]?.running) throw new Error('这个订阅正在同步中');
      setStatus(id, { running: true, progress: { phase: 'fetch', done: 0, total: 0 } });
      try {
        return await runSync(
          sub,
          { categories: get().categories, stickers: get().stickers },
          {
            platform,
            now: Date.now,
            newId,
            // 同步途中订阅被删掉的话，后续结果直接丢弃
            apply: (ops) => {
              if (get().subscriptions.some((s) => s.id === id)) get().applyOps(ops);
            },
          },
          (progress) => setStatus(id, { running: true, progress }),
        );
      } finally {
        setStatus(id, { running: false });
      }
    },

    async syncAll(onlyAuto = false) {
      const subs = get().subscriptions.filter((s) => !onlyAuto || s.autoSync);
      for (const sub of subs) {
        try {
          await get().syncSubscription(sub.id);
        } catch (e) {
          console.warn('同步失败', sub.url, e);
        }
      }
    },

    updateSubscription(id, patch) {
      set((s) => ({ subscriptions: s.subscriptions.map((x) => (x.id === id ? { ...x, ...patch } : x)) }));
    },

    async removeSubscription(id, deleteStickers) {
      if (get().syncStatus[id]?.running) throw new Error('订阅正在同步，请稍后再删除');
      const mine = get().stickers.filter((s) => s.source.type === 'subscription' && s.source.subscriptionId === id);
      if (deleteStickers) {
        await get().deleteStickers(mine.map((s) => s.id));
        const remaining = get().stickers;
        set((s) => {
          // 订阅创建的分类：还有表情的留下；父分类只要还有活着的子分类也留下
          const linked = s.categories.filter((c) => c.subscriptionId === id);
          const keep = new Set<string>();
          for (const c of linked) if (remaining.some((x) => x.categoryId === c.id)) keep.add(c.id);
          for (const c of s.categories) {
            if (c.parentId && (keep.has(c.id) || !c.subscriptionId || c.subscriptionId !== id)) keep.add(c.parentId);
          }
          const gone = s.categories.filter((c) => c.subscriptionId === id && !keep.has(c.id));
          return {
            categories: s.categories.filter((c) => c.subscriptionId !== id || keep.has(c.id)),
            deleted: addTombstones(s.deleted, gone.map((c) => ({ kind: 'category' as const, id: c.id, at: Date.now() }))),
          };
        });
      } else {
        patchStickers(
          mine.map((s) => s.id),
          (s) => ({ ...s, source: { type: 'local' } }),
        );
      }
      set((s) => ({
        subscriptions: s.subscriptions.filter((x) => x.id !== id),
        categories: s.categories.map((c) => (c.subscriptionId === id ? stripLink(c) : c)),
        syncStatus: Object.fromEntries(Object.entries(s.syncStatus).filter(([k]) => k !== id)),
      }));
    },

    async restoreHidden(id) {
      set((s) => ({
        subscriptions: s.subscriptions.map((x) => (x.id === id ? { ...x, hiddenKeys: undefined } : x)),
      }));
      return get().syncSubscription(id);
    },

    updateSettings(patch) {
      set((s) => ({ settings: { ...s.settings, ...patch } }));
    },
  };
});

let loadPromise: Promise<void> | null = null;

async function doLoad(): Promise<void> {
  const { setState: set, getState: get } = useLibraryStore;
  try {
    await platform.init();
    const text = await platform.readText(LIBRARY_FILE);
    let lib = emptyLibrary();
    let loadError: string | undefined;
    if (text) {
      try {
        lib = migrate(JSON.parse(text));
      } catch {
        loadError = '资料文件损坏，已尝试从备份恢复';
        const bak = await platform.readText(`${LIBRARY_FILE}.bak`);
        if (bak) {
          try {
            lib = migrate(JSON.parse(bak));
          } catch {
            /* 备份也坏了，只能从空资料开始 */
          }
        }
      }
    }
    const usage = await platform.getUsage().catch(() => ({}) as UsageMap);
    const readOnly = platform.windowRole === 'float';
    set({ ...lib, usage, loaded: true, loadError, saveBlocked: readOnly });
    platform.onUsageChanged((u) => set({ usage: u }));
    if (readOnly) {
      // 浮窗只读：主窗口写了资料文件就重新读取，自己从不写
      platform.onLibraryChanged(() => void get().reloadFromDisk());
      return;
    }
    platform.onBeforeQuit(() => flushSave());
    void applyDesktop(lib.settings);
    if (SUBSCRIPTIONS_ENABLED && lib.settings.autoSyncOnStart && lib.subscriptions.length > 0) {
      setTimeout(() => void get().syncAll(true), 1500);
    }
  } catch (e) {
    // 读不到资料文件：禁止落盘，免得空数据覆盖了真实文件
    set({ loaded: true, loadError: `无法读取资料：${errorMessage(e)}`, saveBlocked: true });
  }
}

/** 把需要主进程配合的设置（快捷键、托盘）交给主进程 */
async function applyDesktop(s: Settings): Promise<void> {
  if (!platform.capabilities.desktop) return;
  try {
    const r = await platform.applyDesktopSettings({ floatHotkey: s.floatHotkey, closeToTray: s.closeToTray });
    useLibraryStore.setState({ hotkeyOk: r.hotkeyOk });
  } catch (e) {
    console.warn('应用桌面设置失败', e);
  }
}

/** 校验“把分类 id 放到 parentId 下”是否合法（订阅包不能挪、不能放进自己或自己的子孙） */
function assertCanPlace(cats: Category[], id: string, parentId: string | null): void {
  const me = cats.find((c) => c.id === id);
  if (!me) throw new Error('分类不存在');
  if (me.subscriptionId && me.packKey && me.packKey !== 'root') throw new Error('订阅里的表情包分类由订阅管理，不能单独移动');
  if (parentId) {
    const parent = cats.find((c) => c.id === parentId);
    if (!parent) throw new Error('目标分类不存在');
    if (isSelfOrDescendant(cats, id, parentId)) throw new Error('不能把分类放到它自己或它的子分类下面');
  }
}

/** 追加删除记录（同一条目只留最新一条，顺手清理过期的） */
function addTombstones(list: Tombstone[], extra: Tombstone[]): Tombstone[] {
  if (extra.length === 0) return list;
  return pruneTombstones([...list, ...extra]);
}

function stripLink(c: Category): Category {
  const copy = { ...c };
  delete copy.subscriptionId;
  delete copy.packKey;
  delete copy.remoteName;
  return copy;
}

// 资料有变动就在 300ms 后落盘（加载完成那一次不算）
useLibraryStore.subscribe((s, prev) => {
  if (!s.loaded || !prev.loaded || s.saveBlocked) return;
  if (
    s.categories !== prev.categories ||
    s.stickers !== prev.stickers ||
    s.subscriptions !== prev.subscriptions ||
    s.settings !== prev.settings ||
    s.deleted !== prev.deleted
  ) {
    scheduleSave();
  }
});

// 快捷键 / 托盘设置变了就通知主进程（只有主窗口负责）
useLibraryStore.subscribe((s, prev) => {
  if (!s.loaded || !prev.loaded || platform.windowRole !== 'main') return;
  if (s.settings.floatHotkey !== prev.settings.floatHotkey || s.settings.closeToTray !== prev.settings.closeToTray) {
    void applyDesktop(s.settings);
  }
});
