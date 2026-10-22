import { useEffect, useMemo, useState } from 'react';
import { useLibraryStore } from './core/store';
import { useUiStore } from './ui/uiStore';
import { filterStickers } from './core/selectors';
import {
  confirmDeleteStickers,
  copyManyWithFeedback,
  getVisibleOrder,
  importImages,
  importPackageFile,
  isImageFile,
  openFoldersImport,
  readDroppedItems,
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
import { formatHotkey } from './components/HotkeyInput';
import { runUpdateCheck } from './ui/update';
import { useTheme } from './ui/hooks';

function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
}

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
      if (isEditable(e.target) || ui.dialog.kind !== 'none') return;
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

/** 拖图片进窗口即导入；返回是否正在拖入（用于显示覆盖层） */
function useDragImport(): boolean {
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      setDragging(true);
    };
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const items = e.dataTransfer?.items ?? null;
      const fallback = e.dataTransfer?.files ?? null;
      void (async () => {
        try {
          const { files, folders } = await readDroppedItems(items, fallback);
          // zip 表情包直接导入，图片放进当前分类，文件夹逐个询问是否成为分类
          const zips = files.filter((f) => /\.zip$/i.test(f.name));
          const images = files.filter(isImageFile);
          for (const z of zips) await importPackageFile(z);
          if (images.length) importImages(images);
          if (folders.length) openFoldersImport(folders);
          if (!zips.length && !images.length && !folders.length) {
            useUiStore.getState().toast('没有可导入的图片、文件夹或 zip 表情包', 'error');
          }
        } catch (err) {
          useUiStore.getState().toast(`导入失败：${err instanceof Error ? err.message : String(err)}`, 'error');
        }
      })();
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
  return dragging;
}

/** Ctrl+V 粘贴剪贴板里的图片即导入（从聊天窗口里保存表情最快的方式） */
function usePasteImport() {
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (isEditable(e.target) || useUiStore.getState().dialog.kind !== 'none') return;
      const files = Array.from(e.clipboardData?.files ?? []).filter(isImageFile);
      if (files.length === 0) return;
      e.preventDefault();
      const named = files.map((f, i) => {
        if (f.name && f.name !== 'image.png') return f;
        const ext = (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
        return new File([f], `粘贴的表情 ${i + 1}.${ext}`, { type: f.type });
      });
      importImages(named);
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
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
      return <SubscriptionsDialog focusAdd={dialog.focusAdd} />;
    case 'settings':
      return <SettingsDialog />;
    case 'bulkTags':
      return <BulkTagDialog key={dialog.ids.join()} ids={dialog.ids} />;
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
      return <ImportFolderDialog key={dialog.folders.map((f) => f.name).join('|')} folders={dialog.folders} parentName={dialog.parentName} />;
    case 'exportPackage':
      return <ExportDialog key={dialog.ids.join()} ids={dialog.ids} defaultName={dialog.defaultName} />;
    case 'categoryParent':
      return <CategoryParentDialog key={dialog.id} id={dialog.id} />;
    case 'update':
      return <UpdateDialog key={dialog.release.tag} release={dialog.release} current={dialog.current} />;
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
    if (!loaded || !useLibraryStore.getState().settings.checkUpdatesOnStart) return;
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
  const dragging = useDragImport();

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
      {dragging && <div className="drop-overlay">松开即可导入：图片、文件夹（成为分类）或 zip 表情包</div>}
    </div>
  );
}
