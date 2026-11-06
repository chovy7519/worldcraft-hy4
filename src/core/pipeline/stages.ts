/**
 * 分阶段 PCG 实现（v1.2.0 可编辑图版）。每个阶段都是纯函数：
 *   output = f(rules, pipeline params, seed, graph, parcelEdits, declared upstream)
 *
 * S1 从可编辑道路图提取闭合面；S2 生成多边形地块并重放拆分/合并/顶点编辑；
 * S4a 在（可凹）多边形内求旋转内接矩形作为建筑足迹；
 * S4b 公园直接采用地块多边形；S5 树按多边形边界与道路中心线净距分布。
 * 所有随机值走 sample(seed, 属性盐, 稳定序号)，不共享 RNG 流。
 */
import { clamp, fingerprintOf, hash32, sample } from '../rng';
import { zoneOf } from '../zones';
import {
  SpatialGrid, inset, rectFromCenter, rectWidth, rectDepth, unionRect, type Rect,
} from './geometry';
import {
  boundsOf, centroid, dedupe, distanceToEdges, distanceToSegment,
  dist, isSimple, mergePolygons, moveVertex, pointInPolygon, polygonArea,
  splitPolygonByLine, v, type Polygon, type Vec2,
} from '../geom/polygon';
import { extractFaces, totalFaceArea } from '../geom/planar';
import { validateSpatialLayout } from './validate';
import type {
  AssemblyLayer, BuildingLayer, LandUseLayer, ParcelLayer, ParkLayer, RoadLayer,
  StageContext, StageId, StageOutputs, TerrainFeatureLayer, TerrainLayer, TreeLayer, WaterLayer,
} from './contracts';
import {
  ZONE_IDS,
  type ArchetypeId, type BlockObject, type Bounds, type BuildingObject, type LandUseId,
  type MixPreset, type PaletteId, type ParkCluster, type ParkObject, type ParkSizeClass,
  type ParcelObject, type ParcelUse, type Point2, type Polygon2, type RoadBand,
  type RoadSegment, type SceneStats, type TreeObject, type ZoneId,
} from '../types';

// ---------------------------------------------------------------------------
// 静态注册表
// ---------------------------------------------------------------------------

type BuiltUse = 'office' | 'residential' | 'research' | 'commercial';
const BUILT_USES: BuiltUse[] = ['office', 'residential', 'research', 'commercial'];
const ALL_LAND_USES: LandUseId[] = ['office', 'residential', 'research', 'commercial', 'park', 'plaza', 'waterReserved', 'terrainReserved'];

export interface ArchetypeSpec {
  id: ArchetypeId; label: string; ratio: [number, number]; aspect: number;
  heightFactor: number; setback: number; slots: [number, number];
  roofBias: 'flat' | 'stepped' | 'antenna'; colorBoost: number;
}
export const ARCHETYPES: Record<ArchetypeId, ArchetypeSpec> = {
  tower: { id: 'tower', label: '高层塔楼', ratio: [0.52, 0.72], aspect: 0.95, heightFactor: 1, setback: 2, slots: [1, 1], roofBias: 'antenna', colorBoost: 1.12 },
  slab: { id: 'slab', label: '板式楼', ratio: [0.68, 0.84], aspect: 2.2, heightFactor: 0.72, setback: 1.5, slots: [1, 2], roofBias: 'flat', colorBoost: 1 },
  podium: { id: 'podium', label: '商业裙房', ratio: [0.8, 0.94], aspect: 1.35, heightFactor: 0.4, setback: 1, slots: [1, 1], roofBias: 'stepped', colorBoost: 1.05 },
  research: { id: 'research', label: '研发楼', ratio: [0.6, 0.78], aspect: 1.5, heightFactor: 0.62, setback: 2, slots: [1, 2], roofBias: 'flat', colorBoost: 0.96 },
  incubator: { id: 'incubator', label: '孵化单元', ratio: [0.5, 0.68], aspect: 1.05, heightFactor: 0.48, setback: 1.5, slots: [2, 3], roofBias: 'stepped', colorBoost: 0.92 },
};
export const ARCHETYPE_ORDER: ArchetypeId[] = ['tower', 'slab', 'podium', 'research', 'incubator'];
const ARCHETYPE_BY_USE: Record<BuiltUse, Array<[ArchetypeId, number]>> = {
  office: [['tower', 0.5], ['slab', 0.3], ['podium', 0.2]],
  residential: [['slab', 0.6], ['incubator', 0.25], ['tower', 0.15]],
  research: [['research', 0.7], ['slab', 0.3]],
  commercial: [['podium', 0.55], ['incubator', 0.45]],
};
export const MIX_WEIGHTS: Record<MixPreset, Record<BuiltUse, number>> = {
  balanced: { office: 0.34, residential: 0.22, research: 0.22, commercial: 0.22 },
  office: { office: 0.55, residential: 0.15, research: 0.12, commercial: 0.18 },
  research: { office: 0.2, residential: 0.12, research: 0.5, commercial: 0.18 },
  green: { office: 0.24, residential: 0.2, research: 0.18, commercial: 0.14 },
};
const PALETTES: Record<PaletteId, string[]> = {
  future: ['#27435d', '#34618a', '#4a82a8', '#6aa6c2', '#1e3042', '#8db8ce'],
  concrete: ['#9a9a94', '#b4b1a8', '#7e807c', '#c6c2b8', '#6f7372', '#a8a9a2'],
  warm: ['#b07a58', '#c99a6c', '#8f5f45', '#d8b184', '#a56c4e', '#e0c39a'],
  mono: ['#e2e5e6', '#c6cbcd', '#f1f3f3', '#a8afb2', '#d5dadb', '#8f979a'],
};
const GLASS_COLORS = ['#3f7fa8', '#5799c0', '#2f6b93', '#76b6d1'];

const emptyLandUseCounts = (): Record<LandUseId, number> =>
  Object.fromEntries(ALL_LAND_USES.map((u) => [u, 0])) as Record<LandUseId, number>;
const emptyArchetypeCounts = (): Record<ArchetypeId, number> =>
  Object.fromEntries(ARCHETYPE_ORDER.map((a) => [a, 0])) as Record<ArchetypeId, number>;
const emptyZoneSlots = (): Record<ZoneId, number> =>
  Object.fromEntries(ZONE_IDS.map((z) => [z, 0])) as Record<ZoneId, number>;

function pickWeighted<T extends string>(weights: Array<[T, number]>, r: number): T {
  const total = weights.reduce((s, [, w]) => s + w, 0);
  let acc = 0;
  for (const [id, w] of weights) { acc += w / total; if (r <= acc) return id; }
  return weights[weights.length - 1][0];
}
const normalizeXZ = (x: number, z: number, w: number, d: number) => ({ nx: x / (w / 2), nz: z / (d / 2) });
const asRect = (b: Bounds): Rect => ({ minX: b.minX, maxX: b.maxX, minZ: b.minZ, maxZ: b.maxZ });
const toPoly = (p: Polygon2): Polygon => p.map((q) => v(q.x, q.z));
const toPoints = (p: Polygon): Polygon2 => p.map((q) => ({ x: q.x, z: q.z }));

