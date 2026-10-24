import {
  app,
  BrowserWindow,
  ClipboardItem,
  Menu,
  Tray,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  nativeImage,
  nativeTheme,
  net,
  protocol,
  screen,
  shell,
} from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const DEV_URL = process.env.VITE_DEV_SERVER_URL;
const MAX_DOWNLOAD = 100 * 1024 * 1024;
const USER_AGENT = `EmojiManager/${app.getVersion()}`;
/** 开机自启时带上 --hidden：只显示托盘图标，不打开主窗口 */
const START_HIDDEN = process.argv.includes('--hidden');
/** 网页“一键导入”用的自定义协议：emojimanager://subscribe?url=<清单地址> */
const PROTOCOL = 'emojimanager';
const ICON_PATH = path.join(__dirname, 'icon.png');
const PRELOAD = path.join(__dirname, 'preload.cjs');

// 测试或便携使用时可以指定用户数据目录
if (process.env.EMOJI_USER_DATA_DIR) {
  app.setPath('userData', path.resolve(process.env.EMOJI_USER_DATA_DIR));
}
app.setAppUserModelId('dev.lony.emoji-manager');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  {
    scheme: 'sticker',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
  },
]);

// ---------------------------------------------------------------- 数据目录

let libraryDir = '';

function pointerFile(): string {
  return path.join(app.getPath('userData'), 'library-location.json');
}

/** 数据目录默认在 userData/library，用户可以改到别处（例如同步盘） */
function resolveLibraryDir(): string {
  try {
    const j = JSON.parse(fs.readFileSync(pointerFile(), 'utf8')) as { path?: unknown };
    if (typeof j.path === 'string' && fs.existsSync(j.path)) return j.path;
  } catch {
    /* 使用默认位置 */
  }
  return path.join(app.getPath('userData'), 'library');
}

/** 把相对路径限制在数据目录内 */
function safeJoin(rel: string): string {
  if (typeof rel !== 'string' || rel.length === 0) throw new Error('无效路径');
  const abs = path.resolve(libraryDir, rel);
  const root = libraryDir.endsWith(path.sep) ? libraryDir : libraryDir + path.sep;
  if (!abs.startsWith(root)) throw new Error('非法路径');
  return abs;
}

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

