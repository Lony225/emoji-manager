import { useLibraryStore } from '../core/store';
import { useUiStore } from '../ui/uiStore';
import { importImages, pasteFromClipboard, pickFiles } from '../ui/actions';
import { platform } from '../platform';
import { Icon } from '../ui/icons';
import { SUBSCRIPTIONS_ENABLED } from '../core/features';

export function EmptyState({ filtered }: { filtered: boolean }) {
  const openDialog = useUiStore((s) => s.openDialog);
  const setView = useUiStore((s) => s.setView);
  const clearTags = useUiStore((s) => s.clearTags);
  const setQuery = useUiStore((s) => s.setQuery);
  const total = useLibraryStore((s) => s.stickers.length);
  const app = platform.kind === 'capacitor';

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

  let hint = '把图片或整个文件夹拖进窗口，或者按 Ctrl+V 粘贴剪贴板里的图片。';
  if (app) hint = '点「导入图片」从相册或文件里选；在相册、微信、浏览器里把图片「分享」到本应用，也会存进来。';
  else if (SUBSCRIPTIONS_ENABLED) hint = '把图片拖进窗口、按 Ctrl+V 粘贴，或者添加一个订阅地址，表情包就会自动同步到这里。';

  return (
    <div className="empty">
      <div className="face">🙂</div>
      <h3>{total === 0 ? '还没有表情' : '这里还是空的'}</h3>
      <p>{hint}</p>
      <div className="actions">
        <button
          className={SUBSCRIPTIONS_ENABLED ? 'btn' : 'btn primary'}
          onClick={() =>
            void pickFiles().then((files) => {
              if (files.length) importImages(files);
            })
          }
        >
          <Icon name="image" /> 导入图片
        </button>
        <button className="btn" onClick={() => void pasteFromClipboard()} title={app ? '把剪贴板里的图片存为表情' : '把剪贴板里的图片存为表情（Ctrl+V）'}>
          <Icon name="paste" /> 粘贴剪贴板图片
        </button>
        {SUBSCRIPTIONS_ENABLED && (
          <button className="btn primary" onClick={() => openDialog({ kind: 'subscriptions', focusAdd: true })}>
            <Icon name="rss" /> 添加订阅
          </button>
        )}
      </div>
    </div>
  );
}
