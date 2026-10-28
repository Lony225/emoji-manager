import type { SVGProps } from 'react';

const PATHS = {
  search: 'M11 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14zm9 16-4-4',
  plus: 'M12 5v14M5 12h14',
  settings: 'M4 7h10M18 7h2M4 17h4M12 17h8M14 4.5v5M8 14.5v5',
  sync: 'M20 11a8 8 0 0 0-14.6-3.4M4 13a8 8 0 0 0 14.6 3.4M4 4v5h5M20 20v-5h-5',
  star: 'm12 3 2.8 5.9 6.2.8-4.5 4.4 1.1 6.3L12 17.4l-5.6 3 1.1-6.3L3 9.7l6.2-.8z',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6',
  copy: 'M9 9h11v11H9zM4 15V4h11',
  file: 'M6 3h8l5 5v13H6zM14 3v5h5',
  tag: 'M3 12V4h8l9 9-8 8zM7.5 8h.01',
  folder: 'M3 6h6l2 2h10v11H3z',
  edit: 'M4 20h4L19 9l-4-4L4 16zM13 7l4 4',
  x: 'M6 6l12 12M18 6 6 18',
  check: 'm5 12 5 5L20 7',
  menu: 'M4 7h16M4 12h16M4 17h16',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.5 1.5M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.5-1.5',
  image: 'M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15.5 9h.01',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  chevronDown: 'm6 9 6 6 6-6',
  arrowUp: 'M12 19V5M6 11l6-6 6 6',
  arrowDown: 'M12 5v14M6 13l6 6 6-6',
  external: 'M14 4h6v6M20 4l-9 9M18 13v7H4V6h7',
  info: 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zM12 11v5M12 8h.01',
  share: 'M18 5a2 2 0 1 1 0 4 2 2 0 0 1 0-4zM6 10a2 2 0 1 1 0 4 2 2 0 0 1 0-4zM18 15a2 2 0 1 1 0 4 2 2 0 0 1 0-4zM8 11l8-4M8 13l8 4',
  download: 'M12 4v12M7 11l5 5 5-5M5 20h14',
  rss: 'M5 19a1 1 0 1 1 0-.01M5 11a8 8 0 0 1 8 8M5 5a14 14 0 0 1 14 14',
  heart: 'M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.5A4 4 0 0 1 19 10c0 5.5-7 10-7 10z',
  inbox: 'M4 13h5l1 2h4l1-2h5M4 13V6h16v7M4 13v5h16v-5',
  eye: 'M2 12s4-6 10-6 10 6 10 6-4 6-10 6S2 12 2 12zM12 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6z',
  undo: 'M4 10h11a5 5 0 0 1 0 10h-4M4 10l4-4M4 10l4 4',
  play: 'M8 5v14l11-7z',
  pause: 'M7 5h4v14H7zM13 5h4v14h-4z',
  rename: 'M4 7h4M4 17h4M6 7v10M11 5h9v14h-9M14 9h3M14 12h3M14 15h3',
  selectAll: 'M4 4h16v16H4zM8 12l3 3 5-6',
  smile: 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zM9 10h.01M15 10h.01M8.5 14a4 4 0 0 0 7 0',
  clock: 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zM12 7v5l3 2',
  pin: 'M9 4h6l-1 6 3 3H7l3-3zM12 13v7',
  pinOff: 'M9 4h6l-1 6 3 3H7l3-3zM12 13v7M4 4l16 16',
  window: 'M4 5h16v14H4zM4 9h16',
  keyboard: 'M3 7h18v10H3zM7 11h.01M11 11h.01M15 11h.01M7 14h10',
  paste: 'M9 3h6v3H9zM15 4h3v16H6V4h3M9 11h6M9 15h4',
  text: 'M5 7V4h14v3M12 4v16M9 20h6',
  sparkles: 'M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2zM5 15l1 2.5 2.5 1-2.5 1L5 22l-1-2.5-2.5-1 2.5-1zM19 14l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z',
  phone: 'M7 3h10v18H7zM11 18h2',
  laptop: 'M4 5h16v11H4zM2 19h20',
  wifi: 'M2 9a15 15 0 0 1 20 0M5.5 12.5a10 10 0 0 1 13 0M9 16a5 5 0 0 1 6 0M12 19h.01',
  unlink: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.5 1.5M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.5-1.5M4 4l16 16',
} as const;

export type IconName = keyof typeof PATHS;

interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName;
  size?: number;
}

export function Icon({ name, size = 18, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

/** 旋转的加载指示 */
export function Spinner({ size = 16 }: { size?: number }) {
  return (
    <svg className="spinner" width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" opacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}
