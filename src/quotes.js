// 一言数据。两个来源：
//   data/quotes.json         手工挑选的 50 条古典诗词（curated）
//   data/quotes.remote.json  从 hitokoto-osc/sentences-bundle 拉的 2000 条
//
// 两个文件在构建时由 esbuild 内联进产物，运行时不需要读文件 ——
// Makers 的函数是单文件，没有可靠的工作目录。
import { secureIndex, securePick } from './entropy.js';
import curated from '../data/quotes.json';
import remote from '../data/quotes.remote.json';

const curatedList = Array.isArray(curated) ? curated : [];
const remoteList = Array.isArray(remote) ? remote : [];

// 统一成一个数组，id 保持稳定：curated 用原 id，remote 从 1001 起。
// 去重按正文：句库里偶尔会有同一句重复收录。
const seen = new Set();
const quotes = [];
for (const q of [...curatedList, ...remoteList]) {
  const text = String(q?.hitokoto ?? '').trim();
  if (!text || seen.has(text)) continue;
  seen.add(text);
  quotes.push({ ...q, hitokoto: text });
}

/** 数据里出现过的所有 type，用于 /api/stats 和过滤校验 */
export const quoteTypes = [...new Set(quotes.map((q) => String(q.type)))].sort();

export const quoteCount = quotes.length;

export const quoteSources = {
  curated: curatedList.length,
  remote: remoteList.length,
  total: quotes.length,
};

export const quoteCountByType = quotes.reduce((acc, q) => {
  acc[q.type] = (acc[q.type] ?? 0) + 1;
  return acc;
}, {});

// 用 crypto.randomInt 而不是 Math.random() % n：
// 后者存在取模偏差，且不是密码学随机源；这个接口会被大量第三方页面调用，
// 分布不均会让某些句子出现得明显更频繁。
const pick = (arr) => securePick(arr);

/** 随机取一条，可按 type 过滤；池子为空返回 null */
export function randomQuote({ type } = {}) {
  let pool = quotes;
  if (type) {
    const want = String(type).toLowerCase();
    pool = quotes.filter((q) => String(q.type).toLowerCase() === want);
  }
  return pool.length ? pick(pool) : null;
}

/** 随机取 n 条，不重复 */
export function randomQuotes(n) {
  const want = Math.min(Math.max(1, Math.floor(n) || 1), quotes.length);
  const used = new Set();
  const out = [];
  while (out.length < want) {
    const i = secureIndex(quotes.length);
    if (used.has(i)) continue;
    used.add(i);
    out.push(quotes[i]);
  }
  return out;
}

// ---------------------------------------------------------------- 每日一句

/**
 * 给定日期取一条固定的句子。
 *
 * 做法：把日期换算成「从 1970-01-01 起的天数」，再在句子池里按固定步长跳跃。
 *   index = (STEP * dayNum + OFFSET) mod count
 *
 * 步长和池子大小互质是关键 —— 这样连续 count 天里不会重复任何一句，
 * 而且任何一天的结果只跟日期有关：同一天全世界拿到同一句，昨天和明天必然不同。
 * 不用 sha256(日期) % count，因为那个除数一变（加了几句话）整月的排期就全乱。
 */
function gcd(a, b) {
  while (b) [a, b] = [b, a % b];
  return a;
}

function dailyIndex(dayNum, count) {
  if (count <= 1) return 0;
  // 挑一个与 count 互质的步长；从 7919 起往上找，保证分布不退化
  let step = 7919 % count;
  if (step === 0) step = 1;
  let guard = 0;
  while (gcd(step, count) !== 1 && guard++ < count) step = (step + 1) % count || 1;
  return (step * dayNum + 12345) % count;
}

/** YYYY-MM-DD -> 天数（UTC 语义，纯算术，不受时区影响） */
function dayNumber(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

/**
 * 在指定时区里"今天"是哪天。默认 UTC。
 * 用 en-CA 是因为它的日期格式正好是 YYYY-MM-DD。
 */
export function dateKeyIn(timeZone = 'UTC', at = new Date()) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(at);
  } catch {
    // 时区名非法就退回 UTC，别因为一个参数把接口打挂
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(at);
  }
}

/**
 * 到"该时区的下一天"还有多少秒。
 * 二分查找第一次日期发生变化的那一秒，比按分钟硬扫省事也准。
 */
export function secondsUntilNextDay(timeZone = 'UTC', now = new Date()) {
  const today = dateKeyIn(timeZone, now);
  let lo = now.getTime();
  let hi = lo + 27 * 3600 * 1000; // 最多 27 小时（含夏令时）
  for (let i = 0; i < 30 && hi - lo > 1000; i++) {
    const mid = Math.floor((lo + hi) / 2);
    if (dateKeyIn(timeZone, new Date(mid)) === today) lo = mid;
    else hi = mid;
  }
  return Math.max(1, Math.floor((hi - now.getTime()) / 1000));
}

/**
 * 取某一天的句子。type 可过滤，过滤后池子变了，但当天的结果依然唯一。
 */
export function dailyQuote({ date, type } = {}) {
  let pool = quotes;
  if (type) {
    const want = String(type).toLowerCase();
    pool = quotes.filter((q) => String(q.type).toLowerCase() === want);
  }
  if (!pool.length) return null;

  const key = date || dateKeyIn('UTC');
  const idx = dailyIndex(dayNumber(key), pool.length);
  return { quote: pool[idx], date: key };
}
