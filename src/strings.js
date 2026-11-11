// src/strings.js
// 随机字符串 / 口令。字符和长度都能自定义，不是只能选预设。
//
// 三种用法，从粗到细：
//   1. 字符类开关   ?lower=1&upper=1&digits=1&symbols=1&underscore=1
//   2. 自定义符号   ?symbols=!@#$%   （值不是 0/1 时按字符集处理）
//   3. 完全自定义   ?chars=abc123    （直接指定字符池，忽略类开关）
//
// 长度也可以给一串：?length=8,12,16 —— 依次生成，循环使用。
//
// 随机源统一走 entropy.js（node:crypto），不用 Math.random()。
import { securePick, secureShuffle } from './entropy.js';

// 字符类定义。用字符串而不是数组：天然支持下标取值。
export const CLASSES = {
  lower: 'abcdefghijklmnopqrstuvwxyz',
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  digits: '0123456789',
  // 常见符号，避开引号和反斜杠 —— 那类字符一旦出现在口令里，
  // 复制粘贴到 shell / 配置文件时几乎必然出事
  symbols: '!@#$%^&*()-=+[]{};:,.<>?/|~',
  underscore: '_',
};

// 容易看错的字符，?noAmbiguous=1 时剔掉
export const AMBIGUOUS = '0O1lI|`\'"';

export const LIMITS = {
  maxLength: 256,       // 单个串的最大长度
  maxLengths: 8,        // ?length= 里最多给几个长度
  maxCount: 100,
  minLength: 1,
  maxChars: 256,        // ?chars= 的长度上限
  maxExclude: 128,
};

const DEFAULT_ON = ['lower', 'upper', 'digits'];
const TRUTHY = ['1', 'true', 'yes', 'on'];
const FALSY = ['0', 'false', 'no', 'off', ''];

/**
 * 一个参数既能当开关又能当字符集：
 *   symbols=1        → 用内置符号集
 *   symbols=0        → 关闭
 *   symbols=!@#      → 用这串自定义符号
 */
function flagOrSet(raw, def) {
  if (raw === null) return { on: def, custom: null };
  const v = String(raw);
  const low = v.toLowerCase();
  if (TRUTHY.includes(low)) return { on: true, custom: null };
  if (FALSY.includes(low)) return { on: false, custom: null };
  // 其它值一律当成自定义字符集
  return { on: true, custom: v };
}

/** 组装字符池：自定义 chars 优先，否则按类拼，最后统一过滤 */
export function buildPool({ on = DEFAULT_ON, chars = null, customSymbols = null, exclude = '', noAmbiguous = false } = {}) {
  let pool;
  if (chars) {
    pool = [...new Set(chars)].join('');
  } else {
    const parts = on
      .filter((name) => name !== 'symbols')
      .map((name) => CLASSES[name] ?? '');
    if (on.includes('symbols')) parts.push(customSymbols || CLASSES.symbols);
    pool = [...new Set(parts.join(''))].join('');
  }

  if (noAmbiguous) pool = [...pool].filter((ch) => !AMBIGUOUS.includes(ch)).join('');
  if (exclude) {
    const drop = new Set([...exclude]);
    pool = [...pool].filter((ch) => !drop.has(ch)).join('');
  }
  return pool;
}

/**
 * 生成随机串。
 *
 * 每个类的"最少出现次数"由 mins 指定；没给就用默认规则
 * （长度够时每类至少 1 个，否则 0）。这一步做完再随机填满、洗牌，
 * 所以位置也没有规律。
 */
export function randomStrings({ lengths, count, pool, on = DEFAULT_ON, customSymbols = null, mins = {} }) {
  if (!pool) return [];

  const charsArr = [...pool];
  const pick = () => securePick(charsArr);

  // 每类在最终池子里还剩哪些字符（自定义/排除之后可能变少）
  const classChars = new Map();
  for (const name of on) {
    const set = name === 'symbols' ? (customSymbols || CLASSES.symbols) : (CLASSES[name] ?? '');
    classChars.set(name, [...set].filter((ch) => pool.includes(ch)));
  }

  const out = [];
  for (let k = 0; k < count; k++) {
    const length = lengths[k % lengths.length];
    const buf = [];

    // 先按最少次数把每类的坑填上
    for (const [name, arr] of classChars) {
      if (!arr.length) continue;
      const need = Math.min(mins[name] ?? 0, length - buf.length);
      for (let i = 0; i < need; i++) buf.push(securePick(arr));
    }
    while (buf.length < length) buf.push(pick());

    // 前面的位次是固定的，洗一遍牌，避免"首字符永远是小写"
    secureShuffle(buf);
    out.push(buf.slice(0, length).join(''));
  }
  return out;
}

/**
 * 解析并校验查询参数。非法值一律 400，不猜、不静默纠正。
 */
