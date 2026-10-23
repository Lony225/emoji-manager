// 数据：data/index.json（表情包与表情的信息）+ data/images/<包 id>/<文件>
// 单进程、内存缓存、原子写入；写操作串行化。
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { extFromBytes, extFromName, fileStem, normalizeTags } from './images.mjs';
import { hashPassword } from './auth.mjs';
import { makeThumb, probeAnimated, thumbFile, ThumbQueue } from './thumbs.mjs';

export const MAX_FILE = 20 * 1024 * 1024;

export function newId() {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
}

async function atomicWrite(file, text) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await fsp.writeFile(tmp, text);
  await fsp.rename(tmp, file);
}

function cleanName(s, fallback) {
  const v = typeof s === 'string' ? s.trim().slice(0, 80) : '';
  return v || fallback;
}

/** 分组路径规范化：按 / 切开、去空白，用「 / 」连接；最多 8 级、每级 80 字 */
export function normalizeGroup(s) {
  return String(s ?? '')
    .split('/')
    .map((x) => x.trim().slice(0, 80))
    .filter(Boolean)
    .slice(0, 8)
    .join(' / ');
}

/** 表情包的完整路径："分组 / 名称"，没有分组就是名称 */
export function packPath(p) {
  return p.group ? `${p.group} / ${p.name}` : p.name;
}

/** 读旧数据：没有 group 字段时，名字里的「 / 」是早期导入时拼进去的分组，拆回去 */
function splitLegacyName(p) {
  const name = cleanName(p.name, '表情包');
  if (typeof p.group === 'string') return { name, group: normalizeGroup(p.group) };
  const segs = name.split(' / ').map((s) => s.trim()).filter(Boolean);
  if (segs.length < 2) return { name, group: '' };
  return { name: segs[segs.length - 1], group: segs.slice(0, -1).join(' / ') };
}

export class Store {
  constructor(dataDir) {
    this.dataDir = path.resolve(dataDir);
    this.indexFile = path.join(this.dataDir, 'index.json');
    this.configFile = path.join(this.dataDir, 'config.json');
    this.imagesDir = path.join(this.dataDir, 'images');
    this.thumbsDir = path.join(this.dataDir, 'thumbs');
    this.thumbs = new ThumbQueue(2);
    this.index = { version: 1, site: { title: '表情包', description: '' }, packs: [] };
    this.config = null;
    this.queue = Promise.resolve();
  }

  async init(initialPassword) {
    await fsp.mkdir(this.imagesDir, { recursive: true });
    try {
      const raw = JSON.parse(await fsp.readFile(this.indexFile, 'utf8'));
      if (raw && Array.isArray(raw.packs)) {
        this.index = {
          version: 1,
          site: { title: cleanName(raw.site?.title, '表情包'), description: typeof raw.site?.description === 'string' ? raw.site.description.slice(0, 300) : '' },
          packs: raw.packs
            .filter((p) => p && typeof p.id === 'string')
            .map((p, i) => ({
              id: p.id,
              ...splitLegacyName(p),
              description: typeof p.description === 'string' ? p.description.slice(0, 300) : '',
              tags: normalizeTags(p.tags),
              order: typeof p.order === 'number' ? p.order : i,
              createdAt: p.createdAt ?? Date.now(),
              updatedAt: p.updatedAt ?? Date.now(),
              stickers: Array.isArray(p.stickers)
                ? p.stickers
                    .filter((s) => s && typeof s.id === 'string' && typeof s.file === 'string')
                    .map((s) => ({
                      id: s.id,
                      file: s.file,
                      ext: s.ext ?? extFromName(s.file) ?? 'png',
                      size: s.size ?? 0,
                      hash: s.hash ?? '',
                      name: cleanName(s.name, '表情'),
                      tags: normalizeTags(s.tags),
                      createdAt: s.createdAt ?? Date.now(),
                      animated: typeof s.animated === 'boolean' ? s.animated : undefined, // 老数据：启动时补
                    }))
                : [],
            })),
        };
      }
    } catch {
      /* 第一次运行 */
    }
    try {
      this.config = JSON.parse(await fsp.readFile(this.configFile, 'utf8'));
    } catch {
      this.config = null;
    }
    if (!this.config || typeof this.config.secret !== 'string') {
      this.config = { secret: crypto.randomBytes(32).toString('hex'), passwordSalt: '', passwordHash: '' };
      await atomicWrite(this.configFile, JSON.stringify(this.config, null, 2));
    }
    if (initialPassword) await this.setPassword(initialPassword);
  }

