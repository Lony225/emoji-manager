/**
 * 表情包的导出 / 导入（zip）。
 *
 * 压缩包结构：
 *   manifest.json      清单，格式与订阅清单相同（docs/subscription-format.md），
 *                      所以解压后放到网上，manifest.json 的地址就能直接作为订阅使用
 *   images/<包>/<文件>   图片
 *
 * 分类 → 包（pack），子分类用 pack.group 记录父分类路径（“一级 / 二级 / …”，任意多级）；
 * 未分类的表情放在 key 为 "uncategorized" 的包里。名称、标签都写在清单里，导入时原样还原。
 */
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import type { Category, Sticker } from './types';
import { ManifestError, parseManifestText } from './subscription/manifest';
import { categoryLabel, categoryPath, flattenTree } from './selectors';

export const UNCATEGORIZED_KEY = 'uncategorized';
const ZIP_BASE = 'https://zip.local/';

export interface BuildPackageInput {
  stickers: Sticker[];
  categories: Category[];
  name: string;
  description?: string;
  appVersion: string;
  readFile: (rel: string) => Promise<Uint8Array | null>;
}

export interface BuildPackageResult {
  bytes: Uint8Array;
  count: number;
  packs: number;
  /** 读不到图片文件而跳过的表情 */
  missing: number;
}

export interface ManifestStickerJson {
  id: string;
  url: string;
  name: string;
  tags: string[];
}

export interface ManifestPackJson {
  key: string;
  name: string;
  group?: string;
  stickers: ManifestStickerJson[];
}

export interface PackageManifestJson {
  name: string;
  description?: string;
  version: string;
  generator: string;
  packs: ManifestPackJson[];
}

/** 变成只含 ASCII 的文件名片段；全是中文时返回空串，由调用方回退到序号 */
export function asciiSlug(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 40);
}

function unique(base: string, used: Set<string>): string {
  let name = base;
  let i = 2;
  while (used.has(name)) name = `${base}-${i++}`;
  used.add(name);
  return name;
}

/**
 * 只生成清单和文件布局，不读图片（方便测试）。
 * 返回每个表情在压缩包里的路径。
 */
export function planPackage(
  stickers: Sticker[],
  categories: Category[],
  name: string,
  appVersion: string,
  description?: string,
): { manifest: PackageManifestJson; paths: Map<string, string> } {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const groups = new Map<string | null, Sticker[]>();
  for (const s of stickers) {
    const key = s.categoryId !== null && byId.has(s.categoryId) ? s.categoryId : null;
    const list = groups.get(key) ?? [];
    list.push(s);
    groups.set(key, list);
  }

  // 包的顺序跟分类树一致，未分类放最后
  const order: (string | null)[] = flattenTree(categories)
    .map((n) => n.category.id)
    .filter((id) => groups.has(id));
  if (groups.has(null)) order.push(null);

  const usedFolders = new Set<string>();
  const paths = new Map<string, string>();
  const packs: ManifestPackJson[] = order.map((catId, i) => {
    const cat = catId ? byId.get(catId) : undefined;
    // group = 父分类路径“一级 / 二级 / …”（任意多级），没有父分类则不写
    const ancestors = cat ? categoryPath(categories, cat.id).slice(0, -1) : [];
    const parent = ancestors.length ? { name: ancestors.map((c) => c.name).join(' / ') } : undefined;
    const packName = cat ? cat.name : '未分类';
    const folder = unique(asciiSlug(packName) || `pack-${i + 1}`, usedFolders);
    const usedFiles = new Set<string>();
    const list = groups.get(catId) ?? [];
    return {
      key: cat ? cat.id : UNCATEGORIZED_KEY,
      name: packName,
      group: parent?.name,
      stickers: list.map((s, j) => {
        const file = `${unique(asciiSlug(s.name) || `sticker-${j + 1}`, usedFiles)}.${s.ext}`;
        const p = `images/${folder}/${file}`;
        paths.set(s.id, p);
        return { id: s.id, url: p, name: s.name, tags: s.tags };
      }),
    };
  });

  return {
    manifest: {
      name: name.trim() || '表情包',
      description,
      version: new Date().toISOString().slice(0, 10),
      generator: `Emoji Manager ${appVersion}`,
      packs,
    },
    paths,
  };
}

