import { useLibraryStore } from '../core/store';
import { useUiStore } from '../ui/uiStore';
import { confirmDeleteStickers, copyManyWithFeedback, getVisibleOrder, openExportDialog, shareMany, startRename } from '../ui/actions';
import { isMobile, platform } from '../platform';
import { Icon } from '../ui/icons';

export function SelectionBar() {
  const selection = useUiStore((s) => s.selection);
  const clearSelection = useUiStore((s) => s.clearSelection);
  const select = useUiStore((s) => s.select);
  const openDialog = useUiStore((s) => s.openDialog);
  const toggleFavorite = useLibraryStore((s) => s.toggleFavorite);
  if (selection.size === 0) return null;
  const ids = Array.from(selection);
  const n = selection.size;
  const visible = getVisibleOrder();
  const allSelected = visible.length > 0 && visible.every((id) => selection.has(id));
  const canShare = isMobile && platform.capabilities.share;

  const favoriteAll = () => {
    const stickers = useLibraryStore.getState().stickers.filter((s) => selection.has(s.id));
    const allFav = stickers.every((s) => s.favorite);
    for (const s of stickers) if (s.favorite === allFav) toggleFavorite(s.id);
  };

  return (
    <div className="selectionbar">
      <span className="summary num">
        已选 {n} 个{visible.length > n ? ` / 共 ${visible.length} 个` : ''}
      </span>
      {!allSelected && (
        <button className="btn sm" onClick={() => select(visible, 'replace')} title="选中当前显示的全部表情（Ctrl+A）">
          <Icon name="selectAll" size={15} /> 全选
        </button>
      )}
      {canShare && (
        <button className="btn sm primary" onClick={() => void shareMany(ids)} title="打开系统分享面板，一起发送">
          <Icon name="share" size={15} /> 分享{n > 1 ? ` ${n} 个` : ''}
        </button>
      )}
      {platform.capabilities.copyFile && (
        <button className={`btn sm${canShare ? '' : ' primary'}`} onClick={() => void copyManyWithFeedback(ids)} title="作为多个文件一起复制，粘贴即可发送">
          <Icon name="copy" size={15} /> 复制{n > 1 ? ` ${n} 个` : ''}
        </button>
      )}
      <button className="btn sm" onClick={() => openDialog({ kind: 'move', ids })}>
        <Icon name="folder" size={15} /> 移动到分类
      </button>
      <button className="btn sm" onClick={() => openDialog({ kind: 'bulkTags', ids })}>
        <Icon name="tag" size={15} /> 添加标签
      </button>
      <button className="btn sm" onClick={() => startRename(ids)}>
        <Icon name="edit" size={15} /> {n > 1 ? '批量命名' : '重命名'}
      </button>
      <button className="btn sm" onClick={favoriteAll}>
        <Icon name="star" size={15} /> 收藏
      </button>
      <button className="btn sm" onClick={() => openExportDialog(ids)}>
        <Icon name="download" size={15} /> 导出
      </button>
      <button className="btn sm danger" onClick={() => confirmDeleteStickers(ids)}>
        <Icon name="trash" size={15} /> 删除
      </button>
      <span className="spacer" />
      {!isMobile && (
        <span className="hint">
          拖动框选 · <kbd>Ctrl</kbd>+点击 多选 · <kbd>Shift</kbd>+点击 范围 · <kbd>Ctrl</kbd>+<kbd>A</kbd> 全选 · <kbd>Esc</kbd> 取消
        </span>
      )}
      <button className="btn sm ghost" onClick={clearSelection}>
        取消
      </button>
    </div>
  );
}
