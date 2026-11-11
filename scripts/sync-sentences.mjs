#!/usr/bin/env node
// scripts/sync-sentences.mjs
// 从 hitokoto-osc/sentences-bundle 同步**全量**一言到 data/quotes.remote.json。
//
// 设计要点：
//   - 直接读上游仓库的 raw 文件（jsDelivr CDN），不依赖 GitHub API 鉴权
//   - 用 version.json 的 bundle_version 判断有无更新；未变则跳过，避免无意义提交
//   - 全量保留，不去重过滤长度（用户要求"全量"）；只按正文去重
//   - 保留 curated 的 data/quotes.json 不动，两个文件在运行时合并
//   - 输出 data/quotes.remote.json + data/sentences-version.json（记录同步到的版本）
//
// 用法：
//   node scripts/sync-sentences.mjs              # 有更新才写
//   node scripts/sync-sentences.mjs --force      # 强制重写
//
// 本脚本由 .github/workflows/sync-sentences.yml 每天定时调用。
// 上游句子包是 AGPL-3.0，本仓库整体按 AGPL-3.0 授权，见 NOTICE.md。

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
const OUT = resolve(ROOT, 'data', 'quotes.remote.json');
const VERSION_FILE = resolve(ROOT, 'data', 'sentences-version.json');

const CDN = 'https://cdn.jsdelivr.net/gh/hitokoto-osc/sentences-bundle@master';
const VERSION_URL = `${CDN}/version.json`;
const TIMEOUT_MS = 30000;

// version.json 里 12 个分类的 key。写死而不是遍历 sentences 数组，
// 是为了上游万一调整目录结构时我们仍能明确知道要拉什么。
const CATEGORIES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'];

const CATEGORY_NAMES = {
  a: '动画', b: '漫画', c: '游戏', d: '文学', e: '原创', f: '网络',
  g: '其他', h: '影视', i: '诗词', j: '网易云', k: '哲学', l: '抖机灵',
};

const log = (...a) => console.log('[sync-sentences]', ...a);

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status} <- ${url}`);
  return res.json();
}

function readLocalVersion() {
  try {
    return JSON.parse(readFileSync(VERSION_FILE, 'utf8'));
  } catch {
    return {};
  }
}

async function main() {
  const force = process.argv.includes('--force');

  log('检查上游版本…');
  const ver = await getJson(VERSION_URL);
  const bundleVersion = String(ver.bundle_version ?? '');
  const local = readLocalVersion();

  if (!force && bundleVersion && local.bundleVersion === bundleVersion && existsSync(OUT)) {
    log(`上游版本未变（${bundleVersion}），跳过`);
    return;
  }
  log(`上游 ${local.bundleVersion ?? '(无)'} -> ${bundleVersion || '(未知)'}，开始同步全量`);

  // 分类文件并行拉，单个失败不拖垮整体
  const results = await Promise.allSettled(
    CATEGORIES.map(async (key) => {
      const arr = await getJson(`${CDN}/sentences/${key}.json`);
      if (!Array.isArray(arr)) throw new Error('不是数组');
      return { key, arr };
    }),
  );

  const pools = [];
  const perCategory = {};
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const key = CATEGORIES[i];
    if (r.status === 'fulfilled') {
      perCategory[key] = r.value.arr.length;
      for (const q of r.value.arr) pools.push({ ...q, _key: key });
    } else {
      log(`  分类 ${key} (${CATEGORY_NAMES[key]}) 拉取失败：${r.reason?.message}`);
      perCategory[key] = 0;
    }
  }

  const fetched = pools.length;
  if (!fetched) {
    log('一句都没拉到，不写入，避免把已有数据清空');
    process.exit(1);
  }

  // 只按正文去重（上游不同分类里偶尔有重复句），不做长度过滤 —— 全量
  const seen = new Set();
  const quotes = [];
  for (const q of pools) {
    const text = String(q.hitokoto ?? '').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    const created = q.created_at
      ? (Number(q.created_at) > 1e12
          ? new Date(Number(q.created_at)).toISOString()
          : new Date(Number(q.created_at) * 1000).toISOString())
      : null;
    quotes.push({
      id: 1001 + quotes.length,
      uuid: q.uuid ?? null,
      hitokoto: text,
      type: String(q.type ?? q._key ?? 'd'),
      from: q.from ?? null,
      from_who: q.from_who ?? null,
      creator: q.creator ?? null,
      created_at: created,
      length: [...text].length,
    });
  }

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(quotes, null, 2) + '\n', 'utf8');
  writeFileSync(VERSION_FILE, JSON.stringify({
    bundleVersion,
    updatedAt: ver.updated_at ?? null,
    syncedAt: new Date().toISOString(),
    source: 'https://github.com/hitokoto-osc/sentences-bundle',
    license: 'AGPL-3.0',
    fetched,
    unique: quotes.length,
    perCategory,
  }, null, 2) + '\n', 'utf8');

  log(`完成：抓取 ${fetched} 条，去重后 ${quotes.length} 条 -> ${OUT}`);
  log(`分类分布 ${JSON.stringify(perCategory)}`);
  log('下一步：npm run build（产物会把新数据内联进去）');
}

main().catch((e) => {
  log('失败：', e.message);
  process.exit(1);
});
