import { useMemo, useState } from 'react';
import { useLibraryStore } from '../../core/store';
import { useUiStore } from '../../ui/uiStore';
import { useLanStore } from '../../ui/lanStore';
import { describeDevice, pairWith, removePair, renameSelf, syncAllOnline, syncWith } from '../../ui/lan';
import { platform } from '../../platform';
import type { LanDevice } from '../../platform/types';
import type { LanPair } from '../../core/lan/protocol';
import type { SyncProgress } from '../../core/lan/session';
import { formatTime } from '../../ui/hooks';
import { Modal } from '../Dialog';
import { Icon, Spinner, type IconName } from '../../ui/icons';

function osIcon(os: string): IconName {
  return os === 'android' || os === 'ios' ? 'phone' : 'laptop';
}

function progressText(p: SyncProgress): string {
  switch (p.phase) {
    case 'begin':
      return '正在比对…';
    case 'transfer':
      return p.total > 0 ? `正在传输图片 ${p.done}/${p.total}…` : '正在传输…';
    case 'apply':
      return '正在应用改动…';
    default:
      return '完成';
  }
}

export function LanDevicesDialog() {
  const closeDialog = useUiStore((s) => s.closeDialog);
  const openDialog = useUiStore((s) => s.openDialog);
  const identity = useLanStore((s) => s.identity);
  const devices = useLanStore((s) => s.devices);
  const syncing = useLanStore((s) => s.syncing);
  const pairing = useLanStore((s) => s.pairing);
  const running = useLanStore((s) => s.running);
  const startError = useLanStore((s) => s.startError);
  const autoSync = useLibraryStore((s) => s.settings.lanAutoSync);
  const updateSettings = useLibraryStore((s) => s.updateSettings);
  const [name, setName] = useState(identity.name);

  /** 已配对的在前（在线的更前），然后是未配对的在线设备 */
  const rows = useMemo(() => {
    const online = new Map(devices.map((d) => [d.id, d]));
    const paired = identity.pairs
      .map((p) => ({ pair: p, device: online.get(p.id) }))
      .sort((a, b) => Number(!!b.device) - Number(!!a.device) || a.pair.name.localeCompare(b.pair.name, 'zh-Hans-CN'));
    const unpaired = devices.filter((d) => !identity.pairs.some((p) => p.id === d.id)).map((d) => ({ pair: undefined, device: d }));
    return [...paired, ...unpaired];
  }, [devices, identity.pairs]);
  const anyOnlinePaired = rows.some((r) => r.pair && r.device);
  const anySyncing = Object.keys(syncing).length > 0;

  const confirmUnpair = (pair: LanPair) =>
    openDialog({
      kind: 'confirm',
      title: `解除和“${pair.name}”的配对？`,
      message: '之后两台设备不再互相同步；已经同步过来的表情保留。可以随时重新配对。',
      confirmText: '解除配对',
      danger: true,
      onConfirm: () => {
        removePair(pair.id, true);
        // 确认框关闭后回到设备列表（它关闭自己是在 onConfirm 之后，所以要排到后面）
        setTimeout(() => useUiStore.getState().openDialog({ kind: 'lanDevices' }), 0);
      },
    });

  return (
    <Modal
      title="局域网同步"
      wide
      onClose={closeDialog}
      footer={
        <>
          <label className="checkbox left">
            <input type="checkbox" checked={autoSync} onChange={(e) => updateSettings({ lanAutoSync: e.target.checked })} />
            已配对设备上线或本机有改动时自动同步
          </label>
          <button className="btn" onClick={closeDialog}>
            关闭
          </button>
          <button className="btn primary" disabled={!anyOnlinePaired || anySyncing} onClick={() => void syncAllOnline(true)}>
            {anySyncing ? <Spinner /> : <Icon name="sync" />} 立即同步
          </button>
        </>
      }
    >
      <div className="lan-self">
        <Icon name={osIcon(platform.os)} size={18} />
        <span>这台设备叫</span>
        <input
          className="input"
          value={name}
          maxLength={40}
          aria-label="本机名称"
          onChange={(e) => setName(e.target.value)}
          onBlur={() => renameSelf(name)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              renameSelf(name);
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
        <span className="hint">{running ? `正在发现同一网络里的设备…` : (startError ?? '服务未启动')}</span>
      </div>

      {rows.length === 0 ? (
        <div className="lan-empty">
          还没有发现其他设备。
          <br />
          在另一台电脑或手机上打开表情包管理器，同样打开「设置 → 局域网同步」，几秒内就会出现在这里。
          <br />
          两台设备要连在同一个 Wi-Fi / 局域网里；电脑上的防火墙如果询问，请允许本应用访问专用网络。
        </div>
      ) : (
        <div className="lan-list">
          {rows.map(({ pair, device }) => (
            <DeviceRow
              key={pair?.id ?? device!.id}
              pair={pair}
              device={device}
              progress={syncing[pair?.id ?? device!.id]}
              pairingThis={pairing === device?.id}
              pairingBusy={pairing !== null}
              onUnpair={confirmUnpair}
            />
          ))}
        </div>
      )}
    </Modal>
  );
}

function DeviceRow({
  pair,
  device,
  progress,
  pairingThis,
  pairingBusy,
  onUnpair,
}: {
  pair?: LanPair;
  device?: LanDevice;
  progress?: SyncProgress;
  pairingThis: boolean;
  pairingBusy: boolean;
  onUnpair: (pair: LanPair) => void;
}) {
  const online = !!device;
  const name = pair?.name ?? device?.name ?? '设备';
  const os = device?.os ?? pair?.os ?? 'unknown';
  let status: string;
  let error = false;
  if (progress) status = progressText(progress);
  else if (pairingThis) status = '等待对方允许配对…';
  else if (pair) {
    if (pair.lastError) {
      status = `上次同步出错：${pair.lastError}`;
      error = true;
    } else status = pair.lastSyncAt ? `上次同步：${formatTime(pair.lastSyncAt)}${pair.lastResult ? `，${pair.lastResult}` : ''}` : '已配对，还没同步过';
  } else status = `${describeDevice(os)}${device?.version ? ` · v${device.version}` : ''} · 未配对`;

  return (
    <div className={`lan-item${online ? ' online' : ''}`} data-device={pair?.id ?? device?.id}>
      <span className="os-icon">
        <Icon name={osIcon(os)} size={18} />
      </span>
      <div className="info">
        <div className="name">
          {name}
          {pair && <span className={`badge${online ? ' online' : ''}`}>{online ? '在线' : '离线'}</span>}
        </div>
        <div className={`status${error ? ' error' : ''}`} title={status}>
          {status}
        </div>
      </div>
      <div className="actions">
        {pair ? (
          <>
            <button className="btn sm" disabled={!online || !!progress} onClick={() => void syncWith(pair.id, { manual: true })} title={online ? '现在就和它同步一次' : '对方不在线'}>
              {progress ? <Spinner size={14} /> : <Icon name="sync" size={14} />} 同步
            </button>
            <button className="btn sm ghost" disabled={!!progress} onClick={() => onUnpair(pair)} title="解除配对">
              <Icon name="unlink" size={14} />
            </button>
          </>
        ) : (
          <button className="btn sm primary" disabled={pairingBusy} onClick={() => device && void pairWith(device)}>
            {pairingThis ? <Spinner size={14} /> : <Icon name="link" size={14} />} 配对
          </button>
        )}
      </div>
    </div>
  );
}
