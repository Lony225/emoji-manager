/**
 * 局域网同步的页面侧控制器：
 * - 按设置启动 / 停止平台的发现服务和 HTTP 服务
 * - 处理其他设备发来的请求（配对确认、同步会话）
 * - 发起配对、发起同步；已配对设备上线或本机资料改动后自动同步
 * 只在主窗口运行（浮窗只读）。
 */
import { useLibraryStore } from '../core/store';
import { useUiStore } from './uiStore';
import { useLanStore, loadLanStore } from './lanStore';
import { newId } from '../core/ids';
import { platform } from '../platform';
import type { LanConfig, LanDevice, LanIncoming, LanJsonResponse } from '../platform/types';
import { errorMessage } from '../core/subscription/sync';
import {
  LAN_PROTOCOL,
  pairCode,
  parsePairRequest,
  randomToken,
  SYNC_LOCK_MS,
  type LanPair,
  type PairRequest,
  type PairResponse,
} from '../core/lan/protocol';
import { BusyError, runSync, SyncResponder, type LanSyncResult, type SessionDeps, type Transport } from '../core/lan/session';

const lib = () => useLibraryStore.getState();
const ui = () => useUiStore.getState();
const lan = () => useLanStore.getState();

let installed = false;
let responder: SyncResponder | null = null;
/** 资料改动后延迟自动同步的计时器 */
let autoTimer: ReturnType<typeof setTimeout> | null = null;
/** 上线后已经自动同步过的设备（同一次在线期间只自动同步一次，之后靠改动触发） */
const greeted = new Set<string>();
/** 正在应用同步结果：这期间的资料变化不再触发自动同步（store 的订阅是同步触发的，所以计数就够了） */
let applying = 0;

function sessionDeps(): SessionDeps {
  return {
    identity: { id: lan().identity.id, name: lan().identity.name },
    platform,
    getState: () => {
      const s = lib();
      return { categories: s.categories, stickers: s.stickers, deleted: s.deleted };
    },
    apply: (ops) => {
      applying++;
      try {
        lib().applyOps(ops);
      } finally {
        applying--;
      }
    },
    now: Date.now,
    flush: () => lib().flush(),
  };
}

function config(): LanConfig {
  const { id, name, pairs } = lan().identity;
  return { id, name, tokens: pairs.map((p) => ({ deviceId: p.id, token: p.token })) };
}

function pairOf(deviceId: string): LanPair | undefined {
  return lan().identity.pairs.find((p) => p.id === deviceId);
}

function deviceOf(deviceId: string): LanDevice | undefined {
  return lan().devices.find((d) => d.id === deviceId);
}

export function describeDevice(os: string): string {
  switch (os) {
    case 'windows':
      return 'Windows 电脑';
    case 'mac':
      return 'Mac';
    case 'linux':
      return 'Linux 电脑';
    case 'android':
      return 'Android 手机';
    case 'ios':
      return 'iPhone';
    default:
      return '设备';
  }
}

// ---------------------------------------------------------------- 启动 / 停止

async function ensureIdentity(): Promise<void> {
  const stored = loadLanStore();
  if (!stored.id) stored.id = newId();
  if (!stored.name) stored.name = (await platform.lanDefaultName().catch(() => '')) || '我的设备';
  lan().setIdentity(stored);
}

export async function startLan(): Promise<void> {
  if (!platform.capabilities.lanSync || platform.windowRole !== 'main') return;
  await ensureIdentity();
  try {
    const { port } = await platform.lanStart(config());
    lan().setRunning(true, undefined, port);
  } catch (e) {
    lan().setRunning(false, errorMessage(e));
    ui().toast(`局域网同步无法启动：${errorMessage(e)}`, 'error');
  }
}

export async function stopLan(): Promise<void> {
  if (!platform.capabilities.lanSync) return;
  greeted.clear();
  await platform.lanStop().catch(() => undefined);
  lan().setRunning(false);
  lan().setDevices([]);
}

function pushConfig(): void {
  if (lan().running) void platform.lanConfigure(config()).catch(() => undefined);
}

export function renameSelf(name: string): void {
  const clean = name.trim().slice(0, 40);
  if (!clean) return;
  lan().setIdentity({ ...lan().identity, name: clean });
  pushConfig();
}

// ---------------------------------------------------------------- 处理对方发来的请求

