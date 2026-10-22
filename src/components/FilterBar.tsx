import { useMemo } from 'react';
import { useLibraryStore } from '../core/store';
import { useUiStore } from '../ui/uiStore';
import { categoryCounts, categoryCountsWithChildren, categoryPath, childCategories, type SortKey } from '../core/selectors';
import type { GridSize } from '../core/types';
import { Icon } from '../ui/icons';

const SIZES: { key: GridSize; label: string }[] = [
  { key: 'small', label: '小' },
  { key: 'medium', label: '中' },
  { key: 'large', label: '大' },
];

export function FilterBar({ count }: { count: number }) {
  const filter = useUiStore((s) => s.filter);
  const toggleTag = useUiStore((s) => s.toggleTag);
  const setSort = useUiStore((s) => s.setSort);
  const setView = useUiStore((s) => s.setView);
  const openDialog = useUiStore((s) => s.openDialog);
  const toast = useUiStore((s) => s.toast);
  const categories = useLibraryStore((s) => s.categories);
  const stickers = useLibraryStore((s) => s.stickers);
  const subscriptions = useLibraryStore((s) => s.subscriptions);
  const gridSize = useLibraryStore((s) => s.settings.gridSize);
  const updateSettings = useLibraryStore((s) => s.updateSettings);
  const direct = useMemo(() => categoryCounts(stickers), [stickers]);
  const withChildren = useMemo(() => categoryCountsWithChildren(stickers, categories), [stickers, categories]);

  const view = filter.view;
  // 查看分类时：页签列出“当前分类的子分类”；当前分类没有子分类时列出它同级的（它父分类的子分类），方便横向切换
  const current = view.kind === 'category' ? categories.find((c) => c.id === view.id) : undefined;
  let tabBase = current;
  if (current && childCategories(categories, current.id).length === 0 && current.parentId) {
    tabBase = categories.find((c) => c.id === current.parentId) ?? current;
  }
  const children = tabBase ? childCategories(categories, tabBase.id) : [];
  const crumbs = tabBase ? categoryPath(categories, tabBase.id) : [];
  const ancestors = crumbs.slice(0, -1);

  let title = '全部表情';
  if (view.kind === 'recent') title = '最近使用';
  else if (view.kind === 'favorites') title = '收藏';
  else if (view.kind === 'uncategorized') title = '未分类';
  else if (view.kind === 'category') title = tabBase?.name ?? '分类';
  else if (view.kind === 'subscription') title = subscriptions.find((s) => s.id === view.id)?.name ?? '订阅';

  const newChild = () => {
    if (!tabBase) return;
    openDialog({
      kind: 'prompt',
      title: `在“${tabBase.name}”下新建子分类`,
      placeholder: '子分类名称',
      value: '',
      confirmText: '创建',
      onSubmit: (v) => {
        try {
          const c = useLibraryStore.getState().addCategory(v, tabBase.id);
          setView({ kind: 'category', id: c.id });
        } catch (e) {
          toast(e instanceof Error ? e.message : String(e), 'error');
        }
      },
    });
  };

  return (
    <>
      <div className="filterbar">
        <h2>
          {ancestors.length > 0 && (
            <span className="crumbs">
              {ancestors.map((c) => (
                <button key={c.id} className="crumb" onClick={() => setView({ kind: 'category', id: c.id })} title={`回到“${c.name}”`}>
                  {c.name}
                  <Icon name="chevronDown" size={12} style={{ transform: 'rotate(-90deg)' }} />
                </button>
              ))}
            </span>
          )}
          {title}
          <span className="count num">{count}</span>
        </h2>
        {filter.tags.length > 0 && (
          <div className="active-tags">
            {filter.tags.map((t) => (
              <span key={t} className="chip active">
                <span className="label">#{t}</span>
                <button className="remove" aria-label={`移除筛选 ${t}`} onClick={() => toggleTag(t)}>
                  <Icon name="x" size={12} />
                </button>
              </span>
            ))}
          </div>
        )}
        <span className="spacer" />
        {view.kind === 'recent' ? (
          <span className="hint">按最近使用时间排列</span>
        ) : (
          <select className="select" value={filter.sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="排序">
            <option value="newest">最新添加</option>
            <option value="oldest">最早添加</option>
            <option value="name">按名称</option>
          </select>
        )}
        <div className="segmented" role="group" aria-label="网格大小">
          {SIZES.map((s) => (
            <button key={s.key} className={gridSize === s.key ? 'active' : ''} onClick={() => updateSettings({ gridSize: s.key })}>
              {s.label}
            </button>
          ))}
        </div>
      </div>
      {tabBase && view.kind === 'category' && (
        <div className="subtabs" role="tablist" aria-label="子分类">
          <button
            role="tab"
            aria-selected={view.id === tabBase.id && !view.own}
            className={`chip${view.id === tabBase.id && !view.own ? ' active' : ''}`}
            onClick={() => setView({ kind: 'category', id: tabBase.id })}
          >
            <span className="label">全部</span>
            <span className="count num">{withChildren.get(tabBase.id) ?? 0}</span>
          </button>
          {children.map((c) => (
            <button
              key={c.id}
              role="tab"
              aria-selected={view.id === c.id}
              className={`chip${view.id === c.id ? ' active' : ''}`}
              onClick={() => setView({ kind: 'category', id: c.id })}
              title={childCategories(categories, c.id).length ? '还有子分类，点进去查看' : undefined}
            >
              <span className="label">{c.name}</span>
              <span className="count num">{withChildren.get(c.id) ?? 0}</span>
            </button>
          ))}
          {children.length > 0 && (
            // 直接放在这个分类里、还没归入子分类的表情：拖进分类的图片默认就在这里
            <button
              role="tab"
              aria-selected={view.id === tabBase.id && !!view.own}
              className={`chip own${view.id === tabBase.id && view.own ? ' active' : ''}`}
              title="直接放在这个分类里、还没有归入子分类的表情"
              onClick={() => setView({ kind: 'category', id: tabBase.id, own: true })}
            >
              <span className="label">未分类</span>
              <span className="count num">{direct.get(tabBase.id) ?? 0}</span>
            </button>
          )}
          <button className="chip ghost" onClick={newChild} title="在这个分类下新建子分类">
            <Icon name="plus" size={13} />
            <span className="label">子分类</span>
          </button>
        </div>
      )}
    </>
  );
}
