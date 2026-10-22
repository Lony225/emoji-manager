// 管理员口令（scrypt）与登录会话（HMAC 签名的 cookie）
import crypto from 'node:crypto';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

export function verifyPassword(password, salt, hash) {
  if (!salt || !hash) return false;
  const got = crypto.scryptSync(password, salt, 64);
  const want = Buffer.from(hash, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

function sign(secret, payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

/** 生成会话 cookie 的值：过期时间.随机数.签名 */
export function issueSession(secret) {
  const exp = Date.now() + SESSION_TTL_MS;
  const nonce = crypto.randomBytes(8).toString('base64url');
  const payload = `${exp}.${nonce}`;
  return { value: `${payload}.${sign(secret, payload)}`, maxAgeSec: Math.floor(SESSION_TTL_MS / 1000) };
}

export function verifySession(secret, value) {
  if (typeof value !== 'string') return false;
  const parts = value.split('.');
  if (parts.length !== 3) return false;
  const [exp, nonce, sig] = parts;
  const payload = `${exp}.${nonce}`;
  const want = sign(secret, payload);
  if (want.length !== sig.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig))) return false;
  return Number(exp) > Date.now();
}

/** 简单的登录限速：同一 IP 连续失败后要等 */
export class LoginGuard {
  constructor() {
    this.fails = new Map();
  }
  check(ip) {
    const f = this.fails.get(ip);
    if (!f) return 0;
    if (Date.now() > f.until) {
      this.fails.delete(ip);
      return 0;
    }
    return Math.ceil((f.until - Date.now()) / 1000);
  }
  fail(ip) {
    const f = this.fails.get(ip) ?? { count: 0, until: 0 };
    f.count++;
    // 第 5 次起每次失败等待时间翻倍：30s、60s、120s……最长 1 小时
    if (f.count >= 5) f.until = Date.now() + Math.min(3600_000, 30_000 * 2 ** (f.count - 5));
    this.fails.set(ip, f);
  }
  reset(ip) {
    this.fails.delete(ip);
  }
}
