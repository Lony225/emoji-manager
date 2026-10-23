import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { useLibraryStore } from '../core/store';
import { useUiStore } from '../ui/uiStore';
import { filterStickers, topCategories, type View } from '../core/selectors';
import type { Sticker } from '../core/types';
import { platform } from '../platform';
import { copyStickerWithFeedback, setAfterCopyHook } from '../ui/actions';
import { useFileUrl, useTheme } from '../ui/hooks';
import { Icon } from '../ui/icons';
import { ContextMenu } from '../components/ContextMenu';
import { Toasts } from '../components/Toasts';

const PIN_KEY = 'float.pinned';

function loadPinned(): boolean {
  try {
    return localStorage.getItem(PIN_KEY) === '1';
  } catch {
    return false;
  }
}

function viewKey(v: View): string {
  return 'id' in v ? `${v.kind}:${v.id}${'own' in v && v.own ? ':own' : ''}` : v.kind;
}

interface CardProps {
  sticker: Sticker;
  focused: boolean;
  onCopy: (s: Sticker) => void;
}

/** 浮窗里的表情格：只负责显示和点击复制，没有多选 */
const FloatCard = memo(function FloatCard({ sticker, focused, onCopy }: CardProps) {
  const url = useFileUrl(sticker.file);
  const thumbUrl = useFileUrl(sticker.thumb ?? '');
  const [hover, setHover] = useState(false);
  // 浮窗平时显示缩略图（省资源），悬停时才播放动图
  const src = sticker.thumb && thumbUrl && !hover ? thumbUrl : url;
  const stamp = useUiStore((s) => s.stamps[sticker.id]);
  const openMenu = useUiStore((s) => s.openMenu);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [focused]);

  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    const caps = platform.capabilities;
    openMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: '复制图片', icon: 'copy', onSelect: () => void copyStickerWithFeedback(sticker, 'image') },
        ...(caps.copyFile
          ? [{ label: '复制文件', icon: 'file' as const, onSelect: () => void copyStickerWithFeedback(sticker, 'file') }]
          : []),
        { label: '', separator: true },
        { label: '在主窗口中打开', icon: 'window', onSelect: () => void platform.showMain() },
      ],
    });
  };

  return (
    <div
      ref={ref}
      className={`card${focused ? ' selected' : ''}`}
      role="button"
      tabIndex={-1}
      title={sticker.tags.length ? `${sticker.name}\n${sticker.tags.map((t) => '#' + t).join(' ')}` : sticker.name}
      aria-label={sticker.name}
      onClick={() => onCopy(sticker)}
      onContextMenu={onContextMenu}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
    >
      <div className="thumb">
        {url && <img src={src} alt={sticker.name} loading="lazy" decoding="async" draggable={false} />}
        {sticker.favorite && <span className="fav-tab" aria-label="已收藏" />}
        {stamp && (
          <div className={`stamp ${stamp}`}>
            <span>{stamp === 'done' ? '已复制' : '复制中…'}</span>
          </div>
        )}
      </div>
    </div>
  );
});

let shownHookInstalled = false;

