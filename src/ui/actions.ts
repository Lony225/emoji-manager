import { useLibraryStore, type ImportFile, type ImportResult } from '../core/store';
import { useUiStore, type MenuItem } from './uiStore';
import type { FolderFile, PickedFolder } from '../platform/types';
import { copySticker, copyStickers } from '../core/clipboard';
import { platform } from '../platform';
import { errorMessage } from '../core/subscription/sync';
import { extFromName } from '../core/images';
import { defaultPackageName } from '../core/package';
import { categoryIdsIncludingChildren, categoryLabel } from '../core/selectors';
import type { Sticker } from '../core/types';

const lib = () => useLibraryStore.getState();
const ui = () => useUiStore.getState();

/** 当前网格里的表情顺序，用于 Shift 范围选择和全选 */
let visibleOrder: string[] = [];
export function setVisibleOrder(ids: string[]): void {
  visibleOrder = ids;
}
export function getVisibleOrder(): string[] {
  return visibleOrder;
}

export function rangeSelect(toId: string): void {
  const { anchorId, select } = ui();
  const a = anchorId ? visibleOrder.indexOf(anchorId) : -1;
  const b = visibleOrder.indexOf(toId);
  if (a < 0 || b < 0) {
    select([toId], 'add');
    ui().setAnchor(toId);
    return;
  }
  const [from, to] = a < b ? [a, b] : [b, a];
  select(visibleOrder.slice(from, to + 1), 'add');
}

// ---------------------------------------------------------------- 复制

/** 浮窗复制成功后的回调（浮窗用它来自动隐藏） */
let afterCopyHook: ((sticker: Sticker) => void) | null = null;
export function setAfterCopyHook(fn: ((sticker: Sticker) => void) | null): void {
  afterCopyHook = fn;
}

export async function copyStickerWithFeedback(sticker: Sticker, mode?: 'file' | 'image'): Promise<void> {
  const { setStamp, toast } = ui();
  setStamp(sticker.id, 'pending');
  try {
    await copySticker(sticker, mode ?? lib().settings.copyMode);
    setStamp(sticker.id, 'done');
    lib().recordUsage(sticker.id);
    setTimeout(() => {
      if (ui().stamps[sticker.id] === 'done') setStamp(sticker.id, null);
    }, 900);
    afterCopyHook?.(sticker);
  } catch (e) {
    setStamp(sticker.id, null);
    toast(`复制失败：${errorMessage(e)}`, 'error');
  }
}

/** 批量复制：多个表情作为多个文件一起放进剪贴板 */
export async function copyManyWithFeedback(ids: string[]): Promise<void> {
  const idSet = new Set(ids);
  const stickers = lib().stickers.filter((s) => idSet.has(s.id));
  if (stickers.length === 0) return;
  if (stickers.length === 1) return copyStickerWithFeedback(stickers[0]);
  const { setStamps, toast } = ui();
  setStamps(ids, 'pending');
  try {
    await copyStickers(stickers, lib().settings.copyMode);
    setStamps(ids, 'done');
    for (const s of stickers) lib().recordUsage(s.id);
    toast(`已复制 ${stickers.length} 个表情，可直接粘贴发送`, 'success');
    setTimeout(() => setStamps(ids, null), 900);
  } catch (e) {
    setStamps(ids, null);
    toast(`复制失败：${errorMessage(e)}`, 'error');
  }
}

export async function shareSticker(sticker: Sticker): Promise<void> {
  try {
    await platform.share(sticker.file, sticker.name);
  } catch (e) {
    ui().toast(`分享失败：${errorMessage(e)}`, 'error');
  }
}

// ---------------------------------------------------------------- 删除 / 重命名

export function confirmDeleteStickers(ids: string[]): void {
  const n = ids.length;
  ui().openDialog({
    kind: 'confirm',
    title: n === 1 ? '删除这个表情？' : `删除 ${n} 个表情？`,
    message: '图片文件会一并删除。来自订阅的表情删除后，下次同步不会再拉回来。',
    confirmText: '删除',
    danger: true,
    onConfirm: async () => {
      await lib().deleteStickers(ids);
      ui().clearSelection();
      ui().toast(n === 1 ? '已删除' : `已删除 ${n} 个表情`);
    },
  });
}

export function startRename(ids: string[]): void {
  if (ids.length === 1) {
    ui().setRenaming(ids[0]);
    return;
  }
  ui().openDialog({ kind: 'bulkRename', ids });
}

// ---------------------------------------------------------------- 导入

export function isImageFile(f: File): boolean {
  return f.type.startsWith('image/') || extFromName(f.name) !== null;
}

