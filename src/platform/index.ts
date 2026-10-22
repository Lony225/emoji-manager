import { createElectronPlatform } from './electron';
import { createWebPlatform } from './web';
import type { Platform } from './types';

/**
 * 运行时选择平台实现：
 * - Electron（Windows / macOS）：preload 注入了 window.emojiBridge
 * - 浏览器：IndexedDB 存储
 * - 以后的 Android（Capacitor）：在这里再加一个判断即可，业务代码不用改
 */
export const platform: Platform = window.emojiBridge
  ? createElectronPlatform(window.emojiBridge)
  : createWebPlatform();
