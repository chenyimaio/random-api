#!/usr/bin/env node
// scripts/fetch-remote.mjs
// 按四类抓取图片素材到 raw-img/ 下对应目录：
//
//   pc/dm        电脑 · 二次元横图        (二次元源，宽图)
//   mobile/dm    手机 · 二次元竖图        (二次元源，竖图)
//   pc/fjbz      电脑 · 风景壁纸横图      (picsum，1920×1080)
//   mobile/fjbz  手机 · 风景壁纸竖图      (picsum，1080×1920)
//
// 四类各 1000 张，共 4000 张。方图不再保留。
//
// 用法：
//   node scripts/fetch-remote.mjs                       # 按各类差额补齐
//   node scripts/fetch-remote.mjs --class pc/dm --target 1000
//   node scripts/fetch-remote.mjs --force              # 忽略断点清单重抓
//
// 断点：每个类目录里的 .manifest.json 记录已抓哈希，重复跑不会重复下载。

import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const RAW = join(ROOT, 'raw-img');

const TARGET_PER_CLASS = 1000;
// 并发与节流：weirain 每秒最多 20 次、高频会封禁几小时；uapis 也有限流。
// 保持低并发 + 每批后停顿，宁可慢一点也不把公开源打挂。
const CONCURRENCY = Number(process.env.FETCH_CONCURRENCY || 4);
const THROTTLE_MS = Number(process.env.FETCH_THROTTLE || 250);
const TIMEOUT_MS = 20000;
const MAX_BYTES = 12 * 1024 * 1024;
const MIN_BYTES = 20 * 1024;

/** 每个类：从哪些源抓。风景类用真实风景照源（weirain / uapis landscape），不用 picsum（随机照片，非风景） */
const UAPIS = 'https://uapis.cn/api/v1/random/image';
const CLASSES = {
  'pc/dm': {
    sources: [
      { name: 'uapis', url: `${UAPIS}?category=acg&type=pc` },
      { name: 'alcy-pc', url: 'https://t.alcy.cc/pc' },
      { name: 'alcy-moez', url: 'https://t.alcy.cc/moez' },
      { name: 'loliapi', url: 'https://api.loliapi.com/acg/' },
    ],
    want: 'landscape',
  },
  'mobile/dm': {
    // 竖屏二次元：alcy-mp 是手机竖屏（池子有限），api.anosu.top 是 Pixiv 代理（多为竖图）
    sources: [
      { name: 'alcy-mp', url: 'https://t.alcy.cc/mp' },
      { name: 'anosu', url: 'https://api.anosu.top/img' },
      { name: 'alcy-moez', url: 'https://t.alcy.cc/moez' },
    ],
    want: 'portrait',
  },
  'pc/fjbz': {
    // 真实风景横图：ltyuanfang 4K 风景（池子深）、uapis landscape-pc、weirain 补充
    sources: [
      { name: 'ltyuanfang', url: 'https://tu.ltyuanfang.cn/api/fengjing.php' },
      { name: 'uapis', url: `${UAPIS}?category=landscape&type=pc` },
      { name: 'weirain-fj', url: 'https://api.weirain.com/fj' },
      { name: 'weirain-pc', url: 'https://api.weirain.com/pc' },
    ],
    want: 'landscape',
  },
  'mobile/fjbz': {
    // 风景竖图：原生竖图源很少。weirain-sj 是竖图；uapis landscape 是横图，
    // 用 want:'any' 收进来，optimize 阶段对 mobile/ 目录居中裁切成竖图。
    sources: [
      { name: 'weirain-sj', url: 'https://api.weirain.com/sj' },
      { name: 'uapis', url: `${UAPIS}?category=landscape&type=pc` },
    ],
    want: 'any',
  },
};

const log = (...a) => console.log('[fetch]', ...a);
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

/** 按文件头判断真实格式，并顺带读出宽高，用于横竖校验 */
function sniff(buf) {
  if (buf.length < 24) return null;
  let fmt = null, w = 0, h = 0;
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    fmt = 'jpg';
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const m = buf[i + 1];
      if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) {
        h = buf.readUInt16BE(i + 5); w = buf.readUInt16BE(i + 7); break;
      }
      const len = buf.readUInt16BE(i + 2);
      if (len < 2) break;
      i += 2 + len;
    }
  } else if (buf.readUInt32BE(0) === 0x89504e47) {
    fmt = 'png'; w = buf.readUInt32BE(16); h = buf.readUInt32BE(20);
  } else if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    fmt = 'webp';
    const kind = buf.toString('ascii', 12, 16);
    if (kind === 'VP8X') {
      w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
      h = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
    } else if (kind === 'VP8 ') {
      w = buf.readUInt16LE(26) & 0x3fff; h = buf.readUInt16LE(28) & 0x3fff;
    } else if (kind === 'VP8L') {
      const b = buf.readUInt32LE(21);
      w = (b & 0x3fff) + 1; h = ((b >> 14) & 0x3fff) + 1;
    }
  } else if (buf.toString('ascii', 4, 8) === 'ftyp') {
    const brand = buf.toString('ascii', 8, 12);
    fmt = brand.startsWith('avif') ? 'avif' : (brand.startsWith('heic') || brand.startsWith('mif1') ? 'heic' : null);
  }
  const idx = buf.indexOf('ispe', 0, 'ascii');
  if (!w && idx > 0 && idx + 16 <= buf.length) {
    w = buf.readUInt32BE(idx + 8); h = buf.readUInt32BE(idx + 12);
  }
  return fmt ? { fmt, w, h } : null;
}

