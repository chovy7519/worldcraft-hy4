/**
 * 多边形几何内核。
 * 坐标：X 东西、Z 南北（把 Z 当作 2D 的 y 使用）。
 * 约定：Polygon 顶点按环序存储、不重复首点；正/负有向面积由 shoelace 决定。
 *
 * 所有算法都要求确定性：无随机数、输入相同则输出逐位相同。
 */
import type { Bounds } from '../types';

export const GEO_EPS = 1e-6;
const AREA_EPS = 1e-4;

export interface Vec2 { x: number; z: number }
export type Polygon = Vec2[];

export const v = (x: number, z: number): Vec2 => ({ x, z });
export const cross = (ax: number, az: number, bx: number, bz: number): number => ax * bz - az * bx;
export const sub = (a: Vec2, b: Vec2): Vec2 => v(a.x - b.x, a.z - b.z);
export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.z * b.z;
export const len = (a: Vec2): number => Math.hypot(a.x, a.z);
export const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.z - b.z);
export function lerpV(a: Vec2, b: Vec2, t: number): Vec2 { return v(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t); }

export function signedArea(p: Polygon): number {
  if (p.length < 3) return 0;
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i]; const b = p[(i + 1) % p.length];
    s += a.x * b.z - b.x * a.z;
  }
  return s / 2;
}
export const polygonArea = (p: Polygon): number => Math.abs(signedArea(p));

export function centroid(p: Polygon): Vec2 {
  const a = signedArea(p);
  if (Math.abs(a) < AREA_EPS) {
    return v(p.reduce((s, q) => s + q.x, 0) / Math.max(1, p.length), p.reduce((s, q) => s + q.z, 0) / Math.max(1, p.length));
  }
  let cx = 0; let cz = 0;
  for (let i = 0; i < p.length; i++) {
    const q = p[i]; const r = p[(i + 1) % p.length];
    const f = q.x * r.z - r.x * q.z;
    cx += (q.x + r.x) * f; cz += (q.z + r.z) * f;
  }
  return v(cx / (6 * a), cz / (6 * a));
}

export function boundsOf(p: Polygon): Bounds {
  let minX = Infinity; let maxX = -Infinity; let minZ = Infinity; let maxZ = -Infinity;
  for (const q of p) {
    minX = Math.min(minX, q.x); maxX = Math.max(maxX, q.x);
    minZ = Math.min(minZ, q.z); maxZ = Math.max(maxZ, q.z);
  }
  if (p.length === 0) return { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };
  return { minX, maxX, minZ, maxZ };
}

/** 点到线段的最短距离 */
export function distanceToSegment(px: number, pz: number, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x; const dz = b.z - a.z;
  const l2 = dx * dx + dz * dz;
  if (l2 < GEO_EPS) return Math.hypot(px - a.x, pz - a.z);
  let t = ((px - a.x) * dx + (pz - a.z) * dz) / l2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (a.x + t * dx), pz - (a.z + t * dz));
}

/** 点到多边形所有边的最小距离（点在内时为正的净距） */
export function distanceToEdges(p: Polygon, x: number, z: number): number {
  let m = Infinity;
  for (let i = 0; i < p.length; i++) m = Math.min(m, distanceToSegment(x, z, p[i], p[(i + 1) % p.length]));
  return m;
}

/** 射线法点包含判定；落在边界上视为内部 */
export function pointInPolygon(p: Polygon, x: number, z: number, eps = GEO_EPS): boolean {
  if (p.length < 3) return false;
  for (let i = 0; i < p.length; i++) {
    if (distanceToSegment(x, z, p[i], p[(i + 1) % p.length]) <= eps) return true;
  }
  let inside = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const a = p[i]; const b = p[j];
    if ((a.z > z) !== (b.z > z)) {
      const t = (z - a.z) / (b.z - a.z);
      if (x < a.x + t * (b.x - a.x)) inside = !inside;
    }
  }
  return inside;
}

/** 严格相交（共点/共线端点不算），用于自交检测 */
export function segmentsProperlyIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const d1 = cross(b.x - a.x, b.z - a.z, c.x - a.x, c.z - a.z);
  const d2 = cross(b.x - a.x, b.z - a.z, d.x - a.x, d.z - a.z);
  const d3 = cross(d.x - c.x, d.z - c.z, a.x - c.x, a.z - c.z);
  const d4 = cross(d.x - c.x, d.z - c.z, b.x - c.x, b.z - c.z);
  return ((d1 > GEO_EPS && d2 < -GEO_EPS) || (d1 < -GEO_EPS && d2 > GEO_EPS))
    && ((d3 > GEO_EPS && d4 < -GEO_EPS) || (d3 < -GEO_EPS && d4 > GEO_EPS));
}

