// 设置 / 重置管理员口令：node server/set-password.mjs [口令]
// 不传口令则随机生成一个并打印出来。数据目录取环境变量 EMOJI_DATA_DIR（默认 site/data）。
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.mjs';

const SITE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.EMOJI_DATA_DIR ?? path.join(SITE_ROOT, 'data');
const password = process.argv[2] || crypto.randomBytes(9).toString('base64url');
const store = new Store(dataDir);
await store.init();
await store.setPassword(password);
console.log(`管理员口令已更新（数据目录 ${store.dataDir}）`);
if (!process.argv[2]) console.log(`新口令：${password}`);
