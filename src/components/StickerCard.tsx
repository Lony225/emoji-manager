import { memo, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react';
import type { Sticker } from '../core/types';
import { maybeAnimated } from '../core/images';
import { useLibraryStore } from '../core/store';
import { useFileUrl } from '../ui/hooks';
import { useUiStore, type StampState } from '../ui/uiStore';
import { copyStickerWithFeedback, openStickerMenu, rangeSelect } from '../ui/actions';
import { Icon } from '../ui/icons';

interface Props {
  sticker: Sticker;
  selected: boolean;
  stamp?: StampState;
  animate: boolean;
  /** 在“全部”等视图里显示所属分类（“一级 / 二级”），在分类视图里不传 */
  categoryText?: string;
}

/** 动图在网格里不播放时，画出第一帧 */
function StaticFrame({ url, alt }: { url: string; alt: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      const c = ref.current;
      if (!c) return;
      c.width = img.naturalWidth || 1;
      c.height = img.naturalHeight || 1;
      c.getContext('2d')?.drawImage(img, 0, 0);
    };
    img.src = url;
  }, [url]);
  return <canvas ref={ref} role="img" aria-label={alt} />;
}

/** 就地改名的输入框 */
function NameEditor({ sticker }: { sticker: Sticker }) {
  const [value, setValue] = useState(sticker.name);
  const done = useRef(false);
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    if (save && value.trim() && value.trim() !== sticker.name) {
      useLibraryStore.getState().updateSticker(sticker.id, { name: value });
    }
    useUiStore.getState().setRenaming(null);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish(false);
    }
  };
  return (
    <input
      className="name-input"
      value={value}
      maxLength={80}
      autoFocus
      aria-label="表情名称"
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={onKeyDown}
      onBlur={() => finish(true)}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
    />
  );
}

export const StickerCard = memo(function StickerCard({ sticker, selected, stamp, animate, categoryText }: Props) {
  const url = useFileUrl(sticker.file);
  const showNames = useLibraryStore((s) => s.settings.showNames);
  const renaming = useUiStore((s) => s.renamingId === sticker.id);
  const [hover, setHover] = useState(false);
  const longPress = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressClick = useRef(false);

  const menuIds = () => {
    const sel = useUiStore.getState().selection;
    return sel.has(sticker.id) ? Array.from(sel) : [sticker.id];
  };

  const onClick = (e: MouseEvent) => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    const ui = useUiStore.getState();
    if (e.ctrlKey || e.metaKey) {
      ui.select([sticker.id], 'toggle');
      ui.setAnchor(sticker.id);
      return;
    }
    if (e.shiftKey) {
      rangeSelect(sticker.id);
      return;
    }
    void copyStickerWithFeedback(sticker);
  };

  const onCheck = (e: MouseEvent) => {
    e.stopPropagation();
    const ui = useUiStore.getState();
    if (e.shiftKey) rangeSelect(sticker.id);
    else {
      ui.select([sticker.id], 'toggle');
      ui.setAnchor(sticker.id);
    }
  };

  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    const ui = useUiStore.getState();
    // 右键一个未选中的表情时，把它设为当前选择，菜单里的操作才不会错位
    if (!ui.selection.has(sticker.id) && ui.selection.size > 0) ui.select([sticker.id], 'replace');
    openStickerMenu(e.clientX, e.clientY, menuIds());
  };

  // 触屏长按 = 右键（为以后的手机版准备）
  const onPointerDown = (e: PointerEvent) => {
    if (e.pointerType !== 'touch') return;
    const { clientX, clientY } = e;
    longPress.current = setTimeout(() => {
      suppressClick.current = true;
      openStickerMenu(clientX, clientY, menuIds());
    }, 480);
  };
  const cancelLongPress = () => {
    if (longPress.current) {
      clearTimeout(longPress.current);
      longPress.current = null;
    }
  };

  const showStatic = !animate && maybeAnimated(sticker.ext) && !hover;
  const titleLines = [sticker.name];
  if (categoryText) titleLines.push(`分类：${categoryText}`);
  if (sticker.tags.length) titleLines.push(sticker.tags.map((t) => '#' + t).join(' '));
  const title = titleLines.join('\n');
  const openCategory = (e: MouseEvent) => {
    e.stopPropagation();
    const ui = useUiStore.getState();
    if (!sticker.categoryId) {
      ui.setView({ kind: 'uncategorized' });
      return;
    }
    // 直接放在带子分类的分类里 → 打开它的“未分类”页签
    const cats = useLibraryStore.getState().categories;
    const hasChildren = cats.some((x) => x.parentId === sticker.categoryId);
    ui.setView({ kind: 'category', id: sticker.categoryId, own: hasChildren || undefined });
  };

  return (
    <div
      className={`card${selected ? ' selected' : ''}${showNames ? ' named' : ''}`}
      data-id={sticker.id}
      role="button"
      tabIndex={0}
      title={title}
      aria-label={sticker.name}
      onClick={onClick}
      onContextMenu={onContextMenu}
      onPointerDown={onPointerDown}
      onPointerUp={cancelLongPress}
      onPointerCancel={cancelLongPress}
      onPointerMove={cancelLongPress}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      onKeyDown={(e) => {
        if (renaming) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          void copyStickerWithFeedback(sticker);
        }
      }}
    >
      <div className="thumb">
        {url ? (
          showStatic ? (
            <StaticFrame url={url} alt={sticker.name} />
          ) : (
            <img src={url} alt={sticker.name} loading="lazy" decoding="async" draggable={false} />
          )
        ) : null}
        {sticker.favorite && <span className="fav-tab" aria-label="已收藏" />}
        <button type="button" className="check" aria-label={selected ? '取消选择' : '选择'} onClick={onCheck} tabIndex={-1}>
          {selected && <Icon name="check" size={13} strokeWidth={3} />}
        </button>
        {stamp && (
          <div className={`stamp ${stamp}`}>
            <span>{stamp === 'done' ? '已复制' : '复制中…'}</span>
          </div>
        )}
      </div>
      {(showNames || categoryText) &&
        (renaming ? (
          <NameEditor sticker={sticker} />
        ) : (
          // 一行：名称 / 分类（分类只显示最末一级，完整路径在提示里）
          <div className="name-row">
            {showNames && (
              <span
                className="name"
                title="点击改名"
                onClick={(e) => {
                  e.stopPropagation();
                  useUiStore.getState().setRenaming(sticker.id);
                }}
              >
                {sticker.name}
              </span>
            )}
            {showNames && categoryText && <span className="sep">/</span>}
            {categoryText && (
              <span
                className={`cat${sticker.categoryId && categoryText !== '未分类' ? '' : ' none'}`}
                title={
                  sticker.categoryId && categoryText === '未分类'
                    ? '直接放在这个一级分类里，还没有归入二级分类（右键 → 移动到分类）'
                    : `分类：${categoryText}（点击打开）`
                }
                onClick={openCategory}
              >
                {categoryText.includes(' / ') ? categoryText.slice(categoryText.lastIndexOf(' / ') + 3) : categoryText}
              </span>
            )}
          </div>
        ))}
    </div>
  );
});
