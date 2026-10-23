import { useMemo, useState } from 'react';
import { useLibraryStore } from '../../core/store';
import { useUiStore } from '../../ui/uiStore';
import { flattenTree, tagCounts } from '../../core/selectors';
import { formatBytes } from '../../core/images';
import { platform } from '../../platform';
import { SUBSCRIPTIONS_ENABLED } from '../../core/features';
import { confirmDeleteStickers } from '../../ui/actions';
import { useFileUrl } from '../../ui/hooks';
import { Modal } from '../Dialog';
import { TagInput } from '../TagInput';

export function StickerDialog({ id }: { id: string }) {
  const sticker = useLibraryStore((s) => s.stickers.find((x) => x.id === id));
  const stickers = useLibraryStore((s) => s.stickers);
  const categories = useLibraryStore((s) => s.categories);
  const updateSticker = useLibraryStore((s) => s.updateSticker);
  const closeDialog = useUiStore((s) => s.closeDialog);
  const toast = useUiStore((s) => s.toast);
  const suggestions = useMemo(() => tagCounts(stickers).map((t) => t.tag), [stickers]);
  const [name, setName] = useState(sticker?.name ?? '');
  const [categoryId, setCategoryId] = useState(sticker?.categoryId ?? '');
  const [tags, setTags] = useState<string[]>(sticker?.tags ?? []);
  const url = useFileUrl(sticker?.file ?? '');
  if (!sticker) return null;

  const save = () => {
    updateSticker(id, { name, categoryId: categoryId || null, tags });
    closeDialog();
    toast('已保存', 'success');
  };
  const sourceUrl = sticker.source.type === 'subscription' ? sticker.source.url : null;

  return (
    <Modal
      title="编辑表情"
      onClose={closeDialog}
      footer={
        <>
          <button className="btn danger left" onClick={() => confirmDeleteStickers([id])}>
            删除
          </button>
          <button className="btn" onClick={closeDialog}>
            取消
          </button>
          <button className="btn primary" onClick={save}>
            保存
          </button>
        </>
      }
    >
      <div className="preview">{url && <img src={url} alt={sticker.name} />}</div>
      <div className="meta">
        <span>{sticker.ext.toUpperCase()}</span>
        <span>{formatBytes(sticker.size)}</span>
        {SUBSCRIPTIONS_ENABLED && <span>{sticker.source.type === 'subscription' ? '来自订阅' : '本地导入'}</span>}
        {sourceUrl && SUBSCRIPTIONS_ENABLED && (
          <a
            href={sourceUrl}
            onClick={(e) => {
              e.preventDefault();
              void platform.openExternal(sourceUrl);
            }}
          >
            打开原图链接
          </a>
        )}
      </div>
      <form
        className="field"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <label htmlFor="sticker-name">名称</label>
        <input id="sticker-name" className="input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
      </form>
      <div className="field">
        <label htmlFor="sticker-category">分类</label>
        <select
          id="sticker-category"
          className="select"
          style={{ height: 34 }}
          value={categoryId}
          onChange={(e) => setCategoryId(e.target.value)}
        >
          <option value="">未分类</option>
          {flattenTree(categories).map(({ category: c, depth }) => (
            <option key={c.id} value={c.id}>
              {depth ? `${'　'.repeat(depth)}└ ${c.name}` : c.name}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <span className="label">标签</span>
        <TagInput value={tags} onChange={setTags} suggestions={suggestions} />
      </div>
    </Modal>
  );
}
