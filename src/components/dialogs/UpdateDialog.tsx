import { useEffect, useState } from 'react';
import { useLibraryStore } from '../../core/store';
import { useUiStore } from '../../ui/uiStore';
import { accelerated, hostOf, pickAsset, probeAccelerators, type LatestRelease } from '../../core/update';
import { formatBytes } from '../../core/images';
import { platform } from '../../platform';
import { getAccelerators } from '../../ui/update';
import { Modal } from '../Dialog';
import { Icon } from '../../ui/icons';
import { ReleaseNotes } from '../ReleaseNotes';

type Health = 'ok' | 'bad';

export function UpdateDialog({ release, current }: { release: LatestRelease; current: string }) {
  const closeDialog = useUiStore((s) => s.closeDialog);
  const toast = useUiStore((s) => s.toast);
  const updateSettings = useLibraryStore((s) => s.updateSettings);
  const asset = pickAsset(release.assets, platform.os, platform.arch);
  const hasNotes = release.notes.trim() !== '';
  const date = release.publishedAt ? new Date(release.publishedAt).toLocaleDateString('zh-CN') : '';
  const viaMirror = release.source === 'mirror';
  const [accelerators, setAccelerators] = useState<string[]>([]);
  const [health, setHealth] = useState<Record<string, Health>>({});

  // 列出加速站，并实际探测一下此刻哪个能用（这类站点时好时坏）
  useEffect(() => {
    if (!asset) return;
    let alive = true;
    void getAccelerators().then((list) => {
      if (!alive) return;
      setAccelerators(list);
      probeAccelerators(platform, __GITHUB_REPO__, release.tag, list, (acc, ok) => {
        if (alive) setHealth((h) => ({ ...h, [acc]: ok ? 'ok' : 'bad' }));
      });
    });
    return () => {
      alive = false;
    };
  }, [asset?.url, release.tag]);

  const probed = accelerators.length > 0 && accelerators.every((a) => health[a] !== undefined);
  const bestAccelerator = accelerators.find((a) => health[a] === 'ok');
  // GitHub 直连能拿到版本信息就直接从 GitHub 下；版本信息是经镜像拿的，说明 GitHub 多半连不上，主按钮改走能用的加速站
  const primaryUrl = asset ? (viaMirror && bestAccelerator ? accelerated(bestAccelerator, asset.url) : asset.url) : release.url;
  const primaryLabel = !asset ? '前往发布页' : viaMirror && bestAccelerator ? `通过 ${hostOf(bestAccelerator)} 下载` : '下载';

  const open = (url: string) => {
    void platform.openExternal(url);
  };
  const download = () => {
    open(primaryUrl);
    closeDialog();
  };
  const skip = () => {
    updateSettings({ skippedVersion: release.version });
    toast(`已跳过 ${release.version}，有更新的版本时会再提醒`);
    closeDialog();
  };

  const digest = asset?.digest?.replace(/^sha256:/i, '');

  return (
    <Modal
      title={`发现新版本 ${release.version}`}
      onClose={closeDialog}
      footer={
        <>
          <button className="btn ghost left" onClick={skip}>
            跳过这个版本
          </button>
          <button className="btn" onClick={closeDialog}>
            稍后
          </button>
          <button className="btn primary" onClick={download}>
            <Icon name="download" /> {primaryLabel}
          </button>
        </>
      }
    >
      <div className="meta">
        <span>当前 {current}</span>
        <span>最新 {release.version}</span>
        {date && <span>发布于 {date}</span>}
        {asset && (
          <span title={digest ? `SHA-256：${digest}` : undefined}>
            {asset.name}
            {asset.size > 0 ? `（${formatBytes(asset.size)}）` : ''}
          </span>
        )}
        {viaMirror && <span title="GitHub 直连没有成功，版本信息是经镜像拿到的">版本信息来自 {release.via ?? '镜像'}</span>}
      </div>
      {hasNotes ? <ReleaseNotes markdown={release.notes} /> : <p>这个版本没有附带更新说明。</p>}
      {asset && (
        <div className="mirrors">
          <div className="label">
            {viaMirror ? '下载地址（GitHub 可能连不上，优先用标了 ✓ 的加速站）：' : 'GitHub 连不上？下面的公共加速站下载的是同一个文件：'}
          </div>
          <div className="links">
            <a className="chip" href={asset.url} title={asset.url} onClick={(e) => (e.preventDefault(), open(asset.url))}>
              <Icon name="external" size={12} /> GitHub 直连
            </a>
            {accelerators.map((acc) => {
              const state = health[acc];
              const url = accelerated(acc, asset.url);
              return (
                <a
                  key={acc}
                  className={`chip${state ? ` ${state}` : ''}`}
                  href={url}
                  title={state === 'bad' ? `${url}\n刚才测试连不上，也可以试试` : url}
                  onClick={(e) => (e.preventDefault(), open(url))}
                >
                  {hostOf(acc)}
                  {state === 'ok' && <span className="state">✓</span>}
                  {state === 'bad' && <span className="state">✗</span>}
                </a>
              );
            })}
          </div>
          <div className="hint">
            {accelerators.length === 0
              ? '正在获取加速站名单…'
              : probed
                ? bestAccelerator
                  ? '加速站是第三方公共服务，时好时坏，✓ 表示刚才测试能连上。'
                  : '刚才测试这些加速站都连不上，可以稍后再试，或换个网络。'
                : '正在测试各加速站能否连上…'}
            {asset.size > 0 && ` 文件大小应为 ${formatBytes(asset.size)}。`}
          </div>
        </div>
      )}
      <div className="hint">下载后运行安装包即可覆盖升级，你的表情和分类不会受影响。</div>
    </Modal>
  );
}