/** 两个多边形是否共享一条完整边（端点互换匹配，容差 5cm） */
function shareEdge(a: Polygon, b: Polygon): boolean {
  for (let i = 0; i < a.length; i++) {
    const a1 = a[i]; const a2 = a[(i + 1) % a.length];
    for (let j = 0; j < b.length; j++) {
      const b1 = b[j]; const b2 = b[(j + 1) % b.length];
      if ((dist(a1, b1) < 0.05 && dist(a2, b2) < 0.05) || (dist(a1, b2) < 0.05 && dist(a2, b1) < 0.05)) return true;
    }
  }
  return false;
}

/** 凸性检测（叉积符号一致） */
function isConcave(p: Polygon): boolean {
  if (p.length < 4) return false;
  let sign = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i]; const b = p[(i + 1) % p.length]; const c = p[(i + 2) % p.length];
    const cr = (b.x - a.x) * (c.z - b.z) - (b.z - a.z) * (c.x - b.x);
    if (Math.abs(cr) < 1e-6) continue;
    const s = cr > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// S0 场地基底
// ---------------------------------------------------------------------------

function stageTerrain(ctx: StageContext): TerrainLayer {
  const { width, depth, cellSize, groundLevel } = ctx.rules.terrain;
  return {
    cols: clamp(Math.floor(width / cellSize), 4, 160),
    rows: clamp(Math.floor(depth / cellSize), 4, 160),
    cellSize, groundLevel,
    site: { minX: -width / 2, maxX: width / 2, minZ: -depth / 2, maxZ: depth / 2 },
  };
}

// ---------------------------------------------------------------------------
// S1 道路网络确定（可编辑图 → 闭合面）
// ---------------------------------------------------------------------------

function stageRoads(ctx: StageContext): RoadLayer {
  const terrain = ctx.upstream('terrain');
  const site = terrain.site;
  const extraction = extractFaces(ctx.doc.graph, site, 12);
  const { faces, nodes, edges } = extraction;
  const siteArea = (site.maxX - site.minX) * (site.maxZ - site.minZ);

  // 中央公园：取质心最靠近场地中心的 N×N 个面
  const n = ctx.rules.openSpace.enabled ? clamp(Math.round(ctx.params.parks.centralBlocks), 0, 4) : 0;
  const wanted = n > 0 ? Math.min(n * n, faces.length) : 0;
  const byCenter = [...faces].sort((a, b) => {
    const ca = centroid(a.polygon); const cb = centroid(b.polygon);
    return Math.hypot(ca.x, ca.z) - Math.hypot(cb.x, cb.z);
  });
  const centralKeys = new Set(byCenter.slice(0, wanted).map((f) => f.key));
  const centralFaces = faces.filter((f) => centralKeys.has(f.key));
  const centralBounds: Bounds | null = centralFaces.length > 0
    ? unionRect(centralFaces.map((f) => boundsOf(f.polygon))) as Bounds : null;

  // 每条解析边关联到哪些面；两侧都是中央公园面的内部边被抑制
  const edgeFaces = new Map<string, string[]>();
  for (const f of faces) {
    for (let i = 0; i < f.nodeIds.length; i++) {
      const u = f.nodeIds[i]; const w = f.nodeIds[(i + 1) % f.nodeIds.length];
      if (!u || !w) continue;
      for (const e of edges) {
        if ((e.from === u && e.to === w) || (e.from === w && e.to === u)) {
          const list = edgeFaces.get(e.id) ?? []; list.push(f.key); edgeFaces.set(e.id, list);
        }
      }
    }
  }

  const nodeById = new Map(nodes.map((x) => [x.id, x]));
  const bands: RoadBand[] = [];
  const segments: RoadSegment[] = [];
  const suppressedIds: string[] = [];
  for (const e of edges) {
    const a = nodeById.get(e.from); const b = nodeById.get(e.to);
    if (!a || !b) continue;
    const A: Point2 = { x: a.x, z: a.z }; const B: Point2 = { x: b.x, z: b.z };
    const length = Math.hypot(B.x - A.x, B.z - A.z);
    const angle = Math.atan2(B.z - A.z, B.x - A.x);
    const half = Math.max(0, e.width) / 2;
    const bounds: Bounds = {
      minX: Math.min(A.x, B.x) - half, maxX: Math.max(A.x, B.x) + half,
      minZ: Math.min(A.z, B.z) - half, maxZ: Math.max(A.z, B.z) + half,
    };
    const adjacent = edgeFaces.get(e.id) ?? [];
    const suppressed = !e.boundary && ctx.params.roads.suppressParkInterior
      && adjacent.length >= 2 && adjacent.every((k) => centralKeys.has(k));
    const axis = Math.abs(B.x - A.x) < 1e-4 ? 'x' : Math.abs(B.z - A.z) < 1e-4 ? 'z' : 'free';
    bands.push({
      id: `rb.${e.id}`, axis, coord: axis === 'x' ? A.x : axis === 'z' ? A.z : 0,
      width: e.width, cls: e.cls, bounds: { ...bounds, minX: Math.max(site.minX, bounds.minX), maxX: Math.min(site.maxX, bounds.maxX), minZ: Math.max(site.minZ, bounds.minZ), maxZ: Math.min(site.maxZ, bounds.maxZ) },
      a: A, b: B, suppressed, boundary: Boolean(e.boundary), length, angle,
    });
    if (suppressed) suppressedIds.push(`rb.${e.id}`);
    if (e.boundary || suppressed) continue;
    segments.push({
      id: `rs.${e.id}`, bandId: `rb.${e.id}`, axis,
      x: (A.x + B.x) / 2, z: (A.z + B.z) / 2,
      w: length, d: e.width,
      cls: e.cls, bounds, a: A, b: B, length, angle,
      boundary: false, edgeId: e.id, fromNode: e.from, toNode: e.to,
    });
  }

  const blocks: BlockObject[] = faces.map((f, i) => ({
    id: `blk.${f.key}`, kind: 'block', serial: i, gx: 0, gz: 0,
    bounds: boundsOf(f.polygon), isCentralPark: centralKeys.has(f.key),
  }));

  return {
    faces, centralFaceKeys: Array.from(centralKeys), bands, segments, nodes, edges, blocks,
    suppressedIds, centralBounds, faceIssues: extraction.issues,
    faceArea: totalFaceArea(faces), siteArea,
  };
}

// ---------------------------------------------------------------------------
// S2 地块划分（闭合面 → 多边形地块 → 重放编辑）
// ---------------------------------------------------------------------------

interface WorkParcel { polygon: Polygon; isCentral: boolean; editDepth: number; source: string }

/** 按目标尺度用直线把（可凹）面细分为多块；切割线取面内最长弦，失败则保留原块 */
function subdivideFace(poly: Polygon, target: number, maxSplit: number): Polygon[] {
  const b = boundsOf(poly);
  const w = rectWidth(asRect(b)); const d = rectDepth(asRect(b));
  // maxSplit 是细分强度：值越大，等效目标尺度越小，地块越碎
  const effective = Math.max(8, (target * 2) / Math.max(1, maxSplit));
  const nx = clamp(Math.round(w / effective), 1, 4);
  const nz = clamp(Math.round(d / effective), 1, 4);
  let pieces: Polygon[] = [poly];
  const cut = (vertical: boolean, count: number, min: number, span: number, otherMin: number, otherSpan: number) => {
    for (let i = 1; i < count; i++) {
      const t = min + (span * i) / count;
      const A = vertical ? v(t, otherMin - otherSpan) : v(otherMin - otherSpan, t);
      const B = vertical ? v(t, otherMin + otherSpan * 2) : v(otherMin + otherSpan * 2, t);
      const next: Polygon[] = [];
      for (const piece of pieces) {
        const pair = splitPolygonByLine(piece, A, B);
        if (pair) next.push(pair[0], pair[1]);
        else next.push(piece);
      }
      pieces = next;
    }
  };
  cut(true, nx, b.minX, w, b.minZ, d);
  cut(false, nz, b.minZ, d, b.minX, w);
  return pieces;
}

