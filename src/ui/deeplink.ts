import { useLibraryStore } from '../core/store';
import { useUiStore } from './uiStore';
import { syncSummary } from './hooks';
import { errorMessage } from '../core/subscription/sync';
import { platform } from '../platform';
import { parseDeepLink } from '../core/deeplink';
import { SUBSCRIPTIONS_ENABLED } from '../core/features';

/** 处理一条协议链接：弹出确认后添加订阅（已订阅的则直接同步） */
export async function handleDeepLink(link: string): Promise<void> {
  const ui = useUiStore.getState();
  if (!SUBSCRIPTIONS_ENABLED) {
    ui.toast('订阅功能暂未开放，这个链接先不处理');
    return;
  }
  const lib = useLibraryStore.getState();
  const parsed = parseDeepLink(link);
  if (!parsed) {
    ui.toast('收到了无法识别的链接', 'error');
    return;
  }
  const existing = lib.subscriptions.find((s) => s.url === parsed.url);
  if (existing) {
    ui.toast(`“${existing.name}”已经订阅过了，正在同步…`);
    try {
      const r = await lib.syncSubscription(existing.id);
      ui.toast(syncSummary(r), r.failed ? 'error' : 'success');
      ui.setView({ kind: 'subscription', id: existing.id });
    } catch (e) {
      ui.toast(errorMessage(e), 'error');
    }
    return;
  }
  let host = parsed.url;
  try {
    host = new URL(parsed.url).host;
  } catch {
    /* 已校验过 */
  }
  ui.openDialog({
    kind: 'confirm',
    title: '添加订阅？',
    message: `来自 ${host} 的表情包订阅地址：\n${parsed.url}\n\n添加后会立即下载，之后启动时自动同步更新。`,
    confirmText: '添加并同步',
    onConfirm: async () => {
      const { subscription, result } = await useLibraryStore.getState().addSubscription(parsed.url);
      useUiStore.getState().toast(`已添加“${subscription.name}”，${syncSummary(result)}`, result.failed ? 'error' : 'success');
      useUiStore.getState().setView({ kind: 'subscription', id: subscription.id });
    },
  });
}

let installed = false;
/** 启动后调用一次：接收协议链接事件，并处理启动时就带着的链接 */
export function installDeepLinkHandler(): void {
  if (installed) return;
  installed = true;
  const check = async () => {
    const link = await platform.takePendingDeepLink().catch(() => null);
    if (link) await handleDeepLink(link);
  };
  platform.onDeepLink(() => void check());
  void check();
}
