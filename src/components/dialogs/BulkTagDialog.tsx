import { useMemo, useState } from 'react';
import { useLibraryStore } from '../../core/store';
import { useUiStore } from '../../ui/uiStore';
import { tagCounts } from '../../core/selectors';
import { Modal } from '../Dialog';
import { TagInput } from '../TagInput';

export function BulkTagDialog({ ids }: { ids: string[] }) {
  const closeDialog = useUiStore((s) => s.closeDialog);
  const toast = useUiStore((s) => s.toast);
  const stickers = useLibraryStore((s) => s.stickers);
  const addTagsTo = useLibraryStore((s) => s.addTagsTo);
  const suggestions = useMemo(() => tagCounts(stickers).map((t) => t.tag), [stickers]);
  const [tags, setTags] = useState<string[]>([]);

  const apply = () => {
    if (tags.length > 0) {
      addTagsTo(ids, tags);
      toast(`已为 ${ids.length} 个表情添加标签`, 'success');
    }
    closeDialog();
  };

  return (
    <Modal
      title={`为 ${ids.length} 个表情添加标签`}
      onClose={closeDialog}
      footer={
        <>
          <button className="btn" onClick={closeDialog}>
            取消
          </button>
          <button className="btn primary" onClick={apply} disabled={tags.length === 0}>
            添加
          </button>
        </>
      }
    >
      <TagInput value={tags} onChange={setTags} suggestions={suggestions} autoFocus />
    </Modal>
  );
}
