// 极简 HTTP 处理器：零依赖，不引入框架。
// 路由表很小，而且全部是 GET，用不着 Hono 那一层。
//
// 路由：
//   GET /api/hitokoto      一言（兼容 hitokoto 的 JSON 形状）
//   GET /api/quote         一言（简版字段）
//   GET /api/quotes?n=5    批量随机
//   GET /api/image         图片信息（JSON）
//   GET /api/random        302 到随机图片本身（可直接当 <img src> 用）
//   GET /api/all           一言 + 图片一起给
//   GET /api/stats         数量统计，方便确认部署成功
//
// 朝向自适应：orientation=auto（默认）时按 User-Agent 判断——
// 手机给竖图、电脑给横图；也可以用 ?orientation=landscape|portrait|square 显式指定。
//
// 全部允许跨域（这是个给别的页面调用的公共接口），随机接口不缓存。

import {
  randomQuote, randomQuotes, quoteCount, quoteTypes, quoteSources, quoteCountByType,
  dailyQuote, dateKeyIn, secondsUntilNextDay,
} from './quotes.js';
import {
  randomImage, allImages, imageCount, imageTags, imageCounts, imageClassCounts, imageFormatCounts, pickFormat, FORMATS, CLASSES, ORIENTATIONS,
} from './images.js';
import { randomNumbers, parseNumberQuery, LIMITS as NUMBER_LIMITS } from './numbers.js';
import { randomStrings, parseStringQuery, CLASSES as STRING_CLASSES, LIMITS as STRING_LIMITS } from './strings.js';

// 手机 UA 的关键词。iPad 故意排除：平板多数时候是横屏浏览。
const MOBILE_RE = /Mobi|Android|iPhone|iPod|Windows Phone|BlackBerry|IEMobile|Opera Mini/i;
const TABLET_RE = /iPad|Tablet|PlayBook|Silk/i;

/**
 * 决定这次该给横图还是竖图。
 * 显式参数优先；否则按设备；再否则横图（电脑端最常见）。
 */
function pickOrientation(param, request) {
  const explicit = String(param ?? '').toLowerCase();
  if (explicit && explicit !== 'auto') return explicit;

  const ua = String(request?.headers?.get?.('user-agent') ?? '');
  if (!ua) return 'landscape';
  if (TABLET_RE.test(ua)) return 'landscape';
  if (MOBILE_RE.test(ua)) return 'portrait';
  return 'landscape';
}

// 部署自检用。API_VERSION 由人维护，BUILD_ID 由 scripts/build.mjs 在打包时注入
// （git 短 sha + 时间）。线上 /api/stats 会把两者回显出来 ——
// 只凭一个字段就能判断"跑的是不是最新代码"，不用再靠猜。
export const API_VERSION = '1.3.0';

const BUILD_ID = typeof __BUILD_ID__ !== 'undefined' ? __BUILD_ID__ : 'dev';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, HEAD, OPTIONS',
  'access-control-max-age': '86400',
};

const JSON_HEADERS = {
  ...CORS,
  'content-type': 'application/json; charset=utf-8',
  // 随机接口必须不缓存：被 CDN 缓存住就变成"固定"接口了
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...extra } });

// request.url 在 Makers 里是绝对地址，但也做一次容错
function parseUrl(request) {
  const raw = String(request?.url ?? '');
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return new URL(raw);
  } catch {
    /* 落到相对形式 */
  }
  try {
    return new URL(raw || '/', 'http://placeholder.local');
  } catch {
    return new URL('http://placeholder.local/');
  }
}

/**
 * 判断是不是平台内部主机名。
 *
 * EdgeOne 会把请求转发到源站，函数里 request.url 的 host 是内网地址
 * （实测形如 pages-pro-47-394c.pages-scf-gz-pro.qcloudteo.com）。
 * 拿它拼出来的绝对地址外网访问不到，而且会泄露内部拓扑。
 */
