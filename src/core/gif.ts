/**
 * GIF 编码器（纯 TypeScript，不依赖浏览器 API）。
 * “表情制作”给动图逐帧加完文字后，用它把帧重新编成 GIF，动画才不会丢。
 *
 * - 每帧单独量化：颜色不超过 256 种就原样建调色板，超过则中位切分到 256 色
 * - 透明模式（有 alpha < 128 的像素）：留一个透明索引，每帧全量写入，处理方式“恢复背景”
 * - 不透明模式：只写和上一帧有差异的矩形区域，处理方式“保留”，文件小很多
 * - 连续相同的帧合并成一帧，只累加停留时间
 */

export interface GifOptions {
  width: number;
  height: number;
  /** 循环次数，0 = 一直循环（默认） */
  loop?: number;
  /**
   * 是否按透明模式编码。GIF 的透明是 1 位的，而且处理方式要提前定下来，
   * 所以调用方需要先看一遍所有帧有没有透明像素（encodeGif 会自己判断）。
   */
  transparent: boolean;
}

export interface GifFrameInput {
  /** RGBA 像素，长度 = 宽 × 高 × 4 */
  rgba: Uint8Array | Uint8ClampedArray;
  /** 这一帧停留的毫秒数 */
  delayMs: number;
}

interface EncodedFrame {
  x: number;
  y: number;
  w: number;
  h: number;
  delayCs: number;
  disposal: 1 | 2;
  /** 透明索引，-1 表示没有 */
  transparent: number;
  /** 局部调色板（rgb 三元组，已补齐到 2 的幂） */
  palette: Uint8Array;
  bits: number;
  minCodeSize: number;
  /** LZW 压缩后的字节（还没切成子块） */
  data: Uint8Array;
}

const MAX_CODES = 4096;
const MAX_DELAY_CS = 65535;
const MIN_DELAY_CS = 2;

// ---------------------------------------------------------------- 量化

interface ColorEntry {
  key: number;
  n: number;
  r: number;
  g: number;
  b: number;
}

interface Quantized {
  indices: Uint8Array;
  /** rgb 三元组，长度 = count × 3 */
  palette: Uint8Array;
  count: number;
}

/** 颜色太多时先把每通道降到 5 位，直方图才不会爆炸 */
const COARSE_THRESHOLD = 4096;

function exactKey(r: number, g: number, b: number): number {
  return (r << 16) | (g << 8) | b;
}

function coarseKey(r: number, g: number, b: number): number {
  return ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
}

/** 中位切分：把颜色分成不超过 maxColors 组，返回每个颜色所属的组号 */
function medianCut(entries: ColorEntry[], maxColors: number): number[] {
  const boxes: number[][] = [entries.map((_, i) => i)];
  const range = (box: number[]) => {
    let rMin = 255, rMax = 0, gMin = 255, gMax = 0, bMin = 255, bMax = 0;
    for (const i of box) {
      const e = entries[i];
      if (e.r < rMin) rMin = e.r;
      if (e.r > rMax) rMax = e.r;
      if (e.g < gMin) gMin = e.g;
      if (e.g > gMax) gMax = e.g;
      if (e.b < bMin) bMin = e.b;
      if (e.b > bMax) bMax = e.b;
    }
    const dr = rMax - rMin, dg = gMax - gMin, db = bMax - bMin;
    const max = Math.max(dr, dg, db);
    return { max, channel: max === dr ? 'r' : max === dg ? 'g' : 'b' } as const;
  };
  while (boxes.length < maxColors) {
    // 选颜色跨度最大的组来切（跨度相同时选像素多的）
    let pick = -1;
    let pickRange = 0;
    let pickCount = 0;
    let pickChannel: 'r' | 'g' | 'b' = 'r';
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].length < 2) continue;
      const { max, channel } = range(boxes[i]);
      if (max === 0) continue;
      let count = 0;
      for (const j of boxes[i]) count += entries[j].n;
      if (max > pickRange || (max === pickRange && count > pickCount)) {
        pick = i;
        pickRange = max;
        pickCount = count;
        pickChannel = channel;
      }
    }
    if (pick < 0) break;
    const box = boxes[pick];
    box.sort((a, b) => entries[a][pickChannel] - entries[b][pickChannel]);
    // 按像素数取中位
    let acc = 0;
    let cut = 1;
    for (let i = 0; i < box.length; i++) {
      acc += entries[box[i]].n;
      if (acc * 2 >= pickCount) {
        cut = Math.min(Math.max(1, i + 1), box.length - 1);
        break;
      }
    }
    boxes.splice(pick, 1, box.slice(0, cut), box.slice(cut));
  }
  const group = new Array<number>(entries.length);
  boxes.forEach((box, bi) => {
    for (const i of box) group[i] = bi;
  });
  return group;
}

