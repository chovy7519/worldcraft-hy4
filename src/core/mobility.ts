/**
 * 人流 / 车流（v1.3.0）
 *
 * 与「撒点动画」的区别：路径不是独立生成的，而是从已修好的城市要素关系契约推导 ——
 *   - 车沿 RoadGraph 的节点游走形成闭合回路，车道偏移被夹紧在道路半宽内；
 *   - 人沿道路带外侧的步道与退界后的公园/广场范围运动，不进车行道、不穿建筑与水面；
 *   - 配额由「道路等级 × 沿线建筑密度」「公园面积 × 周边功能」决定，
 *     所以改建筑密度或公园比例，车流人流会跟着变 —— 城市是一个整体。
 *
 * 确定性：buildMobility() 是纯函数，所有相位/速度/配额走 sample(seed, 盐, 稳定序号)，
 * 不用 Math.random、不读时钟。动画层只用 elapsed 时间推进 phase，因此同一 SceneDocument
 * 在任意时刻 t 的位置都可复现，也不影响 generateScene 的指纹。
 */
import { pointInPolygon, v, type Polygon } from './geom/polygon';
import { hash32, sample } from './rng';
import { sidewalkOffsetWithin } from './spatialRules';
import type {
  BuildingObject, GeneratedScene, GraphNode, Point2, RoadSegment, SceneDocument, SpatialIssue,
} from './types';

export interface FlowPath {
  id: string;
  kind: 'vehicle' | 'pedestrian';
  /** 闭合折线：首尾不重复，渲染时按 length 取模循环 */
  points: Point2[];
  /** 每点到起点的累积弧长，长度 = points.length */
  cumulative: number[];
  length: number;
  /** 配额权重 */
  weight: number;
  ownerIds: string[];
  /** 该路径的平均道路半宽（校验用） */
  halfWidth: number;
  /**
   * 每一段（points[i] → points[(i+1)%n]）的语义。
   * 'lane' = 沿通行带；'crossing' = 路口人行横道 / 车辆转弯段，
   * 允许短暂跨越车行道。由生成器标记，校验器据此豁免，不靠几何半径猜测。
   */
  segmentKind: Array<'lane' | 'crossing'>;
}

export interface FlowAgent {
  id: string;
  kind: 'vehicle' | 'pedestrian';
  pathId: string;
  /** 初始相位 0..1 */
  phase: number;
  /** m/s */
  speed: number;
  /** 路径横向微偏移（m），不改变所属通行带 */
  lateral: number;
  /** 展示色号索引，确定性 */
  tone: number;
}

export interface MobilityScene {
  enabled: boolean;
  paths: FlowPath[];
  agents: FlowAgent[];
  stats: {
    vehicles: number;
    pedestrians: number;
    vehiclePaths: number;
    pedestrianPaths: number;
    parkLoops: number;
    totalPathLength: number;
  };
}

interface Leg { a: Point2; b: Point2; width: number; edgeId: string; cls: 'arterial' | 'local' }

const dist2 = (a: Point2, b: Point2): number => Math.hypot(a.x - b.x, a.z - b.z);

function makePath(
  id: string, kind: FlowPath['kind'], points: Point2[],
  weight: number, ownerIds: string[], halfWidth: number,
  segmentKind?: Array<'lane' | 'crossing'>,
): FlowPath | null {
  // 不过滤重复点：段索引必须与 segmentKind 严格对齐，零长段在插值时用 max(1e-6) 兜底
  const pts = points;
  if (pts.length < 2) return null;
  const cumulative: number[] = [0];
  for (let i = 1; i < pts.length; i++) cumulative.push(cumulative[i - 1] + dist2(pts[i - 1], pts[i]));
  const closing = dist2(pts[pts.length - 1], pts[0]);
  const length = cumulative[cumulative.length - 1] + closing;
  if (length < 4) return null;
  cumulative.push(length);
  const kinds = segmentKind ?? pts.map(() => 'lane' as const);
  return {
    id, kind, points: pts, cumulative, length,
    weight: Math.max(0.01, weight), ownerIds, halfWidth, segmentKind: kinds,
  };
}

