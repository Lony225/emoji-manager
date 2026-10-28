import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ACCELERATORS,
  accelerated,
  changelogSection,
  checkForUpdate,
  compareVersions,
  describeUpdateError,
  firstSuccess,
  githubAssetName,
  hostOf,
  installerBaseUrl,
  loadAccelerators,
  mirrorListUrl,
  normalizeAccelerators,
  parseRelease,
  parseVersion,
  pickAsset,
  probeAccelerators,
  syntheticAssets,
} from './update';

const ok = (text: string) => ({ ok: true, status: 200, text, finalUrl: '' });
const fail = (status: number) => ({ ok: false, status, text: '', finalUrl: '' });

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
      { name: 'Emoji Manager-1.1.0-win-x64.exe', browser_download_url: 'https://dl/win.exe', size: 1, digest: 'sha256:abc' },
      { name: 'Emoji Manager-1.1.0-portable.exe', browser_download_url: 'https://dl/portable.exe', size: 1 },
      { name: 'Emoji Manager-1.1.0-mac-arm64.dmg', browser_download_url: 'https://dl/arm.dmg', size: 1 },
      { name: 'Emoji Manager-1.1.0-mac-x64.dmg', browser_download_url: 'https://dl/x64.dmg', size: 1 },
      { name: 'Emoji Manager-1.1.0-android.apk', browser_download_url: 'https://dl/app.apk', size: 1 },
      { name: 'junk.blockmap' },
    ],
  };

  it('parseRelease 整理字段', () => {
    const r = parseRelease(release)!;
    expect(r.version).toBe('1.1.0');
    expect(r.assets).toHaveLength(5);
    expect(r.assets[0].digest).toBe('sha256:abc');
    expect(r.assets[1].digest).toBeUndefined();
    expect(parseRelease({})).toBeNull();
  });

  it('pickAsset 按系统和架构挑安装包', () => {
    const r = parseRelease(release)!;
    expect(pickAsset(r.assets, 'windows', 'x64')?.url).toBe('https://dl/win.exe');
    expect(pickAsset(r.assets, 'mac', 'arm64')?.url).toBe('https://dl/arm.dmg');
    expect(pickAsset(r.assets, 'mac', 'x64')?.url).toBe('https://dl/x64.dmg');
    expect(pickAsset(r.assets, 'android', 'arm64')?.url).toBe('https://dl/app.apk');
    expect(pickAsset(r.assets, 'linux', 'x64')).toBeUndefined();
  });

  it('checkForUpdate：GitHub 直连成功 / 没有发布 / 仓库未配置', async () => {
    const fetchText = async () => ok(JSON.stringify(release));
    const r = await checkForUpdate({ fetchText }, 'o/r', '1.0.0');
    expect(r.available).toBe(true);
    expect(r.latest?.tag).toBe('v1.1.0');
    expect(r.latest?.source).toBe('github');
    const same = await checkForUpdate({ fetchText }, 'o/r', '1.1.0');
    expect(same.available).toBe(false);
    const none = await checkForUpdate({ fetchText: async () => fail(404) }, 'o/r', '1.0.0');
    expect(none).toEqual({ current: '1.0.0', latest: null, available: false });
    await expect(checkForUpdate({ fetchText }, 'OWNER/emoji-manager', '1.0.0')).rejects.toThrow(/仓库/);
  });

  it('checkForUpdate：GitHub 连不上时经加速站代理 API', async () => {
    const calls: string[] = [];
    const fetchText = async (url: string) => {
      calls.push(url);
      if (url.startsWith('https://api.github.com/')) throw new Error('ENOTFOUND');
      if (url.startsWith('https://bad.example/')) return fail(403);
      if (url.startsWith('https://good.example/https://api.github.com/')) return ok(JSON.stringify(release));
      throw new Error('unexpected ' + url);
    };
    const r = await checkForUpdate({ fetchText }, 'o/r', '1.0.0', { getAccelerators: async () => ['https://bad.example/', 'https://good.example/'] });
    expect(r.available).toBe(true);
    expect(r.latest?.source).toBe('mirror');
    expect(r.latest?.via).toBe('good.example');
    expect(r.latest?.assets[0].url).toBe('https://dl/win.exe');
    expect(calls.filter((u) => u.includes('api.github.com'))).toHaveLength(3);
  });

  it('checkForUpdate：加速站也不行时用 jsDelivr 读版本号和更新日志，安装包地址按约定拼', async () => {
    const changelog = '# 更新日志\n\n## v1.1.0 - 2026-11-01\n\n### 新增\n\n- 浮窗\n\n## v1.0.0 - 2026-10-01\n\n- 首发\n';
    const fetchText = async (url: string) => {
      if (url.includes('api.github.com')) throw new Error('ENOTFOUND');
      if (url === 'https://cdn.jsdelivr.net/gh/o/r@latest/package.json') return ok(JSON.stringify({ version: '1.1.0', productName: 'Emoji Manager' }));
      if (url === 'https://cdn.jsdelivr.net/gh/o/r@v1.1.0/CHANGELOG.md') return ok(changelog);
      throw new Error('unexpected ' + url);
    };
    const r = await checkForUpdate({ fetchText }, 'o/r', '1.0.0', { getAccelerators: async () => ['https://dead.example/'] });
    expect(r.available).toBe(true);
    expect(r.latest).toMatchObject({ version: '1.1.0', tag: 'v1.1.0', source: 'mirror', via: 'jsDelivr', url: 'https://github.com/o/r/releases/tag/v1.1.0' });
    expect(r.latest?.notes).toBe('### 新增\n\n- 浮窗');
    expect(pickAsset(r.latest!.assets, 'windows', 'x64')?.url).toBe('https://github.com/o/r/releases/download/v1.1.0/Emoji.Manager-1.1.0-win-x64.exe');
    expect(pickAsset(r.latest!.assets, 'mac', 'arm64')?.name).toBe('Emoji.Manager-1.1.0-mac-arm64.dmg');
    expect(pickAsset(r.latest!.assets, 'android', 'arm64')?.name).toBe('Emoji.Manager-1.1.0-android.apk');
  });

  it('checkForUpdate：全都连不上时报错里带上各级原因', async () => {
    const fetchText = async () => {
      throw new Error('ENOTFOUND');
    };
    await expect(checkForUpdate({ fetchText }, 'o/r', '1.0.0', { getAccelerators: async () => ['https://a.example/'] })).rejects.toThrow(/GitHub 和镜像都连不上.*GitHub：ENOTFOUND.*加速站.*jsDelivr/);
  });
});