function mimeFor(p: string): string {
  return MIME[path.extname(p).toLowerCase()] ?? 'application/octet-stream';
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function netError(e: unknown): Error {
  if (e instanceof Error && e.name === 'AbortError') return new Error('请求超时');
  const msg = errorMessage(e);
  if (/ERR_NAME_NOT_RESOLVED/.test(msg)) return new Error('域名无法解析，请检查地址或网络');
  if (/ERR_CONNECTION|ERR_INTERNET_DISCONNECTED|ERR_NETWORK/.test(msg)) return new Error('无法连接到服务器');
  if (/ERR_CERT/.test(msg)) return new Error('服务器证书无效');
  return e instanceof Error ? e : new Error(msg);
}

function assertHttpUrl(url: string): URL {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error('无效的地址');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('只支持 http/https 地址');
  return u;
}

async function atomicWrite(abs: string, data: string | Uint8Array): Promise<void> {
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp-${process.pid}`;
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, abs);
}

/** 给所有窗口（可排除发送者）广播一条消息 */
function broadcast(channel: string, payload?: unknown, except?: Electron.WebContents): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed() && w.webContents !== except) w.webContents.send(channel, payload);
  }
}

// ---------------------------------------------------------------- 窗口位置记忆

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface WindowState {
  main?: Bounds;
  float?: Bounds;
}

let windowState: WindowState = {};
let windowStateTimer: NodeJS.Timeout | null = null;

function windowStateFile(): string {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function loadWindowState(): void {
  try {
    const j = JSON.parse(fs.readFileSync(windowStateFile(), 'utf8')) as unknown;
    windowState = isRecord(j) ? (j as WindowState) : {};
  } catch {
    windowState = {};
  }
}

function saveWindowState(): void {
  if (windowStateTimer) clearTimeout(windowStateTimer);
  windowStateTimer = setTimeout(() => {
    fs.writeFile(windowStateFile(), JSON.stringify(windowState, null, 2), () => undefined);
  }, 400);
}

function trackBounds(win: BrowserWindow, key: keyof WindowState): void {
  const update = () => {
    if (win.isDestroyed() || win.isMinimized() || win.isMaximized()) return;
    windowState[key] = win.getBounds();
    saveWindowState();
  };
  win.on('resize', update);
  win.on('move', update);
}

/** 记住的位置至少要有一部分落在某个屏幕内，否则不用 */
function visibleBounds(b: Bounds | undefined): Bounds | undefined {
  if (!b || typeof b.x !== 'number' || typeof b.y !== 'number' || !(b.width > 0) || !(b.height > 0)) return undefined;
  const wa = screen.getDisplayMatching(b).workArea;
  const ok = b.x < wa.x + wa.width - 40 && b.x + b.width > wa.x + 40 && b.y < wa.y + wa.height - 40 && b.y + b.height > wa.y;
  return ok ? b : undefined;
}

// ---------------------------------------------------------------- 使用记录（最近使用）

type UsageMap = Record<string, { count: number; last: number }>;
let usage: UsageMap = {};
let usageTimer: NodeJS.Timeout | null = null;
const USAGE_KEEP = 500;

function usageFile(): string {
  return path.join(libraryDir, 'usage.json');
}

function loadUsage(): void {
  usage = {};
  try {
    const j = JSON.parse(fs.readFileSync(usageFile(), 'utf8')) as unknown;
    if (!isRecord(j)) return;
    for (const [id, v] of Object.entries(j)) {
      if (isRecord(v) && typeof v.count === 'number' && typeof v.last === 'number') {
        usage[id] = { count: v.count, last: v.last };
      }
    }
  } catch {
    /* 没有记录 */
  }
}

function saveUsage(): void {
  if (usageTimer) clearTimeout(usageTimer);
  usageTimer = setTimeout(() => {
    void atomicWrite(usageFile(), JSON.stringify(usage)).catch((e) => console.warn('保存使用记录失败', e));
  }, 500);
}

function recordUsage(id: string): void {
  if (typeof id !== 'string' || !id || id.length > 64) return;
  usage[id] = { count: (usage[id]?.count ?? 0) + 1, last: Date.now() };
  const keys = Object.keys(usage);
  if (keys.length > USAGE_KEEP + 100) {
    keys.sort((a, b) => usage[b].last - usage[a].last);
    for (const k of keys.slice(USAGE_KEEP)) delete usage[k];
  }
  saveUsage();
  broadcast('usage:changed', usage);
}

// ---------------------------------------------------------------- 自定义协议

function registerProtocols(): void {
  // sticker://library/<相对路径> → 数据目录中的图片
  protocol.handle('sticker', async (req) => {
    let abs: string;
    try {
      const u = new URL(req.url);
      abs = safeJoin(decodeURIComponent(u.pathname).replace(/^\/+/, ''));
    } catch {
      return new Response('Forbidden', { status: 403 });
    }
    try {
      const data = await fsp.readFile(abs);
      return new Response(data, {
        headers: {
          'content-type': mimeFor(abs),
          'cache-control': 'max-age=31536000, immutable',
          'access-control-allow-origin': '*',
        },
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });

  // app://app/… → 打包后的前端静态文件
  protocol.handle('app', async (req) => {
    const distDir = path.join(__dirname, '..', 'dist');
    const u = new URL(req.url);
    let p = decodeURIComponent(u.pathname);
    if (p === '/' || p === '') p = '/index.html';
    let abs = path.resolve(distDir, '.' + p);
    if (!abs.startsWith(distDir)) return new Response('Forbidden', { status: 403 });
    if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) abs = path.join(distDir, 'index.html');
    const res = await net.fetch(pathToFileURL(abs).href);
    return new Response(res.body, {
      status: res.status,
      headers: { 'content-type': mimeFor(abs), 'content-security-policy': CSP },
    });
  });
}

const CSP = [
  "default-src 'self' app: sticker:",
  "img-src 'self' app: sticker: data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "connect-src 'self' app: sticker:",
  "font-src 'self' data:",
].join('; ');

// ---------------------------------------------------------------- 剪贴板 / 系统

function runCommand(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, timeout: 15000 }, (err, _stdout, stderr) => {
      if (err) reject(new Error(String(stderr || '').trim() || err.message));
      else resolve();
    });
  });
}

/**
 * 把文件本身放进剪贴板（粘贴到聊天软件时能保留 GIF 动画）。
 * 多个文件一起放进去，粘贴时会作为多个文件发送。
 */
async function copyFilesToClipboard(absList: string[]): Promise<void> {
  if (absList.length === 0) throw new Error('没有要复制的文件');
  if (process.platform === 'win32') {
    const list = absList.map((p) => `'${p.replace(/'/g, "''")}'`).join(',');
    await runCommand('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-STA',
      '-Command',
      `Set-Clipboard -LiteralPath ${list}`,
    ]);
  } else if (process.platform === 'darwin') {
    // AppleScript 字符串里反斜杠和双引号要转义
    const items = absList.map((p) => `POSIX file "${p.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
    const expr = items.length === 1 ? `(${items[0]})` : `{${items.join(', ')}}`;
    try {
      await runCommand('osascript', ['-e', `set the clipboard to ${expr}`]);
    } catch (e) {
      if (items.length === 1) throw e;
      // 个别系统版本不接受文件列表：退回只复制第一个
      await runCommand('osascript', ['-e', `set the clipboard to (${items[0]})`]);
      throw new Error('系统不支持一次复制多个文件，已只复制第一个');
    }
  } else {
    throw new Error('当前系统不支持复制文件，请改用复制图片');
  }
}

// ---------------------------------------------------------------- 选择文件夹导入

const IMAGE_EXTS = new Set(['.png', '.apng', '.jpg', '.jpeg', '.jfif', '.gif', '.webp', '.bmp', '.avif', '.svg']);
const MAX_PICKED_FILES = 20000;

interface PickedEntry {
  rel: string;
  name: string;
  size: number;
  path: string;
}

/** 一次“选择文件夹”的结果：渲染进程只能读这次列出来的文件 */
interface PickSession {
  allowed: Set<string>;
  createdAt: number;
}
const pickSessions = new Map<string, PickSession>();

async function walkImages(root: string, out: PickedEntry[], rel = ''): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(path.join(root, rel), { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
  for (const d of entries) {
    if (d.name.startsWith('.') || d.isSymbolicLink()) continue;
    const childRel = rel ? `${rel}/${d.name}` : d.name;
    if (d.isDirectory()) {
      await walkImages(root, out, childRel);
    } else if (d.isFile() && IMAGE_EXTS.has(path.extname(d.name).toLowerCase())) {
      const abs = path.join(root, childRel);
      let size = 0;
      try {
        size = (await fsp.stat(abs)).size;
      } catch {
        continue;
      }
      out.push({ rel: childRel, name: d.name, size, path: abs });
    }
    if (out.length >= MAX_PICKED_FILES) throw new Error(`文件夹里的图片太多了（超过 ${MAX_PICKED_FILES} 张）`);
  }
}

async function pickFolders(win: BrowserWindow | null) {
  const options: Electron.OpenDialogOptions = {
    title: '选择要导入的文件夹（可以同时选多个）',
    buttonLabel: '导入',
    properties: ['openDirectory', 'multiSelections', 'dontAddToRecent'],
  };
  const r = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
  if (r.canceled || r.filePaths.length === 0) return null;
  const token = crypto.randomUUID();
  const allowed = new Set<string>();
  const folders = [];
  for (const dir of r.filePaths) {
    const files: PickedEntry[] = [];
    await walkImages(path.resolve(dir), files);
    for (const f of files) allowed.add(f.path);
    folders.push({ name: path.basename(dir) || dir, files });
  }
  // 只保留最近一次选择；旧的（半小时前）顺手清掉
  for (const [k, s] of pickSessions) if (Date.now() - s.createdAt > 30 * 60 * 1000) pickSessions.delete(k);
  pickSessions.set(token, { allowed, createdAt: Date.now() });
  const parents = new Set(r.filePaths.map((p) => path.dirname(path.resolve(p))));
  const parentName = parents.size === 1 ? path.basename([...parents][0]) || undefined : undefined;
  return { token, parentName, folders };
}

function safeFileName(name: string): string {
  const clean = name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim().slice(0, 120);
  return clean || '表情包';
}

async function saveFileDialog(
  win: BrowserWindow | null,
  suggestedName: string,
  bytes: Uint8Array,
): Promise<{ saved: boolean; path?: string }> {
  if (!(bytes instanceof Uint8Array)) throw new Error('文件数据无效');
  const name = safeFileName(typeof suggestedName === 'string' ? suggestedName : '');
  const options: Electron.SaveDialogOptions = {
    title: '导出表情包',
    defaultPath: path.join(app.getPath('downloads'), name),
    filters: name.toLowerCase().endsWith('.zip') ? [{ name: 'Zip 压缩包', extensions: ['zip'] }] : [],
  };
  const r = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
  if (r.canceled || !r.filePath) return { saved: false };
  await fsp.writeFile(r.filePath, bytes);
  return { saved: true, path: r.filePath };
}

async function chooseLibraryDir(win: BrowserWindow | null): Promise<{ changed: boolean; path?: string; error?: string }> {
  const options: Electron.OpenDialogOptions = {
    title: '选择数据目录',
    buttonLabel: '使用此目录',
    properties: ['openDirectory', 'createDirectory'],
  };
  const r = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
  if (r.canceled || r.filePaths.length === 0) return { changed: false };
  const target = path.resolve(r.filePaths[0]);
  if (target === path.resolve(libraryDir)) return { changed: false };
  try {
    const hasLibrary = fs.existsSync(path.join(target, 'library.json'));
    if (!hasLibrary && fs.existsSync(libraryDir)) {
      // 目标目录里没有资料库：把现有资料复制过去
      await fsp.cp(libraryDir, target, { recursive: true, force: false, errorOnExist: false });
    }
    await fsp.mkdir(app.getPath('userData'), { recursive: true });
    await fsp.writeFile(pointerFile(), JSON.stringify({ path: target }, null, 2));
    return { changed: true, path: target };
  } catch (e) {
    return { changed: false, error: errorMessage(e) };
  }
}

// ---------------------------------------------------------------- 桌面设置：快捷键 / 托盘

let closeToTray = true;
let currentHotkey = '';

function displayAccelerator(acc: string): string {
  const mac = process.platform === 'darwin';
  const names: Record<string, string> = mac
    ? { CommandOrControl: '⌘', CmdOrCtrl: '⌘', Command: '⌘', Cmd: '⌘', Control: '⌃', Ctrl: '⌃', Alt: '⌥', Option: '⌥', Shift: '⇧', Super: '⌘' }
    : { CommandOrControl: 'Ctrl', CmdOrCtrl: 'Ctrl', Command: 'Win', Cmd: 'Win', Control: 'Ctrl', Ctrl: 'Ctrl', Alt: 'Alt', Option: 'Alt', Shift: 'Shift', Super: 'Win' };
  return acc
    .split('+')
    .map((p) => names[p] ?? p)
    .join(mac ? '' : '+');
}

const MODIFIERS = new Set([
  'Command', 'Cmd', 'Control', 'Ctrl', 'CommandOrControl', 'CmdOrCtrl', 'Alt', 'Option', 'AltGr', 'Shift', 'Super', 'Meta',
]);
const NAMED_KEYS = new Set([
  'Plus', 'Space', 'Tab', 'Backspace', 'Delete', 'Insert', 'Return', 'Enter', 'Up', 'Down', 'Left', 'Right', 'Home', 'End',
  'PageUp', 'PageDown', 'Escape', 'Esc', 'PrintScreen', 'numdec', 'numadd', 'numsub', 'nummult', 'numdiv',
]);

/**
 * 严格校验快捷键写法。Electron 自己的解析很宽松：遇到不认识的词会直接忽略，
 * 像 "NotAKey+Z" 会被注册成全局的 Z 键，把所有程序的 Z 都抢走，所以必须先把关。
 * 返回规范化后的写法，不合法返回 null。
 */
function normalizeAccelerator(acc: string): string | null {
  const parts = acc.split('+').map((p) => p.trim());
  if (parts.length === 0 || parts.some((p) => !p)) return null;
  const mods: string[] = [];
  let key: string | null = null;
  for (const p of parts) {
    if (MODIFIERS.has(p)) {
      mods.push(p);
      continue;
    }
    const k = /^[a-z]$/.test(p) ? p.toUpperCase() : p;
    const isKey =
      /^[A-Z0-9]$/.test(k) ||
      /^F([1-9]|1[0-9]|2[0-4])$/.test(k) ||
      /^num[0-9]$/.test(k) ||
      NAMED_KEYS.has(k) ||
      /^[~!@#$%^&*()\-=[\]{};:'",.<>/?\\|`_]$/.test(k);
    if (!isKey || key !== null) return null;
    key = k;
  }
  if (!key) return null;
  // 功能键可以单独用；其他键至少要一个 Shift 以外的修饰键，免得抢走普通输入
  if (!/^F\d+$/.test(key) && !mods.some((m) => m !== 'Shift')) return null;
  return [...mods, key].join('+');
}

