import { App } from '@capacitor/app';
import { Capacitor, CapacitorHttp, SystemBars, SystemBarsStyle, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import type { ClipboardFile, Platform, UsageMap } from './types';

/** 随应用打包的原生插件：android/app/src/main/java/dev/lony/emojimanager/EmojiNativePlugin.java */
interface NativeFile {
  name: string;
  mime: string;
  /** base64 */
  data: string;
}

interface EmojiNativePlugin {
  copyImage(o: { data: string; mime: string; name: string }): Promise<void>;
  copyFiles(o: { paths: string[] }): Promise<void>;
  readClipboard(): Promise<{ files: NativeFile[]; text: string; html: string }>;
  takePendingShare(): Promise<{ files: NativeFile[]; text: string }>;
  takePendingDeepLink(): Promise<{ url: string | null }>;
  openUrl(o: { url: string }): Promise<void>;
  /** 窗口底色（#rrggbb）：旧版 WebView 不会铺到状态栏 / 导航栏下面，露出来的是它 */
  setBackground(o: { color: string }): Promise<void>;
  addListener(event: 'received' | 'deepLink', cb: () => void): Promise<PluginListenerHandle>;
}

const Native = registerPlugin<EmojiNativePlugin>('EmojiNative');

/** 资料库放在应用私有目录（files/）下的这个子目录里，结构和桌面版一样：library.json + stickers/ + thumbs/ */
const ROOT = 'library';
const LIBRARY_FILE = 'library.json';
const USAGE_FILE = 'usage.json';
const DIR = Directory.Data;
const MAX_BYTES = 100 * 1024 * 1024;

function toBase64(bytes: Uint8Array): string {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array {
  // 原生端有时按 76 列换行输出
  const bin = atob(b64.replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function fromNativeFile(f: NativeFile): ClipboardFile {
  return { name: f.name, mime: f.mime, bytes: fromBase64(f.data) };
}

function isCancel(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /cancel/i.test(msg);
}

function httpError(e: unknown): Error {
  const msg = e instanceof Error ? e.message : String(e);
  if (/time ?d? ?out|SocketTimeout/i.test(msg)) return new Error('请求超时');
  if (/resolve host|Unable to resolve|ConnectException|Failed to connect|unreachable|No address associated/i.test(msg)) {
    return new Error('无法访问该地址（网络问题）');
  }
  return e instanceof Error ? e : new Error(msg);
}

function headerOf(headers: Record<string, string> | undefined, name: string): string | null {
  if (!headers) return null;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return key ? headers[key] : null;
}

/** #rrggbb 的相对亮度（0 深 … 1 浅），用来决定状态栏图标用深色还是浅色 */
function luminance(hex: string): number {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return 1;
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => parseInt(h, 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function safeName(name: string): string {
  const clean = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
  return clean || 'file';
}

/** 安卓（Capacitor）实现：文件存应用私有目录，分享走系统分享面板，剪贴板 / 接收分享由自带的原生插件完成 */
export function createCapacitorPlatform(): Platform {
  /** file:///data/user/0/<包名>/files/library */
  let baseUri = '';
  let ready: Promise<void> | null = null;

  const rel = (r: string) => `${ROOT}/${r}`;
  const abs = (r: string) => `${baseUri}/${r}`;

  const init = (): Promise<void> => {
    if (!ready) {
      ready = (async () => {
        const { uri } = await Filesystem.getUri({ path: ROOT, directory: DIR });
        baseUri = uri.replace(/\/+$/, '');
        for (const dir of [ROOT, `${ROOT}/stickers`, `${ROOT}/thumbs`]) {
          await Filesystem.mkdir({ path: dir, directory: DIR, recursive: true }).catch(() => undefined);
        }
      })();
    }
    return ready;
  };

  const exists = async (r: string): Promise<boolean> => {
    try {
      await Filesystem.stat({ path: rel(r), directory: DIR });
      return true;
    } catch {
      return false;
    }
  };

  const writeBytes = async (r: string, bytes: Uint8Array): Promise<void> => {
    await init();
    await Filesystem.writeFile({ path: rel(r), data: toBase64(bytes), directory: DIR, recursive: true });
  };

  const getBytes = async (url: string, timeoutMs: number) => {
    let res;
    try {
      res = await CapacitorHttp.get({ url, responseType: 'blob', connectTimeout: timeoutMs, readTimeout: timeoutMs });
    } catch (e) {
      throw httpError(e);
    }
    if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
    // 原生端把二进制按 base64 返回；响应是 JSON 时会被先解析成对象
    const bytes = typeof res.data === 'string' ? fromBase64(res.data) : new TextEncoder().encode(JSON.stringify(res.data ?? ''));
    if (bytes.length > MAX_BYTES) throw new Error('文件超过 100 MB');
    return { bytes, contentType: headerOf(res.headers, 'content-type') };
  };

  /** 把一段数据写到缓存目录，返回 file:// 地址（分享 / 复制用） */
  const stageInCache = async (sub: string, name: string, bytes: Uint8Array): Promise<string> => {
    const { uri } = await Filesystem.writeFile({ path: `${sub}/${safeName(name)}`, data: toBase64(bytes), directory: Directory.Cache, recursive: true });
    return uri;
  };

  const shareFiles = async (files: string[], dialogTitle: string): Promise<boolean> => {
    try {
      await Share.share({ files, dialogTitle });
      return true;
    } catch (e) {
      if (isCancel(e)) return false;
      throw e;
    }
  };

  const readUsage = async (): Promise<UsageMap> => {
    await init();
    if (!(await exists(USAGE_FILE))) return {};
    try {
      const r = await Filesystem.readFile({ path: rel(USAGE_FILE), directory: DIR, encoding: Encoding.UTF8 });
      return JSON.parse(typeof r.data === 'string' ? r.data : await r.data.text()) as UsageMap;
    } catch {
      return {};
    }
  };

  return {
    kind: 'capacitor',
    os: Capacitor.getPlatform() === 'ios' ? 'ios' : 'android',
    arch: 'unknown',
    windowRole: 'main',
    capabilities: {
      copyImage: true,
      copyFile: true,
      share: true,
      revealInFolder: false,
      changeLibraryDir: false,
      corsRestricted: false,
      desktop: false,
      multiFolderPick: false,
      memeTemplates: false,
    },
    init,

    async readText(r) {
      await init();
      if (!(await exists(r))) return null;
      const res = await Filesystem.readFile({ path: rel(r), directory: DIR, encoding: Encoding.UTF8 });
      return typeof res.data === 'string' ? res.data : await res.data.text();
    },
    async writeText(r, text) {
      await init();
      // 资料文件先留一份上一版备份，和桌面版一样
      if (r === LIBRARY_FILE && (await exists(r))) {
        await Filesystem.deleteFile({ path: rel(`${r}.bak`), directory: DIR }).catch(() => undefined);
        await Filesystem.copy({ from: rel(r), to: rel(`${r}.bak`), directory: DIR }).catch(() => undefined);
      }
      await Filesystem.writeFile({ path: rel(r), data: text, directory: DIR, encoding: Encoding.UTF8, recursive: true });
    },
    async readBytes(r) {
      await init();
      if (!(await exists(r))) return null;
      const res = await Filesystem.readFile({ path: rel(r), directory: DIR });
      return typeof res.data === 'string' ? fromBase64(res.data) : new Uint8Array(await res.data.arrayBuffer());
    },
    writeBytes,
    async remove(r) {
      await init();
      await Filesystem.deleteFile({ path: rel(r), directory: DIR }).catch(() => undefined);
    },
    async rename(from, to) {
      await init();
      await Filesystem.deleteFile({ path: rel(to), directory: DIR }).catch(() => undefined);
      await Filesystem.rename({ from: rel(from), to: rel(to), directory: DIR });
    },
    exists,
    fileUrlSync: (r) => (baseUri ? Capacitor.convertFileSrc(abs(r)) : undefined),
    async fileUrl(r) {
      await init();
      return Capacitor.convertFileSrc(abs(r));
    },

    async fetchText(url, timeoutMs = 30000) {
      try {
        const res = await CapacitorHttp.get({
          url,
          responseType: 'text',
          connectTimeout: timeoutMs,
          readTimeout: timeoutMs,
          headers: { Accept: 'application/json, text/plain, */*' },
        });
        const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data ?? '');
        return { ok: res.status >= 200 && res.status < 300, status: res.status, text, finalUrl: res.url || url };
      } catch (e) {
        throw httpError(e);
      }
    },
    async download(url, r, timeoutMs = 60000) {
      const { bytes, contentType } = await getBytes(url, timeoutMs);
      await writeBytes(r, bytes);
      return { size: bytes.length, contentType };
    },
    fetchBytes: (url, timeoutMs = 20000) => getBytes(url, timeoutMs),

    copyImagePng: (png) => Native.copyImage({ data: toBase64(png), mime: 'image/png', name: 'sticker.png' }),
    async triggerPaste() {
      return false;
    },
    async readClipboard() {
      const r = await Native.readClipboard();
      return { files: (r.files ?? []).map(fromNativeFile), text: r.text ?? '', html: r.html ?? '' };
    },
    async copyFile(r) {
      await init();
      await Native.copyFiles({ paths: [abs(r)] });
    },
    async copyFiles(rels) {
      await init();
      await Native.copyFiles({ paths: rels.map(abs) });
    },
    async copyFileBytes(name, bytes) {
      await Native.copyFiles({ paths: [await stageInCache('clipboard', name, bytes)] });
    },
    async saveFile(name, bytes) {
      // 手机上没有“另存为”对话框：写到缓存后打开系统分享面板，可以发给文件传输助手、存到文件应用等
      const uri = await stageInCache('export', name, bytes);
      return { saved: await shareFiles([uri], '发送或保存文件') };
    },
    async pickFolders() {
      throw new Error('安卓版不支持选择文件夹，请直接选择图片');
    },
    async share(r, name) {
      await init();
      return shareFiles([abs(r)], `发送“${name}”`);
    },
    async shareMany(rels) {
      await init();
      return shareFiles(rels.map(abs), `发送 ${rels.length} 个表情`);
    },
    async revealInFolder() {
      throw new Error('安卓版不支持此操作');
    },
    openExternal: (url) => Native.openUrl({ url }),
    async getLibraryPath() {
      await init();
      return `${decodeURIComponent(baseUri.replace(/^file:\/\//, ''))}（应用私有目录，卸载应用会一并删除；备份请用“导出全部”）`;
    },
    async chooseLibraryDir() {
      return { changed: false, error: '安卓版不支持更改数据目录' };
    },
    async openLibraryDir() {},
    async relaunch() {
      location.reload();
    },
    onBeforeQuit(cb) {
      void App.addListener('pause', () => void cb());
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') void cb();
      });
    },
    onDeepLink(cb) {
      void Native.addListener('deepLink', cb);
    },
    async takePendingDeepLink() {
      return (await Native.takePendingDeepLink()).url ?? null;
    },

    getUsage: readUsage,
    async recordUsage(id) {
      const usage = await readUsage();
      usage[id] = { count: (usage[id]?.count ?? 0) + 1, last: Date.now() };
      await Filesystem.writeFile({ path: rel(USAGE_FILE), data: JSON.stringify(usage), directory: DIR, encoding: Encoding.UTF8, recursive: true });
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
    async setWindowBackground(color) {
      // 状态栏 / 导航栏是透明的，图标颜色要跟界面底色反着来；窗口底色也同步，免得旧版 WebView 在栏下面露出白边。
      // 先设样式再设底色：Capacitor 的 setStyle 会把窗口底色重置成主题色
      const dark = luminance(color) < 0.5;
      await SystemBars.setStyle({ style: dark ? SystemBarsStyle.Dark : SystemBarsStyle.Light }).catch(() => undefined);
      await Native.setBackground({ color }).catch(() => undefined);
    },

    async memeStatus() {
      return { available: false, version: '', templates: 0, fontsTotal: 0, fontsReady: 0, downloading: false, error: '安卓版不支持模板表情' };
    },
    async memeList() {
      throw new Error('安卓版不支持模板表情');
    },
    async memePreview() {
      throw new Error('安卓版不支持模板表情');
    },
    async memeGenerate() {
      throw new Error('安卓版不支持模板表情');
    },
    async memeDownloadFonts() {
      throw new Error('安卓版不支持模板表情');
    },
    onMemeProgress() {
      return () => undefined;
    },

    onReceivedFiles(cb) {
      const drain = async () => {
        const r = await Native.takePendingShare();
        const files = (r.files ?? []).map(fromNativeFile);
        if (files.length || r.text) cb(files, r.text ?? '');
      };
      void Native.addListener('received', () => void drain());
      void drain();
    },
    onBack(cb) {
      void App.addListener('backButton', () => {
        if (!cb()) void App.minimizeApp();
      });
    },
  };
}