describe('加速站', () => {
  it('地址拼接与主机名', () => {
    expect(accelerated('https://ghfast.top/', 'https://github.com/o/r/releases/download/v1/a.exe')).toBe('https://ghfast.top/https://github.com/o/r/releases/download/v1/a.exe');
    expect(hostOf('https://gh-proxy.com/')).toBe('gh-proxy.com');
    expect(hostOf('nonsense')).toBe('nonsense');
    expect(githubAssetName('Emoji Manager-1.3.0-win-x64.exe')).toBe('Emoji.Manager-1.3.0-win-x64.exe');
    expect(syntheticAssets('o/r', 'Emoji Manager', '1.3.0').map((a) => a.name)).toEqual([
      'Emoji.Manager-1.3.0-win-x64.exe',
      'Emoji.Manager-1.3.0-portable.exe',
      'Emoji.Manager-1.3.0-mac-arm64.dmg',
      'Emoji.Manager-1.3.0-mac-x64.dmg',
      'Emoji.Manager-1.3.0-android.apk',
    ]);
  });

  it('远端名单校验：只收 https 前缀，去重、限量，不合格用内置的', async () => {
    expect(normalizeAccelerators({ accelerators: ['https://a.example/', 'http://b.example/', 'https://c.example/gh/', 'https://a.example/', 'javascript:alert(1)/', 'https://d.example'] })).toEqual([
      'https://a.example/',
      'https://c.example/gh/',
    ]);
    expect(normalizeAccelerators({ accelerators: [] })).toBeNull();
    expect(normalizeAccelerators('nope')).toBeNull();
    expect(normalizeAccelerators({ accelerators: Array.from({ length: 20 }, (_, i) => `https://m${i}.example/`) })).toHaveLength(12);

    const remote = await loadAccelerators({ fetchText: async () => ok(JSON.stringify({ accelerators: ['https://new.example/'] })) }, 'o/r');
    expect(remote).toEqual(['https://new.example/']);
    const broken = await loadAccelerators({ fetchText: async () => ok('not json') }, 'o/r');
    expect(broken).toEqual([...DEFAULT_ACCELERATORS]);
    const offline = await loadAccelerators(
      {
        fetchText: async () => {
          throw new Error('offline');
        },
      },
      'o/r',
    );
    expect(offline).toEqual([...DEFAULT_ACCELERATORS]);
    expect(DEFAULT_ACCELERATORS.every((a) => /^https:\/\/.+\/$/.test(a))).toBe(true);
  });

  it('firstSuccess 取最先成功的，全失败抛第一个错误', async () => {
    const slowOk = () => new Promise<string>((r) => setTimeout(() => r('slow'), 30));
    const fastOk = () => new Promise<string>((r) => setTimeout(() => r('fast'), 5));
    const bad = () => Promise.reject(new Error('bad'));
    expect(await firstSuccess([bad, slowOk, fastOk])).toBe('fast');
    await expect(firstSuccess([bad, () => Promise.reject(new Error('worse'))])).rejects.toThrow('bad');
    await expect(firstSuccess([])).rejects.toThrow();
  });

  it('probeAccelerators 逐个回报能否代理 GitHub', async () => {
    const results: Record<string, boolean> = {};
    const fetchText = async (url: string) => {
      if (url.startsWith('https://up.example/')) return ok('{ "version": "1.0.0" }');
      if (url.startsWith('https://html.example/')) return ok('<html>loading</html>');
      throw new Error('down');
    };
    await new Promise<void>((resolve) => {
      let n = 0;
      probeAccelerators({ fetchText }, 'o/r', 'v1.0.0', ['https://up.example/', 'https://html.example/', 'https://down.example/'], (acc, isOk) => {
        results[acc] = isOk;
        if (++n === 3) resolve();
      });
    });
    expect(results).toEqual({ 'https://up.example/': true, 'https://html.example/': false, 'https://down.example/': false });
  });

  it('mirrorListUrl 带当天日期，避免长期缓存', () => {
    expect(mirrorListUrl('o/r', new Date(2026, 9, 28))).toBe('https://cdn.jsdelivr.net/gh/o/r@main/docs/download-mirrors.json?d=20261028');
  });

  it('changelogSection 取某个版本的小节', () => {
    const text = '# 更新日志\n\n## 未发布\n\n- 草稿\n\n## v1.3.0 - 2026-10-25\n\n### 新功能\n\n- 模板\n\n## v1.2.0 - 2026-10-23\n\n- 旧\n';
    expect(changelogSection(text, '1.3.0')).toBe('### 新功能\n\n- 模板');
    expect(changelogSection(text, '1.2.0')).toBe('- 旧');
    expect(changelogSection(text, '9.9.9')).toBe('');
  });
});

