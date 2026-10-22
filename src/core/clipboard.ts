import { platform } from '../platform';
import { maybeAnimated } from './images';
import type { CopyMode, Sticker } from './types';

/** 把图片地址渲染成 PNG 字节（动图取当前帧），用于复制到剪贴板 */
export async function renderPng(url: string): Promise<Uint8Array> {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('图片加载失败'));
    img.src = url;
  });
  const w = img.naturalWidth || 256;
  const h = img.naturalHeight || 256;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建画布');
  ctx.drawImage(img, 0, 0, w, h);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('图片转换失败');
  return new Uint8Array(await blob.arrayBuffer());
}

export type EffectiveCopy = 'file' | 'image';

/** 根据设置和平台能力决定实际的复制方式 */
export function resolveCopyMode(sticker: Sticker, mode: CopyMode): EffectiveCopy {
  const caps = platform.capabilities;
  if (mode === 'file') return caps.copyFile ? 'file' : 'image';
  if (mode === 'image') return 'image';
  return caps.copyFile && maybeAnimated(sticker.ext) ? 'file' : 'image';
}

/** 复制表情；返回实际使用的方式 */
export async function copySticker(sticker: Sticker, mode: CopyMode): Promise<EffectiveCopy> {
  const effective = resolveCopyMode(sticker, mode);
  if (effective === 'file') {
    await platform.copyFile(sticker.file);
    return 'file';
  }
  if (!platform.capabilities.copyImage) throw new Error('当前环境不支持复制图片');
  const png = await renderPng(await platform.fileUrl(sticker.file));
  await platform.copyImagePng(png);
  return 'image';
}

/**
 * 批量复制：剪贴板一次只能放一张图片，所以多个表情一律按文件复制，
 * 粘贴到聊天软件时会作为多个文件 / 图片发送。
 */
export async function copyStickers(stickers: Sticker[], mode: CopyMode): Promise<EffectiveCopy> {
  if (stickers.length === 1) return copySticker(stickers[0], mode);
  if (stickers.length === 0) throw new Error('没有选中表情');
  if (!platform.capabilities.copyFile) throw new Error('当前环境不支持批量复制，请改用导出');
  await platform.copyFiles(stickers.map((s) => s.file));
  return 'file';
}
