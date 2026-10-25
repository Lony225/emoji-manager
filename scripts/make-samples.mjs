// 生成示例表情（PNG / GIF）、示例订阅清单和应用图标。
// 不依赖任何第三方库：自己写 PNG 编码（zlib）和 GIF 编码（LZW）。
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'examples', 'subscription');
const IMG = path.join(OUT, 'images');
mkdirSync(IMG, { recursive: true });
mkdirSync(path.join(ROOT, 'build'), { recursive: true });

// ---------------------------------------------------------------- 画布

class Canvas {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.data = new Uint8Array(w * h * 4);
  }
  set(x, y, [r, g, b, a = 255]) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 4;
    const sa = a / 255;
    this.data[i] = Math.round(r * sa + this.data[i] * (1 - sa));
    this.data[i + 1] = Math.round(g * sa + this.data[i + 1] * (1 - sa));
    this.data[i + 2] = Math.round(b * sa + this.data[i + 2] * (1 - sa));
    this.data[i + 3] = Math.max(this.data[i + 3], a);
  }
  /** 填充一个形状：sdf(x,y) < 0 表示在形状内，边缘做 1px 抗锯齿 */
  fill(sdf, color) {
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const d = sdf(x + 0.5, y + 0.5);
        if (d < 0.5) {
          const cov = Math.min(1, 0.5 - d);
          this.set(x, y, [color[0], color[1], color[2], Math.round((color[3] ?? 255) * cov)]);
        }
      }
    }
  }
}

const circle = (cx, cy, r) => (x, y) => Math.hypot(x - cx, y - cy) - r;
const ellipse = (cx, cy, rx, ry) => (x, y) => (Math.hypot((x - cx) / rx, (y - cy) / ry) - 1) * Math.min(rx, ry);
const roundRect = (cx, cy, hw, hh, r) => (x, y) => {
  const qx = Math.abs(x - cx) - hw + r;
  const qy = Math.abs(y - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};
/** 弧线（嘴巴、闭眼）：圆环的一段，角度按 [0, 2π) 归一化 */
const TAU = Math.PI * 2;
const norm = (a) => ((a % TAU) + TAU) % TAU;
const arc = (cx, cy, r, thick, from, to) => {
  const f = norm(from);
  const t = norm(to);
  return (x, y) => {
    const ang = norm(Math.atan2(y - cy, x - cx));
    const inRange = f <= t ? ang >= f && ang <= t : ang >= f || ang <= t;
    const ring = Math.abs(Math.hypot(x - cx, y - cy) - r) - thick / 2;
    if (inRange) return ring;
    // 端点处补圆头
    const e1 = Math.hypot(x - (cx + r * Math.cos(f)), y - (cy + r * Math.sin(f))) - thick / 2;
    const e2 = Math.hypot(x - (cx + r * Math.cos(t)), y - (cy + r * Math.sin(t))) - thick / 2;
    return Math.min(e1, e2);
  };
};

// ---------------------------------------------------------------- PNG 编码

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}