/** 简单多边形：非相邻边不得严格相交，且无重复相邻顶点 */
export function isSimple(p: Polygon): boolean {
  const n = p.length;
  if (n < 3 || polygonArea(p) < AREA_EPS) return false;
  for (let i = 0; i < n; i++) {
    if (dist(p[i], p[(i + 1) % n]) < GEO_EPS) return false;
    for (let j = i + 1; j < n; j++) {
      if (j === i || (j + 1) % n === i || (i + 1) % n === j) continue;
      if (segmentsProperlyIntersect(p[i], p[(i + 1) % n], p[j], p[(j + 1) % n])) return false;
    }
  }
  return true;
}

/** Sutherland–Hodgman：用半平面 nx*x + nz*z + c >= 0 裁剪（裁剪器为凸，输入可为凹） */
export function clipHalfPlane(p: Polygon, nx: number, nz: number, c: number): Polygon {
  if (p.length === 0) return [];
  const out: Polygon = [];
  const side = (q: Vec2) => nx * q.x + nz * q.z + c;
  for (let i = 0; i < p.length; i++) {
    const a = p[i]; const b = p[(i + 1) % p.length];
    const sa = side(a); const sb = side(b);
    const ina = sa >= -GEO_EPS; const inb = sb >= -GEO_EPS;
    if (ina) out.push(a);
    if (ina !== inb) {
      const t = sa / (sa - sb);
      out.push(lerpV(a, b, t));
    }
  }
  return dedupe(out);
}

/** 去除相邻重复点与共线冗余点 */
export function dedupe(p: Polygon, eps = GEO_EPS): Polygon {
  const out: Polygon = [];
  for (const q of p) {
    if (!q || !Number.isFinite(q.x) || !Number.isFinite(q.z)) continue;
    if (out.length === 0 || dist(out[out.length - 1], q) > eps) out.push(q);
  }
  while (out.length > 1 && dist(out[0], out[out.length - 1]) <= eps) out.pop();
  const clean: Polygon = [];
  for (let i = 0; i < out.length; i++) {
    const a = out[(i - 1 + out.length) % out.length]; const b = out[i]; const c = out[(i + 1) % out.length];
    if (Math.abs(cross(b.x - a.x, b.z - a.z, c.x - b.x, c.z - b.z)) < eps * 100
      && dot(sub(b, a), sub(c, b)) > 0) continue;
    clean.push(b);
  }
  return clean.length >= 3 ? clean : [];
}

export function reverse(p: Polygon): Polygon { return [...p].reverse(); }

/** 直线 (A→B) 与多边形边界的全部交点，返回沿直线的参数 t（并去重排序） */
function lineIntersections(p: Polygon, A: Vec2, B: Vec2): number[] {
  const d = sub(B, A);
  const ts: number[] = [];
  for (let i = 0; i < p.length; i++) {
    const a = p[i]; const b = p[(i + 1) % p.length];
    const e = sub(b, a);
    const den = cross(d.x, d.z, e.x, e.z);
    if (Math.abs(den) < GEO_EPS) continue; // 平行
    const t = cross(a.x - A.x, a.z - A.z, e.x, e.z) / den;
    const u = cross(a.x - A.x, a.z - A.z, d.x, d.z) / den;
    if (u >= -GEO_EPS && u <= 1 + GEO_EPS) ts.push(t);
  }
  ts.sort((x, y) => x - y);
  const out: number[] = [];
  for (const t of ts) if (out.length === 0 || Math.abs(t - out[out.length - 1]) > 1e-5) out.push(t);
  return out;
}

/**
 * 求直线 A→B 与多边形相交的**最长内部弦**（两端都落在边界上）。
 * 交点参数允许超出 [0,1]（直线外推），并把线段端点 0/1 纳入分界，
 * 再合并连续的内部区间 —— 这样切割线起点/终点落在地块内部时也能正确切分，
 * 凹多边形被直线多次进出时会取最长的那一段内部弦。
 */
