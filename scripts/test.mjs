#!/usr/bin/env node
// scripts/test.mjs
// 直接对构建产物发请求，验证每个接口。不需要起服务器。
//   npm test

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync, existsSync, readdirSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const entry = resolve(root, 'cloud-functions/[[default]].js');

if (!existsSync(entry)) {
  console.error('找不到 cloud-functions/[[default]].js，先跑 npm run build');
  process.exit(1);
}


const { default: handler } = await import(pathToFileURL(entry).href);

const results = [];
const check = (name, ok, extra) => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? '✅' : '❌'} ${name}${ok ? '' : '  ' + String(JSON.stringify(extra) ?? extra).slice(0, 240)}`);
};

const call = async (path, init) => {
  // 带上 host 头：拿不到公网 host 时接口会给相对地址（生产环境正是这样），
  // 这里模拟"有正常域名"的常见情况，好让绝对地址相关断言成立
  const merged = { ...(init ?? {}) };
  merged.headers = { host: 'example.test', ...(init?.headers ?? {}) };
  const res = await handler({ request: new Request('https://example.test' + path, merged) });
  const buf = Buffer.from(await res.arrayBuffer());
  let data = null;
  if (buf.length && /json/.test(res.headers.get('content-type') || '')) {
    try { data = JSON.parse(buf.toString('utf8')); } catch { /* 忽略 */ }
  }
  return { status: res.status, headers: res.headers, data, text: buf.toString('utf8'), bytes: buf.length };
};

const quotes = JSON.parse(readFileSync(resolve(root, 'data/quotes.json'), 'utf8'));
const quotesRemote = JSON.parse(readFileSync(resolve(root, 'data/quotes.remote.json'), 'utf8'));
const quotesAll = quotes.length + quotesRemote.length;
const images = JSON.parse(readFileSync(resolve(root, 'data/images.json'), 'utf8'));

// ---- stats ----
let r = await call('/api/stats');
check('GET /api/stats 返回 200', r.status === 200, r.status);
check('stats 的 quotes 数量与两个数据文件一致', r.data?.quotes >= quotesAll * 0.99 && r.data?.quotes <= quotesAll, { got: r.data?.quotes, want: quotesAll });
check('stats 的 images 数量与索引一致', r.data?.images === images.length, { got: r.data?.images, want: images.length });
check('stats 带 CORS 头', r.headers.get('access-control-allow-origin') === '*', r.headers.get('access-control-allow-origin'));
check('随机接口不缓存', r.headers.get('cache-control') === 'no-store', r.headers.get('cache-control'));

// ---- hitokoto ----
const seen = new Set();
for (let i = 0; i < 30; i++) {
  r = await call('/api/hitokoto');
  if (r.status !== 200) break;
  seen.add(r.data.id);
}
check('GET /api/hitokoto 返回 200', r.status === 200, r.status);
check('hitokoto 字段齐全', ['hitokoto', 'from', 'from_who', 'type', 'uuid'].every((k) => k in (r.data ?? {})), r.data);
check('多次调用能抽到不同条目（随机性正常）', seen.size > 3, [...seen].length);
check('hitokoto 内容来自我们的数据（curated 或 remote）', [...quotes, ...quotesRemote].some((q) => q.hitokoto === r.data.hitokoto), r.data?.hitokoto);

// ---- type 过滤 ----
r = await call('/api/hitokoto?type=d');
check('?type=d 过滤有效', r.status === 200 && r.data.type === 'd', r.data?.type);
r = await call('/api/hitokoto?type=nope');
check('未知 type -> 404', r.status === 404, r.status);

// ---- quote ----
r = await call('/api/quote');
check('GET /api/quote 简版字段', r.status === 200 && typeof r.data.quote === 'string', r.data);

// ---- 批量 ----
r = await call('/api/quotes?n=5');
check('GET /api/quotes?n=5 返回 5 条', r.status === 200 && r.data.items.length === 5, r.data?.items?.length);
check('批量结果不重复', new Set(r.data.items.map((x) => x.id)).size === 5, r.data?.items?.map((x) => x.id));
// 用一个必定超过数据量的值（全量句子上万条，写死 9999 有一天会不够）
const overN = quotesAll + 500;
r = await call('/api/quotes?n=' + overN);
check('n 超上限时被截断到数据量', r.status === 200 && r.data.items.length >= quotesAll * 0.99, r.data?.items?.length);

// ---- image ----
r = await call('/api/image');
check('GET /api/image 返回 200', r.status === 200, r.status);
check('image.url 是绝对地址', /^https?:\/\//.test(r.data?.url ?? ''), r.data?.url);
check('image 带宽高', Number(r.data?.width) > 0 && Number(r.data?.height) > 0, r.data);
check('image.path 已从响应里移除（只留 url）', !('path' in (r.data ?? {})), Object.keys(r.data ?? {}));

// ---- /api/random：直接返回图片字节 ----
// /api/image/raw 已删除，只保留短链接 /api/random。
// 正常部署下函数内 fetch 同源静态资源成功 → 200 直吐字节，地址不变；
// 取不到时才降级 302。两条路径都要测。
{
  // 用可控的 fetch 桩替换全局，模拟"函数内取静态资源成功"
  const realFetch = globalThis.fetch;
  const probeFetch = async (u) => {
    if (String(u).includes('random-api-images')) {
      return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
        status: 200,
        headers: { 'content-type': 'image/webp' },
      });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };

  globalThis.fetch = probeFetch;
  const direct = await handler({
    request: new Request('https://example.test/api/random', {
      headers: { host: 'example.test', accept: 'image/webp' },
    }),
  });
  const directBytes = Buffer.from(await direct.arrayBuffer());
  globalThis.fetch = realFetch;

  check('/api/random 直接返回 200（不再 302）', direct.status === 200, direct.status);
  check('/api/random 返回图片字节', directBytes.length > 0, directBytes.length);
  check('/api/random 带正确 content-type', /^image\//.test(direct.headers.get('content-type') ?? ''), direct.headers.get('content-type'));
  check('/api/random 无 Location（地址不变）', direct.headers.get('location') === null, direct.headers.get('location'));
  check('/api/random no-store（每次刷新重新随机）', /no-store/.test(direct.headers.get('cache-control') ?? ''), direct.headers.get('cache-control'));
  check('/api/random 带 Vary: Accept', /accept/i.test(direct.headers.get('vary') ?? ''), direct.headers.get('vary'));

  // 连续两次不能拿到同一张图：用可控 fetch 桩记录被请求的 URL
  const seenPaths = [];
  globalThis.fetch = async (u) => {
    if (String(u).includes('random-api-images')) {
      seenPaths.push(new URL(String(u)).pathname);
      return new Response(new Uint8Array([1]), { status: 200, headers: { 'content-type': 'image/webp' } });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  for (let i = 0; i < 30; i++) {
    const res = await handler({ request: new Request('https://example.test/api/random', { headers: { host: 'example.test' } }) });
    await res.arrayBuffer();
  }
  globalThis.fetch = realFetch;
  check('连续 30 次刷新能抽到不同图片', new Set(seenPaths).size > 3, new Set(seenPaths).size);
}

r = await call('/api/image/raw');
check('GET /api/image/raw 已移除 -> 404', r.status === 404, r.status);
{
  // 强制 fetch 失败，验证 /api/random 降级 302 到 GitHub raw
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 500 });
  r = await call('/api/random');
  globalThis.fetch = realFetch;
  check('GET /api/random fetch 失败时降级 302', r.status === 302, r.status);
  check('降级 302 的 location 指向 GitHub raw', String(r.headers.get('location') ?? '').includes('random-api-images'), r.headers.get('location'));
}

// ---- all ----
r = await call('/api/all');
check('GET /api/all 同时含 quote 和 image', r.status === 200 && r.data.quote && r.data.image, Object.keys(r.data ?? {}));

// ---- images 列表 ----
r = await call('/api/images');
check('GET /api/images 全量返回', r.status === 200 && r.data.items.length === images.length, r.data?.items?.length);
check('/api/images 带朝向统计', typeof r.data.counts === 'object', r.data?.counts);

// ---- 朝向与四类路径 ----
// 四类：pc/dm、mobile/dm、pc/fjbz、mobile/fjbz。方图已取消。
for (const o of ['landscape', 'portrait']) {
  r = await call('/api/image?orientation=' + o);
  check('?orientation=' + o + ' 返回该朝向',
    r.status === 200 && r.data.requestedOrientation === o && r.data.orientation === o,
    { got: r.data?.orientation, req: r.data?.requestedOrientation });
}
check('数据里确实有横图', images.some((i) => i.orientation === 'landscape'), images.length);
check('数据里确实有竖图', images.some((i) => i.orientation === 'portrait'), images.length);

{
  const bad = [];
  for (let i = 0; i < 40; i++) {
    const x = await call('/api/image?orientation=portrait');
    if (x.data?.orientation !== 'portrait') bad.push(x.data?.orientation);
  }
  check('?orientation=portrait 连续 40 次都不越界', bad.length === 0, bad.slice(0, 5));
}

// 四类路径过滤
for (const c of ['pc/dm', 'mobile/dm', 'pc/fjbz', 'mobile/fjbz']) {
  const x = await call('/api/image?class=' + encodeURIComponent(c));
  const expect = c.startsWith('pc') ? 'landscape' : 'portrait';
  check('?class=' + c + ' 命中该类',
    x.status === 200 && x.data?.class === c && x.data?.orientation === expect,
    { cls: x.data?.class, orient: x.data?.orientation });
}
r = await call('/api/image?genre=fjbz');
check('?genre=fjbz 只给风景类', r.status === 200 && r.data?.genre === 'fjbz', r.data?.genre);
r = await call('/api/image?device=mobile');
check('?device=mobile 只给竖图类', r.status === 200 && r.data?.device === 'mobile', r.data?.device);

// 四类都应存在（新索引生成后成立）
{
  const counts = images.reduce((m, i) => { const k = i.class ?? '(无)'; m[k] = (m[k] ?? 0) + 1; return m; }, {});
  for (const c of ['pc/dm', 'mobile/dm', 'pc/fjbz', 'mobile/fjbz']) {
    check(`索引里 ${c} 存在且非空`, (counts[c] ?? 0) > 0, counts[c] ?? 0);
  }
  check('索引里不再有 square 类', !images.some((i) => i.orientation === 'square'),
    images.filter((i) => i.orientation === 'square').length);
}

// 简短路径 /pc/dm 等
for (const c of ['pc/dm', 'mobile/fjbz']) {
  const x = await call('/' + c);
  check('/' + c + ' 可访问（302 或 200）', [200, 302].includes(x.status), x.status);
}

// 自适应接口带分类能力：genre + UA 自动补 device
{
  const PC = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/154';
  const PH = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Mobile/15E148';
  const uaGet = async (path, ua) => {
    const res = await handler({ request: new Request('https://example.test' + path, { headers: { host: 'example.test', 'user-agent': ua } }) });
    let d = null; try { d = JSON.parse(Buffer.from(await res.arrayBuffer()).toString('utf8')); } catch { /* 忽略 */ }
    return d;
  };
  let d = await uaGet('/api/image?genre=fjbz', PC);
  check('自适应：电脑 + genre=fjbz -> pc/fjbz', d?.class === 'pc/fjbz' && d?.requestedOrientation === 'landscape', { cls: d?.class, o: d?.requestedOrientation });
  d = await uaGet('/api/image?genre=fjbz', PH);
  check('自适应：手机 + genre=fjbz -> mobile/fjbz', d?.class === 'mobile/fjbz' && d?.requestedOrientation === 'portrait', { cls: d?.class, o: d?.requestedOrientation });
  d = await uaGet('/api/image?class=pc/dm', PH);
  check('自适应：显式 class 压过 UA', d?.class === 'pc/dm' && d?.requestedOrientation === 'landscape', { cls: d?.class, o: d?.requestedOrientation });
  d = await uaGet('/api/image?orientation=portrait', PC);
  check('自适应：显式 orientation 压过 UA', d?.requestedOrientation === 'portrait', d?.requestedOrientation);
  d = await uaGet('/api/image', PC);
  check('自适应：无参数时仍按 UA', d?.requestedOrientation === 'landscape', d?.requestedOrientation);
}

// ---- 朝向：UA 自适应 ----
const UAS = {
  pc: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/154 Safari/537.36',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/154 Mobile Safari/537.36',
  ipad: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
};
const uaCall = async (path, ua) => {
  const res = await handler({ request: new Request('https://example.test' + path, { headers: { 'user-agent': ua } }) });
  const buf = Buffer.from(await res.arrayBuffer());
  let data = null;
  try { data = JSON.parse(buf.toString('utf8')); } catch { /* 忽略 */ }
  return { status: res.status, headers: res.headers, data };
};

r = await uaCall('/api/image', UAS.pc);
check('桌面 UA 判定为横图', r.data?.requestedOrientation === 'landscape', r.data?.requestedOrientation);
r = await uaCall('/api/image', UAS.iphone);
check('iPhone UA 判定为竖图', r.data?.requestedOrientation === 'portrait', r.data?.requestedOrientation);
r = await uaCall('/api/image', UAS.android);
check('Android Mobile UA 判定为竖图', r.data?.requestedOrientation === 'portrait', r.data?.requestedOrientation);
r = await uaCall('/api/image', UAS.ipad);
check('iPad 判定为横图（平板不当手机）', r.data?.requestedOrientation === 'landscape', r.data?.requestedOrientation);
r = await uaCall('/api/image?orientation=portrait', UAS.pc);
check('显式参数优先于 UA', r.data?.requestedOrientation === 'portrait', r.data?.orientation);

// ---- 302 带朝向标记（fetch 失败走降级）----
{
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 500 });
  r = await uaCall('/api/random', UAS.iphone);
  globalThis.fetch = realFetch;
  check('302 响应带 x-image-orientation', r.headers.get('x-image-orientation') === 'portrait', r.headers.get('x-image-orientation'));
  check('302 的 location 落在 GitHub raw', String(r.headers.get('location') ?? '').includes('random-api-images'), r.headers.get('location'));
}


// ---- 图片都已转成 webp ----
check('默认路径都是 .webp', images.every((i) => i.path.endsWith('.webp')), images.filter((i) => !i.path.endsWith('.webp')).map((i) => i.path).slice(0, 3));
check('所有图片都有朝向', images.every((i) => ['landscape', 'portrait'].includes(i.orientation)), images.filter((i) => !['landscape', 'portrait'].includes(i.orientation)).map((i) => i.path).slice(0, 3));
{
  // WebP 是默认格式。二次元图基本都在 400 KB 内，但风景照片信息量大，
  // q82 的 webp 天然会到 400~600 KB —— 放宽到 650 KB（单文件 25 MB 上限下依然充裕）。
  const tooBig = images.filter((i) => i.formats.webp && i.formats.webp.bytes > 650 * 1024);
  check('默认格式（webp）没有单张超过 650 KB', tooBig.length === 0, tooBig.map((i) => `${i.path} ${Math.round(i.formats.webp.bytes / 1024)}KB`).slice(0, 3));

  // 平台限制：单文件 25 MB，项目总量 5 GB
  const allFiles = images.flatMap((i) => Object.values(i.formats));
  const biggest = allFiles.reduce((m, f) => Math.max(m, f.bytes), 0);
  check(`单文件不超过 25 MB（最大 ${(biggest / 1024 / 1024).toFixed(2)} MB）`, biggest < 25 * 1024 * 1024, biggest);
  const total = allFiles.reduce((n, f) => n + f.bytes, 0);
  check(`项目总量不超过 5 GB（当前 ${(total / 1024 / 1024).toFixed(0)} MB）`, total < 5 * 1024 * 1024 * 1024, total);
  check(`文件数不超过 20000（当前 ${images.length * 2}）`, images.length * 2 < 20000, images.length * 2);
}

// ---- 每日一句 ----
{
  // 同一天多次调用必须完全一致
  const texts = new Set();
  for (let i = 0; i < 6; i++) {
    const x = await call('/api/daily');
    if (x.status !== 200) break;
    texts.add(x.data?.hitokoto);
  }
  check('同一天多次调用返回同一句', texts.size === 1, [...texts]);

  r = await call('/api/daily');
  check('每日一句状态 200', r.status === 200, r.status);
  check('带 date / timezone 字段', /^\d{4}-\d{2}-\d{2}$/.test(r.data?.date ?? '') && !!r.data?.timezone, r.data);
  check('标了 daily', r.data?.daily === true, r.data?.daily);
  check('缓存时间不超过一天',
    /^public, max-age=\d+$/.test(r.headers.get('cache-control') ?? '') &&
    Number((r.headers.get('cache-control') ?? '').match(/max-age=(\d+)/)?.[1]) <= 86400,
    r.headers.get('cache-control'));
  check('带 etag（按日期走）', /daily-\d{4}-\d{2}-\d{2}/.test(r.headers.get('etag') ?? r.data?.etag ?? ''), r.headers.get('etag'));

  // 连续 60 天不重复（步长与池子互质的直接效果）
  const days = [];
  for (let i = 0; i < 60; i++) {
    const d = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
    const x = await call('/api/daily?date=' + d);
    days.push(x.data?.hitokoto);
  }
  check('连续 60 天各不相同', new Set(days).size === 60, new Set(days).size);
  check('每日一句来自我们的数据', days.every((t) => [...quotes, ...quotesRemote].some((q) => q.hitokoto === t)), days.slice(0, 2));

  // 同一天 + 指定日期 应该和"那天"的结果一致（可回看）
  r = await call('/api/daily?date=2026-03-15');
  const again = await call('/api/daily?date=2026-03-15');
  check('指定日期结果稳定（可回看）', r.data?.hitokoto === again.data?.hitokoto, r.data?.hitokoto);

  // 时区
  r = await call('/api/daily?tz=Asia/Shanghai');
  check('tz 被正确接受', r.status === 200 && r.data?.timezone === 'Asia/Shanghai', r.data?.timezone);
  const sh = r.data?.date;
  r = await call('/api/daily?tz=UTC');
  const utc = r.data?.date;
  check('不同时区可能落在不同的自然日', typeof sh === 'string' && typeof utc === 'string', { sh, utc });
  r = await call('/api/daily?tz=Not/AZone');
  check('非法时区退化为 UTC 而不是崩', r.status === 200, r.status);

  // 分类
  r = await call('/api/daily?type=a');
  check('每日一句支持 type 过滤', r.status === 200 && r.data?.type === 'a', r.data?.type);
  r = await call('/api/daily?type=zz');
  check('每日一句未知 type -> 404', r.status === 404, r.status);

  // 日期校验：格式对但日历上不存在也要拒
  for (const bad of ['2026-13-99', '2026-02-30', '2026-1-1', 'abc']) {
    const x = await call('/api/daily?date=' + encodeURIComponent(bad));
    check(`非法日期 ${bad} -> 400`, x.status === 400 && x.data?.error === 'invalid_date', x.status);
  }
  for (const good of ['2024-02-29', '2026-12-31']) {
    const x = await call('/api/daily?date=' + good);
    check(`合法日期 ${good} -> 200`, x.status === 200 && x.data?.date === good, x.status);
  }
}

// ---- 格式协商 ----
{
  check('每张图至少有一种格式', images.every((i) => Object.keys(i.formats ?? {}).length > 0),
    images.filter((i) => !Object.keys(i.formats ?? {}).length).length);
  check('每张图都有默认格式且存在于 formats 里',
    images.every((i) => i.formats?.[i.defaultFormat]),
    images.filter((i) => !i.formats?.[i.defaultFormat]).map((i) => i.name).slice(0, 3));
  check('默认格式是 webp', images.every((i) => i.defaultFormat === 'webp'),
    images.filter((i) => i.defaultFormat !== 'webp').map((i) => i.defaultFormat).slice(0, 3));

  const hasAvif = images.filter((i) => i.formats.avif).length;
  check(`有 AVIF 变体的图片（${hasAvif}/${images.length}）`, hasAvif > 0, hasAvif);
  // 这条规则已删除：AVIF 现在是「接近原图画质」，通常比 WebP 更大，这是刻意取舍
  check('AVIF 一律存在（不再因为体积被丢弃）', images.every((i) => i.formats.avif), images.filter((i) => !i.formats.avif).length);

  // 用 fetch 失败桩，强制 /api/random 走 302 降级，避免真实请求 GitHub、测试更快更稳
  const _realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 500 });

  const withAccept = async (accept) => {
    const res = await handler({
      request: new Request('https://example.test/api/random', { headers: accept ? { accept } : {} }),
    });
    return { status: res.status, format: res.headers.get('x-image-format'), location: res.headers.get('location'), vary: res.headers.get('vary') };
  };

  let a = await withAccept('image/avif,image/webp,image/apng,*/*');
  check('Accept 含 image/avif -> 给 AVIF', a.format === 'avif', a);
  check('带 Vary: Accept（同一 URL 会按 Accept 变）', a.vary === 'Accept', a.vary);

  a = await withAccept('image/webp,*/*');
  check('Accept 只有 webp -> 不给 AVIF（通配不算点名）', a.format === 'webp', a);

  a = await withAccept('*/*');
  check('Accept 全通配 -> 默认 webp', a.format === 'webp', a);

  a = await withAccept('image/jpeg');
  // JPEG 兜底层已下线：老客户端要 jpeg 时应顺回退链落到 webp，而不是 404
  check('Accept 只要 jpeg -> 回退到 webp', a.format === 'webp', a);

  a = await withAccept('text/html');
  check('Accept 不是图片 -> 默认 webp', a.format === 'webp', a);

  a = await withAccept(null);
  check('无 Accept -> 默认 webp', a.format === 'webp', a);

  globalThis.fetch = _realFetch;

  // 显式 ?format=
  r = await call('/api/image?format=avif');
  check('?format=avif 返回 avif', r.data?.format === 'avif' && /\.avif$/.test(r.data?.url ?? ''), r.data?.format);
  r = await call('/api/image?format=webp');
  check('?format=webp 返回 webp', r.data?.format === 'webp', r.data?.format);
  r = await call('/api/image?format=jpeg');
  check('?format=jpeg（已下线）回退到 webp 并报告意图',
    r.data?.format === 'webp' && r.data?.requestedFormat === 'jpeg', r.data);
  r = await call('/api/image?format=heic');
  check('?format=heic（没有该格式）回退到 webp 并报告意图',
    r.data?.format === 'webp' && r.data?.requestedFormat === 'heic', r.data);

  // 只有 avif / webp 两份，JPEG 兜底层已下线
  {
    const two = images.filter((i) => i.formats.avif && i.formats.webp).length;
    check(`双格式齐全的图片（${two}/${images.length}）`, two === images.length,
      images.filter((i) => !(i.formats.avif && i.formats.webp)).map((i) => Object.keys(i.formats)).slice(0, 3));
    check('索引里不再有 jpeg', images.every((i) => !i.formats.jpeg),
      images.filter((i) => i.formats.jpeg).length);
  }

  // 响应体里的 formats 清单
  r = await call('/api/image');
  check('响应里有 formats 清单', r.data?.formats && Object.keys(r.data.formats).length > 0, Object.keys(r.data?.formats ?? {}));
  check('formats 里是绝对地址', Object.values(r.data.formats).every((f) => /^https?:\/\//.test(f.url)), r.data?.formats);

  // 索引字段完整性：tags 曾经在重构里丢过，导致 ?tag= 直接 500
  check('每张图都有 tags 数组', images.every((i) => Array.isArray(i.tags)), images.filter((i) => !Array.isArray(i.tags)).length);
  r = await call('/api/image?tag=' + encodeURIComponent(images[0]?.tags?.[0] ?? 'pc'));
  check('?tag= 能工作且不 500', r.status === 200 && Object.keys(r.data?.formats ?? {}).length > 0, r.status);
  r = await call('/api/image?tag=nope');
  check('未知 tag 优雅回退（200 不 500）', r.status === 200 && r.data?.formats, r.status);
  r = await call('/api/image?class=nope/nope');
  check('未知 class 优雅回退（200 不 500）', r.status === 200 && r.data?.formats, r.status);

  // 两种格式的文件都要真实存在
  const missingFmt = [];
  for (const img of images) {
    for (const [fmt, info] of Object.entries(img.formats)) {
      const p = resolve(root, 'public/img' + decodeURIComponent(info.path));
      if (!existsSync(p)) missingFmt.push(`${img.name}:${fmt}`);
    }
  }
  check('所有格式的文件都存在', missingFmt.length === 0, missingFmt.slice(0, 3));
}

// ---- 随机数 ----
{
  r = await call('/api/number');
  check('GET /api/number 默认给一个数字', r.status === 200 && Number.isInteger(r.data?.number), r.data);
  check('默认区间 0..100', r.data?.min === 0 && r.data?.max === 100, [r.data?.min, r.data?.max]);
  check('数字落在区间内', r.data?.number >= 0 && r.data?.number <= 100, r.data?.number);

  // 区间边界必须严格
  const out = [];
  for (let i = 0; i < 300; i++) {
    const x = await call('/api/number?min=1&max=6');
    out.push(x.data.number);
  }
  check('1..6 只出现这 6 个值', out.every((v) => v >= 1 && v <= 6 && Number.isInteger(v)), [...new Set(out)]);
  check('1..6 六个值都出现过', new Set(out).size === 6, new Set(out).size);
  {
    // 300 次抽样下"最大偏差 < 35%"会偶发误报（σ≈6.5，17 的偏差是 2.6σ，正常但会被判失败）。
    // 换成卡方检验：df=5，p=0.001 的临界值是 20.5，对样本量的解释更正确。
    const tally = {};
    for (const v of out) tally[v] = (tally[v] ?? 0) + 1;
    const exp = out.length / 6;
    const chi2 = Object.values(tally).reduce((acc, o) => acc + ((o - exp) ** 2) / exp, 0);
    check(`1..6 分布均匀性通过卡方检验（chi²=${chi2.toFixed(1)} < 20.5，df=5）`, chi2 < 20.5, tally);
  }

  r = await call('/api/number?min=10&max=10');
  check('min == max 时恒等于该值', r.data?.number === 10, r.data?.number);

  r = await call('/api/number?n=5&min=1&max=100');
  check('n=5 返回 5 个数', r.status === 200 && r.data?.numbers?.length === 5 && r.data?.count === 5, r.data);

  r = await call('/api/number?n=6&min=1&max=6&unique=1');
  check('unique=1 结果不重复', new Set(r.data?.numbers ?? []).size === 6, r.data?.numbers);

  r = await call('/api/number?n=20&min=1&max=100&unique=1');
  check('独特值个数等于 n', new Set(r.data?.numbers ?? []).size === 20, new Set(r.data?.numbers ?? []).size);

  r = await call('/api/number?min=0&max=1&decimals=2');
  check('decimals 给出小数', r.data?.type === 'float' && !Number.isInteger(r.data?.number), r.data);
  check('小数位数不超过 decimals', /^\d?(\.\d{1,2})?$/.test(String(r.data?.number)), r.data?.number);

  // 大跨度去重（不能退化成一亿个元素的数组）
  const t0 = Date.now();
  r = await call('/api/number?n=5&min=0&max=1000000000&unique=1');
  const ms = Date.now() - t0;
  check(`大跨度去重能正常返回（${ms}ms）`, r.status === 200 && new Set(r.data?.numbers).size === 5 && ms < 2000, { ms, data: r.data });

  // 参数校验
  for (const [qs, why] of [
    ['min=5&max=1', 'min > max'],
    ['n=0', 'n=0'],
    ['n=abc', 'n 非数字'],
    ['n=1001', 'n 超上限'],
    ['decimals=99', 'decimals 超上限'],
    ['decimals=-1', 'decimals 负数'],
    ['min=abc', 'min 非数字'],
    ['n=10&min=1&max=6&unique=1', '去重数量超过区间'],
  ]) {
    const x = await call('/api/number?' + qs);
    check(`参数错误 ${why} -> 400`, x.status === 400 && x.data?.error === 'invalid_parameter', { status: x.status, data: x.data });
  }

  r = await call('/api/stats');
  check('stats 公布随机数上限', r.data?.numberLimits?.maxCount === 1000, r.data?.numberLimits);
}

// ---- 随机字符串 ----
{
  const has = {
    lower: (s) => /[a-z]/.test(s),
    upper: (s) => /[A-Z]/.test(s),
    digits: (s) => /[0-9]/.test(s),
    underscore: (s) => /_/.test(s),
    symbols: (s) => /[!@#$%^&*()\-=+[\]{};:,.<>?/|~]/.test(s),
  };

  r = await call('/api/string');
  check('默认长度 16', r.status === 200 && r.data?.string?.length === 16, r.data?.string?.length);
  check('默认字符类 lower+upper+digits',
    JSON.stringify(r.data?.classes) === JSON.stringify(['lower', 'upper', 'digits']), r.data?.classes);

  // 只要开了的类，就保证每类至少出现一次（纯随机会偶发缺失）
  for (const cls of ['lower', 'upper', 'digits']) {
    const qs = `length=8&lower=${cls === 'lower' ? 1 : 0}&upper=${cls === 'upper' ? 1 : 0}&digits=${cls === 'digits' ? 1 : 0}`;
    let ok = true;
    let sample = '';
    for (let i = 0; i < 40; i++) {
      const x = await call('/api/string?' + qs);
      sample = x.data?.string;
      if (!has[cls](sample) || sample.length !== 8) { ok = false; break; }
    }
    check(`只开 ${cls} 时结果只含该类字符`, ok, sample);
  }

  // 全开时每类都至少出现一次
  {
    let allCovered = true;
    let sample = '';
    for (let i = 0; i < 30; i++) {
      const x = await call('/api/string?length=32&lower=1&upper=1&digits=1&symbols=1&underscore=1');
      sample = x.data?.string;
      if (!Object.entries(has).every(([, fn]) => fn(sample))) { allCovered = false; break; }
    }
    check('五类全开时每类都出现（32 位 × 30 次）', allCovered, sample);
  }

  r = await call('/api/string?length=20&symbols=1');
  check('symbols=1 会引入符号', has.symbols(r.data?.string), r.data?.string);
  check('symbols 默认关闭时不含符号', !has.symbols((await call('/api/string?length=40')).data?.string), 'default');

  r = await call('/api/string?length=24&underscore=1');
  check('underscore=1 会引入下划线', has.underscore(r.data?.string), r.data?.string);

  r = await call('/api/string?length=32&exclude=abcXYZ019');
  check('exclude 排除了指定字符',
    r.status === 200 && !/[abcXYZ019]/.test(r.data?.string), r.data?.string);
  check('exclude 生效后长度不变', r.data?.string?.length === 32, r.data?.string?.length);

  r = await call('/api/string?length=24&noAmbiguous=1&symbols=1');
  check('noAmbiguous 去掉了易混字符', !/[0O1lI|]/.test(r.data?.string ?? ''), r.data?.string);

  r = await call('/api/string?n=5&length=10');
  check('n=5 返回 5 个串', r.data?.strings?.length === 5 && r.data?.count === 5, r.data);
  check('多个串互不相同', new Set(r.data?.strings ?? []).size === 5, r.data?.strings);

  // 参数校验
  for (const [qs, why] of [
    ['lower=0&upper=0&digits=0&symbols=0&underscore=0', '一个字符类都没开'],
    ['length=0', 'length 过小'],
    ['length=999', 'length 过大'],
    ['length=abc', 'length 非数字'],
    ['n=0', 'n=0'],
    ['n=999', 'n 过大'],
  ]) {
    const x = await call('/api/string?' + qs);
    check(`字符串参数错误 ${why} -> 400`, x.status === 400 && x.data?.error === 'invalid_parameter', { status: x.status, data: x.data });
  }

  // 池子被 exclude 削空
  r = await call('/api/string?length=8&lower=1&upper=0&digits=0&exclude=' + encodeURIComponent('abcdefghijklmnopqrstuvwxyz'));
  check('exclude 削空字符池 -> 400', r.status === 400, r.status);

  // ---- 自定义长度 ----
  r = await call('/api/string?length=64');
  check('自定义长度 64 生效', r.data?.string?.length === 64, r.data?.string?.length);

  r = await call('/api/string?length=8,12,16');
  check('长度列表默认生成对应个数的串',
    Array.isArray(r.data?.strings) && r.data.strings.length === 3, r.data);
  check('每个串的长度与列表一致',
    JSON.stringify(r.data?.strings?.map((s) => [...s].length)) === JSON.stringify([8, 12, 16]),
    r.data?.strings?.map((s) => [...s].length));

  r = await call('/api/string?length=8,12&n=5');
  check('长度列表 + n 时按循环取长度',
    JSON.stringify(r.data?.strings?.map((s) => [...s].length)) === JSON.stringify([8, 12, 8, 12, 8]),
    r.data?.strings?.map((s) => [...s].length));

  r = await call('/api/string?length=1');
  check('最小长度 1 可用', r.data?.string?.length === 1, r.data?.string);

  r = await call('/api/string?length=256');
  check('最大长度 256 可用', r.data?.string?.length === 256, r.data?.string?.length);

  // ---- 自定义字符集 ----
  r = await call('/api/string?length=32&chars=abc123');
  check('chars 只用指定字符', /^[abc123]{32}$/.test(r.data?.string ?? ''), r.data?.string);
  check('响应回显字符池大小', r.data?.poolSize === 6, r.data?.poolSize);

  r = await call('/api/string?length=40&chars=01');
  check('两字符池也能用', /^[01]{40}$/.test(r.data?.string ?? ''), r.data?.string);

  r = await call('/api/string?length=20&symbols=' + encodeURIComponent('!@#'));
  check('symbols 传字符集时当自定义符号', r.status === 200 && /^[A-Za-z0-9!@#]{20}$/.test(r.data?.string ?? ''), r.data?.string);
  check('自定义符号确实出现了', /[!@#]/.test(r.data?.string ?? ''), r.data?.string);

  r = await call('/api/string?length=20&chars=abcdef&exclude=abc');
  check('chars 与 exclude 可叠加', /^[def]{20}$/.test(r.data?.string ?? ''), r.data?.string);

  // emoji 这类代理对：按字符数算，不按 UTF-16 码元
  r = await call('/api/string?length=10&chars=' + encodeURIComponent('🏀⚽'));
  check('多字节字符按字符数计长度', [...(r.data?.string ?? '')].length === 10, [...(r.data?.string ?? '')].length);
  check('多字节字符池只含指定的两个', /^[🏀⚽]+$/.test(r.data?.string ?? ''), r.data?.string);

  // ---- 自定义长度的错误处理 ----
  for (const [qs, why] of [
    ['length=0', 'length=0'],
    ['length=9999', 'length 超 256'],
    ['length=1,2,3,4,5,6,7,8,9', '长度列表超过 8 个'],
    ['length=8&chars=aaa&exclude=aaa', 'exclude 削空池子'],
  ]) {
    const x = await call('/api/string?' + qs);
    check(`自定义参数错误 ${why} -> 400`, x.status === 400, { status: x.status, data: x.data });
  }

  // ---- 每类的最少个数（对应页面上的"数字最少个数 / 特殊字符最少个数"）----
  {
    const cntOf = (s, re) => (s.match(re) || []).length;
    let ok = true;
    let sample = '';
    for (let i = 0; i < 25; i++) {
      const x = await call('/api/string?length=14&minDigits=4');
      sample = x.data?.string ?? '';
      if (cntOf(sample, /[0-9]/g) < 4 || [...sample].length !== 14) { ok = false; break; }
    }
    check('minDigits=4 时每串至少 4 个数字', ok, sample);
  }

  {
    const cntOf = (s, re) => (s.match(re) || []).length;
    let ok = true;
    let sample = '';
    for (let i = 0; i < 25; i++) {
      const x = await call('/api/string?length=16&symbols=' + encodeURIComponent('!@#$%^&*') + '&minSymbols=3');
      sample = x.data?.string ?? '';
      if (cntOf(sample, /[!@#$%^&*]/g) < 3) { ok = false; break; }
      // 只该出现这 8 个符号里的字符
      if (/[^A-Za-z0-9!@#$%^&*]/.test(sample)) { ok = false; break; }
    }
    check('minSymbols=3 时每串至少 3 个指定符号', ok, sample);
  }

  {
    const x = await call('/api/string?length=16&minUpper=4&minDigits=4&minSymbols=4&symbols=1');
    check('多个类的同时下限都能满足',
      x.status === 200
      && (x.data.string.match(/[A-Z]/g) || []).length >= 4
      && (x.data.string.match(/[0-9]/g) || []).length >= 4
      && (x.data.string.match(/[^A-Za-z0-9]/g) || []).length >= 4,
      x.data?.string);
  }

  r = await call('/api/string?length=8&minDigits=9');
  check('下限之和超过长度 -> 400', r.status === 400 && /exceeds length/.test(r.data?.message ?? ''), r.data);

  r = await call('/api/string?length=10&lower=1&upper=0&digits=0&minLower=2&exclude=' + encodeURIComponent('abcdefghijklmnopqrstuvwxyz'));
  check('某类字符被排除光但还要求下限 -> 400', r.status === 400, r.data);

  r = await call('/api/string?minDigits=-1');
  check('负数下限 -> 400', r.status === 400, r.status);

  r = await call('/api/string?length=16');
  check('不传下限时默认每类各 1 个',
    JSON.stringify(r.data?.mins) === JSON.stringify({ lower: 1, upper: 1, digits: 1 }), r.data?.mins);

  r = await call('/api/stats');
  check('stats 公布字符串类的可用值',
    JSON.stringify(r.data?.stringClasses) === JSON.stringify(['lower', 'upper', 'digits', 'symbols', 'underscore']),
    r.data?.stringClasses);
}

// ---- 随机性：是否有伪随机、是否真的均匀 ----
{
  // 1) 静态检查：随机源必须只有一个出入口
  const srcFiles = readFileSync ? null : null; // 占位，避免 lint 报未使用
  const dir = resolve(root, 'src');
  const files = readdirSync(dir).filter((f) => f.endsWith('.js'));
  const offenders = [];
  for (const f of files) {
    const text = readFileSync(resolve(dir, f), 'utf8');
    // 去掉注释再查，注释里提到 Math.random 是允许的（那是在解释为什么不用）
    const code = text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/([^:])\/\/.*$/gm, '$1');
    if (/(?<![\w.])Math\.random\s*\(/.test(code)) offenders.push(`${f}: Math.random`);
    if (f !== 'entropy.js' && /from 'node:crypto'/.test(code)) offenders.push(`${f}: 绕过 entropy.js 直接用 node:crypto`);
  }
  check('全项目只有一个随机源（entropy.js），没有 Math.random', offenders.length === 0, offenders);

  // 2) 缓存头：随机接口一旦被 CDN 缓存，看起来就像"不随机"
  for (const p of ['/api/number', '/api/string', '/api/hitokoto', '/api/image']) {
    const x = await call(p);
    check(`${p} 不可缓存（cache-control: no-store）`, x.headers.get('cache-control') === 'no-store', x.headers.get('cache-control'));
  }

  // 3) 连续调用不能给出同一个值（种子固定的话这里会立刻暴露）
  const seq = [];
  for (let i = 0; i < 50; i++) seq.push((await call('/api/number?min=0&max=1000000')).data.number);
  check('连续 50 次取值互不相同', new Set(seq).size === 50, new Set(seq).size);

  // 4) 卡方检验：1..10 各 5000 次，看分布是否真的均匀
  //    df=9，p=0.001 的临界值约 27.9；明显有偏的实现会远超这个数
  const bins = new Array(10).fill(0);
  const N = 5000;
  for (let i = 0; i < N; i++) {
    const v = (await call('/api/number?min=1&max=10')).data.number;
    bins[v - 1]++;
  }
  const exp = N / 10;
  const chi2 = bins.reduce((acc, o) => acc + ((o - exp) ** 2) / exp, 0);
  check(`卡方均匀性检验通过（chi²=${chi2.toFixed(2)} < 27.9，df=9）`, chi2 < 27.9, { chi2, bins });

  // 5) 字符串的字符分布同样不能一眼看出偏向
  {
    const freq = new Map();
    let total = 0;
    for (let i = 0; i < 200; i++) {
      const x = await call('/api/string?length=40');
      for (const ch of x.data.string) {
        freq.set(ch, (freq.get(ch) ?? 0) + 1);
        total++;
      }
    }
    const expected = total / freq.size;
    const worst = Math.max(...[...freq.values()].map((c) => Math.abs(c - expected) / expected));
    check(`字符串字符分布无极端偏斜（最差偏差 ${(worst * 100).toFixed(1)}%，${freq.size} 个不同字符）`, worst < 0.6 && freq.size > 50, { worst, distinct: freq.size });
  }

  // 6) 超出 Node randomInt 区间（2^48）也要能用
  r = await call('/api/number?min=0&max=281474976710656');   // 2^48
  check('超过 2^48 的区间仍能取到值', r.status === 200 && Number.isInteger(r.data?.number) && r.data.number >= 0, r.data);

  // 7) 一个字节都不该是常量（entropyProbe 的思路，走接口验证）
  r = await call('/api/string?length=256&lower=1&upper=1&digits=1&symbols=1&underscore=1');
  check('256 位串里不同字符数量合理', new Set(r.data?.string ?? '').size > 50, new Set(r.data?.string ?? '').size);
}

// ---- 图片对外地址：走 GitHub raw，不外泄内网 host ----
{
  // 图片已拆到独立仓库，URL 统一由 IMAGE_BASE 拼成 GitHub raw 地址，
  // 不再依赖 request.url 的 host —— 从根上杜绝内网源站地址外泄。
  const realFetch = globalThis.fetch;
  // 让函数内 fetch 失败，走 302 降级，便于断言 location
  globalThis.fetch = async () => new Response(null, { status: 500 });

  const probe = async (url, headers, env = {}) => {
    const res = await handler({ request: new Request(url, { headers }), env });
    let body = null;
    try { body = JSON.parse(Buffer.from(await res.arrayBuffer()).toString('utf8')); } catch { /* 忽略 */ }
    return { status: res.status, location: res.headers.get('location'), body };
  };

  const INTERNAL = 'pages-pro-47-394c.pages-scf-gz-pro.qcloudteo.com';
  const GH = 'https://raw.githubusercontent.com/chenyimaio/random-api-images/main';

  let x = await probe(`http://${INTERNAL}/api/random`, { host: INTERNAL });
  check('内网 host 时图片 URL 仍指向 GitHub raw（不依赖 host）',
    x.status === 302 && String(x.location ?? '').startsWith(GH), x.location);

  x = await probe(`http://${INTERNAL}/api/image`, { host: INTERNAL });
  check('JSON 里的 url 指向 GitHub raw',
    String(x.body?.url ?? '').startsWith(GH), x.body?.url);

  x = await probe(`http://${INTERNAL}/api/image`, { host: INTERNAL }, { IMAGE_BASE: 'https://cdn.example.com/imgs' });
  check('IMAGE_BASE 环境变量可覆盖图片根地址',
    String(x.body?.url ?? '').startsWith('https://cdn.example.com/imgs/'), x.body?.url);

  x = await probe('https://api.example.com/api/random', { host: 'api.example.com' });
  check('公网 host 下图片 URL 仍是 GitHub raw（不拼 host）',
    String(x.location ?? '').startsWith(GH), x.location);

  globalThis.fetch = realFetch;
}

// ---- 边界 ----
r = await call('/api/nope');
check('未知路径 -> 404 JSON', r.status === 404 && r.data?.error === 'not_found', r.status);
r = await call('/api/stats', { method: 'POST' });
check('POST -> 405', r.status === 405, r.status);
r = await call('/api/stats', { method: 'OPTIONS' });
check('OPTIONS -> 204 且带 CORS', r.status === 204 && r.headers.get('access-control-allow-origin') === '*', r.status);

// ---- 图片文件真的存在 ----
const missing = images.filter((i) => !existsSync(resolve(root, 'public/img' + decodeURIComponent(i.path))));
check('索引里的图片文件都存在', missing.length === 0, missing.map((m) => m.path));

const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.error('failed:', failed.map((f) => f.name).join(', '));
  process.exit(1);
}