function applyDesktopSettings(raw: unknown): { hotkeyOk: boolean } {
  const s = isRecord(raw) ? raw : {};
  closeToTray = s.closeToTray !== false;
  const wanted = typeof s.floatHotkey === 'string' ? s.floatHotkey.trim().slice(0, 60) : '';
  globalShortcut.unregisterAll();
  currentHotkey = '';
  let hotkeyOk = true;
  if (wanted) {
    const acc = normalizeAccelerator(wanted);
    if (!acc) {
      hotkeyOk = false;
    } else {
      try {
        hotkeyOk = globalShortcut.register(acc, () => toggleFloat());
      } catch {
        hotkeyOk = false;
      }
      if (hotkeyOk) currentHotkey = acc;
    }
  }
  updateTrayMenu();
  return { hotkeyOk };
}

let tray: Tray | null = null;
let trayHintShown = false;

/**
 * 托盘图标：按屏幕缩放比例提供多套位图（16/20/24/32/40/48），高分屏上不会糊。
 * 文件缺失时退回到把大图标缩小。
 */
function trayImage(): Electron.NativeImage {
  const base = process.platform === 'darwin' ? 20 : 16;
  const img = nativeImage.createEmpty();
  let added = 0;
  for (const [scale, px] of [
    [1, base],
    [1.25, 20],
    [1.5, 24],
    [2, base * 2],
    [2.5, 40],
    [3, 48],
  ] as const) {
    const file = path.join(__dirname, `tray-${px}.png`);
    if (!fs.existsSync(file)) continue;
    try {
      img.addRepresentation({ scaleFactor: scale, width: px, height: px, buffer: fs.readFileSync(file) });
      added++;
    } catch {
      /* 跳过坏文件 */
    }
  }
  if (added > 0) return img;
  const fallback = nativeImage.createFromPath(ICON_PATH);
  return fallback.isEmpty() ? fallback : fallback.resize({ width: base, height: base });
}