/**
 * 把一块 RGBA 像素量化成索引图 + 调色板。
 * transparent 为 true 时 alpha < 128 的像素用索引 count（调色板之后的那一格）表示。
 */
export function quantize(rgba: ArrayLike<number>, pixelCount: number, transparent: boolean): Quantized {
  const maxColors = transparent ? 255 : 256;
  let keyOf = exactKey;
  let hist = new Map<number, ColorEntry>();
  const collect = () => {
    hist = new Map();
    for (let p = 0, i = 0; p < pixelCount; p++, i += 4) {
      if (transparent && rgba[i + 3] < 128) continue;
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
      const key = keyOf(r, g, b);
      const e = hist.get(key);
      if (e) {
        e.n++;
        e.r += r;
        e.g += g;
        e.b += b;
      } else hist.set(key, { key, n: 1, r, g, b });
    }
  };
  collect();
  if (hist.size > COARSE_THRESHOLD) {
    keyOf = coarseKey;
    collect();
  }
  const entries = Array.from(hist.values());
  // 累加值换成平均色（精确模式下每项只有一种颜色，平均色就是它自己）
  for (const e of entries) {
    e.r = Math.round(e.r / e.n);
    e.g = Math.round(e.g / e.n);
    e.b = Math.round(e.b / e.n);
  }

  let indexOfKey: Map<number, number>;
  let palette: Uint8Array;
  let count: number;
  if (entries.length <= maxColors) {
    count = Math.max(1, entries.length);
    palette = new Uint8Array(count * 3);
    indexOfKey = new Map();
    entries.forEach((e, i) => {
      indexOfKey.set(e.key, i);
      palette[i * 3] = e.r;
      palette[i * 3 + 1] = e.g;
      palette[i * 3 + 2] = e.b;
    });
  } else {
    const group = medianCut(entries, maxColors);
    count = Math.max(...group) + 1;
    const sums = new Float64Array(count * 4);
    indexOfKey = new Map();
    entries.forEach((e, i) => {
      const gi = group[i];
      indexOfKey.set(e.key, gi);
      sums[gi * 4] += e.r * e.n;
      sums[gi * 4 + 1] += e.g * e.n;
      sums[gi * 4 + 2] += e.b * e.n;
      sums[gi * 4 + 3] += e.n;
    });
    palette = new Uint8Array(count * 3);
    for (let gi = 0; gi < count; gi++) {
      const n = sums[gi * 4 + 3] || 1;
      palette[gi * 3] = Math.round(sums[gi * 4] / n);
      palette[gi * 3 + 1] = Math.round(sums[gi * 4 + 1] / n);
      palette[gi * 3 + 2] = Math.round(sums[gi * 4 + 2] / n);
    }
  }

  const indices = new Uint8Array(pixelCount);
  const transparentIndex = count;
  for (let p = 0, i = 0; p < pixelCount; p++, i += 4) {
    if (transparent && rgba[i + 3] < 128) {
      indices[p] = transparentIndex;
      continue;
    }
    indices[p] = indexOfKey.get(keyOf(rgba[i], rgba[i + 1], rgba[i + 2])) ?? 0;
  }
  return { indices, palette, count };
}

// ---------------------------------------------------------------- LZW

/** 字典用一张直接寻址表（前缀码 << 8 | 像素），用“代”号区分新旧，清空字典时不用真的清表 */
class LzwTable {
  readonly tab = new Uint32Array(1 << 20);
  gen = 0;
  nextGen(): number {
    if (this.gen >= (1 << 19) - 1) {
      this.tab.fill(0);
      this.gen = 0;
    }
    return ++this.gen;
  }
}