/** 用隐藏的 <input type=file> 选择文件；所有平台通用 */
export function pickFiles(opts: { directory?: boolean; accept?: string; multiple?: boolean } = {}): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = opts.multiple ?? true;
    input.accept = opts.accept ?? 'image/*';
    if (opts.directory) input.setAttribute('webkitdirectory', '');
    input.style.display = 'none';
    document.body.appendChild(input);
    const done = () => {
      resolve(Array.from(input.files ?? []));
      input.remove();
    };
    input.addEventListener('change', done, { once: true });
    input.addEventListener('cancel', done, { once: true });
    input.click();
  });
}

async function toImportFiles(files: Iterable<File>): Promise<ImportFile[]> {
  return Promise.all(Array.from(files).map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })));
}

function describeImport(r: ImportResult, extra: string[] = []): void {
  const parts: string[] = [];
  if (r.added) parts.push(`已导入 ${r.added} 个表情`);
  if (r.moved) parts.push(`${r.moved} 个已有的相同表情已移到该分类`);
  parts.push(...extra);
  if (r.skipped) parts.push(`跳过 ${r.skipped} 个重复或不支持的文件`);
  if (r.failed) parts.push(`${r.failed} 个导入失败`);
  ui().toast(parts.join('，') || '没有新的表情', r.failed ? 'error' : r.added || r.moved ? 'success' : 'info');
}

export async function importFileList(files: Iterable<File>, categoryId: string | null): Promise<void> {
  const list = Array.from(files).filter(isImageFile);
  const { toast } = ui();
  if (list.length === 0) {
    toast('没有可导入的图片（支持 png / jpg / gif / webp / bmp / avif / svg）', 'error');
    return;
  }
  if (list.length > 20) toast(`正在导入 ${list.length} 张图片…`);
  describeImport(await lib().importFiles(await toImportFiles(list), categoryId));
}

/** 当前正在看的分类（导入时默认放进去） */
export function currentCategoryId(): string | null {
  const view = ui().filter.view;
  return view.kind === 'category' ? view.id : null;
}

/**
 * 导入散图：正在看某个分类就直接放进去；
 * 在“全部 / 最近 / 收藏 / 未分类”里则先问放到哪个分类（有二级分类也在列表里），免得图片都落到未分类。
 */
export function importImages(files: Iterable<File>): void {
  const list = Array.from(files).filter(isImageFile);
  if (list.length === 0) {
    ui().toast('没有可导入的图片（支持 png / jpg / gif / webp / bmp / avif / svg）', 'error');
    return;
  }
  const cur = currentCategoryId();
  if (cur !== null || lib().categories.length === 0) {
    void importFileList(list, cur);
    return;
  }
  ui().openDialog({
    kind: 'pickCategory',
    title: `把 ${list.length} 张图片放到哪个分类？`,
    hint: '在某个分类里拖入或粘贴图片时会直接放进那个分类，不再询问。',
    onPick: (id) => void importFileList(list, id),
  });
}

export type FolderPlacement =
  | { kind: 'top' }
  | { kind: 'under'; parentId: string }
  | { kind: 'newParent'; name: string };

export interface FoldersImportOptions {
  /** false = 不建分类，所有图片直接放进 targetCategoryId */
  addToCategory: boolean;
  /** 每个文件夹对应的分类名（与 folders 一一对应，可改） */
  names: string[];
  /** 这些分类放在哪：一级 / 某个一级分类下（成为二级）/ 新建一个一级分类并放在它下面 */
  placement: FolderPlacement;
  /** 第一层子文件夹作为二级分类（只在 placement 为一级时有效） */
  subfoldersAsChildren: boolean;
  targetCategoryId: string | null;
}

export interface FolderImportResult extends ImportResult {
  categoryNames: string[];
}

export function isImageName(name: string): boolean {
  return extFromName(name) !== null;
}

const IMPORT_BATCH = 100;

/**
 * 把一个或多个文件夹导入为分类（可放在任意分类下）。
 * subfoldersAsChildren 为 true 时，子文件夹逐级成为子分类，和文件夹结构一样多级。
 */
