import { useLayoutEffect, useRef, useState } from 'react';
import { useUiStore } from '../ui/uiStore';
import { Icon } from '../ui/icons';

/** 安全区（状态栏 / 导航栏）的像素值；桌面端为 0 */
function inset(name: '--sat' | '--sab'): number {
  return parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name)) || 0;
}

/** 右键菜单：自动避开窗口边缘，点外面 / Esc / 滚动即关闭 */
export function ContextMenu() {
  const menu = useUiStore((s) => s.menu);
  const closeMenu = useUiStore((s) => s.closeMenu);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  useLayoutEffect(() => {
    if (!menu) {
      setPos(null);
      return;
    }
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const x = Math.min(menu.x, window.innerWidth - width - 8);
    const y = Math.min(menu.y, window.innerHeight - inset('--sab') - height - 8);
    setPos({ x: Math.max(8, x), y: Math.max(8 + inset('--sat'), y) });

    const onDown = (e: MouseEvent) => {
      if (!el.contains(e.target as Node)) closeMenu();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeMenu();
    };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', closeMenu, true);
    window.addEventListener('resize', closeMenu);
    window.addEventListener('blur', closeMenu);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', closeMenu, true);
      window.removeEventListener('resize', closeMenu);
      window.removeEventListener('blur', closeMenu);
    };
  }, [menu, closeMenu]);

  if (!menu) return null;
  return (
    <div
      ref={ref}
      className="menu"
      role="menu"
      style={{ left: pos?.x ?? menu.x, top: pos?.y ?? menu.y, visibility: pos ? 'visible' : 'hidden' }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {menu.items.map((item, i) =>
        item.separator ? (
          <div key={i} className="sep" />
        ) : (
          <button
            key={i}
            role="menuitem"
            className={item.danger ? 'danger' : undefined}
            disabled={item.disabled}
            onClick={() => {
              closeMenu();
              item.onSelect?.();
            }}
          >
            {item.icon ? <Icon name={item.icon} size={16} className="icon" /> : <span style={{ width: 16 }} />}
            {item.label}
          </button>
        ),
      )}
    </div>
  );
}
