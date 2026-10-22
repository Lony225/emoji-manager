import { describe, expect, it } from 'vitest';
import { checkForUpdate, compareVersions, parseRelease, parseVersion, pickAsset, plainNotes } from './update';

describe('版本比较', () => {
  it('解析与比较', () => {
    expect(parseVersion('v1.2.3')).toEqual([1, 2, 3]);
    expect(parseVersion('1.10.0-beta.2')).toEqual([1, 10, 0]);
    expect(parseVersion('latest')).toBeNull();
    expect(compareVersions('1.0.1', '1.0.0')).toBe(1);
    expect(compareVersions('v1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1);
    expect(compareVersions('2.0.0-beta.1', '2.0.0')).toBe(-1);
    expect(compareVersions('0.9.0', '1.0.0')).toBe(-1);
    expect(compareVersions('weird', '1.0.0')).toBe(-1);
  });
});

describe('发布信息', () => {
  const release = {
    tag_name: 'v1.1.0',
    name: '1.1.0 新功能',
    body: '## 新增\n- **浮窗**：`Alt+Shift+E` 呼出\n- 见 [文档](https://x)',
    html_url: 'https://github.com/o/r/releases/tag/v1.1.0',
    published_at: '2026-11-01T00:00:00Z',
    assets: [
      { name: 'Emoji Manager-1.1.0-win-x64.exe', browser_download_url: 'https://dl/win.exe', size: 1 },
      { name: 'Emoji Manager-1.1.0-portable.exe', browser_download_url: 'https://dl/portable.exe', size: 1 },
      { name: 'Emoji Manager-1.1.0-mac-arm64.dmg', browser_download_url: 'https://dl/arm.dmg', size: 1 },
      { name: 'Emoji Manager-1.1.0-mac-x64.dmg', browser_download_url: 'https://dl/x64.dmg', size: 1 },
      { name: 'junk.blockmap' },
    ],
  };

  it('parseRelease 整理字段', () => {
    const r = parseRelease(release)!;
    expect(r.version).toBe('1.1.0');
    expect(r.assets).toHaveLength(4);
    expect(parseRelease({})).toBeNull();
  });

  it('pickAsset 按系统和架构挑安装包', () => {
    const r = parseRelease(release)!;
    expect(pickAsset(r.assets, 'windows', 'x64')?.url).toBe('https://dl/win.exe');
    expect(pickAsset(r.assets, 'mac', 'arm64')?.url).toBe('https://dl/arm.dmg');
    expect(pickAsset(r.assets, 'mac', 'x64')?.url).toBe('https://dl/x64.dmg');
    expect(pickAsset(r.assets, 'linux', 'x64')).toBeUndefined();
  });

  it('plainNotes 去掉 Markdown 标记', () => {
    expect(plainNotes(release.body)).toBe('新增\n• 浮窗：Alt+Shift+E 呼出\n• 见 文档');
  });

  it('checkForUpdate：有新版本 / 没有发布 / 仓库未配置', async () => {
    const fetchText = async () => ({ ok: true, status: 200, text: JSON.stringify(release), finalUrl: '' });
    const r = await checkForUpdate({ fetchText }, 'o/r', '1.0.0');
    expect(r.available).toBe(true);
    expect(r.latest?.tag).toBe('v1.1.0');
    const same = await checkForUpdate({ fetchText }, 'o/r', '1.1.0');
    expect(same.available).toBe(false);
    const none = await checkForUpdate({ fetchText: async () => ({ ok: false, status: 404, text: '', finalUrl: '' }) }, 'o/r', '1.0.0');
    expect(none).toEqual({ current: '1.0.0', latest: null, available: false });
    await expect(checkForUpdate({ fetchText }, 'OWNER/emoji-manager', '1.0.0')).rejects.toThrow(/仓库/);
  });
});
