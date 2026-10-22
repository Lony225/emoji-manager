import { useMemo } from 'react';
import { useLibraryStore } from '../../core/store';
import { useUiStore } from '../../ui/uiStore';
import { flattenTree, isSelfOrDescendant } from '../../core/selectors';
import { errorMessage } from '../../core/subscription/sync';
import { Modal } from '../Dialog';
import { Icon } from '../../ui/icons';

/** 把一个分类挪到任意分类下（像移动文件夹），或设为一级分类 */
export function CategoryParentDialog({ id }: { id: string }) {
  const closeDialog = useUiStore((s) => s.closeDialog);
  const toast = useUiStore((s) => s.toast);
  const categories = useLibraryStore((s) => s.categories);
  const me = categories.find((c) => c.id === id);
  // 自己和自己的子孙不能当目标（会成环）
  const options = useMemo(() => flattenTree(categories).filter((n) => !isSelfOrDescendant(categories, id, n.category.id)), [categories, id]);
  if (!me) return null;

  const pick = (parentId: string | null) => {
    try {
      useLibraryStore.getState().setCategoryParent(id, parentId);
      toast(parentId ? '已移动' : '已设为一级分类', 'success');
      closeDialog();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  return (
    <Modal title={`把“${me.name}”放到…`} onClose={closeDialog}>
      <div className="pick-list">
        <button className={!me.parentId ? 'current' : ''} onClick={() => pick(null)}>
          <Icon name="grid" size={16} /> 作为一级分类
        </button>
        {options.map(({ category: c, depth }) => (
          <button
            key={c.id}
            className={me.parentId === c.id ? 'current' : ''}
            style={depth ? { paddingLeft: 10 + depth * 18 } : undefined}
            onClick={() => pick(c.id)}
          >
            <Icon name={depth ? 'chevronDown' : c.subscriptionId ? 'rss' : 'folder'} size={16} style={depth ? { transform: 'rotate(-90deg)' } : undefined} />
            {c.name}
          </button>
        ))}
      </div>
      <div className="hint">分类可以任意多级；不能放到它自己或它的子分类下面。也可以直接在左侧拖动。</div>
    </Modal>
  );
}
