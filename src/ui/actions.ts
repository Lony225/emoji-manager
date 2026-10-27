import { useLibraryStore, type ImportFile, type ImportResult } from '../core/store';
import { useUiStore, type MenuItem } from './uiStore';
import type { ClipboardFile, FolderFile, PickedFolder } from '../platform/types';
import { copySticker, copyStickers } from '../core/clipboard';
import { isMobile, platform } from '../platform';
import { errorMessage } from '../core/subscription/sync';
import { SUBSCRIPTIONS_ENABLED } from '../core/features';
import { extFromBytes, extFromContentType, extFromName, fileStem, mimeFromExt } from '../core/images';
import { defaultPackageName } from '../core/package';
import { categoryIdsIncludingChildren, categoryLabel } from '../core/selectors';
import type { Sticker } from '../core/types';
import type { MakerSource } from './maker';

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
    if (await platform.share(sticker.file, sticker.name)) lib().recordUsage(sticker.id);
  } catch (e) {
    ui().toast(`分享失败：${errorMessage(e)}`, 'error');
  }
}

/** 把多个表情一起交给系统分享面板（手机） */
export async function shareMany(ids: string[]): Promise<void> {
  const idSet = new Set(ids);
  const stickers = lib().stickers.filter((s) => idSet.has(s.id));
  if (stickers.length === 0) return;
  if (stickers.length === 1) return shareSticker(stickers[0]);
  try {
    if (await platform.shareMany(stickers.map((s) => s.file))) {
      for (const s of stickers) lib().recordUsage(s.id);
    }
  } catch (e) {
    ui().toast(`分享失败：${errorMessage(e)}`, 'error');
  }
}

/** 点一下表情：桌面端复制；手机上按设置打开分享面板或复制 */
export function primaryAction(sticker: Sticker): void {
  if (isMobile && platform.capabilities.share && lib().settings.tapAction === 'share') void shareSticker(sticker);
  else void copyStickerWithFeedback(sticker);
}

// ---------------------------------------------------------------- 删除 / 重命名

