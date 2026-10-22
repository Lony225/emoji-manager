// 订阅清单与 zip 导出 / 导入（格式与桌面应用的 docs/subscription-format.md 一致）
// zip 的读写都是流式的：大包也不会把整个压缩包放进内存。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { Unzip, UnzipInflate, Zip, ZipPassThrough, ZipDeflate, strFromU8, strToU8 } from 'fflate';
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

/**
 * 把若干表情包打成 zip，以流的形式返回（桌面应用“导入表情包压缩包”可直接读）。
 * 图片逐个从磁盘读，内存里只有当前这一张。
 */
export function streamZip(store, packs, name) {
  const out = new PassThrough();
  const zip = new Zip((err, chunk, final) => {
    if (err) {
      out.destroy(err);
      return;
    }
    if (out.destroyed) return;
    out.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    if (final) out.end();
  });
  // 下游（网络）写不动时等它排空；对方中途断开则 close 触发，不会卡住
  const drained = () =>
    new Promise((resolve) => {
      const done = () => {
        out.off('drain', done);
        out.off('close', done);
        resolve();
      };
      out.on('drain', done);
      out.on('close', done);
    });

  (async () => {
    const usedFolders = new Set();
    const manifestPacks = [];
    for (const [i, p] of packs.entries()) {
      const folder = unique(asciiSlug(p.name) || `pack-${i + 1}`, usedFolders);
      const usedFiles = new Set();
      const stickers = [];
      for (const [j, s] of p.stickers.entries()) {
        if (out.destroyed) {
          zip.terminate();
          return;
        }
        let bytes;
        try {
          bytes = await fsp.readFile(store.imagePath(p.id, s.file));
        } catch {
          continue;
        }
        const file = `${unique(asciiSlug(s.name) || `sticker-${j + 1}`, usedFiles)}.${s.ext}`;
        const rel = `images/${folder}/${file}`;
        const entry = new ZipPassThrough(rel); // 图片本身已压缩，直接存储
        zip.add(entry);
        entry.push(new Uint8Array(bytes), true);
        stickers.push({ id: s.id, url: rel, name: s.name, tags: s.tags });
        // 产出比下载快时等一等；否则也让出事件循环，避免大包时一直占着线程
        if (out.writableNeedDrain && !out.destroyed) await drained();
        else await new Promise((r) => setImmediate(r));
      }
      manifestPacks.push({ key: p.id, name: p.name, description: p.description || undefined, tags: p.tags, stickers });
    }
    if (out.destroyed) {
      zip.terminate();
      return;
    }
    const manifest = { name, version: new Date().toISOString().slice(0, 10), generator: 'Emoji Site', packs: manifestPacks };
    const m = new ZipDeflate('manifest.json', { level: 6 });
    zip.add(m);
    m.push(strToU8(JSON.stringify(manifest, null, 2)), true);
    zip.end();
  })().catch((e) => out.destroy(e));

  return out;
}

