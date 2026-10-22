/**
 * 检查更新：读取 GitHub Releases 的最新版本，和当前版本比较。
 * 不自动下载安装（未签名的应用做静默更新体验很差），只提示并给下载链接。
 */
import type { Platform } from '../platform/types';

export interface ReleaseAsset {
  name: string;
  url: string;
  size: number;
}

export interface LatestRelease {
  version: string;
  tag: string;
  name: string;
  notes: string;
  url: string;
  publishedAt?: string;
  assets: ReleaseAsset[];
}

export interface UpdateCheckResult {
  current: string;
  latest: LatestRelease | null;
  /** 有比当前更新的版本 */
  available: boolean;
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

/** 把 GitHub API 返回的 release 对象整理成我们需要的形状 */
export function parseRelease(json: unknown): LatestRelease | null {
  if (!isRecord(json) || typeof json.tag_name !== 'string') return null;
  const tag = json.tag_name;
  const assets = Array.isArray(json.assets)
    ? json.assets
        .filter((a): a is Record<string, unknown> => isRecord(a) && typeof a.name === 'string' && typeof a.browser_download_url === 'string')
        .map((a) => ({ name: a.name as string, url: a.browser_download_url as string, size: typeof a.size === 'number' ? a.size : 0 }))
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
  return undefined;
}

export async function checkForUpdate(
  platform: Pick<Platform, 'fetchText'>,
  repo: string,
  currentVersion: string,
): Promise<UpdateCheckResult> {
  if (!repo || repo.includes('OWNER')) throw new Error('还没有配置 GitHub 仓库地址');
  const res = await platform.fetchText(`https://api.github.com/repos/${repo}/releases/latest`, 15000);
  if (res.status === 404) return { current: currentVersion, latest: null, available: false };
  if (!res.ok) throw new Error(`GitHub 返回 HTTP ${res.status}`);
  let json: unknown;
  try {
    json = JSON.parse(res.text);
  } catch {
    throw new Error('GitHub 返回的内容不是有效的 JSON');
  }
  const latest = parseRelease(json);
  if (!latest) throw new Error('无法识别发布信息');
  return { current: currentVersion, latest, available: compareVersions(latest.version, currentVersion) > 0 };
}

/** 把 Markdown 发布说明简化成可直接显示的纯文本 */
export function plainNotes(md: string): string {
  return md
    .replace(/\r/g, '')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^\s*[-*]\s+/gm, '• ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