export function confirmDeleteStickers(ids: string[]): void {
  const n = ids.length;
  ui().openDialog({
    kind: 'confirm',
    title: n === 1 ? '删除这个表情？' : `删除 ${n} 个表情？`,
    message: SUBSCRIPTIONS_ENABLED ? '图片文件会一并删除。来自订阅的表情删除后，下次同步不会再拉回来。' : '图片文件会一并删除。',
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

function describeImport(r: ImportResult, extra: string[] = [], where?: string): void {
  const parts: string[] = [];
  if (r.added) parts.push(where ? `已导入 ${r.added} 个表情到“${where}”` : `已导入 ${r.added} 个表情`);
  if (r.moved) parts.push(`${r.moved} 个已有的相同表情已移到该分类`);
  parts.push(...extra);
  if (r.skipped) parts.push(`跳过 ${r.skipped} 个重复或不支持的文件`);
  if (r.failed) parts.push(`${r.failed} 个导入失败`);
  ui().toast(parts.join('，') || '没有新的表情', r.failed ? 'error' : r.added || r.moved ? 'success' : 'info');
}

export async function importFileList(files: Iterable<File>, categoryId: string | null, opts: { mentionCategory?: boolean } = {}): Promise<void> {
  const list = Array.from(files).filter(isImageFile);
  const { toast } = ui();
  if (list.length === 0) {
    toast('没有可导入的图片（支持 png / jpg / gif / webp / bmp / avif / svg）', 'error');
    return;
  }
  if (list.length > 20) toast(`正在导入 ${list.length} 张图片…`);
  const where = opts.mentionCategory && categoryId ? lib().categories.find((c) => c.id === categoryId)?.name : undefined;
  describeImport(await lib().importFiles(await toImportFiles(list), categoryId), [], where);
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
    // 没有目录项可用时退回 dataTransfer.files；上面已经从 getAsFile 拿到的就不要再加一遍
    if (files.length === 0) files.push(...Array.from(fallbackFiles ?? []));
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
export function openFoldersImport(folders: PickedFolder[], parentName?: string, parentId?: string): void {
  const nonEmpty = folders.filter((f) => f.files.some((x) => isImageName(x.name)));
  if (nonEmpty.length === 0) {
    ui().toast('所选文件夹里没有支持的图片（png / jpg / gif / webp / bmp / avif / svg）', 'error');
    return;
  }
  ui().openDialog({ kind: 'importFolders', folders: nonEmpty, parentName, parentId });
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

// ---------------------------------------------------------------- 粘贴 / 拖入：文件、剪贴板位图、网页图片

export function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
}

/** 剪贴板 / 拖放里能拿到的内容 */
export interface LooseContent {
  files: File[];
  html: string;
  uris: string[];
  text: string;
}

/** 必须在事件处理函数里同步调用（DataTransfer 过了事件就读不到了） */
export function readTransfer(dt: DataTransfer | null | undefined): LooseContent {
  if (!dt) return { files: [], html: '', uris: [], text: '' };
  const safe = (type: string) => {
    try {
      return dt.getData(type) || '';
    } catch {
      return '';
    }
  };
  return {
    files: Array.from(dt.files ?? []),
    html: safe('text/html'),
    uris: safe('text/uri-list')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith('#')),
    text: safe('text/plain'),
  };
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", '#x27': "'" };

function decodeEntities(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|#39|#x27);/g, (_, k: string) => ENTITIES[k] ?? '');
}

/** 从网页片段里的 <img>、链接列表、纯文本里找出图片地址（http(s) 或 data:image） */
export function imageUrlsFrom(c: LooseContent): string[] {
  const out: string[] = [];
  const add = (raw: string) => {
    const u = raw.trim();
    if (u && !out.includes(u) && out.length < 20 && (/^https?:\/\//i.test(u) || /^data:image\//i.test(u))) out.push(u);
  };
  for (const m of c.html.matchAll(/<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) add(decodeEntities(m[1] ?? m[2] ?? m[3] ?? ''));
  for (const u of c.uris) add(u);
  const t = c.text.trim();
  if (/^(https?:\/\/\S+|data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]+)$/i.test(t)) add(t);
  return out;
}

/** 浏览器把剪贴板里的位图（截图、聊天窗口里复制的图）包装成一个刚创建的、叫 image.png 的文件 */
function isClipboardBitmap(f: File): boolean {
  return f.name === 'image.png' && f.type === 'image/png' && Date.now() - f.lastModified < 60_000;
}

/** 地址的扩展名一看就是静态格式，没必要为了保留动画再去抓原图 */
function surelyStatic(url: string): boolean {
  const ext = extFromName(url);
  return ext === 'jpg' || ext === 'bmp';
}

function toFile(bytes: Uint8Array, name: string, ext: string): File {
  return new File([bytes as unknown as BlobPart], `${name}.${ext}`, { type: mimeFromExt(ext) });
}

/** 把一个图片地址变成文件：data: 直接解码，http(s) 交给平台层下载（桌面端不受跨域限制） */
async function fileFromUrl(url: string): Promise<File | null> {
  if (/^data:/i.test(url)) {
    const m = /^data:(image\/[a-z0-9.+-]+)?(;base64)?,([\s\S]*)$/i.exec(url);
    if (!m) return null;
    const payload = m[2]
      ? Uint8Array.from(atob(m[3].replace(/\s+/g, '')), (ch) => ch.charCodeAt(0))
      : new TextEncoder().encode(decodeURIComponent(m[3]));
    const ext = extFromBytes(payload) ?? extFromContentType(m[1]);
    return ext ? toFile(payload, '粘贴的图片', ext) : null;
  }
  const { bytes, contentType } = await platform.fetchBytes(url, 15000);
  const ext = extFromBytes(bytes) ?? extFromContentType(contentType);
  if (!ext) return null;
  const stem = fileStem(url);
  return toFile(bytes, stem === '表情' ? '网页图片' : stem, ext);
}

async function filesFromUrls(urls: string[]): Promise<File[]> {
  const out: File[] = [];
  for (const u of urls) {
    try {
      const f = await fileFromUrl(u);
      if (f) out.push(f);
    } catch (e) {
      console.warn('获取图片失败', u, e);
    }
  }
  return out;
}

export interface LooseImportOptions {
  /** 指定分类（拖到侧栏某个分类上时）；不传则按当前视图决定或询问 */
  categoryId?: string;
  /** 一起拖进来的文件夹 */
  folders?: PickedFolder[];
  /** 用户明确做了动作（点了“粘贴”、松开了拖放）：什么都没导入时要提示 */
  explicit?: boolean;
}

/**
 * 导入“松散”的内容（粘贴或拖进来的）：
 * 1. 真正的文件（有名字的图片、zip、文件夹）直接用；
 * 2. 否则看网页片段 / 链接里有没有图片地址——从浏览器复制或拖来的图片走这里能拿到原图（GIF 保留动画）；
 * 3. 最后才用剪贴板位图（截图、聊天窗口里复制的图）。
 * 返回有没有导入东西。
 */
export async function importLoose(content: LooseContent, opts: LooseImportOptions = {}): Promise<boolean> {
  const { toast } = ui();
  const folders = opts.folders ?? [];
  const zips = content.files.filter((f) => /\.zip$/i.test(f.name));
  const bitmaps = content.files.filter((f) => isImageFile(f) && isClipboardBitmap(f));
  let images = content.files.filter((f) => isImageFile(f) && !isClipboardBitmap(f));
  if (images.length === 0) {
    const urls = imageUrlsFrom(content);
    // 位图已经在手里时，只有地址可能是动图（或看不出格式）才值得去抓原图
    const worth = bitmaps.length === 0 ? urls : urls.filter((u) => /^data:/i.test(u) || !surelyStatic(u));
    if (worth.length) {
      if (worth.some((u) => /^https?:/i.test(u))) toast('正在获取图片…');
      images = await filesFromUrls(worth);
    }
  }
  if (images.length === 0 && bitmaps.length) {
    images = bitmaps.map((f, i) => new File([f], `粘贴的表情 ${i + 1}.png`, { type: f.type }));
  }
  for (const z of zips) await importPackageFile(z);
  if (images.length) {
    if (opts.categoryId !== undefined) await importFileList(images, opts.categoryId, { mentionCategory: true });
    else importImages(images);
  }
  if (folders.length) openFoldersImport(folders, undefined, opts.categoryId);
  const handled = zips.length > 0 || images.length > 0 || folders.length > 0;
  if (!handled && opts.explicit) {
    const hadSomething = content.files.length > 0 || content.uris.length > 0 || content.html !== '';
    toast(hadSomething ? '没有可导入的图片、文件夹或 zip 表情包' : '剪贴板里没有图片', 'error');
  }
  return handled;
}

/** 点了“粘贴”按钮之后短时间内到来的 paste 事件算作用户明确要粘贴 */
let explicitPasteUntil = 0;

/** 处理 paste 事件（Ctrl+V，或点“粘贴”按钮后由主进程触发） */
export function handlePasteEvent(e: ClipboardEvent): void {
  const explicit = Date.now() < explicitPasteUntil;
  explicitPasteUntil = 0;
  if (isEditableTarget(e.target) || ui().dialog.kind !== 'none') return;
  const content = readTransfer(e.clipboardData);
  // 纯文字（不是图片地址）不拦截也不提示，除非是点了按钮
  if (content.files.length === 0 && imageUrlsFrom(content).length === 0) {
    if (explicit) ui().toast('剪贴板里没有图片', 'error');
    return;
  }
  e.preventDefault();
  void importLoose(content, { explicit });
}

/** 点“粘贴”按钮：桌面端让主进程执行粘贴命令（和 Ctrl+V 走同一条路），安卓读原生剪贴板，浏览器里用 navigator.clipboard 读 */
export async function pasteFromClipboard(): Promise<void> {
  const active = document.activeElement as HTMLElement | null;
  if (active && active !== document.body && typeof active.blur === 'function') active.blur();
  try {
    explicitPasteUntil = Date.now() + 2000;
    if (await platform.triggerPaste()) return;
    explicitPasteUntil = 0;
    const native = await platform.readClipboard();
    if (native) {
      await importLoose({ files: native.files.map(toBrowserFile), html: native.html, uris: [], text: native.text }, { explicit: true });
      return;
    }
    const clip = navigator.clipboard as Clipboard | undefined;
    if (!clip || typeof clip.read !== 'function') throw new Error('当前浏览器不支持读取剪贴板，请直接按 Ctrl+V');
    const content: LooseContent = { files: [], html: '', uris: [], text: '' };
    for (const item of await clip.read()) {
      for (const type of item.types) {
        const blob = await item.getType(type);
        if (type.startsWith('image/')) content.files.push(new File([blob], `image.${type.split('/')[1] || 'png'}`, { type }));
        else if (type === 'text/html') content.html = await blob.text();
        else if (type === 'text/plain') content.text = await blob.text();
      }
    }
    await importLoose(content, { explicit: true });
  } catch (e) {
    ui().toast(`读取剪贴板失败：${errorMessage(e)}`, 'error');
  }
}

function toBrowserFile(f: ClipboardFile): File {
  return new File([f.bytes as unknown as BlobPart], f.name, { type: f.mime });
}

/** 其他应用“分享到本应用”的图片 / zip / 链接（安卓）：和拖入、粘贴一样处理 */
export async function importReceived(files: ClipboardFile[], text: string): Promise<void> {
  await importLoose({ files: files.map(toBrowserFile), html: '', uris: [], text }, { explicit: true });
}

/** 这个拖动能不能导入：系统文件，或网页上拖来的图片 / 链接（侧栏自己的分类拖拽不算） */
export function isDragAcceptable(e: DragEvent): boolean {
  const types = Array.from(e.dataTransfer?.types ?? []);
  return types.includes('Files') || types.includes('text/uri-list');
}

/** 拖放落点所在的侧栏分类（分类行上有 data-drop-category） */
export function dropCategoryAt(target: EventTarget | null): string | undefined {
  const el = target as Element | null;
  const row = el && typeof el.closest === 'function' ? el.closest<HTMLElement>('[data-drop-category]') : null;
  return row?.dataset.dropCategory || undefined;
}

/** 处理拖放：先同步把 DataTransfer 里的东西读出来，再异步导入 */
export async function handleDropEvent(e: DragEvent): Promise<void> {
  const content = readTransfer(e.dataTransfer);
  const categoryId = dropCategoryAt(e.target);
  const pending = readDroppedItems(e.dataTransfer?.items ?? null, e.dataTransfer?.files ?? null);
  try {
    const { files, folders } = await pending;
    await importLoose({ ...content, files }, { folders, categoryId, explicit: true });
  } catch (err) {
    ui().toast(`导入失败：${errorMessage(err)}`, 'error');
  }
}

// ---------------------------------------------------------------- 制作表情（加文字）

export function openMaker(source: MakerSource): void {
  ui().openDialog({ kind: 'maker', source });
}

/** 选一张本地图片加文字 */
export async function pickAndMake(): Promise<void> {
  const [file] = await pickFiles({ multiple: false });
  if (file) openMaker({ type: 'file', file });
}

/** 用 meme-generator 的模板做表情（桌面端）；给 stickerId 则把这张图填进第一个图片槽 */
export function openMemeTemplates(stickerId?: string): void {
  if (!platform.capabilities.memeTemplates) {
    ui().toast('当前环境不支持模板表情', 'error');
    return;
  }
  ui().openDialog({ kind: 'memeTemplates', stickerId });
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
    // 手机上“分享”是主要用法，放最前面
    if (caps.share && isMobile) items.push({ label: '分享 / 发送…', icon: 'share', onSelect: () => void shareSticker(single) });
    if (caps.copyImage) items.push({ label: '复制图片', icon: 'copy', onSelect: () => void copyStickerWithFeedback(single, 'image') });
    if (caps.copyFile) items.push({ label: '复制文件', icon: 'file', onSelect: () => void copyStickerWithFeedback(single, 'file') });
    if (caps.share && !isMobile) items.push({ label: '分享…', icon: 'share', onSelect: () => void shareSticker(single) });
    items.push({ label: '重命名', icon: 'edit', onSelect: () => startRename(ids) });
    items.push({ label: '编辑…', icon: 'edit', onSelect: () => ui().openDialog({ kind: 'sticker', id: single.id }) });
    items.push({ label: '加文字，做成新表情…', icon: 'text', onSelect: () => openMaker({ type: 'sticker', id: single.id }) });
    if (caps.memeTemplates) items.push({ label: '用这张图套模板…', icon: 'sparkles', onSelect: () => openMemeTemplates(single.id) });
  } else {
    if (caps.share && isMobile) items.push({ label: `分享 ${stickers.length} 个…`, icon: 'share', onSelect: () => void shareMany(ids) });
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