async function handleIncoming(req: LanIncoming): Promise<LanJsonResponse> {
  switch (req.kind) {
    case 'pair':
      return handlePairRequest(req.body);
    case 'unpair': {
      const pair = req.from ? pairOf(req.from) : undefined;
      if (pair) {
        removePair(pair.id, false);
        ui().toast(`“${pair.name}”解除了和这台设备的配对`);
      }
      return { status: 200, body: { ok: true } };
    }
    case 'begin':
    case 'apply':
    case 'end': {
      if (!req.from) return { status: 401, body: { error: '未配对' } };
      if (!responder) responder = new SyncResponder(sessionDeps(), newId);
      const pair = pairOf(req.from);
      if (req.kind === 'begin' && pair) {
        lan().setSyncing(req.from, { phase: 'begin', done: 0, total: 0 });
        // 对方发起后中途断线：会话到期时把界面上的“同步中”也清掉
        const from = req.from;
        setTimeout(() => {
          if (lan().syncing[from]?.phase === 'begin') lan().setSyncing(from, null);
        }, SYNC_LOCK_MS);
      }
      const res = await responder.handle({ kind: req.kind, body: req.body });
      if (req.kind !== 'begin' || res.status !== 200) {
        lan().setSyncing(req.from, null);
        if (req.kind === 'apply' && pair) {
          const r = res.body as { added?: number; updated?: number; removed?: number; categories?: number } | null;
          lan().updatePair(req.from, {
            lastSyncAt: Date.now(),
            lastError: res.status === 200 ? undefined : String((res.body as { error?: string })?.error ?? `HTTP ${res.status}`),
            lastResult: res.status === 200 && r ? summarizeSide(r) : undefined,
          });
          if (res.status === 200 && r && (r.added || r.updated || r.removed || r.categories)) ui().toast(`“${pair.name}”同步过来：${summarizeSide(r)}`, 'success');
        }
      }
      return res;
    }
  }
}

function summarizeSide(r: { added?: number; updated?: number; removed?: number; skipped?: number; categories?: number }): string {
  const parts: string[] = [];
  if (r.added) parts.push(`新增 ${r.added}`);
  if (r.updated) parts.push(`更新 ${r.updated}`);
  if (r.removed) parts.push(`移除 ${r.removed}`);
  if (r.categories) parts.push(`分类改动 ${r.categories}`);
  if (r.skipped) parts.push(`${r.skipped} 个跳过`);
  return parts.length ? parts.join('，') : '没有变化';
}

/** 对方请求配对：弹出确认，用户允许后记下令牌 */
function handlePairRequest(body: unknown): Promise<LanJsonResponse> {
  const req = parsePairRequest(body);
  if (!req) return Promise.resolve({ status: 400, body: { ok: false, error: '配对请求格式不对' } satisfies PairResponse });
  if (req.id === lan().identity.id) return Promise.resolve({ status: 400, body: { ok: false, error: '不能和自己配对' } satisfies PairResponse });
  if (ui().dialog.kind === 'confirm') return Promise.resolve({ status: 409, body: { ok: false, error: '对方正在看另一个对话框，请稍后再试' } satisfies PairResponse });
  void platform.showMain().catch(() => undefined);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (res: LanJsonResponse) => {
      if (settled) return;
      settled = true;
      resolve(res);
    };
    const timer = setTimeout(() => {
      finish({ status: 408, body: { ok: false, error: '对方没有在限定时间内确认' } satisfies PairResponse });
      if (ui().dialog.kind === 'confirm') ui().closeDialog();
    }, 85_000);
    ui().openDialog({
      kind: 'confirm',
      title: '允许配对？',
      message: `“${req.name}”（${describeDevice(req.os)}）想和这台设备配对同步表情。\n\n配对码：${pairCode(req.token)}\n请确认对方屏幕上显示的配对码一致。配对后两边的表情会互相同步（增量，保留各自的改动）。`,
      confirmText: '允许',
      onConfirm: () => {
        clearTimeout(timer);
        acceptPair(req);
        finish({ status: 200, body: { ok: true, id: lan().identity.id, name: lan().identity.name, os: platform.os } satisfies PairResponse });
      },
    });
    // 用户点了取消 / 关闭：等对话框消失再回绝
    const unsub = useUiStore.subscribe((s) => {
      if (s.dialog.kind !== 'confirm' || (s.dialog as { title?: string }).title !== '允许配对？') {
        unsub();
        clearTimeout(timer);
        setTimeout(() => finish({ status: 403, body: { ok: false, error: '对方拒绝了配对' } satisfies PairResponse }), 50);
      }
    });
  });
}

