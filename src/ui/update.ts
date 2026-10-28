import { useLibraryStore } from '../core/store';
import { useUiStore } from './uiStore';
import { useUpdateStore } from './updateStore';
import { DEFAULT_ACCELERATORS, checkForUpdate, hostOf, installerBaseUrl, loadAccelerators, type LatestRelease, type ReleaseAsset } from '../core/update';
import { errorMessage } from '../core/subscription/sync';
import { platform } from '../platform';
import type { UpdateState } from '../platform/types';

let checkedThisSession = false;
let acceleratorsPromise: Promise<string[]> | null = null;

/** 公共加速站名单：本次会话只从仓库拉一次（经 jsDelivr），拉不到用内置的 */
export function getAccelerators(): Promise<string[]> {
  if (!acceleratorsPromise) {
    acceleratorsPromise = loadAccelerators(platform, __GITHUB_REPO__).catch(() => [...DEFAULT_ACCELERATORS]);
  }
  return acceleratorsPromise;
}

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
    const r = await checkForUpdate(platform, __GITHUB_REPO__, __APP_VERSION__, { productName: __PRODUCT_NAME__, getAccelerators });
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

// ---------------------------------------------------------------- 内置更新（Windows 安装版）

let listening = false;

/** 订阅主进程的下载状态；下载在弹窗关掉之后完成时给一条提示 */
export function installUpdateListener(): void {
  if (listening || !platform.capabilities.installUpdates || platform.windowRole !== 'main') return;
  listening = true;
  const apply = (s: UpdateState) => {
    const prev = useUpdateStore.getState().state;
    useUpdateStore.getState().setState(s);
    if (s.phase === 'downloaded' && prev.phase !== 'downloaded' && useUiStore.getState().dialog.kind !== 'update') {
      useUiStore.getState().toast(`新版本 ${s.version} 已下载好，退出应用时会自动安装`, 'success');
    }
  };
  platform.onUpdateState(apply);
  void platform.updateState().then(apply, () => undefined);
}

/** 这个安装包能不能在应用里直接装：Windows 安装版 + 对方是 Windows 安装包（不是便携版） */
export function canInstallAsset(asset: ReleaseAsset | undefined): boolean {
  return !!asset && platform.capabilities.installUpdates && /\.exe$/i.test(asset.name) && !/portable/i.test(asset.name);
}

/**
 * 在应用里下载某个版本的安装包。accelerator 为空表示 GitHub 直连。
 * 进度和结果都在 useUpdateStore 里；失败时返回 false（弹窗没开着就再给条提示）
 */
export async function downloadUpdate(release: LatestRelease, asset: ReleaseAsset, accelerator = ''): Promise<boolean> {
  const ui = useUiStore.getState();
  const baseUrl = installerBaseUrl(asset.url, accelerator);
  if (!baseUrl) {
    ui.toast('安装包地址无效', 'error');
    return false;
  }
  let error: string;
  try {
    const result = await platform.updateDownload({
      baseUrl,
      version: release.version,
      via: accelerator ? hostOf(accelerator) : 'github.com',
      sha256: asset.digest?.replace(/^sha256:/i, ''),
    });
    if (result.phase === 'downloaded') return true;
    error = result.error ?? '未知错误';
  } catch (e) {
    error = errorMessage(e);
  }
  if (error !== '已取消' && useUiStore.getState().dialog.kind !== 'update') ui.toast(`下载更新失败：${error}`, 'error');
  return false;
}

/** 取消正在进行的下载；已经下载好的则删掉安装包（退出时不再安装） */
export async function cancelUpdateDownload(): Promise<void> {
  await platform.updateCancel().catch(() => undefined);
}

/** 退出并安装已下载好的新版本，装完自动重新启动 */
export async function installUpdate(): Promise<void> {
  try {
    await useLibraryStore.getState().flush();
    await platform.updateInstall();
  } catch (e) {
    useUiStore.getState().toast(`无法安装更新：${errorMessage(e)}`, 'error');
  }
}
