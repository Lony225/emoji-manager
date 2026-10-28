/**
 * 发布说明（CHANGELOG 里的那种 Markdown）→ 结构化的块，供更新弹窗渲染。
 * 只认我们自己会写的那几种：标题、列表（可嵌套）、段落、加粗、行内代码、链接。
 * 不生成 HTML 字符串，界面层按块和行内片段用 React 组件渲染，不会有注入问题。
 */

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'bold'; children: Inline[] }
  | { kind: 'code'; text: string }
  | { kind: 'link'; text: string; url: string };

export type Block =
  | { kind: 'heading'; level: 1 | 2 | 3; children: Inline[] }
  | { kind: 'paragraph'; children: Inline[] }
  | { kind: 'list'; ordered: boolean; items: ListItem[] }
  | { kind: 'rule' };

export interface ListItem {
  children: Inline[];
  /** 缩进更深的子列表 */
  sub?: Block & { kind: 'list' };
}

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const BULLET = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;

/** 解析行内标记：**加粗**、`代码`、[文字](地址)；其余按纯文本 */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let buf = '';
  const flush = () => {
    if (buf) out.push({ kind: 'text', text: buf });
    buf = '';
  };
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    if (rest.startsWith('**')) {
      const end = rest.indexOf('**', 2);
      if (end > 2) {
        flush();
        out.push({ kind: 'bold', children: parseInline(rest.slice(2, end)) });
        i += end + 2;
        continue;
      }
    }
    if (rest.startsWith('`')) {
      const end = rest.indexOf('`', 1);
      if (end > 1) {
        flush();
        out.push({ kind: 'code', text: rest.slice(1, end) });
        i += end + 1;
        continue;
      }
    }
    if (rest.startsWith('[')) {
      const m = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/.exec(rest);
      if (m) {
        flush();
        out.push({ kind: 'link', text: m[1], url: m[2] });
        i += m[0].length;
        continue;
      }
    }
    buf += text[i];
    i++;
  }
  flush();
  return out;
}

interface Frame {
  indent: number;
  list: Block & { kind: 'list' };
}

/** 按行解析成块；列表按缩进（每级 2 个以上空格）嵌套 */
export function parseNotes(md: string): Block[] {
  const blocks: Block[] = [];
  const lines = md.replace(/\r/g, '').split('\n');
  let stack: Frame[] = [];
  let para: string[] = [];

  const flushPara = () => {
    if (para.length) blocks.push({ kind: 'paragraph', children: parseInline(para.join(' ')) });
    para = [];
  };
  const closeLists = () => {
    stack = [];
  };

  for (const raw of lines) {
    const line = raw.replace(/\t/g, '  ');
    if (!line.trim()) {
      flushPara();
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      flushPara();
      closeLists();
      const level = Math.min(3, h[1].length) as 1 | 2 | 3;
      blocks.push({ kind: 'heading', level, children: parseInline(h[2]) });
      continue;
    }
    if (RULE.test(line)) {
      flushPara();
      closeLists();
      blocks.push({ kind: 'rule' });
      continue;
    }
    const b = BULLET.exec(line);
    if (b) {
      flushPara();
      const indent = b[1].length;
      const ordered = /\d/.test(b[2]);
      // 回到和这一行同级（或更浅）的那一层
      while (stack.length && stack[stack.length - 1].indent > indent) stack.pop();
      const top = stack[stack.length - 1];
      if (!top || top.indent < indent) {
        const list: Block & { kind: 'list' } = { kind: 'list', ordered, items: [] };
        if (top) {
          // 挂到上一层最后一项下面
          const parent = top.list.items[top.list.items.length - 1];
          if (parent) parent.sub = list;
          else blocks.push(list);
        } else {
          blocks.push(list);
        }
        stack.push({ indent, list });
      }
      stack[stack.length - 1].list.items.push({ children: parseInline(b[3]) });
      continue;
    }
    // 列表项的续行（缩进的普通文字）并入上一项
    const top = stack[stack.length - 1];
    if (top && /^\s+/.test(line)) {
      const last = top.list.items[top.list.items.length - 1];
      if (last) {
        last.children.push({ kind: 'text', text: ' ' }, ...parseInline(line.trim()));
        continue;
      }
    }
    closeLists();
    para.push(line.trim());
  }
  flushPara();
  return blocks;
}
