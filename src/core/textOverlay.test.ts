import { describe, expect, it } from 'vitest';
import { DEFAULT_TEXT_STYLE, layoutText, wrapLines } from './textOverlay';

/** 每个字符 10 宽的假量尺 */
const measure = (s: string) => Array.from(s).length * 10;

describe('文字排版', () => {
  it('wrapLines 按宽度逐字折行，保留空行', () => {
    expect(wrapLines('你好世界', 25, measure)).toEqual(['你好', '世界']);
    expect(wrapLines('短', 100, measure)).toEqual(['短']);
    expect(wrapLines('a\n\nb', 100, measure)).toEqual(['a', '', 'b']);
    expect(wrapLines('第一行\n第二行很长很长', 50, measure)).toEqual(['第一行', '第二行很长', '很长']);
  });

  it('wrapLines 英文尽量在空格处断开', () => {
    expect(wrapLines('hello world foo', 70, measure)).toEqual(['hello', 'world', 'foo']);
    // 单个超宽的词只能硬折
    expect(wrapLines('abcdefghij', 35, measure)).toEqual(['abc', 'def', 'ghi', 'j']);
  });

  it('layoutText 按锚点摆放，并且不会跑出图外', () => {
    const style = { ...DEFAULT_TEXT_STYLE, text: '测试', sizeRatio: 0.2, strokeRatio: 0 };
    const top = layoutText({ ...style, anchor: 'top' }, 200, 100, measure);
    const center = layoutText({ ...style, anchor: 'center' }, 200, 100, measure);
    const bottom = layoutText({ ...style, anchor: 'bottom' }, 200, 100, measure);
    expect(top.fontPx).toBe(20);
    expect(top.lines).toEqual(['测试']);
    expect(top.cx).toBe(100);
    expect(top.cy).toBeLessThan(center.cy);
    expect(center.cy).toBe(50);
    expect(center.cy).toBeLessThan(bottom.cy);
    expect(bottom.cy + bottom.blockH / 2).toBeLessThanOrEqual(100);

    // 自定义位置拖到角落：文字块被夹回图内
    const corner = layoutText({ ...style, anchor: 'custom', x: 0, y: 1 }, 200, 100, measure);
    expect(corner.cx).toBe(corner.blockW / 2);
    expect(corner.cy).toBe(100 - corner.blockH / 2);
  });

  it('layoutText 超宽文字自动折行，字号随图片高度变化', () => {
    const style = { ...DEFAULT_TEXT_STYLE, text: '一二三四五六七八九十', sizeRatio: 0.1 };
    const lay = layoutText(style, 60, 100, measure);
    expect(lay.fontPx).toBe(10);
    expect(lay.lines.length).toBeGreaterThan(1);
    expect(lay.blockW).toBeLessThanOrEqual(60);
    const big = layoutText(style, 60, 300, measure);
    expect(big.fontPx).toBe(30);
  });
});
