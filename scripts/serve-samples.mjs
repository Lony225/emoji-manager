// 本地静态服务器：把 examples/subscription 当作一个订阅源，方便测试
import http from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'subscription');
const MIME = {
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

export function createSampleServer(port = 8787, host = '127.0.0.1') {
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
    res.writeHead(200, {
      'content-type': MIME[path.extname(abs).toLowerCase()] ?? 'application/octet-stream',
      'content-length': st.size,
      'access-control-allow-origin': '*',
      'cache-control': 'no-cache',
    });
    createReadStream(abs).pipe(res);
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
