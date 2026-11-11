#!/usr/bin/env node
// scripts/fetch-bing.mjs
// 从 npanuhin/Bing-Wallpaper-Archive 的 JSON API 抓 Bing 官方每日壁纸（真实风景摄影）。
//
// 数据源：https://bing.npanuhin.me/{市场}.json
//   每个市场每天一条，含 bing_url（OHR id）。CN-zh 约 950 条，US-en 约 6150 条。
//
// Bing 官方横竖版都支持（都是官方裁切，构图专业，竖版是原生竖图）：
//   横版  https://cn.bing.com/th?id=<OHR>_1920x1080.jpg
//   竖版  https://cn.bing.com/th?id=<OHR>_1080x1920.jpg
//
// 输出：
//   raw-img/pc/fjbz/*.jpg      电脑风景横图（1920×1080）
//   raw-img/mobile/fjbz/*.jpg  手机风景竖图（1080×1920）
//
// 用法：
//   node scripts/fetch-bing.mjs --target 1000

import { mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const RAW = join(ROOT, 'raw-img');

const TARGET = Number(process.argv[process.argv.indexOf('--target') + 1] || 1000);
const MARKETS = ['CN-zh', 'JP-ja', 'US-en', 'GB-en', 'ROW-en'];
const DL_CONCURRENCY = 8;
const TIMEOUT_MS = 25000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/154 Safari/537.36';

const log = (...a) => console.log('[bing]', ...a);
const sha = (b) => createHash('sha256').update(b).digest('hex');

const PC_DIR = join(RAW, 'pc', 'fjbz');
const MOBILE_DIR = join(RAW, 'mobile', 'fjbz');

function count(dir) {
  return readdirSync(dir).filter((f) => !f.startsWith('.')).length;
}

async function getJson(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function getBytes(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 20 * 1024) throw new Error(`太小 ${buf.length}B`);
  return buf;
}

async function main() {
  mkdirSync(PC_DIR, { recursive: true });
  mkdirSync(MOBILE_DIR, { recursive: true });

  const needPC = Math.max(0, TARGET - count(PC_DIR));
  const needMobile = Math.max(0, TARGET - count(MOBILE_DIR));
  log(`pc/fjbz 已有 ${count(PC_DIR)}，需补 ${needPC}；mobile/fjbz 已有 ${count(MOBILE_DIR)}，需补 ${needMobile}`);
  if (!needPC && !needMobile) { log('两类都已满'); return; }

  // 1. 拉多个市场的 JSON，收集 OHR id
  const ohSet = new Set();
  for (const m of MARKETS) {
    try {
      const arr = await getJson(`https://bing.npanuhin.me/${m}.json`);
      for (const item of arr) {
        const u = item.bing_url || '';
        const mm = u.match(/OHR\.[A-Za-z0-9_-]+/);
        if (mm) {
          const base = mm[0].replace(/_\d+x\d+$/, '').replace(/_UHD$/, '');
          ohSet.add(base);
        }
      }
      log(`  市场 ${m}: ${arr.length} 条，累计独立 OHR ${ohSet.size}`);
    } catch (e) { log(`  市场 ${m} 拉取失败：${e.message}`); }
  }
  const ohr = [...ohSet];
  log(`共 ${ohr.length} 个独立 OHR id`);

  // 2. 下载横版 / 竖版，按内容去重
  const pcSeen = new Set(readdirSync(PC_DIR).filter((f) => !f.startsWith('.')).map((f) => sha(readFileSync(join(PC_DIR, f)))));
  const mobileSeen = new Set(readdirSync(MOBILE_DIR).filter((f) => !f.startsWith('.')).map((f) => sha(readFileSync(join(MOBILE_DIR, f)))));

  let pcSaved = 0, mobileSaved = 0;
  const queue = [];
  for (const oh of ohr) {
    if (needPC && pcSaved < needPC) queue.push({ oh, kind: 'pc' });
    if (needMobile && mobileSaved < needMobile) queue.push({ oh, kind: 'mobile' });
  }
  log(`下载队列 ${queue.length} 个任务`);

  let idx = 0;
  while (idx < queue.length) {
    const batch = queue.slice(idx, idx + DL_CONCURRENCY);
    idx += DL_CONCURRENCY;
    await Promise.all(batch.map(async ({ oh, kind }) => {
      const size = kind === 'pc' ? '1920x1080' : '1080x1920';
      const dir = kind === 'pc' ? PC_DIR : MOBILE_DIR;
      const seen = kind === 'pc' ? pcSeen : mobileSeen;
      try {
        const buf = await getBytes(`https://cn.bing.com/th?id=${oh}_${size}.jpg`);
        const h = sha(buf);
        if (seen.has(h)) return;
        seen.add(h);
        writeFileSync(join(dir, `bing-${h.slice(0, 8)}.jpg`), buf);
        if (kind === 'pc') pcSaved++; else mobileSaved++;
      } catch { /* 单张失败跳过 */ }
    }));
    if (idx % 100 === 0 || idx >= queue.length) {
      log(`  下载 ${Math.min(idx, queue.length)}/${queue.length}（pc +${pcSaved}，mobile +${mobileSaved}）`);
    }
    if (pcSaved >= needPC && mobileSaved >= needMobile) break;
  }

  log(`完成：pc/fjbz 新补 ${pcSaved}（累计 ${count(PC_DIR)}），mobile/fjbz 新补 ${mobileSaved}（累计 ${count(MOBILE_DIR)}）`);
  log('下一步：npm run img && npm run gen && npm run build');
}

main().catch((e) => { log('失败：', e.message); process.exit(1); });