export async function importFolders(folders: PickedFolder[], opts: FoldersImportOptions): Promise<FolderImportResult> {
  const total: FolderImportResult = { added: 0, moved: 0, skipped: 0, failed: 0, errors: [], categoryNames: [] };
  const merge = (r: ImportResult) => {
    total.added += r.added;
    total.moved += r.moved;
    total.skipped += r.skipped;
    total.failed += r.failed;
    total.errors.push(...r.errors);
  };
  const importBatch = async (files: { f: FolderFile; categoryId: string | null }[]) => {
    for (let i = 0; i < files.length; i += IMPORT_BATCH) {
      const slice = files.slice(i, i + IMPORT_BATCH);
      const batch: ImportFile[] = [];
      for (const { f, categoryId } of slice) {
        try {
          batch.push({ name: f.name, bytes: await f.read(), categoryId });
        } catch (e) {
          total.failed++;
          total.errors.push(`${f.name}：${errorMessage(e)}`);
        }
      }
      merge(await lib().importFiles(batch, opts.targetCategoryId));
    }
  };

  if (!opts.addToCategory) {
    const all = folders.flatMap((folder) => folder.files.filter((f) => isImageName(f.name)).map((f) => ({ f, categoryId: opts.targetCategoryId })));
    await importBatch(all);
    return total;
  }

  let parentId: string | null = null;
  let parentLabel = '';
  if (opts.placement.kind === 'under') {
    const parent = lib().categories.find((c) => c.id === (opts.placement as { parentId: string }).parentId);
    if (!parent) throw new Error('目标分类不存在');
    parentId = parent.id;
    parentLabel = categoryLabel(lib().categories, parent.id);
  } else if (opts.placement.kind === 'newParent') {
    const { category } = lib().findOrCreateCategory(opts.placement.name, null);
    parentId = category.id;
    parentLabel = category.name;
    total.categoryNames.push(category.name);
  }

  for (const [i, folder] of folders.entries()) {
    const name = (opts.names[i] ?? folder.name).trim() || folder.name;
    const { category } = lib().findOrCreateCategory(name, parentId);
    total.categoryNames.push(parentLabel ? `${parentLabel} / ${category.name}` : category.name);
    // 子文件夹路径 → 逐级子分类（按路径缓存，避免重复查找）
    const byPath = new Map<string, string>([['', category.id]]);
    const categoryFor = (dirPath: string): string => {
      const cached = byPath.get(dirPath);
      if (cached) return cached;
      const idx = dirPath.lastIndexOf('/');
      const parentPath = idx >= 0 ? dirPath.slice(0, idx) : '';
      const dirName = (idx >= 0 ? dirPath.slice(idx + 1) : dirPath).trim() || '未命名';
      const pid = categoryFor(parentPath);
      const child = lib().findOrCreateCategory(dirName, pid).category;
      byPath.set(dirPath, child.id);
      total.categoryNames.push(`${parentLabel ? `${parentLabel} / ` : ''}${category.name} / ${dirPath.split('/').join(' / ')}`);
      return child.id;
    };
    const files = folder.files
      .filter((f) => isImageName(f.name))
      .map((f) => {
        const slash = f.rel.lastIndexOf('/');
        const dirPath = opts.subfoldersAsChildren && slash > 0 ? f.rel.slice(0, slash) : '';
        return { f, categoryId: categoryFor(dirPath) };
      });
    await importBatch(files);
  }
  return total;
}

