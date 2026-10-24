/**
 * 表情制作：在图片上加一段文字。
 * 这里只有排版和绘制逻辑（画布由调用方给），对话框里的实时预览和最终输出走同一份代码，所见即所得。
 */

export type FontKey = 'hei' | 'song' | 'kai' | 'yuan';

export const FONTS: { key: FontKey; label: string; family: string }[] = [
  {
    key: 'hei',
    label: '黑体',
    family: "'Microsoft YaHei', 'PingFang SC', 'Hiragino Sans GB', 'Noto Sans CJK SC', 'Source Han Sans SC', sans-serif",
  },
  { key: 'song', label: '宋体', family: "'SimSun', 'Songti SC', 'STSong', 'Noto Serif CJK SC', serif" },
  { key: 'kai', label: '楷体', family: "'KaiTi', 'STKaiti', 'Kaiti SC', 'Noto Serif CJK SC', serif" },
  { key: 'yuan', label: '圆体', family: "'YouYuan', 'Yuanti SC', 'Microsoft YaHei', 'PingFang SC', sans-serif" },
];

export type TextAnchor = 'top' | 'center' | 'bottom' | 'custom';

export interface TextStyle {
  text: string;
  font: FontKey;
  /** 字号 = 图片高度 × sizeRatio */
  sizeRatio: number;
  bold: boolean;
  color: string;
  /** 描边宽度 = 字号 × strokeRatio；0 表示不描边 */
  strokeRatio: number;
  strokeColor: string;
  shadow: boolean;
  /** 每行文字后面垫一条半透明底色 */
  background: boolean;
  backgroundColor: string;
  anchor: TextAnchor;
  /** anchor 为 custom 时文字块中心的位置（相对图片宽高的比例，0–1） */
  x: number;
  y: number;
}

export const DEFAULT_TEXT_STYLE: TextStyle = {
  text: '',
  font: 'hei',
  sizeRatio: 0.13,
  bold: true,
  color: '#ffffff',
  strokeRatio: 0.12,
  strokeColor: '#000000',
  shadow: false,
  background: false,
  backgroundColor: 'rgba(0, 0, 0, 0.55)',
  anchor: 'bottom',
  x: 0.5,
  y: 0.85,
};

export interface TextPreset {
  key: string;
  label: string;
  patch: Partial<TextStyle>;
}

/** 一键样式（只改颜色 / 描边 / 底色，不动字号和位置） */
export const TEXT_PRESETS: TextPreset[] = [
  { key: 'classic', label: '白字黑边', patch: { color: '#ffffff', strokeRatio: 0.12, strokeColor: '#000000', shadow: false, background: false } },
  { key: 'black', label: '黑字白边', patch: { color: '#111111', strokeRatio: 0.1, strokeColor: '#ffffff', shadow: false, background: false } },
  { key: 'yellow', label: '黄字黑边', patch: { color: '#ffd233', strokeRatio: 0.12, strokeColor: '#000000', shadow: false, background: false } },
  { key: 'red', label: '红字白边', patch: { color: '#e5322d', strokeRatio: 0.1, strokeColor: '#ffffff', shadow: false, background: false } },
  { key: 'plain', label: '纯黑字', patch: { color: '#111111', strokeRatio: 0, shadow: false, background: false } },
  { key: 'bar', label: '白字黑底', patch: { color: '#ffffff', strokeRatio: 0, shadow: false, background: true, backgroundColor: 'rgba(0, 0, 0, 0.55)' } },
];

export const TEXT_COLORS = ['#ffffff', '#111111', '#ffd233', '#e5322d', '#2f9e5b', '#2f7fe5', '#ff7eb6', '#ff8a1f'];
export const STROKE_COLORS = ['#000000', '#ffffff', '#e5322d', '#2f7fe5'];

export function fontFamily(key: FontKey): string {
  return (FONTS.find((f) => f.key === key) ?? FONTS[0]).family;
}

export function cssFont(style: TextStyle, fontPx: number): string {
  return `${style.bold ? 'bold ' : ''}${fontPx}px ${fontFamily(style.font)}`;
}

