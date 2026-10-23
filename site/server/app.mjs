import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import fastifyRateLimit from '@fastify/rate-limit';
import { Store, MAX_FILE, normalizeGroup, packPath } from './store.mjs';
import { issueSession, verifySession, verifyPassword, LoginGuard } from './auth.mjs';
import { groupManifest, packManifest, readZipFile, siteManifest, streamZip } from './manifest.mjs';
import { thumbFile } from './thumbs.mjs';
import fsp from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import crypto from 'node:crypto';
import { MIME } from './images.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const COOKIE = 'emoji_admin';
/** 导入 zip 的大小上限（落盘处理，不占内存） */
const ZIP_MAX = 2 * 1024 * 1024 * 1024;

export async function buildApp({ dataDir, initialPassword, logger = true, trustProxy = true }) {
  const store = new Store(dataDir);
  await store.init(initialPassword);
  const guard = new LoginGuard();

  const app = Fastify({ logger, trustProxy, bodyLimit: 1024 * 1024 });
  await app.register(fastifyCookie);
  await app.register(fastifyRateLimit, { max: 300, timeWindow: '1 minute' });
  await app.register(fastifyMultipart, { limits: { fileSize: MAX_FILE, files: 300 } });

  // 静态页面与资源
  await app.register(fastifyStatic, { root: PUBLIC_DIR, prefix: '/', index: ['index.html'], decorateReply: true });
  // 图片：内容寻址的文件名，可长期缓存
  await app.register(fastifyStatic, {
    root: store.imagesDir,
    prefix: '/images/',
    decorateReply: false,
    maxAge: '365d',
    immutable: true,
    setHeaders(res, filePath) {
      // 不同版本的 @fastify/static 传进来的可能是原生 response 也可能是 reply
      const set = (k, v) => (typeof res.setHeader === 'function' ? res.setHeader(k, v) : res.header(k, v));
      const ext = path.extname(filePath).slice(1).toLowerCase();
      if (MIME[ext]) set('content-type', MIME[ext]);
      set('access-control-allow-origin', '*');
    },
  });

  app.setErrorHandler((err, _req, reply) => {
    const code = err.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
    if (code === 500) app.log.error(err);
    let message = err.message;
    if (code === 413) message = '文件太大：单张图片最多 20 MB，压缩包最多 2 GB';
    else if (code === 500) message = '服务器出错了';
    reply.code(code).send({ error: message });
  });

  const isAdmin = (req) => verifySession(store.config.secret, req.cookies[COOKIE]);
  const requireAdmin = async (req) => {
    if (!isAdmin(req)) throw Object.assign(new Error('请先登录'), { statusCode: 401 });
  };
  const publicPack = (p) => ({
    id: p.id,
    name: p.name,
    group: p.group,
    path: packPath(p),
    description: p.description,
    tags: p.tags,
    count: p.stickers.length,
    updatedAt: p.updatedAt,
    stickers: p.stickers.map((s) => ({
      id: s.id,
      name: s.name,
      tags: s.tags,
      ext: s.ext,
      size: s.size,
      animated: s.animated === true,
      url: `/images/${p.id}/${s.file}`,
      thumb: `/thumbs/${p.id}/${thumbFile(s.file)}`,
    })),
  });

  // ---------------------------------------------------------------- 公开接口
  app.get('/api/site', async () => ({
    title: store.index.site.title,
    description: store.index.site.description,
    passwordSet: store.hasPassword(),
    packs: store.sortedPacks().map(publicPack),
  }));

  // 缩略图：生产环境由 nginx 直接发文件，没有时才落到这里现做（做好就留着，下次 nginx 直接发）
  app.get('/thumbs/:packId/:file', async (req, reply) => {
    const pack = store.getPack(req.params.packId);
    const stem = String(req.params.file).replace(/\.webp$/i, '');
    const sticker = pack?.stickers.find((s) => s.file.startsWith(`${stem}.`));
    if (!pack || !sticker || !/^[a-f0-9]+$/.test(stem)) throw Object.assign(new Error('不存在'), { statusCode: 404 });
    let dest;
    try {
      dest = await store.ensureThumb(pack.id, sticker);
    } catch {
      throw Object.assign(new Error('无法生成缩略图'), { statusCode: 404 });
    }
    reply.header('content-type', 'image/webp').header('cache-control', 'public, max-age=31536000, immutable').header('access-control-allow-origin', '*');
    return reply.send(fs.createReadStream(dest));
  });

  app.get('/manifest.json', async (_req, reply) => {
    reply.header('access-control-allow-origin', '*').header('cache-control', 'no-cache');
    return siteManifest(store);
  });
  app.get('/packs/:id/manifest.json', async (req, reply) => {
    const p = store.getPack(req.params.id);
    if (!p) throw Object.assign(new Error('表情包不存在'), { statusCode: 404 });
    reply.header('access-control-allow-origin', '*').header('cache-control', 'no-cache');
    return packManifest(store, p);
  });
  // async 处理函数里用 reply.send(流) 时必须把 reply 返回：否则 Fastify 会在流写出第一块之前就把响应按空内容结束
  const sendZip = (reply, packs, name, baseGroup = '') =>
    reply
      .header('content-type', 'application/zip')
      .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}.zip`)
      .send(streamZip(store, packs, name, baseGroup));
  app.get('/packs/:id.zip', async (req, reply) => {
    const p = store.getPack(req.params.id);
    if (!p) throw Object.assign(new Error('表情包不存在'), { statusCode: 404 });
    return sendZip(reply, [p], p.name, p.group);
  });
  app.get('/all.zip', async (_req, reply) => sendZip(reply, store.sortedPacks(), store.index.site.title));

  /**
   * 分组级地址：/groups/<一级>/<二级>/manifest.json 订阅、/groups/<一级>/<二级>.zip 下载，
   * 包含这个路径上的包和它下面的所有表情包。按原始 URL 自己切段，段里编码过的 / 不会被当成分隔符。
   */
  const parseGroupUrl = (req) => {
    const raw = req.raw.url.split('?')[0].replace(/^\/groups\//, '');
    const segs = raw.split('/').map((s) => {
      try {
        return decodeURIComponent(s).trim();
      } catch {
        return s.trim();
      }
    });
    const last = segs.pop() ?? '';
    let kind = null;
    if (last === 'manifest.json') kind = 'manifest';
    else if (last.endsWith('.zip')) {
      kind = 'zip';
      segs.push(last.slice(0, -4).trim());
    }
    return { kind, pathStr: segs.filter(Boolean).join(' / ') };
  };
  app.get('/groups/*', async (req, reply) => {
    const { kind, pathStr } = parseGroupUrl(req);
    if (!kind || !pathStr) throw Object.assign(new Error('不存在'), { statusCode: 404 });
    const packs = store.packsUnder(pathStr);
    if (packs.length === 0) throw Object.assign(new Error('分组不存在'), { statusCode: 404 });
    if (kind === 'manifest') {
      reply.header('access-control-allow-origin', '*').header('cache-control', 'no-cache');
      return groupManifest(store, pathStr);
    }
    const segs = pathStr.split(' / ');
    return sendZip(reply, packs, segs[segs.length - 1], segs.slice(0, -1).join(' / '));
  });

  // ---------------------------------------------------------------- 登录
  app.post('/api/login', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const wait = guard.check(req.ip);
    if (wait > 0) throw Object.assign(new Error(`失败次数太多，请 ${wait} 秒后再试`), { statusCode: 429 });
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!store.hasPassword()) throw Object.assign(new Error('还没有设置管理员口令，请在服务器上运行 set-password'), { statusCode: 503 });
    if (!verifyPassword(password, store.config.passwordSalt, store.config.passwordHash)) {
      guard.fail(req.ip);
      throw Object.assign(new Error('口令不正确'), { statusCode: 401 });
    }
    guard.reset(req.ip);
    const s = issueSession(store.config.secret);
    reply.setCookie(COOKIE, s.value, { path: '/', httpOnly: true, sameSite: 'strict', secure: 'auto', maxAge: s.maxAgeSec });
    return { ok: true };
  });
  app.post('/api/logout', async (_req, reply) => {
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });
  app.get('/api/me', async (req) => ({ admin: isAdmin(req) }));

  // ---------------------------------------------------------------- 管理接口
  app.register(async (admin) => {
    admin.addHook('preHandler', requireAdmin);

    admin.patch('/api/site', async (req) => store.updateSite(req.body ?? {}));
    admin.post('/api/password', async (req) => {
      const { current, next } = req.body ?? {};
      if (!verifyPassword(String(current ?? ''), store.config.passwordSalt, store.config.passwordHash)) {
        throw Object.assign(new Error('当前口令不正确'), { statusCode: 400 });
      }
      if (typeof next !== 'string' || next.length < 6) throw Object.assign(new Error('新口令至少 6 位'), { statusCode: 400 });
      await store.setPassword(next);
      return { ok: true };
    });

    admin.post('/api/packs', async (req) => publicPack(await store.createPack(req.body ?? {})));
    admin.patch('/api/packs/:id', async (req) => publicPack(await store.updatePack(req.params.id, req.body ?? {})));
    admin.post('/api/packs/:id/move', async (req) => {
      await store.movePack(req.params.id, req.body?.direction === 'up' ? -1 : 1);
      return { ok: true };
    });
    admin.delete('/api/packs/:id', async (req) => {
      await store.deletePack(req.params.id);
      return { ok: true };
    });

    admin.post('/api/packs/:id/stickers', async (req) => {
      const pack = store.getPack(req.params.id);
      if (!pack) throw Object.assign(new Error('表情包不存在'), { statusCode: 404 });
      const files = [];
      for await (const part of req.parts({ limits: { fileSize: MAX_FILE, files: 300 } })) {
        if (part.type !== 'file') continue;
        const bytes = await part.toBuffer();
        if (part.file.truncated) {
          files.push({ name: part.filename, bytes: Buffer.alloc(MAX_FILE + 1) });
          continue;
        }
        files.push({ name: part.filename, bytes });
      }
      if (files.length === 0) throw Object.assign(new Error('没有收到文件'), { statusCode: 400 });
      return store.addStickers(pack.id, files);
    });
    admin.patch('/api/stickers/:id', async (req) => store.updateSticker(req.params.id, req.body ?? {}));
    admin.post('/api/stickers/delete', async (req) => ({ removed: await store.deleteStickers(Array.isArray(req.body?.ids) ? req.body.ids : []) }));
    admin.post('/api/stickers/move', async (req) => ({
      moved: await store.moveStickers(Array.isArray(req.body?.ids) ? req.body.ids : [], String(req.body?.packId ?? '')),
    }));

    /** 导入桌面应用导出的 zip：先流式落盘再逐条解包，大包也不占内存；每个包按“分组 + 名字”找或建，分类层级原样保留 */
    admin.post('/api/import', async (req) => {
      const tmpBase = path.join(store.dataDir, 'tmp');
      await fsp.mkdir(tmpBase, { recursive: true });
      const id = crypto.randomUUID();
      const zipPath = path.join(tmpBase, `${id}.zip`);
      const tmpDir = path.join(tmpBase, id);
      let received = false;
      try {
        for await (const part of req.parts({ limits: { fileSize: ZIP_MAX, files: 1 } })) {
          if (part.type !== 'file') continue;
          await pipeline(part.file, fs.createWriteStream(zipPath));
          received = true;
        }
        if (!received) throw Object.assign(new Error('没有收到文件'), { statusCode: 400 });
        const { packs, cleanup } = await readZipFile(zipPath, tmpDir);
        try {
          const summary = { packs: 0, added: 0, skipped: 0, failed: 0, missing: 0, names: [] };
          for (const p of packs) {
            const group = normalizeGroup(p.group);
            let pack = store.index.packs.find((x) => x.group === group && x.name === p.name);
            if (!pack) {
              pack = await store.createPack({ name: p.name, description: p.description, tags: p.tags, group });
              summary.packs++;
            }
            // 每批 50 张：图片从临时文件读，内存里只有这一批
            for (let i = 0; i < p.stickers.length; i += 50) {
              const batch = [];
              for (const st of p.stickers.slice(i, i + 50)) {
                batch.push({ name: st.fileName, bytes: await fsp.readFile(st.path), displayName: st.name, tags: st.tags });
              }
              const r = await store.addStickers(pack.id, batch);
              summary.added += r.added;
              summary.skipped += r.skipped;
              summary.failed += r.failed;
            }
            summary.missing += p.missing;
            summary.names.push(packPath(pack));
          }
          return summary;
        } finally {
          await cleanup();
        }
      } finally {
        await fsp.rm(zipPath, { force: true }).catch(() => undefined);
      }
    });
  });

  app.get('/admin', (_req, reply) => reply.sendFile('admin.html'));
  app.get('/healthz', async () => ({ ok: true, packs: store.index.packs.length }));

  // 单页：其他路径回到首页
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/') || req.url.startsWith('/images/') || req.url.startsWith('/thumbs/')) return reply.code(404).send({ error: '不存在' });
    return reply.sendFile('index.html');
  });

  app.store = store;
  return app;
}

export function publicDirExists() {
  return fs.existsSync(PUBLIC_DIR);
}
