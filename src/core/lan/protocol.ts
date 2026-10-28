/**
 * 局域网同步协议：同一网络里的设备互相发现（UDP 广播），配对后通过各自内置的 HTTP 服务双向同步表情。
 *
 * 发现：每台设备每隔几秒向局域网广播一条 JSON（应用标识、设备 id / 名称、HTTP 端口），
 *      收到别人的广播就记为“在线”，十几秒没再收到就算离线。
 * 配对：A 在设备列表里点“配对”，向 B 发 POST /pair（带一个随机令牌）；B 的屏幕上弹出确认，
 *      允许后双方各自记下对方和这个令牌，之后所有请求都带 Authorization: Bearer <令牌>。
 * 同步：发起方 A 向 B 发 POST /begin 拿到 B 的资料（分类、表情元信息、删除记录），
 *      在本地算出两边的差异（见 merge.ts），把 B 缺的图片 PUT 上去、把自己缺的 GET 下来，
 *      然后 POST /apply 让 B 应用它那一侧的改动，自己也应用这一侧的改动。两边的算法完全对称，
 *      所以无论谁发起、发起几次，结果都一样。
 */
import type { OsKind } from '../../platform/types';
import type { Category, Sticker, Tombstone } from '../types';

export const LAN_PROTOCOL = 1;
/** 设备发现用的 UDP 端口（桌面和安卓一致） */
export const LAN_UDP_PORT = 28617;
/** HTTP 接口前缀 */
export const LAN_PATH = '/emoji-sync/v1';
/** 发起配对 / 等待对方确认的时限 */
export const PAIR_TIMEOUT_MS = 90_000;
/** 一次同步从 begin 到 apply 的最长时间，超过则对方自动解锁 */
export const SYNC_LOCK_MS = 5 * 60 * 1000;

/** 本机身份：id 随机生成后不再变；name 默认用主机名 / 手机型号，用户可改 */
export interface LanIdentity {
  id: string;
  name: string;
}

/** 已配对的设备 */
export interface LanPair {
  id: string;
  name: string;
  os: OsKind;
  /** 双方共享的令牌 */
  token: string;
  pairedAt: number;
  lastSyncAt?: number;
  lastResult?: string;
  lastError?: string;
}

export interface LanStore {
  id: string;
  name: string;
  pairs: LanPair[];
}

export interface DeviceInfo {
  proto: number;
  id: string;
  name: string;
  os: OsKind;
  version: string;
}

export interface PairRequest extends DeviceInfo {
  token: string;
}

export interface PairResponse {
  ok: boolean;
  id?: string;
  name?: string;
  os?: OsKind;
  error?: string;
}

/** 同步时交换的分类（不带订阅字段） */
export interface SyncCategory {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  order: number;
  parentId?: string;
}

