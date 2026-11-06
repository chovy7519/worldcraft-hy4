/**
 * 确定性随机：无状态、按「种子 + 属性盐 + 网格坐标」独立哈希。
 *
 * 关键设计 —— 不使用全局 RNG 流。
 * 传统做法 `const rnd = mulberry32(seed); for (cell of cells) { rnd(); ... }`
 * 会让任一地块的抽样值依赖它之前所有地块。一旦东侧密度改变、
 * 循环内分支数量变化，后续全部地块抽样序列错位 → 「其他区域不变」失效。
 *
 * 这里每个 (属性, 坐标) 直接由哈希得到 [0,1) 采样值，互不依赖：
 *   sample(seed, 'occupy', gx, gy)
 * 因此修改 density.zoneMultipliers.east 只会改变东侧地块的「是否被接受」判定，
 * 非东侧地块的所有属性取值逐位不变。新增属性也不会扰动既有属性。
 */

/** FNV-1a 32 位哈希，输入是任意 (string | number) 元组 */
export function hash32(parts: ReadonlyArray<string | number>): number {
  let h = 0x811c9dc5;
  for (const part of parts) {
    const s = String(part);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    // 分隔符，避免 [1, 23] 与 [12, 3] 碰撞
    h ^= 0x2f;
    h = Math.imul(h, 0x01000193);
  }
  // 末轮雪崩，改善低位分布
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}

/** 返回 [0,1) 的确定性采样值 */
export function sample(seed: number, salt: string, ...keys: Array<string | number>): number {
  return hash32([seed, salt, ...keys]) / 0x1_0000_0000;
}

/** 需要同一对象多个连续随机值时的局部流；仍以坐标+盐为种子，不跨对象共享状态 */
export function stream(seed: number, salt: string, ...keys: Array<string | number>): () => number {
  let state = hash32([seed, salt, ...keys]);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

/** 稳定指纹：对任意可序列化结构生成短十六进制串 */
export function fingerprintOf(value: unknown): string {
  const canonical = canonicalize(value);
  return hash32([canonical]).toString(16).padStart(8, '0').toUpperCase();
}

/** 稳定序列化：对象键排序，数组保序，浮点保留 4 位小数消除平台差异 */
export function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 'null';
    return String(Math.round(value * 10000) / 10000);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .filter((k) => obj[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`)
      .join(',')}}`;
  }
  return 'null';
}

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}
