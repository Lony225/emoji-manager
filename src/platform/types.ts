export interface PickedFile {
  name: string;
  bytes: Uint8Array;
}

/** 文件夹里的一个文件；rel 是相对所选文件夹根的路径（不含文件夹自己的名字），用 / 分隔 */
export interface FolderFile {
  name: string;
  rel: string;
  size: number;
  read: () => Promise<Uint8Array>;
}

export interface PickedFolder {
  name: string;
  files: FolderFile[];
}

export interface PickedFolders {
  folders: PickedFolder[];
  /** 所选文件夹共同的上级目录名（用作“新建一级分类”的默认名） */
  parentName?: string;
}

/** 从系统剪贴板或其他应用的分享里拿到的一个文件 */
export interface ClipboardFile {
  name: string;
  mime: string;
  bytes: Uint8Array;
}

export interface ClipboardContent {
  files: ClipboardFile[];
  text: string;
  html: string;
}

export interface FetchTextResult {
  ok: boolean;
  status: number;
  text: string;
  finalUrl: string;
}

export interface DownloadResult {
  size: number;
  contentType: string | null;
}

export interface FetchBytesResult {
  bytes: Uint8Array;
  contentType: string | null;
}

// ---------------------------------------------------------------- 模板表情（meme-generator）

export interface MemeOptionSchema {
  name: string;
  type: 'boolean' | 'string' | 'integer' | 'float';
  default: boolean | string | number | null;
  description: string | null;
  /** 字符串选项的可选值 */
  choices?: string[];
  minimum: number | null;
  maximum: number | null;
}

/** 用户给选项填的值（按选项名） */
export type MemeOptionValues = Record<string, boolean | string | number>;

export interface MemeTemplate {
  key: string;
  keywords: string[];
  tags: string[];
  minImages: number;
  maxImages: number;
  minTexts: number;
  maxTexts: number;
  defaultTexts: string[];
  options: MemeOptionSchema[];
  shortcuts: { pattern: string; humanized: string | null }[];
  dateCreated: string;
  dateModified: string;
}

export interface MemeStatus {
  /** 当前平台有没有可用的模板引擎 */
  available: boolean;
  version: string;
  templates: number;
  fontsTotal: number;
  fontsReady: number;
  downloading: boolean;
  error?: string;
}

export interface MemeProgress {
  kind: 'fonts' | 'images';
  key?: string;
  done: number;
  total: number;
  file?: string;
}

export interface MemeImageInput {
  name: string;
  data: Uint8Array;
}

export interface MemeResult {
  bytes: Uint8Array;
  ext: string;
}

export type PlatformKind = 'electron' | 'web' | 'capacitor';
export type OsKind = 'windows' | 'mac' | 'linux' | 'android' | 'ios' | 'unknown';
/** 当前渲染进程是主窗口还是桌面浮窗 */
export type WindowRole = 'main' | 'float';

export interface UsageEntry {
  count: number;
  last: number;
}
/** 表情使用记录：id → 次数 / 最近一次时间 */
export type UsageMap = Record<string, UsageEntry>;

/** 需要主进程配合的桌面设置 */
export interface DesktopSettings {
  /** 浮窗全局快捷键（Electron accelerator 写法），空字符串表示关闭 */
  floatHotkey: string;
  /** 关闭主窗口时最小化到托盘 */
  closeToTray: boolean;
}

export interface PlatformCapabilities {
  /** 能把图片放进系统剪贴板 */
  copyImage: boolean;
  /** 能把文件放进系统剪贴板（保留动图） */
  copyFile: boolean;
  /** 系统分享面板（移动端） */
  share: boolean;
  revealInFolder: boolean;
  /** 可以更改数据目录 */
  changeLibraryDir: boolean;
  /** 网络请求是否受浏览器跨域限制 */
  corsRestricted: boolean;
  /** 桌面浮窗、托盘、全局快捷键、开机自启 */
  desktop: boolean;
  /** 系统文件夹选择框可以一次选多个文件夹 */
  multiFolderPick: boolean;
  /** 用 meme-generator 的模板做表情（桌面端） */
  memeTemplates: boolean;
}

/**
 * 平台适配层：Web 核心只依赖这个接口。
 * Electron / 浏览器 各有一个实现，以后加 Android（Capacitor）只需再写一个实现。
 */
export interface Platform {
  readonly kind: PlatformKind;
  readonly os: OsKind;
  /** CPU 架构（x64 / arm64 / unknown） */
  readonly arch: string;
  readonly windowRole: WindowRole;
  readonly capabilities: PlatformCapabilities;

  init(): Promise<void>;

