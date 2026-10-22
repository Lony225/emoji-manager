import type { OsKind, Platform, UsageMap } from './types';
import { extFromName, mimeFromExt } from '../core/images';

const DB_NAME = 'emoji-manager';
const STORE = 'files';
const USAGE_FILE = 'usage.json';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('无法打开本地数据库'));
  });
}

function run<T>(db: IDBDatabase, mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const r = fn(t.objectStore(STORE));
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('本地数据库操作失败'));
  });
}

function detectOs(): OsKind {
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return 'android';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  if (/Windows/i.test(ua)) return 'windows';
  if (/Mac OS/i.test(ua)) return 'mac';
  if (/Linux/i.test(ua)) return 'linux';
  return 'unknown';
}

function toBlob(bytes: Uint8Array, type: string): Blob {
  return new Blob([bytes as unknown as BlobPart], { type });
}

function networkHint(e: unknown): Error {
  const msg = e instanceof Error ? e.message : String(e);
  if (e instanceof DOMException && e.name === 'AbortError') return new Error('请求超时');
  if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) {
    return new Error('无法访问该地址（浏览器跨域限制或网络问题；桌面版不受此限制）');
  }
  return e instanceof Error ? e : new Error(msg);
}

type Stored = Uint8Array | string | undefined;

/** 纯浏览器实现：文件存 IndexedDB，图片用 blob: 地址显示 */
export function createWebPlatform(): Platform {
  let db: IDBDatabase;
  const urls = new Map<string, string>();

  const get = (rel: string) => run<Stored>(db, 'readonly', (s) => s.get(rel));
  const put = (rel: string, v: Uint8Array | string) => run(db, 'readwrite', (s) => s.put(v, rel));
  const del = (rel: string) => run(db, 'readwrite', (s) => s.delete(rel));
  const revoke = (rel: string) => {
    const u = urls.get(rel);
    if (u) {
      URL.revokeObjectURL(u);
      urls.delete(rel);
    }
  };
  const makeUrl = (rel: string, bytes: Uint8Array) => {
    revoke(rel);
    const u = URL.createObjectURL(toBlob(bytes, mimeFromExt(extFromName(rel) ?? '')));
    urls.set(rel, u);
    return u;
  };

  const readUsage = async (): Promise<UsageMap> => {
    const v = await get(USAGE_FILE);
    if (typeof v !== 'string') return {};
    try {
      return JSON.parse(v) as UsageMap;
    } catch {
      return {};
    }
  };

  return {
    kind: 'web',
    os: detectOs(),
    arch: 'unknown',
    windowRole: 'main',
    capabilities: {
      copyImage: typeof navigator !== 'undefined' && !!navigator.clipboard && 'write' in navigator.clipboard,
      copyFile: false,
      share: typeof navigator !== 'undefined' && typeof navigator.share === 'function',
      revealInFolder: false,
      changeLibraryDir: false,
      corsRestricted: true,
      desktop: false,
      multiFolderPick: false,
    },
    async init() {
      db = await openDb();
    },
    async readText(rel) {
      const v = await get(rel);
      if (v === undefined) return null;
      return typeof v === 'string' ? v : new TextDecoder().decode(v);
    },
    async writeText(rel, text) {
      await put(rel, text);
    },
    async readBytes(rel) {
      const v = await get(rel);
      if (v === undefined) return null;
      return typeof v === 'string' ? new TextEncoder().encode(v) : v;
    },
    async writeBytes(rel, bytes) {
      await put(rel, bytes);
      makeUrl(rel, bytes);
    },
    async remove(rel) {
      await del(rel);
      revoke(rel);
    },
    async rename(from, to) {
      const v = await get(from);
      if (v === undefined) throw new Error('文件不存在');
      await put(to, v);
      await del(from);
      revoke(from);
    },
    async exists(rel) {
      return (await get(rel)) !== undefined;
    },
    fileUrlSync: (rel) => urls.get(rel),
    async fileUrl(rel) {
      const u = urls.get(rel);
      if (u) return u;
      const v = await get(rel);
      if (v === undefined || typeof v === 'string') return '';
      return makeUrl(rel, v);
    },
    async fetchText(url, timeoutMs = 30000) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      try {
        const res = await fetch(url, { signal: ac.signal });
        return { ok: res.ok, status: res.status, text: await res.text(), finalUrl: res.url || url };
      } catch (e) {
        throw networkHint(e);
      } finally {
        clearTimeout(timer);
      }
    },
    async download(url, rel, timeoutMs = 60000) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      try {
        const res = await fetch(url, { signal: ac.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (bytes.length > 100 * 1024 * 1024) throw new Error('文件超过 100 MB');
        await put(rel, bytes);
        makeUrl(rel, bytes);
        return { size: bytes.length, contentType: res.headers.get('content-type') };
      } catch (e) {
        throw networkHint(e);
      } finally {
        clearTimeout(timer);
      }
    },
    async copyImagePng(png) {
      if (!navigator.clipboard || !('write' in navigator.clipboard)) throw new Error('当前浏览器不支持复制图片');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': toBlob(png, 'image/png') })]);
    },
    async copyFile() {
      throw new Error('浏览器中不支持复制文件');
    },
    async copyFiles() {
      throw new Error('浏览器中不支持复制文件');
    },
    pickFolders() {
      // 浏览器的目录选择框一次只能选一个文件夹
      return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        input.setAttribute('webkitdirectory', '');
        input.style.display = 'none';
        document.body.appendChild(input);
        const done = () => {
          const files = Array.from(input.files ?? []);
          input.remove();
          if (files.length === 0) {
            resolve(null);
            return;
          }
          const first = files[0].webkitRelativePath || files[0].name;
          const name = first.split('/')[0] || '文件夹';
          resolve({
            folders: [
              {
                name,
                files: files.map((f) => {
                  const full = f.webkitRelativePath || f.name;
                  return {
                    name: f.name,
                    rel: full.startsWith(name + '/') ? full.slice(name.length + 1) : full,
                    size: f.size,
                    read: async () => new Uint8Array(await f.arrayBuffer()),
                  };
                }),
              },
            ],
          });
        };
        input.addEventListener('change', done, { once: true });
        input.addEventListener('cancel', done, { once: true });
        input.click();
      });
    },
    async saveFile(name, bytes) {
      const url = URL.createObjectURL(toBlob(bytes, 'application/zip'));
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      return { saved: true };
    },
    async share(rel, name) {
      const v = await get(rel);
      if (v === undefined || typeof v === 'string') throw new Error('文件不存在');
      const ext = extFromName(rel) ?? 'png';
      const file = new File([v as unknown as BlobPart], `${name}.${ext}`, { type: mimeFromExt(ext) });
      if (!navigator.canShare || !navigator.canShare({ files: [file] })) throw new Error('当前浏览器不支持分享文件');
      await navigator.share({ files: [file] });
    },
    async revealInFolder() {
      throw new Error('浏览器中不支持此操作');
    },
    async openExternal(url) {
      window.open(url, '_blank', 'noopener');
    },
    async getLibraryPath() {
      return '浏览器本地存储（IndexedDB）';
    },
    async chooseLibraryDir() {
      return { changed: false, error: '浏览器中不支持更改数据目录' };
    },
    async openLibraryDir() {},
    async relaunch() {
      location.reload();
    },
    getUsage: readUsage,
    async recordUsage(id) {
      const usage = await readUsage();
      usage[id] = { count: (usage[id]?.count ?? 0) + 1, last: Date.now() };
      await put(USAGE_FILE, JSON.stringify(usage));
    },
    onUsageChanged() {},
    onLibraryChanged() {},
    onFloatShown() {},
    async showFloat() {},
    async hideFloat() {},
    async showMain() {},
    async applyDesktopSettings() {
      return { hotkeyOk: true };
    },
    async getLaunchAtLogin() {
      return { enabled: false, available: false };
    },
    async setLaunchAtLogin() {},
    onDeepLink() {},
    async takePendingDeepLink() {
      // 浏览器版：支持 ?subscribe=<清单地址> 这种打开方式
      const u = new URL(location.href).searchParams.get('subscribe');
      if (!u) return null;
      history.replaceState(null, '', location.pathname);
      return `emojimanager://subscribe?url=${encodeURIComponent(u)}`;
    },
    onBeforeQuit(cb) {
      // 浏览器关闭时来不及等异步写入，所以切到后台时也先落盘一次
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') void cb();
      });
      window.addEventListener('beforeunload', () => {
        void cb();
      });
    },
  };
}
