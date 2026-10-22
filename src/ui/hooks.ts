import { useEffect, useState } from 'react';
import { platform } from '../platform';
import { useLibraryStore } from '../core/store';

/** 把 settings.theme 应用到 <html data-theme>，"跟随系统"时监听系统变化 */
export function useTheme(): void {
  const theme = useLibraryStore((s) => s.settings.theme);
  useEffect(() => {
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      document.documentElement.dataset.theme = theme === 'system' ? (mql.matches ? 'dark' : 'light') : theme;
    };
    apply();
    mql.addEventListener('change', apply);
    return () => mql.removeEventListener('change', apply);
  }, [theme]);
}

/** 把资料目录里的相对路径变成可以放进 <img src> 的地址 */
export function useFileUrl(rel: string): string {
  const [url, setUrl] = useState(() => platform.fileUrlSync(rel) ?? '');
  useEffect(() => {
    let alive = true;
    const sync = platform.fileUrlSync(rel);
    if (sync) {
      setUrl(sync);
      return;
    }
    void platform.fileUrl(rel).then((u) => {
      if (alive) setUrl(u);
    });
    return () => {
      alive = false;
    };
  }, [rel]);
  return url;
}

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    mql.addEventListener('change', onChange);
    setMatches(mql.matches);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

/** 窄窗口（以后 Android 也走这个布局）：侧栏变抽屉 */
export const useNarrow = (): boolean => useMediaQuery('(max-width: 900px)');

export function formatTime(ts: number | undefined): string {
  if (!ts) return '从未';
  const d = new Date(ts);
  const now = Date.now();
  const diff = now - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000 && d.getDate() === new Date().getDate()) {
    return `今天 ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
  }
  return `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, '0')}-${d.getDate().toString().padStart(2, '0')}`;
}

export function syncSummary(r: { added: number; updated: number; removed: number; failed: number }): string {
  const parts: string[] = [];
  if (r.added) parts.push(`新增 ${r.added}`);
  if (r.updated) parts.push(`更新 ${r.updated}`);
  if (r.removed) parts.push(`移除 ${r.removed}`);
  if (r.failed) parts.push(`${r.failed} 个下载失败`);
  return parts.length ? `同步完成：${parts.join('，')}` : '同步完成，没有变化';
}
