import { useMemo, useState } from 'react';
import { useLibraryStore } from '../../core/store';
import { useUiStore } from '../../ui/uiStore';
import type { PickedFolder } from '../../platform/types';
import { categoryLabel, flattenTree } from '../../core/selectors';
import { currentCategoryId, importFolders, isImageName, type FolderPlacement } from '../../ui/actions';
import { errorMessage } from '../../core/subscription/sync';
import { platform } from '../../platform';
import { Modal } from '../Dialog';
import { Spinner } from '../../ui/icons';

interface Props {
  folders: PickedFolder[];
  parentName?: string;
  /** 拖到侧栏某个分类上时：默认放到这个分类下 */
  parentId?: string;
}

type Mode = 'top' | 'under' | 'newParent';

/** 导入一个或多个文件夹：每个文件夹成为一个分类，可放在任意分类下；子文件夹可逐级成为子分类 */
export function ImportFolderDialog({ folders, parentName, parentId: dropParentId }: Props) {
  const closeDialog = useUiStore((s) => s.closeDialog);
  const toast = useUiStore((s) => s.toast);
  const setView = useUiStore((s) => s.setView);
  const categories = useLibraryStore((s) => s.categories);
  const options = useMemo(() => flattenTree(categories), [categories]);

  const counts = useMemo(() => folders.map((f) => f.files.filter((x) => isImageName(x.name)).length), [folders]);
  const totalImages = counts.reduce((a, b) => a + b, 0);
  const subfolders = useMemo(() => {
    const names = new Set<string>();
    let deepest = 1;
    for (const folder of folders) {
      for (const f of folder.files) {
        if (!isImageName(f.name)) continue;
        const parts = f.rel.split('/');
        if (parts.length > 1) names.add(parts[0]);
        deepest = Math.max(deepest, parts.length);
      }
    }
    return { names: Array.from(names), levels: deepest - 1 };
  }, [folders]);

  const currentId = dropParentId ?? currentCategoryId();
  const multi = folders.length > 1;

  const [addToCategory, setAddToCategory] = useState(true);
  const [names, setNames] = useState(() => folders.map((f) => f.name));
  // 正在看某个分类 → 默认放到它下面；多选且有共同上级目录 → 默认新建以它命名的一级分类
  const [mode, setMode] = useState<Mode>(currentId ? 'under' : multi && parentName ? 'newParent' : 'top');
  const [parentId, setParentId] = useState<string>(currentId ?? options[0]?.category.id ?? '');
  const [newParentName, setNewParentName] = useState(parentName ?? '');
  const [asChildren, setAsChildren] = useState(true);
  const [busy, setBusy] = useState(false);

  const effectiveMode: Mode = mode === 'under' && !parentId ? 'top' : mode;
  const parentLabel =
    effectiveMode === 'under' ? categoryLabel(categories, parentId) : effectiveMode === 'newParent' ? newParentName.trim() : '';

  const existingAt = (name: string) => {
    if (effectiveMode === 'newParent') {
      const parent = categories.find((c) => c.name === newParentName.trim() && !c.parentId);
      if (!parent) return undefined;
      return categories.find((c) => c.name === name.trim() && c.parentId === parent.id);
    }
    const pid = effectiveMode === 'under' ? parentId : null;
    return categories.find((c) => c.name === name.trim() && (c.parentId ?? null) === pid);
  };

  const run = async () => {
    if (addToCategory) {
      if (names.some((n) => !n.trim())) {
        toast('请给每个文件夹填上分类名称', 'error');
        return;
      }
      if (effectiveMode === 'newParent' && !newParentName.trim()) {
        toast('请填写新一级分类的名称', 'error');
        return;
      }
    }
    setBusy(true);
    try {
      const placement: FolderPlacement =
        effectiveMode === 'under' ? { kind: 'under', parentId } : effectiveMode === 'newParent' ? { kind: 'newParent', name: newParentName } : { kind: 'top' };
      const r = await importFolders(folders, {
        addToCategory,
        names,
        placement,
        subfoldersAsChildren: addToCategory && subfolders.names.length > 0 && asChildren,
        targetCategoryId: currentId,
      });
      const parts: string[] = [];
      if (r.added) parts.push(`已导入 ${r.added} 个表情`);
      if (r.categoryNames.length) parts.push(`分类：${r.categoryNames.slice(0, 4).join('、')}${r.categoryNames.length > 4 ? ` 等 ${r.categoryNames.length} 个` : ''}`);
      if (r.moved) parts.push(`${r.moved} 个已有的相同表情已移到新分类`);
      if (r.skipped) parts.push(`跳过 ${r.skipped} 个重复或不支持的文件`);
      if (r.failed) parts.push(`${r.failed} 个失败`);
      toast(parts.join('，') || '没有新的表情', r.failed ? 'error' : 'success');
      // 跳到刚导入的地方：放在某个分类下就看那个分类，否则看第一个新分类
      if (addToCategory) {
        const cats = useLibraryStore.getState().categories;
        let target = effectiveMode === 'under' ? cats.find((c) => c.id === parentId) : undefined;
        if (effectiveMode === 'newParent') target = cats.find((c) => c.name === newParentName.trim() && !c.parentId);
        if (!target) target = cats.find((c) => c.name === names[0].trim() && !c.parentId);
        if (target) setView({ kind: 'category', id: target.id });
      }
      closeDialog();
    } catch (e) {
      toast(`导入失败：${errorMessage(e)}`, 'error');
      setBusy(false);
    }
  };

  return (
    <Modal
      title={multi ? `导入 ${folders.length} 个文件夹` : `导入文件夹“${folders[0].name}”`}
      onClose={closeDialog}
      wide={multi}
      footer={
        <>
          <button className="btn" onClick={closeDialog} disabled={busy}>
            取消
          </button>
          <button className="btn primary" onClick={() => void run()} disabled={busy || totalImages === 0}>
            {busy ? <Spinner /> : null} 导入 {totalImages} 张图片
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
        <label className="checkbox">
          <input type="checkbox" checked={addToCategory} onChange={(e) => setAddToCategory(e.target.checked)} />
          {multi ? '每个文件夹成为一个分类' : '添加到分类'}
        </label>

        {addToCategory ? (
          <>
            <div className="field">
              <span className="label">放在哪里</span>
              <div className="radio-group" role="radiogroup">
                <label className="checkbox">
                  <input type="radio" name="placement" checked={effectiveMode === 'top'} onChange={() => setMode('top')} />
                  作为一级分类
                </label>
                <label className="checkbox" title={options.length ? '' : '还没有分类'}>
                  <input type="radio" name="placement" checked={effectiveMode === 'under'} disabled={options.length === 0} onChange={() => setMode('under')} />
                  放在已有的分类下
                </label>
                <label className="checkbox">
                  <input type="radio" name="placement" checked={effectiveMode === 'newParent'} onChange={() => setMode('newParent')} />
                  新建一个一级分类，放在它下面
                </label>
              </div>
              {effectiveMode === 'under' && (
                <select className="select" style={{ height: 34 }} value={parentId} onChange={(e) => setParentId(e.target.value)} aria-label="放在哪个分类下">
                  {options.map(({ category: c, depth }) => (
                    <option key={c.id} value={c.id}>
                      {depth ? `${'　'.repeat(depth)}└ ${c.name}` : c.name}
                    </option>
                  ))}
                </select>
              )}
              {effectiveMode === 'newParent' && (
                <input
                  className="input"
                  value={newParentName}
                  placeholder="新一级分类的名称"
                  maxLength={50}
                  onChange={(e) => setNewParentName(e.target.value)}
                  aria-label="新一级分类的名称"
                />
              )}
            </div>

            <div className="field">
              <span className="label">{multi ? '文件夹 → 分类名称（可修改）' : '分类名称'}</span>
              <div className="folder-list">
                {folders.map((folder, i) => {
                  const existing = existingAt(names[i]);
                  return (
                    <div key={folder.name + i} className="folder-row">
                      <input
                        className="input"
                        value={names[i]}
                        maxLength={50}
                        autoFocus={i === 0 && !multi}
                        aria-label={`文件夹 ${folder.name} 的分类名称`}
                        onChange={(e) => setNames((list) => list.map((n, j) => (j === i ? e.target.value : n)))}
                      />
                      <span className="hint num">{counts[i]} 张</span>
                      <span className="hint">{existing ? '已有同名分类，导入到其中' : parentLabel ? `${parentLabel} / 新子分类` : '新一级分类'}</span>
                    </div>
                  );
                })}
              </div>
            </div>

            {subfolders.names.length > 0 && (
              <label className="checkbox">
                <input type="checkbox" checked={asChildren} onChange={(e) => setAsChildren(e.target.checked)} />
                子文件夹逐级成为子分类（{subfolders.names.slice(0, 5).join('、')}
                {subfolders.names.length > 5 ? ` 等 ${subfolders.names.length} 个` : ''}
                {subfolders.levels > 1 ? `，最深 ${subfolders.levels} 层` : ''}）
              </label>
            )}
          </>
        ) : (
          <div className="hint">图片会放进{currentId ? '当前查看的分类' : '“未分类”'}。</div>
        )}
        {!platform.capabilities.multiFolderPick && !multi && (
          <div className="hint">浏览器一次只能选一个文件夹；要一次导入多个，把它们一起拖进窗口即可。</div>
        )}
      </form>
    </Modal>
  );
}