/** 同步时交换的表情元信息（图片文件另行传输；缩略图各自生成） */
export interface SyncSticker {
  id: string;
  name: string;
  file: string;
  ext: string;
  size: number;
  hash?: string;
  categoryId: string | null;
  tags: string[];
  favorite: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface SyncState {
  proto: number;
  device: { id: string; name: string };
  categories: SyncCategory[];
  stickers: SyncSticker[];
  deleted: Tombstone[];
}

/**
 * 一侧要做的事里，图片从哪来：
 * keep = 这一侧已经有这个文件（只改元信息，或发起方已经把文件传过来了）；
 * fetch = 要从另一侧取；{ renameFrom } = 这一侧有一张内容相同的表情，把它的文件改名复用
 */
export type FileSource = 'keep' | 'fetch' | { renameFrom: string };

export interface StickerOp {
  sticker: SyncSticker;
  file: FileSource;
}

/** 某一侧需要应用的改动 */
export interface SideOps {
  categories: SyncCategory[];
  removeCategories: string[];
  stickers: StickerOp[];
  removeStickers: string[];
}

export function emptySideOps(): SideOps {
  return { categories: [], removeCategories: [], stickers: [], removeStickers: [] };
}

export function sideOpsEmpty(ops: SideOps): boolean {
  return ops.categories.length === 0 && ops.removeCategories.length === 0 && ops.stickers.length === 0 && ops.removeStickers.length === 0;
}

export interface ApplyRequest {
  proto: number;
  ops: SideOps;
  /** 合并后的删除记录，两边都存这一份 */
  deleted: Tombstone[];
}

export interface ApplyResult {
  /** 表情的增 / 改 / 删 */
  added: number;
  updated: number;
  removed: number;
  /** 因为文件缺失等原因没应用的 */
  skipped: number;
  /** 分类的增 / 改 / 删（合计） */
  categories: number;
  errors: string[];
}

export interface BusyResponse {
  error: string;
  busy: true;
}

// ---------------------------------------------------------------- 转换

export function toSyncCategory(c: Category): SyncCategory {
  const out: SyncCategory = { id: c.id, name: c.name, createdAt: c.createdAt, updatedAt: c.updatedAt ?? c.createdAt, order: c.order };
  if (c.parentId) out.parentId = c.parentId;
  return out;
}

export function toSyncSticker(s: Sticker): SyncSticker {
  const out: SyncSticker = {
    id: s.id,
    name: s.name,
    file: s.file,
    ext: s.ext,
    size: s.size,
    categoryId: s.categoryId,
    tags: s.tags,
    favorite: s.favorite,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
  if (s.hash) out.hash = s.hash;
  return out;
}

export function buildSyncState(device: LanIdentity, lib: { categories: Category[]; stickers: Sticker[]; deleted: Tombstone[] }): SyncState {
  return {
    proto: LAN_PROTOCOL,
    device: { id: device.id, name: device.name },
    categories: lib.categories.map(toSyncCategory),
    stickers: lib.stickers.map(toSyncSticker),
    deleted: lib.deleted,
  };
}

// ---------------------------------------------------------------- 校验（对方发来的东西不能信）

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const MAX_ID = 64;
const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
/** 图片文件只能在 stickers/ 下，文件名只允许安全字符 */
export const STICKER_FILE_RE = /^stickers\/[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;

export function parseSyncCategory(raw: unknown): SyncCategory | null {
  if (!isRecord(raw)) return null;
  const id = str(raw.id, MAX_ID);
  const name = str(raw.name, 50);
  const createdAt = num(raw.createdAt);
  const order = num(raw.order);
  if (!id || !name || createdAt === null || order === null) return null;
  const out: SyncCategory = { id, name, createdAt, updatedAt: num(raw.updatedAt) ?? createdAt, order };
  const parentId = str(raw.parentId, MAX_ID);
  if (parentId && parentId !== id) out.parentId = parentId;
  return out;
}

export function parseSyncSticker(raw: unknown): SyncSticker | null {
  if (!isRecord(raw)) return null;
  const id = str(raw.id, MAX_ID);
  const name = str(raw.name, 80) ?? '表情';
  const file = str(raw.file, 160);
  const ext = str(raw.ext, 8);
  const createdAt = num(raw.createdAt);
  if (!id || !file || !ext || createdAt === null || !STICKER_FILE_RE.test(file) || !/^[a-z0-9]+$/.test(ext)) return null;
  const tags = Array.isArray(raw.tags) ? raw.tags.filter((t): t is string => typeof t === 'string' && t.length > 0 && t.length <= 40).slice(0, 100) : [];
  const out: SyncSticker = {
    id,
    name,
    file,
    ext,
    size: Math.max(0, num(raw.size) ?? 0),
    categoryId: typeof raw.categoryId === 'string' && raw.categoryId.length <= MAX_ID ? raw.categoryId : null,
    tags: Array.from(new Set(tags)),
    favorite: raw.favorite === true,
    createdAt,
    updatedAt: num(raw.updatedAt) ?? createdAt,
  };
  const hash = str(raw.hash, 80);
  if (hash) out.hash = hash;
  return out;
}

export function parseTombstones(raw: unknown): Tombstone[] {
  if (!Array.isArray(raw)) return [];
  const out: Tombstone[] = [];
  for (const t of raw) {
    if (!isRecord(t) || (t.kind !== 'sticker' && t.kind !== 'category')) continue;
    const id = str(t.id, MAX_ID);
    const at = num(t.at);
    if (!id || at === null) continue;
    out.push({ kind: t.kind, id, at });
  }
  return out;
}

export function parseSyncState(raw: unknown): SyncState {
  if (!isRecord(raw) || raw.proto !== LAN_PROTOCOL) throw new Error('对方的应用版本不兼容，请两边都升级到最新版');
  const device = isRecord(raw.device) ? raw.device : {};
  const categories: SyncCategory[] = [];
  if (Array.isArray(raw.categories)) {
    for (const c of raw.categories) {
      const parsed = parseSyncCategory(c);
      if (parsed) categories.push(parsed);
    }
  }
  const stickers: SyncSticker[] = [];
  if (Array.isArray(raw.stickers)) {
    for (const s of raw.stickers) {
      const parsed = parseSyncSticker(s);
      if (parsed) stickers.push(parsed);
    }
  }
  return {
    proto: LAN_PROTOCOL,
    device: { id: str(device.id, MAX_ID) ?? '', name: str(device.name, 60) ?? '设备' },
    categories,
    stickers,
    deleted: parseTombstones(raw.deleted),
  };
}

function parseFileSource(raw: unknown): FileSource | null {
  if (raw === 'keep' || raw === 'fetch') return raw;
  if (isRecord(raw)) {
    const from = str(raw.renameFrom, 160);
    if (from && STICKER_FILE_RE.test(from)) return { renameFrom: from };
  }
  return null;
}

export function parseSideOps(raw: unknown): SideOps {
  const ops = emptySideOps();
  if (!isRecord(raw)) return ops;
  if (Array.isArray(raw.categories)) {
    for (const c of raw.categories) {
      const parsed = parseSyncCategory(c);
      if (parsed) ops.categories.push(parsed);
    }
  }
  if (Array.isArray(raw.stickers)) {
    for (const item of raw.stickers) {
      if (!isRecord(item)) continue;
      const sticker = parseSyncSticker(item.sticker);
      const file = parseFileSource(item.file);
      if (sticker && file) ops.stickers.push({ sticker, file });
    }
  }
  const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= MAX_ID) : []);
  ops.removeCategories = ids(raw.removeCategories);
  ops.removeStickers = ids(raw.removeStickers);
  return ops;
}

export function parseApplyRequest(raw: unknown): ApplyRequest {
  if (!isRecord(raw) || raw.proto !== LAN_PROTOCOL) throw new Error('对方的应用版本不兼容');
  return { proto: LAN_PROTOCOL, ops: parseSideOps(raw.ops), deleted: parseTombstones(raw.deleted) };
}

export function parsePairRequest(raw: unknown): PairRequest | null {
  if (!isRecord(raw) || raw.proto !== LAN_PROTOCOL) return null;
  const id = str(raw.id, MAX_ID);
  const name = str(raw.name, 60);
  const token = str(raw.token, 128);
  if (!id || !name || !token || !/^[A-Za-z0-9_-]+$/.test(token)) return null;
  const os = typeof raw.os === 'string' ? (raw.os as OsKind) : 'unknown';
  return { proto: LAN_PROTOCOL, id, name, os, version: str(raw.version, 40) ?? '', token };
}

/** 配对码：令牌的前 4 位，双方屏幕上都显示，方便确认是同一个请求 */
export function pairCode(token: string): string {
  return token.slice(0, 4).toUpperCase();
}

export function randomToken(): string {
  const bytes = new Uint8Array(24);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