function acceptPair(req: PairRequest): void {
  const pair: LanPair = { id: req.id, name: req.name, os: req.os, token: req.token, pairedAt: Date.now() };
  const pairs = [...lan().identity.pairs.filter((p) => p.id !== req.id), pair];
  lan().setIdentity({ ...lan().identity, pairs });
  pushConfig();
  ui().toast(`已和“${req.name}”配对`, 'success');
  // 配对成功后对方马上会发起同步，这边不用再主动发
}

// ---------------------------------------------------------------- 发起配对

export async function pairWith(device: LanDevice): Promise<void> {
  if (lan().pairing) return;
  const token = randomToken();
  lan().setPairing(device.id);
  const code = pairCode(token);
  ui().toast(`已向“${device.name}”发出配对请求，配对码 ${code}，请在对方设备上允许…`);
  try {
    const body: PairRequest = { proto: LAN_PROTOCOL, id: lan().identity.id, name: lan().identity.name, os: platform.os, version: __APP_VERSION__, token };
    const res = await platform.lanRequest({ host: device.host, port: device.port }, '', '/pair', body, 95_000);
    const r = (res.body ?? {}) as PairResponse;
    if (res.status !== 200 || !r.ok) throw new Error(r.error ?? `对方返回了 HTTP ${res.status}`);
    const pair: LanPair = { id: device.id, name: r.name ?? device.name, os: r.os ?? device.os, token, pairedAt: Date.now() };
    lan().setIdentity({ ...lan().identity, pairs: [...lan().identity.pairs.filter((p) => p.id !== device.id), pair] });
    pushConfig();
    ui().toast(`已和“${pair.name}”配对，开始第一次同步…`, 'success');
    lan().setPairing(null);
    await syncWith(device.id, { manual: true });
  } catch (e) {
    ui().toast(`配对失败：${errorMessage(e)}`, 'error');
  } finally {
    lan().setPairing(null);
  }
}

/** 解除配对；notify 为 true 时也告诉对方 */
export function removePair(deviceId: string, notify: boolean): void {
  const pair = pairOf(deviceId);
  if (!pair) return;
  if (notify) {
    const dev = deviceOf(deviceId);
    if (dev) void platform.lanRequest({ host: dev.host, port: dev.port }, pair.token, '/unpair', { proto: LAN_PROTOCOL }, 5000).catch(() => undefined);
  }
  lan().setIdentity({ ...lan().identity, pairs: lan().identity.pairs.filter((p) => p.id !== deviceId) });
  greeted.delete(deviceId);
  pushConfig();
}

// ---------------------------------------------------------------- 发起同步

function transportFor(device: LanDevice, token: string): Transport {
  const target = { host: device.host, port: device.port };
  return {
    request: (path, body, timeoutMs) => platform.lanRequest(target, token, path, body, timeoutMs),
    upload: (path, rel) => platform.lanUpload(target, token, path, rel),
    download: (path, rel) => platform.lanDownload(target, token, path, rel),
  };
}

export function summarizeResult(r: LanSyncResult): string {
  const parts: string[] = [];
  const mine = summarizeSide(r.local);
  const theirs = summarizeSide(r.remote);
  if (mine !== '没有变化') parts.push(`本机${mine}`);
  if (theirs !== '没有变化') parts.push(`对方${theirs}`);
  if (r.errors.length) parts.push(`${r.errors.length} 个错误`);
  return parts.length ? parts.join('；') : '两边已经一致';
}

