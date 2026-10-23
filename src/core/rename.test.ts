import { describe, expect, it } from 'vitest';
import type { Sticker } from './types';
import { DEFAULT_RENAME, planRename } from './rename';

function sticker(id: string, name: string): Sticker {
  return { id, name, file: `stickers/${id}.png`, ext: 'png', size: 1, categoryId: null, tags: [], favorite: false, createdAt: 0, updatedAt: 0, source: { type: 'local' } };
}
const list = [sticker('a', '开心 Cat'), sticker('b', '哭哭 cat'), sticker('c', '无语')];

describe('批量改名规则', () => {
  it('统一名称加序号，可指定起始和补零', () => {
    expect(planRename(list, { ...DEFAULT_RENAME, mode: 'number', base: '猫猫' })).toEqual([
      { id: 'a', name: '猫猫 1' },
      { id: 'b', name: '猫猫 2' },
      { id: 'c', name: '猫猫 3' },
    ]);
    expect(planRename(list, { ...DEFAULT_RENAME, mode: 'number', base: '猫猫', start: 9, digits: 3 }).map((r) => r.name)).toEqual(['猫猫 009', '猫猫 010', '猫猫 011']);
    expect(planRename(list, { ...DEFAULT_RENAME, mode: 'number', base: '  ' })).toEqual([]);
  });

  it('前缀后缀', () => {
    expect(planRename(list, { ...DEFAULT_RENAME, mode: 'affix', prefix: '[猫] ', suffix: '!' }).map((r) => r.name)).toEqual(['[猫] 开心 Cat!', '[猫] 哭哭 cat!', '[猫] 无语!']);
    expect(planRename(list, { ...DEFAULT_RENAME, mode: 'affix' })).toEqual([]);
  });

  it('查找替换：普通文本默认忽略大小写，可用正则；没变化的不算', () => {
    expect(planRename(list, { ...DEFAULT_RENAME, mode: 'replace', find: 'cat', replaceWith: '猫' })).toEqual([
      { id: 'a', name: '开心 猫' },
      { id: 'b', name: '哭哭 猫' },
    ]);
    expect(planRename(list, { ...DEFAULT_RENAME, mode: 'replace', find: 'cat', replaceWith: '猫', caseInsensitive: false })).toEqual([{ id: 'b', name: '哭哭 猫' }]);
    expect(planRename(list, { ...DEFAULT_RENAME, mode: 'replace', find: '(\\S+) (\\S+)', replaceWith: '$2-$1', useRegex: true }).map((r) => r.name)).toEqual(['Cat-开心', 'cat-哭哭']);
    expect(planRename(list, { ...DEFAULT_RENAME, mode: 'replace', find: '(', useRegex: true })).toEqual([]); // 非法正则 → 不改
    expect(planRename(list, { ...DEFAULT_RENAME, mode: 'replace', find: '.', replaceWith: '' })).toEqual([]); // 点作为普通文本，没匹配到
  });

  it('逐个指定；空名字和没变的忽略', () => {
    expect(planRename(list, { ...DEFAULT_RENAME, mode: 'manual', manual: { a: '新 a', b: '   ', c: '无语' } })).toEqual([{ id: 'a', name: '新 a' }]);
  });
});
