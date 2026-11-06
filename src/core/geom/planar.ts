/**
 * 可编辑道路图 → 平面闭合面提取。
 *
 * 流程：
 *  1. 补齐场地四角边界节点与边界边；
 *  2. 自动求所有边的严格内部交点，在交点处分割边（保证输入一定是平面图，
 *     用户斜向连路时不会造出"交叉但未连通"的非法拓扑）；
 *  3. 建半边结构，按顶点出边方位角排序，环遍历提取全部面；
 *  4. 按有向面积符号剔除无界面，输出闭合、互不重叠的内部面（即地块）。
 *
 * 面与面共享同一条边（同一对节点），因此边界天然闭合、关系一致。
 */
import {
  GEO_EPS, boundsOf, centroid, cross, dedupe, dist, lerpV, polygonArea,
  signedArea, v, type Polygon, type Vec2,
} from './polygon';
import type { Bounds, GraphEdge, GraphNode, RoadClass, RoadGraph } from '../types';
export type { GraphEdge, GraphNode, RoadGraph } from '../types';

export interface Face { key: string; polygon: Polygon; nodeIds: string[] }
export interface FaceExtraction {
  faces: Face[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  issues: string[];
  outerArea: number;
}

const qkey = (x: number, z: number): string => `${Math.round(x * 1000)},${Math.round(z * 1000)}`;

function properIntersection(a: Vec2, b: Vec2, c: Vec2, d: Vec2): { t: number; u: number } | null {
  const rx = b.x - a.x; const rz = b.z - a.z;
  const sx = d.x - c.x; const sz = d.z - c.z;
  const den = cross(rx, rz, sx, sz);
  if (Math.abs(den) < GEO_EPS) return null;
  const qx = c.x - a.x; const qz = c.z - a.z;
  const t = cross(qx, qz, sx, sz) / den;
  const u = cross(qx, qz, rx, rz) / den;
  if (t <= GEO_EPS || t >= 1 - GEO_EPS || u <= GEO_EPS || u >= 1 - GEO_EPS) return null;
  return { t, u };
}

export interface NormalizedGraph { nodes: GraphNode[]; edges: GraphEdge[]; issues: string[] }

/** 去重节点 + 交点分割，返回合法平面图 */
export function normalizeGraph(graph: RoadGraph, site: Bounds): NormalizedGraph {
  const issues: string[] = [];
  const nodeMap = new Map<string, GraphNode>();
  const addNode = (x: number, z: number, boundary = false): string => {
    const k = qkey(x, z);
    const existing = nodeMap.get(k);
    if (existing) return existing.id;
    const id = `n.${nodeMap.size}`;
    nodeMap.set(k, { id, x, z, ...(boundary ? { boundary: true } : {}) });
    return id;
  };

  // 场地四角与四条边界（用角点 + 沿边节点，保证外轮廓闭合）
  const corners: Array<[number, number]> = [
    [site.minX, site.minZ], [site.maxX, site.minZ], [site.maxX, site.maxZ], [site.minX, site.maxZ],
  ];
  for (const [x, z] of corners) addNode(x, z, true);
  const rawNodes = new Map(graph.nodes.map((n) => [n.id, n]));
  for (const n of graph.nodes) {
    const x = Math.max(site.minX, Math.min(site.maxX, n.x));
    const z = Math.max(site.minZ, Math.min(site.maxZ, n.z));
    if (Math.abs(x - n.x) > 1e-3 || Math.abs(z - n.z) > 1e-3) issues.push(`节点 ${n.id} 被夹紧到场地内`);
    addNode(x, z, Boolean(n.boundary));
  }
  // 边界分段点 = 四角 + 所有落在边界上的图节点（道路端点因此自动接入外轮廓）。
  // 这一步是「道路与地块边界闭合」的关键：斜向道路的端点必须成为边界节点。
  const W = site.maxX - site.minX; const D = site.maxZ - site.minZ;
  const edgePoints: Array<Array<{ t: number; id: string }>> = [[], [], [], []];
  for (const n of nodeMap.values()) {
    const e = Math.max(W, D) * 1e-6 + 1e-4;
    if (Math.abs(n.z - site.minZ) < e) edgePoints[0].push({ t: (n.x - site.minX) / W, id: n.id });
    if (Math.abs(n.x - site.maxX) < e) edgePoints[1].push({ t: (n.z - site.minZ) / D, id: n.id });
    if (Math.abs(n.z - site.maxZ) < e) edgePoints[2].push({ t: (site.maxX - n.x) / W, id: n.id });
    if (Math.abs(n.x - site.minX) < e) edgePoints[3].push({ t: (site.maxZ - n.z) / D, id: n.id });
  }
  const boundaryLines: Array<[string, string]> = [];
  for (let i = 0; i < 4; i++) {
    const list = edgePoints[i].sort((a, b) => a.t - b.t);
    for (let k = 0; k < list.length - 1; k++) {
      if (list[k].id !== list[k + 1].id) boundaryLines.push([list[k].id, list[k + 1].id]);
    }
  }

  type RawEdge = { id: string; a: Vec2; b: Vec2; cls: RoadClass; width: number; boundary: boolean };
  const byId = new Map(Array.from(nodeMap.values()).map((n) => [n.id, n]));
  const rawEdges: RawEdge[] = [];
  for (const [i, [from, to]] of boundaryLines.entries()) {
    const a = byId.get(from)!; const b = byId.get(to)!;
    rawEdges.push({ id: `bnd.${i}`, a: v(a.x, a.z), b: v(b.x, b.z), cls: 'local', width: 0, boundary: true });
  }
  for (const e of graph.edges) {
    const a = rawNodes.get(e.from); const b = rawNodes.get(e.to);
    if (!a || !b) { issues.push(`边 ${e.id} 引用了不存在的节点`); continue; }
    if (dist(v(a.x, a.z), v(b.x, b.z)) < 0.5) { issues.push(`边 ${e.id} 长度过短，已忽略`); continue; }
    rawEdges.push({
      id: e.id,
      a: v(Math.max(site.minX, Math.min(site.maxX, a.x)), Math.max(site.minZ, Math.min(site.maxZ, a.z))),
      b: v(Math.max(site.minX, Math.min(site.maxX, b.x)), Math.max(site.minZ, Math.min(site.maxZ, b.z))),
      cls: e.cls, width: e.width, boundary: false,
    });
  }

  // 收集每条边上的所有严格内部交点参数
  const splits = rawEdges.map(() => new Set<number>([0, 1]));
  for (let i = 0; i < rawEdges.length; i++) {
    for (let j = i + 1; j < rawEdges.length; j++) {
      const hit = properIntersection(rawEdges[i].a, rawEdges[i].b, rawEdges[j].a, rawEdges[j].b);
      if (!hit) continue;
      splits[i].add(hit.t); splits[j].add(hit.u);
    }
  }

  const edges: GraphEdge[] = [];
  for (let i = 0; i < rawEdges.length; i++) {
    const e = rawEdges[i];
    const ts = Array.from(splits[i]).sort((x, y) => x - y);
    const ids: string[] = [];
    for (const t of ts) ids.push(addNode(lerpV(e.a, e.b, t).x, lerpV(e.a, e.b, t).z));
    for (let k = 0; k < ids.length - 1; k++) {
      if (ids[k] === ids[k + 1]) continue;
      edges.push({
        id: `${e.id}.${k}`, from: ids[k], to: ids[k + 1],
        cls: e.cls, width: e.width, ...(e.boundary ? { boundary: true } : {}),
      });
    }
  }
  return { nodes: Array.from(nodeMap.values()), edges, issues };
}

interface HalfEdge { from: string; to: string; edgeId: string; twin: number; visited: boolean }

/** 半边环遍历，提取全部面；无界面按面积符号剔除 */
export function extractFaces(graph: RoadGraph, site: Bounds, minArea = 20): FaceExtraction {
  const { nodes, edges, issues } = normalizeGraph(graph, site);
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const half: HalfEdge[] = [];
  for (const e of edges) {
    const a = nodeById.get(e.from); const b = nodeById.get(e.to);
    if (!a || !b || a.id === b.id) continue;
    const i = half.length;
    half.push({ from: a.id, to: b.id, edgeId: e.id, twin: i + 1, visited: false });
    half.push({ from: b.id, to: a.id, edgeId: e.id, twin: i, visited: false });
  }
  const outgoing = new Map<string, number[]>();
  for (let i = 0; i < half.length; i++) {
    const list = outgoing.get(half[i].from) ?? [];
    list.push(i); outgoing.set(half[i].from, list);
  }
  for (const [id, list] of outgoing) {
    const n = nodeById.get(id)!;
    list.sort((x, y) => {
      const ax = nodeById.get(half[x].to)!; const ay = nodeById.get(half[y].to)!;
      return Math.atan2(ax.z - n.z, ax.x - n.x) - Math.atan2(ay.z - n.z, ay.x - n.x);
    });
  }

  const rings: Polygon[] = [];
  for (let start = 0; start < half.length; start++) {
    if (half[start].visited) continue;
    const ring: Vec2[] = [];
    let h = start; let guard = 0;
    while (!half[h].visited && guard++ < half.length + 2) {
      half[h].visited = true;
      ring.push(v(nodeById.get(half[h].from)!.x, nodeById.get(half[h].from)!.z));
      const twin = half[h].twin;
      const list = outgoing.get(half[h].to)!;
      const k = list.indexOf(twin);
      h = list[(k - 1 + list.length) % list.length];
    }
    if (h === start && ring.length >= 3) {
      const clean = dedupe(ring);
      if (clean.length >= 3) rings.push(clean);
    }
  }

  let positives = 0; let negatives = 0;
  for (const r of rings) { if (signedArea(r) >= 0) positives++; else negatives++; }
  const mainSign = positives >= negatives ? 1 : -1;
  const siteArea = (site.maxX - site.minX) * (site.maxZ - site.minZ);
  let outerArea = 0;
  const candidates = rings.filter((r) => {
    const a = signedArea(r);
    if (a * mainSign > 0 && polygonArea(r) >= minArea) return true;
    if (a * mainSign < 0) outerArea += polygonArea(r);
    return false;
  });

  // 稳定 key：按质心排序后编号，道路微调时不会大面积重排
  const withCentroid = candidates.map((polygon) => ({ polygon, c: centroid(polygon) }));
  withCentroid.sort((a, b) => (a.c.z - b.c.z) || (a.c.x - b.c.x));
  const nodeByCoord = new Map(Array.from(nodeById.values()).map((n) => [qkey(n.x, n.z), n.id]));
  const faces: Face[] = withCentroid.map((f, i) => ({
    key: `f.${i}`,
    polygon: f.polygon,
    nodeIds: f.polygon.map((p) => nodeByCoord.get(qkey(p.x, p.z)) ?? ''),
  }));

  if (faces.length === 0) issues.push('未提取到任何有效地块面');
  if (outerArea > 0 && Math.abs(outerArea - siteArea) > siteArea * 0.02) {
    issues.push(`外部面面积 ${outerArea.toFixed(0)} 与场地面积 ${siteArea.toFixed(0)} 偏差较大，可能存在拓扑异常`);
  }
  return { faces, nodes, edges, issues, outerArea };
}

/** 面集合的面积和，应约等于场地面积（用于一致性断言） */
export function totalFaceArea(faces: Face[]): number {
  return faces.reduce((s, f) => s + polygonArea(f.polygon), 0);
}

export function faceBounds(f: Face): Bounds { return boundsOf(f.polygon); }
