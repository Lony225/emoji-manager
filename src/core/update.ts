/**
 * 检查更新：读取 GitHub Releases 的最新版本，和当前版本比较。
 * 不自动下载安装（未签名的应用做静默更新体验很差），只提示并给下载链接。
 *
 * 国内经常连不上 GitHub，所以：
 * - 检查版本按「GitHub 直连 → 公共加速站代理 API → jsDelivr 读仓库里的 package.json / CHANGELOG」三级回退
 * - 下载链接除了 GitHub 直连，还给出各加速站的地址（同一个文件，前面加上加速站前缀），弹窗里会实际探测哪个能用
 * - 加速站名单内置一份，同时从仓库的 docs/download-mirrors.json（经 jsDelivr）拉最新的：站点挂了改文件就行，不用发版
 */
import type { Platform } from '../platform/types';

export interface ReleaseAsset {
  name: string;
  url: string;
  size: number;
  /** GitHub 给出的校验值，如 sha256:… */
  digest?: string;
}

export type ReleaseSource = 'github' | 'mirror';

export interface LatestRelease {
  version: string;
  tag: string;
  name: string;
  notes: string;
  url: string;
  publishedAt?: string;
  assets: ReleaseAsset[];
  /** 版本信息是直接从 GitHub 拿的，还是经镜像 / 加速站拿的（后者说明 GitHub 可能连不上） */
  source?: ReleaseSource;
  /** 经哪个镜像拿的（主机名） */
  via?: string;
}

export interface UpdateCheckResult {
  current: string;
  latest: LatestRelease | null;
  /** 有比当前更新的版本 */
  available: boolean;
}

/** 公共 GitHub 加速站：把 GitHub 地址整个接在后面即可。2026-10-28 实测可用的几个；最新名单在 docs/download-mirrors.json */
export const DEFAULT_ACCELERATORS: readonly string[] = [
  'https://ghfast.top/',
  'https://gh-proxy.com/',
  'https://ghproxy.net/',
  'https://gh.llkk.cc/',
  'https://gh.nxnow.top/',
  'https://ghfile.geekertao.top/',
];

type Fetcher = Pick<Platform, 'fetchText'>;

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** "v1.2.3" / "1.2.3-beta.1" → [1,2,3]；解析不了返回 null */
export function parseVersion(v: string): number[] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/i.exec(v.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** a 比 b 新返回 1，旧返回 -1，一样返回 0；解析不了的当作最旧 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  }
  // 数字相同时，带预发布后缀（-beta 等）的更旧
  const preA = /-/.test(a);
  const preB = /-/.test(b);
  if (preA !== preB) return preA ? -1 : 1;
  return 0;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('返回的内容不是有效的 JSON');
  }
}

/** 把 GitHub API 返回的 release 对象整理成我们需要的形状 */
export function parseRelease(json: unknown): LatestRelease | null {
  if (!isRecord(json) || typeof json.tag_name !== 'string') return null;
  const tag = json.tag_name;
  const assets = Array.isArray(json.assets)
    ? json.assets
        .filter((a): a is Record<string, unknown> => isRecord(a) && typeof a.name === 'string' && typeof a.browser_download_url === 'string')
        .map((a) => ({
          name: a.name as string,
          url: a.browser_download_url as string,
          size: typeof a.size === 'number' ? a.size : 0,
          digest: typeof a.digest === 'string' ? a.digest : undefined,
        }))
    : [];
  return {
    version: tag.replace(/^v/i, ''),
    tag,
    name: typeof json.name === 'string' && json.name ? json.name : tag,
    notes: typeof json.body === 'string' ? json.body : '',
    url: typeof json.html_url === 'string' ? json.html_url : '',
    publishedAt: typeof json.published_at === 'string' ? json.published_at : undefined,
    assets,
  };
}

/** 按当前系统挑一个最合适的安装包；挑不到就用发布页 */
export function pickAsset(assets: ReleaseAsset[], os: Platform['os'], arch: string): ReleaseAsset | undefined {
  const byName = (re: RegExp) => assets.find((a) => re.test(a.name));
  if (os === 'windows') return byName(/win.*x64.*\.exe$/i) ?? byName(/\.exe$/i);
  if (os === 'mac') {
    const want = arch === 'arm64' ? /mac.*arm64.*\.dmg$/i : /mac.*x64.*\.dmg$/i;
    return byName(want) ?? byName(/\.dmg$/i);
  }
  if (os === 'linux') return byName(/\.AppImage$/i);
  if (os === 'android') return byName(/android.*\.apk$/i) ?? byName(/\.apk$/i);
  return undefined;
}

