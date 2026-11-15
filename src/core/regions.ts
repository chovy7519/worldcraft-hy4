/**
 * 区域选择器 + 规则叠加层（v1.3.0）
 *
 * 目标：把 v1.2.0 的「五分区轴主导互斥」从唯一的分区机制，降级为众多选择器中的一种。
 * 规划语境里的「沿江 50 m」「站点 800 m 半径」「X 轴 -80~80 m 的城市轴线」
 * 都是叠加谓词，无法用互斥分区表达。
 *
 * 设计不变量（比功能本身更重要）：
 * 1. 空叠加层 → density/height 倍率恒为 1，生成结果逐位不变（旧场景、旧测试全部不受影响）。
 * 2. 每个对象按自身坐标独立判定，不引入生成顺序依赖，因此「局部编辑不扰动其他区域」仍成立。
 * 3. 叠加层按 (priority, id) 稳定排序，不依赖数组之外的隐式状态；所有数值定点化到 1e-4。
 * 4. 选择器是纯函数，可单测、可序列化、可交给 LLM 生成结构化命令。
 */
import { pointInPolygon, v } from './geom/polygon';
import { zoneOf } from './zones';
import { ZONE_IDS, type Point2, type ZoneId } from './types';

export interface SiteFrame { width: number; depth: number }

export type RegionSelector =
  | { kind: 'all' }
  | { kind: 'zone'; zone: ZoneId }
  | { kind: 'band'; axis: 'x' | 'z'; min: number; max: number }
  | { kind: 'radius'; cx: number; cz: number; r: number }
  | { kind: 'polygon'; polygon: Point2[] };

/** multiply：与分区倍率连乘；override：直接覆盖之前所有叠加结果 */
export type RegionBlend = 'multiply' | 'override';

export interface RegionLayer {
  id: string;
  name: string;
  selector: RegionSelector;
  /** 密度倍率 0–2 */
  density: number;
  /** 高度倍率 0.2–2 */
  height: number;
  enabled: boolean;
  /** 数值越小越先应用；相同则按 id 字典序，保证确定性 */
  priority: number;
  blend: RegionBlend;
}

export const MAX_REGION_LAYERS = 24;
export const REGION_ID_RE = /^[A-Za-z0-9_.-]{1,40}$/;
export const REGION_SELECTOR_KINDS = ['all', 'zone', 'band', 'radius', 'polygon'] as const;

const round4 = (n: number): number => Math.round(n * 10000) / 10000;
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/** 世界坐标以场地中心为原点：+X 东、+Z 南，与 normalizeXZ / zoneOf 一致 */
export function matchesSelector(sel: RegionSelector, x: number, z: number, site: SiteFrame): boolean {
  switch (sel.kind) {
    case 'all':
      return true;
    case 'zone': {
      const nx = x / Math.max(1, site.width / 2);
      const nz = z / Math.max(1, site.depth / 2);
      return zoneOf(nx, nz) === sel.zone;
    }
    case 'band': {
      const c = sel.axis === 'x' ? x : z;
      const lo = Math.min(sel.min, sel.max);
      const hi = Math.max(sel.min, sel.max);
      return c >= lo - 1e-6 && c <= hi + 1e-6;
    }
    case 'radius':
      return Math.hypot(x - sel.cx, z - sel.cz) <= sel.r + 1e-6;
    case 'polygon': {
      if (sel.polygon.length < 3) return false;
      return pointInPolygon(sel.polygon.map((q) => v(q.x, q.z)), x, z, -1e-6);
    }
  }
}

export interface RegionFactors {
  density: number;
  height: number;
  /** 命中并由小到大应用的叠加层 id，供规则追溯 trace 使用 */
  matched: string[];
}

/**
 * 求某一点的合并倍率。空数组是恒等元 —— 这条保证是「不侵入既有数据层」的关键。
 */
export function evaluateRegions(
  regions: readonly RegionLayer[] | undefined,
  x: number,
  z: number,
  site: SiteFrame,
): RegionFactors {
  const layers = regions ?? [];
  if (layers.length === 0) return { density: 1, height: 1, matched: [] };
  const active = layers
    .filter((r) => r.enabled)
    .slice()
    .sort((a, b) => (a.priority - b.priority) || a.id.localeCompare(b.id));
  let density = 1;
  let height = 1;
  const matched: string[] = [];
  for (const r of active) {
    if (!matchesSelector(r.selector, x, z, site)) continue;
    matched.push(r.id);
    if (r.blend === 'override') {
      density = r.density;
      height = r.height;
    } else {
      density *= r.density;
      height *= r.height;
    }
  }
  return {
    density: clamp(round4(density), 0, 4),
    height: clamp(round4(height), 0.05, 4),
    matched,
  };
}

export function describeSelector(sel: RegionSelector): string {
  switch (sel.kind) {
    case 'all': return '全部区域';
    case 'zone': return `互斥分区 · ${sel.zone}`;
    case 'band': return `${sel.axis.toUpperCase()} 轴 ${Math.min(sel.min, sel.max)} ~ ${Math.max(sel.min, sel.max)} m`;
    case 'radius': return `半径 ${sel.r} m（中心 ${sel.cx}, ${sel.cz}）`;
    case 'polygon': return `自定义多边形（${sel.polygon.length} 顶点）`;
  }
}

// ---------------------------------------------------------------------------
// 严格校验：命令层、schema 层、LLM 输出共用同一入口
// ---------------------------------------------------------------------------

export interface ParseOutcome<T> { ok: boolean; value?: T; error?: string }

