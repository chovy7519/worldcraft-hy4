/**
 * 空间关系校验器（v1.2.0 多边形版）。
 *
 * 校验对象是生成结果本身：闭合面面积守恒、地块简单且互不重叠、
 * 建筑旋转足迹 ⊂ 地块多边形、公园多边形 ⊂ 所属地块、树木净距与包含关系、
 * 道路图无悬空节点。报告随 GeneratedScene 返回。
 */
import { SpatialGrid, type Rect } from './geometry';
import {
  distanceToEdges, distanceToSegment, isSimple, pointInPolygon,
  polygonsOverlap, v, type Polygon,
} from '../geom/polygon';
import type {
  Bounds, BuildingObject, ParcelObject, ParcelUse, ParkObject, PipelineRules, Polygon2,
  RoadBand, RoadGraph, SpatialIssue, SpatialReport, TreeObject, WaterSurface,
} from '../types';

export interface LayoutInput {
  site: Bounds;
  bands: RoadBand[];
  parcels: ParcelObject[];
  uses: ParcelUse[];
  buildings: BuildingObject[];
  parks: ParkObject[];
  trees: TreeObject[];
  water: WaterSurface[];
  params: PipelineRules;
  faceIssues?: string[];
  faceArea?: number;
  siteArea?: number;
  graph?: RoadGraph;
}

const EPS = 1e-4;
const asRect = (b: Bounds): Rect => ({ minX: b.minX, maxX: b.maxX, minZ: b.minZ, maxZ: b.maxZ });
const toPoly = (p: Polygon2): Polygon => p.map((q) => v(q.x, q.z));

