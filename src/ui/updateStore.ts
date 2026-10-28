import { create } from 'zustand';
import type { UpdateState } from '../platform/types';

/** 内置更新（Windows 安装版）的下载 / 安装状态：主进程是唯一来源，这里只是镜像给界面用 */
export interface UpdateUiState {
  state: UpdateState;
  setState: (state: UpdateState) => void;
}

export const IDLE_UPDATE: UpdateState = { phase: 'idle', version: '', percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 };

export const useUpdateStore = create<UpdateUiState>()((set) => ({
  state: IDLE_UPDATE,
  setState: (state) => set({ state }),
}));
