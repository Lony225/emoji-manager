import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles/base.css';
import './styles/sidebar.css';
import './styles/grid.css';
import './styles/overlays.css';
import './styles/float.css';
import './styles/mobile.css';
import { App } from './App';
import { FloatApp } from './float/FloatApp';
import { platform } from './platform';
import { useLibraryStore } from './core/store';
import { useUiStore } from './ui/uiStore';
import * as actions from './ui/actions';
import { runUpdateCheck } from './ui/update';

declare global {
  interface Window {
    /** 供端到端测试脚本驱动应用 */
    __emojiStore: typeof useLibraryStore;
    __uiStore: typeof useUiStore;
    __emojiActions: typeof actions;
    __runUpdateCheck: typeof runUpdateCheck;
  }
}
window.__emojiStore = useLibraryStore;
window.__uiStore = useUiStore;
window.__emojiActions = actions;
window.__runUpdateCheck = runUpdateCheck;

// 同一份页面既是主窗口也是浮窗：由主进程启动时告诉我们是哪一个
const Root = platform.windowRole === 'float' ? FloatApp : App;
document.documentElement.dataset.window = platform.windowRole;
document.documentElement.dataset.platform = platform.kind;

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
