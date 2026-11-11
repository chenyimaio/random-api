#!/usr/bin/env node
// scripts/gen-images.mjs
// 扫 public/img，生成 data/images.json。
//
// 「往 raw-img 丢原图 → npm run img → npm run gen」就能新增图片，不用改代码。
//
// 目录与命名约定（由 optimize-images.py 生成）：
//   public/img/pc/dm/<stem>.{avif,webp}          电脑 · 二次元横图
//   public/img/mobile/dm/<stem>.{avif,webp}      手机 · 二次元竖图
//   public/img/pc/fjbz/<stem>.{avif,webp}        电脑 · 风景壁纸横图
//   public/img/mobile/fjbz/<stem>.{avif,webp}    手机 · 风景壁纸竖图
//
// 路径即 API 分类：device = pc|mobile，genre = dm|fjbz。
// 索引里每张图带一个 formats 映射，接口据此按 Accept 或 ?format= 挑格式。
// 朝向以目录所属类别为准（比单张图的宽高比更可靠），宽高仍会记录供展示。

// 类别表：路径两段 → 语义
export const CLASSES = {
  'pc/dm':       { device: 'pc',     genre: 'dm',   orientation: 'landscape', label: '电脑·二次元' },
  'mobile/dm':   { device: 'mobile', genre: 'dm',   orientation: 'portrait',  label: '手机·二次元' },
  'pc/fjbz':     { device: 'pc',     genre: 'fjbz', orientation: 'landscape', label: '电脑·风景' },
  'mobile/fjbz': { device: 'mobile', genre: 'fjbz', orientation: 'portrait',  label: '手机·风景' },
};

