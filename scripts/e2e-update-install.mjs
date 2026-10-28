// 内置更新的真机验证（Windows）：打两个真实的安装包，装旧版 → 在应用里下载新版（伪装的发布目录）→ 静默安装、自动重启 → 核对版本和数据。
//
//   node scripts/e2e-update-install.mjs             # pnpm build，打两个测试安装包（当前版本、补丁号 +1），然后跑
//   node scripts/e2e-update-install.mjs --no-build  # 复用上次打的包（.e2e-tmp/update-install/）
//
// 测试安装包和正式包只差几个标识：appId、productName（可执行文件名、数据目录）、快捷方式名、包名（更新缓存目录）都带 E2E，
// 装到 .e2e-tmp 下的临时目录，所以不会碰到本机正式安装的表情包管理器和它的资料；跑完会静默卸载并清理。
// 应用启动时会把自己登记为 emojimanager:// 的处理程序，脚本会把原来的登记值存下来、结束时恢复。
// 安装 / 卸载都是静默的，期间请不要手动打开测试版应用。
import { spawn, execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSampleServer } from './serve-samples.mjs';
import { Cdp, check, findPage, results, sleep, waitUntil, writeLatestYml } from './e2e-lib.mjs';

if (process.platform !== 'win32') {
  console.error('只能在 Windows 上跑');
  process.exit(1);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const PORT = 9335;
const FEED_PORT = 8790;
const PRODUCT = 'Emoji Manager E2E';
const EXE_NAME = `${PRODUCT}.exe`;
const CACHE_DIR = path.join(process.env.LOCALAPPDATA, 'emoji-manager-e2e-updater');
const APPDATA_DIR = path.join(process.env.APPDATA, PRODUCT);
const buildDir = path.join(ROOT, '.e2e-tmp', 'update-install');
const work = path.join(ROOT, '.e2e-tmp', `update-install-run-${Date.now()}`);
const installDir = path.join(work, 'app');
const dataDir = path.join(work, 'data');
const feedDir = path.join(work, 'feed');
const exe = path.join(installDir, EXE_NAME);

const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const oldVersion = pkg.version;
const newVersion = oldVersion.replace(/(\d+)$/, (m) => String(Number(m) + 1));

function run(file, cmdArgs, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, cmdArgs, { stdio: 'ignore', ...opts });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code));
  });
}

