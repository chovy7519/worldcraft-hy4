/**
 * 多边形布尔运算层（v1.3.0）
 *
 * 用 Martinez / Clipper 系成熟实现（polygon-clipping）替代 v1.2.0 的「共边消除」合并：
 * 它只能处理精确共边，长边/短边端点不匹配就失败并记入 skippedEdits。
 *
 * 分工（重要）：
 * - polygon.ts 的 mergePolygons 保留为「共边快速路径」，保证既有场景逐位一致、无浮点扰动；
 * - 本模块的 mergePolygonsRobust 只在快速路径失败时接管，支持任意相邻 / 部分重叠的并集；
 * - 带洞结果一律拒绝，因为地块系统尚不支持内环（宁可跳过，也不生成非法地块）。
 *
 * 所有输出经 isSimple / 面积校验后才允许回到生成管线。
 */
import polygonClipping from 'polygon-clipping';
import type { MultiPolygon, Polygon as PcPolygon } from 'polygon-clipping';

type Geom = PcPolygon | MultiPolygon;
type BoolOp = (geom: Geom, ...geoms: Geom[]) => MultiPolygon;
// 该包的 ESM 产物只有 default export（见 src/polygon-clipping.d.ts）：
// 具名导入能通过 tsc，却会让 Rollup 构建失败，因此统一从 default 对象解构。
const { union, intersection, difference } = polygonClipping as unknown as {
  union: BoolOp;
  intersection: BoolOp;
  difference: BoolOp;
};
import {
  clipHalfPlane, dedupe, isSimple, polygonArea, signedArea, v,
  type Polygon,
} from './polygon';

const AREA_EPS = 1e-4;
const q = (n: number): number => Math.round(n * 1e6) / 1e6;

/** 内部环序 → polygon-clipping 的闭合 ring；坐标定点化到 1e-6 抑制浮点毛刺 */
function toGeom(p: Polygon): PcPolygon {
  const ring = p.map((pt) => [q(pt.x), q(pt.z)] as [number, number]);
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0], first[1]]);
  return [ring];
}

export interface BooleanResult {
  /** 可用的外环（简单、非退化、无内环） */
  polygons: Polygon[];
  /** 被拒绝的原因，供 skippedEdits 追溯 */
  rejected: string[];
  /** 结果中出现内环（洞）的次数 */
  holeCount: number;
}

function fromGeom(mp: MultiPolygon): BooleanResult {
  const polygons: Polygon[] = [];
  const rejected: string[] = [];
  let holeCount = 0;
  for (let i = 0; i < mp.length; i++) {
    const poly = mp[i];
    if (!poly || poly.length === 0) continue;
    if (poly.length > 1) { holeCount += poly.length - 1; rejected.push(`结果 ${i} 含内环，地块系统不支持`); continue; }
    const outer = poly[0].map(([x, z]) => v(x, z));
    const clean = dedupe(outer);
    if (clean.length < 3) { rejected.push(`结果 ${i} 顶点不足`); continue; }
    if (!isSimple(clean)) { rejected.push(`结果 ${i} 非简单多边形`); continue; }
    if (polygonArea(clean) < AREA_EPS) { rejected.push(`结果 ${i} 面积退化`); continue; }
    polygons.push(clean);
  }
  return { polygons, rejected, holeCount };
}

function safe<T>(fn: () => T, fallback: T): T {
  try { return fn(); } catch { return fallback; }
}

export function unionPolygons(input: Polygon[]): BooleanResult {
  if (input.length === 0) return { polygons: [], rejected: [], holeCount: 0 };
  if (input.length === 1) return fromGeom([toGeom(input[0])]);
  return safe(
    () => fromGeom(union(toGeom(input[0]), ...input.slice(1).map(toGeom))),
    { polygons: [], rejected: ['布尔并集计算失败（退化输入）'], holeCount: 0 },
  );
}

export function intersectionPolygons(a: Polygon, b: Polygon): BooleanResult {
  return safe(
    () => fromGeom(intersection(toGeom(a), toGeom(b))),
    { polygons: [], rejected: ['布尔交集计算失败'], holeCount: 0 },
  );
}

export function subtractPolygons(a: Polygon, b: Polygon): BooleanResult {
  return safe(
    () => fromGeom(difference(toGeom(a), toGeom(b))),
    { polygons: [], rejected: ['布尔差集计算失败'], holeCount: 0 },
  );
}

/**
 * 稳健合并：快速路径失败后的兜底。
 * 面积约束保证结果是「两个输入的并」，而不是布尔库把完全不相交的两块当成一块返回。
 */
export function mergePolygonsRobust(a: Polygon, b: Polygon): { polygon: Polygon | null; reason?: string } {
  const areaA = polygonArea(a);
  const areaB = polygonArea(b);
  const result = unionPolygons([a, b]);
  if (result.polygons.length === 0) {
    return { polygon: null, reason: result.rejected[0] ?? '布尔并集无可用外环' };
  }
  if (result.polygons.length > 1) {
    return { polygon: null, reason: '两地块不连通（并集产生多个分离外环）' };
  }
  if (result.holeCount > 0) {
    return { polygon: null, reason: '并集产生内环，地块系统不支持' };
  }
  const merged = result.polygons[0];
  const area = polygonArea(merged);
  const lower = Math.max(areaA, areaB) - Math.max(1, areaA * 0.01);
  const upper = areaA + areaB + Math.max(1, (areaA + areaB) * 0.01);
  if (area < lower || area > upper) {
    return { polygon: null, reason: `并集面积 ${area.toFixed(1)} 不在 [${lower.toFixed(1)}, ${upper.toFixed(1)}]` };
  }
  return { polygon: merged };
}

/**
 * 多边形内缩（岸线退界 / 公园边界内缩用）。
 * 逐边内移 d 后用半平面依次裁剪；对凸多边形精确，对凹多边形可能退化，
 * 此时返回 null 由调用方决定保守回退（绝不生成越界桥接）。
 */
export function insetPolygon(p: Polygon, d: number): Polygon | null {
  if (d <= 0) return p.slice();
  const sign = signedArea(p) >= 0 ? 1 : -1;
  let out: Polygon = p.slice();
  for (let i = 0; i < p.length; i++) {
    const a = p[i];
    const b = p[(i + 1) % p.length];
    const ex = b.x - a.x;
    const ez = b.z - a.z;
    const nx = sign * -ez;
    const nz = sign * ex;
    const len = Math.hypot(nx, nz);
    if (len < 1e-9) continue;
    const ux = nx / len;
    const uz = nz / len;
    const c = -(ux * (a.x + ux * d) + uz * (a.z + uz * d));
    out = clipHalfPlane(out, ux, uz, c);
    if (out.length < 3) return null;
  }
  const clean = dedupe(out);
  if (!isSimple(clean) || polygonArea(clean) < 1) return null;
  return clean;
}

/** 多个共边/重叠地块的一次性并集，返回最大外环（供水面连通体使用） */
export function unionLargest(input: Polygon[]): { polygon: Polygon | null; rejected: string[] } {
  const result = unionPolygons(input);
  if (result.polygons.length === 0) return { polygon: null, rejected: result.rejected };
  const sorted = result.polygons.slice().sort((x, y) => polygonArea(y) - polygonArea(x));
  return { polygon: sorted[0], rejected: result.rejected };
}
