// 图片格式识别（与桌面应用保持一致）
const EXT_ALIAS = {
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

export const MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
};

export function extFromName(name) {
  const clean = String(name).split(/[?#]/)[0];
  const m = /\.([a-z0-9]+)$/i.exec(clean);
  return m ? (EXT_ALIAS[m[1].toLowerCase()] ?? null) : null;
}

/** 通过文件头识别图片类型 */
export function extFromBytes(b) {
  if (b.length < 12) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp';
  if (b[0] === 0x42 && b[1] === 0x4d) return 'bmp';
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
    if (brand === 'avif' || brand === 'avis') return 'avif';
  }
  const head = Buffer.from(b.subarray(0, Math.min(b.length, 256))).toString('utf8').trimStart();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'svg';
  return null;
}

/** 去掉扩展名的文件名，用作默认表情名 */
export function fileStem(name) {
  const base = String(name).split(/[\\/]/).pop() ?? '';
  let decoded = base;
  try {
    decoded = decodeURIComponent(base);
  } catch {
    /* 保留原样 */
  }
  const idx = decoded.lastIndexOf('.');
  const stem = idx > 0 ? decoded.slice(0, idx) : decoded;
  return stem.trim().slice(0, 80) || '表情';
}

export function normalizeTags(v) {
  if (typeof v === 'string') v = v.split(/[,，\s]+/);
  if (!Array.isArray(v)) return [];
  const out = [];
  const seen = new Set();
  for (const item of v) {
    if (typeof item !== 'string') continue;
    const t = item.trim().replace(/^#/, '').slice(0, 40);
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out.slice(0, 30);
}