import { readdirSync, statSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative, dirname, extname, basename, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const IMG_DIR = join(ROOT, 'public', 'img');
const OUT = join(ROOT, 'data', 'images.json');

// 支持的格式：key 是接口里 ?format= 取的值，value 是 MIME 和优先级
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
const EXT_TO_FORMAT = {
  '.avif': 'avif',
  '.webp': 'webp',
  '.jpg': 'jpeg',
  '.jpeg': 'jpeg',
  '.jfif': 'jpeg',
  '.png': 'png',
  // 下面这些浏览器多半显示不了，但索引仍然收进来（"放进去就能调用"），
  // 只是会告警提醒走 raw-img + npm run img 转成 webp/avif。
  '.gif': 'gif',
  '.bmp': 'bmp',
  '.tif': 'tiff',
  '.tiff': 'tiff',
  '.heic': 'heic',
  '.heif': 'heif',
};
const EXT = new Set(Object.keys(EXT_TO_FORMAT));

// 阈值必须和 optimize-images.py 一致：>=1.15 横，<=0.87 竖，其余方
const orientationOf = (w, h) => {
  if (!w || !h) return 'unknown';
  const r = w / h;
  if (r >= 1.15) return 'landscape';
  if (r <= 0.87) return 'portrait';
  return 'square';
};

// ---- 读宽高：只解析文件头，不依赖任何图像库 ----
// 返回 null 表示识别不了（不影响出图，只是 JSON 里没有宽高 / 朝向未知）

function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function gifSize(buf) {
  if (buf.length < 10 || buf.toString('ascii', 0, 3) !== 'GIF') return null;
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
}

function jpegSize(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    // SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15 里带尺寸
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    const len = buf.readUInt16BE(i + 2);
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

function webpSize(buf) {
  if (buf.length < 30 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') return null;
  const kind = buf.toString('ascii', 12, 16);
  if (kind === 'VP8X') {
    const w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
    const h = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
    return { width: w, height: h };
  }
  if (kind === 'VP8 ') {
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  if (kind === 'VP8L') {
    const b = buf.readUInt32LE(21);
    return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
  }
  return null;
}

/**
 * AVIF 是 ISOBMFF 容器：找到 'ispe' box（Image Spatial Extents），
 * 跳过 4 字节 version/flags 后是 width / height（各 4 字节大端）。
 * 一个文件中可能有多个 ispe（缩略图等），取第一个通常就是主图。
 */
function avifSize(buf) {
  const idx = buf.indexOf('ispe', 0, 'ascii');
  if (idx < 0) return null;
  if (idx + 16 > buf.length) return null;
  const width = buf.readUInt32BE(idx + 8);
  const height = buf.readUInt32BE(idx + 12);
  if (!width || !height || width > 100000 || height > 100000) return null;
  return { width, height };
}

function sizeOf(buf, ext) {
  try {
    if (ext === '.png') return pngSize(buf);
    if (ext === '.gif') return gifSize(buf);
    if (ext === '.jpg' || ext === '.jpeg') return jpegSize(buf);
    if (ext === '.webp') return webpSize(buf);
    if (ext === '.avif') return avifSize(buf);
  } catch {
    /* 头部损坏就当读不到 */
  }
  return null;
}

// ---- 扫描 ----

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

mkdirSync(dirname(OUT), { recursive: true });

if (!statSync(IMG_DIR, { throwIfNoEntry: false })) {
  writeFileSync(OUT, '[]\n', 'utf8');
  console.log('[gen-images] public/img 不存在，写入空索引');
  process.exit(0);
}

// 先按 (目录, stem) 聚合同一张图的不同格式
const groups = new Map();
for (const full of walk(IMG_DIR)) {
  const ext = extname(full).toLowerCase();
  if (!EXT.has(ext)) continue;

  const rel = relative(IMG_DIR, full).split(sep).join('/');
  const dir = dirname(rel) === '.' ? '' : dirname(rel).split(sep).join('/');
  const stem = basename(rel, extname(rel));
  const key = `${dir}/${stem}`;

  const buf = readFileSync(full);
  const format = EXT_TO_FORMAT[ext];
  const size = sizeOf(buf, ext);

  if (!groups.has(key)) groups.set(key, { dir, stem, formats: {}, size: null });
  const g = groups.get(key);
  // path 是相对「图片仓库根」的路径（图片已拆到独立仓库 random-api-images，
  // 由 app.js 用 IMAGE_BASE 拼成 GitHub raw 地址）。这里不带 /img 前缀了。
  g.formats[format] = { path: `/${encodeURI(rel)}`, bytes: buf.length };
  // 用哪个文件读宽高都行；avif/webp 都支持，取第一个能读到的
  if (!g.size && size) g.size = size;
}

const images = [];
let mismatch = 0;
let unknownClass = 0;
for (const key of [...groups.keys()].sort()) {
  const g = groups.get(key);
  const w = g.size?.width ?? null;
  const h = g.size?.height ?? null;

  const cls = CLASSES[g.dir] ?? null;
  if (!cls && g.dir) unknownClass += 1;

  // 朝向以类别为准；读不出类别时才退回宽高比推断
  const orientation = cls ? cls.orientation : orientationOf(w, h);

  // 默认格式：webp 兼容性最好；没有 webp 就取优先级最高的那个
  const available = Object.keys(g.formats).sort((a, b) => FORMATS[b].rank - FORMATS[a].rank);
  const def = available.includes('webp') ? 'webp' : available[0];

  // 实际比例与类别期望不符时告警（不阻塞，仅提示素材可能放错目录）
  if (cls && w && h) {
    const actual = orientationOf(w, h);
    if (actual !== 'unknown' && actual !== cls.orientation) {
      mismatch += 1;
      console.warn(`[gen-images] 类别与比例不符: ${key} 类别=${g.dir}(${cls.orientation}) 实际=${actual} (${w}x${h})`);
    }
  }

  // tags 让 ?tag=pc / ?tag=mobile / ?tag=dm / ?tag=fjbz / ?tag=pc/dm 都能过滤
  const tags = cls
    ? [cls.device, cls.genre, g.dir]
    : (g.dir ? g.dir.split('/') : []);

  images.push({
    name: key,
    class: g.dir || null,          // 'pc/dm' 等，页面/接口可直接用
    device: cls?.device ?? null,
    genre: cls?.genre ?? null,
    tags,
    orientation,
    width: w,
    height: h,
    defaultFormat: def,
    path: g.formats[def].path,       // 默认格式的路径，兼容只认 path 的调用方
    bytes: g.formats[def].bytes,
    formats: g.formats,              // { webp: {path,bytes}, avif: {...} }
  });
}

writeFileSync(OUT, JSON.stringify(images, null, 2) + '\n', 'utf8');

const byOrient = images.reduce((acc, i) => ({ ...acc, [i.orientation]: (acc[i.orientation] ?? 0) + 1 }), {});
const byFormat = images.reduce((acc, i) => {
  for (const f of Object.keys(i.formats)) acc[f] = (acc[f] ?? 0) + 1;
  return acc;
}, {});
const totalDefault = images.reduce((n, i) => n + i.bytes, 0);
const fmt = Object.entries(byFormat).map(([k, v]) => `${k} ${v}`).join('  ');

const byClass = images.reduce((acc, i) => ({ ...acc, [i.class ?? '(无)']: (acc[i.class ?? '(无)'] ?? 0) + 1 }), {});
console.log(`[gen-images] ${images.length} 张图 -> data/images.json`);
for (const c of Object.keys(CLASSES)) console.log(`[gen-images]   ${c.padEnd(14)} ${byClass[c] ?? 0} 张`);
console.log(`[gen-images] 朝向: 横 ${byOrient.landscape ?? 0}  竖 ${byOrient.portrait ?? 0}  方 ${byOrient.square ?? 0}` +
  (mismatch ? `  ⚠ 类别与比例不符 ${mismatch} 张` : '') +
  (unknownClass ? `  ⚠ 未知类别 ${unknownClass} 张` : ''));
console.log(`[gen-images] 格式: ${fmt}`);
console.log(`[gen-images] 默认格式总体积 ${(totalDefault / 1024 / 1024).toFixed(2)} MB`);
