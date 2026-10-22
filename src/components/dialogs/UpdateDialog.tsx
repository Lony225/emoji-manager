import { useLibraryStore } from '../../core/store';
import { useUiStore } from '../../ui/uiStore';
import { pickAsset, plainNotes, type LatestRelease } from '../../core/update';
import { formatBytes } from '../../core/images';
import { platform } from '../../platform';
import { Modal } from '../Dialog';
import { Icon } from '../../ui/icons';

export function UpdateDialog({ release, current }: { release: LatestRelease; current: string }) {
  const closeDialog = useUiStore((s) => s.closeDialog);
  const toast = useUiStore((s) => s.toast);
  const updateSettings = useLibraryStore((s) => s.updateSettings);
  const asset = pickAsset(release.assets, platform.os, platform.arch);
  const notes = plainNotes(release.notes);
  const date = release.publishedAt ? new Date(release.publishedAt).toLocaleDateString('zh-CN') : '';

  const download = () => {
    void platform.openExternal(asset?.url ?? release.url);
    closeDialog();
  };
  const skip = () => {
    updateSettings({ skippedVersion: release.version });
    toast(`已跳过 ${release.version}，有更新的版本时会再提醒`);
    closeDialog();
  };

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
            <Icon name="download" /> {asset ? '下载' : '前往发布页'}
          </button>
        </>
      }
    >
      <div className="meta">
        <span>当前 {current}</span>
        <span>最新 {release.version}</span>
        {date && <span>发布于 {date}</span>}
        {asset && (
          <span>
            {asset.name}（{formatBytes(asset.size)}）
          </span>
        )}
      </div>
      {notes ? <pre className="notes">{notes}</pre> : <p>这个版本没有附带更新说明。</p>}
      <div className="hint">下载后运行安装包即可覆盖升级，你的表情和分类不会受影响。</div>
    </Modal>
  );
}
