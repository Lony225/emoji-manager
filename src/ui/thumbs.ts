/**
 * 网格缩略图：动图取第一帧、大图缩小成最长边 192px 的 webp，存在 thumbs/ 目录。
 * 几百张原尺寸 GIF 一起解码会卡；网格平时只显示缩略图，悬停或需要播放时才用原图。
 * 生成在主窗口后台慢慢做（并发 2），做好一张记一张，重启后不用重做。
 */
import { useLibraryStore } from '../core/store';
import { maybeAnimated } from '../core/images';
import type { Sticker } from '../core/types';
import { platform } from '../platform';

const MAX_SIDE = 192;
const CONCURRENCY = 2;
/** 静态图小于这个体积且不超过缩略图尺寸时，直接用原图，不另存缩略图 */
const SMALL_STATIC_BYTES = 60 * 1024;

const queue: string[] = [];
const queued = new Set<string>();
const failed = new Set<string>();
let running = 0;
let sweepTimer: ReturnType<typeof setTimeout> | null = null;

/** 这张表情需不需要缩略图 */
export function needsThumb(s: Sticker): boolean {
  if (s.thumb) return false;
  if (s.ext === 'svg') return false;
  if (maybeAnimated(s.ext)) return true;
  return s.size > SMALL_STATIC_BYTES;
}

function canGenerate(): boolean {
  return platform.windowRole === 'main' && typeof document !== 'undefined';
}

/** 优先生成某一张（网格里正在显示的） */
export function requestThumb(id: string): void {
  if (!canGenerate() || queued.has(id) || failed.has(id)) return;
  queued.add(id);
  queue.unshift(id);
  pump();
}

/** 把所有还没有缩略图的表情排到队尾，空闲时慢慢做 */
export function scheduleThumbSweep(delayMs = 2000): void {
  if (!canGenerate()) return;
  if (sweepTimer) clearTimeout(sweepTimer);
  sweepTimer = setTimeout(() => {
    sweepTimer = null;
    for (const s of useLibraryStore.getState().stickers) {
      if (needsThumb(s) && !queued.has(s.id) && !failed.has(s.id)) {
        queued.add(s.id);
        queue.push(s.id);
      }
    }
    pump();
  }, delayMs);
}

function pump(): void {
  while (running < CONCURRENCY && queue.length > 0) {
    const id = queue.shift()!;
    running++;
    void generate(id)
      .catch(() => failed.add(id))
      .finally(() => {
        queued.delete(id);
        running--;
        pump();
      });
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片加载失败'));
    img.src = url;
  });
}

async function generate(id: string): Promise<void> {
  const s = useLibraryStore.getState().stickers.find((x) => x.id === id);
  if (!s || !needsThumb(s)) return;
  const img = await loadImage(await platform.fileUrl(s.file));
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (!w || !h) throw new Error('图片尺寸无效');
  // 静态小图不需要缩略图：标记一下免得反复检查（用原图路径占位不合适，这里直接跳过并记入 failed 集合）
  if (!maybeAnimated(s.ext) && Math.max(w, h) <= MAX_SIDE) {
    failed.add(id);
    return;
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建画布');
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', 0.82));
  if (!blob) throw new Error('缩略图编码失败');
  const rel = `thumbs/${id}-${Date.now().toString(36)}.webp`;
  await platform.writeBytes(rel, new Uint8Array(await blob.arrayBuffer()));
  // 生成期间表情可能已被删除
  const still = useLibraryStore.getState().stickers.find((x) => x.id === id);
  if (!still) {
    await platform.remove(rel).catch(() => undefined);
    return;
  }
  if (still.thumb) await platform.remove(still.thumb).catch(() => undefined);
  useLibraryStore.getState().setThumb(id, rel);
}

/** 主窗口启动后调用一次：资料加载完和每次表情列表变化后都安排一轮后台生成 */
export function installThumbWorker(): void {
  if (!canGenerate()) return;
  scheduleThumbSweep(3000);
  let lastStickers = useLibraryStore.getState().stickers;
  useLibraryStore.subscribe((s) => {
    if (s.stickers !== lastStickers) {
      lastStickers = s.stickers;
      scheduleThumbSweep(1500);
    }
  });
}
