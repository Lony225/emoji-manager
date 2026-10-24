import { contextBridge, ipcRenderer } from 'electron';
import type { EmojiBridge } from './bridge-types';
import type { UsageMap } from '../src/platform/types';

function cleanError(e: unknown): Error {
  const msg = e instanceof Error ? e.message : String(e);
  return new Error(msg.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''));
}

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  try {
    return (await ipcRenderer.invoke(channel, ...args)) as T;
  } catch (e) {
    throw cleanError(e);
  }
}

const os: EmojiBridge['os'] =
  process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux';

// 主进程通过 webPreferences.additionalArguments 告诉我们这是哪个窗口
const windowRole: EmojiBridge['windowRole'] = process.argv.includes('--emoji-window-role=float') ? 'float' : 'main';

const bridge: EmojiBridge = {
  os,
  arch: process.arch,
  windowRole,
  readText: (rel) => invoke('fs:readText', rel),
  writeText: (rel, text) => invoke('fs:writeText', rel, text),
  readBytes: (rel) => invoke('fs:readBytes', rel),
  writeBytes: (rel, bytes) => invoke('fs:writeBytes', rel, bytes),
  remove: (rel) => invoke('fs:remove', rel),
  rename: (from, to) => invoke('fs:rename', from, to),
  exists: (rel) => invoke('fs:exists', rel),
  fetchText: (url, timeoutMs) => invoke('net:fetchText', url, timeoutMs),
  download: (url, rel, timeoutMs) => invoke('net:download', url, rel, timeoutMs),
  fetchBytes: (url, timeoutMs) => invoke('net:fetchBytes', url, timeoutMs),
  copyImagePng: (png) => invoke('clipboard:copyImagePng', png),
  paste: () => invoke('clipboard:paste'),
  copyFile: (rel) => invoke('clipboard:copyFile', rel),
  copyFiles: (rels) => invoke('clipboard:copyFiles', rels),
  saveFile: (name, bytes) => invoke('dialog:saveFile', name, bytes),
  pickFolders: () => invoke('dialog:pickFolders'),
  readPicked: (token, p) => invoke('fs:readPicked', token, p),
  revealInFolder: (rel) => invoke('shell:revealInFolder', rel),
  openExternal: (url) => invoke('shell:openExternal', url),
  getLibraryPath: () => invoke('app:libraryPath'),
  chooseLibraryDir: () => invoke('app:chooseLibraryDir'),
  openLibraryDir: () => invoke('app:openLibraryDir'),
  relaunch: () => invoke('app:relaunch'),
  onBeforeQuit(cb) {
    ipcRenderer.on('app:before-quit', async () => {
      try {
        await cb();
      } finally {
        ipcRenderer.send('app:quit-ready');
      }
    });
  },

  getUsage: () => invoke('usage:get'),
  recordUsage: (id) => invoke('usage:record', id),
  onUsageChanged(cb) {
    ipcRenderer.on('usage:changed', (_e, usage: UsageMap) => cb(usage));
  },

  onLibraryChanged(cb) {
    ipcRenderer.on('library:changed', () => cb());
  },
  onFloatShown(cb) {
    ipcRenderer.on('float:shown', () => cb());
  },
  showFloat: () => invoke('float:show'),
  hideFloat: () => invoke('float:hide'),
  toggleFloat: () => invoke('float:toggle'),
  showMain: () => invoke('main:show'),
  applyDesktopSettings: (s) => invoke('settings:apply', s),
  getLaunchAtLogin: () => invoke('login:get'),
  setLaunchAtLogin: (on) => invoke('login:set', on),
  quit: () => invoke('app:quit'),
  setWindowBackground: (color) => invoke('window:bg', color),
  onDeepLink(cb) {
    ipcRenderer.on('deeplink', () => cb());
  },
  takePendingDeepLink: () => invoke('deeplink:take'),
};

contextBridge.exposeInMainWorld('emojiBridge', bridge);
