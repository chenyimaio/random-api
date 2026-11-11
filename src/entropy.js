// src/entropy.js
// 全项目唯一的随机源。
//
// 关于「真随机」：
//   云函数里拿不到硬件噪声源（RDSEED/RDRAND 那类）。能拿到的最好东西是
//   操作系统的 CSPRNG —— Linux 的 getrandom(2) / Windows 的 BCryptGenRandom，
//   它由硬件中断时序等真实物理事件播种，之后用密码学算法扩展。
//   它严格来说是「密码学安全的伪随机」，但它**不可预测**：
//   即使把进程内存全读一遍也推不出下一个输出。
//
//   真正要警惕的是**假随机**，也就是 Math.random()：V8 的 xorshift128+ 种子只有 64 位，
//   拿到几个连续输出就能反推内部状态、预测后续所有值。凡是能影响安全或公平性的
//   取值，都不能用它。这个项目里一次都没用。
//
// 这个模块存在的意义：把所有随机取值收敛到一个地方，
// 顺手挡掉两种常见事故 ——
//   1. 某个环境缺 crypto，代码悄悄退回 Math.random()
//   2. 有人图省事写 Math.random() % n，引入取模偏差
import { randomBytes, randomInt } from 'node:crypto';

// 启动即自检：拿不到密码学随机源就直接失败，绝不静默降级。
// 这类地方"能跑就行"是最糟的选择 —— 表面上一切正常，安全性已经没了。
if (typeof randomInt !== 'function' || typeof randomBytes !== 'function') {
  throw new Error('FATAL: node:crypto random primitives are unavailable; refusing to serve weak randomness');
}

// Node 的 randomInt 只支持到 2^48-1 的区间；超了要自己拼字节。
const RANDOM_INT_MAX_RANGE = 2 ** 48 - 1;

/**
 * [min, max] 闭区间内的均匀随机整数，无模偏差。
 *
 * 小区间走 Node 自带的 randomInt（它内部就是拒绝采样，天然无偏）；
 * 超过 2^48 时用 randomBytes 取 64 位，再做拒绝采样。
 */
export function secureInt(min, max) {
  const lo = Math.ceil(min);
  const hi = Math.floor(max);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) throw new Error('secureInt: bounds must be finite');
  if (hi < lo) throw new Error('secureInt: max must be >= min');
  if (lo === hi) return lo;

  const range = hi - lo + 1;
  if (range <= RANDOM_INT_MAX_RANGE) return randomInt(lo, hi + 1);

  // 大区间：取 64 位，丢弃超出 range 整数倍的部分，保证均匀
  const limit = Math.floor(2 ** 64 / range) * range;
  while (true) {
    const v = randomBytes(8).readBigUInt64BE(0);
    if (v < BigInt(limit)) return lo + Number(v % BigInt(range));
  }
}

/**
 * [0, 1) 的均匀随机小数。
 *
 * 取 53 位（double 尾数能精确表示的最大位数）直接换算，
 * 不用 Math.random()，也不用浮点乘加 —— 后者会引入可测量的偏差。
 */
export function secureFloat() {
  const b = randomBytes(8);
  const hi = b.readUInt32BE(0) >>> 5;  // 27 位
  const lo = b.readUInt32BE(4) >>> 6;  // 26 位
  return (hi * 67108864 + lo) / 9007199254740992; // 2^53
}

/** 从 [0, n) 里取一个下标，n 必须为正整数 */
export function secureIndex(n) {
  if (!Number.isInteger(n) || n <= 0) throw new Error('secureIndex: n must be a positive integer');
  return n === 1 ? 0 : randomInt(n);
}

/** 从数组/字符串里随机取一个元素 */
export function securePick(list) {
  return list[secureIndex(list.length)];
}

/** 原地洗牌（Fisher-Yates），用无偏下标 */
export function secureShuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = secureIndex(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * 自检用：连续取 n 个随机字节，检查它们不是常量。
 * 只在调试接口里跑，正常请求路径不调用。
 */
export function entropyProbe(bytes = 16) {
  const a = randomBytes(bytes);
  const b = randomBytes(bytes);
  return {
    bytes,
    distinctValues: new Set([...a]).size,
    repeatsImmediately: a.equals(b),
    sample: a.toString('hex'),
  };
}
