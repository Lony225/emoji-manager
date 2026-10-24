/**
 * 表情制作：读入一张图（已有的表情，或刚选 / 粘贴的文件），在上面加文字，输出新图片。
 * 静态图输出 PNG；动图（GIF / 动态 WebP / APNG）用浏览器自带的 ImageDecoder 逐帧解码、逐帧加字，再用自己的编码器编成 GIF。
 */
import { GifEncoder, hasTransparentPixels } from '../core/gif';
import { extFromBytes, extFromName, fileStem, maybeAnimated, mimeFromExt, type ImageExt } from '../core/images';
import { useLibraryStore } from '../core/store';
import { drawTextOverlay, type TextStyle } from '../core/textOverlay';
import type { Sticker } from '../core/types';
import { platform } from '../platform';

export type MakerSource = { type: 'sticker'; id: string } | { type: 'file'; file: File };

export interface MakerImage {
  bytes: Uint8Array;
  ext: ImageExt;
  mime: string;
  /** 能放进 <img src> 的地址 */
  url: string;
  width: number;
  height: number;
  /** 帧数；1 表示静态图（或当前环境解不了动图） */
  frameCount: number;
  /** 默认名字的来源（表情名 / 文件名） */
  baseName: string;
  /** 来源表情（新表情继承它的分类和标签） */
  sticker?: Sticker;
  /** 释放临时资源（对象 URL） */
  release(): void;
}

/** 最大像素数：再大的图加字意义不大，逐帧处理也会很慢 */
const MAX_PIXELS = 4096 * 4096;

export function canDecodeAnimation(): boolean {
  return typeof ImageDecoder !== 'undefined';
}

export function loadImageElement(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // sticker:// 和页面不同源：不声明跨域的话画到画布上会被污染，导不出图
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片加载失败'));
    img.src = url;
  });
}

async function probeFrameCount(bytes: Uint8Array, mime: string): Promise<number> {
  if (!canDecodeAnimation()) return 1;
  try {
    if (!(await ImageDecoder.isTypeSupported(mime))) return 1;
    const dec = new ImageDecoder({ data: bytes as BufferSource, type: mime });
    try {
      // 轨道信息是异步建立的：要先等 tracks.ready，再等数据全部解析完，帧数才是最终值
      await dec.tracks.ready;
      await dec.completed;
      return dec.tracks.selectedTrack?.frameCount ?? 1;
    } finally {
      dec.close();
    }
  } catch {
    return 1;
  }
}

export async function loadMakerImage(source: MakerSource): Promise<MakerImage> {
  let bytes: Uint8Array;
  let ext: ImageExt | null;
  let url: string;
  let baseName: string;
  let sticker: Sticker | undefined;
  let release = () => {};
  if (source.type === 'sticker') {
    sticker = useLibraryStore.getState().stickers.find((s) => s.id === source.id);
    if (!sticker) throw new Error('这个表情已经不在了');
    const b = await platform.readBytes(sticker.file);
    if (!b) throw new Error('图片文件不存在');
    bytes = b;
    ext = extFromBytes(bytes) ?? extFromName(sticker.file);
    url = await platform.fileUrl(sticker.file);
    baseName = sticker.name;
  } else {
    bytes = new Uint8Array(await source.file.arrayBuffer());
    ext = extFromBytes(bytes) ?? extFromName(source.file.name);
    url = URL.createObjectURL(source.file);
    release = () => URL.revokeObjectURL(url);
    baseName = fileStem(source.file.name);
  }
  if (!ext) {
    release();
    throw new Error('不是支持的图片格式');
  }
  const mime = mimeFromExt(ext);
  let el: HTMLImageElement;
  try {
    el = await loadImageElement(url);
  } catch (e) {
    release();
    throw e;
  }
  const width = el.naturalWidth;
  const height = el.naturalHeight;
  if (!width || !height) {
    release();
    throw new Error('读不到图片尺寸');
  }
  if (width * height > MAX_PIXELS) {
    release();
    throw new Error('图片太大了（超过 4096×4096）');
  }
  // GIF / WebP / AVIF 可能是动图，PNG 可能是 APNG
  const frameCount = maybeAnimated(ext) || ext === 'png' ? await probeFrameCount(bytes, mime) : 1;
  return { bytes, ext, mime, url, width, height, frameCount, baseName, sticker, release };
}