// ---------------------------------------------------------------- 加速站

/** 加速站地址 + 原地址 = 走加速站的地址 */
export function accelerated(prefix: string, url: string): string {
  return prefix + url;
}

/** 显示用：加速站的主机名 */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** 校验远端的加速站名单：只认 https://主机/（可带路径）的前缀，最多 12 个；不合格返回 null */
export function normalizeAccelerators(json: unknown): string[] | null {
  if (!isRecord(json) || !Array.isArray(json.accelerators)) return null;
  const list = json.accelerators.filter((s): s is string => typeof s === 'string' && /^https:\/\/[a-z0-9.-]+(?::\d+)?(?:\/[a-z0-9._-]+)*\/$/i.test(s));
  const uniq = Array.from(new Set(list)).slice(0, 12);
  return uniq.length ? uniq : null;
}

/** 名单文件的地址；带上当天的日期做查询参数，免得被 HTTP 缓存按 jsDelivr 给的 7 天 max-age 一直用旧的 */
export function mirrorListUrl(repo: string, now = new Date()): string {
  const d = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  return `https://cdn.jsdelivr.net/gh/${repo}@main/docs/download-mirrors.json?d=${d}`;
}

/** 从仓库拉最新的加速站名单（经 jsDelivr，国内可达）；拉不到用内置的 */
export async function loadAccelerators(platform: Fetcher, repo: string): Promise<string[]> {
  try {
    const res = await platform.fetchText(mirrorListUrl(repo), 8000);
    if (res.ok) {
      const list = normalizeAccelerators(parseJson(res.text));
      if (list) return list;
    }
  } catch {
    /* 用内置名单 */
  }
  return [...DEFAULT_ACCELERATORS];
}

/** 并行跑一组任务，谁先成功用谁；全失败时抛第一个错误 */
export function firstSuccess<T>(tasks: (() => Promise<T>)[]): Promise<T> {
  if (tasks.length === 0) return Promise.reject(new Error('没有可用的地址'));
  return new Promise<T>((resolve, reject) => {
    let pending = tasks.length;
    const errors: string[] = [];
    for (const task of tasks) {
      task().then(resolve, (e) => {
        errors.push(msg(e));
        if (--pending === 0) reject(new Error(errors[0]));
      });
    }
  });
}

/**
 * 探测各加速站此刻能不能代理 GitHub（拉该版本仓库里的 package.json，很小）。
 * 每个站有了结果就回调一次，弹窗据此标出可用 / 不可用。
 */
export function probeAccelerators(
  platform: Fetcher,
  repo: string,
  tag: string,
  accelerators: string[],
  onResult: (accelerator: string, ok: boolean) => void,
): void {
  const probe = `https://raw.githubusercontent.com/${repo}/${tag}/package.json`;
  for (const acc of accelerators) {
    platform.fetchText(accelerated(acc, probe), 8000).then(
      (r) => onResult(acc, r.ok && r.text.includes('"version"')),
      () => onResult(acc, false),
    );
  }
}

// ---------------------------------------------------------------- 没有 API 时的退路：按约定推断

/** CHANGELOG.md 里某个版本的小节（和 scripts/release-notes.mjs 同一套规则） */
export function changelogSection(text: string, version: string): string {
  const lines = text.split(/\r?\n/);
  const re = new RegExp(`^## v?${version.replace(/\./g, '\\.')}(\\s|$)`);
  const start = lines.findIndex((l) => re.test(l));
  if (start < 0) return '';
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join('\n').trim();
}

/** GitHub 会把附件名里的空格换成点 */
export function githubAssetName(name: string): string {
  return name.replace(/\s+/g, '.');
}