describe('内置更新', () => {
  it('installerBaseUrl：安装包所在目录，可加加速站前缀', () => {
    const asset = 'https://github.com/o/r/releases/download/v1.5.0/Emoji.Manager-1.5.0-win-x64.exe';
    expect(installerBaseUrl(asset)).toBe('https://github.com/o/r/releases/download/v1.5.0/');
    expect(installerBaseUrl(asset, 'https://ghfast.top/')).toBe('https://ghfast.top/https://github.com/o/r/releases/download/v1.5.0/');
    expect(installerBaseUrl('nonsense')).toBeNull();
    // 加速站前缀 + 完整地址在 URL 解析下仍能正确拼出 latest.yml 和安装包的地址
    const base = installerBaseUrl(asset, 'https://gh-proxy.com/')!;
    expect(new URL('latest.yml', base).href).toBe('https://gh-proxy.com/https://github.com/o/r/releases/download/v1.5.0/latest.yml');
    expect(new URL('Emoji.Manager-1.5.0-win-x64.exe', base).href).toBe(`https://gh-proxy.com/${asset}`);
  });

  it('describeUpdateError：把 electron-updater 的报错翻成一句话', () => {
    const withCode = (message: string, code: string) => Object.assign(new Error(message), { code });
    expect(describeUpdateError(new Error('cancelled'))).toBe('已取消');
    expect(describeUpdateError(withCode('Cannot find channel "latest.yml" update info: HttpError: 404', 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND'))).toMatch(/latest\.yml/);
    expect(describeUpdateError(withCode('sha512 checksum mismatch, expected a, got b', 'ERR_CHECKSUM_MISMATCH'))).toMatch(/校验不通过/);
    expect(describeUpdateError(new Error('checksum mismatch: sha256'))).toMatch(/校验不通过/);
    expect(describeUpdateError(withCode('whatever', 'HTTP_ERROR_404'))).toBe('下载地址不存在（HTTP 404）');
    expect(describeUpdateError(withCode('whatever', 'HTTP_ERROR_503'))).toBe('下载服务器返回 HTTP 503');
    // 日志里的文字：带 Error: 前缀、堆栈和响应头
    expect(describeUpdateError('Error: HttpError: 404 Not Found\nHeaders: {"a":1}\n    at x')).toBe('下载地址不存在（HTTP 404）');
    expect(describeUpdateError('Error: Error: getaddrinfo ENOTFOUND ghfast.top\n    at x')).toMatch(/域名无法解析/);
    expect(describeUpdateError(new Error('net::ERR_CONNECTION_RESET'))).toMatch(/无法连接/);
    expect(describeUpdateError(new Error('socket hang up'))).toMatch(/无法连接/);
    expect(describeUpdateError(withCode('bad', 'ERR_UPDATER_INVALID_VERSION'))).toMatch(/版本号/);
    expect(describeUpdateError(new Error('更新文件里的版本（1.0.0）和要安装的版本（2.0.0）不一致'))).toBe('更新文件里的版本（1.0.0）和要安装的版本（2.0.0）不一致');
    expect(describeUpdateError('')).toBe('未知错误');
  });
});
