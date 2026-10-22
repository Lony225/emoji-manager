// 开发模式：启动 Vite 开发服务器，再用它的地址启动 Electron
import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const electronPath = require('electron');

execFileSync(process.execPath, ['scripts/build-electron.mjs'], { stdio: 'inherit' });

const server = await createServer({ configFile: 'vite.config.ts' });
await server.listen();
const url = server.resolvedUrls?.local[0];
if (!url) throw new Error('Vite 没有返回地址');
console.log(`[dev] renderer: ${url}`);

const child = spawn(electronPath, ['.'], {
  stdio: 'inherit',
  env: { ...process.env, VITE_DEV_SERVER_URL: url, EMOJI_DEVTOOLS: process.env.EMOJI_DEVTOOLS ?? '' },
});
child.on('exit', async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