export function FloatApp() {
  const loaded = useLibraryStore((s) => s.loaded);
  const stickers = useLibraryStore((s) => s.stickers);
  const categories = useLibraryStore((s) => s.categories);
  const usage = useLibraryStore((s) => s.usage);
  const [query, setQuery] = useState('');
  const [view, setView] = useState<View | null>(null);
  const [focus, setFocus] = useState(0);
  const [pinned, setPinned] = useState(loadPinned);
  const inputRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const shownAt = useRef(0);
  const pinnedRef = useRef(pinned);
  pinnedRef.current = pinned;

  useTheme();
  useEffect(() => {
    void useLibraryStore.getState().load();
  }, []);

  const hasRecent = useMemo(() => stickers.some((s) => usage[s.id]), [stickers, usage]);
  const hasFav = useMemo(() => stickers.some((s) => s.favorite), [stickers]);
  // 浮窗的页签只列一级分类（点进去包含它的二级分类）
  const cats = useMemo(() => topCategories(categories), [categories]);

  // 默认标签页：有最近使用看最近，否则看收藏，再否则看全部
  const effectiveView: View = view ?? (hasRecent ? { kind: 'recent' } : hasFav ? { kind: 'favorites' } : { kind: 'all' });
  const searching = query.trim() !== '';
  const list = useMemo(
    () =>
      filterStickers(
        stickers,
        { view: searching ? { kind: 'all' } : effectiveView, tags: [], query, sort: 'newest' },
        usage,
        categories,
      ),
    [stickers, effectiveView, query, searching, usage, categories],
  );

  // 列表变了就把焦点收回范围内
  useEffect(() => {
    setFocus((f) => Math.min(f, Math.max(0, list.length - 1)));
  }, [list.length]);

  const hide = useCallback(() => void platform.hideFloat(), []);

  const copy = useCallback((s: Sticker) => {
    void copyStickerWithFeedback(s);
  }, []);

  // 复制成功后：未固定时稍等片刻让盖章显示出来，然后隐藏
  useEffect(() => {
    setAfterCopyHook(() => {
      if (!pinnedRef.current) setTimeout(hide, 450);
    });
    return () => setAfterCopyHook(null);
  }, [hide]);

  // 被呼出时：清空搜索、聚焦输入框
  useEffect(() => {
    if (shownHookInstalled) return;
    shownHookInstalled = true;
    platform.onFloatShown(() => {
      shownAt.current = Date.now();
      setQuery('');
      setFocus(0);
      setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 30);
    });
  }, []);

  // 失去焦点就藏起来（固定时不藏；刚显示出来的瞬间忽略，避免抢焦点失败导致闪退）
  useEffect(() => {
    const onBlur = () => {
      if (pinnedRef.current) return;
      if (Date.now() - shownAt.current < 500) return;
      if (useUiStore.getState().menu) return;
      hide();
    };
    window.addEventListener('blur', onBlur);
    return () => window.removeEventListener('blur', onBlur);
  }, [hide]);

  const togglePin = () => {
    const next = !pinned;
    setPinned(next);
    try {
      localStorage.setItem(PIN_KEY, next ? '1' : '0');
    } catch {
      /* 忽略 */
    }
  };

  const columns = () => {
    const el = gridRef.current;
    if (!el) return 1;
    return Math.max(1, getComputedStyle(el).gridTemplateColumns.split(' ').length);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const n = list.length;
    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        if (query) setQuery('');
        else hide();
        break;
      case 'Enter':
        e.preventDefault();
        if (n > 0) copy(list[Math.min(focus, n - 1)]);
        break;
      case 'ArrowRight':
        if (n > 0 && (e.currentTarget.selectionStart ?? 0) >= query.length) {
          e.preventDefault();
          setFocus((f) => Math.min(n - 1, f + 1));
        }
        break;
      case 'ArrowLeft':
        if (n > 0 && focus > 0 && (e.currentTarget.selectionStart ?? 0) === 0) {
          e.preventDefault();
          setFocus((f) => Math.max(0, f - 1));
        }
        break;
      case 'ArrowDown':
        e.preventDefault();
        if (n > 0) setFocus((f) => Math.min(n - 1, f + columns()));
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (n > 0) setFocus((f) => Math.max(0, f - columns()));
        break;
      case 'Tab': {
        // Tab 在标签页之间切换
        e.preventDefault();
        const tabs = tabList();
        const idx = tabs.findIndex((t) => viewKey(t.view) === viewKey(effectiveView));
        const next = tabs[(idx + (e.shiftKey ? tabs.length - 1 : 1)) % tabs.length];
        setView(next.view);
        setFocus(0);
        break;
      }
      default:
        break;
    }
  };

  const tabList = (): { view: View; label: string }[] => [
    { view: { kind: 'recent' }, label: '最近' },
    { view: { kind: 'favorites' }, label: '收藏' },
    { view: { kind: 'all' }, label: '全部' },
    ...cats.map((c) => ({ view: { kind: 'category', id: c.id } as View, label: c.name })),
  ];

  if (!loaded) return <div className="load-screen">正在加载…</div>;

  let emptyText = '';
  if (stickers.length === 0) emptyText = '还没有表情。打开主窗口导入图片或添加订阅。';
  else if (list.length === 0 && searching) emptyText = '没有匹配的表情';
  else if (list.length === 0 && effectiveView.kind === 'recent') emptyText = '复制过的表情会出现在这里';
  else if (list.length === 0 && effectiveView.kind === 'favorites') emptyText = '还没有收藏的表情';
  else if (list.length === 0) emptyText = '这个分类是空的';

  return (
    <div className="float">
      <div className="float-bar">
        <span className="brand-mark">
          <Icon name="smile" size={15} strokeWidth={2.2} />
        </span>
        <span className="float-title">表情</span>
        <span className="spacer" />
        <button
          className={`btn ghost icon-only sm${pinned ? ' active' : ''}`}
          title={pinned ? '已固定：复制后和失去焦点时都保持显示' : '未固定：复制后自动隐藏。点击固定'}
          aria-label={pinned ? '取消固定' : '固定浮窗'}
          aria-pressed={pinned}
          onClick={togglePin}
        >
          <Icon name={pinned ? 'pin' : 'pinOff'} size={15} />
        </button>
        <button className="btn ghost icon-only sm" title="打开主窗口" aria-label="打开主窗口" onClick={() => void platform.showMain()}>
          <Icon name="window" size={15} />
        </button>
        <button className="btn ghost icon-only sm" title="隐藏（Esc）" aria-label="隐藏浮窗" onClick={hide}>
          <Icon name="x" size={15} />
        </button>
      </div>

      <div className="float-search search">
        <Icon name="search" className="icon" size={15} />
        <input
          ref={inputRef}
          type="search"
          autoFocus
          value={query}
          placeholder="搜索表情…"
          aria-label="搜索表情"
          onChange={(e) => {
            setQuery(e.target.value);
            setFocus(0);
          }}
          onKeyDown={onKeyDown}
        />
      </div>

      <div className={`float-tabs${searching ? ' muted' : ''}`} role="tablist">
        {tabList().map((t) => {
          const active = !searching && viewKey(t.view) === viewKey(effectiveView);
          return (
            <button
              key={viewKey(t.view)}
              role="tab"
              aria-selected={active}
              className={`chip${active ? ' active' : ''}`}
              onClick={() => {
                setQuery('');
                setView(t.view);
                setFocus(0);
                inputRef.current?.focus();
              }}
            >
              <span className="label">{t.label}</span>
            </button>
          );
        })}
      </div>

      <div className="float-scroll">
        {list.length === 0 ? (
          <div className="float-empty">
            {emptyText}
            {stickers.length === 0 && (
              <button className="btn sm" onClick={() => void platform.showMain()}>
                打开主窗口
              </button>
            )}
          </div>
        ) : (
          <div ref={gridRef} className="grid float-grid">
            {list.map((s, i) => (
              <FloatCard key={s.id} sticker={s} focused={i === focus} onCopy={copy} />
            ))}
          </div>
        )}
      </div>

      <div className="float-foot">
        {searching ? <span>在全部表情中搜索</span> : <span>{list.length} 个</span>}
        <span className="spacer" />
        <span>
          <kbd>↵</kbd> 复制 <kbd>Tab</kbd> 切换 <kbd>Esc</kbd> 隐藏
        </span>
      </div>

      <ContextMenu />
      <Toasts />
    </div>
  );
}