function createTray(): void {
  const img = trayImage();
  if (img.isEmpty()) {
    console.warn('托盘图标缺失：', ICON_PATH);
    return;
  }
  tray = new Tray(img);
  tray.setToolTip('表情包管理器');
  tray.on('click', () => showMain());
  tray.on('double-click', () => showMain());
  updateTrayMenu();
}

function updateTrayMenu(): void {
  if (!tray) return;
  const hot = currentHotkey ? `　${displayAccelerator(currentHotkey)}` : '';
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开主窗口', click: () => showMain() },
      { label: `显示 / 隐藏浮窗${hot}`, click: () => toggleFloat() },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() },
    ]),
  );
}

/** 第一次最小化到托盘时提示一下（仅 Windows 有气泡） */
function notifyTrayOnce(): void {
  if (trayHintShown || !tray || process.platform !== 'win32') return;
  trayHintShown = true;
  try {
    tray.displayBalloon({
      title: '表情包管理器仍在运行',
      content: '已最小化到托盘，快捷键仍可呼出浮窗。要退出请右键托盘图标选择“退出”。',
      iconType: 'info',
    });
  } catch {
    /* 忽略 */
  }
}

// ---------------------------------------------------------------- 窗口

/** 窗口底色：建窗口时按系统深浅色选，加载后渲染进程会按界面主题再校正一次 */
function windowBackground(): string {
  return nativeTheme.shouldUseDarkColors ? '#1b1c1f' : '#f4f4f5';
}

