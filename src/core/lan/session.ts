/**
 * 一次同步的流程（发起方）和被同步方的请求处理。网络由调用方注入（Transport），这里只管协议。
 *
 * 发起方：begin → 算差异 → 把对方缺的图片传过去、把自己缺的取回来 → apply（对方应用它那份改动）→ 本地应用自己这份。
 * 被同步方：同一时间只接受一个同步会话（锁），会话超时自动释放。
 */
import type { Tombstone } from '../types';
import { applySideOps, type ApplyDeps } from './apply';
import { mergeStates } from './merge';
import {
  buildSyncState,
  LAN_PROTOCOL,
  parseApplyRequest,
  parseSyncState,
  SYNC_LOCK_MS,
  type ApplyResult,
  type LanIdentity,
  type SideOps,
  type SyncState,
} from './protocol';

export interface JsonResponse {
  status: number;
  body: unknown;
}

/** 和某台设备说话的通道：JSON 请求、上传 / 下载资料目录里的文件 */
export interface Transport {
  request(path: string, body: unknown, timeoutMs: number): Promise<JsonResponse>;
  upload(path: string, rel: string): Promise<number>;
  download(path: string, rel: string): Promise<number>;
}

export interface SyncProgress {
  phase: 'begin' | 'transfer' | 'apply' | 'done';
  done: number;
  total: number;
}

export interface LanSyncResult {
  /** 本机这边的变化 */
  local: ApplyResult;
  /** 对方那边的变化 */
  remote: ApplyResult;
  /** 传输的图片数量 */
  sent: number;
  received: number;
  errors: string[];
}

export interface SessionDeps extends Omit<ApplyDeps, 'now'> {
  identity: LanIdentity;
  now: () => number;
  /** 把内存里的资料先写盘（可选） */
  flush?: () => Promise<void>;
  concurrency?: number;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 对方正在和别的设备同步：稍后重试即可，不算出错 */
export class BusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BusyError';
  }
}

function describeStatus(r: JsonResponse): string {
  const body = r.body as { error?: unknown } | null;
  if (body && typeof body === 'object' && typeof body.error === 'string') return body.error;
  if (r.status === 401) return '对方不认这个配对了，请重新配对';
  if (r.status === 409) return '对方正在和别的设备同步，稍后再试';
  if (r.status === 503) return '对方的应用没有打开主窗口';
  return `对方返回了 HTTP ${r.status}`;
}

async function runPool<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
    while (next < items.length) await fn(items[next++]);
  });
  await Promise.all(workers);
}

const fileName = (rel: string) => rel.slice(rel.lastIndexOf('/') + 1);

