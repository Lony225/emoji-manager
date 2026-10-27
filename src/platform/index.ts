import { Capacitor } from '@capacitor/core';
import { createCapacitorPlatform } from './capacitor';
import { createElectronPlatform } from './electron';
import { createWebPlatform } from './web';
import type { Platform } from './types';

/**
 * 运行时选择平台实现：
 * - Electron（Windows / macOS）：preload 注入了 window.emojiBridge
 * - Android（Capacitor）：原生壳注入了 window.Capacitor
 * - 浏览器：IndexedDB 存储
 */
export const platform: Platform = window.emojiBridge
  ? createElectronPlatform(window.emojiBridge)
  : Capacitor.isNativePlatform()
    ? createCapacitorPlatform()
    : createWebPlatform();

/** 手机（安卓应用，或手机浏览器）：点一下表情默认分享而不是复制，菜单也按触屏排 */
export const isMobile = platform.os === 'android' || platform.os === 'ios';