/** 按行进方向右偏 offset 生成折线；反向边自动翻到另一侧，天然形成靠右双向 */
function legsToPolyline(
  legs: Leg[], offsetOf: (leg: Leg) => number,
): { points: Point2[]; segmentKind: Array<'lane' | 'crossing'> } {
  const pts: Point2[] = [];
  for (const leg of legs) {
    const dx = leg.b.x - leg.a.x;
    const dz = leg.b.z - leg.a.z;
    const len = Math.hypot(dx, dz) || 1;
    const nx = -dz / len;
    const nz = dx / len;
    const off = offsetOf(leg);
    pts.push({ x: leg.a.x + nx * off, z: leg.a.z + nz * off });
    pts.push({ x: leg.b.x + nx * off, z: leg.b.z + nz * off });
  }
  // 偶数段是沿通行带，奇数段是相邻 leg 之间的路口连接（过街 / 转弯）；
  // 最后一为闭合段（回路掉头）同样是过街。斜向路段也能被正确标记。
  const segmentKind = pts.map((_, i) => (i % 2 === 0 ? 'lane' : 'crossing') as 'lane' | 'crossing');
  if (segmentKind.length > 0) segmentKind[segmentKind.length - 1] = 'crossing';
  return { points: pts, segmentKind };
}

function reverseLegs(legs: Leg[]): Leg[] {
  return legs.slice().reverse().map((l) => ({ ...l, a: l.b, b: l.a }));
}

/** 闭合回路：去程 + 返程，车辆在两端掉头而不是凭空消失 */
function loopLegs(legs: Leg[]): Leg[] {
  return [...legs, ...reverseLegs(legs)];
}

function buildAdjacency(edges: RoadSegment[]): Map<string, RoadSegment[]> {
  const adj = new Map<string, RoadSegment[]>();
  for (const e of edges) {
    if (e.boundary) continue;
    if (!adj.has(e.fromNode)) adj.set(e.fromNode, []);
    if (!adj.has(e.toNode)) adj.set(e.toNode, []);
    adj.get(e.fromNode)!.push(e);
    adj.get(e.toNode)!.push(e);
  }
  return adj;
}

/** 确定性随机游走：禁止立即掉头（死胡同除外），步数由稳定序号决定 */
function walk(
  adj: Map<string, RoadSegment[]>, start: string, seed: number,
  salt: string, index: number, maxSteps: number,
  bandWidth: Map<string, number>,
): Leg[] {
  const legs: Leg[] = [];
  let current = start;
  let previous: RoadSegment | null = null;
  for (let step = 0; step < maxSteps; step++) {
    const options = (adj.get(current) ?? []).filter((e) => !previous || e.id !== previous.id);
    const usable = options.length > 0 ? options : (adj.get(current) ?? []);
    if (usable.length === 0) break;
    const pick = usable[Math.floor(sample(seed, salt, index, step) * usable.length) % usable.length];
    const from = current;
    const to = pick.fromNode === current ? pick.toNode : pick.fromNode;
    const a = pick.fromNode === from ? pick.a : pick.b;
    const b = pick.fromNode === from ? pick.b : pick.a;
    // RoadSegment.w 是渲染矩形的 AABB 宽，不是道路真实宽度；必须用 RoadBand.width
    legs.push({ a, b, width: bandWidth.get(pick.bandId) ?? pick.w, edgeId: pick.id, cls: pick.cls });
    previous = pick;
    current = to;
    if (current === start && step >= 2) break;
  }
  return legs;
}

function buildingDensityAt(buildings: BuildingObject[], x: number, z: number, radius = 30): number {
  let n = 0;
  for (const b of buildings) {
    if (Math.abs(b.x - x) <= radius && Math.abs(b.z - z) <= radius) n++;
  }
  return n;
}

/** 最大余数法分配配额：总数精确、结果确定，不依赖遍历顺序之外的状态 */
function allocate(total: number, weights: number[]): number[] {
  if (total <= 0 || weights.length === 0) return weights.map(() => 0);
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => (w / sum) * total);
  const out = raw.map(Math.floor);
  let left = total - out.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => (b.frac - a.frac) || (a.i - b.i));
  for (let k = 0; left > 0; k++, left--) out[order[k % order.length].i]++;
  return out;
}