function stageParcels(ctx: StageContext): ParcelLayer {
  const roads = ctx.upstream('roads');
  const { width, depth } = ctx.rules.terrain;
  const skippedEdits: string[] = [];
  const target = Math.max(8, ctx.params.parcels.targetSize * 1.4);
  let work: WorkParcel[] = [];
  for (const f of roads.faces) {
    if (roads.centralFaceKeys.includes(f.key)) {
      work.push({ polygon: toPoly(f.polygon as Polygon2), isCentral: true, editDepth: 0, source: f.key });
      continue;
    }
    const pieces = subdivideFace(toPoly(f.polygon as Polygon2), target, clamp(Math.round(ctx.params.parcels.maxSplit), 1, 4));
    pieces.forEach((polygon, i) => work.push({
      polygon, isCentral: false, editDepth: 0, source: `${f.key}.g${i}`,
    }));
  }

  // 中央公园：把多个面合并为一个（可能是凹的）多边形地块
  if (ctx.params.roads.suppressParkInterior) {
    const central = work.filter((w) => w.isCentral);
    const rest = work.filter((w) => !w.isCentral);
    if (central.length > 1) {
      let merged = central[0]; let ok = true;
      for (let i = 1; i < central.length; i++) {
        const m = mergePolygons(merged.polygon, central[i].polygon);
        if (!m) { ok = false; break; }
        merged = { polygon: m, isCentral: true, editDepth: 0, source: `${merged.source}+${central[i].source}` };
      }
      work = ok ? [...rest, merged] : work;
      if (!ok) skippedEdits.push('中央公园面合并失败，保留独立地块');
    }
  }

  // 按空间锚点重放地块编辑序列
  for (const edit of ctx.doc.parcelEdits) {
    if (edit.kind === 'split') {
      const A = v(edit.a.x, edit.a.z); const B = v(edit.b.x, edit.b.z);
      const next: WorkParcel[] = []; let applied = 0;
      for (const w of work) {
        const pair = splitPolygonByLine(w.polygon, A, B);
        if (pair) {
          next.push({ ...w, polygon: pair[0], editDepth: w.editDepth + 1, source: `${w.source}.s${applied}` });
          next.push({ ...w, polygon: pair[1], editDepth: w.editDepth + 1, source: `${w.source}.s${applied}` });
          applied++;
        } else next.push(w);
      }
      if (applied === 0) skippedEdits.push(`${edit.id}: 切割线未与任何地块形成有效弦`);
      work = next;
    } else if (edit.kind === 'merge') {
      const findAt = (q: Point2) => work.findIndex((w) => pointInPolygon(w.polygon, q.x, q.z));
      const ia = findAt(edit.a); const ib = findAt(edit.b);
      if (ia < 0 || ib < 0 || ia === ib) { skippedEdits.push(`${edit.id}: 两点未落在两个不同地块内`); continue; }
      const m = mergePolygons(work[ia].polygon, work[ib].polygon);
      if (!m) { skippedEdits.push(`${edit.id}: 两地块不共边，无法合并`); continue; }
      const keep = Math.max(0, Math.min(ia, ib));
      const drop = Math.max(ia, ib);
      work = work.filter((_, i) => i !== drop);
      work[keep] = {
        polygon: m, isCentral: work[keep].isCentral || ia < 0,
        editDepth: work[keep].editDepth + 1,
        source: `${work[keep].source}+${edit.id}`,
      };
    } else {
      const at = v(edit.at.x, edit.at.z); const to = v(edit.to.x, edit.to.z);
      const targets = work.map((w, i) => ({ w, i, d: Math.min(...w.polygon.map((q) => dist(q, at))) }))
        .filter((x) => x.d < 0.6);
      if (targets.length === 0) { skippedEdits.push(`${edit.id}: 未找到匹配顶点`); continue; }
      const moved = targets.map((x) => ({ ...x, next: moveVertex(x.w.polygon, at, to) }));
      if (moved.some((x) => !x.next)) { skippedEdits.push(`${edit.id}: 顶点移动会造成自交或退化，已拒绝`); continue; }
      for (const x of moved) work[x.i] = { ...x.w, polygon: x.next!, editDepth: x.w.editDepth + 1, source: `${x.w.source}.v` };
    }
  }

  // 稳定排序后编号
  const sorted = work.map((w) => ({ w, c: centroid(w.polygon) }))
    .sort((a, b) => (a.c.z - b.c.z) || (a.c.x - b.c.x));
  const parcels: ParcelObject[] = [];
  const polygonByParcel: Record<string, Polygon2> = {};
  for (let i = 0; i < sorted.length; i++) {
    const poly = dedupe(sorted[i].w.polygon);
    if (!isSimple(poly) || polygonArea(poly) < 4) { skippedEdits.push(`面 ${sorted[i].w.source} 退化，已跳过`); continue; }
    const bounds = boundsOf(poly);
    const c = centroid(poly);
    const { nx, nz } = normalizeXZ(c.x, c.z, width, depth);
    const polygon = toPoints(poly);
    const id = `prc.${parcels.length}`;
    // 临路面：与任一非边界道路段共线重合的边
    const frontage: ParcelObject['frontage'] = [];
    for (const seg of roads.segments) {
      for (let k = 0; k < poly.length; k++) {
        const a = poly[k]; const b = poly[(k + 1) % poly.length];
        const d1 = distanceToSegment(a.x, a.z, v(seg.a.x, seg.a.z), v(seg.b.x, seg.b.z));
        const d2 = distanceToSegment(b.x, b.z, v(seg.a.x, seg.a.z), v(seg.b.x, seg.b.z));
        if (d1 < 0.05 && d2 < 0.05) { frontage.push({ side: 'FREE', roadId: seg.id }); break; }
      }
    }
    parcels.push({
      id, kind: 'parcel', serial: parcels.length,
      blockId: sorted[i].w.isCentral ? 'central' : `blk.${sorted[i].w.source}`,
      bounds, buildable: inset(asRect(bounds), Math.min(ctx.params.parcels.setback, Math.min(rectWidth(asRect(bounds)), rectDepth(asRect(bounds))) * 0.18)),
      polygon, isConcave: isConcave(poly), area: polygonArea(poly), zone: zoneOf(nx, nz),
      frontage, isCentralPark: sorted[i].w.isCentral,
      sourceFaceKey: sorted[i].w.source, editDepth: sorted[i].w.editDepth,
    });
    polygonByParcel[id] = polygon;
  }
  return {
    parcels, byId: Object.fromEntries(parcels.map((p) => [p.id, p])),
    skippedEdits, concaveCount: parcels.filter((p) => p.isConcave).length, polygonByParcel,
  };
}

// ---------------------------------------------------------------------------
// S3 地块功能分配
// ---------------------------------------------------------------------------

