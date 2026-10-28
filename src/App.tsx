import { useEffect, useMemo, useState } from 'react';
import { useLibraryStore } from './core/store';
import { useUiStore } from './ui/uiStore';
import { filterStickers } from './core/selectors';
import {
  confirmDeleteStickers,
  copyManyWithFeedback,
  dropCategoryAt,
  getVisibleOrder,
  handleDropEvent,
  handlePasteEvent,
  isDragAcceptable,
  isEditableTarget,
  startRename,
} from './ui/actions';
import { TopBar } from './components/TopBar';
import { Sidebar } from './components/Sidebar';
import { FilterBar } from './components/FilterBar';
import { StickerGrid } from './components/StickerGrid';
import { SelectionBar } from './components/SelectionBar';
import { ContextMenu } from './components/ContextMenu';
import { Toasts } from './components/Toasts';
import { EmptyState } from './components/EmptyState';
import { ConfirmDialog, PromptDialog } from './components/Dialog';
import { StickerDialog } from './components/dialogs/StickerDialog';
import { SubscriptionsDialog } from './components/dialogs/SubscriptionsDialog';
import { SettingsDialog } from './components/dialogs/SettingsDialog';
import { BulkTagDialog } from './components/dialogs/BulkTagDialog';
import { CategoryPickDialog } from './components/dialogs/CategoryPickDialog';
import { ImportFolderDialog } from './components/dialogs/ImportFolderDialog';
import { ExportDialog } from './components/dialogs/ExportDialog';
import { CategoryParentDialog } from './components/dialogs/CategoryParentDialog';
import { UpdateDialog } from './components/dialogs/UpdateDialog';
import { BulkRenameDialog } from './components/dialogs/BulkRenameDialog';
import { MakerDialog } from './components/dialogs/MakerDialog';
import { MemeTemplatesDialog } from './components/dialogs/MemeTemplatesDialog';
import { formatHotkey } from './components/HotkeyInput';
import { installUpdateListener, runUpdateCheck } from './ui/update';
import { installDeepLinkHandler } from './ui/deeplink';
import { SUBSCRIPTIONS_ENABLED } from './core/features';
import { installThumbWorker } from './ui/thumbs';
import { installMobileHandlers } from './ui/mobile';
import { installLanSync } from './ui/lan';
import { LanDevicesDialog } from './components/dialogs/LanDevicesDialog';
import { useTheme } from './ui/hooks';

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ui = useUiStore.getState();
      if (e.key === 'Escape') {
        if (ui.menu) ui.closeMenu();
        else if (ui.dialog.kind !== 'none') return; // 对话框自己处理
        else if (ui.selection.size > 0) ui.clearSelection();
        else if (ui.filter.query) ui.setQuery('');
        return;
      }
      if (isEditableTarget(e.target) || ui.dialog.kind !== 'none') return;
      const mod = e.ctrlKey || e.metaKey;
      if ((e.key === 'Delete' || e.key === 'Backspace') && ui.selection.size > 0) {
        e.preventDefault();
        confirmDeleteStickers(Array.from(ui.selection));
      } else if (mod && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        ui.select(getVisibleOrder(), 'replace');
      } else if (mod && e.key.toLowerCase() === 'c' && ui.selection.size > 0) {
        e.preventDefault();
        void copyManyWithFeedback(Array.from(ui.selection));
      } else if (e.key === 'F2' && ui.selection.size > 0) {
        e.preventDefault();
        startRename(Array.from(ui.selection));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

/**
 * 拖东西进窗口即导入：系统里的图片 / 文件夹 / zip，以及从浏览器拖来的网页图片。
 * 拖到侧栏某个分类上会直接放进那个分类。返回是否正在拖入和悬停的分类名（用于覆盖层提示）。
 */
function useDragImport(): { dragging: boolean; targetName: string | null } {
  const [dragging, setDragging] = useState(false);
  const [targetName, setTargetName] = useState<string | null>(null);
  useEffect(() => {
    let depth = 0;
    const reset = () => {
      depth = 0;
      setDragging(false);
      setTargetName(null);
    };
    const onEnter = (e: DragEvent) => {
      if (!isDragAcceptable(e)) return;
      e.preventDefault();
      depth++;
      setDragging(true);
    };
    const onOver = (e: DragEvent) => {
      if (!isDragAcceptable(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      const id = dropCategoryAt(e.target);
      setTargetName(id ? (useLibraryStore.getState().categories.find((c) => c.id === id)?.name ?? null) : null);
    };
    const onLeave = (e: DragEvent) => {
      if (!isDragAcceptable(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) reset();
    };
    const onDrop = (e: DragEvent) => {
      if (!isDragAcceptable(e)) return;
      e.preventDefault();
      reset();
      void handleDropEvent(e);
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, []);
  return { dragging, targetName };
}

/** Ctrl+V（或点“粘贴”按钮）：把剪贴板里的图片 / 文件 / 网页图片存为表情 */
function usePasteImport() {
  useEffect(() => {
    document.addEventListener('paste', handlePasteEvent);
    return () => document.removeEventListener('paste', handlePasteEvent);
  }, []);
}

function Dialogs() {
  const dialog = useUiStore((s) => s.dialog);
  switch (dialog.kind) {
    case 'prompt':
      return <PromptDialog key={dialog.title} />;
    case 'confirm':
      return <ConfirmDialog key={dialog.title} />;
    case 'sticker':
      return <StickerDialog key={dialog.id} id={dialog.id} />;
    case 'subscriptions':
      return SUBSCRIPTIONS_ENABLED ? <SubscriptionsDialog focusAdd={dialog.focusAdd} /> : null;
    case 'settings':
      return <SettingsDialog />;
    case 'lanDevices':
      return <LanDevicesDialog />;
    case 'bulkTags':
      return <BulkTagDialog key={dialog.ids.join()} ids={dialog.ids} />;
    case 'bulkRename':
      return <BulkRenameDialog key={dialog.ids.join()} ids={dialog.ids} />;
    case 'move': {
      const ids = dialog.ids;
      const lib = useLibraryStore.getState();
      const current = ids.length === 1 ? (lib.stickers.find((s) => s.id === ids[0])?.categoryId ?? null) : undefined;
      return (
        <CategoryPickDialog
          key={ids.join()}
          title={ids.length === 1 ? '移动到分类' : `移动 ${ids.length} 个表情到分类`}
          current={current}
          newLabel="创建并移动"
          onPick={(id, name) => {
            useLibraryStore.getState().setCategoryFor(ids, id);
            useUiStore.getState().toast(`已移动到“${name}”`, 'success');
          }}
        />
      );
    }
    case 'pickCategory':
      return <CategoryPickDialog key={dialog.title} title={dialog.title} current={dialog.current} hint={dialog.hint} onPick={dialog.onPick} />;
    case 'importFolders':
      return (
        <ImportFolderDialog
          key={dialog.folders.map((f) => f.name).join('|')}
          folders={dialog.folders}
          parentName={dialog.parentName}
          parentId={dialog.parentId}
        />
      );
    case 'exportPackage':
      return <ExportDialog key={dialog.ids.join()} ids={dialog.ids} defaultName={dialog.defaultName} />;
    case 'categoryParent':
      return <CategoryParentDialog key={dialog.id} id={dialog.id} />;
    case 'update':
      return <UpdateDialog key={dialog.release.tag} release={dialog.release} current={dialog.current} />;
    case 'maker':
      return <MakerDialog key={dialog.source.type === 'sticker' ? dialog.source.id : dialog.source.file.name} source={dialog.source} />;
    case 'memeTemplates':
      return <MemeTemplatesDialog key={dialog.stickerId ?? ''} stickerId={dialog.stickerId} />;
    default:
      return null;
  }
}

export function App() {
  const loaded = useLibraryStore((s) => s.loaded);
  const loadError = useLibraryStore((s) => s.loadError);
  const stickers = useLibraryStore((s) => s.stickers);
  const categories = useLibraryStore((s) => s.categories);
  const usage = useLibraryStore((s) => s.usage);
  const hotkeyOk = useLibraryStore((s) => s.hotkeyOk);
  const floatHotkey = useLibraryStore((s) => s.settings.floatHotkey);
  const filter = useUiStore((s) => s.filter);
  const toast = useUiStore((s) => s.toast);

  useEffect(() => {
    void useLibraryStore.getState().load();
  }, []);
  useEffect(() => {
    if (loadError) toast(loadError, 'error');
  }, [loadError, toast]);
  // 启动几秒后静默检查一次新版本（不打扰加载和自动同步）
  useEffect(() => {
    if (!loaded) return;
    installDeepLinkHandler();
    installThumbWorker();
    installMobileHandlers();
    installLanSync();
    installUpdateListener();
    if (!useLibraryStore.getState().settings.checkUpdatesOnStart) return;
    const timer = setTimeout(() => void runUpdateCheck(false), 4000);
    return () => clearTimeout(timer);
  }, [loaded]);
  useEffect(() => {
    if (!hotkeyOk && floatHotkey) {
      toast(`浮窗快捷键 ${formatHotkey(floatHotkey)} 无法注册，可能被其他程序占用了，请到设置里更换`, 'error');
    }
  }, [hotkeyOk, floatHotkey, toast]);
  useTheme();
  useShortcuts();
  usePasteImport();
  const { dragging, targetName } = useDragImport();

  const filtered = useMemo(() => filterStickers(stickers, filter, usage, categories), [stickers, filter, usage, categories]);
  if (!loaded) return <div className="load-screen">正在加载…</div>;

  const isFiltered = filter.query.trim() !== '' || filter.tags.length > 0 || filter.view.kind !== 'all';
  return (
    <div className="app">
      <TopBar />
      <Sidebar />
      <main className="main">
        <FilterBar count={filtered.length} />
        {filtered.length > 0 ? <StickerGrid stickers={filtered} /> : <EmptyState filtered={isFiltered} />}
      </main>
      <SelectionBar />
      <ContextMenu />
      <Dialogs />
      <Toasts />
      {dragging && (
        <div className="drop-overlay">
          {targetName ? (
            <span>松开即导入到“{targetName}”</span>
          ) : (
            <span>
              松开即可导入：图片、文件夹（成为分类）、zip 表情包，网页上拖来的图片也可以
              <small>拖到左侧某个分类上，会直接放进那个分类</small>
            </span>
          )}
        </div>
      )}
    </div>
  );
}
