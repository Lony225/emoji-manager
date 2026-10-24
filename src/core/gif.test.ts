import { describe, expect, it } from 'vitest';
import { GifEncoder, encodeGif, hasTransparentPixels, quantize } from './gif';

// ---------------------------------------------------------------- 测试用的 GIF 解析 / LZW 解码（和浏览器解码器同一套规则）

function lzwDecode(data: Uint8Array, minCodeSize: number, pixelCount: number): Uint8Array {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  let codeSize = minCodeSize + 1;
  let codeMask = (1 << codeSize) - 1;
  const prefix = new Uint16Array(4096);
  const suffix = new Uint8Array(4096);
  const stack = new Uint8Array(4097);
  let avail = clear + 2;
  let oldCode = -1;
  let first = 0;
  const out = new Uint8Array(pixelCount);
  let op = 0;
  let bits = 0;
  let datum = 0;
  let pos = 0;
  while (op < pixelCount) {
    while (bits < codeSize) {
      if (pos >= data.length) throw new Error('数据提前结束');
      datum |= data[pos++] << bits;
      bits += 8;
    }
    let code = datum & codeMask;
    datum >>>= codeSize;
    bits -= codeSize;
    if (code === clear) {
      codeSize = minCodeSize + 1;
      codeMask = (1 << codeSize) - 1;
      avail = clear + 2;
      oldCode = -1;
      continue;
    }
    if (code === eoi) break;
    if (oldCode === -1) {
      out[op++] = code;
      first = code;
      oldCode = code;
      continue;
    }
    const inCode = code;
    let sp = 0;
    if (code >= avail) {
      stack[sp++] = first;
      code = oldCode;
    }
    while (code >= clear) {
      stack[sp++] = suffix[code];
      code = prefix[code];
    }
    first = code;
    stack[sp++] = code;
    while (sp > 0 && op < pixelCount) out[op++] = stack[--sp];
    if (avail < 4096) {
      prefix[avail] = oldCode;
      suffix[avail] = first;
      avail++;
      if ((avail & codeMask) === 0 && avail < 4096) {
        codeSize++;
        codeMask += avail;
      }
    }
    oldCode = inCode;
  }
  return out;
}

interface ParsedFrame {
  x: number;
  y: number;
  w: number;
  h: number;
  delayCs: number;
  disposal: number;
  transparent: number | null;
  palette: Uint8Array;
  indices: Uint8Array;
}

function parseGif(bytes: Uint8Array) {
  const u16 = (p: number) => bytes[p] | (bytes[p + 1] << 8);
  expect(String.fromCharCode(...bytes.subarray(0, 6))).toBe('GIF89a');
  const width = u16(6);
  const height = u16(8);
  let p = 13;
  let gct: Uint8Array | null = null;
  if (bytes[10] & 0x80) {
    const n = 1 << ((bytes[10] & 7) + 1);
    gct = bytes.subarray(p, p + n * 3);
    p += n * 3;
  }
  const readSubBlocks = () => {
    const parts: number[] = [];
    for (;;) {
      const n = bytes[p++];
      if (n === 0) break;
      for (let i = 0; i < n; i++) parts.push(bytes[p++]);
    }
    return new Uint8Array(parts);
  };
  const frames: ParsedFrame[] = [];
  let loop: number | null = null;
  let gce: { delayCs: number; disposal: number; transparent: number | null } | null = null;
  for (;;) {
    const b = bytes[p++];
    if (b === 0x3b) break;
    if (b === 0x21) {
      const label = bytes[p++];
      if (label === 0xf9) {
        const size = bytes[p++];
        const packed = bytes[p];
        gce = { disposal: (packed >> 2) & 7, delayCs: u16(p + 1), transparent: packed & 1 ? bytes[p + 3] : null };
        p += size;
        expect(bytes[p++]).toBe(0);
      } else if (label === 0xff) {
        const size = bytes[p++];
        const id = String.fromCharCode(...bytes.subarray(p, p + size));
        p += size;
        const sub = readSubBlocks();
        if (id === 'NETSCAPE2.0') loop = sub[1] | (sub[2] << 8);
      } else {
        readSubBlocks();
      }
    } else if (b === 0x2c) {
      const x = u16(p), y = u16(p + 2), w = u16(p + 4), h = u16(p + 6);
      const packed = bytes[p + 8];
      p += 9;
      let lct: Uint8Array | null = null;
      if (packed & 0x80) {
        const n = 1 << ((packed & 7) + 1);
        lct = bytes.subarray(p, p + n * 3);
        p += n * 3;
      }
      const minCodeSize = bytes[p++];
      const data = readSubBlocks();
      const palette = lct ?? gct;
      if (!palette) throw new Error('没有调色板');
      frames.push({ x, y, w, h, delayCs: gce?.delayCs ?? 0, disposal: gce?.disposal ?? 0, transparent: gce?.transparent ?? null, palette, indices: lzwDecode(data, minCodeSize, w * h) });
      gce = null;
    } else {
      throw new Error(`未知的块 0x${b.toString(16)} @${p - 1}`);
    }
  }
  return { width, height, loop, frames };
}