function lzwEncode(indices: Uint8Array, minCodeSize: number, table: LzwTable): Uint8Array {
  const clearCode = 1 << minCodeSize;
  const eoi = clearCode + 1;
  let out = new Uint8Array(Math.max(256, indices.length >> 1));
  let outLen = 0;
  let bitBuf = 0;
  let bitCount = 0;
  let codeSize = minCodeSize + 1;
  let next = eoi + 1;
  const tab = table.tab;
  let gen = table.nextGen();
  const emit = (code: number) => {
    bitBuf |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      if (outLen === out.length) {
        const bigger = new Uint8Array(out.length * 2);
        bigger.set(out);
        out = bigger;
      }
      out[outLen++] = bitBuf & 0xff;
      bitBuf >>>= 8;
      bitCount -= 8;
    }
  };
  emit(clearCode);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const px = indices[i];
    const k = (prefix << 8) | px;
    const v = tab[k];
    if (v >>> 13 === gen) {
      prefix = v & 0x1fff;
      continue;
    }
    emit(prefix);
    if (next < MAX_CODES) {
      tab[k] = (gen << 13) | next;
      next++;
      // 刚加进去的码正好等于当前位宽能表示的上限时，下一个码起加一位（和解码器同步）
      if (next - 1 === 1 << codeSize && codeSize < 12) codeSize++;
    } else {
      emit(clearCode);
      gen = table.nextGen();
      next = eoi + 1;
      codeSize = minCodeSize + 1;
    }
    prefix = px;
  }
  emit(prefix);
  emit(eoi);
  if (bitCount > 0) {
    if (outLen === out.length) {
      const bigger = new Uint8Array(out.length + 1);
      bigger.set(out);
      out = bigger;
    }
    out[outLen++] = bitBuf & 0xff;
  }
  return out.subarray(0, outLen);
}

// ---------------------------------------------------------------- 编码器

function clampDelay(delayMs: number): number {
  const cs = Math.round((Number.isFinite(delayMs) ? delayMs : 100) / 10);
  return Math.min(MAX_DELAY_CS, Math.max(MIN_DELAY_CS, cs));
}

/** 和上一帧不同的像素所在的最小矩形；完全一样返回 null */
function diffBox(prev: Uint8Array, cur: ArrayLike<number>, width: number, height: number, compareAlpha: boolean) {
  let x1 = width, y1 = height, x2 = -1, y2 = -1;
  for (let y = 0; y < height; y++) {
    let i = y * width * 4;
    for (let x = 0; x < width; x++, i += 4) {
      if (prev[i] !== cur[i] || prev[i + 1] !== cur[i + 1] || prev[i + 2] !== cur[i + 2] || (compareAlpha && prev[i + 3] !== cur[i + 3])) {
        if (x < x1) x1 = x;
        if (x > x2) x2 = x;
        if (y < y1) y1 = y;
        if (y > y2) y2 = y;
      }
    }
  }
  if (x2 < 0) return null;
  return { x: x1, y: y1, w: x2 - x1 + 1, h: y2 - y1 + 1 };
}

function bitsFor(colors: number): number {
  let bits = 2;
  while (1 << bits < colors) bits++;
  return bits;
}

export class GifEncoder {
  private readonly width: number;
  private readonly height: number;
  private readonly loop: number;
  private readonly transparent: boolean;
  private readonly frames: EncodedFrame[] = [];
  private prev: Uint8Array | null = null;
  private readonly table = new LzwTable();

  constructor(opts: GifOptions) {
    if (!(opts.width > 0 && opts.height > 0 && opts.width <= 65535 && opts.height <= 65535)) throw new Error('GIF 尺寸无效');
    this.width = opts.width;
    this.height = opts.height;
    this.loop = opts.loop ?? 0;
    this.transparent = opts.transparent;
  }

  get frameCount(): number {
    return this.frames.length;
  }

