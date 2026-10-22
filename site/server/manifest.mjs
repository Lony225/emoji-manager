// 订阅清单与 zip 导出（格式与桌面应用的 docs/subscription-format.md 一致）
import fsp from 'node:fs/promises';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { extFromBytes, extFromName, normalizeTags } from './images.mjs';

function stickerEntry(s, packId) {
  return { id: s.id, url: `/images/${packId}/${s.file}`, name: s.name, tags: s.tags };
}

/** 单个表情包的清单 */
export function packManifest(store, pack) {
  return {
    name: pack.name,
    description: pack.description || undefined,
    version: new Date(pack.updatedAt).toISOString().slice(0, 10),
    tags: pack.tags,
    stickers: pack.stickers.map((s) => stickerEntry(s, pack.id)),
  };
}

/** 整站清单：多包 */
export function siteManifest(store) {
  const site = store.index.site;
  return {
    name: site.title,
    description: site.description || undefined,
    version: new Date().toISOString().slice(0, 10),
    packs: store.sortedPacks().map((p) => ({
      key: p.id,
      name: p.name,
      description: p.description || undefined,
      tags: p.tags,
      stickers: p.stickers.map((s) => stickerEntry(s, p.id)),
    })),
  };
}

function asciiSlug(s) {
  return String(s)
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 40);
}

function unique(base, used) {
  let name = base;
  let i = 2;
  while (used.has(name)) name = `${base}-${i++}`;
  used.add(name);
  return name;
}

/** 把若干表情包打成 zip（桌面应用“导入表情包压缩包”可直接读） */
export async function buildZip(store, packs, name) {
  const files = {};
  const usedFolders = new Set();
  const manifestPacks = [];
  for (const [i, p] of packs.entries()) {
    const folder = unique(asciiSlug(p.name) || `pack-${i + 1}`, usedFolders);
    const usedFiles = new Set();
    const stickers = [];
    for (const [j, s] of p.stickers.entries()) {
      let bytes;
      try {
        bytes = await fsp.readFile(store.imagePath(p.id, s.file));
      } catch {
        continue;
      }
      const file = `${unique(asciiSlug(s.name) || `sticker-${j + 1}`, usedFiles)}.${s.ext}`;
      const rel = `images/${folder}/${file}`;
      files[rel] = [new Uint8Array(bytes), { level: 0 }];
      stickers.push({ id: s.id, url: rel, name: s.name, tags: s.tags });
    }
    manifestPacks.push({ key: p.id, name: p.name, description: p.description || undefined, tags: p.tags, stickers });
  }
  const manifest = {
    name,
    version: new Date().toISOString().slice(0, 10),
    generator: 'Emoji Site',
    packs: manifestPacks,
  };
  files['manifest.json'] = [strToU8(JSON.stringify(manifest, null, 2)), { level: 6 }];
  return Buffer.from(zipSync(files));
}

function isRecord(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 读取桌面应用导出的 zip（或任何符合订阅格式的 zip）。
 * 返回 [{ name, description, tags, stickers: [{ fileName, bytes, name, tags }] }]
 */
export function readZip(bytes) {
  let entries;
  try {
    entries = unzipSync(new Uint8Array(bytes));
  } catch {
    throw Object.assign(new Error('这不是有效的 zip 压缩包'), { statusCode: 400 });
  }
  const names = Object.keys(entries);
  const manifestPath = names
    .filter((n) => /(^|\/)manifest\.json$/i.test(n) && !/(^|\/)__MACOSX\//.test(n) && !/(^|\/)\._/.test(n))
    .sort((a, b) => a.split('/').length - b.split('/').length || a.length - b.length)[0];
  if (!manifestPath) throw Object.assign(new Error('压缩包里没有 manifest.json'), { statusCode: 400 });
  const dir = manifestPath.slice(0, manifestPath.length - 'manifest.json'.length);
  let manifest;
  try {
    manifest = JSON.parse(strFromU8(entries[manifestPath]).replace(/^﻿/, ''));
  } catch {
    throw Object.assign(new Error('manifest.json 不是有效的 JSON'), { statusCode: 400 });
  }
  if (!isRecord(manifest)) throw Object.assign(new Error('manifest.json 格式不正确'), { statusCode: 400 });

  const lookup = (url) => {
    if (typeof url !== 'string' || /^[a-z]+:/i.test(url)) return null;
    let p = url.replace(/^\.\//, '').replace(/^\/+/, '');
    try {
      p = decodeURIComponent(p);
    } catch {
      /* ignore */
    }
    for (const t of [dir + p, p]) {
      const b = entries[t];
      if (b && b.length > 0) return { path: t, bytes: b };
    }
    return null;
  };

  const parsePack = (raw, fallbackName) => {
    const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 80) : fallbackName;
    const packTags = normalizeTags(raw.tags);
    const stickers = [];
    let missing = 0;
    for (const item of Array.isArray(raw.stickers) ? raw.stickers : []) {
      const obj = typeof item === 'string' ? { url: item } : isRecord(item) ? item : null;
      if (!obj) continue;
      const hit = lookup(obj.url ?? obj.src ?? obj.image);
      if (!hit) {
        missing++;
        continue;
      }
      const fileName = hit.path.split('/').pop() ?? 'sticker';
      if (!(extFromBytes(hit.bytes) ?? extFromName(fileName))) continue;
      stickers.push({
        fileName,
        bytes: Buffer.from(hit.bytes),
        name: typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim().slice(0, 80) : undefined,
        tags: [...packTags, ...normalizeTags(obj.tags)],
      });
    }
    return {
      name,
      description: typeof raw.description === 'string' ? raw.description.slice(0, 300) : '',
      tags: packTags,
      group: typeof raw.group === 'string' ? raw.group.trim() : '',
      stickers,
      missing,
    };
  };

  const rootName = typeof manifest.name === 'string' && manifest.name.trim() ? manifest.name.trim().slice(0, 80) : '导入的表情包';
  const packs = [];
  if (Array.isArray(manifest.stickers) && manifest.stickers.length) packs.push(parsePack(manifest, rootName));
  if (Array.isArray(manifest.packs)) {
    manifest.packs.forEach((p, i) => {
      if (isRecord(p) && Array.isArray(p.stickers)) packs.push(parsePack(p, `${rootName} ${i + 1}`));
    });
  }
  if (packs.length === 0) throw Object.assign(new Error('压缩包里没有任何表情'), { statusCode: 400 });
  return packs;
}
