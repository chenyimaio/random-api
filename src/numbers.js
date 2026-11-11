// src/numbers.js
// 随机数。整数用 crypto.randomInt（无偏），小数用 crypto 的随机字节换算。
//
// 为什么不用 Math.random()：
//   - 它不是密码学随机源，种子可预测
//   - Math.floor(Math.random() * n) 在 n 不能整除 2^53 时有极轻微的分布倾斜
//   这个接口会被别的页面直接调用，宁可多花几纳秒也要无偏。
import { secureInt, secureFloat, secureIndex, secureShuffle } from './entropy.js';

export const LIMITS = {
  maxCount: 1000,      // 单次最多返回多少个
  maxDecimals: 10,     // 小数位数上限
  uniqueCeil: 100000,  // 去重模式下，区间跨度超过这个值就改用抽样，避免建巨大数组
};

/** 区间内的随机整数，两端都包含 */
const intIn = (min, max) => secureInt(min, max);

// 小数路径直接用系统的 53 位随机浮点（见 entropy.js 的说明）
const unit = () => secureFloat();

/**
 * 取随机数。
 *
 * @param {object} o
 * @param {number} o.min
 * @param {number} o.max
 * @param {number} o.count      个数
 * @param {boolean} o.unique    是否去重
 * @param {number|null} o.decimals  null = 整数，>=0 = 保留几位小数
 * @returns {number[]}
 */
export function randomNumbers({ min, max, count, unique = false, decimals = null }) {
  const isFloat = decimals !== null;

  if (!isFloat) {
    // 整数 + 去重：跨度不大时先建全集再洗牌截断，跨度太大就拒绝，
    // 因为"从 0..10^9 里取 5 个不重复的数"建数组会爆内存。
    if (unique) {
      const span = max - min + 1;
      if (span <= LIMITS.uniqueCeil) {
        // 部分 Fisher-Yates：只洗前 count 个，O(count) 而不是 O(span)
        const pool = new Array(span);
        for (let i = 0; i < span; i++) pool[i] = min + i;
        for (let i = 0; i < count; i++) {
          const j = secureInt(i, span - 1);
          [pool[i], pool[j]] = [pool[j], pool[i]];
        }
        return pool.slice(0, count);
      }
      // 跨度太大：退化成拒绝采样，用 Set 去重
      const seen = new Set();
      let guard = 0;
      while (seen.size < count && guard++ < count * 100) seen.add(intIn(min, max));
      return [...seen];
    }
    return Array.from({ length: count }, () => intIn(min, max));
  }

  // 小数
  const out = [];
  const seen = new Set();
  const scale = 10 ** decimals;
  let guard = 0;
  while (out.length < count) {
    const v = Math.round((min + unit() * (max - min)) * scale) / scale;
    const clamped = Math.min(max, Math.max(min, v));
    if (unique) {
      const key = clamped.toFixed(decimals);
      if (seen.has(key)) {
        // 小数池子可能是有限的（比如 0..1 保留 1 位小数只有 11 个），
        // 加个上限防止无限循环
        if (guard++ > count * 1000) break;
        continue;
      }
      seen.add(key);
    }
    out.push(clamped);
  }
  return out;
}

/**
 * 解析并校验查询参数。全部走白名单式的显式转换，
 * 不认识的参数直接忽略，不合法的值返回 400 而不是猜。
 *
 * @returns {{ok: true, opts: object} | {ok: false, error: string, detail?: object}}
 */
export function parseNumberQuery(q) {
  const num = (name, def) => {
    const raw = q.get(name);
    if (raw === null || raw === '') return def;
    const v = Number(raw);
    return Number.isFinite(v) ? v : NaN;
  };

  const min = num('min', 0);
  const max = num('max', 100);
  if (Number.isNaN(min) || Number.isNaN(max)) {
    return { ok: false, error: 'min and max must be numbers' };
  }
  if (min > max) {
    return { ok: false, error: 'min must be <= max', detail: { min, max } };
  }

  const count = num('n', 1);
  if (Number.isNaN(count) || !Number.isInteger(count) || count < 1) {
    return { ok: false, error: 'n must be a positive integer' };
  }
  if (count > LIMITS.maxCount) {
    return { ok: false, error: `n must be <= ${LIMITS.maxCount}`, detail: { n: count } };
  }

  // decimals 不传 = 整数；传 0 = 取整的小数（等价整数，但按小数路径走）
  let decimals = null;
  const rawDec = q.get('decimals');
  if (rawDec !== null && rawDec !== '') {
    const d = Number(rawDec);
    if (!Number.isInteger(d) || d < 0 || d > LIMITS.maxDecimals) {
      return { ok: false, error: `decimals must be an integer between 0 and ${LIMITS.maxDecimals}` };
    }
    decimals = d;
  }

  const unique = ['1', 'true', 'yes'].includes(String(q.get('unique') ?? '').toLowerCase());

  if (unique && decimals === null) {
    const span = max - min + 1;
    if (count > span) {
      return {
        ok: false,
        error: 'cannot return that many unique integers from this range',
        detail: { n: count, span },
      };
    }
  }

  return { ok: true, opts: { min, max, count, unique, decimals } };
}