/** 和某台已配对的设备同步一次；manual 为 false 时静默（只在有变化或出错时提示） */
export async function syncWith(deviceId: string, opts: { manual?: boolean; retried?: boolean } = {}): Promise<LanSyncResult | null> {
  const pair = pairOf(deviceId);
  if (!pair) {
    if (opts.manual) ui().toast('还没有和这台设备配对', 'error');
    return null;
  }
  const device = deviceOf(deviceId);
  if (!device) {
    if (opts.manual) ui().toast(`“${pair.name}”当前不在线`, 'error');
    return null;
  }
  if (lan().syncing[deviceId]) {
    if (opts.manual) ui().toast('正在同步中');
    return null;
  }
  lan().setSyncing(deviceId, { phase: 'begin', done: 0, total: 0 });
  try {
    const r = await runSync(transportFor(device, pair.token), sessionDeps(), (p) => lan().setSyncing(deviceId, p));
    const summary = summarizeResult(r);
    lan().updatePair(deviceId, { lastSyncAt: Date.now(), lastResult: summary, lastError: r.errors.length ? r.errors[0] : undefined });
    const changed = [r.local, r.remote].some((x) => x.added || x.updated || x.removed || x.categories);
    if (opts.manual || changed || r.errors.length) ui().toast(`和“${pair.name}”同步完成：${summary}`, r.errors.length ? 'error' : 'success');
    return r;
  } catch (e) {
    const msg = errorMessage(e);
    if (e instanceof BusyError) {
      // 两边同时发起了：让一步，几秒后再试一次
      if (opts.manual) ui().toast(`“${pair.name}”正在同步中，稍后自动重试`);
      if (!opts.retried) setTimeout(() => void syncWith(deviceId, { retried: true }), 3000 + Math.random() * 3000);
      return null;
    }
    lan().updatePair(deviceId, { lastSyncAt: Date.now(), lastError: msg });
    if (opts.manual) ui().toast(`和“${pair.name}”同步失败：${msg}`, 'error');
    return null;
  } finally {
    lan().setSyncing(deviceId, null);
  }
}

/** 和所有在线的已配对设备同步 */
export async function syncAllOnline(manual = false): Promise<void> {
  const online = lan().identity.pairs.filter((p) => deviceOf(p.id));
  if (manual && online.length === 0) {
    ui().toast('没有在线的已配对设备');
    return;
  }
  for (const p of online) await syncWith(p.id, { manual });
}

// ---------------------------------------------------------------- 自动同步

function scheduleAutoSync(delayMs: number): void {
  if (!lib().settings.lanAutoSync || !lan().running) return;
  if (autoTimer) clearTimeout(autoTimer);
  autoTimer = setTimeout(() => {
    autoTimer = null;
    // 正在同步的设备不打扰（同步本身会改资料，不然会无限循环）
    if (Object.keys(lan().syncing).length > 0) {
      scheduleAutoSync(delayMs);
      return;
    }
    void syncAllOnline(false);
  }, delayMs);
}

/** 哪些资料变化值得触发同步（缩略图生成、订阅状态等不算） */
function libraryChanged(a: ReturnType<typeof lib>, b: ReturnType<typeof lib>): boolean {
  if (a.categories !== b.categories || a.deleted !== b.deleted) return true;
  if (a.stickers === b.stickers) return false;
  if (a.stickers.length !== b.stickers.length) return true;
  const prev = new Map(b.stickers.map((s) => [s.id, s]));
  return a.stickers.some((s) => {
    const p = prev.get(s.id);
    return !p || p.updatedAt !== s.updatedAt || p.categoryId !== s.categoryId;
  });
}

/** 主窗口加载完后调用一次 */
export function installLanSync(): void {
  if (installed || !platform.capabilities.lanSync || platform.windowRole !== 'main') return;
  installed = true;

  platform.onLanDevices((devices) => {
    const before = new Set(lan().devices.map((d) => d.id));
    lan().setDevices(devices);
    for (const d of devices) {
      if (before.has(d.id)) continue;
      // 已配对的设备刚上线：稍等它那边也准备好，再自动同步一次。
      // 两边都会看到对方上线，id 小的先发起，id 大的晚几秒，发现对方已经同步过就不再重复
      if (pairOf(d.id) && !greeted.has(d.id) && lib().settings.lanAutoSync) {
        greeted.add(d.id);
        const first = lan().identity.id < d.id;
        setTimeout(() => {
          const p = pairOf(d.id);
          if (!p || (!first && p.lastSyncAt && Date.now() - p.lastSyncAt < 10_000)) return;
          void syncWith(d.id);
        }, first ? 1500 : 6000);
      }
    }
    for (const id of before) if (!devices.some((d) => d.id === id)) greeted.delete(id);
  });
  platform.onLanRequest(handleIncoming);

  // 开关变化：启动 / 停止服务
  let lastOn = lib().settings.lanSync;
  useLibraryStore.subscribe((s, prev) => {
    if (s.settings.lanSync !== lastOn) {
      lastOn = s.settings.lanSync;
      if (lastOn) void startLan();
      else void stopLan();
    }
    if (applying === 0 && s.loaded && prev.loaded && s.settings.lanSync && libraryChanged(s, prev)) scheduleAutoSync(2500);
  });
  if (lib().settings.lanSync) void startLan();
}