function isInternalHost(host) {
  return /qcloudteo\.com|pages-scf|\.internal$/i.test(String(host ?? ''))
    || /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(String(host ?? ''));
}

/**
 * 对外可用的站点根地址。优先级：
 *   1. BASE_URL 环境变量（最稳，显式声明公网地址）
 *   2. x-forwarded-proto + x-forwarded-host（平台/反代一般都会带）
 *   3. host 头（只要不是内网地址）
 *   4. 都给不出 → 返回空串，调用方改用相对路径
 *
 * 返回空串时 absUrl 会输出"/img/..."这样的相对地址 ——
 * 302 的 Location 允许相对路径，浏览器会按当前站点补全，永远是对的。
 */
function publicBase(request, env) {
  const configured = env?.BASE_URL;
  if (configured && String(configured).trim()) {
    return String(configured).trim().replace(/\/+$/, '');
  }

  const h = request?.headers;
  if (!h || typeof h.get !== 'function') return '';

  const first = (name) => String(h.get(name) ?? '').split(',')[0].trim();

  const proto = first('x-forwarded-proto') || first('x-forwarded-scheme');
  const fwdHost = first('x-forwarded-host');
  if (fwdHost && !isInternalHost(fwdHost)) {
    return `${proto || 'https'}://${fwdHost}`;
  }

  const host = first('host');
  if (host && !isInternalHost(host)) {
    return `${proto || 'http'}://${host}`;
  }

  return '';
}

/** 把站点内路径补成绝对地址；拿不到公网根地址时返回相对路径 */
function absUrl(u, origin) {
  if (!u) return u;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) return u;
  if (!origin) return u;
  try {
    return new URL(u, origin).toString();
  } catch {
    return u;
  }
}

const withUrl = (img, origin) => {
  if (!img) return null;
  const formats = {};
  for (const [name, f] of Object.entries(img.formats ?? {})) {
    formats[name] = { url: absUrl(f.path, origin), bytes: f.bytes };
  }
  return {
    name: img.name,
    // url 默认指向默认格式；下面会被 pickFormat 的结果覆盖
    url: absUrl(img.path, origin),
    width: img.width,
    height: img.height,
    orientation: img.orientation,
    class: img.class ?? null,
    device: img.device ?? null,
    genre: img.genre ?? null,
    tags: img.tags ?? [],
    bytes: img.bytes,
    defaultFormat: img.defaultFormat,
    formats,
  };
};

/**
 * 把"选好的格式"落到输出上：换掉 url/bytes，附上可用格式清单。
 * fallback 非空表示请求的格式这张图没有（调用方据此决定要不要提示）。
 */
function applyFormat(out, img, picked, origin) {
  const fmt = picked.format;
  const chosen = img.formats[fmt];
  return {
    ...out,
    url: absUrl(chosen.path, origin),
    bytes: chosen.bytes,
    format: fmt,
    ...(picked.fallback ? { requestedFormat: picked.fallback } : {}),
  };
}

function hitokotoShape(q, origin) {
  // 对齐 hitokoto v1 的字段名，现成的一言组件可以直接用
  return {
    id: q.id,
    uuid: `qa-${String(q.id).padStart(6, '0')}`,
    hitokoto: q.hitokoto,
    type: q.type,
    from: q.from,
    from_who: q.from_who,
    creator: q.creator,
    created_at: q.created_at,
    length: q.length,
    source: absUrl('/api/stats', origin),
  };
}