  // —— 数据目录内的文件（rel 为相对路径，如 stickers/x.png）——
  readText(rel: string): Promise<string | null>;
  writeText(rel: string, text: string): Promise<void>;
  readBytes(rel: string): Promise<Uint8Array | null>;
  writeBytes(rel: string, bytes: Uint8Array): Promise<void>;
  remove(rel: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  exists(rel: string): Promise<boolean>;

  /** 可直接用于 <img src> 的地址；浏览器实现需要异步生成 */
  fileUrl(rel: string): Promise<string>;
  /** 同步快速路径；返回 undefined 表示需要走异步 */
  fileUrlSync(rel: string): string | undefined;

  // —— 网络 ——
  fetchText(url: string, timeoutMs?: number): Promise<FetchTextResult>;
  download(url: string, rel: string, timeoutMs?: number): Promise<DownloadResult>;
  /** 把一个 http(s) 地址的内容读进内存（导入从网页复制 / 拖来的图片） */
  fetchBytes(url: string, timeoutMs?: number): Promise<FetchBytesResult>;

  // —— 动作 ——
  copyImagePng(png: Uint8Array): Promise<void>;
  /**
   * 触发一次系统粘贴：桌面端由主进程执行“粘贴”命令，页面会收到带剪贴板内容的 paste 事件（含文件）；
   * 返回 false 表示这个平台做不到，调用方要自己用 navigator.clipboard 读
   */
  triggerPaste(): Promise<boolean>;
  copyFile(rel: string): Promise<void>;
  /** 把多个文件一起放进剪贴板 */
  copyFiles(rels: string[]): Promise<void>;
  /** 把一段还没存进资料库的图片数据作为文件放进剪贴板（桌面端先写到临时目录），动图粘贴后仍是动图 */
  copyFileBytes(name: string, bytes: Uint8Array): Promise<void>;
  /** 让用户选择位置保存一个文件（桌面端弹保存对话框，浏览器触发下载） */
  saveFile(suggestedName: string, bytes: Uint8Array): Promise<{ saved: boolean; path?: string }>;
  /** 选择一个或多个文件夹（取消返回 null）；只列出图片文件，内容按需读取 */
  pickFolders(): Promise<PickedFolders | null>;
  /** 系统分享面板（移动端）；返回 false 表示用户取消了 */
  share(rel: string, name: string): Promise<boolean>;
  /** 把多个表情一起分享（移动端）；返回 false 表示用户取消了 */
  shareMany(rels: string[]): Promise<boolean>;
  /** 原生读取系统剪贴板（安卓）；返回 null 表示这个平台没有原生实现，调用方改用 navigator.clipboard */
  readClipboard(): Promise<ClipboardContent | null>;
  revealInFolder(rel: string): Promise<void>;
  openExternal(url: string): Promise<void>;

  getLibraryPath(): Promise<string>;
  chooseLibraryDir(): Promise<{ changed: boolean; path?: string; error?: string }>;
  openLibraryDir(): Promise<void>;
  relaunch(): Promise<void>;

  /** 应用退出前的回调（用于把未落盘的数据写完） */
  onBeforeQuit(cb: () => Promise<void> | void): void;

  // —— 协议链接：网页上的“一键导入”会打开 emojimanager://subscribe?url=… ——
  onDeepLink(cb: () => void): void;
  takePendingDeepLink(): Promise<string | null>;

  // —— 移动端 ——
  /** 其他应用“分享到本应用”的图片 / zip（安卓）；注册时会先把启动时带来的内容交出来 */
  onReceivedFiles(cb: (files: ClipboardFile[], text: string) => void): void;
  /** 系统返回键（安卓）：回调返回 true 表示界面自己消化了这次返回，false 则把应用退到后台 */
  onBack(cb: () => boolean): void;

  // —— 使用记录（“最近使用”）——
  getUsage(): Promise<UsageMap>;
  recordUsage(id: string): Promise<void>;
  /** 任一窗口记录了使用之后，所有窗口都会收到最新的记录 */
  onUsageChanged(cb: (usage: UsageMap) => void): void;

  // —— 多窗口 / 桌面集成（非桌面平台为空实现）——
  /** 其他窗口改写了 library.json */
  onLibraryChanged(cb: () => void): void;
  /** 浮窗被显示出来（用于聚焦搜索框） */
  onFloatShown(cb: () => void): void;
  showFloat(): Promise<void>;
  hideFloat(): Promise<void>;
  showMain(): Promise<void>;
  applyDesktopSettings(s: DesktopSettings): Promise<{ hotkeyOk: boolean }>;
  getLaunchAtLogin(): Promise<{ enabled: boolean; available: boolean }>;
  setLaunchAtLogin(on: boolean): Promise<void>;
  /** 窗口底色跟随界面主题（桌面端），避免深色模式下窗口边缘露白 */
  setWindowBackground(color: string): Promise<void>;

  // —— 模板表情（meme-generator，桌面端）——
  memeStatus(): Promise<MemeStatus>;
  memeList(): Promise<MemeTemplate[]>;
  memePreview(key: string, options?: MemeOptionValues): Promise<MemeResult>;
  memeGenerate(key: string, images: MemeImageInput[], texts: string[], options: MemeOptionValues): Promise<MemeResult>;
  /** 下载模板用的字体（一次性）；进度走 onMemeProgress */
  memeDownloadFonts(): Promise<void>;
  /** 字体 / 素材下载进度；返回取消订阅的函数 */
  onMemeProgress(cb: (p: MemeProgress) => void): () => void;
}
