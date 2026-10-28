/**
 * 局域网同步的主进程部分：
 * - UDP 广播互相发现（每 3 秒广播一次本机信息；收到别人的广播就记为在线，并直接回一条让对方立刻看到自己）
 * - 内置 HTTP 服务：配对、同步请求转交给主窗口的页面处理；图片文件的上传 / 下载在这里直接读写资料目录
 * - 向其他设备发请求的客户端
 * 协议逻辑（差异比对、合并）都在页面里（src/core/lan），这里只负责网络和文件。
 */
import { BrowserWindow, ipcMain } from 'electron';
import crypto from 'node:crypto';
import dgram from 'node:dgram';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import type { LanConfig, LanDevice, LanIncoming, LanJsonResponse, LanTarget, OsKind } from '../src/platform/types';

const APP_TAG = 'emoji-manager';
const PROTO = 1;
const UDP_PORT = 28617;
/** HTTP 服务优先用这个端口（防火墙规则稳定），被占用就随机 */
const HTTP_PORT = 28618;
const HTTP_PATH = '/emoji-sync/v1';
const ANNOUNCE_MS = 3000;
const OFFLINE_MS = 12_000;
const MAX_JSON = 64 * 1024 * 1024;
const MAX_FILE = 100 * 1024 * 1024;
const FILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;

export interface LanHost {
  version: string;
  os: OsKind;
  /** 资料目录里的相对路径 → 绝对路径（会拦住越界路径） */
  resolve(rel: string): string;
  /** 处理请求的主窗口 */
  mainWindow(): BrowserWindow | null;
  broadcast(channel: string, payload?: unknown): void;
}

interface Announce {
  app: string;
  proto: number;
  id: string;
  name: string;
  os: OsKind;
  version: string;
  port: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 每个网卡所在网段的广播地址，再加上全局广播 */
function broadcastAddresses(): string[] {
  const out = new Set<string>(['255.255.255.255']);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const ip = a.address.split('.').map(Number);
      const mask = a.netmask.split('.').map(Number);
      if (ip.length !== 4 || mask.length !== 4) continue;
      out.add(ip.map((b, i) => (b & mask[i]) | (~mask[i] & 255)).join('.'));
    }
  }
  return [...out];
}

function validTarget(t: unknown): LanTarget {
  if (!isRecord(t) || typeof t.host !== 'string' || typeof t.port !== 'number') throw new Error('无效的设备地址');
  if (!/^[A-Za-z0-9.:[\]-]{1,255}$/.test(t.host) || !Number.isInteger(t.port) || t.port < 1 || t.port > 65535) throw new Error('无效的设备地址');
  return { host: t.host, port: t.port };
}

