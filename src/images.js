// 图片索引。由 data/images.json 在构建期内联 —— 索引是 gen-images 扫目录生成的，
// 所以「往 raw-img 丢图 → npm run img → npm run gen」就能新增，不需要改代码。
import { securePick } from './entropy.js';
import all from '../data/images.json';

const images = Array.isArray(all) ? all : [];

export const imageCount = images.length;

// 四类路径。方图已取消，只保留横/竖两种朝向。
export const ORIENTATIONS = ['landscape', 'portrait'];

export const CLASSES = {
  'pc/dm':       { device: 'pc',     genre: 'dm',   orientation: 'landscape' },
  'mobile/dm':   { device: 'mobile', genre: 'dm',   orientation: 'portrait'  },
  'pc/fjbz':     { device: 'pc',     genre: 'fjbz', orientation: 'landscape' },
  'mobile/fjbz': { device: 'mobile', genre: 'fjbz', orientation: 'portrait'  },
};

// 支持哪些格式、以及协商时的优先级。数字大的优先。
// 主推 avif / webp；jpeg 兜底层已下线，保留条目只为让 ?format=jpeg / Accept: image/jpeg
// 能优雅回退到 webp，而不是直接 404。
export const FORMATS = {
  avif: { mime: 'image/avif', rank: 6 },
  webp: { mime: 'image/webp', rank: 5 },
  jpeg: { mime: 'image/jpeg', rank: 4 },
  png: { mime: 'image/png', rank: 3 },
  gif: { mime: 'image/gif', rank: 2 },
  bmp: { mime: 'image/bmp', rank: 1 },
  tiff: { mime: 'image/tiff', rank: 1 },
  heic: { mime: 'image/heic', rank: 1 },
  heif: { mime: 'image/heif', rank: 1 },
};

// 「依次回退」的顺序：新 → 旧，越靠后兼容性越好。
// 产物只有 avif / webp 两份，jpeg 这一格留着是为了让老客户端
// 请求 jpeg 时能顺着链落到 webp，而不是拿不到图。
export const FALLBACK_CHAIN = ['avif', 'webp', 'jpeg'];

/**
 * 按类别 / 朝向挑图。
 *
 * 过滤维度（可叠加）：
 *   class  : 'pc/dm' | 'mobile/dm' | 'pc/fjbz' | 'mobile/fjbz'
 *   device : 'pc' | 'mobile'   genre : 'dm' | 'fjbz'
 *   tag    : 兼容旧用法，匹配 tags 里的任一项
 *   orientation : 'landscape' | 'portrait'（默认 auto 由 UA 判断，不传就不过滤）
 *
 * 求的是"总有图可给"：某个过滤条件池子为空就退回全部，不直接 404。
 */
export function randomImage({ tag, orientation, class: cls, device, genre } = {}) {
  let pool = images;

  if (cls) {
    const want = String(cls).toLowerCase();
    const hit = pool.filter((img) => String(img.class ?? '').toLowerCase() === want);
    if (hit.length) pool = hit;
  }
  if (device) {
    const want = String(device).toLowerCase();
    const hit = pool.filter((img) => String(img.device ?? '').toLowerCase() === want);
    if (hit.length) pool = hit;
  }
  if (genre) {
    const want = String(genre).toLowerCase();
    const hit = pool.filter((img) => String(img.genre ?? '').toLowerCase() === want);
    if (hit.length) pool = hit;
  }
  if (tag) {
    const want = String(tag).toLowerCase();
    const hit = pool.filter((img) => (img.tags ?? []).some((t) => String(t).toLowerCase() === want));
    if (hit.length) pool = hit;
  }

  const want = String(orientation ?? '').toLowerCase();
  if (ORIENTATIONS.includes(want)) {
    const hit = pool.filter((img) => img.orientation === want);
    if (hit.length) pool = hit;
  }

  return pool.length ? securePick(pool) : null;
}

// Accept 头里**明确点名**了哪些图片格式。
//
// 故意不把 `image/x` 通配和全通配展开成"全部格式"：那会让只支持 WebP 的客户端
// （例如 Accept: image/webp, 通配）被塞一个它解不了的 AVIF。
// 通配只代表"其余随意"，落到默认格式最安全。
function acceptedFormats(accept) {
  const s = String(accept ?? '').toLowerCase();
  if (!s) return [];
  const out = [];
  for (const [name, info] of Object.entries(FORMATS)) {
    // image/jpeg 有个常见别名 image/jpg
    const aliases = name === 'jpeg' ? ['image/jpeg', 'image/jpg'] : [info.mime];
    if (aliases.some((m) => s.includes(m))) out.push(name);
  }
  return out;
}

/**
 * 回退到"这张图真有的、且不比请求格式更激进"的格式。
 *
 * 方向很重要：只沿着 avif → webp → jpg 往**兼容性更高**的一侧走。
 * 反过来（jpeg 没有就给 avif）等于假设客户端能解 AVIF，
 * 而它主动要 JPEG 恰恰说明它可能解不了。
 *
 * 未知格式名（比如 ?format=heic）不参与这条链，直接给默认格式。
 */
function firstAvailable(img, preferred) {
  const available = Object.keys(img?.formats ?? {});
  if (!available.length) return null;

  const start = FALLBACK_CHAIN.indexOf(preferred);
  if (start < 0) return img.defaultFormat ?? available[0];

  const down = FALLBACK_CHAIN.slice(start).filter((f) => available.includes(f));
  return down[0] ?? img.defaultFormat ?? available[0];
}

/**
 * 决定这次给哪种格式。
 *
 *   requested（?format=）优先；这张图没有 → 按 avif → webp → jpg 依次回退
 *   否则看 Accept：在客户端明确接受的格式里挑优先级最高的
 *   都没有就用图片自己的默认格式（webp）
 *
 * 返回 { format, fallback }，fallback 非空表示请求的格式这张图没有、已回退。
 */
export function pickFormat(img, { requested, accept } = {}) {
  const available = Object.keys(img?.formats ?? {});
  if (!available.length) return { format: null, fallback: null };

  const want = String(requested ?? '').toLowerCase();
  if (want && want !== 'auto') {
    if (available.includes(want)) return { format: want, fallback: null };
    // 请求的格式没有：按回退链换一个，并把原始意图带回去
    return { format: firstAvailable(img, want), fallback: want };
  }

  const accepted = acceptedFormats(accept)
    .filter((f) => available.includes(f))
    .sort((a, b) => FORMATS[b].rank - FORMATS[a].rank);
  if (accepted.length) return { format: accepted[0], fallback: null };

  return { format: img.defaultFormat ?? available[0], fallback: null };
}

export function allImages() {
  return images;
}

export const imageTags = [...new Set(images.flatMap((i) => i.tags ?? []))].filter(Boolean).sort();

export const imageCounts = images.reduce((acc, i) => {
  acc[i.orientation] = (acc[i.orientation] ?? 0) + 1;
  return acc;
}, {});

export const imageFormatCounts = images.reduce((acc, i) => {
  for (const f of Object.keys(i.formats ?? {})) acc[f] = (acc[f] ?? 0) + 1;
  return acc;
}, {});

export const imageClassCounts = images.reduce((acc, i) => {
  const key = i.class ?? '(无)';
  acc[key] = (acc[key] ?? 0) + 1;
  return acc;
}, {});
