import { useMemo, useState } from 'react';
import { useLibraryStore } from '../../core/store';
import { useUiStore } from '../../ui/uiStore';
import { categoryLabel } from '../../core/selectors';
import { formatBytes } from '../../core/images';
import { errorMessage } from '../../core/subscription/sync';
import { platform } from '../../platform';
import { Modal } from '../Dialog';
import { Icon, Spinner } from '../../ui/icons';

export function ExportDialog({ ids, defaultName }: { ids: string[]; defaultName: string }) {
  const closeDialog = useUiStore((s) => s.closeDialog);
  const toast = useUiStore((s) => s.toast);
  const stickers = useLibraryStore((s) => s.stickers);
  const categories = useLibraryStore((s) => s.categories);
  const [name, setName] = useState(defaultName);
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);

  const picked = useMemo(() => {
    const idSet = new Set(ids);
    return stickers.filter((s) => idSet.has(s.id));
  }, [stickers, ids]);
  const size = picked.reduce((n, s) => n + s.size, 0);
  const cats = useMemo(() => {
    const set = new Set(picked.map((s) => s.categoryId));
    return Array.from(set).map((id) => categoryLabel(categories, id));
  }, [picked, categories]);

  const run = async () => {
    setBusy(true);
    try {
      const r = await useLibraryStore.getState().exportPackage(ids, name, description.trim() || undefined);
      const saved = await platform.saveFile(`${name.trim() || '表情包'}.zip`, r.bytes);
      if (saved.saved) {
        toast(
          `已导出 ${r.count} 个表情${r.missing ? `（${r.missing} 个缺少图片文件被跳过）` : ''}${saved.path ? `：${saved.path}` : ''}`,
          'success',
        );
        closeDialog();
      } else {
        setBusy(false);
      }
    } catch (e) {
      toast(`导出失败：${errorMessage(e)}`, 'error');
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`导出 ${picked.length} 个表情`}
      onClose={closeDialog}
      footer={
        <>
          <button className="btn" onClick={closeDialog} disabled={busy}>
            取消
          </button>
          <button className="btn primary" onClick={() => void run()} disabled={busy || !name.trim()}>
            {busy ? <Spinner /> : <Icon name="download" />} 导出 zip…
          </button>
        </>
      }
    >
      <form
        className="field"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <label htmlFor="export-name">表情包名称</label>
        <input id="export-name" className="input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
      </form>
      <div className="field">
        <label htmlFor="export-desc">说明（可选）</label>
        <input id="export-desc" className="input" value={description} maxLength={200} placeholder="给收到的人看的一句话" onChange={(e) => setDescription(e.target.value)} />
      </div>
      <div className="meta">
        <span>{picked.length} 个表情</span>
        <span>约 {formatBytes(size)}</span>
        <span>分类：{cats.join('、')}</span>
      </div>
      <div className="hint">
        压缩包里包含图片和 manifest.json，名称、标签、分类（含二级分类）都会带上。对方在“导入 → 导入表情包”里选择这个 zip 即可。
        把解压后的文件夹放到网上，manifest.json 的地址还能直接作为订阅地址。
      </div>
    </Modal>
  );
}