function finite(n: unknown, lo: number, hi: number, label: string): ParseOutcome<number> {
  const num = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(num)) return { ok: false, error: `${label} 需要数值` };
  if (num < lo || num > hi) return { ok: false, error: `${label} 越界（${lo} ~ ${hi}）` };
  return { ok: true, value: round4(num) };
}

function parsePoint(raw: unknown, label: string): ParseOutcome<Point2> {
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: `${label} 必须是点` };
  const p = raw as Record<string, unknown>;
  const x = finite(p.x, -100000, 100000, `${label}.x`);
  const z = finite(p.z, -100000, 100000, `${label}.z`);
  if (!x.ok || !z.ok) return { ok: false, error: x.error ?? z.error };
  return { ok: true, value: { x: x.value!, z: z.value! } };
}

export function parseSelector(raw: unknown): ParseOutcome<RegionSelector> {
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: 'selector 必须是对象' };
  const s = raw as Record<string, unknown>;
  switch (s.kind) {
    case 'all':
      return { ok: true, value: { kind: 'all' } };
    case 'zone': {
      if (!ZONE_IDS.includes(s.zone as ZoneId)) return { ok: false, error: `未知分区 ${String(s.zone)}` };
      return { ok: true, value: { kind: 'zone', zone: s.zone as ZoneId } };
    }
    case 'band': {
      if (s.axis !== 'x' && s.axis !== 'z') return { ok: false, error: 'band.axis 必须是 x 或 z' };
      const min = finite(s.min, -100000, 100000, 'band.min');
      const max = finite(s.max, -100000, 100000, 'band.max');
      if (!min.ok || !max.ok) return { ok: false, error: min.error ?? max.error };
      return { ok: true, value: { kind: 'band', axis: s.axis, min: min.value!, max: max.value! } };
    }
    case 'radius': {
      const cx = finite(s.cx, -100000, 100000, 'radius.cx');
      const cz = finite(s.cz, -100000, 100000, 'radius.cz');
      const r = finite(s.r, 0.5, 100000, 'radius.r');
      if (!cx.ok || !cz.ok || !r.ok) return { ok: false, error: cx.error ?? cz.error ?? r.error };
      return { ok: true, value: { kind: 'radius', cx: cx.value!, cz: cz.value!, r: r.value! } };
    }
    case 'polygon': {
      if (!Array.isArray(s.polygon) || s.polygon.length < 3 || s.polygon.length > 64) {
        return { ok: false, error: 'polygon 需要 3 ~ 64 个顶点' };
      }
      const pts: Point2[] = [];
      for (let i = 0; i < s.polygon.length; i++) {
        const p = parsePoint(s.polygon[i], `polygon[${i}]`);
        if (!p.ok) return { ok: false, error: p.error };
        pts.push(p.value!);
      }
      return { ok: true, value: { kind: 'polygon', polygon: pts } };
    }
    default:
      return { ok: false, error: `未知选择器类型 ${String(s.kind)}` };
  }
}

export function parseRegionLayer(raw: unknown, index = 0): ParseOutcome<RegionLayer> {
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: '叠加层必须是对象' };
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' && REGION_ID_RE.test(r.id) ? r.id : `region.${index}`;
  const sel = parseSelector(r.selector);
  if (!sel.ok) return { ok: false, error: sel.error };
  const density = finite(r.density ?? 1, 0, 2, 'density');
  const height = finite(r.height ?? 1, 0.2, 2, 'height');
  const priority = finite(r.priority ?? 10, 0, 1000, 'priority');
  if (!density.ok || !height.ok || !priority.ok) {
    return { ok: false, error: density.error ?? height.error ?? priority.error };
  }
  if (r.blend !== undefined && r.blend !== 'multiply' && r.blend !== 'override') {
    return { ok: false, error: 'blend 必须是 multiply 或 override' };
  }
  return {
    ok: true,
    value: {
      id,
      name: typeof r.name === 'string' ? r.name.slice(0, 60) : `叠加层 ${index + 1}`,
      selector: sel.value!,
      density: density.value!,
      height: height.value!,
      enabled: r.enabled !== false,
      priority: priority.value!,
      blend: (r.blend as RegionBlend) ?? 'multiply',
    },
  };
}

export function parseRegionLayers(raw: unknown): ParseOutcome<RegionLayer[]> {
  if (raw === undefined || raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return { ok: false, error: 'regions 必须是数组' };
  if (raw.length > MAX_REGION_LAYERS) return { ok: false, error: `叠加层数量超过上限 ${MAX_REGION_LAYERS}` };
  const out: RegionLayer[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const layer = parseRegionLayer(raw[i], i);
    if (!layer.ok) return { ok: false, error: `regions[${i}]: ${layer.error}` };
    if (seen.has(layer.value!.id)) return { ok: false, error: `重复的叠加层 id：${layer.value!.id}` };
    seen.add(layer.value!.id);
    out.push(layer.value!);
  }
  return { ok: true, value: out };
}

/** 命令层用的默认叠加层模板：新增时只需给 selector 与倍率 */
export function makeRegionLayer(input: Partial<RegionLayer> & { selector: RegionSelector }): RegionLayer {
  return {
    id: input.id ?? `region.${Date.now().toString(36)}`,
    name: input.name ?? '自定义区域',
    selector: input.selector,
    density: clamp(round4(input.density ?? 1), 0, 2),
    height: clamp(round4(input.height ?? 1), 0.2, 2),
    enabled: input.enabled ?? true,
    priority: input.priority ?? 10,
    blend: input.blend ?? 'multiply',
  };
}
