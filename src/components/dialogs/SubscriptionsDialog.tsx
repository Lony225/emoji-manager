import { useMemo, useState } from 'react';
import { useLibraryStore } from '../../core/store';
import { useUiStore } from '../../ui/uiStore';
import { subscriptionCounts } from '../../core/selectors';
import { errorMessage } from '../../core/subscription/sync';
import type { Subscription } from '../../core/types';
import { platform } from '../../platform';
import { formatTime, syncSummary } from '../../ui/hooks';
import { Modal } from '../Dialog';
import { Icon, Spinner } from '../../ui/icons';

export function SubscriptionsDialog({ focusAdd }: { focusAdd?: boolean }) {
  const closeDialog = useUiStore((s) => s.closeDialog);
  const toast = useUiStore((s) => s.toast);
  const subscriptions = useLibraryStore((s) => s.subscriptions);
  const stickers = useLibraryStore((s) => s.stickers);
  const counts = useMemo(() => subscriptionCounts(stickers), [stickers]);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const add = async () => {
    setBusy(true);
    setError('');
    try {
      const { subscription, result } = await useLibraryStore.getState().addSubscription(url);
      toast(`已添加“${subscription.name}”，${syncSummary(result)}`, result.failed ? 'error' : 'success');
      setUrl('');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="订阅" wide onClose={closeDialog}>
      <form
        className="field"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <label htmlFor="sub-url">订阅地址</label>
        <div className="row">
          <input
            id="sub-url"
            className="input"
            autoFocus={focusAdd}
            placeholder="https://example.com/stickers/pack.json"
            value={url}
            spellCheck={false}
            onChange={(e) => {
              setUrl(e.target.value);
              setError('');
            }}
          />
          <button className="btn primary" type="submit" disabled={busy || !url.trim()} style={{ flex: 'none' }}>
            {busy ? <Spinner /> : <Icon name="plus" />} 添加并同步
          </button>
        </div>
        {error && <div className="error-text">{error}</div>}
        <div className="hint">
          地址指向一个 JSON 清单文件（格式见项目的 docs/subscription-format.md）。清单里的每个表情包会成为一个分类，之后可随时重新同步。
        </div>
      </form>
      <div className="sub-list">
        {subscriptions.length === 0 && <p>还没有订阅。</p>}
        {subscriptions.map((sub) => (
          <SubscriptionItem key={sub.id} sub={sub} count={counts.get(sub.id) ?? 0} />
        ))}
      </div>
    </Modal>
  );
}

function SubscriptionItem({ sub, count }: { sub: Subscription; count: number }) {
  const status = useLibraryStore((s) => s.syncStatus[sub.id]);
  const toast = useUiStore((s) => s.toast);
  const openDialog = useUiStore((s) => s.openDialog);
  const closeDialog = useUiStore((s) => s.closeDialog);
  const setView = useUiStore((s) => s.setView);
  const lib = useLibraryStore.getState;
  const running = !!status?.running;
  const p = status?.progress;

  const sync = () =>
    void lib()
      .syncSubscription(sub.id)
      .then((r) => toast(syncSummary(r), r.failed ? 'error' : 'success'))
      .catch((e) => toast(errorMessage(e), 'error'));

  const restore = () =>
    void lib()
      .restoreHidden(sub.id)
      .then((r) => toast(syncSummary(r), 'success'))
      .catch((e) => toast(errorMessage(e), 'error'));

  const remove = () =>
    openDialog({
      kind: 'confirm',
      title: `删除订阅“${sub.name}”？`,
      message: '删除后不再同步。不勾选下面的选项时，已下载的表情会保留为本地表情。',
      confirmText: '删除',
      danger: true,
      checkbox: count > 0 ? { label: `同时删除已下载的 ${count} 个表情`, checked: true } : undefined,
      onConfirm: async (del) => {
        await lib().removeSubscription(sub.id, del);
        toast('订阅已删除');
      },
    });

  let statusText = `上次同步：${formatTime(sub.lastSuccessAt)}`;
  if (running) {
    statusText = p?.phase === 'download' && p.total > 0 ? `正在下载 ${p.done}/${p.total}…` : '正在获取清单…';
  }
  const hiddenCount = sub.hiddenKeys?.length ?? 0;

  return (
    <div className="sub-item">
      <div className="title">
        {running ? <Spinner size={14} /> : <Icon name="rss" size={15} />}
        <span>{sub.name}</span>
        <span className="count num">{count} 个表情</span>
        {sub.remoteVersion && <span className="count">v{sub.remoteVersion}</span>}
      </div>
      {sub.description && <div className="hint">{sub.description}</div>}
      <div className="url" title={sub.url}>
        {sub.url}
      </div>
      <div className="status">{statusText}</div>
      {sub.lastError && !running && <div className="status error">上次同步出错：{sub.lastError}</div>}
      <div className="actions">
        <label className="checkbox">
          <input
            type="checkbox"
            checked={sub.deleteRemoved}
            onChange={(e) => lib().updateSubscription(sub.id, { deleteRemoved: e.target.checked })}
          />
          远端移除的表情也在本地删除
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={sub.autoSync}
            onChange={(e) => lib().updateSubscription(sub.id, { autoSync: e.target.checked })}
          />
          启动时自动同步
        </label>
        <span className="spacer" />
        {hiddenCount > 0 && (
          <button className="btn sm" onClick={restore} disabled={running} title="把你删除过的表情重新下载回来">
            <Icon name="undo" size={14} /> 恢复已删除的 {hiddenCount} 个
          </button>
        )}
        {sub.homepage && (
          <button className="btn sm ghost" onClick={() => void platform.openExternal(sub.homepage!)}>
            <Icon name="external" size={14} /> 主页
          </button>
        )}
        <button
          className="btn sm"
          onClick={() => {
            setView({ kind: 'subscription', id: sub.id });
            closeDialog();
          }}
        >
          <Icon name="eye" size={14} /> 查看
        </button>
        <button className="btn sm" onClick={sync} disabled={running}>
          <Icon name="sync" size={14} /> 同步
        </button>
        <button className="btn sm danger" onClick={remove} disabled={running}>
          <Icon name="trash" size={14} /> 删除
        </button>
      </div>
    </div>
  );
}