/** 按 GIF 的规则把帧叠成完整画面（RGBA），用来和输入对比 */
function compose(parsed: ReturnType<typeof parseGif>): Uint8Array[] {
  const { width, height } = parsed;
  const canvas = new Uint8Array(width * height * 4);
  const out: Uint8Array[] = [];
  let prevRect: { x: number; y: number; w: number; h: number; disposal: number } | null = null;
  for (const f of parsed.frames) {
    if (prevRect?.disposal === 2) {
      for (let y = prevRect.y; y < prevRect.y + prevRect.h; y++) canvas.fill(0, (y * width + prevRect.x) * 4, (y * width + prevRect.x + prevRect.w) * 4);
    }
    for (let y = 0; y < f.h; y++) {
      for (let x = 0; x < f.w; x++) {
        const idx = f.indices[y * f.w + x];
        if (idx === f.transparent) continue;
        const o = ((f.y + y) * width + f.x + x) * 4;
        canvas[o] = f.palette[idx * 3];
        canvas[o + 1] = f.palette[idx * 3 + 1];
        canvas[o + 2] = f.palette[idx * 3 + 2];
        canvas[o + 3] = 255;
      }
    }
    out.push(canvas.slice());
    prevRect = { x: f.x, y: f.y, w: f.w, h: f.h, disposal: f.disposal };
  }
  return out;
}

function frame(w: number, h: number, fill: (x: number, y: number) => [number, number, number, number?]): Uint8Array {
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b, a = 255] = fill(x, y);
      rgba.set([r, g, b, a], (y * w + x) * 4);
    }
  }
  return rgba;
}

/** 伪随机数（固定种子，结果可复现） */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function expectRgbEqual(actual: Uint8Array, expected: Uint8Array) {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < actual.length; i += 4) {
    if (expected[i + 3] < 128) {
      expect(actual[i + 3]).toBe(0);
      continue;
    }
    if (actual[i] !== expected[i] || actual[i + 1] !== expected[i + 1] || actual[i + 2] !== expected[i + 2]) {
      throw new Error(`像素 ${i / 4} 不一致：${[actual[i], actual[i + 1], actual[i + 2]]} vs ${[expected[i], expected[i + 1], expected[i + 2]]}`);
    }
  }
}

// ---------------------------------------------------------------- 用例