function stageLandUse(ctx: StageContext): LandUseLayer {
  const { parcels } = ctx.upstream('parcels');
  const p = ctx.params.landUse;
  const weights = MIX_WEIGHTS[p.mixPreset] ?? MIX_WEIGHTS.balanced;
  const counts = emptyLandUseCounts();
  const byParcel: Record<string, ParcelUse> = {};

  for (const parcel of parcels) {
    let use: LandUseId; let sizeClass: ParkSizeClass | null = null;
    if (parcel.isCentralPark) { use = 'park'; sizeClass = 'central'; }
    else {
      const r = sample(ctx.seed, 'landuse-roll', parcel.serial);
      const greenBonus = p.mixPreset === 'green' ? 1.5 : 1;
      const parkP = clamp(p.parkRatio * greenBonus * (1 + p.clusterBias * (parcel.zone === 'core' ? -0.25 : 0.2)), 0, 0.9);
      const waterP = clamp(p.waterReserveRatio, 0, 0.5);
      const terrainP = clamp(p.terrainReserveRatio, 0, 0.5);
      const plazaP = clamp(p.plazaRatio, 0, 0.5);
      if (r < waterP) use = 'waterReserved';
      else if (r < waterP + terrainP) use = 'terrainReserved';
      else if (r < waterP + terrainP + parkP) { use = 'park'; sizeClass = 'pocket'; }
      else if (r < waterP + terrainP + parkP + plazaP) { use = 'plaza'; sizeClass = 'pocket'; }
      else use = pickWeighted(BUILT_USES.map((u) => [u, weights[u]] as [BuiltUse, number]), sample(ctx.seed, 'landuse-built', parcel.serial));
    }
    byParcel[parcel.id] = { parcelId: parcel.id, use, clusterId: null, sizeClass };
    counts[use]++;
  }

  // 公园扩张：相邻（共边）地块并入公园，形成不同尺寸等级
  const seeds = parcels.filter((q) => !q.isCentralPark && byParcel[q.id].use === 'park');
  for (const seed of seeds) {
    if (sample(ctx.seed, 'park-expand', seed.serial) >= p.clusterBias) continue;
    const neighbors = parcels.filter((o) => o.id !== seed.id && !o.isCentralPark
      && BUILT_USES.includes(byParcel[o.id].use as BuiltUse)
      && shareEdge(toPoly(seed.polygon), toPoly(o.polygon)))
      .sort((a, b) => a.serial - b.serial);
    const take = 1 + Math.floor(sample(ctx.seed, 'park-expand-n', seed.serial) * 3);
    for (const nb of neighbors.slice(0, take)) {
      byParcel[nb.id] = { parcelId: nb.id, use: 'park', clusterId: null, sizeClass: 'pocket' };
    }
  }
  for (const key of ALL_LAND_USES) counts[key] = 0;
  for (const parcel of parcels) counts[byParcel[parcel.id].use]++;

  // 聚类：仅合并真正共边的公园/广场地块
  const green = parcels.filter((q) => byParcel[q.id].use === 'park' || byParcel[q.id].use === 'plaza');
  const parent = new Map(green.map((q) => [q.id, q.id]));
  const find = (id: string): string => { let r = id; while (parent.get(r) !== r) r = parent.get(r)!; return r; };
  for (let i = 0; i < green.length; i++) {
    for (let j = i + 1; j < green.length; j++) {
      if (shareEdge(toPoly(green[i].polygon), toPoly(green[j].polygon))) {
        const ra = find(green[i].id); const rb = find(green[j].id);
        if (ra !== rb) parent.set(rb, ra);
      }
    }
  }
  const groups = new Map<string, ParcelObject[]>();
  for (const q of green) { const r = find(q.id); const list = groups.get(r) ?? []; list.push(q); groups.set(r, list); }
  const clusters: ParkCluster[] = [];
  const centralParcelCount = parcels.filter((q) => q.isCentralPark).length;
  let ci = 0;
  for (const group of Array.from(groups.values()).sort((a, b) => a[0].serial - b[0].serial)) {
    const isCentral = centralParcelCount === 1 && group.some((q) => q.isCentralPark);
    const bounds = unionRect(group.map((q) => asRect(q.bounds))) as Bounds;
    const area = group.reduce((s, q) => s + q.area, 0);
    const sizeClass: ParkSizeClass = isCentral ? 'central'
      : area <= ctx.params.parks.pocketMaxArea ? 'pocket'
        : area <= ctx.params.parks.neighborhoodMaxArea ? 'neighborhood' : 'neighborhood';
    const cluster: ParkCluster = {
      id: isCentral ? 'pk.central' : `pk.${ci++}`,
      parcelIds: group.map((q) => q.id).sort(), bounds, area, sizeClass, isCentral,
    };
    clusters.push(cluster);
    for (const q of group) { byParcel[q.id].clusterId = cluster.id; byParcel[q.id].sizeClass = sizeClass; }
  }
  const uses = parcels.map((q) => byParcel[q.id]);
  return { uses, byParcel, clusters, counts };
}

// ---------------------------------------------------------------------------
// S4a 多类型建筑：多边形内旋转内接矩形族
// ---------------------------------------------------------------------------

interface CandidateRect { cx: number; cz: number; w: number; d: number; angle: number; area: number; corners: Vec2[] }
function cornersOf(cx: number, cz: number, w: number, d: number, angle: number): Vec2[] {
  const c = Math.cos(angle); const s = Math.sin(angle);
  return [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]]
    .map(([dx, dz]) => v(cx + dx * c - dz * s, cz + dx * s + dz * c));
}
function polygonsIntersect(a: Vec2[], b: Vec2[]): boolean {
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      const a1 = a[i]; const a2 = a[(i + 1) % a.length]; const b1 = b[j]; const b2 = b[(j + 1) % b.length];
      const d1 = (a2.x - a1.x) * (b1.z - a1.z) - (a2.z - a1.z) * (b1.x - a1.x);
      const d2 = (a2.x - a1.x) * (b2.z - a1.z) - (a2.z - a1.z) * (b2.x - a1.x);
      const d3 = (b2.x - b1.x) * (a1.z - b1.z) - (b2.z - b1.z) * (a1.x - b1.x);
      const d4 = (b2.x - b1.x) * (a2.z - b1.z) - (b2.z - b1.z) * (a2.x - b1.x);
      if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
    }
  }
  return pointInPolygon(a, b[0].x, b[0].z, -1e-6) || pointInPolygon(b, a[0].x, a[0].z, -1e-6);
}
/**
 * 足迹是否完整落在多边形内，且到**每条边**分别满足该边的净距要求。
 * 逐边净距让临主干路的边退 6m、临支路的边退 4m、内部边界只退 3m，
 * 比统一 buffer 更贴合地块形状、减少不合理空隙。
 */
