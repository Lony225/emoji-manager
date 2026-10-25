/**
 * 模板表情（meme-generator 的 299 个模板）：和界面无关的小工具，供对话框和测试使用。
 */
import type { MemeOptionSchema, MemeOptionValues, MemeTemplate } from '../platform/types';

export type TemplateKind = 'image' | 'text' | 'mixed';

/** 图片类（只要头像）、文字类（只要文字）、图文类 */
export function templateKind(t: MemeTemplate): TemplateKind {
  const img = t.maxImages > 0;
  const txt = t.maxTexts > 0;
  return img && txt ? 'mixed' : img ? 'image' : 'text';
}

export function templateTitle(t: MemeTemplate): string {
  return t.keywords[0] ?? t.key;
}

function range(min: number, max: number, unit: string): string {
  return min === max ? `${min} ${unit}` : `${min}~${max} ${unit}`;
}

/** “需要 1 张图片、0~1 段文字” */
export function describeRequirements(t: MemeTemplate): string {
  const parts: string[] = [];
  if (t.maxImages > 0) parts.push(range(t.minImages, t.maxImages, '张图片'));
  if (t.maxTexts > 0) parts.push(range(t.minTexts, t.maxTexts, '段文字'));
  return parts.length ? `需要 ${parts.join('、')}` : '不需要图片和文字';
}

/** 选项的默认值（没有默认值的不设） */
export function defaultOptionValues(t: MemeTemplate): MemeOptionValues {
  const out: MemeOptionValues = {};
  for (const o of t.options) if (o.default !== null && o.default !== undefined) out[o.name] = o.default;
  return out;
}

/** 数字选项夹到范围内；非法输入回退到默认值或下限 */
export function clampOptionValue(schema: MemeOptionSchema, raw: string | number): number {
  let v = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(v)) v = typeof schema.default === 'number' ? schema.default : (schema.minimum ?? 0);
  if (schema.type === 'integer') v = Math.round(v);
  if (schema.minimum !== null && schema.minimum !== undefined) v = Math.max(schema.minimum, v);
  if (schema.maximum !== null && schema.maximum !== undefined) v = Math.min(schema.maximum, v);
  return v;
}

/** 关键词 / 标签 / 快捷指令 / key 里包含搜索词 */
export function matchesQuery(t: MemeTemplate, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = [t.key, ...t.keywords, ...t.tags, ...t.shortcuts.map((s) => s.humanized ?? '')];
  return hay.some((v) => v.toLowerCase().includes(q));
}

export interface TemplateFilter {
  query: string;
  kind: 'all' | TemplateKind;
  tag: string;
}

export function filterTemplates(list: MemeTemplate[], f: TemplateFilter): MemeTemplate[] {
  return list.filter((t) => (f.kind === 'all' || templateKind(t) === f.kind) && (!f.tag || t.tags.includes(f.tag)) && matchesQuery(t, f.query));
}

/** 出现次数最多的标签 */
export function topTags(list: MemeTemplate[], n: number): { tag: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const t of list) for (const tag of t.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  return Array.from(counts, ([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'zh-Hans-CN'))
    .slice(0, n);
}

/**
 * 整理用户填的文字：去掉首尾空白，末尾空着的不算；必填的位置没填就用模板的默认文字。
 * 数量不在模板要求的范围内时抛出可读的错误。
 */
export function resolveTexts(t: MemeTemplate, texts: string[]): string[] {
  const trimmed = texts.map((s) => s.trim());
  while (trimmed.length > 0 && trimmed[trimmed.length - 1] === '' && trimmed.length > t.minTexts) trimmed.pop();
  const out = trimmed.map((s, i) => s || t.defaultTexts[i] || '');
  if (out.length < t.minTexts) {
    for (let i = out.length; i < t.minTexts; i++) out.push(t.defaultTexts[i] ?? '');
  }
  if (out.some((s) => !s)) throw new Error(`请填写文字（这个模板需要 ${range(t.minTexts, t.maxTexts, '段')}）`);
  if (out.length > t.maxTexts) throw new Error(`最多只能填 ${t.maxTexts} 段文字`);
  return out;
}

/** 图片数量是否满足模板要求；不满足时返回提示 */
export function checkImageCount(t: MemeTemplate, n: number): string | null {
  if (n < t.minImages) return t.minImages === 1 ? '请先选一张图片' : `还需要 ${t.minImages - n} 张图片（共 ${t.minImages} 张）`;
  if (n > t.maxImages) return `最多只能用 ${t.maxImages} 张图片`;
  return null;
}