  addFrame(rgba: Uint8Array | Uint8ClampedArray, delayMs: number): void {
    const W = this.width;
    const H = this.height;
    if (rgba.length !== W * H * 4) throw new Error('帧的像素数据长度不对');
    const delayCs = clampDelay(delayMs);
    let x = 0, y = 0, w = W, h = H;
    if (this.prev) {
      const box = diffBox(this.prev, rgba, W, H, this.transparent);
      if (!box) {
        // 和上一帧一模一样：只延长上一帧的停留时间
        const last = this.frames[this.frames.length - 1];
        last.delayCs = Math.min(MAX_DELAY_CS, last.delayCs + delayCs);
        return;
      }
      if (!this.transparent) ({ x, y, w, h } = box);
    }
    let region: Uint8Array | Uint8ClampedArray = rgba;
    if (w !== W || h !== H) {
      region = new Uint8Array(w * h * 4);
      for (let row = 0; row < h; row++) {
        const src = ((y + row) * W + x) * 4;
        region.set((rgba as Uint8Array).subarray(src, src + w * 4), row * w * 4);
      }
    }
    const q = quantize(region, w * h, this.transparent);
    const total = q.count + (this.transparent ? 1 : 0);
    const bits = bitsFor(total);
    const palette = new Uint8Array((1 << bits) * 3);
    palette.set(q.palette);
    const minCodeSize = bits;
    this.frames.push({
      x,
      y,
      w,
      h,
      delayCs,
      disposal: this.transparent ? 2 : 1,
      transparent: this.transparent ? q.count : -1,
      palette,
      bits,
      minCodeSize,
      data: lzwEncode(q.indices, minCodeSize, this.table),
    });
    this.prev = rgba instanceof Uint8Array ? rgba.slice() : new Uint8Array(rgba);
  }

  finish(): Uint8Array {
    if (this.frames.length === 0) throw new Error('没有帧');
    const first = this.frames[0];
    let size = 6 + 7 + first.palette.length + 19 + 1;
    for (const f of this.frames) {
      size += 8 + 10 + f.palette.length + 1 + f.data.length + Math.ceil(f.data.length / 255) + 1;
    }
    const out = new Uint8Array(size);
    let p = 0;
    const u8 = (v: number) => {
      out[p++] = v & 0xff;
    };
    const u16 = (v: number) => {
      out[p++] = v & 0xff;
      out[p++] = (v >> 8) & 0xff;
    };
    const ascii = (s: string) => {
      for (let i = 0; i < s.length; i++) out[p++] = s.charCodeAt(i);
    };
    ascii('GIF89a');
    u16(this.width);
    u16(this.height);
    // 全局调色板用第一帧的（有些老解码器要求必须有），每帧仍带自己的局部调色板
    u8(0x80 | (7 << 4) | (first.bits - 1));
    u8(0);
    u8(0);
    out.set(first.palette, p);
    p += first.palette.length;
    // 循环播放
    u8(0x21);
    u8(0xff);
    u8(11);
    ascii('NETSCAPE2.0');
    u8(3);
    u8(1);
    u16(this.loop);
    u8(0);
    for (const f of this.frames) {
      u8(0x21);
      u8(0xf9);
      u8(4);
      u8((f.disposal << 2) | (f.transparent >= 0 ? 1 : 0));
      u16(f.delayCs);
      u8(f.transparent >= 0 ? f.transparent : 0);
      u8(0);
      u8(0x2c);
      u16(f.x);
      u16(f.y);
      u16(f.w);
      u16(f.h);
      u8(0x80 | (f.bits - 1));
      out.set(f.palette, p);
      p += f.palette.length;
      u8(f.minCodeSize);
      for (let i = 0; i < f.data.length; i += 255) {
        const n = Math.min(255, f.data.length - i);
        u8(n);
        out.set(f.data.subarray(i, i + n), p);
        p += n;
      }
      u8(0);
    }
    u8(0x3b);
    return p === size ? out : out.subarray(0, p);
  }
}

/** 一次把所有帧编成 GIF（帧都在内存里时用；会自己判断要不要透明模式） */
export function encodeGif(frames: GifFrameInput[], opts: Omit<GifOptions, 'transparent'> & { transparent?: boolean }): Uint8Array {
  if (frames.length === 0) throw new Error('没有帧');
  const transparent = opts.transparent ?? frames.some((f) => hasTransparentPixels(f.rgba));
  const enc = new GifEncoder({ ...opts, transparent });
  for (const f of frames) enc.addFrame(f.rgba, f.delayMs);
  return enc.finish();
}

/** 有没有需要按透明处理的像素（alpha < 128） */
export function hasTransparentPixels(rgba: ArrayLike<number>): boolean {
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] < 128) return true;
  return false;
}