export interface RenderResult {
  bytes: Uint8Array;
  ext: 'png' | 'gif';
  frames: number;
}

export interface RenderOptions {
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

const yieldToUi = () => new Promise<void>((r) => setTimeout(r, 0));

function makeCanvas(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('无法创建画布');
  return [canvas, ctx];
}

/** 只画文字的透明图层（原图尺寸） */
export function buildOverlay(width: number, height: number, style: TextStyle): HTMLCanvasElement {
  const [canvas, ctx] = makeCanvas(width, height);
  drawTextOverlay(ctx, width, height, style);
  return canvas;
}

function abortError(): Error {
  return new DOMException('已取消', 'AbortError');
}

/** 逐帧解码；fn 返回 true 表示提前结束。返回总帧数 */
async function eachFrame(
  img: MakerImage,
  signal: AbortSignal | undefined,
  fn: (frame: VideoFrame, index: number, total: number) => Promise<boolean | void> | boolean | void,
): Promise<number> {
  const dec = new ImageDecoder({ data: img.bytes as BufferSource, type: img.mime });
  try {
    await dec.tracks.ready;
    await dec.completed;
    const total = dec.tracks.selectedTrack?.frameCount ?? 1;
    for (let i = 0; i < total; i++) {
      if (signal?.aborted) throw abortError();
      const { image } = await dec.decode({ frameIndex: i });
      let stop: boolean | void;
      try {
        stop = await fn(image, i, total);
      } finally {
        image.close();
      }
      if (stop) return total;
    }
    return total;
  } finally {
    dec.close();
  }
}

async function renderAnimated(img: MakerImage, overlay: HTMLCanvasElement, opts: RenderOptions): Promise<RenderResult> {
  const { width: W, height: H } = img;
  const [, ctx] = makeCanvas(W, H);
  // 第一遍：有没有透明像素。GIF 的透明是 1 位的，而且帧的处理方式要在第一帧就定下来
  let transparent = false;
  await eachFrame(img, opts.signal, (frame) => {
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(frame, 0, 0, W, H);
    if (hasTransparentPixels(ctx.getImageData(0, 0, W, H).data)) {
      transparent = true;
      return true;
    }
  });
  const enc = new GifEncoder({ width: W, height: H, loop: 0, transparent });
  const total = await eachFrame(img, opts.signal, async (frame, i, n) => {
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(frame, 0, 0, W, H);
    ctx.drawImage(overlay, 0, 0);
    const delayMs = frame.duration != null ? frame.duration / 1000 : 100;
    enc.addFrame(ctx.getImageData(0, 0, W, H).data, delayMs);
    opts.onProgress?.(i + 1, n);
    await yieldToUi();
  });
  if (opts.signal?.aborted) throw abortError();
  return { bytes: enc.finish(), ext: 'gif', frames: total };
}

/** 把文字画到图上，得到新图片的字节 */
export async function renderWithText(img: MakerImage, style: TextStyle, opts: RenderOptions = {}): Promise<RenderResult> {
  const { width: W, height: H } = img;
  const overlay = buildOverlay(W, H, style);
  if (img.frameCount > 1 && canDecodeAnimation()) return renderAnimated(img, overlay, opts);
  const el = await loadImageElement(img.url);
  const [canvas, ctx] = makeCanvas(W, H);
  ctx.drawImage(el, 0, 0, W, H);
  ctx.drawImage(overlay, 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('图片编码失败');
  if (opts.signal?.aborted) throw abortError();
  return { bytes: new Uint8Array(await blob.arrayBuffer()), ext: 'png', frames: 1 };
}