function footprintFits(poly: Polygon, corners: Vec2[], edgeBuffers: number[]): boolean {
  const check = (x: number, z: number): boolean => {
    if (!pointInPolygon(poly, x, z, -1e-6)) return false;
    for (let i = 0; i < poly.length; i++) {
      if (distanceToSegment(x, z, poly[i], poly[(i + 1) % poly.length]) < edgeBuffers[i]) return false;
    }
    return true;
  };
  // 到直线的距离是仿射函数：角点 + 中心满足逐边净距，则整条足迹边也满足（凸/凹多边形均由
  // pointInPolygon 与后续 validateSpatialLayout 的多边形相交检查兜底）。
  for (const q of corners) if (!check(q.x, q.z)) return false;
  const mx = corners.reduce((s, q) => s + q.x, 0) / corners.length;
  const mz = corners.reduce((s, q) => s + q.z, 0) / corners.length;
  return check(mx, mz);
}
/** 每条地块边的净距：临道路边取道路半宽 + 0.5，其余取配置退界 */
function edgeBuffersOf(poly: Polygon, bands: RoadBand[], setback: number): number[] {
  return poly.map((a, i) => {
    const b = poly[(i + 1) % poly.length];
    let buf = setback;
    for (const band of bands) {
      if (band.boundary || band.suppressed) continue;
      const d1 = distanceToSegment(a.x, a.z, v(band.a.x, band.a.z), v(band.b.x, band.b.z));
      const d2 = distanceToSegment(b.x, b.z, v(band.a.x, band.a.z), v(band.b.x, band.b.z));
      if (d1 < 0.05 && d2 < 0.05) { buf = Math.max(buf, band.width / 2 + 0.5); }
    }
    return buf;
  });
}
function candidateAngles(poly: Polygon): number[] {
  const out = [0, Math.PI / 2];
  const edges = poly.map((q, i) => ({ a: q, b: poly[(i + 1) % poly.length], l: dist(q, poly[(i + 1) % poly.length]) }))
    .sort((x, y) => y.l - x.l).slice(0, 2);
  for (const e of edges) out.push(Math.atan2(e.b.z - e.a.z, e.b.x - e.a.x));
  return Array.from(new Set(out.map((a) => Math.round(a * 1000) / 1000)));
}

function heightAt(ctx: StageContext, x: number, z: number, serial: number, k: number) {
  const { width, depth } = ctx.rules.terrain;
  const H = ctx.rules.height;
  const { nx, nz } = normalizeXZ(x, z, width, depth);
  const centrality = 1 - Math.min(1, Math.hypot(nx, nz));
  let factor: number;
  switch (H.profile) {
    case 'centerHigh': factor = Math.pow(Math.max(0, centrality), H.taper); break;
    case 'uniform': factor = 0.5; break;
    case 'random': factor = sample(ctx.seed, 'profile', serial, k); break;
  }
  const jitter = 1 + H.jitter * (2 * sample(ctx.seed, 'hjitter', serial, k) - 1);
  return { h: (H.base + (H.max - H.base) * factor) * jitter, factor };
}
function colorAt(ctx: StageContext, serial: number, k: number, h: number, boost: number): string {
  const m = ctx.rules.material;
  if (sample(ctx.seed, 'glass', serial, k) < m.glassRatio) {
    return GLASS_COLORS[Math.floor(sample(ctx.seed, 'glasstone', serial, k) * GLASS_COLORS.length) % GLASS_COLORS.length];
  }
  const list = PALETTES[m.palette];
  const t = clamp(h / Math.max(1, ctx.rules.height.max), 0, 1);
  const r = clamp((0.25 * t + 0.75 * sample(ctx.seed, 'color', serial, k)) * boost, 0, 0.999);
  return list[Math.min(list.length - 1, Math.floor(r * list.length))];
}
function roofAt(ctx: StageContext, serial: number, k: number, bias: ArchetypeSpec['roofBias']): BuildingObject['roof'] {
  switch (ctx.rules.material.roofStyle) {
    case 'flat': return 'flat';
    case 'stepped': return 'stepped';
    case 'mixed': { const r = sample(ctx.seed, 'roof', serial, k); return r < 0.52 ? 'flat' : r < 0.84 ? bias : 'antenna'; }
  }
}

function stageBuildings(ctx: StageContext): BuildingLayer {
  const { parcels } = ctx.upstream('parcels');
  const land = ctx.upstream('landuse');
  const roads = ctx.upstream('roads');
  const p = ctx.params.buildings;
  const buildings: BuildingObject[] = [];
  const counts = emptyArchetypeCounts();
  const slotsByZone = emptyZoneSlots();
  const maxPerParcel = clamp(Math.round(p.maxPerParcel), 1, 4);
  const activeBands = roads.bands.filter((b) => !b.suppressed && !b.boundary);
  const maxRoadHalf = Math.max(0, ...activeBands.map((b) => b.width / 2));
  const uniformBuffer = Math.max(ctx.params.parcels.setback, maxRoadHalf + 0.5);

  for (const parcel of parcels) {
    const use = land.byParcel[parcel.id]?.use;
    if (!use || !BUILT_USES.includes(use as BuiltUse)) continue;
    const builtUse = use as BuiltUse;
    const zoneMult = ctx.rules.density.zoneMultipliers[parcel.zone];
    const prob = clamp(ctx.rules.density.base * zoneMult, 0, 1);
    const specList = ARCHETYPE_BY_USE[builtUse].map(([a, w]) => [a, w * (a === 'tower' ? (parcel.zone === 'core' ? 2.4 : 0.6) : 1)] as [ArchetypeId, number]);
    const jitter = clamp(p.archetypeJitter, 0, 1);
    const archetype: ArchetypeId = jitter > 0 && sample(ctx.seed, 'archetype-jitter', parcel.serial) < jitter
      ? ARCHETYPE_ORDER[Math.floor(sample(ctx.seed, 'archetype-free', parcel.serial) * ARCHETYPE_ORDER.length)]
      : pickWeighted(specList, sample(ctx.seed, 'archetype', parcel.serial));
    const spec = ARCHETYPES[archetype];
    const slotCount = clamp(spec.slots[0] + Math.floor(sample(ctx.seed, 'slots', parcel.serial) * (spec.slots[1] - spec.slots[0] + 1)), 1, maxPerParcel);
    slotsByZone[parcel.zone] += slotCount;

    const poly = toPoly(parcel.polygon);
    const bounds = asRect(parcel.bounds);
    const bw = rectWidth(bounds); const bd = rectDepth(bounds);
    if (bw < 6 || bd < 6) continue;
    const angles = candidateAngles(poly);
    const ratio = spec.ratio[0] + (spec.ratio[1] - spec.ratio[0]) * sample(ctx.seed, 'fp', parcel.serial);
    const target = Math.max(6, ctx.params.parcels.targetSize);
    const edgeBuffers = edgeBuffersOf(poly, activeBands, ctx.params.parcels.setback);
    const maxFoot = Math.max(4, Math.min(bw, bd) - 2 * uniformBuffer - 1);
    const baseW = clamp(target * ratio, 4, maxFoot);
    const baseD = clamp(baseW / spec.aspect, 3, maxFoot);
    const step = Math.max(2.5, Math.min(bw, bd) / 8);
    // 候选中心 = 加密网格 + 质心（保证至少有一个可行中心，不会因采样步长错过）
    const centers: Vec2[] = [centroid(poly)];
    for (let x = bounds.minX + step / 2; x < bounds.maxX; x += step) {
      for (let z = bounds.minZ + step / 2; z < bounds.maxZ; z += step) centers.push(v(x, z));
    }
    const candidates: CandidateRect[] = [];
    outer: for (const scale of [1, 0.8, 0.65]) {
      const w = baseW * scale; const d = baseD * scale;
      for (const c of centers) {
        for (const angle of angles) {
          const corners = cornersOf(c.x, c.z, w, d, angle);
          if (!footprintFits(poly, corners, edgeBuffers)) continue;
          candidates.push({ cx: c.x, cz: c.z, w, d, angle, area: w * d, corners });
          if (candidates.length >= slotCount * 8) break outer;
        }
      }
      if (candidates.length >= slotCount) break;
    }
    // 面积相同，按确定性哈希稳定排序后贪心选取互不重叠的槽位
    candidates.sort((a, b) => {
      const ha = hash32([ctx.seed, 'slot', parcel.serial, Math.round(a.cx * 100), Math.round(a.cz * 100), Math.round(a.angle * 1000)]);
      const hb = hash32([ctx.seed, 'slot', parcel.serial, Math.round(b.cx * 100), Math.round(b.cz * 100), Math.round(b.angle * 1000)]);
      return ha - hb;
    });
    const chosen: CandidateRect[] = [];
    for (const c of candidates) {
      if (chosen.length >= slotCount) break;
      const spaced = cornersOf(c.cx, c.cz, c.w + p.spacing, c.d + p.spacing, c.angle);
      if (chosen.some((o) => polygonsIntersect(spaced, o.corners))) continue;
      chosen.push(c);
    }

    for (let k = 0; k < chosen.length; k++) {
      if (sample(ctx.seed, 'occupy', parcel.serial, k) >= prob) continue;
      const c = chosen[k];
      const { h: rawH, factor } = heightAt(ctx, c.cx, c.cz, parcel.serial, k);
      const override = ctx.doc.overrides[`bld.${parcel.serial}.${k}`];
      const h = clamp(override?.height ?? rawH * spec.heightFactor * ctx.rules.height.zoneMultipliers[parcel.zone], 4, 500);
      const fscale = Math.min(override?.footprintScale ?? 1, 1.5);
      const w = c.w * fscale; const d = c.d * fscale;
      const footprint = cornersOf(c.cx, c.cz, w, d, c.angle);
      if (!footprintFits(poly, footprint, edgeBuffers)) continue;
      const fb = boundsOf(footprint) as Bounds;
      const color = override?.color ?? colorAt(ctx, parcel.serial, k, h, spec.colorBoost);
      const trace = [
        `stage=S4a · parcel=${parcel.id} · polygon ${poly.length} 顶点 · ${parcel.isConcave ? '凹' : '凸'} · 面积 ${parcel.area.toFixed(1)}m²`,
        `use=${builtUse} · archetype=${archetype}(${spec.label}) · zone=${parcel.zone}`,
        `density.base=${ctx.rules.density.base} × zoneMultipliers.${parcel.zone}=${zoneMult} → p=${prob.toFixed(3)}`,
        `旋转内接矩形：angle=${c.angle.toFixed(3)}rad · ${w.toFixed(2)}×${d.toFixed(2)}m · 逐边净距 ${edgeBuffers.map((x) => x.toFixed(1)).join('/')}m`,
        `height.profile=${ctx.rules.height.profile} f=${factor.toFixed(3)} × heightFactor=${spec.heightFactor} × zone=${ctx.rules.height.zoneMultipliers[parcel.zone]}`,
        `footprint 四角均落在 parcel.polygon 内`,
      ];
      if (override && Object.keys(override).length > 0) trace.push(`人工覆写：${JSON.stringify(override)}`);
      buildings.push({
        id: `bld.${parcel.serial}.${k}`, kind: 'building', cell: [parcel.serial, k], zone: parcel.zone,
        x: c.cx, z: c.cz, w, d, h, bounds: fb, color, roof: roofAt(ctx, parcel.serial, k, spec.roofBias),
        visible: override?.visible !== false && override?.deleted !== true,
        deleted: override?.deleted === true,
        hash: hash32([ctx.seed, 'building', parcel.serial, k]), trace,
        overridden: override !== undefined && Object.keys(override).length > 0,
        parcelId: parcel.id, archetype, landUse: builtUse, setback: uniformBuffer,
        orientation: c.angle, footprint: toPoints(footprint),
      });
      counts[archetype]++;
    }
  }
  return { buildings, counts, slotsByZone };
}