export type Measure = (s: string) => number;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** 按宽度折行：先按换行符分段，超宽的段逐字折（英文尽量在空格处断开） */
export function wrapLines(text: string, maxWidth: number, measure: Measure): string[] {
  const out: string[] = [];
  for (const para of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (measure(para) <= maxWidth) {
      out.push(para);
      continue;
    }
    const start = out.length;
    let line = '';
    for (const ch of Array.from(para)) {
      if (line && measure(line + ch) > maxWidth) {
        const space = line.lastIndexOf(' ');
        if (space > 0 && ch !== ' ') {
          out.push(line.slice(0, space).trimEnd());
          line = line.slice(space + 1) + ch;
        } else {
          out.push(line.trimEnd());
          line = ch === ' ' ? '' : ch;
        }
      } else {
        line += ch;
      }
    }
    if (line.trimEnd() || out.length === start) out.push(line.trimEnd());
  }
  return out;
}

export interface TextLayout {
  lines: string[];
  widths: number[];
  fontPx: number;
  lineHeight: number;
  strokePx: number;
  /** 底色左右各留的内边距 */
  padX: number;
  blockW: number;
  blockH: number;
  /** 文字块中心（像素） */
  cx: number;
  cy: number;
}

export function fontPxFor(style: TextStyle, height: number): number {
  return Math.max(6, Math.round(height * clamp(style.sizeRatio, 0.03, 0.6)));
}

/** 算出每行文字和整块文字的位置；measure 要用和最终绘制一样的字体去量 */
export function layoutText(style: TextStyle, width: number, height: number, measure: Measure): TextLayout {
  const fontPx = fontPxFor(style, height);
  const lineHeight = Math.round(fontPx * 1.24);
  const strokePx = style.strokeRatio > 0 ? Math.max(1, fontPx * clamp(style.strokeRatio, 0, 0.5)) : 0;
  const padX = style.background ? Math.round(fontPx * 0.3) : 0;
  const margin = Math.max(3, Math.round(Math.min(width, height) * 0.04));
  const maxWidth = Math.max(fontPx, width - margin * 2 - strokePx - padX * 2);
  const lines = wrapLines(style.text, maxWidth, measure);
  const widths = lines.map(measure);
  const blockW = Math.min(width, Math.max(0, ...widths) + strokePx + padX * 2);
  const blockH = lines.length * lineHeight + strokePx;
  let cx = width / 2;
  let cy: number;
  switch (style.anchor) {
    case 'top':
      cy = margin + blockH / 2;
      break;
    case 'center':
      cy = height / 2;
      break;
    case 'bottom':
      cy = height - margin - blockH / 2;
      break;
    default:
      cx = clamp(style.x, 0, 1) * width;
      cy = clamp(style.y, 0, 1) * height;
  }
  // 整块文字尽量留在图内
  cy = blockH < height ? clamp(cy, blockH / 2, height - blockH / 2) : height / 2;
  cx = blockW < width ? clamp(cx, blockW / 2, width - blockW / 2) : width / 2;
  return { lines, widths, fontPx, lineHeight, strokePx, padX, blockW, blockH, cx, cy };
}

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** 把文字画到画布上（画布尺寸 = 图片尺寸）；没有文字时什么也不画并返回 null */
export function drawTextOverlay(ctx: CanvasRenderingContext2D, width: number, height: number, style: TextStyle): TextLayout | null {
  if (!style.text.trim()) return null;
  ctx.save();
  ctx.font = cssFont(style, fontPxFor(style, height));
  const layout = layoutText(style, width, height, (s) => ctx.measureText(s).width);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  const top = layout.cy - layout.blockH / 2 + layout.strokePx / 2;
  const lineY = (i: number) => top + layout.lineHeight * (i + 0.5);
  if (style.background) {
    ctx.fillStyle = style.backgroundColor;
    layout.lines.forEach((line, i) => {
      if (!line) return;
      const w = layout.widths[i] + layout.padX * 2;
      const h = layout.lineHeight;
      roundRectPath(ctx, layout.cx - w / 2, lineY(i) - h / 2, w, h, Math.round(layout.fontPx * 0.25));
      ctx.fill();
    });
  }
  layout.lines.forEach((line, i) => {
    if (!line) return;
    const y = lineY(i);
    if (style.shadow) {
      ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
      ctx.shadowBlur = layout.fontPx * 0.16;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = Math.max(1, layout.fontPx * 0.06);
    }
    if (layout.strokePx > 0) {
      ctx.lineWidth = layout.strokePx;
      ctx.strokeStyle = style.strokeColor;
      ctx.strokeText(line, layout.cx, y);
      // 阴影只投一次：描过边之后填充不再投影，否则会在描边上叠出一层灰
      ctx.shadowColor = 'transparent';
    }
    ctx.fillStyle = style.color;
    ctx.fillText(line, layout.cx, y);
    ctx.shadowColor = 'transparent';
  });
  ctx.restore();
  return layout;
}
