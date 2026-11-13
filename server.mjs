import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, normalize, extname } from 'node:path';

const mod = await import('./cloud-functions/bundle.mjs');
const handler = mod.default ?? mod.onRequest ?? mod.fetch;

const PORT = Number(process.env.PORT || 8790);
const HOST = process.env.HOST || '127.0.0.1';
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

// 与 Go 版保持一致的缓存策略
const IMG_EXT = /\.(png|webp|avif|jpg|jpeg|gif|ico)$/i;

/**
 * 按「原始请求」决定 Cache-Control，覆盖 bundle 自带的头。
 * 随机接口绝不能缓存，否则 CDN 会让所有人拿到同一个结果。
 */
function cacheControlFor(pathname, search) {
  const q = new URLSearchParams(search);
  if (pathname === '/api/random' || pathname === '/api/image') {
    return 'no-store';
  }
  if (pathname === '/api/hitokoto') {
    return q.get('daily') === '1' ? 'public, max-age=3600' : 'no-store';
  }
  if (pathname === '/api/daily') {
    return 'public, max-age=3600';
  }
  if (pathname === '/api/stats') {
    return 'public, max-age=300';
  }
  return 'no-store';
}

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
      // 图片带内容哈希，可永久缓存；其余不缓存，保证改完立即生效
      'cache-control': IMG_EXT.test(file)
        ? 'public, max-age=31536000, immutable'
        : 'no-cache',
    });
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

/** 转发给 bundle，并强制覆盖缓存头与 CORS */
async function proxy(target, req, res, originalPath, originalSearch) {
  const request = new Request(target, { method: req.method, headers: req.headers });
  const response = await handler({ request, env: ENV });
  const buf = Buffer.from(await response.arrayBuffer());
  const headers = {};
  response.headers.forEach((v, k) => {
    // 丢弃 bundle 的缓存头，统一由这里决定
    if (k.toLowerCase() === 'cache-control') return;
    headers[k] = v;
  });
  headers['cache-control'] = cacheControlFor(originalPath, originalSearch);
  if (!headers['access-control-allow-origin']) {
    headers['access-control-allow-origin'] = '*';
  }
  res.writeHead(response.status, headers);
  res.end(buf);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
    const p = url.pathname;
    const search = url.search;

    // 健康检查（systemd / 反代探活）
    if (p === '/healthz') {
      res.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end('ok\n');
      return;
    }

    // /api/string 已下线：口令改由页面在浏览器本地生成，服务端不再提供该接口。
    if (p === '/api/string') {
      res.writeHead(410, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(JSON.stringify({
        error: 'gone',
        message: 'this endpoint has been removed; secrets are generated client-side',
      }));
      return;
    }

    // /api/image 是 /api/random?info=1 的历史别名：始终返回 JSON，绝不 302。
    if (p === '/api/image') {
      const target = new URL(url);
      target.pathname = '/api/random';
      target.searchParams.set('info', '1');
      await proxy(target, req, res, p, search);
      return;
    }

    if (p.startsWith('/api/')) {
      // 参数合并：主接口吸收原本的独立子接口，让 /api/random 与 /api/hitokoto 成为唯一入口。
      //   /api/random?info=1     -> /api/image   要 JSON 详情而不是图片字节
      //   /api/hitokoto?daily=1  -> /api/daily   要「每日一句」而不是随机一句
      // 其余参数原样透传（genre / device / class / format / type …）。
      let target = url;
      if (p === '/api/random' && url.searchParams.get('info') === '1') {
        target = new URL(url);
        target.pathname = '/api/image';
        target.searchParams.delete('info');
      } else if (p === '/api/hitokoto' && url.searchParams.get('daily') === '1') {
        target = new URL(url);
        target.pathname = '/api/daily';
        target.searchParams.delete('daily');
      } else if (p === '/api/hitokoto') {
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
      await proxy(target, req, res, p, search);
      return;
    }

    // 兼容旧的四类固定路径：内部等价于 /api/random?device=&genre=
    //   /pc/dm -> /api/random?device=pc&genre=dm
    const legacy = /^\/(pc|mobile)\/(dm|fjbz)\/?$/.exec(p);
    if (legacy) {
      const target = new URL(url);
      target.pathname = '/api/random';
      target.searchParams.set('device', legacy[1]);
      target.searchParams.set('genre', legacy[2]);
      await proxy(target, req, res, p, search);
      return;
    }

    if (await serveStatic(p, res)) return;

    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'not_found', path: p }));
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'internal', message: String((e && e.message) || e) }));
  }
});

// 与 Go 版对齐的超时设置，避免慢连接耗尽句柄
server.requestTimeout = 30000;
server.headersTimeout = 10000;
server.keepAliveTimeout = 60000;

server.listen(PORT, HOST, () => {
  console.log(
    'random-api(node) ' + HOST + ':' + PORT +
    ' BASE=' + (ENV.BASE_URL || 'auto') +
    ' IMG=' + (ENV.IMG_BASE_URL || 'auto')
  );
});
