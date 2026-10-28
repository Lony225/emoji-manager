import { describe, expect, it } from 'vitest';
import { parseInline, parseNotes } from './notesMarkdown';

describe('发布说明 Markdown', () => {
  it('行内：加粗、代码、链接、普通文字', () => {
    expect(parseInline('**浮窗**：`Alt+Shift+E` 呼出，见 [文档](https://x.y/z)')).toEqual([
      { kind: 'bold', children: [{ kind: 'text', text: '浮窗' }] },
      { kind: 'text', text: '：' },
      { kind: 'code', text: 'Alt+Shift+E' },
      { kind: 'text', text: ' 呼出，见 ' },
      { kind: 'link', text: '文档', url: 'https://x.y/z' },
    ]);
    // 没闭合的标记按原样当文字
    expect(parseInline('a ** b ` c [d](x)')).toEqual([{ kind: 'text', text: 'a ** b ` c [d](x)' }]);
  });

  it('块：标题、列表、段落、分隔线', () => {
    const md = '## v1.3.0 - 2026-10-25\n\n### 新功能\n\n- **用模板做表情**：顶栏新增「制作」\n- 第二条\n\n### 其他\n\n一段说明文字\n第二行接上\n\n---\n未签名的安装包';
    const blocks = parseNotes(md);
    expect(blocks.map((b) => b.kind)).toEqual(['heading', 'heading', 'list', 'heading', 'paragraph', 'rule', 'paragraph']);
    expect(blocks[0]).toMatchObject({ kind: 'heading', level: 2 });
    expect(blocks[1]).toMatchObject({ kind: 'heading', level: 3, children: [{ kind: 'text', text: '新功能' }] });
    const list = blocks[2];
    if (list.kind !== 'list') throw new Error('不是列表');
    expect(list.ordered).toBe(false);
    expect(list.items).toHaveLength(2);
    expect(list.items[0].children[0]).toEqual({ kind: 'bold', children: [{ kind: 'text', text: '用模板做表情' }] });
    expect(blocks[4]).toMatchObject({ kind: 'paragraph', children: [{ kind: 'text', text: '一段说明文字 第二行接上' }] });
  });

  it('嵌套列表与有序列表', () => {
    const blocks = parseNotes('1. 一\n2. 二\n   - 二甲\n   - 二乙\n3. 三');
    expect(blocks).toHaveLength(1);
    const list = blocks[0];
    if (list.kind !== 'list') throw new Error('不是列表');
    expect(list.ordered).toBe(true);
    expect(list.items.map((i) => i.children[0])).toEqual([
      { kind: 'text', text: '一' },
      { kind: 'text', text: '二' },
      { kind: 'text', text: '三' },
    ]);
    expect(list.items[1].sub?.items.map((i) => i.children[0])).toEqual([
      { kind: 'text', text: '二甲' },
      { kind: 'text', text: '二乙' },
    ]);
    expect(list.items[0].sub).toBeUndefined();
  });

  it('列表项的缩进续行并入上一项', () => {
    const blocks = parseNotes('- 第一项很长\n  接着写\n- 第二项');
    const list = blocks[0];
    if (list.kind !== 'list') throw new Error('不是列表');
    expect(list.items).toHaveLength(2);
    expect(list.items[0].children.map((c) => (c.kind === 'text' ? c.text : '?')).join('')).toBe('第一项很长 接着写');
  });

  it('空内容与 Windows 换行', () => {
    expect(parseNotes('')).toEqual([]);
    expect(parseNotes('\r\n\r\n')).toEqual([]);
    expect(parseNotes('# 标题\r\n- 项').map((b) => b.kind)).toEqual(['heading', 'list']);
  });
});
