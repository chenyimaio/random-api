#!/usr/bin/env node
// scripts/dev.mjs
// 本地开发：把函数打包到内存，和 public/ 静态目录一起用一个 http 服务跑起来。
// 这样本地看到的路径行为和线上一致（/api/* 走函数，其余走静态）。

import { build } from 'esbuild';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const PUBLIC_DIR = join(root, 'public');
const port = Number(process.env.PORT || 8790);

// 打包到内存（write: false），再把产物当成 ESM 模块 import 进来
const result = await build({
  entryPoints: [resolve(root, 'src/makers.js')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  write: false,
  logLevel: 'silent',
});
const code = result.outputFiles[0].text;
const mod = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
const handler = mod.default;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

async function serveStatic(pathname, res) {
  // 只允许 public 里的文件：normalize 之后要仍在 PUBLIC_DIR 下
  const rel = decodeURIComponent(pathname).replace(/^\/+/, '');
  const target = normalize(join(PUBLIC_DIR, rel || 'index.html'));
  if (!target.startsWith(PUBLIC_DIR)) return false;

  let file = target;
  try {
    const st = await stat(file);
    if (st.isDirectory()) file = join(file, 'index.html');
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'content-length': body.length,
      'cache-control': /\.(jpg|jpeg|png|webp|gif|avif)$/i.test(file) ? 'public, max-age=86400' : 'no-cache',
    });
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname.startsWith('/api/')) {
    const request = new Request(url, { method: req.method, headers: req.headers });
    const response = await handler({ request });
    const body = Buffer.from(await response.arrayBuffer());
    const headers = {};
    response.headers.forEach((v, k) => { headers[k] = v; });
    res.writeHead(response.status, headers);
    res.end(body);
    return;
  }

  if (await serveStatic(url.pathname, res)) return;
  if (await serveStatic('/index.html', res)) return;

  res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: 'not_found', path: url.pathname }));
});

server.listen(port, () => {
  console.log(`random-api dev: http://127.0.0.1:${port}`);
  console.log('先跑 npm run gen 生成图片索引；改了 src 需要重启本服务');
});
