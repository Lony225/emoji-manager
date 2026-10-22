import { extFromName } from './images';
import {
  DEFAULT_SETTINGS,
  emptyLibrary,
  type Category,
  type Library,
  type Settings,
  type Sticker,
  type StickerSource,
  type Subscription,
} from './types';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const optStr = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const num = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;
const optNum = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const strList = (v: unknown): string[] =>
  Array.isArray(v) ? Array.from(new Set(v.filter((t): t is string => typeof t === 'string' && t !== ''))) : [];

function migrateSource(raw: unknown, subIds: Set<string>): StickerSource {
  if (!isRecord(raw) || raw.type !== 'subscription') return { type: 'local' };
  const subscriptionId = str(raw.subscriptionId);
  const packKey = str(raw.packKey);
  const remoteId = str(raw.remoteId);
  // 订阅已经不存在的表情降级为本地表情
  if (!subscriptionId || !packKey || !remoteId || !subIds.has(subscriptionId)) return { type: 'local' };
  return {
    type: 'subscription',
    subscriptionId,
    packKey,
    remoteId,
    url: str(raw.url),
    remoteName: str(raw.remoteName),
    remoteTags: strList(raw.remoteTags),
  };
}

function migrateSettings(raw: Record<string, unknown>): Settings {
  const s = { ...DEFAULT_SETTINGS };
  if (raw.theme === 'light' || raw.theme === 'dark' || raw.theme === 'system') s.theme = raw.theme;
  if (raw.gridSize === 'small' || raw.gridSize === 'medium' || raw.gridSize === 'large') s.gridSize = raw.gridSize;
  if (raw.copyMode === 'auto' || raw.copyMode === 'file' || raw.copyMode === 'image') s.copyMode = raw.copyMode;
  if (typeof raw.autoSyncOnStart === 'boolean') s.autoSyncOnStart = raw.autoSyncOnStart;
  if (typeof raw.animateInGrid === 'boolean') s.animateInGrid = raw.animateInGrid;
  if (typeof raw.floatHotkey === 'string') s.floatHotkey = raw.floatHotkey.trim().slice(0, 60);
  if (typeof raw.closeToTray === 'boolean') s.closeToTray = raw.closeToTray;
  if (typeof raw.showNames === 'boolean') s.showNames = raw.showNames;
  if (typeof raw.checkUpdatesOnStart === 'boolean') s.checkUpdatesOnStart = raw.checkUpdatesOnStart;
  if (typeof raw.skippedVersion === 'string') s.skippedVersion = raw.skippedVersion.slice(0, 40);
  return s;
}

/**
 * 读取资料文件时做校验和补全：缺字段补默认值、引用不存在的分类/订阅则解除引用，
 * 避免旧版本或损坏的数据让应用起不来。
 */
export function migrate(raw: unknown): Library {
  if (!isRecord(raw)) throw new Error('资料文件格式不正确');
  const lib = emptyLibrary();
  const now = Date.now();

  if (Array.isArray(raw.subscriptions)) {
    lib.subscriptions = raw.subscriptions
      .filter((s): s is Record<string, unknown> => isRecord(s) && typeof s.id === 'string' && typeof s.url === 'string')
      .map(
        (s): Subscription => ({
          id: s.id as string,
          url: s.url as string,
          name: str(s.name) || (s.url as string),
          description: optStr(s.description),
          homepage: optStr(s.homepage),
          remoteVersion: optStr(s.remoteVersion),
          addedAt: num(s.addedAt, now),
          lastSyncAt: optNum(s.lastSyncAt),
          lastSuccessAt: optNum(s.lastSuccessAt),
          lastError: optStr(s.lastError),
          stickerCount: num(s.stickerCount, 0),
          deleteRemoved: s.deleteRemoved !== false,
          autoSync: s.autoSync !== false,
          hiddenKeys: Array.isArray(s.hiddenKeys) ? strList(s.hiddenKeys) : undefined,
        }),
      );
  }
  const subIds = new Set(lib.subscriptions.map((s) => s.id));

  if (Array.isArray(raw.categories)) {
    const seen = new Set<string>();
    lib.categories = raw.categories
      .filter((c): c is Record<string, unknown> => isRecord(c) && typeof c.id === 'string' && typeof c.name === 'string')
      .filter((c) => (seen.has(c.id as string) ? false : (seen.add(c.id as string), true)))
      .map((c, i): Category => {
        const subscriptionId = optStr(c.subscriptionId);
        const linked = subscriptionId !== undefined && subIds.has(subscriptionId);
        return {
          id: c.id as string,
          name: c.name as string,
          createdAt: num(c.createdAt, now),
          order: num(c.order, i),
          parentId: optStr(c.parentId),
          subscriptionId: linked ? subscriptionId : undefined,
          packKey: linked ? optStr(c.packKey) : undefined,
          remoteName: linked ? optStr(c.remoteName) : undefined,
        };
      });
    // 任意多级，但父分类必须存在、不能指向自己、不能形成环；不满足的升为一级
    const byId = new Map(lib.categories.map((c) => [c.id, c]));
    const detached = new Set<string>();
    for (const c of lib.categories) {
      if (c.parentId === undefined) continue;
      const seen = new Set<string>([c.id]);
      let cur = byId.get(c.parentId);
      let ok = !!cur;
      while (cur) {
        if (seen.has(cur.id)) {
          ok = false; // 转回了自己：成环
          break;
        }
        seen.add(cur.id);
        cur = cur.parentId ? byId.get(cur.parentId) : undefined;
      }
      if (!ok) detached.add(c.id);
    }
    lib.categories = lib.categories.map((c) => (detached.has(c.id) ? { ...c, parentId: undefined } : c));
  }
  const catIds = new Set(lib.categories.map((c) => c.id));

  if (Array.isArray(raw.stickers)) {
    const seen = new Set<string>();
    lib.stickers = raw.stickers
      .filter((s): s is Record<string, unknown> => isRecord(s) && typeof s.id === 'string' && typeof s.file === 'string')
      .filter((s) => (seen.has(s.id as string) ? false : (seen.add(s.id as string), true)))
      .map((s): Sticker => {
        const file = s.file as string;
        const createdAt = num(s.createdAt, now);
        return {
          id: s.id as string,
          name: str(s.name) || '表情',
          file,
          ext: str(s.ext) || extFromName(file) || 'png',
          size: num(s.size, 0),
          categoryId: typeof s.categoryId === 'string' && catIds.has(s.categoryId) ? s.categoryId : null,
          tags: strList(s.tags),
          favorite: s.favorite === true,
          createdAt,
          updatedAt: num(s.updatedAt, createdAt),
          hash: optStr(s.hash),
          source: migrateSource(s.source, subIds),
        };
      });
  }

  if (isRecord(raw.settings)) lib.settings = migrateSettings(raw.settings);
  return lib;
}
