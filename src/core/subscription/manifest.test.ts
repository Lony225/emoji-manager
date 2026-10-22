import { describe, expect, it } from 'vitest';
import { ManifestError, normalizeTags, parseManifest, parseManifestText } from './manifest';

const BASE = 'https://cdn.example.com/packs/cats/pack.json';

describe('parseManifest', () => {
  it('解析最简清单：字符串和对象两种写法，相对地址按清单位置解析', () => {
    const m = parseManifest(
      {
        name: '猫猫',
        tags: ['猫', '#猫', ' 可爱 '],
        stickers: [
          'images/01.gif',
          { id: 'two', url: '/abs/02.png', name: '开心', tags: ['开心'] },
          { url: 'https://other.host/x.webp' },
        ],
      },
      BASE,
    );
    expect(m.name).toBe('猫猫');
    expect(m.packs).toHaveLength(1);
    expect(m.packRefs).toHaveLength(0);
    const pack = m.packs[0];
    expect(pack.key).toBe('root');
    expect(pack.tags).toEqual(['猫', '可爱']);
    expect(pack.stickers.map((s) => s.url)).toEqual([
      'https://cdn.example.com/packs/cats/images/01.gif',
      'https://cdn.example.com/abs/02.png',
      'https://other.host/x.webp',
    ]);
    // 没给 id 时用绝对地址当 id，名称取文件名
    expect(pack.stickers[0].remoteId).toBe('https://cdn.example.com/packs/cats/images/01.gif');
    expect(pack.stickers[0].name).toBe('01');
    expect(pack.stickers[1].remoteId).toBe('two');
    expect(pack.stickers[1].name).toBe('开心');
    expect(pack.stickers[1].tags).toEqual(['开心']);
  });

  it('名称缺省时用清单文件名', () => {
    const m = parseManifest({ stickers: ['a.png'] }, 'https://x.com/dir/funny-dogs.json');
    expect(m.name).toBe('funny-dogs');
  });

  it('同一包内重复的 id 只保留第一个', () => {
    const m = parseManifest({ stickers: [{ id: 'a', url: '1.png' }, { id: 'a', url: '2.png' }] }, BASE);
    expect(m.packs[0].stickers).toHaveLength(1);
    expect(m.packs[0].stickers[0].url).toContain('1.png');
  });

  it('支持多包：内联包和引用包，key 冲突自动加后缀', () => {
    const m = parseManifest(
      {
        name: '合集',
        stickers: ['root.png'],
        packs: [
          { name: '狗狗', stickers: ['dog.png'], tags: ['狗'] },
          { key: 'dogs', url: 'dogs/pack.json' },
          { name: '狗狗', stickers: ['dog2.png'] },
          { url: 'more.json' },
        ],
      },
      BASE,
    );
    expect(m.packs.map((p) => p.key)).toEqual(['root', '狗狗', '狗狗_']);
    expect(m.packRefs).toEqual([
      { key: 'dogs', url: 'https://cdn.example.com/packs/cats/dogs/pack.json' },
      { key: 'https://cdn.example.com/packs/cats/more.json', url: 'https://cdn.example.com/packs/cats/more.json' },
    ]);
  });

  it('拒绝不支持的协议', () => {
    expect(() => parseManifest({ stickers: ['file:///etc/passwd'] }, BASE)).toThrow(ManifestError);
    expect(() => parseManifest({ stickers: ['javascript:alert(1)'] }, BASE)).toThrow(ManifestError);
  });

  it('没有表情时报错', () => {
    expect(() => parseManifest({ name: 'x' }, BASE)).toThrow(/没有找到任何表情/);
    expect(() => parseManifest({ stickers: [] }, BASE)).toThrow(/没有找到任何表情/);
    expect(() => parseManifest([], BASE)).toThrow(ManifestError);
  });

  it('parseManifestText 处理 BOM 和无效 JSON', () => {
    const m = parseManifestText('﻿{"stickers":["a.png"]}', BASE);
    expect(m.packs[0].stickers).toHaveLength(1);
    expect(() => parseManifestText('<html>', BASE)).toThrow(/不是有效的 JSON/);
  });
});

describe('normalizeTags', () => {
  it('去重、去空、去掉井号', () => {
    expect(normalizeTags(['a', '#a', '', '  ', 'b', 3])).toEqual(['a', 'b']);
    expect(normalizeTags('nope')).toEqual([]);
  });
});
