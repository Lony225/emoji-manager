/**
 * 模板表情（@memecrafters/meme-generator）的主进程这一侧：
 * - 管理工具进程的生命周期（按需启动、空闲退出、崩溃后重启）
 * - 按需下载素材：字体一次性下载（约 77 MB），每个模板的图片用到时再下载，都校验 sha256
 * - 预览图缓存在磁盘上，第二次打开不用重新生成
 * 原生模块和素材都放在 userData/meme-generator 下，不进资料目录（那是用户的表情库，可能在同步盘上）。
 */
import { app, ipcMain, net, utilityProcess, type UtilityProcess } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { MemeImageInput, MemeOptionValues, MemeProgress, MemeResult, MemeStatus, MemeTemplate } from '../src/platform/types';
import type { WorkerError, WorkerReply, WorkerRequest } from './meme-worker';

const WORKER_FILE = path.join(__dirname, 'meme-worker.mjs');
const IDLE_EXIT_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 180_000;
const MANIFEST_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ASSET_BYTES = 100 * 1024 * 1024;
const DOWNLOAD_CONCURRENCY = 4;
const USER_AGENT = `EmojiManager/${app.getVersion()}`;

interface ManifestEntry {
  file: string;
  hash: string;
}
interface Manifest {
  fonts: ManifestEntry[];
  images: ManifestEntry[];
}
interface CachedManifest {
  version: string;
  fetchedAt: number;
  manifest: Manifest;
}

class MemeFailure extends Error {
  constructor(readonly detail: WorkerError) {
    super(detail.message);
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function memeHome(): string {
  return path.join(app.getPath('userData'), 'meme-generator');
}
const fontsDir = () => path.join(memeHome(), 'resources', 'fonts');
const imagesDir = () => path.join(memeHome(), 'resources', 'images');

/** 各平台的原生库：打包后由 electron-builder 放到 resources/meme/，开发时在 dist-electron/meme-native/<os>-<arch>/ */
function nativeLibraryPath(): string {
  const os = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux';
  return app.isPackaged
    ? path.join(process.resourcesPath, 'meme', 'meme-generator.node')
    : path.join(__dirname, 'meme-native', `${os}-${process.arch}`, 'meme-generator.node');
}

function isAvailable(): boolean {
  return fs.existsSync(nativeLibraryPath()) && fs.existsSync(WORKER_FILE);
}

/** 素材地址：默认 jsDelivr 上该版本的 resources/；测试时用环境变量指向本地服务器 */
function resourcesRoot(version: string): string {
  return process.env.EMOJI_MEME_RESOURCES_ROOT || `https://cdn.jsdelivr.net/gh/MemeCrafters/meme-generator-rs@v${version}/resources/`;
}

// ---------------------------------------------------------------- 工具进程

let child: UtilityProcess | null = null;
let seq = 0;
interface PendingRequest {
  /** 发给哪个进程：旧进程退出时只能让它自己的请求失败，不能连累刚启动的新进程 */
  proc: UtilityProcess;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}
const pending = new Map<number, PendingRequest>();
let idleTimer: NodeJS.Timeout | null = null;
let initPromise: Promise<{ version: string; count: number }> | null = null;
/** 工具进程启动时本地字体的数量：字体只在进程里扫描一次，下载完新字体后要重启它才认 */
let fontsAtStart = -1;
let progressSink: ((p: MemeProgress) => void) | null = null;

function touchIdle(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (pending.size === 0) stopWorker();
  }, IDLE_EXIT_MS);
}

function failPendingFor(proc: UtilityProcess, message: string): void {
  for (const [id, p] of pending) {
    if (p.proc !== proc) continue;
    clearTimeout(p.timer);
    p.reject(new Error(message));
    pending.delete(id);
  }
}

export function stopWorker(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  const proc = child;
  child = null;
  initPromise = null;
  if (proc) {
    failPendingFor(proc, '模板引擎已停止');
    proc.kill();
  }
}

function spawnWorker(): UtilityProcess {
  const proc = utilityProcess.fork(WORKER_FILE, [], {
    serviceName: 'meme-generator',
    env: { ...process.env, MEME_HOME: memeHome() },
  });
  proc.on('message', (msg: WorkerReply) => {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new MemeFailure(msg.error ?? { code: 'Error', message: '未知错误' }));
    touchIdle();
  });
  proc.on('exit', (code) => {
    if (child === proc) {
      child = null;
      initPromise = null;
    }
    failPendingFor(proc, `模板引擎意外退出（代码 ${code}）`);
  });
  return proc;
}

