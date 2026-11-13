import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, normalize, extname } from 'node:path';

const mod = await import('./cloud-functions/bundle.mjs');
const handler = mod.default ?? mod.onRequest ?? mod.fetch;

const PORT = Number(process.env.PORT || 8790);
const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url));
const ENV = {
  BASE_URL: process.env.BASE_URL || '',
  IMG_BASE_URL: process.env.IMG_BASE_URL || '',
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

async function serveStatic(pathname, res) {
  const rel = decodeURIComponent(pathname).replace(/^\/+/, '');
  const target = normalize(join(PUBLIC_DIR, rel || 'index.html'));
  if (!target.startsWith(PUBLIC_DIR)) return false;
  let file = target;
  try {
    const st = await stat(file);
    if (st.isDirectory()) file = join(file, 'index.html');
    const body = await readFile(file);
    const ext = extname(file).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'content-length': body.length,
      'cache-control': /\.(png|webp|avif|jpg|jpeg|gif|ico)$/i.test(file)
        ? 'public, max-age=86400'
        : 'no-cache',
    });
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));

    // /api/string 已下线：口令改由页面在浏览器本地生成，服务端不再提供该接口。
    if (url.pathname === '/api/string') {
      res.writeHead(410, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        error: 'gone',
        message: 'this endpoint has been removed; secrets are generated client-side',
      }));
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      // 参数合并：主接口吸收原本的独立子接口，让 /api/random 与 /api/hitokoto 成为唯一入口。
      //   /api/random?info=1     -> /api/image   要 JSON 详情而不是图片字节
      //   /api/hitokoto?daily=1  -> /api/daily   要「每日一句」而不是随机一句
      // 其余参数原样透传（genre / device / class / format / type …）。
      let target = url;
      if (url.pathname === '/api/random' && url.searchParams.get('info') === '1') {
        target = new URL(url);
        target.pathname = '/api/image';
        target.searchParams.delete('info');
      } else if (url.pathname === '/api/hitokoto' && url.searchParams.get('daily') === '1') {
        target = new URL(url);
        target.pathname = '/api/daily';
        target.searchParams.delete('daily');
      } else if (url.pathname === '/api/hitokoto') {
        // type 支持逗号多值：?type=a,d,e —— 上游只认单值，这里每次请求随机抽一个，
        // 多次调用在多个类型之间均匀分布。
        const rawType = url.searchParams.get('type');
        if (rawType && rawType.includes(',')) {
          const list = rawType.split(',').map((s) => s.trim()).filter(Boolean);
          if (list.length) {
            target = new URL(url);
            target.searchParams.set('type', list[Math.floor(Math.random() * list.length)]);
          }
        }
      }
      const request = new Request(target, { method: req.method, headers: req.headers });
      const response = await handler({ request, env: ENV });
      const buf = Buffer.from(await response.arrayBuffer());
      const headers = {};
      response.headers.forEach((v, k) => { headers[k] = v; });
      res.writeHead(response.status, headers);
      res.end(buf);
      return;
    }

    // 兼容旧的四类固定路径：内部等价于 /api/random?device=&genre=
    //   /pc/dm -> /api/random?device=pc&genre=dm
    const legacy = /^\/(pc|mobile)\/(dm|fjbz)\/?$/.exec(url.pathname);
    if (legacy) {
      const target = new URL(url);
      target.pathname = '/api/random';
      target.searchParams.set('device', legacy[1]);
      target.searchParams.set('genre', legacy[2]);
      const request = new Request(target, { method: req.method, headers: req.headers });
      const response = await handler({ request, env: ENV });
      const buf = Buffer.from(await response.arrayBuffer());
      const headers = {};
      response.headers.forEach((v, k) => { headers[k] = v; });
      res.writeHead(response.status, headers);
      res.end(buf);
      return;
    }

    if (await serveStatic(url.pathname, res)) return;

    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'not_found', path: url.pathname }));
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'internal', message: String((e && e.message) || e) }));
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('random-api on ' + PORT + ' BASE=' + (ENV.BASE_URL || 'auto') + ' IMG_BASE=' + (ENV.IMG_BASE_URL || 'auto'));
});