  hasPassword() {
    return !!(this.config.passwordHash && this.config.passwordSalt);
  }

  async setPassword(password) {
    const { salt, hash } = hashPassword(password);
    this.config = { ...this.config, passwordSalt: salt, passwordHash: hash };
    await atomicWrite(this.configFile, JSON.stringify(this.config, null, 2));
  }

  /** 串行执行一个修改并落盘 */
  mutate(fn) {
    const run = async () => {
      const result = await fn(this.index);
      await atomicWrite(this.indexFile, JSON.stringify(this.index));
      return result;
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  sortedPacks() {
    return [...this.index.packs].sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
  }

  getPack(id) {
    return this.index.packs.find((p) => p.id === id);
  }

  /** 某个路径下的所有表情包：路径本身的包（如果有）加上所有后代，按顺序 */
  packsUnder(pathStr) {
    const prefix = `${pathStr} / `;
    return this.sortedPacks().filter((p) => {
      const fp = packPath(p);
      return fp === pathStr || fp.startsWith(prefix);
    });
  }

  findSticker(id) {
    for (const p of this.index.packs) {
      const s = p.stickers.find((x) => x.id === id);
      if (s) return { pack: p, sticker: s };
    }
    return null;
  }

  imagePath(packId, file) {
    const abs = path.resolve(this.imagesDir, packId, file);
    if (!abs.startsWith(this.imagesDir + path.sep)) throw new Error('非法路径');
    return abs;
  }

  thumbPath(packId, file) {
    const abs = path.resolve(this.thumbsDir, packId, thumbFile(file));
    if (!abs.startsWith(this.thumbsDir + path.sep)) throw new Error('非法路径');
    return abs;
  }

  /** 保证某张表情有缩略图（没有就现做），返回缩略图路径；做不出来会抛错 */
  async ensureThumb(packId, sticker) {
    const dest = this.thumbPath(packId, sticker.file);
    try {
      await fsp.access(dest);
      return dest;
    } catch {
      await this.thumbs.run(() => makeThumb(this.imagePath(packId, sticker.file), dest));
      return dest;
    }
  }

  /**
   * 启动时补齐缩略图和 animated 标记（老数据、或缩略图目录被清过）。
   * 逐张串行做，不影响正常请求。
   */
  async backfillThumbs() {
    let made = 0;
    let failed = 0;
    const flags = new Map();
    for (const p of [...this.index.packs]) {
      for (const s of [...p.stickers]) {
        const src = this.imagePath(p.id, s.file);
        const dest = this.thumbPath(p.id, s.file);
        let exists = true;
        try {
          await fsp.access(dest);
        } catch {
          exists = false;
        }
        if (exists) {
          if (s.animated === undefined) flags.set(s.id, await probeAnimated(src));
          continue;
        }
        try {
          const { animated } = await this.thumbs.run(() => makeThumb(src, dest));
          flags.set(s.id, animated);
          made++;
        } catch {
          failed++;
          if (s.animated === undefined) flags.set(s.id, false);
        }
      }
    }
    if (flags.size) {
      await this.mutate((idx) => {
        for (const p of idx.packs) for (const s of p.stickers) if (flags.has(s.id)) s.animated = flags.get(s.id);
      });
    }
    return { made, failed, flagged: flags.size };
  }

  // ---------------------------------------------------------------- 表情包

  createPack({ name, description, tags, group }) {
    return this.mutate((idx) => {
      const order = idx.packs.reduce((m, p) => Math.max(m, p.order), -1) + 1;
      const pack = {
        id: newId(),
        name: cleanName(name, '新表情包'),
        group: normalizeGroup(group),
        description: typeof description === 'string' ? description.trim().slice(0, 300) : '',
        tags: normalizeTags(tags),
        order,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        stickers: [],
      };
      idx.packs.push(pack);
      return pack;
    });
  }

  updatePack(id, patch) {
    return this.mutate((idx) => {
      const p = idx.packs.find((x) => x.id === id);
      if (!p) throw Object.assign(new Error('表情包不存在'), { statusCode: 404 });
      if (patch.name !== undefined) p.name = cleanName(patch.name, p.name);
      if (patch.group !== undefined) p.group = normalizeGroup(patch.group);
      if (patch.description !== undefined) p.description = String(patch.description ?? '').trim().slice(0, 300);
      if (patch.tags !== undefined) p.tags = normalizeTags(patch.tags);
      p.updatedAt = Date.now();
      return p;
    });
  }

  /** 在同一分组的兄弟之间上下移动 */
  movePack(id, direction) {
    return this.mutate((idx) => {
      const sorted = [...idx.packs].sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
      sorted.forEach((p, k) => (p.order = k));
      const me = sorted.find((p) => p.id === id);
      if (!me) return;
      const siblings = sorted.filter((p) => p.group === me.group);
      const i = siblings.indexOf(me);
      const j = i + direction;
      if (j < 0 || j >= siblings.length) return;
      [siblings[i].order, siblings[j].order] = [siblings[j].order, siblings[i].order];
    });
  }

  async deletePack(id) {
    const pack = await this.mutate((idx) => {
      const i = idx.packs.findIndex((p) => p.id === id);
      if (i < 0) throw Object.assign(new Error('表情包不存在'), { statusCode: 404 });
      return idx.packs.splice(i, 1)[0];
    });
    await fsp.rm(path.join(this.imagesDir, pack.id), { recursive: true, force: true });
    await fsp.rm(path.join(this.thumbsDir, pack.id), { recursive: true, force: true });
    return pack;
  }

  // ---------------------------------------------------------------- 表情

  /**
   * 向表情包添加图片。files: [{ name, bytes, displayName?, tags? }]
   * 内容相同的图片（同一包内）不重复添加。
   */
  async addStickers(packId, files) {
    const pack = this.getPack(packId);
    if (!pack) throw Object.assign(new Error('表情包不存在'), { statusCode: 404 });
    const result = { added: 0, skipped: 0, failed: 0, errors: [] };
    const toAdd = [];
    const hashes = new Set(pack.stickers.map((s) => s.hash));
    for (const f of files) {
      try {
        if (f.bytes.length > MAX_FILE) {
          result.failed++;
          result.errors.push(`${f.name}：超过 20 MB`);
          continue;
        }
        const ext = extFromBytes(f.bytes) ?? extFromName(f.name);
        if (!ext) {
          result.skipped++;
          result.errors.push(`${f.name}：不是支持的图片格式`);
          continue;
        }
        const hash = crypto.createHash('sha256').update(f.bytes).digest('hex');
        if (hashes.has(hash)) {
          result.skipped++;
          continue;
        }
        hashes.add(hash);
        const file = `${hash.slice(0, 20)}.${ext}`;
        await fsp.mkdir(path.join(this.imagesDir, pack.id), { recursive: true });
        await fsp.writeFile(this.imagePath(pack.id, file), f.bytes);
        // 顺手生成缩略图；做不出来（少见格式）就没有，前端回退到原图
        let animated = false;
        try {
          ({ animated } = await this.thumbs.run(() => makeThumb(this.imagePath(pack.id, file), this.thumbPath(pack.id, file))));
        } catch {
          /* 没有缩略图 */
        }
        toAdd.push({
          id: newId(),
          file,
          ext,
          size: f.bytes.length,
          hash,
          name: cleanName(f.displayName, fileStem(f.name)),
          tags: normalizeTags(f.tags),
          createdAt: Date.now(),
          animated,
        });
        result.added++;
      } catch (e) {
        result.failed++;
        result.errors.push(`${f.name}：${e.message}`);
      }
    }
    if (toAdd.length) {
      await this.mutate((idx) => {
        const p = idx.packs.find((x) => x.id === packId);
        if (!p) throw Object.assign(new Error('表情包不存在'), { statusCode: 404 });
        p.stickers.push(...toAdd);
        p.updatedAt = Date.now();
      });
    }
    return result;
  }

  updateSticker(id, patch) {
    return this.mutate((idx) => {
      for (const p of idx.packs) {
        const s = p.stickers.find((x) => x.id === id);
        if (!s) continue;
        if (patch.name !== undefined) s.name = cleanName(patch.name, s.name);
        if (patch.tags !== undefined) s.tags = normalizeTags(patch.tags);
        p.updatedAt = Date.now();
        return s;
      }
      throw Object.assign(new Error('表情不存在'), { statusCode: 404 });
    });
  }

  async deleteStickers(ids) {
    const idSet = new Set(ids);
    const removed = await this.mutate((idx) => {
      const out = [];
      for (const p of idx.packs) {
        const keep = [];
        for (const s of p.stickers) {
          if (idSet.has(s.id)) out.push({ packId: p.id, file: s.file });
          else keep.push(s);
        }
        if (keep.length !== p.stickers.length) {
          p.stickers = keep;
          p.updatedAt = Date.now();
        }
      }
      return out;
    });
    for (const r of removed) {
      await fsp.rm(this.imagePath(r.packId, r.file), { force: true }).catch(() => undefined);
      await fsp.rm(this.thumbPath(r.packId, r.file), { force: true }).catch(() => undefined);
    }
    return removed.length;
  }

  moveStickers(ids, targetPackId) {
    return this.mutate(async (idx) => {
      const target = idx.packs.find((p) => p.id === targetPackId);
      if (!target) throw Object.assign(new Error('目标表情包不存在'), { statusCode: 404 });
      const idSet = new Set(ids);
      let moved = 0;
      for (const p of idx.packs) {
        if (p.id === target.id) continue;
        const keep = [];
        for (const s of p.stickers) {
          if (!idSet.has(s.id)) {
            keep.push(s);
            continue;
          }
          if (target.stickers.some((t) => t.hash === s.hash)) {
            await fsp.rm(this.imagePath(p.id, s.file), { force: true }).catch(() => undefined);
            await fsp.rm(this.thumbPath(p.id, s.file), { force: true }).catch(() => undefined);
          } else {
            await fsp.mkdir(path.join(this.imagesDir, target.id), { recursive: true });
            await fsp.rename(this.imagePath(p.id, s.file), this.imagePath(target.id, s.file));
            await fsp.mkdir(path.join(this.thumbsDir, target.id), { recursive: true });
            await fsp.rename(this.thumbPath(p.id, s.file), this.thumbPath(target.id, s.file)).catch(() => undefined);
            target.stickers.push(s);
          }
          moved++;
        }
        p.stickers = keep;
      }
      target.updatedAt = Date.now();
      return moved;
    });
  }

  updateSite(patch) {
    return this.mutate((idx) => {
      if (patch.title !== undefined) idx.site.title = cleanName(patch.title, idx.site.title);
      if (patch.description !== undefined) idx.site.description = String(patch.description ?? '').trim().slice(0, 300);
      return idx.site;
    });
  }

  /** 当前 index 文件是否存在（用于判断第一次运行） */
  exists() {
    return fs.existsSync(this.indexFile);
  }
}