let mainWindow: BrowserWindow | null = null;
let floatWindow: BrowserWindow | null = null;
let closing = false;
let quitting = false;

function pageUrl(hash: string): string {
  return DEV_URL ? `${DEV_URL}${hash}` : `app://app/index.html${hash}`;
}

function webPreferences(role: 'main' | 'float'): Electron.WebPreferences {
  return {
    preload: PRELOAD,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    spellcheck: false,
    additionalArguments: [`--emoji-window-role=${role}`],
  };
}

function hardenWindow(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  if (!app.isPackaged) {
    win.webContents.on('before-input-event', (_e, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
    });
  }
}

function createMainWindow(showOnReady: boolean): BrowserWindow {
  const saved = visibleBounds(windowState.main);
  const win = new BrowserWindow({
    width: saved?.width ?? 1180,
    height: saved?.height ?? 780,
    x: saved?.x,
    y: saved?.y,
    minWidth: 720,
    minHeight: 480,
    title: '表情包管理器',
    show: false,
    autoHideMenuBar: true,
    backgroundColor: windowBackground(),
    icon: process.platform === 'darwin' ? undefined : ICON_PATH,
    webPreferences: webPreferences('main'),
  });
  mainWindow = win;
  trackBounds(win, 'main');
  hardenWindow(win);
  if (showOnReady) win.once('ready-to-show', () => win.show());

  win.on('close', (e) => {
    if (closing) return;
    // 最小化到托盘：窗口只是藏起来，快捷键和浮窗继续可用
    if (closeToTray && !quitting) {
      e.preventDefault();
      win.hide();
      notifyTrayOnce();
      return;
    }
    // 真正关闭前让渲染进程把未保存的数据写完
    e.preventDefault();
    closing = true;
    const finish = () => {
      clearTimeout(timer);
      ipcMain.removeListener('app:quit-ready', finish);
      win.destroy();
      // macOS 上 Cmd+Q 触发的关闭：窗口销毁后要继续完成退出
      if (quitting) app.quit();
    };
    const timer = setTimeout(finish, 2500);
    ipcMain.once('app:quit-ready', finish);
    win.webContents.send('app:before-quit');
  });
  win.on('closed', () => {
    mainWindow = null;
    closing = false;
    // 主窗口真正关闭（没有最小化到托盘）时退出程序；macOS 按惯例留在程序坞
    if (!quitting && process.platform !== 'darwin') app.quit();
  });

  void win.loadURL(pageUrl(''));
  if (DEV_URL && process.env.EMOJI_DEVTOOLS) win.webContents.openDevTools({ mode: 'detach' });
  return win;
}