export function validateSpatialLayout(input: LayoutInput): SpatialReport {
  const { site, bands, parcels, uses, buildings, parks, trees, water, params } = input;
  const faceIssues = input.faceIssues ?? [];
  const faceArea = input.faceArea ?? (site.maxX - site.minX) * (site.maxZ - site.minZ);
  const siteArea = input.siteArea ?? (site.maxX - site.minX) * (site.maxZ - site.minZ);
  const graph: RoadGraph = input.graph ?? { nodes: [], edges: [] };
  const issues: SpatialIssue[] = [];
  const checks: Record<string, number> = {};
  const active = bands.filter((b) => !b.suppressed && !b.boundary);
  const parcelById = new Map(parcels.map((p) => [p.id, p]));
  const push = (code: string, a: string, b: string, detail: string) => {
    if (issues.length < 240) issues.push({ code, a, b, detail });
  };

  // --- 1. 面提取守恒 -------------------------------------------------------
  if (siteArea > 0 && Math.abs(faceArea - siteArea) > siteArea * 0.02) {
    push('FACE_AREA_MISMATCH', 'faces', 'site', `闭合面面积 ${faceArea.toFixed(0)} 与场地 ${siteArea.toFixed(0)} 偏差 > 2%`);
  }
  for (const m of faceIssues) push('FACE_ISSUE', 'graph', '-', m);
  const parcelArea = parcels.reduce((s, p) => s + p.area, 0);
  if (faceArea > 0 && Math.abs(parcelArea - faceArea) > faceArea * 0.03) {
    push('PARCEL_AREA_MISMATCH', 'parcels', 'faces', `地块面积和 ${parcelArea.toFixed(0)} 与闭合面 ${faceArea.toFixed(0)} 偏差 > 3%`);
  }
  checks.faceArea = Math.round(faceArea);
  checks.parcelArea = Math.round(parcelArea);

  // --- 2. 道路图拓扑 -------------------------------------------------------
  const degree = new Map<string, number>();
  for (const e of graph.edges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  }
  const nodeIds = new Set(graph.nodes.map((n) => n.id));
  for (const e of graph.edges) {
    if (!nodeIds.has(e.from) || !nodeIds.has(e.to)) push('GRAPH_BAD_ENDPOINT', e.id, '-', '路段引用了不存在的节点');
  }
  // 孤立节点是合法编辑中间态（用户可能稍后连边），只统计不报错
  checks.isolatedNodes = graph.nodes.filter((n) => (degree.get(n.id) ?? 0) === 0).length;
  checks.graphNodes = graph.nodes.length;
  checks.graphEdges = graph.edges.length;

  // --- 3. 地块多边形：简单、闭合、互不重叠 ---------------------------------
  let simpleCount = 0;
  for (const p of parcels) {
    const poly = toPoly(p.polygon);
    if (poly.length >= 3 && isSimple(poly)) simpleCount++;
    else push('PARCEL_NOT_SIMPLE', p.id, '-', `地块多边形非简单（${poly.length} 顶点）`);
    if (p.area <= 0) push('PARCEL_DEGENERATE', p.id, '-', '地块面积非正');
  }
  checks.simpleParcels = simpleCount;
  let parcelOverlaps = 0;
  const parcelGrid = new SpatialGrid<ParcelObject>(64);
  for (const p of parcels) parcelGrid.insert(p.id, asRect(p.bounds), p);
  for (const p of parcels) {
    for (const o of parcelGrid.query(asRect(p.bounds))) {
      if (o.id <= p.id) continue;
      if (polygonsOverlap(toPoly(p.polygon), toPoly(o.value.polygon))) {
        parcelOverlaps++; push('PARCEL_OVERLAP', p.id, o.id, '两地块多边形重叠');
      }
    }
  }
  checks.parcelOverlaps = parcelOverlaps;

  // --- 4. 建筑旋转足迹 ⊂ 地块多边形、互不重叠、避开道路 -------------------
  const footprints = new Map<string, Polygon>();
  let insideCount = 0; let roadConflicts = 0;
  for (const b of buildings) {
    const p = parcelById.get(b.parcelId);
    if (!p) { push('BUILDING_ORPHAN', b.id, b.parcelId, '建筑引用了不存在的地块'); continue; }
    const poly = toPoly(p.polygon);
    const fp = toPoly(b.footprint);
    footprints.set(b.id, fp);
    const allInside = fp.length === 4 && fp.every((q) => pointInPolygon(poly, q.x, q.z));
    if (!allInside) push('BUILDING_OUTSIDE_POLYGON', b.id, p.id, '建筑足迹角点越出地块多边形');
    else insideCount++;
    for (const band of active) {
      const minD = Math.min(...fp.map((q) => distanceToSegment(q.x, q.z, v(band.a.x, band.a.z), v(band.b.x, band.b.z))));
      if (minD < band.width / 2 - EPS) { roadConflicts++; push('BUILDING_ROAD_OVERLAP', b.id, band.id, '建筑足迹压占道路带'); }
    }
  }
  checks.buildingInsidePolygon = insideCount;
  checks.buildingRoadOverlap = roadConflicts;
  const buildingGrid = new SpatialGrid<BuildingObject>(32);
  for (const b of buildings) buildingGrid.insert(b.id, asRect(b.bounds), b);
  let pairOverlap = 0;
  for (const b of buildings) {
    for (const o of buildingGrid.query(asRect(b.bounds))) {
      if (o.id <= b.id) continue;
      const a = footprints.get(b.id); const c = footprints.get(o.id);
      if (a && c && polygonsOverlap(a, c)) { pairOverlap++; push('BUILDING_FOOTPRINT_OVERLAP', b.id, o.id, '两栋建筑足迹相交'); }
    }
  }
  checks.buildingPairOverlap = pairOverlap;

  // --- 5. 公园多边形 ⊂ 所属地块，且不与可建地块重叠 -----------------------
  const builtIds = new Set(uses.filter((u) => ['office', 'residential', 'research', 'commercial'].includes(u.use)).map((u) => u.parcelId));
  let parkContained = 0;
  for (const park of parks) {
    const poly = toPoly(park.polygon);
    const owners = park.parcelIds.map((id) => parcelById.get(id)).filter((x): x is ParcelObject => Boolean(x));
    const ownerPolys = owners.map((o) => toPoly(o.polygon));
    if (ownerPolys.length === 0) { push('PARK_ORPHAN', park.id, '-', '公园没有关联地块'); continue; }
    const outside = poly.some((q) => !ownerPolys.some((op) => pointInPolygon(op, q.x, q.z)));
    if (outside) push('PARK_OUTSIDE_POLYGON', park.id, park.parcelIds[0], '公园多边形越出所属地块');
    else parkContained++;
    for (const q of parcels) {
      if (!builtIds.has(q.id) || park.parcelIds.includes(q.id)) continue;
      // 用严格多边形相交判定（共边/共顶点不算），避免射线法在边界顶点上的误报
      if (polygonsOverlap(poly, toPoly(q.polygon))) {
        push('PARK_BUILT_PARCEL_OVERLAP', park.id, q.id, '公园范围与可建地块重叠');
      }
    }
    if (!isSimple(poly)) push('PARK_NOT_SIMPLE', park.id, '-', '公园多边形自交');
  }
  checks.parkContained = parkContained;

  // --- 6. 树木：在 owner 多边形内、净距、株距、不落建筑内 -----------------
  const parkById = new Map(parks.map((p) => [p.id, p]));
  const treeGrid = new SpatialGrid<TreeObject>(Math.max(4, params.trees.minSpacing * 2));
  let minSpacing = Infinity; let minRoad = Infinity;
  for (const t of trees) {
    let ownerPoly: Polygon | null = null;
    if (t.context === 'park') {
      const pk = parkById.get(t.ownerId);
      if (pk) ownerPoly = toPoly(pk.polygon);
    } else {
      const pc = parcelById.get(t.ownerId);
      if (pc) ownerPoly = toPoly(pc.polygon);
    }
    if (!ownerPoly) { push('TREE_ORPHAN', t.id, t.ownerId, '树没有合法的 owner 多边形'); continue; }
    if (!pointInPolygon(ownerPoly, t.x, t.z)) push('TREE_OUTSIDE_OWNER', t.id, t.ownerId, '树心越出 owner 多边形');
    let rc = Infinity;
    for (const band of active) rc = Math.min(rc, distanceToSegment(t.x, t.z, v(band.a.x, band.a.z), v(band.b.x, band.b.z)) - band.width / 2);
    if (Number.isFinite(rc)) minRoad = Math.min(minRoad, Math.max(0, rc));
    if (rc + EPS < params.trees.roadSetback) push('TREE_ROAD_CLEARANCE', t.id, '-', `距路缘 ${rc.toFixed(2)} < ${params.trees.roadSetback}`);
    const bc = distanceToEdges(ownerPoly, t.x, t.z);
    if (bc + EPS < params.trees.boundarySetback) push('TREE_BOUNDARY_CLEARANCE', t.id, t.ownerId, `距边界 ${bc.toFixed(2)} < ${params.trees.boundarySetback}`);
    for (const b of buildingGrid.query({ minX: t.x - 0.05, maxX: t.x + 0.05, minZ: t.z - 0.05, maxZ: t.z + 0.05 } as Bounds)) {
      const fp = footprints.get(b.id);
      if (fp && pointInPolygon(fp, t.x, t.z)) { push('TREE_INSIDE_BUILDING', t.id, b.id, '树心落在建筑足迹内'); break; }
    }
    const probe: Rect = { minX: t.x - params.trees.minSpacing, maxX: t.x + params.trees.minSpacing, minZ: t.z - params.trees.minSpacing, maxZ: t.z + params.trees.minSpacing };
    for (const o of treeGrid.query(probe)) {
      const d = Math.hypot(o.value.x - t.x, o.value.z - t.z);
      minSpacing = Math.min(minSpacing, d);
      if (d + EPS < params.trees.minSpacing) push('TREE_SPACING', t.id, o.id, `株距 ${d.toFixed(2)} < ${params.trees.minSpacing}`);
    }
    treeGrid.insert(t.id, { minX: t.x - 0.05, maxX: t.x + 0.05, minZ: t.z - 0.05, maxZ: t.z + 0.05 }, t);
  }
  checks.trees = trees.length;
  checks.parks = parks.length;
  checks.buildings = buildings.length;

  // --- 7. 水面占位 ---------------------------------------------------------
  for (const w of water) {
    if (w.bounds.minX < site.minX - EPS || w.bounds.maxX > site.maxX + EPS
      || w.bounds.minZ < site.minZ - EPS || w.bounds.maxZ > site.maxZ + EPS) {
      push('WATER_OUT_OF_SITE', w.id, 'site', '水面超出场地');
    }
  }

  return {
    ok: issues.length === 0, issues, checks,
    minTreeSpacing: Number.isFinite(minSpacing) ? Math.round(minSpacing * 1000) / 1000 : 0,
    minRoadClearance: Number.isFinite(minRoad) ? Math.round(minRoad * 1000) / 1000 : 0,
  };
}