function request<T>(req: Omit<WorkerRequest, 'id'>): Promise<T> {
  const proc = child;
  if (!proc) return Promise.reject(new Error('模板引擎没有运行'));
  const id = ++seq;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('生成超时'));
    }, REQUEST_TIMEOUT_MS);
    pending.set(id, { proc, resolve: resolve as (v: unknown) => void, reject, timer });
    proc.postMessage({ id, ...req } satisfies WorkerRequest);
  });
}

/** 正在启动中的那一次（对话框打开时状态和列表会同时来要，只能起一个进程） */
let starting: Promise<{ version: string; count: number }> | null = null;

async function ensureWorker(): Promise<{ version: string; count: number }> {
  if (!isAvailable()) throw new Error('当前平台没有可用的模板引擎');
  if (child && initPromise) return initPromise;
  if (!starting) {
    starting = (async () => {
      await fsp.mkdir(fontsDir(), { recursive: true });
      await fsp.mkdir(imagesDir(), { recursive: true });
      fontsAtStart = countFiles(fontsDir());
      child = spawnWorker();
      touchIdle();
      initPromise = request<{ version: string; count: number }>({ type: 'init', nativePath: nativeLibraryPath() }).catch((e) => {
        stopWorker();
        throw new Error(`模板引擎启动失败：${errorMessage(e)}`);
      });
      return initPromise;
    })().finally(() => {
      starting = null;
    });
  }
  return starting;
}

function countFiles(dir: string): number {
  try {
    return fs.readdirSync(dir).filter((f) => !f.endsWith('.part')).length;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------- 素材清单与下载

let manifestCache: CachedManifest | null = null;

function manifestFile(): string {
  return path.join(memeHome(), 'resources.json');
}

function isManifest(v: unknown): v is Manifest {
  if (!v || typeof v !== 'object') return false;
  const m = v as Partial<Manifest>;
  const okList = (l: unknown) => Array.isArray(l) && l.every((e) => e && typeof e.file === 'string' && typeof e.hash === 'string');
  return okList(m.fonts) && okList(m.images);
}

async function loadManifest(version: string, force = false): Promise<Manifest> {
  if (!manifestCache) {
    try {
      const j = JSON.parse(await fsp.readFile(manifestFile(), 'utf8')) as CachedManifest;
      if (j && typeof j.version === 'string' && isManifest(j.manifest)) manifestCache = j;
    } catch {
      /* 没有缓存 */
    }
  }
  const fresh = manifestCache && manifestCache.version === version && Date.now() - manifestCache.fetchedAt < MANIFEST_MAX_AGE_MS;
  if (fresh && !force) return manifestCache!.manifest;
  try {
    const res = await net.fetch(resourcesRoot(version) + 'resources.json', { headers: { 'user-agent': USER_AGENT } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const manifest = (await res.json()) as unknown;
    if (!isManifest(manifest)) throw new Error('清单格式不对');
    manifestCache = { version, fetchedAt: Date.now(), manifest };
    await fsp.mkdir(memeHome(), { recursive: true });
    await fsp.writeFile(manifestFile(), JSON.stringify(manifestCache));
    return manifest;
  } catch (e) {
    // 离线时用旧清单也能继续（已经下载过的素材照常可用）
    if (manifestCache) return manifestCache.manifest;
    throw new Error(`无法获取素材清单：${errorMessage(e)}`);
  }
}

function safeAssetPath(root: string, rel: string): string {
  const abs = path.resolve(root, rel);
  if (!abs.startsWith(root + path.sep)) throw new Error(`素材路径非法：${rel}`);
  return abs;
}

/** 正在下载的文件（按目标路径）：预览和生成可能同时要同一个模板的素材，不能各下各的再互相抢 .part 文件 */
const inflight = new Map<string, Promise<void>>();

function downloadFile(url: string, dest: string, sha256: string): Promise<void> {
  const running = inflight.get(dest);
  if (running) return running;
  const p = doDownload(url, dest, sha256).finally(() => inflight.delete(dest));
  inflight.set(dest, p);
  return p;
}

async function doDownload(url: string, dest: string, sha256: string): Promise<void> {
  if (fs.existsSync(dest)) return;
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  try {
    const res = await net.fetch(url, { headers: { 'user-agent': USER_AGENT } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (!res.body) throw new Error('空响应');
    const hash = crypto.createHash('sha256');
    let size = 0;
    const tap = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length;
        if (size > MAX_ASSET_BYTES) cb(new Error('文件超过 100 MB'));
        else {
          hash.update(chunk);
          cb(null, chunk);
        }
      },
    });
    await pipeline(Readable.fromWeb(res.body as never), tap, fs.createWriteStream(tmp));
    if (hash.digest('hex') !== sha256.toLowerCase()) throw new Error('文件校验失败');
    await fsp.rename(tmp, dest);
  } catch (e) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    throw new Error(`下载 ${path.basename(dest)} 失败：${errorMessage(e)}`);
  }
}

async function downloadMany(
  jobs: { url: string; dest: string; hash: string }[],
  onDone: (done: number, total: number, file: string) => void,
): Promise<void> {
  let next = 0;
  let done = 0;
  const errors: string[] = [];
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      try {
        await downloadFile(job.url, job.dest, job.hash);
      } catch (e) {
        errors.push(errorMessage(e));
      }
      done++;
      onDone(done, jobs.length, path.basename(job.dest));
    }
  };
  await Promise.all(Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, jobs.length) }, worker));
  if (errors.length) throw new Error(errors.length === 1 ? errors[0] : `${errors[0]}（共 ${errors.length} 个文件失败）`);
}

