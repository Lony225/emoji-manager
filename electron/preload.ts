import { contextBridge, ipcRenderer } from 'electron';
import type { EmojiBridge } from './bridge-types';
import type { LanDevice, LanIncoming, LanJsonResponse, MemeProgress, UpdateState, UsageMap } from '../src/platform/types';

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
// 以及这种运行方式能不能在应用里直接安装更新（Windows 安装版才行）
const installUpdates = process.argv.includes('--emoji-updates=builtin');

const bridge: EmojiBridge = {
  os,
  arch: process.arch,
  windowRole,
  installUpdates,
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
  copyFileBytes: (name, bytes) => invoke('clipboard:copyFileBytes', name, bytes),
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

  memeStatus: () => invoke('memes:status'),
  memeList: () => invoke('memes:list'),
  memePreview: (key, options) => invoke('memes:preview', key, options),
  memeGenerate: (key, images, texts, options) => invoke('memes:generate', key, images, texts, options),
  memeDownloadFonts: () => invoke('memes:downloadFonts'),
  onMemeProgress(cb) {
    const listener = (_e: Electron.IpcRendererEvent, p: MemeProgress) => cb(p);
    ipcRenderer.on('memes:progress', listener);
    return () => ipcRenderer.removeListener('memes:progress', listener);
  },

  updateState: () => invoke('update:state'),
  updateDownload: (req) => invoke('update:download', req),
  updateCancel: () => invoke('update:cancel'),
  updateInstall: () => invoke('update:install'),
  onUpdateState(cb) {
    ipcRenderer.on('update:state', (_e, state: UpdateState) => cb(state));
  },

  lanStart: (config) => invoke('lan:start', config),
  lanStop: () => invoke('lan:stop'),
  lanConfigure: (config) => invoke('lan:configure', config),
  lanDefaultName: () => invoke('lan:defaultName'),
  onLanDevices(cb) {
    ipcRenderer.on('lan:devices', (_e, devices: LanDevice[]) => cb(devices));
  },
  onLanRequest(cb) {
    // 主进程的 HTTP 服务收到请求后转交给页面，页面处理完把结果发回去
    ipcRenderer.on('lan:request', async (_e, reqId: string, req: LanIncoming) => {
      let res: LanJsonResponse;
      try {
        res = await cb(req);
      } catch (err) {
        res = { status: 500, body: { error: err instanceof Error ? err.message : String(err) } };
      }
      ipcRenderer.send('lan:response', reqId, res);
    });
  },
  lanRequest: (target, token, path, body, timeoutMs) => invoke('lan:request', target, token, path, body, timeoutMs),
  lanUpload: (target, token, path, rel) => invoke('lan:upload', target, token, path, rel),
  lanDownload: (target, token, path, rel) => invoke('lan:download', target, token, path, rel),
};

contextBridge.exposeInMainWorld('emojiBridge', bridge);