/** 拖进来的东西：拆成散文件和文件夹（递归读取文件夹内容） */
export async function readDroppedItems(
  items: DataTransferItemList | null,
  fallbackFiles: FileList | null,
): Promise<{ files: File[]; folders: PickedFolder[] }> {
  const files: File[] = [];
  const folders: PickedFolder[] = [];
  const entries: FileSystemEntry[] = [];
  if (items) {
    for (const item of Array.from(items)) {
      if (item.kind !== 'file') continue;
      const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null;
      if (entry) entries.push(entry);
      else {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
  }
  if (entries.length === 0) {
    files.push(...Array.from(fallbackFiles ?? []));
    return { files, folders };
  }
  for (const entry of entries) {
    if (entry.isFile) {
      files.push(await entryFile(entry as FileSystemFileEntry));
    } else if (entry.isDirectory) {
      const list: FolderFile[] = [];
      await walkDirectory(entry as FileSystemDirectoryEntry, '', list);
      folders.push({ name: entry.name, files: list });
    }
  }
  return { files, folders };
}

function entryFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

function fromFile(file: File, rel: string): FolderFile {
  return { name: file.name, rel, size: file.size, read: async () => new Uint8Array(await file.arrayBuffer()) };
}

async function walkDirectory(dir: FileSystemDirectoryEntry, prefix: string, out: FolderFile[]): Promise<void> {
  const reader = dir.createReader();
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (batch.length === 0) break;
    for (const e of batch) {
      if (e.isFile) {
        if (e.name.startsWith('.') || !isImageName(e.name)) continue;
        out.push(fromFile(await entryFile(e as FileSystemFileEntry), prefix + e.name));
      } else if (e.isDirectory && !e.name.startsWith('.')) {
        await walkDirectory(e as FileSystemDirectoryEntry, `${prefix}${e.name}/`, out);
      }
    }
    if (out.length > 20000) throw new Error('文件夹里的文件太多了（超过 20000）');
  }
}

/** 打开“导入文件夹”对话框（一个或多个文件夹一起处理） */
export function openFoldersImport(folders: PickedFolder[], parentName?: string): void {
  const nonEmpty = folders.filter((f) => f.files.some((x) => isImageName(x.name)));
  if (nonEmpty.length === 0) {
    ui().toast('所选文件夹里没有支持的图片（png / jpg / gif / webp / bmp / avif / svg）', 'error');
    return;
  }
  ui().openDialog({ kind: 'importFolders', folders: nonEmpty, parentName });
}

export async function pickAndImportFolders(): Promise<void> {
  try {
    const picked = await platform.pickFolders();
    if (picked) openFoldersImport(picked.folders, picked.parentName);
  } catch (e) {
    ui().toast(`读取文件夹失败：${errorMessage(e)}`, 'error');
  }
}

export async function pickAndImportPackage(): Promise<void> {
  const [file] = await pickFiles({ accept: '.zip,application/zip', multiple: false });
  if (!file) return;
  await importPackageFile(file);
}

export async function importPackageFile(file: File): Promise<void> {
  const { toast } = ui();
  toast(`正在读取 ${file.name}…`);
  try {
    const r = await lib().importPackage(new Uint8Array(await file.arrayBuffer()));
    const extra: string[] = [];
    if (r.categoriesCreated) extra.push(`新建 ${r.categoriesCreated} 个分类`);
    if (r.missing) extra.push(`${r.missing} 个缺少图片`);
    describeImport(r, extra);
  } catch (e) {
    toast(`导入失败：${errorMessage(e)}`, 'error');
  }
}

// ---------------------------------------------------------------- 导出

export function openExportDialog(ids: string[]): void {
  if (ids.length === 0) {
    ui().toast('没有可导出的表情');
    return;
  }
  const idSet = new Set(ids);
  const stickers = lib().stickers.filter((s) => idSet.has(s.id));
  ui().openDialog({ kind: 'exportPackage', ids, defaultName: defaultPackageName(stickers, lib().categories) });
}

/** 导出一个分类：包含它下面所有层级的子分类 */
export function exportCategory(categoryId: string): void {
  const ids = new Set(categoryIdsIncludingChildren(lib().categories, categoryId));
  openExportDialog(lib().stickers.filter((s) => s.categoryId !== null && ids.has(s.categoryId)).map((s) => s.id));
}

// ---------------------------------------------------------------- 右键菜单

export function stickerMenuItems(ids: string[]): MenuItem[] {
  const idSet = new Set(ids);
  const stickers = lib().stickers.filter((s) => idSet.has(s.id));
  const single = stickers.length === 1 ? stickers[0] : null;
  const caps = platform.capabilities;
  const items: MenuItem[] = [];
  if (single) {
    if (caps.copyImage) items.push({ label: '复制图片', icon: 'copy', onSelect: () => void copyStickerWithFeedback(single, 'image') });
    if (caps.copyFile) items.push({ label: '复制文件', icon: 'file', onSelect: () => void copyStickerWithFeedback(single, 'file') });
    if (caps.share) items.push({ label: '分享…', icon: 'share', onSelect: () => void shareSticker(single) });
    items.push({ label: '重命名', icon: 'edit', onSelect: () => startRename(ids) });
    items.push({ label: '编辑…', icon: 'edit', onSelect: () => ui().openDialog({ kind: 'sticker', id: single.id }) });
  } else {
    if (caps.copyFile) items.push({ label: `复制 ${stickers.length} 个文件`, icon: 'copy', onSelect: () => void copyManyWithFeedback(ids) });
    items.push({ label: '批量命名…', icon: 'edit', onSelect: () => startRename(ids) });
  }
  const allFav = stickers.length > 0 && stickers.every((s) => s.favorite);
  items.push({
    label: allFav ? '取消收藏' : '收藏',
    icon: 'star',
    onSelect: () => {
      for (const s of stickers) if (s.favorite === allFav) lib().toggleFavorite(s.id);
    },
  });
  items.push({ label: '移动到分类…', icon: 'folder', onSelect: () => ui().openDialog({ kind: 'move', ids }) });
  items.push({ label: '添加标签…', icon: 'tag', onSelect: () => ui().openDialog({ kind: 'bulkTags', ids }) });
  items.push({ label: stickers.length > 1 ? `导出 ${stickers.length} 个…` : '导出…', icon: 'download', onSelect: () => openExportDialog(ids) });
  if (single && caps.revealInFolder) {
    items.push({
      label: '在文件夹中显示',
      icon: 'external',
      onSelect: () => void platform.revealInFolder(single.file).catch((e) => ui().toast(errorMessage(e), 'error')),
    });
  }
  items.push({ label: '', separator: true });
  items.push({
    label: stickers.length > 1 ? `删除 ${stickers.length} 个表情` : '删除',
    icon: 'trash',
    danger: true,
    onSelect: () => confirmDeleteStickers(ids),
  });
  return items;
}

export function openStickerMenu(x: number, y: number, ids: string[]): void {
  ui().openMenu({ x, y, items: stickerMenuItems(ids) });
}
