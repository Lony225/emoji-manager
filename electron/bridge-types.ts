import type {
  DesktopSettings,
  DownloadResult,
  FetchBytesResult,
  FetchTextResult,
  LanConfig,
  LanDevice,
  LanIncoming,
  LanJsonResponse,
  LanTarget,
  MemeImageInput,
  MemeOptionValues,
  MemeProgress,
  MemeResult,
  MemeStatus,
  MemeTemplate,
  UpdateDownloadRequest,
  UpdateState,
  UsageMap,
  WindowRole,
} from '../src/platform/types';

/** 主进程列出的文件夹内容（只有元信息，字节另行按需读取） */
export interface PickedFolderEntry {
  rel: string;
  name: string;
  size: number;
  path: string;
}
export interface PickedFoldersResult {
  token: string;
  parentName?: string;
  folders: { name: string; files: PickedFolderEntry[] }[];
}

/** preload 暴露给渲染进程的 API（window.emojiBridge） */
export interface EmojiBridge {
  os: 'windows' | 'mac' | 'linux';
  /** CPU 架构（x64 / arm64），用于挑选对应的安装包 */
  arch: string;
  windowRole: WindowRole;
  /** 这种运行方式（Windows 安装版）能在应用里下载安装新版本 */
  installUpdates: boolean;
  readText(rel: string): Promise<string | null>;
  writeText(rel: string, text: string): Promise<void>;
  readBytes(rel: string): Promise<Uint8Array | null>;
  writeBytes(rel: string, bytes: Uint8Array): Promise<void>;
  remove(rel: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  exists(rel: string): Promise<boolean>;
  fetchText(url: string, timeoutMs: number): Promise<FetchTextResult>;
  download(url: string, rel: string, timeoutMs: number): Promise<DownloadResult>;
  fetchBytes(url: string, timeoutMs: number): Promise<FetchBytesResult>;
  copyImagePng(png: Uint8Array): Promise<void>;
  /** 让主进程对本窗口执行“粘贴”命令：页面会收到带剪贴板内容（图片、文件、网页片段）的 paste 事件 */
  paste(): Promise<void>;
  copyFile(rel: string): Promise<void>;
  copyFiles(rels: string[]): Promise<void>;
  copyFileBytes(name: string, bytes: Uint8Array): Promise<void>;
  saveFile(suggestedName: string, bytes: Uint8Array): Promise<{ saved: boolean; path?: string }>;
  pickFolders(): Promise<PickedFoldersResult | null>;
  /** 读取 pickFolders 列出过的文件 */
  readPicked(token: string, path: string): Promise<Uint8Array>;
  revealInFolder(rel: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  getLibraryPath(): Promise<string>;
  chooseLibraryDir(): Promise<{ changed: boolean; path?: string; error?: string }>;
  openLibraryDir(): Promise<void>;
  relaunch(): Promise<void>;
  onBeforeQuit(cb: () => Promise<void> | void): void;

  getUsage(): Promise<UsageMap>;
  recordUsage(id: string): Promise<void>;
  onUsageChanged(cb: (usage: UsageMap) => void): void;

  onLibraryChanged(cb: () => void): void;
  onFloatShown(cb: () => void): void;
  showFloat(): Promise<void>;
  hideFloat(): Promise<void>;
  toggleFloat(): Promise<void>;
  showMain(): Promise<void>;
  applyDesktopSettings(s: DesktopSettings): Promise<{ hotkeyOk: boolean }>;
  getLaunchAtLogin(): Promise<{ enabled: boolean; available: boolean }>;
  setLaunchAtLogin(on: boolean): Promise<void>;
  /** 彻底退出（等同托盘菜单的“退出”） */
  quit(): Promise<void>;
  /** 把窗口底色设成与界面主题一致，避免深色模式下边缘露出浅色 */
  setWindowBackground(color: string): Promise<void>;
  /** 有新的 emojimanager:// 链接等待处理 */
  onDeepLink(cb: () => void): void;
  /** 取走待处理的协议链接（没有则 null） */
  takePendingDeepLink(): Promise<string | null>;

  // —— 模板表情（meme-generator，在主进程的工具进程里运行）——
  memeStatus(): Promise<MemeStatus>;
  memeList(): Promise<MemeTemplate[]>;
  memePreview(key: string, options: MemeOptionValues): Promise<MemeResult>;
  memeGenerate(key: string, images: MemeImageInput[], texts: string[], options: MemeOptionValues): Promise<MemeResult>;
  memeDownloadFonts(): Promise<void>;
  onMemeProgress(cb: (p: MemeProgress) => void): () => void;

  // —— 内置更新 ——
  updateState(): Promise<UpdateState>;
  updateDownload(req: UpdateDownloadRequest): Promise<UpdateState>;
  updateCancel(): Promise<void>;
  updateInstall(): Promise<void>;
  onUpdateState(cb: (state: UpdateState) => void): void;

  // —— 局域网同步 ——
  lanStart(config: LanConfig): Promise<{ port: number }>;
  lanStop(): Promise<void>;
  lanConfigure(config: LanConfig): Promise<void>;
  lanDefaultName(): Promise<string>;
  onLanDevices(cb: (devices: LanDevice[]) => void): void;
  onLanRequest(cb: (req: LanIncoming) => Promise<LanJsonResponse>): void;
  lanRequest(target: LanTarget, token: string, path: string, body: unknown, timeoutMs: number): Promise<LanJsonResponse>;
  lanUpload(target: LanTarget, token: string, path: string, rel: string): Promise<number>;
  lanDownload(target: LanTarget, token: string, path: string, rel: string): Promise<number>;
}

declare global {
  interface Window {
    emojiBridge?: EmojiBridge;
  }
}
