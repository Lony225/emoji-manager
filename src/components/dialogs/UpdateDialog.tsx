import { useEffect, useState, type ReactElement } from 'react';
import { useLibraryStore } from '../../core/store';
import { useUiStore } from '../../ui/uiStore';
import { useUpdateStore } from '../../ui/updateStore';
import { accelerated, hostOf, pickAsset, probeAccelerators, type LatestRelease } from '../../core/update';
import { formatBytes } from '../../core/images';
import { platform } from '../../platform';
import { canInstallAsset, cancelUpdateDownload, downloadUpdate, getAccelerators, installUpdate } from '../../ui/update';
import { Modal } from '../Dialog';
import { Icon } from '../../ui/icons';
import { ReleaseNotes } from '../ReleaseNotes';

type Health = 'ok' | 'bad';

export function UpdateDialog({ release, current }: { release: LatestRelease; current: string }) {
  const closeDialog = useUiStore((s) => s.closeDialog);
  const toast = useUiStore((s) => s.toast);
  const updateSettings = useLibraryStore((s) => s.updateSettings);
  const up = useUpdateStore((s) => s.state);
  const asset = pickAsset(release.assets, platform.os, platform.arch);
  const hasNotes = release.notes.trim() !== '';
  const date = release.publishedAt ? new Date(release.publishedAt).toLocaleDateString('zh-CN') : '';
  const viaMirror = release.source === 'mirror';
  const [accelerators, setAccelerators] = useState<string[]>([]);
  const [health, setHealth] = useState<Record<string, Health>>({});
  // 内置更新选的下载线路：'' 为 GitHub 直连，否则是加速站前缀；null 表示还没选、按探测结果自动定
  const [route, setRoute] = useState<string | null>(null);

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
  const autoRoute = viaMirror && bestAccelerator ? bestAccelerator : '';
  const primaryUrl = asset ? (autoRoute ? accelerated(autoRoute, asset.url) : asset.url) : release.url;
  const primaryLabel = !asset ? '前往发布页' : autoRoute ? `通过 ${hostOf(autoRoute)} 下载` : '下载';

  // 内置更新（Windows 安装版）：在应用里下载、校验、静默安装
  const builtin = canInstallAsset(asset);
  const mine = builtin && up.version === release.version;
  const busy = mine && (up.phase === 'checking' || up.phase === 'downloading');
  const downloaded = mine && up.phase === 'downloaded';
  const failed = mine && up.phase === 'error';
  const chosenRoute = route ?? autoRoute;
  // 高亮正在用 / 用过的线路：以主进程记的来源为准（弹窗关掉再打开时本地的选择已经没了）
  const viaRoute = up.via === 'github.com' ? '' : accelerators.find((a) => hostOf(a) === up.via);
  const activeRoute = mine ? (viaRoute ?? chosenRoute) : null;

  const open = (url: string) => {
    void platform.openExternal(url);
  };
  const download = () => {
    open(primaryUrl);
    closeDialog();
  };
  const startDownload = (acc: string) => {
    if (!asset || !builtin || busy || downloaded) return;
    setRoute(acc);
    void downloadUpdate(release, asset, acc);
  };
  const skip = () => {
    // 正在下载或已经下载好这个版本：一并作罢，退出时就不会装了
    if (mine) void cancelUpdateDownload();
    updateSettings({ skippedVersion: release.version });
    toast(`已跳过 ${release.version}，有更新的版本时会再提醒`);
    closeDialog();
  };

  const digest = asset?.digest?.replace(/^sha256:/i, '');
  const sizeHint = asset && asset.size > 0 ? `文件大小应为 ${formatBytes(asset.size)}。` : '';

  let primary: ReactElement;
  if (!builtin) {
    primary = (
      <button className="btn primary" onClick={download}>
        <Icon name="download" /> {primaryLabel}
      </button>
    );
  } else if (downloaded) {
    primary = (
      <button className="btn primary" onClick={() => void installUpdate()}>
        <Icon name="check" /> 立即安装并重启
      </button>
    );
  } else if (busy) {
    primary = (
      <button className="btn primary" disabled>
        {up.phase === 'checking' ? '正在准备…' : `正在下载 ${Math.floor(up.percent)}%`}
      </button>
    );
  } else if (viaMirror && route === null && !bestAccelerator && !probed) {
    // GitHub 多半连不上：等探测出一条能用的加速站再开始，免得第一下就撞在 GitHub 上等超时
    primary = (
      <button className="btn primary" disabled>
        正在测试下载线路…
      </button>
    );
  } else {
    primary = (
      <button className="btn primary" onClick={() => startDownload(chosenRoute)}>
        <Icon name="download" /> {failed ? '重试' : chosenRoute ? `通过 ${hostOf(chosenRoute)} 下载并安装` : '下载并安装'}
      </button>
    );
  }

  return (
    <Modal
      title={`发现新版本 ${release.version}`}
      onClose={closeDialog}
      footer={
        <>
          <button className="btn ghost left" onClick={skip}>
            跳过这个版本
          </button>
          {busy ? (
            <button className="btn" onClick={() => void cancelUpdateDownload()}>
              取消下载
            </button>
          ) : (
            <button className="btn" onClick={closeDialog}>
              稍后
            </button>
          )}
          {primary}
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
      {mine && (
        <div className={`update-progress ${up.phase}`}>
          {(up.phase === 'checking' || up.phase === 'downloading') && (
            <span className="progress">
              <i style={{ width: `${up.phase === 'downloading' ? Math.min(100, Math.max(0, up.percent)) : 0}%` }} />
            </span>
          )}
          <div className={up.phase === 'error' ? 'error-text' : 'hint'}>
            {up.phase === 'checking' && `正在从 ${up.via ?? '服务器'} 获取更新信息…`}
            {up.phase === 'downloading' &&
              `${formatBytes(up.transferred)}${up.total > 0 ? ` / ${formatBytes(up.total)}` : ''}${up.bytesPerSecond > 0 ? ` · ${formatBytes(up.bytesPerSecond)}/s` : ''}${up.via ? ` · 来自 ${up.via}` : ''}`}
            {up.phase === 'downloaded' && '安装包已下载并通过校验。点「立即安装并重启」完成升级；也可以稍后，退出应用时会自动安装。'}
            {up.phase === 'error' && `下载失败：${up.error ?? '未知错误'}`}
          </div>
        </div>
      )}
      {asset && (
        <div className="mirrors">
          <div className="label">
            {builtin
              ? '下载线路（点一条换着试，✓ 表示刚才测试能连上）：'
              : viaMirror
                ? '下载地址（GitHub 可能连不上，优先用标了 ✓ 的加速站）：'
                : 'GitHub 连不上？下面的公共加速站下载的是同一个文件：'}
          </div>
          <div className="links">
            <a
              className={`chip${activeRoute === '' ? ' active' : ''}`}
              href={asset.url}
              title={asset.url}
              onClick={(e) => (e.preventDefault(), builtin ? startDownload('') : open(asset.url))}
            >
              <Icon name="external" size={12} /> GitHub 直连
            </a>
            {accelerators.map((acc) => {
              const state = health[acc];
              const url = accelerated(acc, asset.url);
              return (
                <a
                  key={acc}
                  className={`chip${state ? ` ${state}` : ''}${activeRoute === acc ? ' active' : ''}`}
                  href={url}
                  title={state === 'bad' ? `${url}\n刚才测试连不上，也可以试试` : url}
                  onClick={(e) => (e.preventDefault(), builtin ? startDownload(acc) : open(url))}
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
            {sizeHint && ` ${sizeHint}`}
          </div>
        </div>
      )}
      {builtin ? (
        <div className="hint">
          下载并校验通过后点「立即安装并重启」就会自动安装并重新启动（不点的话退出应用时也会装上），你的表情和分类不会受影响。也可以{' '}
          <a href={primaryUrl} onClick={(e) => (e.preventDefault(), open(primaryUrl))}>
            在浏览器里下载安装包
          </a>
          。
        </div>
      ) : (
        <div className="hint">下载后运行安装包即可覆盖升级，你的表情和分类不会受影响。</div>
      )}
    </Modal>
  );
}