// ---------------------------------------------------------------------------
// S4b 多尺寸公园：直接采用地块多边形（可凹）
// ---------------------------------------------------------------------------

function maxInscribedCircle(poly: Polygon): { x: number; z: number; r: number } {
  const b = boundsOf(poly);
  let best = { x: centroid(poly).x, z: centroid(poly).z, r: 0 };
  const step = Math.max(3, Math.min(rectWidth(asRect(b)), rectDepth(asRect(b))) / 12);
  for (let x = b.minX; x <= b.maxX; x += step) {
    for (let z = b.minZ; z <= b.maxZ; z += step) {
      if (!pointInPolygon(poly, x, z)) continue;
      const r = distanceToEdges(poly, x, z);
      if (r > best.r) best = { x, z, r };
    }
  }
  return best;
}

function stageParks(ctx: StageContext): ParkLayer {
  const land = ctx.upstream('landuse');
  const { byId, polygonByParcel } = ctx.upstream('parcels');
  const p = ctx.params.parks;
  const { width, depth } = ctx.rules.terrain;
  const parks: ParkObject[] = [];

  for (const cluster of land.clusters) {
    const owners = cluster.parcelIds.map((id) => byId[id]).filter(Boolean);
    if (owners.length === 0) continue;
    const parts = owners.map((o) => toPoly(polygonByParcel[o.id] ?? o.polygon));

    // 尝试把共边地块合并为一个（可凹）公园多边形；任何一步失败或结果越界，
    // 就退回「每个地块一个公园对象」，保证公园范围严格贴合地块、绝不穿插。
    let poly = parts[0]; let mergedOk = parts.length === 1;
    if (!mergedOk) {
      mergedOk = true;
      for (let i = 1; i < parts.length; i++) {
        const m = mergePolygons(poly, parts[i]);
        if (!m) { mergedOk = false; break; }
        poly = m;
      }
    }
    if (mergedOk && !isSimple(poly)) mergedOk = false;
    if (mergedOk && !poly.every((q) => parts.some((part) => pointInPolygon(part, q.x, q.z)))) mergedOk = false;
    const groups = mergedOk
      ? [{ polygon: poly, parcelIds: cluster.parcelIds, suffix: '' }]
      : owners.map((o, i) => ({ polygon: parts[i], parcelIds: [o.id], suffix: `.${i}` }));

    const isPlaza = owners.every((o) => land.byParcel[o.id]?.use === 'plaza');
    const style: ParkObject['style'] = cluster.isCentral ? ctx.rules.openSpace.style
      : isPlaza ? 'plaza' : sample(ctx.seed, 'parkstyle', cluster.id) < p.styleJitter ? 'plaza' : 'park';

    for (const g of groups) {
      const finalPoly = g.polygon;
      const c = centroid(finalPoly);
      const b = boundsOf(finalPoly);
      const { nx, nz } = normalizeXZ(c.x, c.z, width, depth);
      let shape: ParkObject['shape'] = 'polygon';
      let cx = c.x; let cz = c.z; let radius = Math.min(rectWidth(asRect(b)), rectDepth(asRect(b))) / 2;
      if (cluster.isCentral && ctx.rules.openSpace.shape === 'circle') {
        const inc = maxInscribedCircle(finalPoly);
        radius = Math.min(ctx.rules.openSpace.radius, inc.r);
        if (radius >= 3) { shape = 'circle'; cx = inc.x; cz = inc.z; }
      }
      const polygon = shape === 'circle' ? circlePolygon(cx, cz, radius, 40) : toPoints(finalPoly);
      parks.push({
        id: `park.${cluster.id}${g.suffix}`, kind: 'park', clusterId: cluster.id,
        parcelIds: g.parcelIds, bounds: b,
        x: cx, z: cz, width: rectWidth(asRect(b)), depth: rectDepth(asRect(b)), radius,
        shape, polygon, style, sizeClass: cluster.sizeClass,
        zone: zoneOf(nx, nz), area: polygonArea(finalPoly),
        hash: hash32([ctx.seed, 'park', cluster.id, g.suffix]),
      });
    }
  }
  return { parks };
}

