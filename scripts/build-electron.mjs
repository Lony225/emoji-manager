// 用 esbuild 把 Electron 主进程和 preload 打包成 CommonJS
import { build } from 'esbuild';
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

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
// 模板表情的工具进程是 ESM：它动态 import 原生模块的 index.js（也是 ESM）
await build({ ...shared, format: 'esm', entryPoints: ['electron/meme-worker.ts'], outfile: 'dist-electron/meme-worker.mjs' });
stageMemeGenerator();

/**
 * 模板表情（@memecrafters/meme-generator）：各平台的原生库（.node）放到 dist-electron/meme-native/<os>-<arch>/，
 * electron-builder 按目标平台挑一个放进 resources/meme/。工具进程直接 require 这个文件，不依赖 node_modules，也不用包里的 JS 加载器。
 */
function stageMemeGenerator() {
  let pkgDir;
  try {
    pkgDir = path.dirname(require.resolve('@memecrafters/meme-generator/package.json'));
  } catch {
    console.warn('没有安装 @memecrafters/meme-generator，模板表情功能不可用');
    return;
  }
  const targets = {
    'win32-x64-msvc': 'win-x64',
    'darwin-x64': 'mac-x64',
    'darwin-arm64': 'mac-arm64',
    'linux-x64-gnu': 'linux-x64',
    'linux-arm64-gnu': 'linux-arm64',
  };
  rmSync('dist-electron/meme-native', { recursive: true, force: true });
  const staged = [];
  for (const [target, dir] of Object.entries(targets)) {
    let file;
    try {
      // 平台包的 main 就是 .node 文件本身
      file = require.resolve(`@memecrafters/meme-generator-${target}`, { paths: [pkgDir] });
    } catch {
      continue;
    }
    const out = path.join('dist-electron/meme-native', dir);
    mkdirSync(out, { recursive: true });
    copyFileSync(file, path.join(out, 'meme-generator.node'));
    staged.push(dir);
  }
  console.log(`模板表情原生库：${staged.join(', ') || '无'}`);
}
