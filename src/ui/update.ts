import { useLibraryStore } from '../core/store';
import { useUiStore } from './uiStore';
import { checkForUpdate } from '../core/update';
import { errorMessage } from '../core/subscription/sync';
import { platform } from '../platform';

let checkedThisSession = false;

/**
 * 检查更新。manual 为 true 时（设置里点按钮）无论结果都给提示；
 * 启动时的自动检查只在有新版本、且用户没跳过该版本时弹窗，出错保持安静。
 */
export async function runUpdateCheck(manual: boolean): Promise<void> {
  const ui = useUiStore.getState();
  const lib = useLibraryStore.getState();
  if (!manual && checkedThisSession) return;
  checkedThisSession = true;
  try {
    const r = await checkForUpdate(platform, __GITHUB_REPO__, __APP_VERSION__);
    if (!r.latest) {
      if (manual) ui.toast('还没有发布过版本');
      return;
    }
    if (!r.available) {
      if (manual) ui.toast(`已经是最新版本（${r.current}）`, 'success');
      return;
    }
    if (!manual && lib.settings.skippedVersion === r.latest.version) return;
    ui.openDialog({ kind: 'update', release: r.latest, current: r.current });
  } catch (e) {
    if (manual) ui.toast(`检查更新失败：${errorMessage(e)}`, 'error');
  }
}