function showMain(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow(true);
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function placeNearCorner(win: BrowserWindow): void {
  const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const { width, height } = win.getBounds();
  win.setPosition(Math.round(wa.x + wa.width - width - 16), Math.round(wa.y + wa.height - height - 16));
}

/** 桌面浮窗：无边框、置顶、不占任务栏，关闭只是隐藏 */
function createFloatWindow(): BrowserWindow {
  const saved = visibleBounds(windowState.float);
  const win = new BrowserWindow({
    width: saved?.width ?? 380,
    height: saved?.height ?? 460,
    x: saved?.x,
    y: saved?.y,
    minWidth: 280,
    minHeight: 320,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: '表情浮窗',
    backgroundColor: windowBackground(),
    icon: process.platform === 'darwin' ? undefined : ICON_PATH,
    webPreferences: webPreferences('float'),
  });
  floatWindow = win;
  win.setAlwaysOnTop(true, 'floating');
  if (process.platform === 'darwin') win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  if (!saved) placeNearCorner(win);
  trackBounds(win, 'float');
  hardenWindow(win);
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => {
    floatWindow = null;
  });
  void win.loadURL(pageUrl('#float'));
  return win;
}

function showFloat(): void {
  const win = floatWindow && !floatWindow.isDestroyed() ? floatWindow : createFloatWindow();
  const reveal = () => {
    if (win.isDestroyed()) return;
    if (!visibleBounds(win.getBounds())) placeNearCorner(win);
    win.show();
    win.focus();
    win.webContents.send('float:shown');
  };
  if (win.webContents.isLoadingMainFrame()) win.webContents.once('did-finish-load', reveal);
  else reveal();
}

function hideFloat(): void {
  if (floatWindow && !floatWindow.isDestroyed()) floatWindow.hide();
}

function toggleFloat(): void {
  if (floatWindow && !floatWindow.isDestroyed() && floatWindow.isVisible() && floatWindow.isFocused()) hideFloat();
  else showFloat();
}

// ---------------------------------------------------------------- 协议链接（网页一键导入）

let pendingDeepLink: string | null = null;

function extractDeepLink(argv: string[]): string | null {
  return argv.find((a) => typeof a === 'string' && a.toLowerCase().startsWith(`${PROTOCOL}://`)) ?? null;
}

/** 注册为 emojimanager:// 的处理程序（安装版由安装器写注册表，这里兜底；开发模式要带上脚本路径） */
function registerDeepLinkProtocol(): void {
  try {
    if (app.isPackaged) app.setAsDefaultProtocolClient(PROTOCOL);
    else if (process.platform === 'win32' && process.argv[1]) {
      app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
    }
  } catch (e) {
    console.warn('注册协议失败', e);
  }
}

/** 收到链接：存起来，通知主窗口来取（窗口还没加载完时它加载完会自己来取） */
function handleDeepLink(url: string): void {
  if (!url.toLowerCase().startsWith(`${PROTOCOL}://`) || url.length > 4096) return;
  pendingDeepLink = url;
  showMain();
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isLoadingMainFrame()) {
    mainWindow.webContents.send('deeplink');
  }
}

