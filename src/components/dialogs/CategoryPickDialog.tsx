import { useLibraryStore } from '../../core/store';
import { useUiStore } from '../../ui/uiStore';
import { flattenTree } from '../../core/selectors';
import { Modal } from '../Dialog';
import { Icon } from '../../ui/icons';

interface Props {
  title: string;
  /** 高亮当前所在的分类（null = 未分类，undefined = 不高亮） */
  current?: string | null;
  /** “新建分类…”按钮的确认文案 */
  newLabel?: string;
  hint?: string;
  onPick: (categoryId: string | null, name: string) => void;
}

/** 选一个分类（含二级分类、未分类、新建）：移动表情和导入图片都用它 */
export function CategoryPickDialog({ title, current, newLabel = '创建', hint, onPick }: Props) {
  const closeDialog = useUiStore((s) => s.closeDialog);
  const openDialog = useUiStore((s) => s.openDialog);
  const categories = useLibraryStore((s) => s.categories);
  const addCategory = useLibraryStore((s) => s.addCategory);

  const pick = (id: string | null, name: string) => {
    closeDialog();
    onPick(id, name);
  };

  return (
    <Modal title={title} onClose={closeDialog}>
      <div className="pick-list">
        <button className={current === null ? 'current' : ''} onClick={() => pick(null, '未分类')}>
          <Icon name="inbox" size={16} /> 未分类
        </button>
        {flattenTree(categories).map(({ category: c, depth }) => (
          <button
            key={c.id}
            className={`${current === c.id ? 'current' : ''}${depth ? ' child' : ''}`}
            style={depth ? { paddingLeft: 10 + depth * 18 } : undefined}
            onClick={() => pick(c.id, c.name)}
          >
            <Icon name={depth ? 'chevronDown' : c.subscriptionId ? 'rss' : 'folder'} size={16} style={depth ? { transform: 'rotate(-90deg)' } : undefined} />
            {c.name}
          </button>
        ))}
        <button
          onClick={() =>
            openDialog({
              kind: 'prompt',
              title: '新建分类',
              placeholder: '分类名称',
              value: '',
              confirmText: newLabel,
              onSubmit: (v) => {
                const c = addCategory(v);
                onPick(c.id, c.name);
              },
            })
          }
        >
          <Icon name="plus" size={16} /> 新建分类…
        </button>
      </div>
      {hint && <div className="hint">{hint}</div>}
    </Modal>
  );
}
