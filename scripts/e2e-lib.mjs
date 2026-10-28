// 端到端测试共用的小工具：断言计数、Chrome DevTools 协议客户端、找窗口、伪造一个“发布目录”
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 失败计数（check 会累加；测试脚本最后据此决定退出码） */
export const results = { failures: 0 };

export function check(name, ok, detail = '') {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) results.failures++;
}

export function assertEq(name, actual, expected) {
  check(name, actual === expected, `实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`);
}

export async function waitForFile(p, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (existsSync(p)) return true;
    await sleep(100);
  }
  return existsSync(p);
}

/** 轮询直到 fn 返回真值 */
export async function waitUntil(fn, timeoutMs, label) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待超时：${label}`);
    await sleep(200);
  }
}

// ---------------------------------------------------------------- CDP 客户端

export class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
    // 连接断开（比如 Browser.close 之后）时，让所有等待中的请求结束，不要挂死
    ws.addEventListener('close', () => {
      for (const { reject } of this.pending.values()) reject(new Error('调试连接已关闭'));
      this.pending.clear();
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('无法连接调试端口')), { once: true });
    });
    return new Cdp(ws);
  }
  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  /** 在页面里执行代码；expression 可以是返回 Promise 的表达式 */
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    }
    return r.result.value;
  }
  async waitFor(expression, timeoutMs = 15000, label = expression) {
    const t0 = Date.now();
    for (;;) {
      let v;
      try {
        v = await this.eval(expression);
      } catch {
        v = undefined;
      }
      if (v) return v;
      if (Date.now() - t0 > timeoutMs) throw new Error(`等待超时：${label}`);
      await sleep(150);
    }
  }
  close() {
    this.ws.close();
  }
}

/** 找到主窗口（无 hash）或浮窗（#float）的页面 */
export async function findPage(role = 'main', port = 9333, timeoutMs = 30000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      const page = list.find(
        (t) => t.type === 'page' && t.url.startsWith('app://') && (role === 'float') === t.url.endsWith('#float'),
      );
      if (page) return page;
    } catch {
      /* 还没起来 */
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`Electron ${role === 'float' ? '浮窗' : '主窗口'} ${Math.round(timeoutMs / 1000)} 秒内没有出现`);
    await sleep(250);
  }
}

// ---------------------------------------------------------------- 伪造发布目录（内置更新测试）

export function sha512Base64(file) {
  return createHash('sha512').update(readFileSync(file)).digest('base64');
}

export function sha256Hex(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/**
 * 在 dir 下按 electron-updater 的格式写 latest.yml（指向 installer 这个文件）。
 * 返回 { name, size, sha512, sha256 }
 */
export function writeLatestYml(dir, version, installer, overrides = {}) {
  mkdirSync(dir, { recursive: true });
  const name = path.basename(installer);
  const size = statSync(installer).size;
  const sha512 = overrides.sha512 ?? sha512Base64(installer);
  const yml = [
    `version: ${version}`,
    'files:',
    `  - url: ${name}`,
    `    sha512: ${sha512}`,
    `    size: ${size}`,
    `path: ${name}`,
    `sha512: ${sha512}`,
    `releaseDate: '${new Date().toISOString()}'`,
    '',
  ].join('\n');
  writeFileSync(path.join(dir, 'latest.yml'), yml);
  return { name, size, sha512, sha256: sha256Hex(installer) };
}

/** 生成一个指定大小的伪安装包（随机内容，不是真的可执行文件） */
export function writeFakeInstaller(file, bytes) {
  mkdirSync(path.dirname(file), { recursive: true });
  const buf = Buffer.alloc(bytes);
  // 内容可重复但不全零：按块填充伪随机数
  let seed = 0x9e3779b9 ^ bytes;
  for (let i = 0; i < bytes; i += 4) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    buf.writeUInt32LE(seed, i > bytes - 4 ? bytes - 4 : i);
  }
  writeFileSync(file, buf);
  return file;
}
