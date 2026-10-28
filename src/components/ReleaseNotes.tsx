import { useMemo } from 'react';
import { parseNotes, type Block, type Inline, type ListItem } from '../core/notesMarkdown';
import { platform } from '../platform';

function Inlines({ nodes }: { nodes: Inline[] }) {
  return (
    <>
      {nodes.map((n, i) => {
        switch (n.kind) {
          case 'bold':
            return (
              <strong key={i}>
                <Inlines nodes={n.children} />
              </strong>
            );
          case 'code':
            return <code key={i}>{n.text}</code>;
          case 'link':
            return (
              <a
                key={i}
                href={n.url}
                title={n.url}
                onClick={(e) => {
                  e.preventDefault();
                  void platform.openExternal(n.url);
                }}
              >
                {n.text}
              </a>
            );
          default:
            return <span key={i}>{n.text}</span>;
        }
      })}
    </>
  );
}

function List({ ordered, items }: { ordered: boolean; items: ListItem[] }) {
  const Tag = ordered ? 'ol' : 'ul';
  return (
    <Tag>
      {items.map((item, i) => (
        <li key={i}>
          <Inlines nodes={item.children} />
          {item.sub && <List ordered={item.sub.ordered} items={item.sub.items} />}
        </li>
      ))}
    </Tag>
  );
}

function BlockView({ block }: { block: Block }) {
  switch (block.kind) {
    case 'heading': {
      const Tag = block.level === 1 ? 'h1' : block.level === 2 ? 'h2' : 'h3';
      return (
        <Tag>
          <Inlines nodes={block.children} />
        </Tag>
      );
    }
    case 'list':
      return <List ordered={block.ordered} items={block.items} />;
    case 'rule':
      return <hr />;
    default:
      return (
        <p>
          <Inlines nodes={block.children} />
        </p>
      );
  }
}

/** 更新弹窗里的发布说明：按 Markdown 结构渲染（标题 / 列表 / 加粗 / 代码 / 链接） */
export function ReleaseNotes({ markdown }: { markdown: string }) {
  const blocks = useMemo(() => parseNotes(markdown), [markdown]);
  if (blocks.length === 0) return null;
  return (
    <div className="notes">
      {blocks.map((b, i) => (
        <BlockView key={i} block={b} />
      ))}
    </div>
  );
}
