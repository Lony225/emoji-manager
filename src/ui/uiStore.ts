import { create } from 'zustand';
import type { Filter, SortKey, View } from '../core/selectors';
import type { PickedFolder } from '../platform/types';
import type { LatestRelease } from '../core/update';
import type { IconName } from './icons';

export type DialogState =
  | { kind: 'none' }
  | { kind: 'sticker'; id: string }
  | {
      kind: 'prompt';
      title: string;
      label?: string;
      value: string;
      placeholder?: string;
      confirmText?: string;
      onSubmit: (value: string) => void | Promise<void>;
    }
  | {
      kind: 'confirm';
      title: string;
      message: string;
      confirmText?: string;
      danger?: boolean;
      checkbox?: { label: string; checked: boolean };
      onConfirm: (checked: boolean) => void | Promise<void>;
    }
  | { kind: 'subscriptions'; focusAdd?: boolean }
  | { kind: 'settings' }
  | { kind: 'bulkTags'; ids: string[] }
  | { kind: 'move'; ids: string[] }
  | {
      kind: 'pickCategory';
      title: string;
      current?: string | null;
      hint?: string;
      onPick: (categoryId: string | null, name: string) => void;
    }
  | { kind: 'importFolders'; folders: PickedFolder[]; parentName?: string }
  | { kind: 'exportPackage'; ids: string[]; defaultName: string }
  | { kind: 'categoryParent'; id: string }
  | { kind: 'update'; release: LatestRelease; current: string };

export interface MenuItem {
  label: string;
  icon?: IconName;
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
  onSelect?: () => void;
}

export interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

export interface Toast {
  id: number;
  message: string;
  kind: 'info' | 'success' | 'error';
}

export type StampState = 'pending' | 'done';

interface UiState {
  filter: Filter;
  setView: (view: View) => void;
  toggleTag: (tag: string) => void;
  clearTags: () => void;
  setQuery: (query: string) => void;
  setSort: (sort: SortKey) => void;

  selection: Set<string>;
  anchorId: string | null;
  select: (ids: string[], mode: 'replace' | 'toggle' | 'add') => void;
  setAnchor: (id: string | null) => void;
  clearSelection: () => void;

  /** 正在网格里就地改名的表情 */
  renamingId: string | null;
  setRenaming: (id: string | null) => void;

  dialog: DialogState;
  openDialog: (dialog: DialogState) => void;
  closeDialog: () => void;

  menu: MenuState | null;
  openMenu: (menu: MenuState) => void;
  closeMenu: () => void;

  toasts: Toast[];
  toast: (message: string, kind?: Toast['kind']) => void;
  dismissToast: (id: number) => void;

  stamps: Record<string, StampState>;
  setStamp: (id: string, state: StampState | null) => void;
  setStamps: (ids: string[], state: StampState | null) => void;

  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
}

let toastSeq = 0;

export const useUiStore = create<UiState>()((set, get) => ({
  filter: { view: { kind: 'all' }, tags: [], query: '', sort: 'newest' },
  setView: (view) => set((s) => ({ filter: { ...s.filter, view }, selection: new Set(), sidebarOpen: false })),
  toggleTag: (tag) =>
    set((s) => ({
      filter: {
        ...s.filter,
        tags: s.filter.tags.includes(tag) ? s.filter.tags.filter((t) => t !== tag) : [...s.filter.tags, tag],
      },
    })),
  clearTags: () => set((s) => ({ filter: { ...s.filter, tags: [] } })),
  setQuery: (query) => set((s) => ({ filter: { ...s.filter, query } })),
  setSort: (sort) => set((s) => ({ filter: { ...s.filter, sort } })),

  selection: new Set(),
  anchorId: null,
  select: (ids, mode) =>
    set((s) => {
      if (mode === 'replace') return { selection: new Set(ids) };
      const next = new Set(s.selection);
      for (const id of ids) {
        if (mode === 'toggle' && next.has(id)) next.delete(id);
        else next.add(id);
      }
      return { selection: next };
    }),
  setAnchor: (anchorId) => set({ anchorId }),
  clearSelection: () => set({ selection: new Set(), anchorId: null }),

  renamingId: null,
  setRenaming: (renamingId) => set({ renamingId }),

  dialog: { kind: 'none' },
  openDialog: (dialog) => set({ dialog, menu: null }),
  closeDialog: () => set({ dialog: { kind: 'none' } }),

  menu: null,
  openMenu: (menu) => set({ menu }),
  closeMenu: () => set({ menu: null }),

  toasts: [],
  toast: (message, kind = 'info') => {
    const id = ++toastSeq;
    set((s) => ({ toasts: [...s.toasts.slice(-3), { id, message, kind }] }));
    setTimeout(() => get().dismissToast(id), kind === 'error' ? 6000 : 2600);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  stamps: {},
  setStamp: (id, state) => get().setStamps([id], state),
  setStamps: (ids, state) =>
    set((s) => {
      const stamps = { ...s.stamps };
      for (const id of ids) {
        if (state === null) delete stamps[id];
        else stamps[id] = state;
      }
      return { stamps };
    }),

  sidebarOpen: false,
  setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
}));
