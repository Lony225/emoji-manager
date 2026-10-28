import { useEffect, useState } from 'react';
import { useLibraryStore } from '../../core/store';
import { useUiStore } from '../../ui/uiStore';
import type { CopyMode, Theme } from '../../core/types';
import { isMobile, platform } from '../../platform';
import { errorMessage } from '../../core/subscription/sync';
import { openExportDialog, pickAndImportPackage } from '../../ui/actions';
import { runUpdateCheck } from '../../ui/update';
import { SUBSCRIPTIONS_ENABLED } from '../../core/features';
import { Modal } from '../Dialog';
import { HotkeyInput } from '../HotkeyInput';
import { Icon } from '../../ui/icons';
import { useLanStore } from '../../ui/lanStore';

const THEMES: { key: Theme; label: string }[] = [
  { key: 'system', label: '跟随系统' },
  { key: 'light', label: '浅色' },
  { key: 'dark', label: '深色' },
];

export function SettingsDialog() {
  const settings = useLibraryStore((s) => s.settings);
  const hotkeyOk = useLibraryStore((s) => s.hotkeyOk);
  const updateSettings = useLibraryStore((s) => s.updateSettings);
  const flush = useLibraryStore((s) => s.flush);
  const closeDialog = useUiStore((s) => s.closeDialog);
  const openDialog = useUiStore((s) => s.openDialog);
  const toast = useUiStore((s) => s.toast);
  const [libPath, setLibPath] = useState('');
  const [login, setLogin] = useState<{ enabled: boolean; available: boolean }>({ enabled: false, available: false });
  const lanRunning = useLanStore((s) => s.running);
  const lanError = useLanStore((s) => s.startError);
  const lanPairs = useLanStore((s) => s.identity.pairs.length);
  const lanOnline = useLanStore((s) => s.devices.length);
  const caps = platform.capabilities;

  useEffect(() => {
    void platform.getLibraryPath().then(setLibPath);
    if (caps.desktop) void platform.getLaunchAtLogin().then(setLogin);
  }, [caps.desktop]);

  const changeDir = async () => {
    const r = await platform.chooseLibraryDir();
    if (r.error) {
      toast(r.error, 'error');
      return;
    }
    if (!r.changed) return;
    openDialog({
      kind: 'confirm',
      title: '数据目录已更改',
      message: `新目录：${r.path}。需要重新启动应用才会生效。`,
      confirmText: '立即重启',
      onConfirm: async () => {
        await flush();
        await platform.relaunch();
      },
    });
  };

  const setLaunchAtLogin = async (on: boolean) => {
    try {
      await platform.setLaunchAtLogin(on);
      setLogin((l) => ({ ...l, enabled: on }));
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  return (
    <Modal title="设置" onClose={closeDialog}>
      <div className="setting">
        <div className="text">主题</div>
        <div className="segmented" role="group" aria-label="主题">
          {THEMES.map((t) => (
            <button key={t.key} className={settings.theme === t.key ? 'active' : ''} onClick={() => updateSettings({ theme: t.key })}>
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {isMobile && caps.share && (
        <div className="setting">
          <div className="text">
            点一下表情时
            <small>“分享”打开系统分享面板，直接发到微信 / QQ；“复制”放进剪贴板，支持粘贴图片的聊天软件可以直接粘贴。长按表情还有更多操作。</small>
          </div>
          <div className="segmented" role="group" aria-label="点一下表情时">
            {(
              [
                ['share', '分享'],
                ['copy', '复制'],
              ] as const
            ).map(([key, label]) => (
              <button key={key} className={settings.tapAction === key ? 'active' : ''} onClick={() => updateSettings({ tapAction: key })}>
                {label}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="setting">
        <div className="text">
          {isMobile ? '复制方式' : '点击表情时的复制方式'}
          <small>动图按文件复制能保留动画；粘贴后背景发黑的话，改成“总是复制文件”试试。</small>
        </div>
        <select
          className="select"
          value={settings.copyMode}
          onChange={(e) => updateSettings({ copyMode: e.target.value as CopyMode })}
          disabled={!caps.copyFile}
        >
          <option value="auto">自动</option>
          <option value="file">总是复制文件</option>
          <option value="image">总是复制图片</option>
        </select>
      </div>

      <div className="setting">
        <div className="text">
          网格里的动图
          <small>“自动”在动图不多时播放，动图很多会卡时自动改成悬停才播放；网格平时显示的是缩略图，更省资源。</small>
        </div>
        <div className="segmented" role="group" aria-label="网格里的动图">
          {(
            [
              ['always', '全部播放'],
              ['auto', '自动'],
              ['hover', '悬停播放'],
            ] as const
          ).map(([key, label]) => (
            <button key={key} className={settings.gridAnimation === key ? 'active' : ''} onClick={() => updateSettings({ gridAnimation: key })}>
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="setting">
        <div className="text">
          在网格里显示表情名称
          <small>点名称可以直接改名；选中后按 F2 也可以。</small>
        </div>
        <input
          type="checkbox"
          checked={settings.showNames}
          onChange={(e) => updateSettings({ showNames: e.target.checked })}
          aria-label="在网格里显示表情名称"
        />
      </div>

      {SUBSCRIPTIONS_ENABLED && (
        <div className="setting">
          <div className="text">启动时自动同步订阅</div>
          <input
            type="checkbox"
            checked={settings.autoSyncOnStart}
            onChange={(e) => updateSettings({ autoSyncOnStart: e.target.checked })}
            aria-label="启动时自动同步订阅"
          />
        </div>
      )}

      {caps.desktop && (
        <>
          <div className="setting">
            <div className="text">
              浮窗快捷键
              <small>在任何程序里按下即可呼出浮窗，搜索或点选表情后自动复制。</small>
              {!hotkeyOk && settings.floatHotkey && <small className="error-text">这个快捷键被其他程序占用了，请换一个。</small>}
            </div>
            <div className="row">
              <HotkeyInput value={settings.floatHotkey} onChange={(acc) => updateSettings({ floatHotkey: acc })} />
              <button className="btn sm" onClick={() => void platform.showFloat()} title="现在就打开浮窗看看">
                <Icon name="window" size={14} /> 显示浮窗
              </button>
            </div>
          </div>

          <div className="setting">
            <div className="text">
              关闭主窗口时最小化到托盘
              <small>关闭后程序继续在后台运行，快捷键和浮窗照常可用；要退出请右键托盘图标。</small>
            </div>
            <input
              type="checkbox"
              checked={settings.closeToTray}
              onChange={(e) => updateSettings({ closeToTray: e.target.checked })}
              aria-label="关闭主窗口时最小化到托盘"
            />
          </div>

          <div className="setting">
            <div className="text">
              开机自动启动
              <small>{login.available ? '启动时只显示托盘图标，不打开主窗口。' : '安装版才能设置（开发模式或便携版不可用）。'}</small>
            </div>
            <input
              type="checkbox"
              checked={login.enabled}
              disabled={!login.available}
              onChange={(e) => void setLaunchAtLogin(e.target.checked)}
              aria-label="开机自动启动"
            />
          </div>
        </>
      )}

      {caps.lanSync && (
        <div className="setting">
          <div className="text">
            局域网同步
            <small>
              和同一 Wi-Fi / 局域网里装了本应用的电脑、手机互相同步表情：自动发现设备，配对一次即可，之后增量同步，两边的改动都保留。
            </small>
            {settings.lanSync && lanError && <small className="error-text">{lanError}</small>}
            {settings.lanSync && lanRunning && (
              <small>
                已配对 {lanPairs} 台，当前发现 {lanOnline} 台在线。
              </small>
            )}
          </div>
          <div className="row">
            <input
              type="checkbox"
              checked={settings.lanSync}
              onChange={(e) => updateSettings({ lanSync: e.target.checked })}
              aria-label="局域网同步"
            />
            <button className="btn sm" disabled={!settings.lanSync} onClick={() => openDialog({ kind: 'lanDevices' })}>
              <Icon name="wifi" size={14} /> 设备…
            </button>
          </div>
        </div>
      )}

      <div className="setting">
        <div className="text">
          数据目录
          <small style={{ userSelect: 'text', wordBreak: 'break-all' }}>{libPath}</small>
          {caps.changeLibraryDir && <small>放到 OneDrive / iCloud 等同步盘目录里，就能在多台电脑间共用同一份表情库。</small>}
        </div>
        {caps.changeLibraryDir && (
          <div className="row">
            <button className="btn sm" onClick={() => void platform.openLibraryDir()}>
              打开
            </button>
            <button className="btn sm" onClick={() => void changeDir()}>
              更改…
            </button>
          </div>
        )}
      </div>

      <div className="setting">
        <div className="text">
          备份与分享
          <small>把全部表情连同名称、标签、分类导出成一个 zip；对方用“导入 → 导入表情包”即可还原。</small>
        </div>
        <div className="row">
          <button className="btn sm" onClick={() => void pickAndImportPackage()}>
            导入 zip…
          </button>
          <button
            className="btn sm"
            onClick={() => {
              closeDialog();
              openExportDialog(useLibraryStore.getState().stickers.map((s) => s.id));
            }}
          >
            导出全部…
          </button>
        </div>
      </div>

      <div className="setting">
        <div className="text">
          启动时检查新版本
          <small>从 GitHub 发布页读取最新版本号，有更新时弹窗提示，不会自动安装。</small>
        </div>
        <div className="row">
          <input
            type="checkbox"
            checked={settings.checkUpdatesOnStart}
            onChange={(e) => updateSettings({ checkUpdatesOnStart: e.target.checked })}
            aria-label="启动时检查新版本"
          />
          <button className="btn sm" onClick={() => void runUpdateCheck(true)}>
            立即检查
          </button>
        </div>
      </div>

      <div className="hint">
        表情包管理器 v{__APP_VERSION__} · 数据以 library.json 和 stickers/ 目录保存，可直接备份。
        {__GITHUB_REPO__ && !__GITHUB_REPO__.includes('OWNER') && (
          <>
            {' '}
            <a
              href={`https://github.com/${__GITHUB_REPO__}`}
              onClick={(e) => {
                e.preventDefault();
                void platform.openExternal(`https://github.com/${__GITHUB_REPO__}`);
              }}
            >
              项目主页
            </a>
          </>
        )}
      </div>
    </Modal>
  );
}