function report(p: MemeProgress): void {
  progressSink?.(p);
}

let fontsDownload: Promise<void> | null = null;

/** 下载清单里缺的字体；下载完如果工具进程已经在跑，重启它让新字体生效 */
async function downloadFonts(): Promise<void> {
  if (fontsDownload) return fontsDownload;
  fontsDownload = (async () => {
    const { version } = await ensureWorker();
    const manifest = await loadManifest(version);
    const root = resourcesRoot(version);
    const dir = fontsDir();
    const jobs = manifest.fonts
      .filter((f) => !fs.existsSync(safeAssetPath(dir, f.file)))
      .map((f) => ({ url: `${root}fonts/${f.file}`, dest: safeAssetPath(dir, f.file), hash: f.hash }));
    report({ kind: 'fonts', done: 0, total: jobs.length });
    if (jobs.length) {
      await downloadMany(jobs, (done, total, file) => report({ kind: 'fonts', done, total, file }));
    }
    if (child && fontsAtStart !== countFiles(dir)) stopWorker();
  })().finally(() => {
    fontsDownload = null;
  });
  return fontsDownload;
}

/** 某个模板的图片素材（清单里以 key/ 开头的文件），缺的下载下来 */
async function ensureImagesFor(key: string, manifest: Manifest, version: string): Promise<void> {
  const root = resourcesRoot(version);
  const dir = imagesDir();
  const jobs = manifest.images
    .filter((i) => i.file.startsWith(`${key}/`) && !fs.existsSync(safeAssetPath(dir, i.file)))
    .map((i) => ({ url: `${root}images/${i.file}`, dest: safeAssetPath(dir, i.file), hash: i.hash }));
  if (jobs.length === 0) return;
  report({ kind: 'images', key, done: 0, total: jobs.length });
  await downloadMany(jobs, (done, total, file) => report({ kind: 'images', key, done, total, file }));
}

/** 生成时报“缺少素材”（有的模板会用别的目录的图）：按路径补下载再试 */
async function withAssetRetry<T>(manifest: Manifest, version: string, fn: () => Promise<T>): Promise<T> {
  const tried = new Set<string>();
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      const missing = e instanceof MemeFailure && e.detail.code === 'ImageAssetMissing' ? String(e.detail.data?.path ?? '') : '';
      const entry = missing && !tried.has(missing) ? manifest.images.find((i) => i.file === missing) : undefined;
      if (!entry || tried.size >= 8) throw e;
      tried.add(missing);
      const dir = imagesDir();
      report({ kind: 'images', done: 0, total: 1, file: entry.file });
      await downloadFile(`${resourcesRoot(version)}images/${entry.file}`, safeAssetPath(dir, entry.file), entry.hash);
      report({ kind: 'images', done: 1, total: 1, file: entry.file });
    }
  }
}

function extOf(bytes: Uint8Array): string {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'png';
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return 'gif';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpg';
  if (bytes[0] === 0x52 && bytes[8] === 0x57) return 'webp';
  return 'png';
}