function circlePolygon(cx: number, cz: number, r: number, n: number): Polygon2 {
  return Array.from({ length: n }, (_, i) => {
    const t = (i / n) * Math.PI * 2;
    return { x: cx + Math.cos(t) * r, z: cz + Math.sin(t) * r };
  });
}

// ---------------------------------------------------------------------------
// S5 树木分布：多边形内采样 + 路缘 / 边界 / 株距约束
// ---------------------------------------------------------------------------

function stageTrees(ctx: StageContext): TreeLayer {
  const roads = ctx.upstream('roads');
  const { parcels } = ctx.upstream('parcels');
  const land = ctx.upstream('landuse');
  const { parks } = ctx.upstream('parks');
  const p = ctx.params.trees;
  const active = roads.bands.filter((b) => !b.suppressed && !b.boundary);
  const rejected: Record<string, number> = { road: 0, boundary: 0, shape: 0, buildable: 0, spacing: 0, cap: 0 };
  const trees: TreeObject[] = [];
  const grid = new SpatialGrid<TreeObject>(Math.max(4, p.minSpacing * 2));
  const used = new Set<string>();
  let candidateCount = 0;

  const roadClearance = (x: number, z: number): number => {
    let m = Infinity;
    for (const b of active) {
      m = Math.min(m, distanceToSegment(x, z, v(b.a.x, b.a.z), v(b.b.x, b.b.z)) - b.width / 2);
    }
    return Number.isFinite(m) ? Math.max(0, m) : 0;
  };
  // 树不得落在任何可建地块的建筑可用区（多项式内部净距判定）
  const builtPolys = parcels.filter((q) => BUILT_USES.includes(land.byParcel[q.id]?.use as BuiltUse)).map((q) => toPoly(q.polygon));
  const inBuildable = (x: number, z: number): boolean => builtPolys.some((poly) =>
    pointInPolygon(poly, x, z, -1e-6) && distanceToEdges(poly, x, z) >= ctx.params.parcels.setback);

  const accept = (id: string, x: number, z: number, context: TreeObject['context'], ownerId: string, boundaryClearance: number) => {
    candidateCount++;
    if (trees.length >= p.maxTrees) { rejected.cap++; return; }
    const rc = roadClearance(x, z);
    if (rc + 1e-4 < p.roadSetback) { rejected.road++; return; }
    if (boundaryClearance + 1e-4 < p.boundarySetback) { rejected.boundary++; return; }
    if (inBuildable(x, z)) { rejected.buildable++; return; }
    const probe = rectFromCenter(x, z, p.minSpacing * 2, p.minSpacing * 2);
    for (const o of grid.query(probe)) {
      if (Math.hypot(o.value.x - x, o.value.z - z) + 1e-4 < p.minSpacing) { rejected.spacing++; return; }
    }
    let finalId = id; let suffix = 1;
    while (used.has(finalId)) finalId = `${id}.${suffix++}`;
    used.add(finalId);
    const tree: TreeObject = {
      id: finalId, kind: 'tree', x, z,
      scale: 0.65 + sample(ctx.seed, 'tree-scale', finalId) * 0.7,
      hash: hash32([ctx.seed, 'tree', finalId]),
      context, ownerId,
      roadClearance: Math.round(rc * 1000) / 1000,
      boundaryClearance: Math.round(boundaryClearance * 1000) / 1000,
    };
    trees.push(tree);
    grid.insert(finalId, rectFromCenter(x, z, 0.1, 0.1), tree);
  };

  // 行道树：沿地块每条与道路共线的边，向多边形内侧按株距布点
  const d = Math.max(p.boundarySetback, p.roadSetback + 0.5);
  for (const parcel of parcels) {
    if (parcel.isCentralPark || parcel.frontage.length === 0) continue;
    const use = land.byParcel[parcel.id]?.use;
    if (use && !BUILT_USES.includes(use as BuiltUse)) continue;
    const poly = toPoly(parcel.polygon);
    const c = centroid(poly);
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]; const b = poly[(i + 1) % poly.length];
      const dx = b.x - a.x; const dz = b.z - a.z; const L = Math.hypot(dx, dz);
      if (L < 3) continue;
      let nx = -dz / L; let nz = dx / L;
      if (nx * (c.x - a.x) + nz * (c.z - a.z) < 0) { nx = -nx; nz = -nz; }
      const count = Math.max(1, Math.floor(L / Math.max(3, p.streetInterval)));
      for (let k = 1; k < count; k++) {
        const t = k / count;
        const jitter = (sample(ctx.seed, 'tree-j', parcel.serial, i, k) - 0.5) * 2 * p.jitter;
        const x = a.x + dx * t + nx * (d + jitter);
        const z = a.z + dz * t + nz * (d + jitter);
        if (!pointInPolygon(poly, x, z, -1e-6)) { rejected.shape++; continue; }
        const bc = distanceToEdges(poly, x, z);
        accept(`tree.street.${parcel.serial}.${i}.${k}`, x, z, 'street', parcel.id, bc);
      }
    }
  }

  // 公园树：公园多边形内网格候选（支持凹形）
  for (const park of parks) {
    const poly = toPoly(park.polygon);
    const b = boundsOf(poly);
    const step = Math.max(3, p.parkSpacing);
    const cap = park.sizeClass === 'central' ? ctx.rules.openSpace.treeCount : Number.MAX_SAFE_INTEGER;
    let placed = 0;
    for (let x = b.minX + step / 2; x < b.maxX; x += step) {
      for (let z = b.minZ + step / 2; z < b.maxZ; z += step) {
        if (placed >= cap) break;
        const jx = (sample(ctx.seed, 'pt-jx', park.id, Math.round(x), Math.round(z)) - 0.5) * 2 * p.jitter;
        const jz = (sample(ctx.seed, 'pt-jz', park.id, Math.round(x), Math.round(z)) - 0.5) * 2 * p.jitter;
        const px = x + jx; const pz = z + jz;
        if (!pointInPolygon(poly, px, pz, -1e-6)) { rejected.shape++; continue; }
        if (distanceToEdges(poly, px, pz) < ctx.params.parks.inset) { rejected.shape++; continue; }
        const bc = distanceToEdges(poly, px, pz);
        const before = trees.length;
        accept(`tree.park.${park.id}.${Math.round(x)}.${Math.round(z)}`, px, pz, 'park', park.id, bc);
        if (trees.length > before) placed++;
      }
    }
  }
  return { trees, candidateCount, rejected };
}

// ---------------------------------------------------------------------------
// E1 / E2 扩展占位阶段
// ---------------------------------------------------------------------------

