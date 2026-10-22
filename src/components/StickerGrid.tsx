import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { Sticker } from '../core/types';
import { useLibraryStore } from '../core/store';
import { useUiStore } from '../ui/uiStore';
import { categoryLabel, descendantIds } from '../core/selectors';
import { setVisibleOrder } from '../ui/actions';
import { StickerCard } from './StickerCard';

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Drag {
  /** 起点（滚动内容坐标） */
  x: number;
  y: number;
  /** 按住 Ctrl / Shift 开始框选时，保留原来的选择 */
  base: Set<string>;
  active: boolean;
  client: { x: number; y: number };
}

const DRAG_THRESHOLD = 4;
const EDGE = 28;

export function StickerGrid({ stickers }: { stickers: Sticker[] }) {
  const selection = useUiStore((s) => s.selection);
  const stamps = useUiStore((s) => s.stamps);
  const clearSelection = useUiStore((s) => s.clearSelection);
  const gridSize = useLibraryStore((s) => s.settings.gridSize);
  const animate = useLibraryStore((s) => s.settings.animateInGrid);
  const categories = useLibraryStore((s) => s.categories);
  const view = useUiStore((s) => s.filter.view);
  /**
   * 每个表情下方标出所属分类：
   * - 全部 / 最近 / 收藏 / 未分类：显示“一级 / 二级”
   * - 分类的“全部”页签：显示所在子分类（完整路径在提示里）；直接放在该分类里的标“未分类”（对应顶部的“未分类”页签）
   * - “未分类”页签、没有子分类的分类：不用标
   */
  const labels = useMemo(() => {
    if (view.kind !== 'category') return new Map(categories.map((c) => [c.id, categoryLabel(categories, c.id)]));
    if (view.own) return null;
    const descendants = descendantIds(categories, view.id);
    if (descendants.length === 0) return null;
    const map = new Map(descendants.map((id) => [id, categoryLabel(categories, id)]));
    map.set(view.id, '');
    return map;
  }, [categories, view]);
  const textFor = (s: Sticker): string | undefined => {
    if (!labels) return undefined;
    if (s.categoryId === null) return view.kind === 'category' ? undefined : '未分类';
    const t = labels.get(s.categoryId);
    if (t === undefined) return view.kind === 'category' ? undefined : '未分类';
    return t === '' ? '未分类' : t;
  };
  const scrollRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const raf = useRef(0);
  /** 框选刚结束时紧跟着的 click 不能当作“点空白取消选择” */
  const dragEndedAt = useRef(0);
  const [box, setBox] = useState<Box | null>(null);

  useEffect(() => {
    setVisibleOrder(stickers.map((s) => s.id));
  }, [stickers]);

  /** 把客户区坐标换成滚动内容坐标 */
  const toContent = (clientX: number, clientY: number) => {
    const el = scrollRef.current!;
    const r = el.getBoundingClientRect();
    return { x: clientX - r.left + el.scrollLeft, y: clientY - r.top + el.scrollTop };
  };

  /** 根据当前框的范围更新选择 */
  const update = () => {
    const d = drag.current;
    const el = scrollRef.current;
    if (!d || !el) return;
    const cur = toContent(d.client.x, d.client.y);
    const x1 = Math.min(d.x, cur.x);
    const y1 = Math.min(d.y, cur.y);
    const x2 = Math.max(d.x, cur.x);
    const y2 = Math.max(d.y, cur.y);
    setBox({ x: x1, y: y1, w: x2 - x1, h: y2 - y1 });
    const r = el.getBoundingClientRect();
    const hits: string[] = [];
    el.querySelectorAll<HTMLElement>('.card[data-id]').forEach((card) => {
      const cr = card.getBoundingClientRect();
      const l = cr.left - r.left + el.scrollLeft;
      const t = cr.top - r.top + el.scrollTop;
      if (l < x2 && l + cr.width > x1 && t < y2 && t + cr.height > y1) hits.push(card.dataset.id!);
    });
    useUiStore.getState().select([...d.base, ...hits], 'replace');
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || e.pointerType === 'touch') return;
    // 从表情、按钮、输入框上按下的不算框选
    if ((e.target as HTMLElement).closest('.card, button, input, a')) return;
    const el = scrollRef.current!;
    const start = toContent(e.clientX, e.clientY);
    const additive = e.ctrlKey || e.metaKey || e.shiftKey;
    drag.current = {
      ...start,
      base: additive ? new Set(useUiStore.getState().selection) : new Set(),
      active: false,
      client: { x: e.clientX, y: e.clientY },
    };
    el.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    const el = scrollRef.current;
    if (!d || !el) return;
    d.client = { x: e.clientX, y: e.clientY };
    if (!d.active) {
      const cur = toContent(e.clientX, e.clientY);
      if (Math.hypot(cur.x - d.x, cur.y - d.y) < DRAG_THRESHOLD) return;
      d.active = true;
      useUiStore.getState().closeMenu();
    }
    // 拖到边缘时自动滚动
    const r = el.getBoundingClientRect();
    if (e.clientY > r.bottom - EDGE) el.scrollTop += 14;
    else if (e.clientY < r.top + EDGE) el.scrollTop -= 14;
    if (!raf.current) {
      raf.current = requestAnimationFrame(() => {
        raf.current = 0;
        update();
      });
    }
  };

  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    if (d.active) {
      dragEndedAt.current = Date.now();
      update();
    }
    drag.current = null;
    setBox(null);
    try {
      scrollRef.current?.releasePointerCapture(e.pointerId);
    } catch {
      /* 已经释放 */
    }
  };

  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  return (
    <div
      ref={scrollRef}
      className="grid-scroll"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onClick={(e) => {
        if (Date.now() - dragEndedAt.current < 300) return;
        const t = e.target as HTMLElement;
        if (t === e.currentTarget || t.classList.contains('grid')) clearSelection();
      }}
    >
      <div className={`grid${selection.size > 0 ? ' selecting' : ''}`} data-size={gridSize}>
        {stickers.map((s) => (
          <StickerCard
            key={s.id}
            sticker={s}
            selected={selection.has(s.id)}
            stamp={stamps[s.id]}
            animate={animate}
            categoryText={textFor(s)}
          />
        ))}
      </div>
      {box && <div className="marquee" style={{ left: box.x, top: box.y, width: box.w, height: box.h }} />}
    </div>
  );
}