async function handle(request, url, env) {
  const path = url.pathname.replace(/\/+$/, '') || '/';
  // 用公网根地址，不能用 url.origin —— 那是平台内网源站，外网访问不到
  const origin = publicBase(request, env);
  const q = url.searchParams;
  // 每次请求只算一次，random/all 共用同一个朝向判断
  const orientation = pickOrientation(q.get('orientation'), request);
  // 简短路径 /pc/dm 等：等价于 ?class=pc/dm，且优先级高于查询参数
  const pathClass = /^\/(pc|mobile)\/(dm|fjbz)$/i.exec(path)?.[0]?.slice(1).toLowerCase() ?? null;
  const classFilter = pathClass ?? q.get('class');
  const deviceParam = q.get('device');
  const genreParam = q.get('genre');

  // 自适应接口也带分类能力：
  //   - 显式给了 class 或 device 就以它为准（朝向跟着类别，见 CLASSES）
  //   - 只给了 genre（如 ?genre=fjbz）时，按 UA 自动补 device，
  //     拼成完整类别：手机 → mobile/fjbz，电脑 → pc/fjbz
  //   - 什么都没给 → 保持原来的纯 UA 朝向判断，行为不变
  let resolvedClass = classFilter && CLASSES[classFilter] ? classFilter : null;
  if (!resolvedClass && (deviceParam || genreParam)) {
    const device = String(deviceParam ?? '').toLowerCase()
      || (orientation === 'portrait' ? 'mobile' : 'pc');
    const genre = String(genreParam ?? '').toLowerCase() || 'dm';
    const candidate = `${device}/${genre}`;
    if (CLASSES[candidate]) resolvedClass = candidate;
  }
  // 类别确定后，朝向用类别自身的 —— 但显式 ?orientation= 仍优先（用户手动指定最大）
  const explicitOrientation = String(q.get('orientation') ?? '').toLowerCase();
  const orientationExplicit = explicitOrientation && explicitOrientation !== 'auto' && ORIENTATIONS.includes(explicitOrientation);
  const effectiveOrientation = orientationExplicit
    ? explicitOrientation
    : (resolvedClass ? CLASSES[resolvedClass].orientation : orientation);

  const imageFilter = {
    tag: q.get('tag'),
    class: resolvedClass,
    device: resolvedClass ? CLASSES[resolvedClass].device : deviceParam,
    genre: resolvedClass ? CLASSES[resolvedClass].genre : genreParam,
    orientation: effectiveOrientation,
  };

  if (path === '/api/stats') {
    return json({
      version: API_VERSION,
      build: BUILD_ID,
      quotes: quoteCount,
      quoteTypes,
      quoteCountByType,
      quoteSources,
      images: imageCount,
      imageCounts,
      imageClassCounts,
      imageFormatCounts,
      formats: Object.keys(FORMATS),
      classes: Object.keys(CLASSES),
      classPaths: ['/pc/dm', '/mobile/dm', '/pc/fjbz', '/mobile/fjbz'],
      imageTags,
      endpoints: ['/api/hitokoto', '/api/daily', '/api/quote', '/api/quotes', '/api/number', '/api/string', '/api/image', '/api/random', '/api/all', '/api/images'],
      numberLimits: NUMBER_LIMITS,
      stringLimits: STRING_LIMITS,
      stringClasses: Object.keys(STRING_CLASSES),
      orientationParam: 'auto | landscape | portrait | square',
      formatParam: 'auto | ' + Object.keys(FORMATS).join(' | '),
    });
  }

  if (path === '/api/hitokoto' || path === '/api/quote') {
    const item = randomQuote({ type: q.get('type') });
    if (!item) return json({ error: 'no quote for that type', type: q.get('type') }, 404);
    return json(path === '/api/hitokoto' ? hitokotoShape(item, origin) : {
      quote: item.hitokoto,
      from: item.from,
      fromWho: item.from_who,
      type: item.type,
    });
  }

  // 随机数：?min=&max=&n=&unique=&decimals=
  if (path === '/api/number') {
    const parsed = parseNumberQuery(q);
    if (!parsed.ok) {
      return json({ error: 'invalid_parameter', message: parsed.error, ...(parsed.detail ?? {}) }, 400);
    }
    const { min, max, count, unique, decimals } = parsed.opts;
    const values = randomNumbers(parsed.opts);
    const type = decimals === null ? 'int' : 'float';

    // n=1 时给一个单数字段，省得调用方写 numbers[0]
    if (count === 1) {
      return json({ number: values[0], min, max, type, ...(decimals !== null ? { decimals } : {}), unique });
    }
    return json({
      numbers: values,
      count: values.length,
      min,
      max,
      type,
      ...(decimals !== null ? { decimals } : {}),
      unique,
    });
  }

  // 随机字符串 / 口令：?length=16&lower=1&upper=1&digits=1&symbols=0&underscore=0
  if (path === '/api/string') {
    const parsed = parseStringQuery(q);
    if (!parsed.ok) {
      return json({ error: 'invalid_parameter', message: parsed.error, ...(parsed.classes ? { classes: parsed.classes } : {}) }, 400);
    }
    const { lengths, count, on, chars, exclude, noAmbiguous, poolSize, mins } = parsed.opts;
    const values = randomStrings(parsed.opts);

    const meta = {
      // 单个长度时给 length，给了列表时给 lengths（并回显实际每个串的长度）
      ...(lengths.length === 1 ? { length: lengths[0] } : { lengths }),
      poolSize,
      mins,
      ...(chars ? { chars } : { classes: on }),
      ...(exclude ? { excluded: exclude } : {}),
      ...(noAmbiguous ? { noAmbiguous: true } : {}),
    };

    if (count === 1) return json({ string: values[0], ...meta });
    return json({ strings: values, count: values.length, ...meta });
  }

  // 每日一句：同一天所有人拿到同一句，跨天自动换。
  if (path === '/api/daily') {
    const tz = q.get('tz') || 'UTC';
    const asked = q.get('date');

    // 显式指定日期时校验：光看格式不够，2026-13-99 也能过正则，
    // 而 Date.UTC 会把它顺延成一个合法日期（2027-04-09），悄悄返回错的句子。
    if (asked) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(asked)) {
        return json({ error: 'invalid_date', hint: 'use YYYY-MM-DD', got: asked }, 400);
      }
      const [y, m, d] = asked.split('-').map(Number);
      const round = new Date(Date.UTC(y, m - 1, d));
      if (round.getUTCFullYear() !== y || round.getUTCMonth() !== m - 1 || round.getUTCDate() !== d) {
        return json({ error: 'invalid_date', hint: 'that calendar date does not exist', got: asked }, 400);
      }
    }

    const date = asked || dateKeyIn(tz);
    const got = dailyQuote({ date, type: q.get('type') });
    if (!got) return json({ error: 'no quote for that type', type: q.get('type') }, 404);

    // 缓存到该时区的下一天零点：同一天内无论谁访问、访问多少次，内容都一样，
    // 所以可以放心让 CDN 和浏览器一起缓存。
    const ttl = asked ? 86400 : secondsUntilNextDay(tz);
    return json({
      ...hitokotoShape(got.quote, origin),
      date: got.date,
      timezone: tz,
      // 下次换句的大致时刻，方便调用方自己排定时任务
      nextUpdate: new Date(Date.now() + ttl * 1000).toISOString(),
      daily: true,
    }, 200, {
      'cache-control': `public, max-age=${ttl}`,
      etag: `"daily-${got.date}-${got.quote.id}"`,
    });
  }

  if (path === '/api/quotes') {
    const n = Number(q.get('n') ?? 5);
    return json({ total: quoteCount, items: randomQuotes(n).map((x) => hitokotoShape(x, origin)) });
  }

  if (path === '/api/image') {
    const img = randomImage(imageFilter);
    if (!img) return json({ error: 'no image for that tag', tag: q.get('tag') }, 404);
    const picked = pickFormat(img, { requested: q.get('format'), accept: request?.headers?.get?.('accept') });
    // orientation 保留图片**自身**的朝向（可能是方图），请求的意图放在 requestedOrientation
    const out = applyFormat(withUrl(img, origin), img, picked, origin);
    return json({ ...out, requestedOrientation: effectiveOrientation, ...(resolvedClass ? { class: resolvedClass } : {}) }, 200, { vary: 'Accept' });
  }

  // /api/random 与四个简短路径 /pc/dm、/mobile/dm、/pc/fjbz、/mobile/fjbz
  // 走同一套"直返图片字节"逻辑。简短路径自带 class 过滤。
  if (path === '/api/random' || pathClass) {
    const img = randomImage(imageFilter);
    if (!img) return json({ error: 'no image for that class', class: classFilter }, 404);
    const picked = pickFormat(img, { requested: q.get('format'), accept: request?.headers?.get?.('accept') });
    const chosen = img.formats[picked.format];
    const mime = FORMATS[picked.format]?.mime ?? 'application/octet-stream';

    const baseHeaders = {
      ...CORS,
      'x-image-orientation': img.orientation,
      'x-image-format': picked.format,
      ...(img.class ? { 'x-image-class': img.class } : {}),
      ...(picked.fallback ? { 'x-format-fallback': picked.fallback } : {}),
      // 同一 URL 会因为 Accept 不同返回不同格式，必须告诉缓存按 Accept 分桶
      vary: 'Accept',
      // 关键：no-store。每次刷新都重新请求 → 函数重新随机 → 一定是新图
      'cache-control': 'no-store, private',
    };

    // 图片在 EdgeOne 静态层（public/img），302 到相对路径，浏览器直接加载（同域、快）。
    // 地址栏会跳到 /img/...，但这是加载最快的方式 —— 不经过函数 fetch，零代理开销。
    return new Response(null, {
      status: 302,
      headers: {
        ...baseHeaders,
        location: absUrl(chosen.path, origin),
        'content-type': mime,
      },
    });
  }

  if (path === '/api/all') {
    const item = randomQuote({ type: q.get('type') });
    const img = randomImage(imageFilter);
    if (!item && !img) return json({ error: 'empty dataset' }, 404);
    const picked = img ? pickFormat(img, { requested: q.get('format'), accept: request?.headers?.get?.('accept') }) : null;
    return json({
      quote: item ? hitokotoShape(item, origin) : null,
      // 同上：图片对象保留自身朝向，请求意图单列
      image: img ? applyFormat(withUrl(img, origin), img, picked, origin) : null,
      requestedOrientation: effectiveOrientation,
      ...(resolvedClass ? { class: resolvedClass } : {}),
    }, 200, { vary: 'Accept' });
  }

  if (path === '/api/images') {
    return json({
      total: imageCount,
      counts: imageCounts,
      formatCounts: imageFormatCounts,
      formats: Object.keys(FORMATS),
      items: allImages().map((i) => withUrl(i, origin)),
    });
  }

  // 其余交给静态层；本地 dev 时由 dev 脚本兜底
  return json({ error: 'not_found', path }, 404);
}

/**
 * 既能被测试当 handler({ request, env }) 调用，
 * 也能被 makers.js 按 app.fetch(request, env, ctx) 三参数调用 ——
 * 两种形态都必须认，否则线上环境变量会静默失效。
 */
async function handler(context, envArg, ctxArg) {
  const request = context?.request ?? context;
  const env = context?.env ?? envArg ?? ctxArg?.env ?? (typeof process !== 'undefined' ? process.env : {});
  const url = parseUrl(request);
  const method = String(request?.method ?? 'GET').toUpperCase();

  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (method !== 'GET' && method !== 'HEAD') {
    return json({ error: 'method_not_allowed' }, 405, { allow: 'GET, HEAD, OPTIONS' });
  }

  return await handle(request, url, env);
}

// 兼容 Makers 的几种调用约定（和既有的服务端保持一致）
handler.fetch = handler;
handler.onRequest = handler;

export default handler;
export { handler as onRequest, handler as fetch };
