// 打安卓 APK：vite build → cap sync android → gradlew assembleRelease → 拷到 release/
//
// 用法：node scripts/build-android.mjs [--debug] [--dev] [--out <目录>] [--skip-web]
//   --debug     打调试包（assembleDebug），默认打 release 包
//   --dev       文件名加 -dev-<日期> 后缀（本地自测用，不和正式发布的包混淆）
//   --out       输出目录（默认 release/）
//   --skip-web  不重新构建网页（dist/ 已经是最新时省时间）
//
// 需要：Android SDK（ANDROID_HOME，或 android/local.properties 的 sdk.dir，否则在常见位置找）、
//       JDK 21+（EMOJI_ANDROID_JAVA_HOME，或版本够的 JAVA_HOME，否则找 Android Studio 自带的 jbr）。
// 签名：android/keystore.properties（见 README）；没有就用调试签名，装上手机能用，但不能和正式包互相覆盖安装。
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const debug = flag('--debug');
const dev = flag('--dev');
const outDir = option('--out') ?? 'release';
const win = process.platform === 'win32';
const home = os.homedir();

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

function die(msg) {
  console.error(`\n${msg}`);
  process.exit(1);
}

function run(cmd, cmdArgs, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, { stdio: 'inherit', shell: win, ...opts });
  if (r.status !== 0) die(`命令失败：${cmd} ${cmdArgs.join(' ')}`);
}

/** JDK 主版本号；读不到返回 0 */
function javaMajor(javaHome) {
  try {
    const m = /JAVA_VERSION="(\d+)/.exec(readFileSync(path.join(javaHome, 'release'), 'utf8'));
    if (m) return Number(m[1]);
  } catch {
    /* 没有 release 文件就跑一下 java -version */
  }
  const r = spawnSync(path.join(javaHome, 'bin', win ? 'java.exe' : 'java'), ['-version'], { encoding: 'utf8' });
  const m = /version "(\d+)/.exec(`${r.stderr ?? ''}${r.stdout ?? ''}`);
  return m ? Number(m[1]) : 0;
}

function studioJbrCandidates() {
  if (win) {
    const drives = ['C', 'D', 'E', 'F', 'G'];
    return [
      path.join(process.env.ProgramFiles ?? 'C:/Program Files', 'Android/Android Studio/jbr'),
      path.join(process.env.LOCALAPPDATA ?? path.join(home, 'AppData/Local'), 'Programs/Android Studio/jbr'),
      ...drives.flatMap((d) => [`${d}:/Android/Android Studio/jbr`, `${d}:/Program Files/Android/Android Studio/jbr`]),
    ];
  }
  if (process.platform === 'darwin') {
    return ['/Applications/Android Studio.app/Contents/jbr', path.join(home, 'Applications/Android Studio.app/Contents/jbr')];
  }
  return ['/opt/android-studio/jbr', '/usr/local/android-studio/jbr', path.join(home, 'android-studio/jbr')];
}

function findJdk() {
  const candidates = [process.env.EMOJI_ANDROID_JAVA_HOME, process.env.JAVA_HOME, ...studioJbrCandidates()].filter(Boolean);
  for (const c of candidates) {
    if (existsSync(c) && javaMajor(c) >= 21) return c;
  }
  die('需要 JDK 21 或更新来编译安卓工程：安装 Android Studio（自带 jbr），或把 EMOJI_ANDROID_JAVA_HOME 指向一个 JDK 21。');
}

function sdkCandidates() {
  if (win) {
    const local = process.env.LOCALAPPDATA ?? path.join(home, 'AppData/Local');
    return [path.join(local, 'Android/Sdk'), ...['C', 'D', 'E', 'F', 'G'].flatMap((d) => [`${d}:/Android/Sdk`, `${d}:/Android/sdk`])];
  }
  if (process.platform === 'darwin') return [path.join(home, 'Library/Android/sdk')];
  return [path.join(home, 'Android/Sdk'), '/opt/android-sdk'];
}

/** 找到 SDK 目录；android/local.properties 没有就写一个 */
function findSdk() {
  const localProps = path.join('android', 'local.properties');
  const fromEnv = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  let sdk = fromEnv && existsSync(fromEnv) ? fromEnv : undefined;
  if (!sdk && existsSync(localProps)) {
    const m = /^sdk\.dir=(.+)$/m.exec(readFileSync(localProps, 'utf8'));
    if (m) {
      const p = m[1].trim().replace(/\\\\/g, '\\').replace(/\\:/g, ':');
      if (existsSync(p)) sdk = p;
    }
  }
  if (!sdk) sdk = sdkCandidates().find((c) => existsSync(path.join(c, 'platform-tools')) || existsSync(path.join(c, 'platforms')));
  if (!sdk) die('没有找到 Android SDK：设置 ANDROID_HOME，或在 android/local.properties 里写 sdk.dir=…');
  if (!existsSync(localProps)) writeFileSync(localProps, `sdk.dir=${sdk.replace(/\\/g, '/')}\n`);
  return sdk;
}

// ---------------------------------------------------------------- 开始

if (!flag('--skip-web')) run('pnpm', ['exec', 'vite', 'build']);
run('pnpm', ['exec', 'cap', 'sync', 'android']);

const jdk = findJdk();
const sdk = findSdk();
const keystoreProps = process.env.EMOJI_ANDROID_KEYSTORE_PROPERTIES ?? path.join('android', 'keystore.properties');
console.log(`\nJDK：${jdk}\nSDK：${sdk}\n签名：${existsSync(keystoreProps) ? keystoreProps : '（没有 keystore.properties，用调试签名）'}\n`);

const variant = debug ? 'debug' : 'release';
const gradlew = path.resolve('android', win ? 'gradlew.bat' : 'gradlew');
run(win ? `"${gradlew}"` : gradlew, [debug ? 'assembleDebug' : 'assembleRelease'], {
  cwd: path.resolve('android'),
  env: { ...process.env, JAVA_HOME: jdk, ANDROID_HOME: sdk },
});

const built = path.join('android', 'app', 'build', 'outputs', 'apk', variant, `app-${variant}.apk`);
if (!existsSync(built)) die(`没有找到构建产物：${built}`);
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const name = `${pkg.productName}-${pkg.version}-android${debug ? '-debug' : ''}${dev ? `-dev-${stamp}` : ''}.apk`;
const target = path.join(outDir, name);
copyFileSync(built, target);
console.log(`\n安卓安装包：${target}`);
