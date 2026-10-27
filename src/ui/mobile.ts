import { platform } from '../platform';
import { useUiStore } from './uiStore';
import { importReceived } from './actions';

let installed = false;

/** 手机端：接收其他应用分享来的图片、系统返回键。桌面端的平台实现里这些回调不会触发 */
export function installMobileHandlers(): void {
  if (installed) return;
  installed = true;
  platform.onReceivedFiles((files, text) => void importReceived(files, text));
  platform.onBack(() => {
    const ui = useUiStore.getState();
    if (ui.menu) {
      ui.closeMenu();
      return true;
    }
    if (ui.dialog.kind !== 'none') {
      ui.closeDialog();
      return true;
    }
    if (ui.sidebarOpen) {
      ui.setSidebarOpen(false);
      return true;
    }
    if (ui.renamingId) {
      ui.setRenaming(null);
      return true;
    }
    if (ui.selection.size > 0) {
      ui.clearSelection();
      return true;
    }
    const f = ui.filter;
    if (f.query || f.tags.length > 0 || f.view.kind !== 'all') {
      ui.setQuery('');
      ui.clearTags();
      ui.setView({ kind: 'all' });
      return true;
    }
    return false;
  });
}
