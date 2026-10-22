/**
 * 订阅清单（manifest）解析与规范化。
 *
 * 一个订阅地址指向一个 JSON 文件，最简形式：
 * {
 *   "name": "猫猫表情包",
 *   "stickers": [ "images/1.gif", { "url": "images/2.png", "name": "开心", "tags": ["猫"] } ]
 * }
 * 也可以用 "packs" 把多个包放在一个订阅里（见 docs/subscription-format.md）。
 */

export interface RemoteSticker {
  remoteId: string;
  url: string;
  name: string;
  tags: string[];
}

export interface RemotePack {
  key: string;
  name: string;
  description?: string;
  /** 所属的分组名（导出的压缩包用它还原两级分类；作为订阅使用时忽略） */
  group?: string;
  tags: string[];
  stickers: RemoteSticker[];
}

export interface PackRef {
  key: string;
  url: string;
}

export interface RemoteManifest {
  name: string;
  description?: string;
  homepage?: string;
  version?: string;
  /** 清单内直接给出的包（含根级 stickers） */
  packs: RemotePack[];
  /** 需要再去下载的子包 */
  packRefs: PackRef[];
}

export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManifestError';
  }
}

const MAX_PACKS = 200;
const MAX_STICKERS_PER_PACK = 10000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function optString(v: unknown): string | undefined {
  if (typeof v === 'string') {
    const s = v.trim();
    return s ? s : undefined;
  }
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

export function normalizeTags(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of v) {
    if (typeof item !== 'string') continue;
    const t = item.trim().replace(/^#/, '').slice(0, 40);
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

export function resolveUrl(url: string, baseUrl: string): string {
  let resolved: URL;
  try {
    resolved = new URL(url, baseUrl);
  } catch {
    throw new ManifestError(`无效的图片地址：${url}`);
  }
  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
    throw new ManifestError(`不支持的图片地址协议：${resolved.protocol}`);
  }
  return resolved.href;
}

function nameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop() ?? '';
    let decoded = last;
    try {
      decoded = decodeURIComponent(last);
    } catch {
      /* ignore */
    }
    const idx = decoded.lastIndexOf('.');
    const stem = idx > 0 ? decoded.slice(0, idx) : decoded;
    return stem || u.hostname;
  } catch {
    return '表情';
  }
}

function parseSticker(raw: unknown, baseUrl: string, index: number): RemoteSticker {
  if (typeof raw === 'string') {
    const url = resolveUrl(raw, baseUrl);
    return { remoteId: url, url, name: nameFromUrl(url), tags: [] };
  }
  if (!isRecord(raw)) throw new ManifestError(`第 ${index + 1} 个表情格式不正确`);
  const rawUrl = optString(raw.url) ?? optString(raw.src) ?? optString(raw.image);
  if (!rawUrl) throw new ManifestError(`第 ${index + 1} 个表情缺少 url`);
  const url = resolveUrl(rawUrl, baseUrl);
  const remoteId = optString(raw.id) ?? url;
  const name = (optString(raw.name) ?? optString(raw.title) ?? nameFromUrl(url)).slice(0, 80);
  return { remoteId, url, name, tags: normalizeTags(raw.tags) };
}

function parseStickers(raw: unknown, baseUrl: string, where: string): RemoteSticker[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new ManifestError(`${where} 的 stickers 必须是数组`);
  if (raw.length > MAX_STICKERS_PER_PACK) throw new ManifestError(`${where} 的表情数量超过上限（${MAX_STICKERS_PER_PACK}）`);
  const out: RemoteSticker[] = [];
  const seen = new Set<string>();
  raw.forEach((item, i) => {
    const s = parseSticker(item, baseUrl, i);
    if (seen.has(s.remoteId)) return; // 同一包内重复 id 只取第一个
    seen.add(s.remoteId);
    out.push(s);
  });
  return out;
}

function slug(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[\s/\\?#%:]+/g, '-')
    .slice(0, 60);
}

/**
 * 解析一个「包」对象（根清单本身也是一个包）。
 */
export function parsePack(raw: unknown, baseUrl: string, key: string, fallbackName: string): RemotePack {
  if (!isRecord(raw)) throw new ManifestError('订阅内容不是有效的 JSON 对象');
  const name = (optString(raw.name) ?? optString(raw.title) ?? fallbackName).slice(0, 80);
  return {
    key,
    name,
    description: optString(raw.description),
    group: optString(raw.group)?.slice(0, 80),
    tags: normalizeTags(raw.tags),
    stickers: parseStickers(raw.stickers, baseUrl, `“${name}”`),
  };
}

export function parseManifestText(text: string, baseUrl: string): RemoteManifest {
  let json: unknown;
  try {
    json = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    throw new ManifestError('订阅内容不是有效的 JSON（请确认地址指向的是清单文件本身）');
  }
  return parseManifest(json, baseUrl);
}

export function parseManifest(json: unknown, baseUrl: string): RemoteManifest {
  if (!isRecord(json)) throw new ManifestError('订阅内容不是有效的 JSON 对象');

  const fallbackName = (() => {
    try {
      const u = new URL(baseUrl);
      const last = u.pathname.split('/').filter(Boolean).pop();
      return last && last !== 'index.json' ? last.replace(/\.json$/i, '') : u.hostname;
    } catch {
      return '订阅';
    }
  })();

  const name = (optString(json.name) ?? optString(json.title) ?? fallbackName).slice(0, 80);
  const packs: RemotePack[] = [];
  const packRefs: PackRef[] = [];

  const rootStickers = parseStickers(json.stickers, baseUrl, `“${name}”`);
  if (rootStickers.length > 0) {
    packs.push({
      key: 'root',
      name,
      description: optString(json.description),
      tags: normalizeTags(json.tags),
      stickers: rootStickers,
    });
  }

  if (json.packs !== undefined) {
    if (!Array.isArray(json.packs)) throw new ManifestError('packs 必须是数组');
    if (json.packs.length > MAX_PACKS) throw new ManifestError(`包的数量超过上限（${MAX_PACKS}）`);
    const usedKeys = new Set<string>(['root']);
    json.packs.forEach((p, i) => {
      if (!isRecord(p)) throw new ManifestError(`第 ${i + 1} 个包格式不正确`);
      const refUrl = optString(p.url);
      const explicitKey = optString(p.key) ?? optString(p.id);
      if (refUrl && p.stickers === undefined) {
        const url = resolveUrl(refUrl, baseUrl);
        let key = explicitKey ?? url;
        while (usedKeys.has(key)) key += '_';
        usedKeys.add(key);
        packRefs.push({ key, url });
        return;
      }
      const pname = optString(p.name) ?? optString(p.title);
      let key = (explicitKey ?? (pname ? slug(pname) : '')) || `pack-${i + 1}`;
      while (usedKeys.has(key)) key += '_';
      usedKeys.add(key);
      packs.push(parsePack(p, baseUrl, key, pname ?? `${name} ${i + 1}`));
    });
  }

  if (packs.length === 0 && packRefs.length === 0) {
    throw new ManifestError('订阅中没有找到任何表情（需要 stickers 或 packs 字段）');
  }

  return {
    name,
    description: optString(json.description),
    homepage: optString(json.homepage) ?? optString(json.url),
    version: optString(json.version),
    packs,
    packRefs,
  };
}