export function parseStringQuery(q) {
  // ---- 长度：可以是单个数字，也可以是逗号分隔的列表 ----
  const rawLength = q.get('length');
  const lengths = [];
  if (rawLength === null || rawLength === '') {
    lengths.push(16);
  } else {
    for (const part of String(rawLength).split(',')) {
      const t = part.trim();
      if (!t) continue;
      const v = Number(t);
      if (!Number.isInteger(v) || v < LIMITS.minLength || v > LIMITS.maxLength) {
        return { ok: false, error: `length must be integer(s) between ${LIMITS.minLength} and ${LIMITS.maxLength}` };
      }
      lengths.push(v);
    }
    if (!lengths.length) return { ok: false, error: 'length is empty' };
    if (lengths.length > LIMITS.maxLengths) {
      return { ok: false, error: `at most ${LIMITS.maxLengths} lengths are allowed` };
    }
  }

  // ---- 个数 ----
  // 给了长度列表又不给 n 时，列表本身就是想要的个数：
  //   ?length=8,12,16        → 三个串，长度分别是 8 / 12 / 16
  //   ?length=8,12&n=5       → 五个串，长度按 8,12,8,12,8 循环
  const rawN = q.get('n');
  const count = rawN === null || rawN === '' ? lengths.length : Number(rawN);
  if (!Number.isInteger(count) || count < 1 || count > LIMITS.maxCount) {
    return { ok: false, error: `n must be an integer between 1 and ${LIMITS.maxCount}` };
  }

  // ---- 完全自定义字符集 ----
  const rawChars = q.get('chars');
  const chars = rawChars === null || rawChars === '' ? null : String(rawChars);
  if (chars && [...chars].length > LIMITS.maxChars) {
    return { ok: false, error: `chars is too long (max ${LIMITS.maxChars} characters)` };
  }

  // ---- 类开关 / 自定义符号 ----
  const on = [];
  let customSymbols = null;
  for (const name of Object.keys(CLASSES)) {
    const { on: enabled, custom } = flagOrSet(q.get(name), DEFAULT_ON.includes(name));
    if (custom !== null && name === 'symbols') customSymbols = custom;
    if (custom !== null && name !== 'symbols') {
      // 只有 symbols 支持自定义集；别的类传了怪值就当开启，避免静默忽略
      if (enabled) on.push(name);
      continue;
    }
    if (enabled) on.push(name);
  }

  if (!chars && !on.length) {
    return { ok: false, error: 'at least one character class must be enabled (or pass ?chars=)', classes: Object.keys(CLASSES) };
  }

  const exclude = String(q.get('exclude') ?? '');
  if ([...exclude].length > LIMITS.maxExclude) {
    return { ok: false, error: `exclude is too long (max ${LIMITS.maxExclude} characters)` };
  }

  const noAmbiguous = TRUTHY.includes(String(q.get('noAmbiguous') ?? '').toLowerCase());

  const pool = buildPool({ on, chars, customSymbols, exclude, noAmbiguous });
  if (!pool) {
    return { ok: false, error: 'character pool is empty after exclusions', classes: on };
  }

  // ---- 每类的最少出现次数 ----
  // 参数名是 min + 类名首字母大写：minDigits / minSymbols / minUpper ...
  // 不传就沿用默认：长度够时每类至少 1 个（避免"开了符号却一个符号没有"）。
  //
  // 但"每类至少 1 个"只在池子里真有这类字符时才成立 ——
  // 用 ?chars=abc123 时池子里没有大写字母，硬要求 minUpper=1 是不可能的。
  // 所以先按池子剔掉不可能的类；只有用户**明确**要求了下限而池子里没有时才报错。
  const classHasChars = (name) => {
    const set = name === 'symbols' ? (customSymbols || CLASSES.symbols) : (CLASSES[name] ?? '');
    return [...set].some((ch) => pool.includes(ch));
  };

  const usableOn = on.filter(classHasChars);
  const impossible = [];
  const mins = {};

  for (const name of on) {
    const key = 'min' + name[0].toUpperCase() + name.slice(1);
    const raw = q.get(key);
    const explicit = raw !== null && raw !== '';

    if (!classHasChars(name)) {
      if (explicit && Number(raw) > 0) impossible.push(key);
      continue;
    }

    let v = Math.min(...lengths) >= usableOn.length ? 1 : 0;
    if (explicit) {
      v = Number(raw);
      if (!Number.isInteger(v) || v < 0 || v > LIMITS.maxLength) {
        return { ok: false, error: `${key} must be an integer between 0 and ${LIMITS.maxLength}` };
      }
    }
    mins[name] = v;
  }

  if (impossible.length) {
    return {
      ok: false,
      error: `no characters available for: ${impossible.join(', ')}`,
      hint: 'these classes are empty in the selected pool',
    };
  }

  const minSum = Object.values(mins).reduce((a, b) => a + b, 0);
  if (minSum > Math.min(...lengths)) {
    return {
      ok: false,
      error: `sum of minimums (${minSum}) exceeds length (${Math.min(...lengths)})`,
      mins,
    };
  }

  return {
    ok: true,
    opts: {
      lengths, count, pool, on: usableOn, chars, customSymbols, exclude, noAmbiguous,
      mins, poolSize: [...pool].length,
    },
  };
}
