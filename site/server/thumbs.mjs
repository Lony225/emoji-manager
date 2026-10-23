// 缩略图：原图按内容哈希命名，缩略图用同一个 stem 加 .webp，最长边 256；动图只取第一帧（静态）
// 首页和表情网格都只加载缩略图，点击复制 / 下载时才取原图，省服务器带宽。
import fsp from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

export const THUMB_SIZE = 256;
/** 首页分类卡片封面用的更小一档 */
export const COVER_SIZE = 128;

/** 原图文件名 → 缩略图文件名（同一个哈希 stem） */
export function thumbFile(file) {
  return `${file.replace(/\.[^.]+$/, '')}.webp`;
}

/** 原图文件名 → 封面小图文件名 */
export function coverFile(file) {
  return `${file.replace(/\.[^.]+$/, '')}.s.webp`;
}

/** 从缩略图再缩出封面小图（输入已经是 256 的 webp，很快） */
export async function makeCover(thumbPath, dest) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.tmp`;
  try {
    await sharp(await fsp.readFile(thumbPath), { failOn: 'none' })
      .resize(COVER_SIZE, COVER_SIZE, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 75, effort: 4 })
      .toFile(tmp);
    await fsp.rename(tmp, dest);
  } catch (e) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
}

/** 是否动图（gif / webp / avif 多帧）；读不出来按不是算 */
export async function probeAnimated(src) {
  try {
    const meta = await sharp(await fsp.readFile(src), { failOn: 'none' }).metadata();
    return (meta.pages ?? 1) > 1;
  } catch {
    return false;
  }
}

/**
 * 生成缩略图，返回 { animated }。
 * 不支持的格式（如 bmp）会抛错，调用方当作“没有缩略图”，前端会回退到原图。
 */
export async function makeThumb(src, dest) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  // 原图先读进内存再交给 sharp：libvips 直接打开文件会一直握着句柄，Windows 上随后就删不掉
  const input = await fsp.readFile(src);
  const image = sharp(input, { animated: false, limitInputPixels: 80e6, failOn: 'none' });
  const meta = await image.metadata();
  const animated = (meta.pages ?? 1) > 1;
  const tmp = `${dest}.${process.pid}.tmp`;
  try {
    await image
      .rotate() // 按 EXIF 方向摆正
      .resize(THUMB_SIZE, THUMB_SIZE, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80, effort: 4 })
      .toFile(tmp);
    await fsp.rename(tmp, dest);
  } catch (e) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
  return { animated };
}

/** 简单的并发上限：小服务器上同时最多生成这么多张，避免上传大包时把 CPU 占满 */
export class ThumbQueue {
  constructor(concurrency = 2) {
    this.concurrency = concurrency;
    this.running = 0;
    this.waiting = [];
  }

  run(fn) {
    return new Promise((resolve, reject) => {
      const start = () => {
        this.running++;
        Promise.resolve()
          .then(fn)
          .then(resolve, reject)
          .finally(() => {
            this.running--;
            const next = this.waiting.shift();
            if (next) next();
          });
      };
      if (this.running < this.concurrency) start();
      else this.waiting.push(start);
    });
  }
}