/** 拿不到 API 时按 CI 的命名约定拼出各平台安装包的地址（大小未知，填 0） */
export function syntheticAssets(repo: string, productName: string, version: string): ReleaseAsset[] {
  const base = `https://github.com/${repo}/releases/download/v${version}/`;
  const stem = githubAssetName(`${productName}-${version}`);
  return [`${stem}-win-x64.exe`, `${stem}-portable.exe`, `${stem}-mac-arm64.dmg`, `${stem}-mac-x64.dmg`, `${stem}-android.apk`].map((name) => ({
    name,
    url: base + name,
    size: 0,
  }));
}

// ---------------------------------------------------------------- 检查

export interface CheckOptions {
  /** 拼安装包文件名用（package.json 的 productName） */
  productName?: string;
  /** 加速站名单（GitHub 直连失败时才会用到，所以可以延迟加载） */
  getAccelerators?: () => Promise<string[]>;
  /** GitHub 直连的超时 */
  timeoutMs?: number;
}

function withSource(latest: LatestRelease, source: ReleaseSource, via?: string): LatestRelease {
  return { ...latest, source, via };
}

export async function checkForUpdate(platform: Fetcher, repo: string, currentVersion: string, opts: CheckOptions = {}): Promise<UpdateCheckResult> {
  if (!repo || repo.includes('OWNER')) throw new Error('还没有配置 GitHub 仓库地址');
  const api = `https://api.github.com/repos/${repo}/releases/latest`;
  const done = (latest: LatestRelease): UpdateCheckResult => ({
    current: currentVersion,
    latest,
    available: compareVersions(latest.version, currentVersion) > 0,
  });
  const errors: string[] = [];

  // 1. GitHub 直连
  try {
    const res = await platform.fetchText(api, opts.timeoutMs ?? 12000);
    if (res.status === 404) return { current: currentVersion, latest: null, available: false };
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const latest = parseRelease(parseJson(res.text));
    if (!latest) throw new Error('无法识别发布信息');
    return done(withSource(latest, 'github'));
  } catch (e) {
    errors.push(`GitHub：${msg(e)}`);
  }

  // 2. 加速站代理 GitHub API（并行，谁先成功用谁）
  const accelerators = opts.getAccelerators ? await opts.getAccelerators().catch(() => [...DEFAULT_ACCELERATORS]) : [...DEFAULT_ACCELERATORS];
  try {
    const latest = await firstSuccess(
      accelerators.map((acc) => async () => {
        const res = await platform.fetchText(accelerated(acc, api), 8000);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const r = parseRelease(parseJson(res.text));
        if (!r) throw new Error('不是发布信息');
        return withSource(r, 'mirror', hostOf(acc));
      }),
    );
    return done(latest);
  } catch (e) {
    errors.push(`加速站：${msg(e)}`);
  }

  // 3. jsDelivr：@latest 解析到最新的标签，读 package.json 拿版本号，读 CHANGELOG 拿说明；安装包地址按约定拼
  try {
    const pkgRes = await platform.fetchText(`https://cdn.jsdelivr.net/gh/${repo}@latest/package.json`, 10000);
    if (!pkgRes.ok) throw new Error(`HTTP ${pkgRes.status}`);
    const pkg = parseJson(pkgRes.text);
    const version = isRecord(pkg) && typeof pkg.version === 'string' ? pkg.version : '';
    if (!parseVersion(version)) throw new Error('读不到版本号');
    const tag = `v${version}`;
    let notes = '';
    try {
      const ch = await platform.fetchText(`https://cdn.jsdelivr.net/gh/${repo}@${tag}/CHANGELOG.md`, 10000);
      if (ch.ok) notes = changelogSection(ch.text, version);
    } catch {
      /* 没有说明也能提示 */
    }
    const productName = typeof pkg === 'object' && pkg && typeof (pkg as Record<string, unknown>).productName === 'string' ? ((pkg as Record<string, unknown>).productName as string) : (opts.productName ?? 'Emoji Manager');
    return done({
      version,
      tag,
      name: tag,
      notes,
      url: `https://github.com/${repo}/releases/tag/${tag}`,
      assets: syntheticAssets(repo, productName, version),
      source: 'mirror',
      via: 'jsDelivr',
    });
  } catch (e) {
    errors.push(`jsDelivr：${msg(e)}`);
  }

  throw new Error(`GitHub 和镜像都连不上（${errors.join('；')}）`);
}