/** 公园内环：取多边形顶点向质心收缩 15%，避免行人贴着绿地红线走 */
function parkLoop(poly: Point2[], factor = 0.85): Point2[] {
  let cx = 0; let cz = 0;
  for (const p of poly) { cx += p.x; cz += p.z; }
  cx /= poly.length; cz /= poly.length;
  return poly.map((p) => ({ x: cx + (p.x - cx) * factor, z: cz + (p.z - cz) * factor }));
}

export function buildMobility(doc: SceneDocument, scene: GeneratedScene): MobilityScene {
  const cfg = doc.rules.pipeline.mobility;
  const seed = doc.seed;
  const empty: MobilityScene = {
    enabled: false, paths: [], agents: [],
    stats: { vehicles: 0, pedestrians: 0, vehiclePaths: 0, pedestrianPaths: 0, parkLoops: 0, totalPathLength: 0 },
  };
  if (!cfg.enabled) return empty;

  const edges = scene.roadEdges.filter((e) => !e.boundary);
  const adj = buildAdjacency(edges);
  const bandWidth = new Map(scene.bands.map((b) => [b.id, b.width]));
  const nodes: GraphNode[] = scene.graphNodes;
  const halfWidths = edges.map((e) => e.w / 2);
  const minHalf = Math.max(0.8, Math.min(...halfWidths));
  const maxHalf = Math.max(...halfWidths);
  // 关系契约：车道偏移必须留在道路带内；步道必须落在建筑退界带之外、又不进入车行道
  const laneOffset = Math.min(cfg.laneOffset, Math.max(0.2, minHalf - 0.4));
  const sidewalkOffset = sidewalkOffsetWithin(doc.rules.pipeline);

  const paths: FlowPath[] = [];
  const startNodes = nodes.filter((n) => (adj.get(n.id) ?? []).length > 1).slice(0, 48);
  const routeCount = Math.min(28, startNodes.length);

  // --- 车辆回路 -----------------------------------------------------------
  for (let i = 0; i < routeCount; i++) {
    const legs = walk(adj, startNodes[i].id, seed, 'car-route', i, 7, bandWidth);
    if (legs.length < 2) continue;
    const loop = loopLegs(legs);
    const { points: pts, segmentKind } = legsToPolyline(loop, () => laneOffset);
    let weight = 0;
    for (const leg of legs) {
      const mid = { x: (leg.a.x + leg.b.x) / 2, z: (leg.a.z + leg.b.z) / 2 };
      const density = buildingDensityAt(scene.buildings, mid.x, mid.z);
      weight += (leg.cls === 'arterial' ? 2.2 : 1) * (1 + Math.min(1.2, density * 0.06));
    }
    const path = makePath(`veh.${i}`, 'vehicle', pts, weight, legs.map((l) => l.edgeId), minHalf, segmentKind);
    if (path) paths.push(path);
  }

  // --- 行人步道（道路两侧各一条，用同一批回路） ---------------------------
  for (let i = 0; i < routeCount; i++) {
    const legs = walk(adj, startNodes[i].id, seed, 'walk-route', i, 6, bandWidth);
    if (legs.length < 2) continue;
    for (const side of [1, -1] as const) {
      const loop = loopLegs(legs);
      const { points: pts, segmentKind } = legsToPolyline(loop, (leg) => side * (leg.width / 2 + sidewalkOffset));
      let weight = 0;
      for (const leg of legs) {
        const mid = { x: (leg.a.x + leg.b.x) / 2, z: (leg.a.z + leg.b.z) / 2 };
        weight += 1 + Math.min(1.5, buildingDensityAt(scene.buildings, mid.x, mid.z) * 0.08);
      }
      const path = makePath(
        `ped.sw.${i}.${side}`, 'pedestrian', pts, weight,
        legs.map((l) => l.edgeId), maxHalf + sidewalkOffset, segmentKind,
      );
      if (path) paths.push(path);
    }
  }

  // --- 公园 / 广场内环 ----------------------------------------------------
  let parkLoops = 0;
  for (let i = 0; i < scene.parks.length; i++) {
    const park = scene.parks[i];
    if (park.polygon.length < 3) continue;
    const ring = parkLoop(park.polygon);
    const path = makePath(`ped.park.${i}`, 'pedestrian', ring, Math.max(1, park.area / 600), [park.id], 0);
    if (path) { paths.push(path); parkLoops++; }
  }

  // --- 配额与代理 ---------------------------------------------------------
  const vehiclePaths = paths.filter((p) => p.kind === 'vehicle');
  const pedestrianPaths = paths.filter((p) => p.kind === 'pedestrian');
  const carQuota = allocate(Math.max(0, Math.round(cfg.vehicles)), vehiclePaths.map((p) => p.weight));
  const pedQuota = allocate(Math.max(0, Math.round(cfg.pedestrians)), pedestrianPaths.map((p) => p.weight));
  const agents: FlowAgent[] = [];

  vehiclePaths.forEach((path, pi) => {
    for (let i = 0; i < carQuota[pi]; i++) {
      agents.push({
        id: `car.${pi}.${i}`, kind: 'vehicle', pathId: path.id,
        phase: sample(seed, 'car-phase', path.id, i),
        speed: cfg.vehicleSpeed * (0.75 + 0.5 * sample(seed, 'car-speed', path.id, i)),
        lateral: (sample(seed, 'car-lateral', path.id, i) - 0.5) * 0.7,
        tone: hash32([seed, 'car-tone', path.id, i]) % 5,
      });
    }
  });
  pedestrianPaths.forEach((path, pi) => {
    for (let i = 0; i < pedQuota[pi]; i++) {
      agents.push({
        id: `ped.${pi}.${i}`, kind: 'pedestrian', pathId: path.id,
        phase: sample(seed, 'ped-phase', path.id, i),
        speed: cfg.pedestrianSpeed * (0.8 + 0.4 * sample(seed, 'ped-speed', path.id, i)),
        lateral: (sample(seed, 'ped-lateral', path.id, i) - 0.5) * 0.9,
        tone: hash32([seed, 'ped-tone', path.id, i]) % 5,
      });
    }
  });

  return {
    enabled: true,
    paths,
    agents,
    stats: {
      vehicles: agents.filter((a) => a.kind === 'vehicle').length,
      pedestrians: agents.filter((a) => a.kind === 'pedestrian').length,
      vehiclePaths: vehiclePaths.length,
      pedestrianPaths: pedestrianPaths.length,
      parkLoops,
      totalPathLength: Math.round(paths.reduce((s, p) => s + p.length, 0)),
    },
  };
}