function isRecord(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 流式解开 zip：图片条目写到 tmpDir，manifest.json 读进内存。
 * 返回 { manifestPath, manifestText, entries: Map<条目名, 临时文件路径> }
 */
async function extractZip(zipPath, tmpDir) {
  await fsp.mkdir(tmpDir, { recursive: true });
  const entries = new Map();
  let manifestText = null;
  let manifestPath = null;
  let failed = null;
  let seq = 0;
  const pending = [];
  // 同时最多写这么多张到磁盘，超过就暂停读 zip，免得整包图片都堆在内存里
  const MAX_INFLIGHT = 8;
  let inflight = 0;
  const rs = fs.createReadStream(zipPath, { highWaterMark: 1024 * 1024 });

  const unzipper = new Unzip();
  unzipper.register(UnzipInflate);
  unzipper.onfile = (file) => {
    const name = file.name;
    if (name.endsWith('/')) return; // 目录
    if (/(^|\/)__MACOSX\//.test(name) || /(^|\/)\._/.test(name)) return;
    const isManifest = /(^|\/)manifest\.json$/i.test(name);
    const chunks = [];
    let size = 0;
    file.ondata = (err, data, final) => {
      if (err) {
        failed = failed ?? err;
        return;
      }
      size += data.length;
      if (size > 50 * 1024 * 1024) {
        failed = failed ?? new Error(`${name} 超过 50 MB`);
        file.terminate();
        return;
      }
      chunks.push(data);
      if (final) {
        const buf = Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)));
        if (isManifest) {
          // 多个 manifest 时取路径最浅的
          if (manifestPath === null || name.split('/').length < manifestPath.split('/').length) {
            manifestPath = name;
            manifestText = buf.toString('utf8');
          }
        } else if (extFromName(name)) {
          const tmp = path.join(tmpDir, `${++seq}.bin`);
          inflight++;
          pending.push(
            fsp
              .writeFile(tmp, buf)
              .then(() => entries.set(name, tmp))
              .catch((e) => {
                failed = failed ?? e;
              })
              .finally(() => {
                inflight--;
                if (inflight < MAX_INFLIGHT && rs.isPaused()) rs.resume();
              }),
          );
        }
      }
    };
    file.start();
  };

  await new Promise((resolve, reject) => {
    rs.on('data', (chunk) => {
      try {
        unzipper.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength), false);
      } catch (e) {
        failed = failed ?? e;
        rs.destroy(); // 坏包：停止读取，下面的 close 会结束等待
        return;
      }
      if (inflight >= MAX_INFLIGHT) rs.pause();
    });
    rs.on('close', resolve);
    rs.on('end', () => {
      try {
        unzipper.push(new Uint8Array(0), true);
      } catch (e) {
        failed = failed ?? e;
      }
      resolve();
    });
    rs.on('error', reject);
  });
  await Promise.all(pending);
  if (failed) throw Object.assign(new Error(`压缩包读取失败：${failed.message}`), { statusCode: 400 });
  if (!manifestPath) throw Object.assign(new Error('压缩包里没有 manifest.json'), { statusCode: 400 });
  return { manifestPath, manifestText, entries };
}

/**
 * 读取桌面应用导出的 zip（或任何符合订阅格式的 zip）。
 * 返回 { packs: [{ name, description, tags, group, missing, stickers: [{ fileName, path, name, tags }] }], cleanup }
 * stickers[].path 是临时文件，用完调用 cleanup() 删除。
 */
export async function readZipFile(zipPath, tmpDir) {
  const cleanup = () => fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  let extracted;
  try {
    extracted = await extractZip(zipPath, tmpDir);
  } catch (e) {
    await cleanup(); // 坏包 / 没有 manifest：已经解出来的临时文件也要删
    throw e;
  }
  const { manifestPath, manifestText, entries } = extracted;
  const dir = manifestPath.slice(0, manifestPath.length - 'manifest.json'.length);
  let manifest;
  try {
    manifest = JSON.parse(manifestText.replace(/^﻿/, ''));
  } catch {
    await cleanup();
    throw Object.assign(new Error('manifest.json 不是有效的 JSON'), { statusCode: 400 });
  }
  if (!isRecord(manifest)) {
    await cleanup();
    throw Object.assign(new Error('manifest.json 格式不正确'), { statusCode: 400 });
  }

  const lookup = (url) => {
    if (typeof url !== 'string' || /^[a-z]+:/i.test(url)) return null;
    let p = url.replace(/^\.\//, '').replace(/^\/+/, '');
    try {
      p = decodeURIComponent(p);
    } catch {
      /* ignore */
    }
    for (const t of [dir + p, p]) {
      const f = entries.get(t);
      if (f) return { name: t, path: f };
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
      stickers.push({
        fileName: hit.name.split('/').pop() ?? 'sticker',
        path: hit.path,
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
  if (packs.length === 0) {
    await cleanup();
    throw Object.assign(new Error('压缩包里没有任何表情'), { statusCode: 400 });
  }
  return { packs, cleanup };
}

export { extFromBytes, strFromU8 };
