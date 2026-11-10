// 잠소리 — 개발용 정적 서버 (의존성 없음)
//   npm start  →  http://localhost:5173
// 마이크는 https 또는 localhost 에서만 동작하므로, PC에서 테스트할 때는 이 서버로 여세요.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)));
const port = Number(process.env.PORT) || 5173;
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.wav': 'audio/wav',
  '.md': 'text/markdown; charset=utf-8',
};

http
  .createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      let path = normalize(join(root, decodeURIComponent(url.pathname)));
      if (!path.startsWith(root)) { res.writeHead(403).end(); return; }
      const s = await stat(path).catch(() => null);
      if (s?.isDirectory()) path = join(path, 'index.html');
      const body = await readFile(path);
      res.writeHead(200, { 'Content-Type': types[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('없는 파일이에요');
    }
  })
  .listen(port, () => console.log(`잠소리: http://localhost:${port}`));