function setupMenu(): void {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
    return;
  }
  // macOS 需要菜单才能用 Cmd+C/V/Q 等快捷键
  const template: Electron.MenuItemConstructorOptions[] = [
    { role: 'appMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------- IPC

function registerIpc(): void {
  ipcMain.handle('fs:readText', async (_e, rel: string) => {
    try {
      return await fsp.readFile(safeJoin(rel), 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  });
  ipcMain.handle('fs:writeText', async (e, rel: string, text: string) => {
    const abs = safeJoin(rel);
    if (rel === 'library.json' && fs.existsSync(abs)) {
      await fsp.copyFile(abs, `${abs}.bak`).catch(() => undefined);
    }
    await atomicWrite(abs, text);
    // 其他窗口（浮窗）据此重新读取资料
    if (rel === 'library.json') broadcast('library:changed', undefined, e.sender);
  });
  ipcMain.handle('fs:readBytes', async (_e, rel: string) => {
    try {
      const b = await fsp.readFile(safeJoin(rel));
      return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  });
  ipcMain.handle('fs:writeBytes', async (_e, rel: string, bytes: Uint8Array) => {
    await atomicWrite(safeJoin(rel), bytes);
  });
  ipcMain.handle('fs:remove', async (_e, rel: string) => {
    await fsp.rm(safeJoin(rel), { force: true });
  });
  ipcMain.handle('fs:rename', async (_e, from: string, to: string) => {
    const target = safeJoin(to);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.rename(safeJoin(from), target);
  });
  ipcMain.handle('fs:exists', async (_e, rel: string) => fs.existsSync(safeJoin(rel)));

  ipcMain.handle('net:fetchText', async (_e, url: string, timeoutMs = 30000) => {
    assertHttpUrl(url);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await net.fetch(url, {
        signal: ac.signal,
        headers: { 'user-agent': USER_AGENT, accept: 'application/json, text/plain, */*' },
      });
      const text = await res.text();
      return { ok: res.ok, status: res.status, text, finalUrl: res.url || url };
    } catch (e) {
      throw netError(e);
    } finally {
      clearTimeout(timer);
    }
  });

  ipcMain.handle('net:download', async (_e, url: string, rel: string, timeoutMs = 60000) => {
    assertHttpUrl(url);
    const abs = safeJoin(rel);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    const tmp = `${abs}.part`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await net.fetch(url, { signal: ac.signal, headers: { 'user-agent': USER_AGENT } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (!res.body) throw new Error('服务器返回了空内容');
      let size = 0;
      const limiter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          size += chunk.length;
          if (size > MAX_DOWNLOAD) cb(new Error('文件超过 100 MB'));
          else cb(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(res.body as never), limiter, fs.createWriteStream(tmp));
      await fsp.rename(tmp, abs);
      return { size, contentType: res.headers.get('content-type') };
    } catch (e) {
      await fsp.rm(tmp, { force: true }).catch(() => undefined);
      throw netError(e);
    } finally {
      clearTimeout(timer);
    }
  });

  ipcMain.handle('net:fetchBytes', async (_e, url: string, timeoutMs = 20000) => {
    assertHttpUrl(url);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await net.fetch(url, {
        signal: ac.signal,
        headers: { 'user-agent': USER_AGENT, accept: 'image/*,*/*;q=0.8' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const declared = Number(res.headers.get('content-length') ?? 0);
      if (declared > MAX_DOWNLOAD) throw new Error('文件超过 100 MB');
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.byteLength > MAX_DOWNLOAD) throw new Error('文件超过 100 MB');
      return { bytes, contentType: res.headers.get('content-type') };
    } catch (e) {
      throw netError(e);
    } finally {
      clearTimeout(timer);
    }
  });

  // 点“粘贴”按钮时由主进程执行粘贴命令：和按 Ctrl+V 一样，页面会收到带剪贴板里图片 / 文件的 paste 事件
  ipcMain.handle('clipboard:paste', async (e) => {
    e.sender.paste();
  });
  ipcMain.handle('clipboard:copyImagePng', async (_e, png: Uint8Array) => {
    if (!(png instanceof Uint8Array) || png.byteLength < 8) throw new Error('图片数据无效');
    // Electron 45 起剪贴板 API 与浏览器的 navigator.clipboard 一致
    const blob = new Blob([png], { type: 'image/png' });
    await clipboard.write([new ClipboardItem({ 'image/png': blob })]);
  });
  ipcMain.handle('clipboard:copyFile', async (_e, rel: string) => copyFilesToClipboard([safeJoin(rel)]));
  ipcMain.handle('clipboard:copyFiles', async (_e, rels: unknown) => {
    if (!Array.isArray(rels) || rels.length === 0 || rels.length > 500) throw new Error('一次最多复制 500 个文件');
    await copyFilesToClipboard(rels.map((r) => safeJoin(String(r))));
  });
  ipcMain.handle('dialog:saveFile', async (e, name: string, bytes: Uint8Array) =>
    saveFileDialog(BrowserWindow.fromWebContents(e.sender), name, bytes),
  );
  ipcMain.handle('dialog:pickFolders', async (e) => pickFolders(BrowserWindow.fromWebContents(e.sender)));
  ipcMain.handle('fs:readPicked', async (_e, token: string, p: string) => {
    const session = typeof token === 'string' ? pickSessions.get(token) : undefined;
    if (!session || typeof p !== 'string' || !session.allowed.has(p)) throw new Error('这个文件不在刚才选择的文件夹里');
    const b = await fsp.readFile(p);
    return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  });
  ipcMain.handle('shell:revealInFolder', async (_e, rel: string) => shell.showItemInFolder(safeJoin(rel)));
  ipcMain.handle('shell:openExternal', async (_e, url: string) => {
    assertHttpUrl(url);
    await shell.openExternal(url);
  });
  ipcMain.handle('app:libraryPath', async () => libraryDir);
  ipcMain.handle('app:openLibraryDir', async () => {
    await fsp.mkdir(libraryDir, { recursive: true });
    await shell.openPath(libraryDir);
  });
  ipcMain.handle('app:relaunch', async () => {
    app.relaunch();
    app.exit(0);
  });
  ipcMain.handle('window:bg', async (e, color: unknown) => {
    if (typeof color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(color)) throw new Error('无效的颜色');
    BrowserWindow.fromWebContents(e.sender)?.setBackgroundColor(color);
  });
  ipcMain.handle('app:quit', async () => {
    app.quit();
  });
  ipcMain.handle('deeplink:take', async () => {
    const v = pendingDeepLink;
    pendingDeepLink = null;
    return v;
  });
  ipcMain.handle('app:chooseLibraryDir', async (e) => chooseLibraryDir(BrowserWindow.fromWebContents(e.sender)));

  ipcMain.handle('usage:get', async () => usage);
  ipcMain.handle('usage:record', async (_e, id: string) => recordUsage(id));

  ipcMain.handle('float:show', async () => showFloat());
  ipcMain.handle('float:hide', async () => hideFloat());
  ipcMain.handle('float:toggle', async () => toggleFloat());
  ipcMain.handle('main:show', async () => showMain());
  ipcMain.handle('settings:apply', async (_e, s: unknown) => applyDesktopSettings(s));

  // 便携版从临时目录运行，登录项会指向一个随时被清理的路径，所以只有安装版能设
  const isPortable = !!process.env.PORTABLE_EXECUTABLE_DIR;
  const loginAvailable =
    app.isPackaged && !isPortable && (process.platform === 'win32' || process.platform === 'darwin');
  ipcMain.handle('login:get', async () => ({
    enabled: loginAvailable ? app.getLoginItemSettings().openAtLogin : false,
    available: loginAvailable,
  }));
  ipcMain.handle('login:set', async (_e, on: boolean) => {
    if (!loginAvailable) throw new Error('安装版才能设置开机启动');
    app.setLoginItemSettings({ openAtLogin: !!on, args: ['--hidden'] });
  });
}

// ---------------------------------------------------------------- 生命周期

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  // 第二个实例（点了 emojimanager:// 链接或再次双击图标）：把参数交给第一个实例
  app.on('second-instance', (_e, argv) => {
    showMain();
    const link = extractDeepLink(argv);
    if (link) handleDeepLink(link);
  });
  // macOS 通过 open-url 事件收到协议链接
  app.on('open-url', (e, url) => {
    e.preventDefault();
    handleDeepLink(url);
  });

  void app.whenReady().then(async () => {
    libraryDir = resolveLibraryDir();
    await fsp.mkdir(path.join(libraryDir, 'stickers'), { recursive: true });
    loadWindowState();
    loadUsage();
    registerProtocols();
    registerIpc();
    setupMenu();
    createTray();
    registerDeepLinkProtocol();
    createMainWindow(!START_HIDDEN);
    const initial = extractDeepLink(process.argv);
    if (initial) handleDeepLink(initial);
    // 预先把浮窗建好（隐藏），快捷键一按就能立刻出现
    setTimeout(() => {
      if (!quitting && !floatWindow) createFloatWindow();
    }, 1200);
    app.on('activate', () => showMain());
  });

  app.on('before-quit', () => {
    quitting = true;
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
