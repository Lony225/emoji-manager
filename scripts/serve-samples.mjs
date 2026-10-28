// 本地静态服务器：把 examples/subscription 当作一个订阅源，方便测试；
// 端到端测试也用它伪装 GitHub Releases（latest.yml + 安装包），支持单段 Range 请求和限速目录
import http from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SAMPLE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'subscription');
const MIME = {
  '.json': 'application/json; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.exe': 'application/octet-stream',
};

/**
 * @param {number} port
 * @param {string} host
 * @param {string} root 要提供的目录（默认示例订阅源）
 * @param {{ slow?: RegExp, chunk?: number, delayMs?: number }} [opts] 路径匹配 slow 的文件按 chunk / delayMs 限速发送（测试取消下载用）
 */
export function createSampleServer(port = 8787, host = '127.0.0.1', root = SAMPLE_ROOT, opts = {}) {
  const ROOT = path.resolve(root);
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    const abs = path.resolve(ROOT, '.' + urlPath);
    if (!abs.startsWith(ROOT)) {
      res.writeHead(403).end();
      return;
    }
    let st;
    try {
      st = statSync(abs);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    if (st.isDirectory()) {
      res.writeHead(404).end();
      return;
    }
    const headers = {
      'content-type': MIME[path.extname(abs).toLowerCase()] ?? 'application/octet-stream',
      'accept-ranges': 'bytes',
      'access-control-allow-origin': '*',
      'cache-control': 'no-cache',
    };
    // 单段 Range（增量更新按块下载）：bytes=start-end / bytes=start- / bytes=-suffix
    let start = 0;
    let end = st.size - 1;
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    if (range && (range[1] || range[2])) {
      if (range[1]) {
        start = Number(range[1]);
        if (range[2]) end = Math.min(Number(range[2]), st.size - 1);
      } else {
        start = Math.max(0, st.size - Number(range[2]));
      }
      if (start > end || start >= st.size) {
        res.writeHead(416, { 'content-range': `bytes */${st.size}` }).end();
        return;
      }
      headers['content-range'] = `bytes ${start}-${end}/${st.size}`;
    }
    headers['content-length'] = end - start + 1;
    res.writeHead(range && (range[1] || range[2]) ? 206 : 200, headers);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const slow = opts.slow && opts.slow.test(urlPath);
    const stream = createReadStream(abs, { start, end, highWaterMark: slow ? (opts.chunk ?? 256 * 1024) : 64 * 1024 });
    if (!slow) {
      stream.pipe(res);
      return;
    }
    stream.on('data', (chunk) => {
      stream.pause();
      res.write(chunk, () => setTimeout(() => stream.resume(), opts.delayMs ?? 100));
    });
    stream.on('end', () => res.end());
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
  });
  return new Promise((resolve) => {
    server.listen(port, host, () => resolve({ server, url: `http://${host}:${port}` }));
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] ?? 8787);
  const { url } = await createSampleServer(port);
  console.log(`示例订阅源已启动：${url}/pack.json （多包示例：${url}/index.json）`);
  console.log('按 Ctrl+C 停止');
}