describe('gif 编码', () => {
  it('单帧不透明：颜色、尺寸、循环信息原样写入', () => {
    const w = 8, h = 6;
    const f = frame(w, h, (x, y) => (x < 4 ? [255, 0, 0] : y < 3 ? [0, 255, 0] : [0, 0, 255]));
    const gif = encodeGif([{ rgba: f, delayMs: 1234 }], { width: w, height: h });
    const parsed = parseGif(gif);
    expect(parsed.width).toBe(w);
    expect(parsed.height).toBe(h);
    expect(parsed.loop).toBe(0);
    expect(parsed.frames).toHaveLength(1);
    const fr = parsed.frames[0];
    expect([fr.x, fr.y, fr.w, fr.h]).toEqual([0, 0, w, h]);
    expect(fr.delayCs).toBe(123);
    expect(fr.transparent).toBeNull();
    expect(fr.disposal).toBe(1);
    expectRgbEqual(compose(parsed)[0], f);
  });

  it('透明模式：透明像素有透明索引，处理方式为恢复背景，每帧全量', () => {
    const w = 10, h = 10;
    const a = frame(w, h, (x, y) => (x + y < 10 ? [200, 100, 50] : [0, 0, 0, 0]));
    const b = frame(w, h, (x, y) => (x + y < 6 ? [10, 20, 30] : [0, 0, 0, 0]));
    const gif = encodeGif([{ rgba: a, delayMs: 80 }, { rgba: b, delayMs: 80 }], { width: w, height: h });
    const parsed = parseGif(gif);
    expect(parsed.frames).toHaveLength(2);
    for (const fr of parsed.frames) {
      expect(fr.transparent).not.toBeNull();
      expect(fr.disposal).toBe(2);
      expect([fr.w, fr.h]).toEqual([w, h]);
    }
    const composed = compose(parsed);
    expectRgbEqual(composed[0], a);
    expectRgbEqual(composed[1], b);
  });

  it('不透明动图：只写有变化的矩形，相同的帧合并停留时间', () => {
    const w = 20, h = 12;
    const base = frame(w, h, () => [240, 240, 240]);
    const changed = base.slice();
    // 在 (5..8, 3..4) 画一个小方块
    for (let y = 3; y <= 4; y++) for (let x = 5; x <= 8; x++) changed.set([255, 0, 0, 255], (y * w + x) * 4);
    const gif = encodeGif(
      [
        { rgba: base, delayMs: 100 },
        { rgba: changed, delayMs: 100 },
        { rgba: changed, delayMs: 50 },
        { rgba: base, delayMs: 100 },
      ],
      { width: w, height: h },
    );
    const parsed = parseGif(gif);
    expect(parsed.frames).toHaveLength(3);
    expect([parsed.frames[1].x, parsed.frames[1].y, parsed.frames[1].w, parsed.frames[1].h]).toEqual([5, 3, 4, 2]);
    expect(parsed.frames[1].delayCs).toBe(15);
    expect(parsed.frames[1].disposal).toBe(1);
    const composed = compose(parsed);
    expectRgbEqual(composed[0], base);
    expectRgbEqual(composed[1], changed);
    expectRgbEqual(composed[2], base);
  });

  it('颜色不超过 256 种时无损；随机大图会触发 LZW 字典重置也能还原', () => {
    const w = 160, h = 120;
    const rand = rng(7);
    const palette = Array.from({ length: 256 }, () => [Math.floor(rand() * 256), Math.floor(rand() * 256), Math.floor(rand() * 256)] as [number, number, number]);
    const f = frame(w, h, () => palette[Math.floor(rand() * 256)]);
    const gif = encodeGif([{ rgba: f, delayMs: 100 }], { width: w, height: h });
    const parsed = parseGif(gif);
    expect(parsed.frames[0].palette.length).toBe(256 * 3);
    expectRgbEqual(compose(parsed)[0], f);
  });

  it('颜色超过 256 种时量化到 256 色，误差很小', () => {
    const w = 64, h = 64;
    // 4096 种不同颜色的渐变
    const f = frame(w, h, (x, y) => [x * 4, y * 4, ((x + y) * 2) & 255]);
    const gif = encodeGif([{ rgba: f, delayMs: 100 }], { width: w, height: h });
    const parsed = parseGif(gif);
    expect(parsed.frames[0].palette.length).toBeLessThanOrEqual(256 * 3);
    const out = compose(parsed)[0];
    let err = 0;
    for (let i = 0; i < f.length; i += 4) err += Math.abs(out[i] - f[i]) + Math.abs(out[i + 1] - f[i + 1]) + Math.abs(out[i + 2] - f[i + 2]);
    expect(err / (w * h * 3)).toBeLessThan(8);
  });

  it('停留时间：最短 2 个百分秒，并按 10ms 取整', () => {
    const w = 2, h = 2;
    const a = frame(w, h, () => [1, 2, 3]);
    const b = frame(w, h, () => [4, 5, 6]);
    const gif = encodeGif([{ rgba: a, delayMs: 5 }, { rgba: b, delayMs: 666 }], { width: w, height: h });
    expect(parseGif(gif).frames.map((f) => f.delayCs)).toEqual([2, 67]);
  });

  it('流式接口：逐帧加入后 finish，帧数正确；quantize 与 hasTransparentPixels 行为', () => {
    const enc = new GifEncoder({ width: 4, height: 4, transparent: true, loop: 3 });
    enc.addFrame(frame(4, 4, () => [9, 9, 9]), 100);
    enc.addFrame(frame(4, 4, (x) => (x === 0 ? [0, 0, 0, 0] : [9, 9, 9])), 100);
    expect(enc.frameCount).toBe(2);
    const parsed = parseGif(enc.finish());
    expect(parsed.loop).toBe(3);
    expect(parsed.frames).toHaveLength(2);

    const q = quantize(new Uint8Array([255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 255, 10]), 3, true);
    expect(q.count).toBe(1);
    expect(Array.from(q.indices)).toEqual([0, 0, 1]);
    expect(hasTransparentPixels(new Uint8Array([0, 0, 0, 255]))).toBe(false);
    expect(hasTransparentPixels(new Uint8Array([0, 0, 0, 255, 0, 0, 0, 3]))).toBe(true);
    expect(() => enc.addFrame(new Uint8Array(3), 1)).toThrow();
  });
});
