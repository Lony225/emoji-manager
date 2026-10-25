import { describe, expect, it } from 'vitest';
import type { MemeTemplate } from '../platform/types';
import {
  checkImageCount,
  clampOptionValue,
  defaultOptionValues,
  describeRequirements,
  filterTemplates,
  matchesQuery,
  resolveTexts,
  templateKind,
  topTags,
} from './memeTemplates';

function tpl(patch: Partial<MemeTemplate>): MemeTemplate {
  return {
    key: 'petpet',
    keywords: ['摸', '摸摸'],
    tags: [],
    minImages: 1,
    maxImages: 1,
    minTexts: 0,
    maxTexts: 0,
    defaultTexts: [],
    options: [],
    shortcuts: [],
    dateCreated: '',
    dateModified: '',
    ...patch,
  };
}

describe('模板表情工具', () => {
  it('按需要的图片 / 文字分类并描述', () => {
    expect(templateKind(tpl({}))).toBe('image');
    expect(templateKind(tpl({ maxImages: 0, minTexts: 1, maxTexts: 1 }))).toBe('text');
    expect(templateKind(tpl({ minTexts: 0, maxTexts: 1 }))).toBe('mixed');
    expect(describeRequirements(tpl({}))).toBe('需要 1 张图片');
    expect(describeRequirements(tpl({ minImages: 1, maxImages: 2, minTexts: 0, maxTexts: 1 }))).toBe('需要 1~2 张图片、0~1 段文字');
    expect(describeRequirements(tpl({ minImages: 0, maxImages: 0 }))).toBe('不需要图片和文字');
  });

  it('选项默认值与范围', () => {
    const t = tpl({
      options: [
        { name: 'circle', type: 'boolean', default: false, description: null, minimum: null, maximum: null },
        { name: 'size', type: 'integer', default: 50, description: null, minimum: 20, maximum: 100 },
        { name: 'font', type: 'string', default: null, description: null, minimum: null, maximum: null },
      ],
    });
    expect(defaultOptionValues(t)).toEqual({ circle: false, size: 50 });
    const size = t.options[1];
    expect(clampOptionValue(size, 150)).toBe(100);
    expect(clampOptionValue(size, '7')).toBe(20);
    expect(clampOptionValue(size, 33.7)).toBe(34);
    expect(clampOptionValue(size, 'abc')).toBe(50);
    expect(clampOptionValue({ ...size, type: 'float', minimum: 1, maximum: 10, default: 2 }, 3.25)).toBe(3.25);
  });

  it('搜索关键词、标签、快捷指令', () => {
    const t = tpl({ tags: ['原神'], shortcuts: [{ pattern: '胡桃吃', humanized: '胡桃吃' }] });
    expect(matchesQuery(t, '摸')).toBe(true);
    expect(matchesQuery(t, '原')).toBe(true);
    expect(matchesQuery(t, '胡桃')).toBe(true);
    expect(matchesQuery(t, 'PET')).toBe(true);
    expect(matchesQuery(t, '狗')).toBe(false);
    expect(matchesQuery(t, '  ')).toBe(true);
    const list = [t, tpl({ key: 'good_news', keywords: ['喜报'], maxImages: 0, minTexts: 1, maxTexts: 1, tags: ['原神', '文字'] })];
    expect(filterTemplates(list, { query: '', kind: 'text', tag: '' }).map((x) => x.key)).toEqual(['good_news']);
    expect(filterTemplates(list, { query: '', kind: 'all', tag: '原神' })).toHaveLength(2);
    expect(filterTemplates(list, { query: '喜', kind: 'all', tag: '' }).map((x) => x.key)).toEqual(['good_news']);
    expect(topTags(list, 5)).toEqual([
      { tag: '原神', count: 2 },
      { tag: '文字', count: 1 },
    ]);
  });

  it('整理文字：补默认值、去掉多余空行、数量校验', () => {
    const t = tpl({ maxImages: 0, minTexts: 1, maxTexts: 2, defaultTexts: ['喜报'] });
    expect(resolveTexts(t, [' 测试 ', ''])).toEqual(['测试']);
    expect(resolveTexts(t, [''])).toEqual(['喜报']);
    expect(resolveTexts(t, [])).toEqual(['喜报']);
    expect(resolveTexts(t, ['a', 'b'])).toEqual(['a', 'b']);
    expect(() => resolveTexts(t, ['a', 'b', 'c'])).toThrow('最多只能填 2 段文字');
    const noDefault = tpl({ maxImages: 0, minTexts: 2, maxTexts: 2 });
    expect(() => resolveTexts(noDefault, ['只有一段'])).toThrow('请填写文字');
  });

  it('图片数量校验', () => {
    expect(checkImageCount(tpl({}), 0)).toBe('请先选一张图片');
    expect(checkImageCount(tpl({}), 1)).toBeNull();
    expect(checkImageCount(tpl({ minImages: 2, maxImages: 5 }), 1)).toBe('还需要 1 张图片（共 2 张）');
    expect(checkImageCount(tpl({ minImages: 1, maxImages: 2 }), 3)).toBe('最多只能用 2 张图片');
  });
});
