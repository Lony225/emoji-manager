import { useEffect, useRef, type MouseEvent } from 'react';
import { useLibraryStore } from '../core/store';
import { useUiStore } from '../ui/uiStore';
import { importImages, openMemeTemplates, pasteFromClipboard, pickAndImportFolders, pickAndImportPackage, pickAndMake, pickFiles } from '../ui/actions';
import { useNarrow } from '../ui/hooks';
import { platform } from '../platform';
import { SUBSCRIPTIONS_ENABLED } from '../core/features';
import { Icon, Spinner } from '../ui/icons';

export function TopBar() {
  const query = useUiStore((s) => s.filter.query);
  const setQuery = useUiStore((s) => s.setQuery);
  const openDialog = useUiStore((s) => s.openDialog);
  const openMenu = useUiStore((s) => s.openMenu);
  const setSidebarOpen = useUiStore((s) => s.setSidebarOpen);
  const toast = useUiStore((s) => s.toast);
  const subscriptions = useLibraryStore((s) => s.subscriptions);
  const syncStatus = useLibraryStore((s) => s.syncStatus);
  const syncAll = useLibraryStore((s) => s.syncAll);
  const narrow = useNarrow();
  const inputRef = useRef<HTMLInputElement>(null);
  const syncing = Object.values(syncStatus).some((s) => s.running);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const importPictures = () =>
    void pickFiles().then((files) => {
      if (files.length) importImages(files);
    });

  const onImport = (e: MouseEvent<HTMLButtonElement>) => {
    if (platform.kind === 'capacitor') {
      importPictures();
      return;
    }
    const r = e.currentTarget.getBoundingClientRect();
    openMenu({
      x: r.left,
      y: r.bottom + 4,
      items: [
        { label: '选择图片…', icon: 'image', onSelect: importPictures },
        {
          label: platform.capabilities.multiFolderPick ? '导入文件夹（可多选，成为分类）…' : '导入文件夹（成为分类）…',
          icon: 'folder',
          onSelect: () => void pickAndImportFolders(),
        },
        { label: '导入表情包压缩包（zip）…', icon: 'inbox', onSelect: () => void pickAndImportPackage() },
        { label: '粘贴剪贴板里的图片（Ctrl+V）', icon: 'paste', onSelect: () => void pasteFromClipboard() },
      ],
    });
  };

  const onMake = (e: MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    openMenu({
      x: r.left,
      y: r.bottom + 4,
      items: [
        { label: '给图片加文字…', icon: 'text', onSelect: () => void pickAndMake() },
        ...(platform.capabilities.memeTemplates ? [{ label: '用模板做表情（摸头、喜报、举牌…）', icon: 'sparkles' as const, onSelect: () => openMemeTemplates() }] : []),
      ],
    });
  };

  const onSyncAll = async () => {
    if (subscriptions.length === 0) {
      openDialog({ kind: 'subscriptions', focusAdd: true });
      return;
    }
    toast('开始同步全部订阅…');
    await syncAll();
    const failed = useLibraryStore.getState().subscriptions.filter((s) => s.lastError);
    toast(failed.length ? `同步完成，${failed.length} 个订阅有错误` : '全部订阅已同步', failed.length ? 'error' : 'success');
  };

  return (
    <header className="topbar">
      {narrow && (
        <button className="btn ghost icon-only" aria-label="打开侧栏" onClick={() => setSidebarOpen(true)}>
          <Icon name="menu" />
        </button>
      )}
      <div className="brand">
        <span className="brand-mark">
          <Icon name="smile" size={17} strokeWidth={2.2} />
        </span>
        <span className="brand-text">表情包</span>
      </div>
      <div className="search">
        <Icon name="search" className="icon" size={16} />
        <input
          ref={inputRef}
          type="search"
          value={query}
          placeholder="搜索名称、标签…（Ctrl+F）"
          onChange={(e) => setQuery(e.target.value)}
          aria-label="搜索表情"
        />
        {query && (
          <button className="clear" aria-label="清除搜索" onClick={() => setQuery('')}>
            <Icon name="x" size={14} />
          </button>
        )}
      </div>
      <span className="spacer" />
      <button className="btn" onClick={onImport} title="导入图片 / 文件夹 / zip，粘贴剪贴板">
        <Icon name="image" /> {!narrow && '导入'}
      </button>
      <button className="btn make-btn" onClick={onMake} title="制作表情：给图片加文字，或用模板生成">
        <Icon name="sparkles" /> {!narrow && '制作'}
      </button>
      {SUBSCRIPTIONS_ENABLED && (
        <>
          <button className="btn primary" onClick={() => openDialog({ kind: 'subscriptions', focusAdd: true })} title="添加订阅">
            <Icon name="rss" /> {!narrow && '添加订阅'}
          </button>
          <button className="btn icon-only" onClick={() => void onSyncAll()} disabled={syncing} title="同步全部订阅">
            {syncing ? <Spinner /> : <Icon name="sync" />}
          </button>
        </>
      )}
      <button className="btn icon-only" onClick={() => openDialog({ kind: 'settings' })} title="设置" aria-label="设置">
        <Icon name="settings" />
      </button>
    </header>
  );
}
