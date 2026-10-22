import { Fragment, useMemo, useState, type DragEvent, type MouseEvent } from 'react';
import { CATEGORY_DRAG_TYPE, dropPosFor, isNoop, resolveDrop, type DropPos } from '../ui/categoryDnd';
import { useLibraryStore } from '../core/store';
import { useUiStore } from '../ui/uiStore';
import {
  categoryCountsWithChildren,
  categoryIdsIncludingChildren,
  categoryTree,
  sameView,
  subscriptionCounts,
  tagCounts,
  type CategoryNode,
  type View,
} from '../core/selectors';
import type { Category, Subscription } from '../core/types';
import { errorMessage } from '../core/subscription/sync';
import { exportCategory } from '../ui/actions';
import { useNarrow, syncSummary } from '../ui/hooks';
import { Icon, Spinner, type IconName } from '../ui/icons';

const TAG_LIMIT = 30;

export function Sidebar() {
  const stickers = useLibraryStore((s) => s.stickers);
  const categories = useLibraryStore((s) => s.categories);
  const subscriptions = useLibraryStore((s) => s.subscriptions);
  const syncStatus = useLibraryStore((s) => s.syncStatus);
  const usage = useLibraryStore((s) => s.usage);
  const view = useUiStore((s) => s.filter.view);
  const activeTags = useUiStore((s) => s.filter.tags);
  const setView = useUiStore((s) => s.setView);
  const toggleTag = useUiStore((s) => s.toggleTag);
  const openDialog = useUiStore((s) => s.openDialog);
  const openMenu = useUiStore((s) => s.openMenu);
  const toast = useUiStore((s) => s.toast);
  const sidebarOpen = useUiStore((s) => s.sidebarOpen);
  const setSidebarOpen = useUiStore((s) => s.setSidebarOpen);
  const narrow = useNarrow();
  const [showAllTags, setShowAllTags] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  /** 正在拖动的分类 */
  const [dragId, setDragId] = useState<string | null>(null);
  /** 指针悬停的目标行与放法 */
  const [over, setOver] = useState<{ id: string; pos: DropPos } | null>(null);

  const treeCounts = useMemo(() => categoryCountsWithChildren(stickers, categories), [stickers, categories]);
  const tree = useMemo(() => categoryTree(categories), [categories]);
  const favCount = useMemo(() => stickers.filter((s) => s.favorite).length, [stickers]);
  const recentCount = useMemo(() => stickers.filter((s) => usage[s.id]).length, [stickers, usage]);
  const uncategorized = useMemo(() => stickers.filter((s) => s.categoryId === null).length, [stickers]);
  const subCounts = useMemo(() => subscriptionCounts(stickers), [stickers]);
  const tags = useMemo(() => tagCounts(stickers), [stickers]);
  const lib = useLibraryStore.getState;

  const toggleCollapsed = (id: string) =>
    setCollapsed((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // ---------------------------------------------------------------- 拖拽
  const onDragStart = (e: DragEvent, c: Category) => {
    e.dataTransfer.setData(CATEGORY_DRAG_TYPE, c.id);
    e.dataTransfer.effectAllowed = 'move';
    setDragId(c.id);
  };
  const onDragOver = (e: DragEvent, c: Category) => {
    if (!dragId) return;
    const pos = dropPosFor(e.clientY, e.currentTarget.getBoundingClientRect());
    const target = resolveDrop(categories, dragId, c.id, pos);
    if (!target) {
      setOver((o) => (o?.id === c.id ? null : o));
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setOver((o) => (o?.id === c.id && o.pos === pos ? o : { id: c.id, pos }));
  };
  const onDragLeave = (e: DragEvent, c: Category) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setOver((o) => (o?.id === c.id ? null : o));
  };
  const finishDrag = () => {
    setDragId(null);
    setOver(null);
  };
  const onDrop = (e: DragEvent, c: Category) => {
    e.preventDefault();
    const id = dragId ?? e.dataTransfer.getData(CATEGORY_DRAG_TYPE);
    finishDrag();
    if (!id) return;
    const pos = dropPosFor(e.clientY, e.currentTarget.getBoundingClientRect());
    const target = resolveDrop(categories, id, c.id, pos);
    if (!target || isNoop(categories, id, target)) return;
    try {
      lib().reorderCategory(id, target.parentId, target.index);
      if (target.parentId) {
        setCollapsed((s) => {
          const next = new Set(s);
          next.delete(target.parentId!);
          return next;
        });
      }
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };
  /** 列表末尾的落点：拖到这里成为最后一个一级分类 */
  const onDropToEnd = (e: DragEvent) => {
    e.preventDefault();
    const id = dragId ?? e.dataTransfer.getData(CATEGORY_DRAG_TYPE);
    finishDrag();
    if (!id) return;
    const target = { parentId: null, index: categories.filter((c) => !c.parentId && c.id !== id).length };
    if (isNoop(categories, id, target)) return;
    try {
      lib().reorderCategory(id, null, target.index);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };
  const dragging = dragId ? categories.find((c) => c.id === dragId) : undefined;
  // 订阅里的表情包分类固定在订阅分类下，不能拖成一级
  const canDropToEnd = !!dragging && !(dragging.subscriptionId && dragging.packKey && dragging.packKey !== 'root');
  const dropClass = (id: string) => (over?.id === id ? ` drop-${over.pos}` : '') + (dragId === id ? ' dragging' : '');

  // ---------------------------------------------------------------- 菜单
  const item = (v: View, label: string, count: number, icon: IconName, extraClass = '') => (
    <button className={`side-item${sameView(view, v) ? ' active' : ''}`} onClick={() => setView(v)}>
      <Icon name={icon} size={16} className={`icon ${extraClass}`} />
      <span className="label">{label}</span>
      <span className="count num">{count}</span>
    </button>
  );

  const newCategory = (parent?: Category) =>
    openDialog({
      kind: 'prompt',
      title: parent ? `在“${parent.name}”下新建子分类` : '新建分类',
      placeholder: parent ? '子分类名称' : '分类名称',
      value: '',
      confirmText: '创建',
      onSubmit: (v) => {
        try {
          setView({ kind: 'category', id: lib().addCategory(v, parent?.id ?? null).id });
        } catch (err) {
          toast(errorMessage(err), 'error');
        }
      },
    });

  const categoryMenu = (e: MouseEvent, cat: Category) => {
    e.preventDefault();
    const n = treeCounts.get(cat.id) ?? 0;
    const descendants = categoryIdsIncludingChildren(categories, cat.id).length - 1;
    const isPack = !!cat.subscriptionId && !!cat.packKey && cat.packKey !== 'root';
    const sub = cat.subscriptionId ? subscriptions.find((s) => s.id === cat.subscriptionId) : undefined;
    openMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        // 订阅生成的分类：直接在这里同步整个订阅
        ...(sub
          ? [
              {
                label: `立即同步“${sub.name}”`,
                icon: 'sync' as const,
                disabled: !!syncStatus[sub.id]?.running,
                onSelect: () =>
                  void lib()
                    .syncSubscription(sub.id)
                    .then((r) => toast(syncSummary(r), r.failed ? 'error' : 'success'))
                    .catch((err) => toast(errorMessage(err), 'error')),
              },
              { label: '', separator: true },
            ]
          : []),
        {
          label: '重命名…',
          icon: 'edit',
          onSelect: () =>
            openDialog({ kind: 'prompt', title: '重命名分类', value: cat.name, onSubmit: (v) => lib().renameCategory(cat.id, v) }),
        },
        { label: '新建子分类…', icon: 'plus', onSelect: () => newCategory(cat) },
        { label: '上移', icon: 'arrowUp', onSelect: () => lib().moveCategory(cat.id, -1) },
        { label: '下移', icon: 'arrowDown', onSelect: () => lib().moveCategory(cat.id, 1) },
        ...(!isPack
          ? [
              {
                label: cat.parentId ? '移到别的分类下 / 设为一级…' : '放到某个分类下…',
                icon: 'folder' as const,
                onSelect: () => openDialog({ kind: 'categoryParent', id: cat.id }),
              },
            ]
          : []),
        { label: '导出这个分类…', icon: 'download', disabled: n === 0, onSelect: () => exportCategory(cat.id) },
        { label: '', separator: true },
        {
          label: '删除分类…',
          icon: 'trash',
          danger: true,
          onSelect: () =>
            openDialog({
              kind: 'confirm',
              title: `删除分类“${cat.name}”？`,
              message:
                (descendants ? `它下面的 ${descendants} 个子分类会一起删除。` : '') +
                (n ? `里面共有 ${n} 个表情。不勾选下面的选项时，表情会保留到“未分类”。` : '这个分类是空的。'),
              confirmText: '删除',
              danger: true,
              checkbox: n ? { label: `同时删除里面的 ${n} 个表情`, checked: false } : undefined,
              onConfirm: async (del) => {
                await lib().deleteCategory(cat.id, del);
                if (view.kind === 'category') setView({ kind: 'all' });
              },
            }),
        },
      ],
    });
  };

  const subscriptionMenu = (e: MouseEvent, sub: Subscription) => {
    e.preventDefault();
    openMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          label: '立即同步',
          icon: 'sync',
          disabled: !!syncStatus[sub.id]?.running,
          onSelect: () =>
            void lib()
              .syncSubscription(sub.id)
              .then((r) => toast(syncSummary(r), r.failed ? 'error' : 'success'))
              .catch((err) => toast(errorMessage(err), 'error')),
        },
        { label: '管理订阅…', icon: 'rss', onSelect: () => openDialog({ kind: 'subscriptions' }) },
      ],
    });
  };

  const tagMenu = (e: MouseEvent, tag: string) => {
    e.preventDefault();
    openMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          label: '重命名…',
          icon: 'edit',
          onSelect: () =>
            openDialog({ kind: 'prompt', title: `重命名标签 #${tag}`, value: tag, onSubmit: (v) => lib().renameTag(tag, v) }),
        },
        {
          label: '删除标签',
          icon: 'trash',
          danger: true,
          onSelect: () =>
            openDialog({
              kind: 'confirm',
              title: `删除标签 #${tag}？`,
              message: '会从所有表情上移除这个标签，表情本身不会删除。',
              confirmText: '删除',
              danger: true,
              onConfirm: () => lib().deleteTag(tag),
            }),
        },
      ],
    });
  };

  // ---------------------------------------------------------------- 分类树（递归渲染，任意深度）
  const activeInside = (node: CategoryNode): boolean =>
    node.children.some((ch) => sameView(view, { kind: 'category', id: ch.category.id }) || activeInside(ch));

  const renderNode = (node: CategoryNode, depth: number) => {
    const c = node.category;
    const hasChildren = node.children.length > 0;
    const open = !collapsed.has(c.id) || activeInside(node);
    return (
      <Fragment key={c.id}>
        <button
          className={`side-item${depth ? ' child' : ''}${sameView(view, { kind: 'category', id: c.id }) ? ' active' : ''}${dropClass(c.id)}`}
          style={depth ? { paddingLeft: 10 + depth * 18 } : undefined}
          title="拖动可调整顺序；拖到某个分类上可变成它的子分类"
          draggable
          onDragStart={(e) => onDragStart(e, c)}
          onDragOver={(e) => onDragOver(e, c)}
          onDragLeave={(e) => onDragLeave(e, c)}
          onDrop={(e) => onDrop(e, c)}
          onDragEnd={finishDrag}
          onClick={() => setView({ kind: 'category', id: c.id })}
          onContextMenu={(e) => categoryMenu(e, c)}
        >
          {depth === 0 && <Icon name={c.subscriptionId ? 'rss' : 'folder'} size={16} className="icon" />}
          <span className="label">{c.name}</span>
          <span className="count num">{treeCounts.get(c.id) ?? 0}</span>
          {hasChildren && (
            <span
              role="button"
              tabIndex={-1}
              className={`twisty${open ? '' : ' collapsed'}`}
              aria-label={open ? '收起子分类' : '展开子分类'}
              onClick={(e) => {
                e.stopPropagation();
                toggleCollapsed(c.id);
              }}
            >
              <Icon name="chevronDown" size={13} />
            </span>
          )}
        </button>
        {open && node.children.map((ch) => renderNode(ch, depth + 1))}
      </Fragment>
    );
  };

  const shownTags = showAllTags ? tags : tags.slice(0, TAG_LIMIT);

  return (
    <>
      {narrow && sidebarOpen && <div className="scrim" onClick={() => setSidebarOpen(false)} />}
      <aside className={`sidebar${sidebarOpen ? ' open' : ''}`}>
        <div className="side-section">
          {item({ kind: 'all' }, '全部', stickers.length, 'grid')}
          {item({ kind: 'recent' }, '最近使用', recentCount, 'clock')}
          {item({ kind: 'favorites' }, '收藏', favCount, 'star', 'star')}
          {item({ kind: 'uncategorized' }, '未分类', uncategorized, 'inbox')}
        </div>

        <div className="side-section">
          <div className="side-head">
            <span>分类</span>
            <button className="btn ghost icon-only" title="新建分类" aria-label="新建分类" onClick={() => newCategory()}>
              <Icon name="plus" size={15} />
            </button>
          </div>
          {tree.length === 0 && <div className="side-empty">还没有分类。点 + 新建，订阅的表情包也会自动成为分类。</div>}
          {tree.map((node) => renderNode(node, 0))}
          {dragId && canDropToEnd && (
            <div
              className={`drop-zone${over?.id === '__end__' ? ' active' : ''}`}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                setOver({ id: '__end__', pos: 'after' });
              }}
              onDragLeave={() => setOver((o) => (o?.id === '__end__' ? null : o))}
              onDrop={onDropToEnd}
            >
              放到这里 → 作为最后一个一级分类
            </div>
          )}
        </div>

        <div className="side-section">
          <div className="side-head">
            <span>订阅</span>
            <button
              className="btn ghost icon-only"
              title="添加订阅"
              aria-label="添加订阅"
              onClick={() => openDialog({ kind: 'subscriptions', focusAdd: true })}
            >
              <Icon name="plus" size={15} />
            </button>
          </div>
          {subscriptions.length === 0 && <div className="side-empty">输入订阅地址，自动同步别人分享的表情包。</div>}
          {subscriptions.map((sub) => {
            const st = syncStatus[sub.id];
            const p = st?.progress;
            return (
              <button
                key={sub.id}
                className={`side-item${sameView(view, { kind: 'subscription', id: sub.id }) ? ' active' : ''}`}
                onClick={() => setView({ kind: 'subscription', id: sub.id })}
                onContextMenu={(e) => subscriptionMenu(e, sub)}
                title={sub.lastError ? `上次同步出错：${sub.lastError}` : sub.url}
              >
                <span className="icon">{st?.running ? <Spinner size={14} /> : <Icon name="rss" size={16} />}</span>
                <span className="label">{sub.name}</span>
                {st?.running && p?.phase === 'download' && p.total > 0 ? (
                  <span className="sync-progress num">
                    {p.done}/{p.total}
                  </span>
                ) : (
                  <span className="count num">{subCounts.get(sub.id) ?? 0}</span>
                )}
                {sub.lastError && !st?.running && <Icon name="info" size={14} style={{ color: 'var(--danger)' }} />}
              </button>
            );
          })}
        </div>

        <div className="side-section">
          <div className="side-head">
            <span>标签</span>
            {tags.length > TAG_LIMIT && (
              <button className="btn ghost sm" onClick={() => setShowAllTags((v) => !v)}>
                {showAllTags ? '收起' : `全部 ${tags.length}`}
              </button>
            )}
          </div>
          {tags.length === 0 ? (
            <div className="side-empty">给表情打上标签，这里就能按标签筛选。</div>
          ) : (
            <div className="tag-cloud">
              {shownTags.map((t) => (
                <button
                  key={t.tag}
                  className={`chip${activeTags.includes(t.tag) ? ' active' : ''}`}
                  onClick={() => toggleTag(t.tag)}
                  onContextMenu={(e) => tagMenu(e, t.tag)}
                >
                  <span className="label">{t.tag}</span>
                  <span className="count num">{t.count}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
