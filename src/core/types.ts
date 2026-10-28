/** 本地导入的表情 */
export interface StickerSourceLocal {
  type: 'local';
}

/** 来自订阅的表情 */
export interface StickerSourceSubscription {
  type: 'subscription';
  subscriptionId: string;
  /** 订阅内的包标识（单包订阅为 "root"） */
  packKey: string;
  /** 远端给出的 id（缺省时为图片 URL） */
  remoteId: string;
  /** 图片的绝对 URL */
  url: string;
  /** 远端提供的名称，用于判断用户是否改过名 */
  remoteName: string;
  /** 远端提供的标签（含包级标签），用于与用户自己加的标签区分 */
  remoteTags: string[];
}

export type StickerSource = StickerSourceLocal | StickerSourceSubscription;

export interface Sticker {
  id: string;
  name: string;
  /** 相对于数据目录的文件路径，如 stickers/abc.png */
  file: string;
  ext: string;
  size: number;
  categoryId: string | null;
  tags: string[];
  favorite: boolean;
  createdAt: number;
  updatedAt: number;
  /** 本地导入时的 sha256，用于去重 */
  hash?: string;
  /** 网格缩略图（thumbs/…webp，动图取第一帧、大图缩小）；没有则直接显示原图 */
  thumb?: string;
  source: StickerSource;
}

export interface Category {
  id: string;
  name: string;
  createdAt: number;
  /** 最近一次改名 / 移动 / 排序的时间；旧资料里没有这个字段时按 createdAt 算（局域网同步按它判断哪边更新） */
  updatedAt?: number;
  order: number;
  /** 父分类；一级分类没有这个字段。可以像文件夹一样任意多级 */
  parentId?: string;
  /** 由订阅创建的分类会记录来源 */
  subscriptionId?: string;
  packKey?: string;
  /** 远端的包名，用于判断用户是否重命名过 */
  remoteName?: string;
}

export interface Subscription {
  id: string;
  url: string;
  name: string;
  description?: string;
  homepage?: string;
  remoteVersion?: string;
  addedAt: number;
  lastSyncAt?: number;
  lastSuccessAt?: number;
  lastError?: string;
  stickerCount: number;
  /** 同步时删除远端已移除的表情 */
  deleteRemoved: boolean;
  /** 启动时自动同步 */
  autoSync: boolean;
  /** 用户删除过的订阅表情（包 + 远端 id），同步时不再拉回 */
  hiddenKeys?: string[];
}

export type GridSize = 'small' | 'medium' | 'large';
export type Theme = 'system' | 'light' | 'dark';
export type CopyMode = 'auto' | 'file' | 'image';
/**
 * 网格里动图怎么播放：
 * always = 全部播放；hover = 只显示第一帧，悬停才播放；
 * auto = 当前视图里动图不多时播放，太多（会卡）时自动切到 hover
 */
export type GridAnimation = 'always' | 'auto' | 'hover';

export interface Settings {
  theme: Theme;
  gridSize: GridSize;
  autoSyncOnStart: boolean;
  gridAnimation: GridAnimation;
  copyMode: CopyMode;
  /** 浮窗全局快捷键（Electron accelerator 写法），空字符串表示关闭 */
  floatHotkey: string;
  /** 关闭主窗口时最小化到托盘（快捷键和浮窗继续可用） */
  closeToTray: boolean;
  /** 网格里在表情下方显示名称 */
  showNames: boolean;
  /** 启动时检查新版本 */
  checkUpdatesOnStart: boolean;
  /** 用户选择“跳过这个版本”的版本号 */
  skippedVersion: string;
  /** 手机上点一下表情做什么：打开系统分享面板，或复制到剪贴板 */
  tapAction: TapAction;
  /** 局域网同步：在同一网络里发现其他装了本应用的设备，配对后双向同步表情 */
  lanSync: boolean;
  /** 发现已配对的设备在线、或本机资料有改动时自动同步 */
  lanAutoSync: boolean;
}

export type TapAction = 'share' | 'copy';

/**
 * 删除记录（墓碑）：表情或分类被删掉后留下 id 和时间，
 * 局域网同步时另一台设备据此知道“这是被删了，不是它那边新加的”。
 */
export interface Tombstone {
  kind: 'sticker' | 'category';
  id: string;
  at: number;
}

export interface Library {
  version: 1;
  categories: Category[];
  stickers: Sticker[];
  subscriptions: Subscription[];
  settings: Settings;
  /** 删除记录，同步用；超过一定时间会清理 */
  deleted: Tombstone[];
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  gridSize: 'medium',
  autoSyncOnStart: true,
  gridAnimation: 'auto',
  copyMode: 'auto',
  floatHotkey: 'Alt+Shift+E',
  closeToTray: true,
  showNames: true,
  checkUpdatesOnStart: true,
  skippedVersion: '',
  tapAction: 'share',
  lanSync: false,
  lanAutoSync: true,
};

export function emptyLibrary(): Library {
  return {
    version: 1,
    categories: [],
    stickers: [],
    subscriptions: [],
    settings: { ...DEFAULT_SETTINGS },
    deleted: [],
  };
}
