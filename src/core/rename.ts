/** 批量改名的几种规则，纯函数，方便测试 */
import type { Sticker } from './types';

export type RenameMode = 'number' | 'affix' | 'replace' | 'manual';

export interface RenameOptions {
  mode: RenameMode;
  /** number：统一名称 */
  base: string;
  /** number：起始序号 */
  start: number;
  /** number：序号位数（补零），0 表示不补 */
  digits: number;
  /** affix */
  prefix: string;
  suffix: string;
  /** replace */
  find: string;
  replaceWith: string;
  useRegex: boolean;
  caseInsensitive: boolean;
  /** manual：逐个给出的名字 */
  manual: Record<string, string>;
}

export const DEFAULT_RENAME: RenameOptions = {
  mode: 'number',
  base: '',
  start: 1,
  digits: 0,
  prefix: '',
  suffix: '',
  find: '',
  replaceWith: '',
  useRegex: false,
  caseInsensitive: true,
  manual: {},
};

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 按规则算出每个表情的新名字；名字没变的不包含在结果里 */
export function planRename(stickers: Sticker[], o: RenameOptions): { id: string; name: string }[] {
  const out: { id: string; name: string }[] = [];
  let re: RegExp | null = null;
  if (o.mode === 'replace' && o.find) {
    try {
      re = new RegExp(o.useRegex ? o.find : escapeRegex(o.find), 'g' + (o.caseInsensitive ? 'i' : ''));
    } catch {
      re = null;
    }
  }
  stickers.forEach((s, i) => {
    let name: string;
    switch (o.mode) {
      case 'number': {
        const base = o.base.trim();
        if (!base) return;
        const n = String(Math.max(0, Math.floor(o.start)) + i);
        name = `${base} ${o.digits > 0 ? n.padStart(o.digits, '0') : n}`;
        break;
      }
      case 'affix':
        name = `${o.prefix}${s.name}${o.suffix}`;
        break;
      case 'replace':
        if (!re) return;
        name = s.name.replace(re, o.replaceWith);
        break;
      case 'manual':
        name = o.manual[s.id] ?? s.name;
        break;
    }
    name = name.trim().slice(0, 80);
    if (name && name !== s.name) out.push({ id: s.id, name });
  });
  return out;
}
