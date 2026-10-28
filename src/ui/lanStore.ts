import { create } from 'zustand';
import type { LanDevice } from '../platform/types';
import type { LanPair, LanStore } from '../core/lan/protocol';
import type { SyncProgress } from '../core/lan/session';

/**
 * 局域网同步的界面状态：本机身份与配对（存 localStorage，每台设备各自一份，不进资料文件——
 * 资料目录可能放在同步盘上被多台电脑共用）、在线设备、正在进行的同步。
 */
export interface LanUiState {
  /** 服务是否已启动 */
  running: boolean;
  /** 本机 HTTP 服务的端口（调试 / 防火墙排查用） */
  port: number;
  startError?: string;
  identity: LanStore;
  devices: LanDevice[];
  /** 正在和哪些设备同步 */
  syncing: Record<string, SyncProgress>;
  /** 正在等待对方确认的配对（发起方） */
  pairing: string | null;

  setRunning: (running: boolean, error?: string, port?: number) => void;
  setIdentity: (identity: LanStore) => void;
  setDevices: (devices: LanDevice[]) => void;
  setSyncing: (deviceId: string, progress: SyncProgress | null) => void;
  setPairing: (deviceId: string | null) => void;
  updatePair: (id: string, patch: Partial<LanPair>) => void;
}

const STORAGE_KEY = 'emoji-manager.lan';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function loadLanStore(): LanStore {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as unknown;
    if (isRecord(raw) && typeof raw.id === 'string' && raw.id) {
      const pairs = Array.isArray(raw.pairs)
        ? raw.pairs
            .filter((p): p is Record<string, unknown> => isRecord(p) && typeof p.id === 'string' && typeof p.token === 'string')
            .map(
              (p): LanPair => ({
                id: p.id as string,
                name: typeof p.name === 'string' ? p.name : '设备',
                os: typeof p.os === 'string' ? (p.os as LanPair['os']) : 'unknown',
                token: p.token as string,
                pairedAt: typeof p.pairedAt === 'number' ? p.pairedAt : 0,
                lastSyncAt: typeof p.lastSyncAt === 'number' ? p.lastSyncAt : undefined,
                lastResult: typeof p.lastResult === 'string' ? p.lastResult : undefined,
                lastError: typeof p.lastError === 'string' ? p.lastError : undefined,
              }),
            )
        : [];
      return { id: raw.id, name: typeof raw.name === 'string' ? raw.name : '', pairs };
    }
  } catch {
    /* 没有或坏了：重新生成 */
  }
  return { id: '', name: '', pairs: [] };
}

export function saveLanStore(s: LanStore): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* 存不了就算了（隐私模式等） */
  }
}

export const useLanStore = create<LanUiState>()((set) => ({
  running: false,
  port: 0,
  identity: { id: '', name: '', pairs: [] },
  devices: [],
  syncing: {},
  pairing: null,

  setRunning: (running, startError, port = 0) => set({ running, startError, port }),
  setIdentity: (identity) => {
    saveLanStore(identity);
    set({ identity });
  },
  setDevices: (devices) => set({ devices }),
  setSyncing: (deviceId, progress) =>
    set((s) => {
      const syncing = { ...s.syncing };
      if (progress) syncing[deviceId] = progress;
      else delete syncing[deviceId];
      return { syncing };
    }),
  setPairing: (pairing) => set({ pairing }),
  updatePair: (id, patch) =>
    set((s) => {
      const identity = { ...s.identity, pairs: s.identity.pairs.map((p) => (p.id === id ? { ...p, ...patch } : p)) };
      saveLanStore(identity);
      return { identity };
    }),
}));
