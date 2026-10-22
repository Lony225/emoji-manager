import { useLibraryStore } from '../core/store';
import { useUiStore } from '../ui/uiStore';
import { importImages, pickFiles } from '../ui/actions';
import { Icon } from '../ui/icons';

export function EmptyState({ filtered }: { filtered: boolean }) {
  const openDialog = useUiStore((s) => s.openDialog);
  const setView = useUiStore((s) => s.setView);
  const clearTags = useUiStore((s) => s.clearTags);
  const setQuery = useUiStore((s) => s.setQuery);
  const total = useLibraryStore((s) => s.stickers.length);

  if (filtered && total > 0) {
    return (
      <div className="empty">
        <div className="face">🔍</div>
        <h3>没有符合条件的表情</h3>
        <p>换个关键词，或者清除筛选再看看。</p>
        <div className="actions">
          <button
            className="btn"
            onClick={() => {
              clearTags();
              setQuery('');
              setView({ kind: 'all' });
            }}
          >
            清除筛选
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="empty">
      <div className="face">🙂</div>
      <h3>{total === 0 ? '还没有表情' : '这里还是空的'}</h3>
      <p>把图片拖进窗口、按 Ctrl+V 粘贴，或者添加一个订阅地址，表情包就会自动同步到这里。</p>
      <div className="actions">
        <button
          className="btn"
          onClick={() =>
            void pickFiles().then((files) => {
              if (files.length) importImages(files);
            })
          }
        >
          <Icon name="image" /> 导入图片
        </button>
        <button className="btn primary" onClick={() => openDialog({ kind: 'subscriptions', focusAdd: true })}>
          <Icon name="rss" /> 添加订阅
        </button>
      </div>
    </div>
  );
}