function ps(command) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** 放进 PowerShell 单引号字符串里 */
function psq(s) {
  return s.replace(/'/g, "''");
}

/** 可执行文件的版本号（electron-builder 写进资源里的，和 package.json 一致；Windows 可能补成四段，去掉末尾的 .0）；读不到（正在被安装程序替换）返回 null */
function exeVersion(file) {
  if (!existsSync(file)) return null;
  try {
    const v = ps(`(Get-Item -LiteralPath '${psq(file)}' -ErrorAction SilentlyContinue).VersionInfo.ProductVersion`);
    return v ? v.trim().replace(/^(\d+\.\d+\.\d+)(?:\.0)?$/, '$1') : null;
  } catch {
    return null;
  }
}

/** 「程序和功能」里有没有测试版的卸载项（按 DisplayName） */
function uninstallEntryExists() {
  const out = ps(
    `Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like '${PRODUCT}*' } | Select-Object -ExpandProperty DisplayName`,
  );
  return out.length > 0;
}

/** 从测试安装目录启动的进程的 PID（按可执行文件路径找，不会和本机正式安装的程序混淆） */
function runningPids() {
  try {
    const out = ps(`Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq '${psq(exe)}' } | ForEach-Object { $_.Id }`);
    return out ? out.split(/\r?\n/).map((l) => Number(l.trim())).filter((n) => n > 0) : [];
  } catch {
    return [];
  }
}

function isRunning() {
  return runningPids().length > 0;
}

function killAll() {
  try {
    ps(`Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq '${psq(exe)}' } | Stop-Process -Force -ErrorAction SilentlyContinue`);
  } catch {
    /* 没在运行 */
  }
}

/** 打一个测试安装包：标识都带 E2E，输出到 outDir；返回安装包路径 */
function buildInstaller(version, outDir) {
  rmSync(outDir, { recursive: true, force: true });
  const cli = path.join(ROOT, 'node_modules', 'electron-builder', 'cli.js');
  const cliArgs = [
    cli,
    '--win',
    'nsis',
    '--publish',
    'never',
    `--config.directories.output=${outDir}`,
    '--config.appId=dev.lony.emoji-manager.e2e',
    `--config.productName=${PRODUCT}`,
    `--config.extraMetadata.productName=${PRODUCT}`,
    '--config.extraMetadata.name=emoji-manager-e2e',
    `--config.extraMetadata.version=${version}`,
    '--config.nsis.shortcutName=表情包管理器 E2E',
  ];
  console.log(`  打包 ${version} → ${outDir}`);
  execFileSync(process.execPath, cliArgs, { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
  // 解包目录有几百 MB，留着安装包、blockmap 和 latest.yml 就够复用（--no-build）
  rmSync(path.join(outDir, 'win-unpacked'), { recursive: true, force: true });
  const file = readdirSync(outDir).find((f) => f.endsWith('.exe'));
  if (!file) throw new Error(`没有打出安装包：${outDir}`);
  return path.join(outDir, file);
}

/** 反复关掉从测试目录启动的进程，直到它连续若干秒都不再出现（安装程序可能过一会儿才经资源管理器拉起新版，会抢单实例锁） */
async function settleKilled() {
  for (let i = 0; i < 40; i++) {
    if (isRunning()) {
      killAll();
      await sleep(1000);
      continue;
    }
    await sleep(1500);
    if (!isRunning()) return;
  }
}

/** 启动安装好的应用（带调试端口、独立数据目录），连上主窗口；带单实例锁撞车时的一次重试 */
async function launchInstalled() {
  const env = { ...process.env, EMOJI_USER_DATA_DIR: dataDir };
  delete env.ELECTRON_RUN_AS_NODE;
  for (let attempt = 0; attempt < 2; attempt++) {
    await settleKilled();
    const child = spawn(exe, [`--remote-debugging-port=${PORT}`], { env, stdio: 'ignore', detached: true });
    child.unref();
    try {
      const page = await findPage('main', PORT, 30000);
      const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
      await cdp.waitFor('window.__emojiStore && window.__emojiStore.getState().loaded', 30000, '资料加载完成');
      return cdp;
    } catch (e) {
      // 多半是被安装程序刚拉起的实例抢了单实例锁，我们这个一启动就退了：清场重来一次
      if (attempt === 1) throw e;
      console.log('  启动没连上（可能撞上自动拉起的实例），清场重试…');
    }
  }
  throw new Error('无法启动安装好的应用');
}

async function quitApp(cdp) {
  await Promise.race([cdp.eval('window.emojiBridge.quit()').catch(() => undefined), sleep(3000)]);
  cdp.close();
  await waitUntil(() => !isRunning(), 15000, '应用退出');
}

const PROTOCOL_KEY = 'HKCU:\\Software\\Classes\\emojimanager\\shell\\open\\command';
function readProtocolHandler() {
  try {
    return ps(`(Get-ItemProperty -LiteralPath '${PROTOCOL_KEY}' -ErrorAction Stop).'(default)'`);
  } catch {
    return '';
  }
}
function restoreProtocolHandler(value) {
  if (!value) return;
  ps(`Set-ItemProperty -LiteralPath '${PROTOCOL_KEY}' -Name '(default)' -Value '${value.replace(/'/g, "''")}'`);
}

let feedServer = null;
const protocolBefore = readProtocolHandler();
try {
  console.log(`旧版 ${oldVersion} → 新版 ${newVersion}；工作目录：${work}`);
  mkdirSync(dataDir, { recursive: true });

  // 0. 打包（两个版本共用同一份 dist）
  let oldInstaller;
  let newInstaller;
  if (args.has('--no-build')) {
    oldInstaller = path.join(buildDir, 'old', readdirSync(path.join(buildDir, 'old')).find((f) => f.endsWith('.exe')));
    newInstaller = path.join(buildDir, 'new', readdirSync(path.join(buildDir, 'new')).find((f) => f.endsWith('.exe')));
  } else {
    console.log('\n构建…');
    execFileSync('pnpm', ['build'], { cwd: ROOT, stdio: 'inherit', shell: true });
    oldInstaller = buildInstaller(oldVersion, path.join(buildDir, 'old'));
    newInstaller = buildInstaller(newVersion, path.join(buildDir, 'new'));
  }
  console.log(`  旧版安装包：${oldInstaller}\n  新版安装包：${newInstaller}`);

  // 1. 伪装的发布目录：latest.yml + 新版安装包 + 两个版本的 blockmap（有旧版的缓存时走增量下载）
  const feed = writeLatestYml(feedDir, newVersion, newInstaller);
  copyFileSync(newInstaller, path.join(feedDir, feed.name));
  for (const dir of [path.dirname(oldInstaller), path.dirname(newInstaller)]) {
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.blockmap'))) copyFileSync(path.join(dir, f), path.join(feedDir, f));
  }
  const started = await createSampleServer(FEED_PORT, '127.0.0.1', feedDir);
  feedServer = started.server;
  const feedUrl = `${started.url}/`;
  console.log(`  伪装的发布目录：${feedUrl}（${feed.name}，${feed.size} 字节）`);

  // 2. 静默安装旧版到临时目录
  console.log('\n安装旧版…');
  killAll();
  rmSync(CACHE_DIR, { recursive: true, force: true });
  const code = await run(oldInstaller, ['/S', '/currentuser', `/D=${installDir}`]);
  check('旧版安装程序退出码为 0', code === 0, String(code));
  await waitUntil(() => existsSync(exe), 20000, '安装目录出现主程序');
  const v0 = exeVersion(exe);
  check('旧版装好了', v0 === oldVersion, `安装目录里的版本 ${v0}`);
  check('「程序和功能」里有测试版的卸载项', uninstallEntryExists());
  check('安装程序把自己存进了更新缓存目录（增量下载用）', existsSync(path.join(CACHE_DIR, 'installer.exe')));

  // 3. 启动旧版，在应用里下载新版
  console.log('\n启动旧版并下载更新…');
  let cdp = await launchInstalled();
  check('安装版报告支持内置更新', (await cdp.eval('window.emojiBridge.installUpdates')) === true);
  // 留一条设置，装完后核对数据没丢
  await cdp.eval("window.__emojiStore.getState().updateSettings({ gridSize: 'small' })");
  const t0 = Date.now();
  const r = await cdp.eval(
    `window.emojiBridge.updateDownload({ baseUrl: '${feedUrl}', version: '${newVersion}', via: '测试', sha256: '${feed.sha256}' }).then(s => s, e => ({ error: e.message }))`,
  );
  check('在应用里下载并校验新版安装包', r.phase === 'downloaded' && r.version === newVersion, `${JSON.stringify(r)}，耗时 ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
  check('安装包进了更新缓存目录', existsSync(path.join(CACHE_DIR, 'pending', feed.name)));
  check('两个版本只差元信息，增量下载用上了旧版缓存（有 blockmap 留下）', existsSync(path.join(CACHE_DIR, 'current.blockmap')));

  // 4. 立即安装并重启：应用退出 → 安装程序静默升级 → 新版自动启动
  console.log('\n立即安装并重启…');
  await Promise.race([cdp.eval('window.emojiBridge.updateInstall()').catch(() => undefined), sleep(3000)]);
  cdp.close();
  await waitUntil(() => !isRunning(), 20000, '旧版退出');
  console.log('  旧版已退出，等待安装程序…');
  // 这是整条链路最关键的一步：安装程序真的把安装目录升级成了新版
  await waitUntil(() => exeVersion(exe) === newVersion, 120000, '安装目录变成新版');
  check('静默安装把安装目录升级成了新版', true, `版本 ${exeVersion(exe)}`);
  // 安装程序装完会（经资源管理器 ShellExecute）拉起新版。自动化会话里没有资源管理器代为启动，这里只作提示、不算失败；
  // 真实桌面上用户能看到应用自动打开。无论有没有自动拉起，都按下面手动启动一次核对升级结果。
  const relaunched = await waitUntil(() => isRunning(), 30000, '新版自动启动').catch(() => false);
  console.log(`  ${relaunched ? '✓ 新版自动重新启动了' : '· 这个会话里没有自动拉起（无资源管理器，属正常），手动启动核对'}`);
  // launchInstalled 会先清场（关掉任何自动拉起的实例）再用调试端口启动
  cdp = await launchInstalled();
  check('升级后能正常启动', true);
  const gridSize = await cdp.eval('window.__emojiStore.getState().settings.gridSize');
  check('升级后用户数据保留', gridSize === 'small', String(gridSize));
  check('新版启动后状态为空闲（没有待装的更新）', (await cdp.eval('window.emojiBridge.updateState().then(s => s.phase)')) === 'idle');
  await quitApp(cdp);
} catch (e) {
  results.failures++;
  console.error('\n测试中断：', e.message);
} finally {
  feedServer?.close();
  killAll();
  // 5. 静默卸载临时安装，清理测试版的数据目录、更新缓存，恢复协议登记
  const uninstaller = path.join(installDir, `Uninstall ${PRODUCT}.exe`);
  if (existsSync(uninstaller)) {
    console.log('\n卸载临时安装…');
    await run(uninstaller, ['/S', '/currentuser', `_?=${installDir}`]).catch(() => undefined);
    await sleep(1500);
  }
  rmSync(work, { recursive: true, force: true });
  rmSync(APPDATA_DIR, { recursive: true, force: true });
  rmSync(CACHE_DIR, { recursive: true, force: true });
  restoreProtocolHandler(protocolBefore);
  check('卸载后「程序和功能」里没有测试版残留', !uninstallEntryExists());
  check('协议处理程序已恢复', readProtocolHandler() === protocolBefore, readProtocolHandler());
}

console.log(results.failures === 0 ? '\n全部通过' : `\n${results.failures} 项失败`);
process.exit(results.failures === 0 ? 0 : 1);