function stageWater(ctx: StageContext): WaterLayer {
  const land = ctx.upstream('landuse');
  const { byId } = ctx.upstream('parcels');
  const reserved = land.uses.filter((u) => u.use === 'waterReserved').map((u) => u.parcelId);
  if (!ctx.params.extensions.water) return { surfaces: [], reservedParcelIds: reserved };
  return {
    surfaces: reserved.map((id) => ({ id: `water.${id}`, kind: 'water', bounds: byId[id].bounds, parcelIds: [id], placeholder: true })),
    reservedParcelIds: reserved,
  };
}
function stageTerrainFeatures(ctx: StageContext): TerrainFeatureLayer {
  const land = ctx.upstream('landuse');
  const { byId } = ctx.upstream('parcels');
  const reserved = land.uses.filter((u) => u.use === 'terrainReserved').map((u) => u.parcelId);
  if (!ctx.params.extensions.terrain) return { features: [], reservedParcelIds: reserved };
  return {
    features: reserved.map((id) => ({ id: `tf.${id}`, kind: 'terrainFeature', bounds: byId[id].bounds, parcelIds: [id], placeholder: true })),
    reservedParcelIds: reserved,
  };
}

// ---------------------------------------------------------------------------
// S6 汇总、统计、空间校验、指纹
// ---------------------------------------------------------------------------

function stageAssembly(ctx: StageContext): AssemblyLayer {
  const terrain = ctx.upstream('terrain');
  const roads = ctx.upstream('roads');
  const parcelLayer = ctx.upstream('parcels');
  const land = ctx.upstream('landuse');
  const build = ctx.upstream('buildings');
  const { parks } = ctx.upstream('parks');
  const trees = ctx.upstream('trees');
  const water = ctx.upstream('water');
  const tf = ctx.upstream('terrainFeatures');
  const { parcels } = parcelLayer;

  const byZone = ZONE_IDS.map<SceneStats['byZone'][number]>((zone) => {
    const list = build.buildings.filter((b) => b.zone === zone);
    const slots = build.slotsByZone[zone];
    return {
      zone, availableCells: slots, buildings: list.length,
      occupancy: slots > 0 ? Math.min(1, list.length / slots) : 0,
      avgHeight: list.length ? list.reduce((s, b) => s + b.h, 0) / list.length : 0,
      maxHeight: list.reduce((m, b) => Math.max(m, b.h), 0),
    };
  });
  const heights = build.buildings.map((b) => b.h);
  const parksBySize: Record<ParkSizeClass, number> = { pocket: 0, neighborhood: 0, central: 0 };
  for (const pk of parks) parksBySize[pk.sizeClass]++;
  const totalSlots = Object.values(build.slotsByZone).reduce((a, b) => a + b, 0);

  const stats: SceneStats = {
    cols: terrain.cols, rows: terrain.rows, totalCells: terrain.cols * terrain.rows,
    roadCells: 0, availableCells: parcels.filter((q) => !q.isCentralPark).length,
    buildingCount: build.buildings.filter((b) => !b.deleted).length,
    visibleBuildings: build.buildings.filter((b) => b.visible && !b.deleted).length,
    avgHeight: heights.length ? heights.reduce((a, b) => a + b, 0) / heights.length : 0,
    maxHeight: heights.reduce((m, h) => Math.max(m, h), 0),
    coverage: build.buildings.length / Math.max(1, totalSlots), byZone,
    roadLength: roads.segments.reduce((s, r) => s + r.length, 0),
    arterialSegments: roads.segments.filter((s) => s.cls === 'arterial').length,
    localSegments: roads.segments.filter((s) => s.cls === 'local').length,
    suppressedRoads: roads.suppressedIds.length,
    blocks: roads.blocks.length, parcels: parcels.length, parks: parks.length,
    parkArea: Math.round(parks.reduce((s, p) => s + p.area, 0)), parksBySize,
    landUseCounts: land.counts, archetypeCounts: build.counts,
    streetTrees: trees.trees.filter((t) => t.context === 'street').length,
    parkTrees: trees.trees.filter((t) => t.context === 'park').length,
    reservedWater: water.reservedParcelIds.length, reservedTerrain: tf.reservedParcelIds.length,
    roadNodes: roads.nodes.length, roadEdges: roads.segments.length,
    concaveParcels: parcelLayer.concaveCount,
    polygonParcels: parcels.filter((q) => q.polygon.length !== 4 || q.isConcave).length,
    faceArea: Math.round(roads.faceArea), siteArea: Math.round(roads.siteArea),
    skippedEdits: parcelLayer.skippedEdits.length,
  };

  const spatial = validateSpatialLayout({
    site: terrain.site, bands: roads.bands, parcels, uses: land.uses,
    buildings: build.buildings.filter((b) => !b.deleted), parks,
    trees: trees.trees, water: water.surfaces, params: ctx.params,
    faceIssues: roads.faceIssues, faceArea: roads.faceArea, siteArea: roads.siteArea,
    graph: ctx.doc.graph,
  });

  const fingerprint = fingerprintOf({
    seed: ctx.seed, rules: ctx.rules, graph: ctx.doc.graph,
    parcelEdits: ctx.doc.parcelEdits, overrides: ctx.doc.overrides,
    bands: roads.bands.map((b) => [b.id, b.a, b.b, b.width, b.cls, b.suppressed]),
    parcels: parcels.map((q) => [q.id, q.polygon, q.zone, q.isCentralPark, q.isConcave]),
    uses: land.uses.map((u) => [u.parcelId, u.use, u.clusterId]),
    buildings: build.buildings.map((b) => [b.id, b.footprint, b.h, b.color, b.roof, b.archetype, b.orientation, b.visible, b.deleted]),
    parks: parks.map((p) => [p.id, p.polygon, p.shape, p.style, p.sizeClass, p.radius]),
    trees: trees.trees.map((t) => [t.id, t.x, t.z, t.scale, t.context]),
    water: water.surfaces.map((w) => [w.id, w.bounds]),
    terrainFeatures: tf.features.map((f) => [f.id, f.bounds]),
  });
  return { stats, fingerprint, spatial };
}

export const STAGE_RUNNERS: { [K in StageId]: (ctx: StageContext) => StageOutputs[K] } = {
  terrain: stageTerrain, roads: stageRoads, parcels: stageParcels, landuse: stageLandUse,
  buildings: stageBuildings, parks: stageParks, trees: stageTrees,
  water: stageWater, terrainFeatures: stageTerrainFeatures, assembly: stageAssembly,
};

export function emptyExtensionLayer(id: 'water' | 'terrainFeatures'): WaterLayer | TerrainFeatureLayer {
  return id === 'water' ? { surfaces: [], reservedParcelIds: [] } : { features: [], reservedParcelIds: [] };
}

export function stageForPath(path: string): StageId {
  if (path.startsWith('pipeline.roads.')) return 'roads';
  if (path.startsWith('pipeline.parcels.')) return 'parcels';
  if (path.startsWith('pipeline.landUse.')) return 'landuse';
  if (path.startsWith('pipeline.buildings.')) return 'buildings';
  if (path.startsWith('pipeline.parks.') || path.startsWith('openSpace.')) return 'parks';
  if (path.startsWith('pipeline.trees.')) return 'trees';
  if (path.startsWith('pipeline.extensions.water')) return 'water';
  if (path.startsWith('pipeline.extensions.terrain')) return 'terrainFeatures';
  if (path.startsWith('terrain.')) return 'terrain';
  if (path.startsWith('density.') || path.startsWith('height.') || path.startsWith('material.')) return 'buildings';
  return 'assembly';
}