/** 沿闭合路径按弧长插值；返回位置与朝向（弧度，绕 Y 轴） */
export function positionOnPath(path: FlowPath, t: number, lateral = 0): { x: number; z: number; angle: number; segment: number } {
  const n = path.points.length;
  const target = (((t % 1) + 1) % 1) * path.length;
  let seg = 0;
  while (seg < n - 1 && path.cumulative[seg + 1] < target) seg++;
  const a = path.points[seg];
  const b = path.points[(seg + 1) % n];
  const segLen = Math.max(1e-6, path.cumulative[seg + 1] - path.cumulative[seg]);
  const k = Math.min(1, Math.max(0, (target - path.cumulative[seg]) / segLen));
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len = Math.hypot(dx, dz) || 1;
  const nx = -dz / len;
  const nz = dx / len;
  return {
    x: a.x + dx * k + nx * lateral,
    z: a.z + dz * k + nz * lateral,
    angle: Math.atan2(dx, dz),
    segment: seg,
  };
}

/** 按关系契约独立复核流动代理：采样路径点，报告越界 */
export function validateMobility(mobility: MobilityScene, scene: GeneratedScene): SpatialIssue[] {
  const issues: SpatialIssue[] = [];
  if (!mobility.enabled) return issues;
  const bands = scene.bands.filter((b) => !b.suppressed && !b.boundary);
  const push = (code: string, a: string, detail: string) => {
    if (issues.length < 40) issues.push({ code, a, b: '-', detail });
  };
  const waterPolys: Polygon[] = scene.water
    .filter((w) => w.polygon && w.polygon.length >= 3)
    .map((w) => w.polygon!.map((q) => v(q.x, q.z)));
  // 用旋转足迹多边形而非 AABB：AABB 会把建筑外侧的合法步道误判为穿越
  const buildingPolys = scene.buildings
    .filter((b) => !b.deleted && b.footprint.length >= 3)
    .map((b) => ({ id: b.id, poly: b.footprint.map((q) => v(q.x, q.z)) }));
  const nodePoints = scene.graphNodes.map((n) => ({ x: n.x, z: n.z }));
  const nearestNode = (p: { x: number; z: number }): number =>
    nodePoints.reduce((m, n) => Math.min(m, Math.hypot(p.x - n.x, p.z - n.z)), Infinity);
  const maxHalf = Math.max(0, ...bands.map((b) => b.width / 2));
  const crossingRadius = Math.max(9, maxHalf + 5);
  // 路口豁免 = 结构化标记 OR 节点邻域：
  //  - segmentKind='crossing' 覆盖斜向路段下离节点 20 m 以上的长转弯连接段；
  //  - 半径兜底覆盖沿路段靠近路口、进入人车混行区的采样点。
  // 只靠半径会漏判斜交路口，只靠段标记会误判路口邻域，两者必须同时生效。
  for (const path of mobility.paths) {
    const steps = Math.min(80, Math.max(8, Math.round(path.length / 12)));
    for (let s = 0; s < steps; s++) {
      const p = positionOnPath(path, s / steps);
      const near = nearestNode(p);
      const crossing = path.segmentKind[p.segment] === 'crossing' || near < crossingRadius;
      const pa = path.points[p.segment];
      const pb = path.points[(p.segment + 1) % path.points.length];
      const pdx = pb.x - pa.x;
      const pdz = pb.z - pa.z;
      const plen = Math.hypot(pdx, pdz) || 1;
      let minClearance = Infinity;
      let alongRoad = false;
      for (const band of bands) {
        const dx = band.b.x - band.a.x;
        const dz = band.b.z - band.a.z;
        const len = Math.hypot(dx, dz) || 1;
        const t = Math.max(0, Math.min(1, ((p.x - band.a.x) * dx + (p.z - band.a.z) * dz) / (len * len)));
        const cx = band.a.x + dx * t;
        const cz = band.a.z + dz * t;
        const d = Math.hypot(p.x - cx, p.z - cz) - band.width / 2;
        minClearance = Math.min(minClearance, d);
        if (d < -0.05) {
          // 关系契约：行人不得「沿」车行道行进；与道路近似垂直的横穿是合法过街
          const parallel = Math.abs((pdx * dx + pdz * dz) / (plen * len));
          if (parallel > 0.7) alongRoad = true;
        }
      }
      if (path.kind === 'vehicle') {
        if (!crossing && minClearance > 0.35) {
          push('VEHICLE_OFF_ROAD', path.id, `车辆路径偏离道路带 ${minClearance.toFixed(2)} m`);
        }
      } else {
        if (!crossing && alongRoad) {
          push('PEDESTRIAN_ON_ROAD', path.id,
            `行人步道进入车行道 @(${p.x.toFixed(1)},${p.z.toFixed(1)})，最近路口 ${near.toFixed(1)} m`);
        }
        if (waterPolys.some((poly) => pointInPolygon(poly, p.x, p.z, -1e-6))) {
          push('PEDESTRIAN_IN_WATER', path.id, '行人路径穿过水面');
        }
        for (const b of buildingPolys) {
          if (pointInPolygon(b.poly, p.x, p.z, -1e-6)) {
            push('PEDESTRIAN_INSIDE_BUILDING', path.id, `行人路径穿过建筑 ${b.id}`);
            break;
          }
        }
      }
    }
  }
  return issues;
}