export function clipSegmentInside(p: Polygon, A: Vec2, B: Vec2): [Vec2, Vec2] | null {
  const raw = [0, 1, ...lineIntersections(p, A, B)].sort((x, y) => x - y);
  const ts: number[] = [];
  for (const t of raw) if (ts.length === 0 || Math.abs(t - ts[ts.length - 1]) > 1e-5) ts.push(t);
  if (ts.length < 2) return null;
  let best: [Vec2, Vec2] | null = null;
  let bestLen = 0;
  let start: number | null = null;
  for (let i = 0; i < ts.length - 1; i++) {
    const t0 = ts[i]; const t1 = ts[i + 1];
    if (t1 - t0 < 1e-5) continue;
    const mid = lerpV(A, B, (t0 + t1) / 2);
    if (pointInPolygon(p, mid.x, mid.z)) {
      if (start === null) start = t0;
      const L = t1 - start;
      if (L > bestLen) { bestLen = L; best = [lerpV(A, B, start), lerpV(A, B, t1)]; }
    } else start = null;
  }
  return best;
}

/** 把点投影到多边形边界，返回插入后的新环（若落在顶点容差内则不插入） */
function insertBoundaryPoint(p: Polygon, q: Vec2): { ring: Polygon; index: number; inserted: boolean } {
  let bestI = -1; let bestD = Infinity;
  for (let i = 0; i < p.length; i++) {
    const a = p[i]; const b = p[(i + 1) % p.length];
    const e = sub(b, a); const l2 = dot(e, e);
    let t = l2 < GEO_EPS ? 0 : dot(sub(q, a), e) / l2;
    t = Math.max(0, Math.min(1, t));
    const d = dist(q, lerpV(a, b, t));
    if (d < bestD) { bestD = d; bestI = i; }
  }
  if (bestI < 0) return { ring: p, index: 0, inserted: false };
  if (dist(p[bestI], q) < 1e-4) return { ring: p, index: bestI, inserted: false };
  if (dist(p[(bestI + 1) % p.length], q) < 1e-4) return { ring: p, index: (bestI + 1) % p.length, inserted: false };
  const ring = [...p];
  ring.splice(bestI + 1, 0, q);
  return { ring, index: bestI + 1, inserted: true };
}

/**
 * 沿内部弦 A→B 把（可凹）多边形切成两块。
 * 前置条件：A、B 在边界上，且弦在多边形内（由 clipSegmentInside 保证）。
 * 返回的两个多边形共用弦作为闭合边，因此边界闭合、面积和等于原面积。
 */
export function splitByChord(p: Polygon, A: Vec2, B: Vec2): [Polygon, Polygon] | null {
  if (p.length < 3) return null;
  const first = insertBoundaryPoint(p, A);
  const second = insertBoundaryPoint(first.ring, B);
  const ring = second.ring;
  // 只有 B 真正被插入且位置在 A 之前时，A 的索引才需要后移一位
  const iA = second.inserted && second.index <= first.index ? first.index + 1 : first.index;
  const iB = second.index;
  if (iA === iB || iA < 0 || iB < 0 || iA >= ring.length || iB >= ring.length) return null;
  const chain = (from: number, to: number): Polygon | null => {
    const out: Polygon = [];
    let i = from; let guard = 0;
    out.push(ring[i]);
    while (i !== to && guard++ <= ring.length) { i = (i + 1) % ring.length; out.push(ring[i]); }
    return i === to ? dedupe(out) : null;
  };
  const p1 = chain(iA, iB);
  const p2 = chain(iB, iA);
  if (!p1 || !p2) return null;
  if (p1.length < 3 || p2.length < 3) return null;
  if (!isSimple(p1) || !isSimple(p2)) return null;
  const a1 = polygonArea(p1); const a2 = polygonArea(p2);
  if (a1 < 1 || a2 < 1) return null;
  if (Math.abs(a1 + a2 - polygonArea(p)) > Math.max(0.5, polygonArea(p) * 0.005)) return null;
  return [p1, p2];
}

/** 用无限直线切分多边形，取最长内部弦；返回 [p1,p2] 或 null */
export function splitPolygonByLine(p: Polygon, A: Vec2, B: Vec2): [Polygon, Polygon] | null {
  const chord = clipSegmentInside(p, A, B);
  if (!chord) return null;
  if (dist(chord[0], chord[1]) < 1) return null;
  return splitByChord(p, chord[0], chord[1]);
}

const keyOf = (q: Vec2): string => `${Math.round(q.x * 1000)},${Math.round(q.z * 1000)}`;

/**
 * 合并两个共边多边形：删除方向相反的重合边，剩余边重组成环。
 * 支持凹多边形；只有当重组后得到单一简单环时才成功。
 */
/**
 * 边界顶点对齐：把 B 的顶点插入 A 中落在边上的位置，反之亦然。
 * 合并后的长边与邻居的短边因此被切成相同的小段，共享边才能被正确识别并消除。
 */
