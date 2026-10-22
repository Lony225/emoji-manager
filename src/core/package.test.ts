import { describe, expect, it } from 'vitest';
import { strFromU8, unzipSync, zipSync, strToU8 } from 'fflate';
import type { Category, Sticker } from './types';
import { asciiSlug, buildPackage, planPackage, readPackage } from './package';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

const cats: Category[] = [
  { id: 'p', name: '动物', createdAt: 0, order: 0 },
  { id: 'c', name: '猫猫', createdAt: 0, order: 1, parentId: 'p' },
  { id: 'g', name: '橘猫', createdAt: 0, order: 0, parentId: 'c' },
];

function sticker(id: string, name: string, categoryId: string | null, tags: string[] = []): Sticker {
  return {
    id,
    name,
    file: `stickers/${id}.png`,
    ext: 'png',
    size: PNG.length,
    categoryId,
    tags,
    favorite: false,
    createdAt: 0,
    updatedAt: 0,
    source: { type: 'local' },
  };
}

const stickers = [
  sticker('s1', '开心', 'c', ['开心', '猫']),
  sticker('s2', '开心', 'c'), // 同名：文件名要去重
  sticker('s3', 'Happy Dog', 'p'),
  sticker('s4', '散的', null, ['杂']),
  sticker('s5', '三级', 'g'),
];

describe('导出 / 导入表情包', () => {
  it('asciiSlug 只保留 ASCII', () => {
    expect(asciiSlug('Happy Dog!')).toBe('happy-dog');
    expect(asciiSlug('开心')).toBe('');
    expect(asciiSlug('猫 cat 2')).toBe('cat-2');
  });

  it('planPackage：分类变成包，子分类的 group 是父分类路径，未分类单独成包，路径全 ASCII 且唯一', () => {
    const { manifest, paths } = planPackage(stickers, cats, '我的表情', '0.1.0');
    expect(manifest.packs.map((p) => [p.name, p.group ?? null])).toEqual([
      ['动物', null],
      ['猫猫', '动物'],
      ['橘猫', '动物 / 猫猫'],
      ['未分类', null],
    ]);
    expect(manifest.packs[3].key).toBe('uncategorized');
    const all = Array.from(paths.values());
    expect(new Set(all).size).toBe(5);
    for (const p of all) expect(p).toMatch(/^images\/[a-z0-9-]+\/[a-z0-9-]+\.png$/);
    const cat = manifest.packs[1];
    expect(cat.stickers.map((s) => s.name)).toEqual(['开心', '开心']);
    expect(cat.stickers[0].tags).toEqual(['开心', '猫']);
  });

  it('buildPackage → readPackage 往返保留名称、标签、分类结构', async () => {
    const built = await buildPackage({
      stickers,
      categories: cats,
      name: '我的表情',
      description: '测试',
      appVersion: '0.1.0',
      readFile: async (rel) => (rel === 'stickers/s3.png' ? null : PNG), // s3 读不到
    });
    expect(built).toMatchObject({ count: 4, missing: 1 });
    const entries = unzipSync(built.bytes);
    expect(Object.keys(entries)).toContain('manifest.json');
    const manifest = JSON.parse(strFromU8(entries['manifest.json']));
    expect(manifest.name).toBe('我的表情');
    expect(manifest.generator).toMatch(/Emoji Manager/);
    // 读不到图片的 s3 所在的“动物”包没有表情了，被整体去掉
    expect(manifest.packs.map((p: { name: string }) => p.name)).toEqual(['猫猫', '橘猫', '未分类']);

    const pkg = readPackage(built.bytes);
    expect(pkg.name).toBe('我的表情');
    expect(pkg.missing).toBe(0);
    expect(pkg.total).toBe(4);
    expect(pkg.packs.map((p) => [p.name, p.group ?? null, p.uncategorized, p.stickers.length])).toEqual([
      ['猫猫', '动物', false, 2],
      ['橘猫', '动物 / 猫猫', false, 1],
      ['未分类', null, true, 1],
    ]);
    expect(pkg.packs[0].stickers[0]).toMatchObject({ name: '开心', tags: ['开心', '猫'] });
    expect(pkg.packs[0].stickers[0].bytes).toEqual(PNG);
  });

  it('readPackage 兼容手写的订阅清单（根级 stickers）和子目录里的 manifest', () => {
    const zip = zipSync({
      'pack/manifest.json': strToU8(JSON.stringify({ name: '手写包', tags: ['手'], stickers: ['a.png', { url: 'sub/b.png', name: '乙' }, 'missing.png'] })),
      'pack/a.png': PNG,
      'pack/sub/b.png': PNG,
      '__MACOSX/pack/._manifest.json': strToU8('junk'),
    });
    const pkg = readPackage(zip);
    expect(pkg.name).toBe('手写包');
    expect(pkg.packs).toHaveLength(1);
    expect(pkg.packs[0]).toMatchObject({ name: '手写包', uncategorized: false });
    expect(pkg.packs[0].stickers.map((s) => s.name)).toEqual(['a', '乙']);
    expect(pkg.packs[0].stickers[1].tags).toEqual(['手']);
    expect(pkg.missing).toBe(1);
  });

  it('无效压缩包给出明确错误', () => {
    expect(() => readPackage(new Uint8Array([1, 2, 3]))).toThrow(/zip/);
    expect(() => readPackage(zipSync({ 'a.png': PNG }))).toThrow(/manifest\.json/);
    expect(() => readPackage(zipSync({ 'manifest.json': strToU8('{"stickers":[]}') }))).toThrow(/无效/);
  });
});