function readJson(req: http.IncomingMessage, max: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) {
        reject(new Error('请求太大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null);
      } catch {
        reject(new Error('不是有效的 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const data = Buffer.from(JSON.stringify(body ?? null), 'utf8');
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': data.length });
  res.end(data);
}

export class LanService {
  private config: LanConfig | null = null;
  private udp: dgram.Socket | null = null;
  private server: http.Server | null = null;
  private port = 0;
  private announceTimer: NodeJS.Timeout | null = null;
  private pruneTimer: NodeJS.Timeout | null = null;
  private readonly devices = new Map<string, LanDevice>();
  private readonly pending = new Map<string, { resolve: (r: LanJsonResponse) => void; timer: NodeJS.Timeout }>();
  private pairInFlight = false;

  constructor(private readonly host: LanHost) {
    ipcMain.on('lan:response', (_e, reqId: unknown, res: unknown) => {
      const p = typeof reqId === 'string' ? this.pending.get(reqId) : undefined;
      if (!p) return;
      this.pending.delete(reqId as string);
      clearTimeout(p.timer);
      const r = isRecord(res) && typeof res.status === 'number' ? { status: res.status, body: res.body } : { status: 500, body: { error: '页面没有正确回应' } };
      p.resolve(r);
    });
  }

  get running(): boolean {
    return this.server !== null;
  }

  async start(config: LanConfig): Promise<{ port: number }> {
    this.config = config;
    if (this.server) return { port: this.port };
    this.port = await this.listenHttp();
    await this.openUdp();
    this.announceTimer = setInterval(() => this.announce(), ANNOUNCE_MS);
    this.pruneTimer = setInterval(() => this.prune(), 2500);
    this.announce();
    return { port: this.port };
  }

  async stop(): Promise<void> {
    if (this.announceTimer) clearInterval(this.announceTimer);
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.announceTimer = null;
    this.pruneTimer = null;
    if (this.udp) {
      try {
        this.udp.close();
      } catch {
        /* 已关闭 */
      }
      this.udp = null;
    }
    if (this.server) {
      const s = this.server;
      this.server = null;
      await new Promise<void>((resolve) => s.close(() => resolve()));
      s.closeAllConnections?.();
    }
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve({ status: 503, body: { error: '服务已停止' } });
      this.pending.delete(id);
    }
    if (this.devices.size) {
      this.devices.clear();
      this.emitDevices();
    }
  }

  configure(config: LanConfig): void {
    const renamed = this.config?.name !== config.name;
    this.config = config;
    if (renamed && this.udp) this.announce();
  }

  // ---------------------------------------------------------------- 发现

  private async openUdp(): Promise<void> {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    await new Promise<void>((resolve, reject) => {
      sock.once('error', reject);
      sock.bind(UDP_PORT, '0.0.0.0', () => {
        sock.removeListener('error', reject);
        resolve();
      });
    });
    sock.on('error', (e) => console.warn('发现服务出错', e));
    sock.setBroadcast(true);
    sock.on('message', (msg, rinfo) => this.onAnnounce(msg, rinfo));
    this.udp = sock;
  }

  private payload(): Buffer {
    const a: Announce = {
      app: APP_TAG,
      proto: PROTO,
      id: this.config?.id ?? '',
      name: this.config?.name ?? '',
      os: this.host.os,
      version: this.host.version,
      port: this.port,
    };
    return Buffer.from(JSON.stringify(a), 'utf8');
  }

  private announce(): void {
    if (!this.udp || !this.config) return;
    const data = this.payload();
    for (const addr of broadcastAddresses()) {
      this.udp.send(data, UDP_PORT, addr, () => undefined);
    }
  }

  private onAnnounce(msg: Buffer, rinfo: dgram.RemoteInfo): void {
    let j: unknown;
    try {
      j = JSON.parse(msg.toString('utf8'));
    } catch {
      return;
    }
    if (!isRecord(j) || j.app !== APP_TAG || j.proto !== PROTO) return;
    if (typeof j.id !== 'string' || !j.id || j.id === this.config?.id || typeof j.port !== 'number') return;
    const prev = this.devices.get(j.id);
    const now = Date.now();
    // 多网卡的机器会从几个地址轮流广播：先记住的地址只要还新鲜就一直用，免得列表来回抖动
    const keepAddr = prev && prev.host !== rinfo.address && now - prev.lastSeen < ANNOUNCE_MS + 1500;
    const dev: LanDevice = {
      id: j.id,
      name: typeof j.name === 'string' && j.name ? j.name.slice(0, 60) : '设备',
      os: typeof j.os === 'string' ? (j.os as OsKind) : 'unknown',
      version: typeof j.version === 'string' ? j.version.slice(0, 40) : '',
      host: keepAddr ? prev.host : rinfo.address,
      port: keepAddr ? prev.port : j.port,
      lastSeen: now,
    };
    this.devices.set(dev.id, dev);
    const changed = !prev || prev.name !== dev.name || prev.host !== dev.host || prev.port !== dev.port;
    if (changed) this.emitDevices();
    // 新出现的设备：直接回一条，让它不用等下一轮广播就能看到我们
    if (!prev && this.udp) this.udp.send(this.payload(), rinfo.port, rinfo.address, () => undefined);
  }

  private prune(): void {
    const cutoff = Date.now() - OFFLINE_MS;
    let changed = false;
    for (const [id, d] of this.devices) {
      if (d.lastSeen < cutoff) {
        this.devices.delete(id);
        changed = true;
      }
    }
    if (changed) this.emitDevices();
  }

  private emitDevices(): void {
    this.host.broadcast('lan:devices', [...this.devices.values()]);
  }

  list(): LanDevice[] {
    return [...this.devices.values()];
  }

  // ---------------------------------------------------------------- HTTP 服务

  private listenHttp(): Promise<number> {
    const server = http.createServer((req, res) => {
      this.handle(req, res).catch((e) => {
        if (!res.headersSent) sendJson(res, 500, { error: errorMessage(e) });
        else res.destroy();
      });
    });
    server.keepAliveTimeout = 15_000;
    this.server = server;
    const tryListen = (port: number) =>
      new Promise<number>((resolve, reject) => {
        const onError = (e: NodeJS.ErrnoException) => {
          server.removeListener('listening', onListening);
          reject(e);
        };
        const onListening = () => {
          server.removeListener('error', onError);
          const addr = server.address();
          resolve(typeof addr === 'object' && addr ? addr.port : port);
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, '0.0.0.0');
      });
    return tryListen(HTTP_PORT).catch(() => tryListen(0));
  }

  private tokenOwner(req: http.IncomingMessage): string | undefined {
    const auth = req.headers.authorization ?? '';
    const m = /^Bearer\s+([A-Za-z0-9_-]{8,128})$/.exec(auth);
    if (!m || !this.config) return undefined;
    const hit = this.config.tokens.find((t) => t.token.length === m[1].length && crypto.timingSafeEqual(Buffer.from(t.token), Buffer.from(m[1])));
    return hit?.deviceId;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x');
    if (!url.pathname.startsWith(HTTP_PATH + '/')) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    const sub = url.pathname.slice(HTTP_PATH.length);
    const method = req.method ?? 'GET';

    if (sub === '/pair' && method === 'POST') {
      if (this.pairInFlight) {
        sendJson(res, 409, { error: '对方正在处理另一个配对请求' });
        return;
      }
      this.pairInFlight = true;
      try {
        const body = await readJson(req, 64 * 1024);
        const r = await this.dispatch({ kind: 'pair', body }, 100_000);
        sendJson(res, r.status, r.body);
      } finally {
        this.pairInFlight = false;
      }
      return;
    }

    const from = this.tokenOwner(req);
    if (!from) {
      sendJson(res, 401, { error: '未配对或配对已失效' });
      return;
    }

    if (sub === '/ping' && method === 'GET') {
      sendJson(res, 200, { id: this.config?.id, name: this.config?.name });
      return;
    }
    if ((sub === '/begin' || sub === '/apply' || sub === '/end' || sub === '/unpair') && method === 'POST') {
      const body = await readJson(req, MAX_JSON);
      const r = await this.dispatch({ kind: sub.slice(1) as LanIncoming['kind'], from, body }, sub === '/apply' ? 180_000 : 60_000);
      sendJson(res, r.status, r.body);
      return;
    }
    const file = /^\/file\/([^/]+)$/.exec(sub);
    if (file && (method === 'PUT' || method === 'GET')) {
      const name = decodeURIComponent(file[1]);
      if (!FILE_NAME_RE.test(name)) {
        sendJson(res, 400, { error: '无效的文件名' });
        return;
      }
      const abs = this.host.resolve(`stickers/${name}`);
      if (method === 'PUT') {
        await this.receiveFile(req, abs);
        sendJson(res, 200, { ok: true });
      } else {
        await this.sendFile(res, abs);
      }
      return;
    }
    sendJson(res, 404, { error: 'not found' });
  }

  /** 把请求交给主窗口页面处理 */
  private dispatch(incoming: LanIncoming, timeoutMs: number): Promise<LanJsonResponse> {
    const win = this.host.mainWindow();
    if (!win || win.isDestroyed() || win.webContents.isLoadingMainFrame()) {
      return Promise.resolve({ status: 503, body: { error: '对方的应用没有打开主窗口' } });
    }
    const reqId = crypto.randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        resolve({ status: 504, body: { error: '对方没有在限定时间内回应' } });
      }, timeoutMs);
      this.pending.set(reqId, { resolve, timer });
      win.webContents.send('lan:request', reqId, incoming);
    });
  }

  private async receiveFile(req: http.IncomingMessage, abs: string): Promise<void> {
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > MAX_FILE) throw new Error('文件超过 100 MB');
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    const tmp = `${abs}.part-${process.pid}-${Date.now().toString(36)}`;
    let size = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length;
        if (size > MAX_FILE) cb(new Error('文件超过 100 MB'));
        else cb(null, chunk);
      },
    });
    try {
      await pipeline(req, limiter, fs.createWriteStream(tmp));
      await fsp.rename(tmp, abs);
    } catch (e) {
      await fsp.rm(tmp, { force: true }).catch(() => undefined);
      throw e;
    }
  }

  private async sendFile(res: http.ServerResponse, abs: string): Promise<void> {
    let st: fs.Stats;
    try {
      st = await fsp.stat(abs);
    } catch {
      sendJson(res, 404, { error: '文件不存在' });
      return;
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': st.size });
    await pipeline(fs.createReadStream(abs), res);
  }

  // ---------------------------------------------------------------- 客户端

  private open(target: LanTarget, token: string, method: string, sub: string, headers: http.OutgoingHttpHeaders, timeoutMs: number): http.ClientRequest {
    const t = validTarget(target);
    const req = http.request({
      host: t.host,
      port: t.port,
      method,
      path: HTTP_PATH + sub,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      timeout: timeoutMs,
    });
    req.on('timeout', () => req.destroy(new Error('连接对方超时')));
    return req;
  }

  private static netError(e: unknown): Error {
    const msg = errorMessage(e);
    if (/ECONNREFUSED/.test(msg)) return new Error('对方没有在接受连接（应用可能已关闭）');
    if (/EHOSTUNREACH|ENETUNREACH|ETIMEDOUT/.test(msg)) return new Error('连不上对方（不在同一网络，或被防火墙拦住）');
    return e instanceof Error ? e : new Error(msg);
  }

  request(target: LanTarget, token: string, sub: string, body: unknown, timeoutMs: number): Promise<LanJsonResponse> {
    if (typeof sub !== 'string' || !/^\/[a-z]+$/.test(sub)) return Promise.reject(new Error('无效的请求路径'));
    return new Promise((resolve, reject) => {
      const data = Buffer.from(JSON.stringify(body ?? null), 'utf8');
      const req = this.open(target, token, 'POST', sub, { 'content-type': 'application/json; charset=utf-8', 'content-length': data.length }, timeoutMs);
      req.on('response', (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > MAX_JSON) {
            res.destroy(new Error('对方返回的内容太大'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed: unknown = null;
          try {
            parsed = text ? JSON.parse(text) : null;
          } catch {
            parsed = { error: '对方返回的不是 JSON' };
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
        res.on('error', (e) => reject(LanService.netError(e)));
      });
      req.on('error', (e) => reject(LanService.netError(e)));
      req.end(data);
    });
  }

  upload(target: LanTarget, token: string, sub: string, rel: string): Promise<number> {
    if (typeof sub !== 'string' || !/^\/file\/[^/]+$/.test(sub)) return Promise.reject(new Error('无效的请求路径'));
    const abs = this.host.resolve(rel);
    return new Promise((resolve, reject) => {
      fsp
        .stat(abs)
        .then((st) => {
          const req = this.open(target, token, 'PUT', sub, { 'content-type': 'application/octet-stream', 'content-length': st.size }, 120_000);
          req.on('response', (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode ?? 0));
          });
          req.on('error', (e) => reject(LanService.netError(e)));
          const src = fs.createReadStream(abs);
          src.on('error', (e) => req.destroy(e));
          src.pipe(req);
        })
        .catch(reject);
    });
  }

  download(target: LanTarget, token: string, sub: string, rel: string): Promise<number> {
    if (typeof sub !== 'string' || !/^\/file\/[^/]+$/.test(sub)) return Promise.reject(new Error('无效的请求路径'));
    const abs = this.host.resolve(rel);
    return new Promise((resolve, reject) => {
      const req = this.open(target, token, 'GET', sub, {}, 120_000);
      req.on('response', (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
          return;
        }
        const declared = Number(res.headers['content-length'] ?? 0);
        if (declared > MAX_FILE) {
          res.destroy();
          reject(new Error('文件超过 100 MB'));
          return;
        }
        const tmp = `${abs}.part-${process.pid}-${Date.now().toString(36)}`;
        let size = 0;
        const limiter = new Transform({
          transform(chunk: Buffer, _enc, cb) {
            size += chunk.length;
            if (size > MAX_FILE) cb(new Error('文件超过 100 MB'));
            else cb(null, chunk);
          },
        });
        fsp
          .mkdir(path.dirname(abs), { recursive: true })
          .then(() => pipeline(res, limiter, fs.createWriteStream(tmp)))
          .then(() => fsp.rename(tmp, abs))
          .then(() => resolve(200))
          .catch((e) => {
            void fsp.rm(tmp, { force: true }).catch(() => undefined);
            reject(LanService.netError(e));
          });
      });
      req.on('error', (e) => reject(LanService.netError(e)));
      req.end();
    });
  }
}

export function defaultDeviceName(): string {
  const h = os.hostname();
  return h.replace(/\.local$/i, '').slice(0, 40) || '这台电脑';
}