function alignBoundaryVertices(a: Polygon, b: Polygon): [Polygon, Polygon] {
  const insertOn = (p: Polygon, points: Polygon): Polygon => {
    let out = [...p];
    for (const q of points) {
      for (let i = 0; i < out.length; i++) {
        const s = out[i]; const e = out[(i + 1) % out.length];
        if (distanceToSegment(q.x, q.z, s, e) > 1e-3) continue;
        if (dist(q, s) < 1e-3 || dist(q, e) < 1e-3) break;
        out.splice(i + 1, 0, q);
        break;
      }
    }
    return dedupe(out);
  };
  return [insertOn(a, b), insertOn(b, a)];
}

export function mergePolygons(a: Polygon, b: Polygon): Polygon | null {
  const [alignedA, alignedB] = alignBoundaryVertices(a, b);
  type E = { from: Vec2; to: Vec2; key: string };
  const edges: E[] = [];
  const push = (p: Polygon) => {
    for (let i = 0; i < p.length; i++) {
      const from = p[i]; const to = p[(i + 1) % p.length];
      if (dist(from, to) < GEO_EPS) continue;
      edges.push({ from, to, key: `${keyOf(from)}|${keyOf(to)}` });
    }
  };
  push(alignedA); push(alignedB);
  const reverseKey = (e: E) => `${keyOf(e.to)}|${keyOf(e.from)}`;
  const map = new Map<string, E[]>();
  for (const e of edges) {
    const list = map.get(e.key) ?? []; list.push(e); map.set(e.key, list);
  }
  const used = new Set<E>();
  const remaining: E[] = [];
  for (const e of edges) {
    if (used.has(e)) continue;
    const twin = (map.get(reverseKey(e)) ?? []).find((x) => !used.has(x));
    if (twin) { used.add(e); used.add(twin); continue; }
    remaining.push(e);
  }
  if (remaining.length < 3) return null;
  // 依次串接剩余有向边
  const start = remaining[0];
  const ring: Vec2[] = [start.from];
  let cur = start;
  const pool = new Set(remaining);
  pool.delete(start);
  while (pool.size > 0) {
    const target = keyOf(cur.to);
    let next: E | undefined;
    for (const e of pool) { if (keyOf(e.from) === target) { next = e; break; } }
    if (!next) return null;
    ring.push(next.from);
    cur = next;
    pool.delete(next);
    if (keyOf(cur.to) === keyOf(start.from) && pool.size === 0) break;
  }
  if (keyOf(cur.to) !== keyOf(start.from) || pool.size > 0) return null;
  const merged = dedupe(ring);
  if (!isSimple(merged)) return null;
  const expected = polygonArea(alignedA) + polygonArea(alignedB);
  if (Math.abs(polygonArea(merged) - expected) > Math.max(1, expected * 0.01)) return null;
  return merged;
}

/** 两多边形是否重叠（严格相交或互相包含） */
export function polygonsOverlap(a: Polygon, b: Polygon): boolean {
  const ba = boundsOf(a); const bb = boundsOf(b);
  if (ba.maxX <= bb.minX + GEO_EPS || bb.maxX <= ba.minX + GEO_EPS
    || ba.maxZ <= bb.minZ + GEO_EPS || bb.maxZ <= ba.minZ + GEO_EPS) return false;
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      if (segmentsProperlyIntersect(a[i], a[(i + 1) % a.length], b[j], b[(j + 1) % b.length])) return true;
    }
  }
  const ca = centroid(a); const cb = centroid(b);
  return (pointInPolygon(a, cb.x, cb.z, -GEO_EPS) && !pointInPolygon(b, ca.x, ca.z, -GEO_EPS))
    || (pointInPolygon(b, ca.x, ca.z, -GEO_EPS) && !pointInPolygon(a, cb.x, cb.z, -GEO_EPS));
}

/** 把顶点 at 移到 to，返回新环；不合法时返回 null */
export function moveVertex(p: Polygon, at: Vec2, to: Vec2): Polygon | null {
  let idx = -1; let best = Infinity;
  for (let i = 0; i < p.length; i++) { const d = dist(p[i], at); if (d < best) { best = d; idx = i; } }
  if (idx < 0 || best > 0.5) return null;
  const ring = p.map((q, i) => i === idx ? v(to.x, to.z) : q);
  const clean = dedupe(ring);
  if (!isSimple(clean) || polygonArea(clean) < 1) return null;
  return clean;
}
