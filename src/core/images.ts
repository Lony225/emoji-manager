/** 支持的图片扩展名（统一小写，jpeg 归一为 jpg） */
export const IMAGE_EXTS = ['png', 'jpg', 'gif', 'webp', 'bmp', 'avif', 'svg'] as const;
export type ImageExt = (typeof IMAGE_EXTS)[number];

const EXT_ALIAS: Record<string, ImageExt> = {
  png: 'png',
  apng: 'png',
  jpg: 'jpg',
  jpeg: 'jpg',
  jfif: 'jpg',
  gif: 'gif',
  webp: 'webp',
  bmp: 'bmp',
  avif: 'avif',
  svg: 'svg',
};

const MIME_TO_EXT: Record<string, ImageExt> = {
  'image/png': 'png',
  'image/apng': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/pjpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/x-ms-bmp': 'bmp',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
};

const EXT_TO_MIME: Record<ImageExt, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
};

/** 从文件名或 URL 路径中取扩展名 */
export function extFromName(name: string): ImageExt | null {
  const clean = name.split(/[?#]/)[0];
  const m = /\.([a-z0-9]+)$/i.exec(clean);
  if (!m) return null;
  return EXT_ALIAS[m[1].toLowerCase()] ?? null;
}

export function extFromContentType(ct: string | null | undefined): ImageExt | null {
  if (!ct) return null;
  const mime = ct.split(';')[0].trim().toLowerCase();
  return MIME_TO_EXT[mime] ?? null;
}

/** 通过文件头识别图片类型 */
export function extFromBytes(bytes: Uint8Array): ImageExt | null {
  if (bytes.length < 12) return null;
  const b = bytes;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp';
  if (b[0] === 0x42 && b[1] === 0x4d) return 'bmp';
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
    if (brand === 'avif' || brand === 'avis') return 'avif';
  }
  const head = new TextDecoder().decode(b.subarray(0, Math.min(b.length, 256))).trimStart();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'svg';
  return null;
}

export function mimeFromExt(ext: string): string {
  return EXT_TO_MIME[ext as ImageExt] ?? 'application/octet-stream';
}

/** 可能是动图的格式（复制时优先按文件复制以保留动画） */
export function maybeAnimated(ext: string): boolean {
  return ext === 'gif' || ext === 'webp' || ext === 'avif';
}

/** 去掉扩展名的文件名，用作默认表情名 */
export function fileStem(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? name;
  const clean = base.split(/[?#]/)[0];
  let decoded = clean;
  try {
    decoded = decodeURIComponent(clean);
  } catch {
    /* 保留原样 */
  }
  const idx = decoded.lastIndexOf('.');
  const stem = idx > 0 ? decoded.slice(0, idx) : decoded;
  return stem.trim() || '表情';
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const buf = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
    return Array.from(new Uint8Array(buf), (x) => x.toString(16).padStart(2, '0')).join('');
  }
  // 极少数环境没有 subtle，退化为简单散列（仅用于去重，不要求密码学强度）
  let h1 = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h1 ^= bytes[i];
    h1 = Math.imul(h1, 0x01000193) >>> 0;
  }
  return 'fnv-' + h1.toString(16) + '-' + bytes.length.toString(16);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
