import type { OpenSpaceRules, ZoneId } from './types';

/**
 * 分区判定：轴主导法（axis-dominant），保证每个网格单元**恰好属于一个分区**。
 *
 * nx, nz 为归一化坐标 [-1, 1]（+X = 东，-Z = 北）。
 * - 若 |nx| 与 |nz| 均 < 1/3 → core
 * - 否则取绝对值较大的轴决定方向
 *
 * 为什么不用「nx > 1/3 即东侧」的叠加判定：那样东北角同属 east 与 north，
 * 「东侧密度 -30%」会与北侧规则发生优先级歧义，验收中的「其他区域不变」无法严格验证。
 * 互斥分区让局部编辑的影响范围可被逐对象断言。
 */
export const ZONE_THRESHOLD = 1 / 3;

export function zoneOf(nx: number, nz: number): ZoneId {
  const ax = Math.abs(nx);
  const az = Math.abs(nz);
  if (ax < ZONE_THRESHOLD && az < ZONE_THRESHOLD) return 'core';
  if (ax >= az) return nx >= 0 ? 'east' : 'west';
  return nz >= 0 ? 'south' : 'north';
}

/** 单元中心是否落在中央公共开放空间内 */
export function inOpenSpace(x: number, z: number, rules: OpenSpaceRules): boolean {
  if (!rules.enabled) return false;
  const dx = x - rules.offsetX;
  const dz = z - rules.offsetZ;
  if (rules.shape === 'circle') {
    return dx * dx + dz * dz <= rules.radius * rules.radius;
  }
  return Math.abs(dx) <= rules.width / 2 && Math.abs(dz) <= rules.depth / 2;
}

/** 供规则追溯说明使用 */
export function zoneDescription(zone: ZoneId): string {
  switch (zone) {
    case 'core': return '|x| < 1/3 且 |z| < 1/3';
    case 'east': return 'x ≥ 0 且 |x| ≥ |z|（非核心）';
    case 'west': return 'x < 0 且 |x| ≥ |z|（非核心）';
    case 'north': return 'z < 0 且 |z| > |x|（非核心）';
    case 'south': return 'z ≥ 0 且 |z| > |x|（非核心）';
  }
}