export async function buildPackage(input: BuildPackageInput): Promise<BuildPackageResult> {
  const { manifest, paths } = planPackage(input.stickers, input.categories, input.name, input.appVersion, input.description);
  const files: Zippable = {};
  let missing = 0;
  for (const s of input.stickers) {
    const p = paths.get(s.id);
    if (!p) continue;
    const bytes = await input.readFile(s.file);
    if (!bytes) {
      missing++;
      continue;
    }
    files[p] = [bytes, { level: 0 }]; // 图片本身已压缩，直接存储
  }
  if (missing > 0) {
    // 把读不到的从清单里去掉
    const gone = new Set(input.stickers.filter((s) => !files[paths.get(s.id) ?? '']).map((s) => s.id));
    for (const pack of manifest.packs) pack.stickers = pack.stickers.filter((st) => !gone.has(st.id));
    manifest.packs = manifest.packs.filter((pack) => pack.stickers.length > 0);
  }
  files['manifest.json'] = [strToU8(JSON.stringify(manifest, null, 2)), { level: 6 }];
  const bytes = zipSync(files);
  return { bytes, count: input.stickers.length - missing, packs: manifest.packs.length, missing };
}

// ---------------------------------------------------------------- 读取

export interface PackageSticker {
  fileName: string;
  bytes: Uint8Array;
  name: string;
  tags: string[];
}

export interface PackagePack {
  key: string;
  name: string;
  group?: string;
  /** 这个包里的表情不归入任何分类 */
  uncategorized: boolean;
  stickers: PackageSticker[];
}

export interface ParsedPackage {
  name: string;
  description?: string;
  packs: PackagePack[];
  /** 清单里提到但压缩包里没有的图片数量 */
  missing: number;
  total: number;
}

function pickManifestPath(names: string[]): string | undefined {
  const candidates = names
    .filter((n) => /(^|\/)manifest\.json$/i.test(n) && !/(^|\/)__MACOSX\//.test(n) && !/(^|\/)\._/.test(n))
    .sort((a, b) => a.split('/').length - b.split('/').length || a.length - b.length);
  return candidates[0];
}

export function readPackage(bytes: Uint8Array): ParsedPackage {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new Error('这不是有效的 zip 压缩包');
  }
  const manifestPath = pickManifestPath(Object.keys(files));
  if (!manifestPath) throw new Error('压缩包里没有 manifest.json，不是表情包文件');
  const dir = manifestPath.slice(0, manifestPath.length - 'manifest.json'.length);
  let manifest;
  try {
    manifest = parseManifestText(strFromU8(files[manifestPath]), ZIP_BASE + manifestPath);
  } catch (e) {
    const msg = e instanceof ManifestError ? e.message : String(e);
    throw new Error(`manifest.json 无效：${msg}`);
  }
  if (manifest.packRefs.length > 0) throw new Error('压缩包里的清单引用了外部子包，无法离线导入');

  const lookup = (url: string): { path: string; bytes: Uint8Array } | null => {
    if (!url.startsWith(ZIP_BASE)) return null;
    let p: string;
    try {
      p = decodeURIComponent(new URL(url).pathname.replace(/^\/+/, ''));
    } catch {
      return null;
    }
    const tries = [p, dir + p, p.replace(/^\.\//, '')];
    for (const t of tries) {
      const b = files[t];
      if (b && b.length > 0) return { path: t, bytes: b };
    }
    return null;
  };

  let missing = 0;
  let total = 0;
  const packs: PackagePack[] = manifest.packs.map((pack) => {
    const isRoot = pack.key === 'root';
    const stickers: PackageSticker[] = [];
    for (const rs of pack.stickers) {
      total++;
      const hit = lookup(rs.url);
      if (!hit) {
        missing++;
        continue;
      }
      stickers.push({
        fileName: hit.path.split('/').pop() ?? 'sticker',
        bytes: hit.bytes,
        name: rs.name,
        tags: Array.from(new Set([...pack.tags, ...rs.tags])),
      });
    }
    return {
      key: pack.key,
      name: isRoot ? manifest.name : pack.name,
      group: pack.group,
      uncategorized: pack.key === UNCATEGORIZED_KEY,
      stickers,
    };
  });

  return { name: manifest.name, description: manifest.description, packs, missing, total };
}

/** 导出对话框的默认名称 */
export function defaultPackageName(stickers: Sticker[], categories: Category[]): string {
  const cats = new Set(stickers.map((s) => s.categoryId));
  if (cats.size === 1) {
    const [only] = cats;
    if (only !== null) return categoryLabel(categories, only).replace(' / ', '-');
  }
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `表情包 ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