/** 发起一次同步 */
export async function runSync(transport: Transport, deps: SessionDeps, onProgress?: (p: SyncProgress) => void): Promise<LanSyncResult> {
  onProgress?.({ phase: 'begin', done: 0, total: 0 });
  await deps.flush?.();
  const startedAt = deps.now();
  const begin = await transport.request('/begin', { proto: LAN_PROTOCOL, device: deps.identity }, 30_000);
  if (begin.status === 409) throw new BusyError(describeStatus(begin));
  if (begin.status !== 200) throw new Error(describeStatus(begin));
  const remote = parseSyncState(begin.body);
  const session = (begin.body as { session?: unknown }).session;
  if (typeof session !== 'string') throw new Error('对方的回应不完整');

  const local = buildSyncState(deps.identity, deps.getState());
  const plan = mergeStates(local, remote, deps.now());
  const errors: string[] = [];

  // 图片传输：对方缺的传过去，自己缺的取回来；失败的那一条这次不动（从两边的操作里去掉）
  const uploads = plan.remote.stickers.filter((o) => o.file === 'fetch');
  const downloads = plan.local.stickers.filter((o) => o.file === 'fetch');
  const total = uploads.length + downloads.length;
  let done = 0;
  let sent = 0;
  let received = 0;
  const failedIds = new Set<string>();
  onProgress?.({ phase: 'transfer', done, total });
  const tick = () => onProgress?.({ phase: 'transfer', done: ++done, total });
  await runPool(uploads, deps.concurrency ?? 3, async (o) => {
    try {
      const status = await transport.upload(`/file/${fileName(o.sticker.file)}`, o.sticker.file);
      if (status !== 200) throw new Error(`HTTP ${status}`);
      sent++;
    } catch (e) {
      failedIds.add(o.sticker.id);
      errors.push(`传出“${o.sticker.name}”失败：${errorMessage(e)}`);
    }
    tick();
  });
  await runPool(downloads, deps.concurrency ?? 3, async (o) => {
    try {
      const status = await transport.download(`/file/${fileName(o.sticker.file)}`, o.sticker.file);
      if (status !== 200) throw new Error(`HTTP ${status}`);
      received++;
    } catch (e) {
      failedIds.add(o.sticker.id);
      errors.push(`取回“${o.sticker.name}”失败：${errorMessage(e)}`);
    }
    tick();
  });
  const strip = (ops: SideOps): SideOps => ({ ...ops, stickers: ops.stickers.filter((o) => !failedIds.has(o.sticker.id)) });
  // 传输失败的表情不能当作已删除：它们的删除记录也不带过去（下次再同步）
  const deleted: Tombstone[] = plan.deleted.filter((t) => !(t.kind === 'sticker' && failedIds.has(t.id)));

  onProgress?.({ phase: 'apply', done, total });
  const applyRes = await transport.request('/apply', { proto: LAN_PROTOCOL, session, ops: strip(plan.remote), deleted }, 120_000);
  if (applyRes.status !== 200) throw new Error(describeStatus(applyRes));
  const remoteResult = parseApplyResult(applyRes.body);
  const localResult = await applySideOps(strip(plan.local), deleted, deps, startedAt);
  await deps.flush?.();
  onProgress?.({ phase: 'done', done, total });
  return { local: localResult, remote: remoteResult, sent, received, errors: [...errors, ...remoteResult.errors.map((e) => `对方：${e}`), ...localResult.errors] };
}

function parseApplyResult(raw: unknown): ApplyResult {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    added: n(r.added),
    updated: n(r.updated),
    removed: n(r.removed),
    skipped: n(r.skipped),
    categories: n(r.categories),
    errors: Array.isArray(r.errors) ? r.errors.filter((e): e is string => typeof e === 'string').slice(0, 20) : [],
  };
}

// ---------------------------------------------------------------- 被同步方

export interface IncomingRequest {
  kind: 'begin' | 'apply' | 'end';
  body: unknown;
}

/** 被同步方的会话状态：一次只服务一台设备 */
export class SyncResponder {
  private session: { id: string; startedAt: number } | null = null;

  constructor(
    private readonly deps: SessionDeps,
    private readonly newId: () => string,
  ) {}

  get busy(): boolean {
    this.expire();
    return this.session !== null;
  }

  private expire(): void {
    if (this.session && this.deps.now() - this.session.startedAt > SYNC_LOCK_MS) this.session = null;
  }

  async handle(req: IncomingRequest): Promise<JsonResponse> {
    this.expire();
    switch (req.kind) {
      case 'begin': {
        if (this.session) return { status: 409, body: { error: '正在和别的设备同步，稍后再试', busy: true } };
        const body = req.body as { proto?: unknown } | null;
        if (!body || body.proto !== LAN_PROTOCOL) return { status: 400, body: { error: '对方的应用版本不兼容，请两边都升级到最新版' } };
        await this.deps.flush?.();
        this.session = { id: this.newId(), startedAt: this.deps.now() };
        const state: SyncState & { session: string } = { ...buildSyncState(this.deps.identity, this.deps.getState()), session: this.session.id };
        return { status: 200, body: state };
      }
      case 'apply': {
        const body = req.body as { session?: unknown } | null;
        if (!this.session || !body || body.session !== this.session.id) return { status: 409, body: { error: '同步会话已失效，请重新开始' } };
        try {
          const parsed = parseApplyRequest(req.body);
          const result = await applySideOps(parsed.ops, parsed.deleted, this.deps, this.session.startedAt);
          await this.deps.flush?.();
          return { status: 200, body: result };
        } catch (e) {
          return { status: 400, body: { error: errorMessage(e) } };
        } finally {
          this.session = null;
        }
      }
      case 'end': {
        this.session = null;
        return { status: 200, body: { ok: true } };
      }
    }
  }
}
