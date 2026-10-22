// 用 esbuild 把 Electron 主进程和 preload 打包成 CommonJS
import { build } from 'esbuild';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';

mkdirSync('dist-electron', { recursive: true });
// 窗口图标和各尺寸托盘图标随主进程一起打包
if (existsSync('build/icon.png')) copyFileSync('build/icon.png', 'dist-electron/icon.png');
for (const s of [16, 20, 24, 32, 40, 48]) {
  if (existsSync(`build/tray-${s}.png`)) copyFileSync(`build/tray-${s}.png`, `dist-electron/tray-${s}.png`);
}

const shared = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['electron'],
  sourcemap: true,
  logLevel: 'info',
};

await build({ ...shared, entryPoints: ['electron/main.ts'], outfile: 'dist-electron/main.cjs' });
await build({ ...shared, entryPoints: ['electron/preload.ts'], outfile: 'dist-electron/preload.cjs' });