function encodePng(canvas) {
  const { w, h, data } = canvas;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(data.buffer, y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- GIF 编码（调色板 + LZW）

function quantize(frames) {
  // 把所有帧的颜色收集进调色板（示例图颜色很少，最多 255 色 + 透明）
  const palette = [[0, 0, 0]];
  const index = new Map(['0,0,0', 0].slice(0, 0));
  const lookup = (r, g, b) => {
    const k = `${r},${g},${b}`;
    let i = index.get(k);
    if (i === undefined) {
      if (palette.length >= 256) {
        // 找最接近的
        let best = 1;
        let bd = Infinity;
        for (let j = 1; j < palette.length; j++) {
          const [pr, pg, pb] = palette[j];
          const d = (pr - r) ** 2 + (pg - g) ** 2 + (pb - b) ** 2;
          if (d < bd) {
            bd = d;
            best = j;
          }
        }
        return best;
      }
      i = palette.length;
      palette.push([r, g, b]);
      index.set(k, i);
    }
    return i;
  };
  const indexed = frames.map((c) => {
    const out = new Uint8Array(c.w * c.h);
    for (let p = 0; p < c.w * c.h; p++) {
      const a = c.data[p * 4 + 3];
      if (a < 128) {
        out[p] = 0; // 透明色索引 0
        continue;
      }
      // 量化到 4 位/通道，减少颜色数
      const q = (v) => Math.round(v / 17) * 17;
      out[p] = lookup(q(c.data[p * 4]), q(c.data[p * 4 + 1]), q(c.data[p * 4 + 2]));
    }
    return out;
  });
  return { palette, indexed };
}

function lzwEncode(pixels, minCodeSize) {
  const clearCode = 1 << minCodeSize;
  const eoi = clearCode + 1;
  const out = [];
  let bitBuf = 0;
  let bitCount = 0;
  let codeSize = minCodeSize + 1;
  const emit = (code) => {
    bitBuf |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      out.push(bitBuf & 0xff);
      bitBuf >>>= 8;
      bitCount -= 8;
    }
  };
  let dict = new Map();
  let next = eoi + 1;
  const reset = () => {
    dict = new Map();
    next = eoi + 1;
    codeSize = minCodeSize + 1;
  };
  emit(clearCode);
  let prefix = pixels[0];
  for (let i = 1; i < pixels.length; i++) {
    const k = prefix * 4096 + pixels[i];
    const found = dict.get(k);
    if (found !== undefined) {
      prefix = found;
      continue;
    }
    emit(prefix);
    if (next < 4096) {
      dict.set(k, next++);
      if (next - 1 === 1 << codeSize && codeSize < 12) codeSize++;
    } else {
      emit(clearCode);
      reset();
    }
    prefix = pixels[i];
  }
  emit(prefix);
  emit(eoi);
  if (bitCount > 0) out.push(bitBuf & 0xff);
  return Buffer.from(out);
}

function encodeGif(frames, delayCs) {
  const { w, h } = frames[0];
  const { palette, indexed } = quantize(frames);
  const bits = Math.max(1, Math.ceil(Math.log2(palette.length)));
  const tableSize = 1 << bits;
  const parts = [Buffer.from('GIF89a', 'ascii')];
  const lsd = Buffer.alloc(7);
  lsd.writeUInt16LE(w, 0);
  lsd.writeUInt16LE(h, 2);
  lsd[4] = 0x80 | ((bits - 1) << 4) | (bits - 1);
  parts.push(lsd);
  const table = Buffer.alloc(tableSize * 3);
  palette.forEach(([r, g, b], i) => {
    table[i * 3] = r;
    table[i * 3 + 1] = g;
    table[i * 3 + 2] = b;
  });
  parts.push(table);
  // 循环播放
  parts.push(Buffer.from([0x21, 0xff, 0x0b, ...Buffer.from('NETSCAPE2.0', 'ascii'), 0x03, 0x01, 0x00, 0x00, 0x00]));
  const minCodeSize = Math.max(2, bits);
  for (const px of indexed) {
    const gce = Buffer.from([0x21, 0xf9, 0x04, 0x09, delayCs & 0xff, delayCs >> 8, 0x00, 0x00]); // disposal=2, 透明索引 0
    parts.push(gce);
    const desc = Buffer.alloc(10);
    desc[0] = 0x2c;
    desc.writeUInt16LE(w, 5);
    desc.writeUInt16LE(h, 7);
    parts.push(desc);
    parts.push(Buffer.from([minCodeSize]));
    const data = lzwEncode(px, minCodeSize);
    for (let i = 0; i < data.length; i += 255) {
      const sub = data.subarray(i, i + 255);
      parts.push(Buffer.from([sub.length]), sub);
    }
    parts.push(Buffer.from([0]));
  }
  parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- 画表情

const INK = [40, 36, 30];
const WHITE = [255, 255, 255];
const BLUSH = [255, 140, 140, 120];

/** 画一张脸：mood 决定嘴和眼，t 是动画相位 0..1 */
function face(size, color, mood, t = 0) {
  const c = new Canvas(size, size);
  const cx = size / 2;
  const bounce = Math.sin(t * Math.PI * 2) * size * 0.03;
  const cy = size / 2 + bounce;
  const r = size * 0.42;
  c.fill(circle(cx, cy, r), color);
  const eyeY = cy - r * 0.2;
  const eyeDx = r * 0.38;
  const blink = mood === 'wink' || (t > 0.4 && t < 0.6 && mood === 'happy');
  const eye = (ex, closed) => {
    if (closed) c.fill(arc(ex, eyeY + r * 0.05, r * 0.14, size * 0.035, Math.PI * 1.15, Math.PI * 1.85), INK);
    else {
      c.fill(ellipse(ex, eyeY, r * 0.13, r * 0.17), INK);
      c.fill(circle(ex + r * 0.04, eyeY - r * 0.06, r * 0.045), WHITE);
    }
  };
  eye(cx - eyeDx, mood === 'sleepy' || blink);
  eye(cx + eyeDx, mood === 'sleepy' || (blink && mood !== 'wink'));
  if (mood === 'wink') {
    c.fill(arc(cx + eyeDx, eyeY, r * 0.14, size * 0.035, Math.PI * 1.15, Math.PI * 1.85), INK);
  }
  const mouthY = cy + r * 0.3;
  switch (mood) {
    case 'happy':
    case 'wink':
      c.fill(arc(cx, mouthY - r * 0.1, r * 0.32, size * 0.04, Math.PI * 0.15, Math.PI * 0.85), INK);
      c.fill(circle(cx - eyeDx - r * 0.1, cy + r * 0.12, r * 0.12), BLUSH);
      c.fill(circle(cx + eyeDx + r * 0.1, cy + r * 0.12, r * 0.12), BLUSH);
      break;
    case 'sad':
      c.fill(arc(cx, mouthY + r * 0.3, r * 0.3, size * 0.04, Math.PI * 1.2, Math.PI * 1.8), INK);
      c.fill(ellipse(cx - eyeDx, eyeY + r * 0.35 + t * r * 0.3, r * 0.06, r * 0.1), [120, 180, 255]);
      break;
    case 'surprised':
      c.fill(ellipse(cx, mouthY + r * 0.05, r * 0.14, r * 0.2 + t * r * 0.05), INK);
      break;
    case 'angry':
      c.fill(arc(cx, mouthY + r * 0.25, r * 0.28, size * 0.04, Math.PI * 1.2, Math.PI * 1.8), INK);
      c.fill(roundRect(cx - eyeDx, eyeY - r * 0.3, r * 0.2, size * 0.02, size * 0.01), INK);
      c.fill(roundRect(cx + eyeDx, eyeY - r * 0.3, r * 0.2, size * 0.02, size * 0.01), INK);
      break;
    case 'sleepy':
      c.fill(roundRect(cx, mouthY, r * 0.12, size * 0.02, size * 0.01), INK);
      break;
    case 'love':
      c.fill(arc(cx, mouthY - r * 0.1, r * 0.3, size * 0.04, Math.PI * 0.15, Math.PI * 0.85), INK);
      for (const sx of [cx - eyeDx, cx + eyeDx]) {
        c.fill(circle(sx - r * 0.07, eyeY - r * 0.05, r * 0.09), [230, 60, 90]);
        c.fill(circle(sx + r * 0.07, eyeY - r * 0.05, r * 0.09), [230, 60, 90]);
        // 爱心下半部分：倒三角（底边在两个圆的中心高度，尖端在下）
        const baseY = eyeY - r * 0.05;
        const tipY = eyeY + r * 0.14;
        const hw = r * 0.16;
        c.fill(
          (x, y) => Math.max(baseY - y, y - tipY, Math.abs(x - sx) - (hw * (tipY - y)) / (tipY - baseY)),
          [230, 60, 90],
        );
      }
      break;
    default:
      c.fill(roundRect(cx, mouthY, r * 0.25, size * 0.02, size * 0.01), INK);
  }
  return c;
}

const SIZE = 160;
const cats = [
  { file: 'cat-happy.png', name: '开心', mood: 'happy', color: [255, 196, 90], tags: ['开心', '笑'] },
  { file: 'cat-sad.gif', name: '哭哭', mood: 'sad', color: [255, 196, 90], tags: ['难过', '哭'], frames: 4 },
  { file: 'cat-surprised.png', name: '惊讶', mood: 'surprised', color: [255, 196, 90], tags: ['惊讶'] },
  { file: 'cat-angry.png', name: '生气', mood: 'angry', color: [255, 160, 90], tags: ['生气'] },
  { file: 'cat-sleepy.png', name: '困了', mood: 'sleepy', color: [255, 196, 90], tags: ['困', '晚安'] },
  { file: 'cat-love.gif', name: '喜欢你', mood: 'love', color: [255, 196, 90], tags: ['爱心', '喜欢'], frames: 3 },
  { file: 'cat-wink.png', name: '眨眼', mood: 'wink', color: [255, 196, 90], tags: ['调皮'] },
  { file: 'cat-neutral.png', name: '无语', mood: 'neutral', color: [255, 196, 90], tags: ['无语'] },
];
const dogs = [
  { file: 'dog-happy.gif', name: '汪汪开心', mood: 'happy', color: [150, 200, 255], tags: ['开心'], frames: 4 },
  { file: 'dog-sad.png', name: '汪汪委屈', mood: 'sad', color: [150, 200, 255], tags: ['难过'] },
  { file: 'dog-surprised.png', name: '汪？', mood: 'surprised', color: [150, 200, 255], tags: ['惊讶', '问号'] },
  { file: 'dog-love.png', name: '汪汪爱你', mood: 'love', color: [150, 200, 255], tags: ['爱心'] },
  { file: 'dog-sleepy.gif', name: '汪汪睡觉', mood: 'sleepy', color: [150, 200, 255], tags: ['晚安'], frames: 2 },
];

function render(item) {
  if (item.frames) {
    const frames = Array.from({ length: item.frames }, (_, i) => face(SIZE, item.color, item.mood, i / item.frames));
    return encodeGif(frames, 18);
  }
  return encodePng(face(SIZE, item.color, item.mood));
}

for (const item of [...cats, ...dogs]) {
  writeFileSync(path.join(IMG, item.file), render(item));
}

const toEntry = (item, idPrefix) => ({
  id: `${idPrefix}-${item.file.replace(/\.(png|gif)$/, '')}`,
  url: `images/${item.file}`,
  name: item.name,
  tags: item.tags,
});

// 单包清单
writeFileSync(
  path.join(OUT, 'pack.json'),
  JSON.stringify(
    {
      name: '示例：猫猫表情包',
      description: '由 scripts/make-samples.mjs 生成的示例表情，用于体验订阅功能。',
      version: '2026.10.22',
      homepage: 'https://github.com/example/emoji-packs',
      tags: ['猫'],
      stickers: cats.map((c) => toEntry(c, 'cat')),
    },
    null,
    2,
  ),
);

// 多包清单：一个内联包 + 一个引用包
writeFileSync(
  path.join(OUT, 'dogs.json'),
  JSON.stringify({ name: '狗狗', tags: ['狗'], stickers: dogs.map((d) => toEntry(d, 'dog')) }, null, 2),
);
writeFileSync(
  path.join(OUT, 'index.json'),
  JSON.stringify(
    {
      name: '示例：表情合集',
      description: '一个订阅里包含多个表情包，每个包会成为一个分类。',
      version: '2026.10.22',
      packs: [
        { key: 'cats', name: '猫猫', tags: ['猫'], stickers: cats.map((c) => toEntry(c, 'cat')) },
        { key: 'dogs', url: 'dogs.json' },
      ],
    },
    null,
    2,
  ),
);

// 模板表情（meme-generator）的测试素材：一份假的 resources.json 清单加几张图，端到端测试不用联网就能走完下载 → 生成
{
  const MEME = path.join(OUT, 'meme-resources');
  mkdirSync(path.join(MEME, 'fonts'), { recursive: true });
  mkdirSync(path.join(MEME, 'images', 'good_news'), { recursive: true });
  mkdirSync(path.join(MEME, 'images', 'petpet'), { recursive: true });
  const files = [];
  const put = (rel, bytes) => {
    writeFileSync(path.join(MEME, rel), bytes);
    files.push({ rel, hash: createHash('sha256').update(bytes).digest('hex') });
  };
  // 不是真字体，只用来验证下载和校验流程（引擎读不出来会跳过）
  put('fonts/sample.ttf', Buffer.from('not a real font, just something to download and verify'));
  // “喜报”的底图：600×400 的红底
  const news = new Canvas(600, 400);
  news.fill(() => -1, [220, 40, 40]);
  put('images/good_news/0.jpg', encodePng(news));
  // “摸头”的 5 帧手
  for (let i = 0; i < 5; i++) {
    const hand = new Canvas(112, 112);
    hand.fill(circle(56 + i * 3, 30 - i * 2, 22), [255, 220, 180]);
    put(`images/petpet/${i}.png`, encodePng(hand));
  }
  writeFileSync(
    path.join(MEME, 'resources.json'),
    JSON.stringify(
      {
        fonts: files.filter((f) => f.rel.startsWith('fonts/')).map((f) => ({ file: f.rel.slice('fonts/'.length), hash: f.hash })),
        images: files.filter((f) => f.rel.startsWith('images/')).map((f) => ({ file: f.rel.slice('images/'.length), hash: f.hash })),
      },
      null,
      2,
    ),
  );
}

// 应用图标：黄色圆角方块 + 笑脸
{
  const s = 512;
  const c = new Canvas(s, s);
  c.fill(roundRect(s / 2, s / 2, s * 0.46, s * 0.46, s * 0.22), [255, 210, 51]);
  const f = face(s, [255, 255, 255, 0], 'happy');
  // 把脸的线条叠上去（脸本身透明底）
  const inner = face(Math.round(s * 0.8), [255, 228, 120], 'wink');
  const off = Math.round(s * 0.1);
  for (let y = 0; y < inner.h; y++) {
    for (let x = 0; x < inner.w; x++) {
      const i = (y * inner.w + x) * 4;
      if (inner.data[i + 3] > 0) c.set(x + off, y + off, [inner.data[i], inner.data[i + 1], inner.data[i + 2], inner.data[i + 3]]);
    }
  }
  void f;
  writeFileSync(path.join(ROOT, 'build', 'icon.png'), encodePng(c));
}

// 托盘图标：小尺寸专用，线条更粗、没有外框，16 px 也能认出是个笑脸
function trayFace(size) {
  const c = new Canvas(size, size);
  const cx = size / 2;
  const cy = size / 2;
  const r = size * 0.47;
  c.fill(circle(cx, cy, r), [255, 196, 60]);
  const eyeR = Math.max(1.1, size * 0.085);
  c.fill(circle(cx - r * 0.42, cy - r * 0.22, eyeR), INK);
  c.fill(circle(cx + r * 0.42, cy - r * 0.22, eyeR), INK);
  c.fill(arc(cx, cy + r * 0.05, r * 0.5, Math.max(1.6, size * 0.11), Math.PI * 0.18, Math.PI * 0.82), INK);
  return c;
}
for (const s of [16, 20, 24, 32, 40, 48]) {
  writeFileSync(path.join(ROOT, 'build', `tray-${s}.png`), encodePng(trayFace(s)));
}

console.log(`已生成 ${cats.length + dogs.length} 个示例表情到 ${IMG}`);
console.log(`清单：${path.join(OUT, 'pack.json')}、${path.join(OUT, 'index.json')}`);
console.log(`图标：${path.join(ROOT, 'build', 'icon.png')}`);