// ---------------------------------------------------------------- 对外操作

async function status(): Promise<MemeStatus> {
  const base: MemeStatus = { available: false, version: '', templates: 0, fontsTotal: 0, fontsReady: 0, downloading: !!fontsDownload };
  if (!isAvailable()) return { ...base, error: '当前平台没有可用的模板引擎' };
  let version: string;
  try {
    const init = await ensureWorker();
    version = init.version;
    base.available = true;
    base.version = version;
    base.templates = init.count;
  } catch (e) {
    return { ...base, error: errorMessage(e) };
  }
  try {
    const manifest = await loadManifest(version);
    const dir = fontsDir();
    base.fontsTotal = manifest.fonts.length;
    base.fontsReady = manifest.fonts.filter((f) => fs.existsSync(safeAssetPath(dir, f.file))).length;
  } catch (e) {
    base.error = errorMessage(e);
  }
  return base;
}

async function list(): Promise<MemeTemplate[]> {
  await ensureWorker();
  return request<MemeTemplate[]>({ type: 'list' });
}

async function preview(key: string, options?: MemeOptionValues): Promise<MemeResult> {
  const { version } = await ensureWorker();
  const custom = !!options && Object.keys(options).length > 0;
  const cacheDir = path.join(memeHome(), 'previews', version);
  if (!custom) {
    for (const ext of ['png', 'gif', 'jpg', 'webp']) {
      const f = path.join(cacheDir, `${key}.${ext}`);
      if (fs.existsSync(f)) return { bytes: new Uint8Array(await fsp.readFile(f)), ext };
    }
  }
  const manifest = await loadManifest(version);
  await ensureImagesFor(key, manifest, version);
  const { bytes } = await withAssetRetry(manifest, version, () => request<{ bytes: Uint8Array }>({ type: 'preview', key, options }));
  const ext = extOf(bytes);
  if (!custom) {
    await fsp.mkdir(cacheDir, { recursive: true });
    await fsp.writeFile(path.join(cacheDir, `${key}.${ext}`), bytes).catch(() => undefined);
  }
  return { bytes, ext };
}

async function generate(key: string, images: MemeImageInput[], texts: string[], options: MemeOptionValues): Promise<MemeResult> {
  const { version } = await ensureWorker();
  const manifest = await loadManifest(version);
  await ensureImagesFor(key, manifest, version);
  const { bytes } = await withAssetRetry(manifest, version, () => request<{ bytes: Uint8Array }>({ type: 'generate', key, images, texts, options }));
  return { bytes, ext: extOf(bytes) };
}

function assertKey(key: unknown): string {
  if (typeof key !== 'string' || !/^[a-z0-9_]{1,64}$/i.test(key)) throw new Error('模板标识无效');
  return key;
}

function assertOptions(v: unknown): MemeOptionValues {
  const out: MemeOptionValues = {};
  if (!v || typeof v !== 'object') return out;
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (k.length > 64) continue;
    if (typeof val === 'boolean' || typeof val === 'number' || (typeof val === 'string' && val.length <= 500)) out[k] = val;
  }
  return out;
}

export function registerMemeIpc(broadcast: (channel: string, payload: unknown) => void): void {
  progressSink = (p) => broadcast('memes:progress', p);
  ipcMain.handle('memes:status', () => status());
  ipcMain.handle('memes:list', () => list());
  ipcMain.handle('memes:downloadFonts', () => downloadFonts());
  ipcMain.handle('memes:preview', (_e, key: unknown, options: unknown) => preview(assertKey(key), assertOptions(options)));
  ipcMain.handle('memes:generate', (_e, key: unknown, images: unknown, texts: unknown, options: unknown) => {
    if (!Array.isArray(images) || images.length > 10) throw new Error('图片数量不对');
    const imgs: MemeImageInput[] = images.map((img: { name?: unknown; data?: unknown }) => {
      if (!(img?.data instanceof Uint8Array) || img.data.byteLength > 20 * 1024 * 1024) throw new Error('图片数据无效');
      return { name: typeof img.name === 'string' ? img.name.slice(0, 80) : '', data: img.data };
    });
    if (!Array.isArray(texts) || texts.length > 20) throw new Error('文字数量不对');
    const txts = texts.map((t) => (typeof t === 'string' ? t.slice(0, 2000) : ''));
    return generate(assertKey(key), imgs, txts, assertOptions(options));
  });
}
