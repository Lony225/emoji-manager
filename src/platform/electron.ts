import type { EmojiBridge } from '../../electron/bridge-types';
import type { Platform } from './types';

export function createElectronPlatform(bridge: EmojiBridge): Platform {
  return {
    kind: 'electron',
    os: bridge.os,
    arch: bridge.arch,
    windowRole: bridge.windowRole,
    capabilities: {
      copyImage: true,
      copyFile: bridge.os === 'windows' || bridge.os === 'mac',
      share: false,
      revealInFolder: true,
      changeLibraryDir: true,
      corsRestricted: false,
      desktop: true,
      multiFolderPick: true,
    },
    async init() {},
    readText: (rel) => bridge.readText(rel),
    writeText: (rel, text) => bridge.writeText(rel, text),
    readBytes: (rel) => bridge.readBytes(rel),
    writeBytes: (rel, bytes) => bridge.writeBytes(rel, bytes),
    remove: (rel) => bridge.remove(rel),
    rename: (from, to) => bridge.rename(from, to),
    exists: (rel) => bridge.exists(rel),
    fileUrlSync: (rel) => stickerUrl(rel),
    fileUrl: async (rel) => stickerUrl(rel),
    fetchText: (url, timeoutMs = 30000) => bridge.fetchText(url, timeoutMs),
    download: (url, rel, timeoutMs = 60000) => bridge.download(url, rel, timeoutMs),
    copyImagePng: (png) => bridge.copyImagePng(png),
    copyFile: (rel) => bridge.copyFile(rel),
    copyFiles: (rels) => bridge.copyFiles(rels),
    saveFile: (name, bytes) => bridge.saveFile(name, bytes),
    async pickFolders() {
      const r = await bridge.pickFolders();
      if (!r) return null;
      return {
        parentName: r.parentName,
        folders: r.folders.map((f) => ({
          name: f.name,
          files: f.files.map((e) => ({ name: e.name, rel: e.rel, size: e.size, read: () => bridge.readPicked(r.token, e.path) })),
        })),
      };
    },
    async share() {
      throw new Error('桌面端不支持系统分享');
    },
    revealInFolder: (rel) => bridge.revealInFolder(rel),
    openExternal: (url) => bridge.openExternal(url),
    getLibraryPath: () => bridge.getLibraryPath(),
    chooseLibraryDir: () => bridge.chooseLibraryDir(),
    openLibraryDir: () => bridge.openLibraryDir(),
    relaunch: () => bridge.relaunch(),
    onBeforeQuit: (cb) => bridge.onBeforeQuit(cb),

    getUsage: () => bridge.getUsage(),
    recordUsage: (id) => bridge.recordUsage(id),
    onUsageChanged: (cb) => bridge.onUsageChanged(cb),

    onLibraryChanged: (cb) => bridge.onLibraryChanged(cb),
    onFloatShown: (cb) => bridge.onFloatShown(cb),
    showFloat: () => bridge.showFloat(),
    hideFloat: () => bridge.hideFloat(),
    showMain: () => bridge.showMain(),
    applyDesktopSettings: (s) => bridge.applyDesktopSettings(s),
    getLaunchAtLogin: () => bridge.getLaunchAtLogin(),
    setLaunchAtLogin: (on) => bridge.setLaunchAtLogin(on),
  };
}

function stickerUrl(rel: string): string {
  // sticker://library/<rel>，由主进程的协议处理器提供文件
  return 'sticker://library/' + rel.split('/').map(encodeURIComponent).join('/');
}