function isWanted(w, h, want) {
  if (!w || !h) return true; // 读不出尺寸就先收下，optimize 阶段再判
  if (!want || want === 'any') return true; // any = 不筛朝向，横竖都收（竖图类会靠横图裁切补足）
  const r = w / h;
  return want === 'landscape' ? r >= 1.15 : r <= 0.87;
}

async function fetchOnce(url) {
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      accept: 'image/avif,image/webp,image/*,*/*;q=0.8',
      'user-agent': 'random-api/1.0 (+personal gallery)',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function fetchWithRetry(url, tries = 3) {
  let last;
  for (let i = 1; i <= tries; i++) {
    try { return await fetchOnce(url); }
    catch (e) {
      last = e;
      // 429 是限流，退避久一点，别把公开接口打挂
      const wait = String(e.message).includes('429') ? 1500 * i : 400 * i;
      if (i < tries) await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw last;
}

const argv = process.argv.slice(2);
const arg = (flag, def) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const onlyClasses = (arg('--class', '')).split(',').map((s) => s.trim()).filter(Boolean);
const target = Number(arg('--target', TARGET_PER_CLASS));
const force = argv.includes('--force');

async function grabClass(cls) {
  const cfg = CLASSES[cls];
  const dir = join(RAW, cls);
  mkdirSync(dir, { recursive: true });
  const mf = join(dir, '.manifest.json');
  const manifest = existsSync(mf) && !force ? JSON.parse(readFileSync(mf, 'utf8')) : {};
  const known = new Set(Object.keys(manifest));

  // 已有文件数（不含 manifest）
  const have = readdirSync(dir).filter((f) => !f.startsWith('.')).length;
  let need = Math.max(0, target - have);
  if (!need) { log(`  ${cls.padEnd(13)} 已有 ${have}，无需补`); return; }
  log(`  ${cls.padEnd(13)} 已有 ${have}，需补 ${need}`);

  let saved = 0, attempts = 0;
  const started = Date.now();
  let srcIdx = 0;

  while (saved < need && attempts < need * 15) {
    const batch = [];
    for (let k = 0; k < CONCURRENCY && saved + batch.length < need; k++) {
      const src = cfg.sources[srcIdx % cfg.sources.length];
      srcIdx++;
      let url = src.url;
      if (url.includes('{seed}')) {
        url = url.replace('{seed}', `${cls.replace('/', '-')}-${Date.now().toString(36)}-${attempts}-${k}-${Math.random().toString(36).slice(2, 8)}`);
      }
      batch.push({ src, url });
    }

    await Promise.all(batch.map(async ({ src, url }) => {
      attempts++;
      try {
        const buf = await fetchWithRetry(url);
        if (buf.length < MIN_BYTES) throw new Error(`太小 ${buf.length}B`);
        if (buf.length > MAX_BYTES) throw new Error(`太大 ${(buf.length / 1048576).toFixed(1)}MB`);
        const info = sniff(buf);
        if (!info) throw new Error('不是图片');
        if (!isWanted(info.w, info.h, cfg.want)) throw new Error(`朝向不符 ${info.w}x${info.h}`);
        const h = sha(buf);
        if (known.has(h)) return;
        known.add(h);
        const file = join(dir, `${src.name}-${h.slice(0, 8)}.${info.fmt}`);
        writeFileSync(file, buf);
        manifest[h] = { url, source: src.name, bytes: buf.length, format: info.fmt, w: info.w, h: info.h };
        saved++;
        if (saved % 100 === 0 || saved === need) {
          log(`    ${cls} 已补 ${saved}/${need}（${((Date.now() - started) / 1000).toFixed(0)}s）`);
        }
      } catch { /* 单个失败忽略，继续补 */ }
      await new Promise((r) => setTimeout(r, THROTTLE_MS));
    }));
  }

  writeFileSync(mf, JSON.stringify(manifest), 'utf8');
  log(`  ${cls.padEnd(13)} 完成：新补 ${saved} 张，累计 ${have + saved}`);
}

try {
  const classes = onlyClasses.length ? onlyClasses : Object.keys(CLASSES);
  log(`目标每类 ${target} 张，类别：${classes.join(', ')}`);
  // 顺序跑各类，避免同一时刻把某个源打太猛
  for (const cls of classes) {
    if (!CLASSES[cls]) { log(`未知类别 ${cls}，跳过`); continue; }
    await grabClass(cls);
  }
  log('完成。下一步：npm run img && npm run gen && npm run build');
} catch (e) {
  log('中断：', e.message);
  process.exit(1);
}
