import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.mjs';

const SITE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const port = Number(process.env.PORT ?? 8844);
const host = process.env.HOST ?? '127.0.0.1';
const dataDir = process.env.EMOJI_DATA_DIR ?? path.join(SITE_ROOT, 'data');

const app = await buildApp({
  dataDir,
  // 只在第一次启动或需要重置时通过环境变量给口令；之后用 set-password 修改
  initialPassword: process.env.EMOJI_ADMIN_PASSWORD || undefined,
});
if (!app.store.hasPassword()) {
  app.log.warn('还没有设置管理员口令：启动时设置 EMOJI_ADMIN_PASSWORD，或运行 node server/set-password.mjs');
}
await app.listen({ port, host });
// 老数据补缩略图（在后台慢慢做，不挡请求）
app.store
  .backfillThumbs()
  .then((r) => {
    if (r.made || r.failed) app.log.info(`缩略图补齐：新生成 ${r.made} 张，失败 ${r.failed} 张`);
  })
  .catch((e) => app.log.error(e));
