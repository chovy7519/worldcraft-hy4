/**
 * 城市要素关系契约（v1.3.0 规则层）—— 单一事实来源
 *
 * 起因：实测默认场景 57/57 个公园与道路带重叠 28.3%，而建筑 0 栋、乔木 0 株越界，
 * 空间校验却 PASS。根因不是某个图层画歪，而是**关系没有统一声明**：
 *   - 建筑在 stageBuildings 里自己用 edgeBuffersOf() 算临路退界；
 *   - 树在 stageTrees 里自己用 trees.roadSetback；
 *   - 公园 / 广场 / 水面完全不做退界；
 *   - 校验器只检查了它恰好想到的几对关系。
 * 结果就是「城市被拆成互不相干的图层」，改一处参数不会传导到别处。
 *
 * 本模块把三件事收拢到一处：
 *   1. RELATION_MATRIX：显式声明谁定义谁、谁避让谁、谁沿谁流动、由哪个参数驱动；
 *   2. clearanceFor()：全体要素共用的退界量，复用已有参数，不新增重复旋钮；
 *   3. bandPolygon() / setbackFromRoads()：生成侧与校验侧共用的几何口径。
 *
 * 不变量：所有几何函数都是纯函数，不依赖生成顺序；相同输入 → 相同输出。
 */
import {
  boundsOf, centroid, clipHalfPlane, dedupe, distanceToSegment, isSimple,
  polygonArea, segmentsProperlyIntersect, v,
  type Polygon, type Vec2,
} from './geom/polygon';
import type { PipelineRules, RoadBand, Polygon2 } from './types';

export const ELEMENT_KINDS = [
  'road', 'parcel', 'building', 'park', 'plaza', 'water', 'terrain', 'tree', 'vehicle', 'pedestrian',
] as const;
export type ElementKind = typeof ELEMENT_KINDS[number];

export type RelationKind =
  | 'defines'       // 主体决定客体的几何边界
  | 'containedBy'   // 主体必须落在客体内
  | 'setbackFrom'   // 主体必须从客体退让指定净距
  | 'disjointWith'  // 两者不得有面积重叠
  | 'follows'       // 主体沿客体的网络运动
  | 'avoids'        // 主体不得进入客体
  | 'drives';       // 客体的密度/属性决定主体的分布强度

export interface RelationRule {
  subject: ElementKind;
  object: ElementKind;
  kind: RelationKind;
  rule: string;
  /** 驱动这条规则的唯一参数路径；空表示由几何结构本身保证 */
  parameter?: string;
  /** 校验器里的 code；空表示由生成侧结构性保证 */
  enforcedBy?: string;
  note?: string;
}

/**
 * 关系矩阵。新增要素时必须在这里登记，否则 relationCoverage() 的测试会失败。
 * 「城市是一个整体」在工程上的落点就是这张表：参数改动通过它传导，校验通过它对齐。
 */
export const RELATION_MATRIX: RelationRule[] = [
  {
    subject: 'road', object: 'road', kind: 'setbackFrom',
    rule: '两条近似平行的独立道路带之间须留出 2 × 步道通行带的净距；交叉口与共享端点的连通段豁免',
    parameter: 'pipeline.mobility.sidewalkWidth', enforcedBy: 'ROAD_CORRIDOR_NARROW',
    note: '阈值 corridorMinGap() 由 sidewalkWidth 派生；图形编辑把两条路挪到过近时判违规并给出提示',
  },
  {
    subject: 'road', object: 'parcel', kind: 'defines',
    rule: '道路中心线经平面闭合面提取，决定地块红线的拓扑边界',
    enforcedBy: 'FACE_AREA_MISMATCH', note: 'Σ闭合面面积 = Σ地块面积 = 场地面积',
  },
  {
    subject: 'parcel', object: 'road', kind: 'containedBy',
    rule: '地块红线由道路围合；允许压在道路带内（gap 只是地块间缝隙，不是临路退界）',
    note: '历史口径。这正是公园直接采用地块多边形时会压路的原因，不能靠改红线来修',
  },
  {
    subject: 'building', object: 'road', kind: 'setbackFrom',
    rule: '建筑旋转足迹逐边退让：临主干路/支路取道路半宽 + 净距，其余取 parcels.setback',
    parameter: 'pipeline.parcels.setback', enforcedBy: 'BUILDING_ROAD_OVERLAP',
  },
  {
    subject: 'building', object: 'parcel', kind: 'containedBy',
    rule: '建筑足迹四角必须落在所属地块多边形内',
    enforcedBy: 'BUILDING_OUTSIDE_POLYGON',
  },
  {
    subject: 'building', object: 'park', kind: 'disjointWith',
    rule: '建筑不得与公园/广场范围重叠',
    enforcedBy: 'PARK_BUILT_PARCEL_OVERLAP',
  },
  {
    subject: 'park', object: 'road', kind: 'setbackFrom',
    rule: '公园/广场多边形必须从道路带外缘再退让 parks.inset（与树位净距共用同一参数）',
    parameter: 'pipeline.parks.inset', enforcedBy: 'PARK_ROAD_OVERLAP',
  },
  {
    subject: 'plaza', object: 'road', kind: 'setbackFrom',
    rule: '广场与公园共用退界规则，不因铺装形式而豁免',
    parameter: 'pipeline.parks.inset', enforcedBy: 'PARK_ROAD_OVERLAP',
  },
  {
    subject: 'park', object: 'parcel', kind: 'containedBy',
    rule: '退界后的公园多边形仍须落在所属地块红线内',
    enforcedBy: 'PARK_OUTSIDE_POLYGON',
  },
  {
    subject: 'water', object: 'road', kind: 'setbackFrom',
    rule: '水面从道路带外缘退让 extensions.bankSetback，且水面 ⊆ 原始岸线',
    parameter: 'pipeline.extensions.bankSetback', enforcedBy: 'WATER_ROAD_OVERLAP',
  },
  {
    subject: 'water', object: 'building', kind: 'disjointWith',
    rule: '水面不得压占建筑足迹', enforcedBy: 'WATER_OUTSIDE_SHORELINE',
  },
  {
    subject: 'terrain', object: 'parcel', kind: 'containedBy',
    rule: '高程场采样点必须落在 terrainReserved 地块范围内',
    enforcedBy: 'TERRAIN_OUT_OF_SITE',
  },
  {
    subject: 'terrain', object: 'road', kind: 'follows',
    rule: '地形要素的道路纵断采样沿路段 t=0..1 取值，不改变车行道平面范围',
    note: '高程场是数据图层，尚未回填到建筑/道路的 Y 坐标',
  },
  {
    subject: 'tree', object: 'road', kind: 'setbackFrom',
    rule: '树心到路缘净距不小于 trees.roadSetback',
    parameter: 'pipeline.trees.roadSetback', enforcedBy: 'TREE_ROAD_CLEARANCE',
  },
  {
    subject: 'tree', object: 'building', kind: 'avoids',
    rule: '树心不得落在建筑足迹内', enforcedBy: 'TREE_INSIDE_BUILDING',
  },
  {
    subject: 'vehicle', object: 'road', kind: 'follows',
    rule: '车辆只沿 RoadGraph 路段运动，车道偏移量小于道路半宽，路口按图连通性转向',
    parameter: 'pipeline.mobility.laneOffset', enforcedBy: 'VEHICLE_OFF_ROAD',
  },
  {
    subject: 'pedestrian', object: 'road', kind: 'follows',
    rule: '行人沿道路带外侧步道运动；不得沿车行道行进，但与道路近垂直的横穿（含斜交路口过街）合法',
    parameter: 'pipeline.mobility.sidewalkWidth', enforcedBy: 'PEDESTRIAN_ON_ROAD',
    note: '校验按路径方向与道路方向夹角判定；路口连接段另由 segmentKind=crossing 标记豁免',
  },
  {
    subject: 'pedestrian', object: 'park', kind: 'follows',
    rule: '行人可进入退界后的公园/广场范围，公园面积与数量提高该片区人流权重',
    note: '由生成侧结构性保证：公园环线直接取退界后的公园多边形向内收缩',
  },
  {
    subject: 'pedestrian', object: 'building', kind: 'avoids',
    rule: '行人不得穿过建筑足迹', enforcedBy: 'PEDESTRIAN_INSIDE_BUILDING',
  },
  {
    subject: 'pedestrian', object: 'water', kind: 'avoids',
    rule: '行人不得穿过水面', enforcedBy: 'PEDESTRIAN_IN_WATER',
  },
  {
    subject: 'road', object: 'vehicle', kind: 'drives',
    rule: '道路等级（arterial/local）与沿线建筑密度共同决定该路段车辆配额',
    parameter: 'pipeline.mobility.vehicles',
  },
  {
    subject: 'park', object: 'pedestrian', kind: 'drives',
    rule: '公园/广场面积与周边功能配比共同决定该片区行人配额',
    parameter: 'pipeline.mobility.pedestrians',
  },
];

export function relationsFor(element: ElementKind): RelationRule[] {
  return RELATION_MATRIX.filter((r) => r.subject === element || r.object === element);
}

export function describeRelations(): string[] {
  return RELATION_MATRIX.map((r) => `${r.subject} → ${r.object} [${r.kind}] ${r.rule}`);
}

/** 关系矩阵里声明的校验 code，供测试与 Inspector 对齐使用 */
export function declaredChecks(): string[] {
  return Array.from(new Set(RELATION_MATRIX.map((r) => r.enforcedBy).filter((x): x is string => Boolean(x))));
}

// ---------------------------------------------------------------------------
// 统一退界量：复用已有参数，绝不新增「同一件事两个旋钮」
// ---------------------------------------------------------------------------

/**
 * 建筑相对道路带外缘的最小净距。
 *
 * 关键传导：步道要占 sidewalkWidth，建筑就必须让出「步道宽 + 0.4 m 余量」。
 * v1.3.0 之前这里硬编码 0.5 m，人行道和建筑争同一条 1 m 带，行人路径直接穿楼。
 * 改一次 sidewalkWidth，建筑退界、步道位置、空间校验同时跟着变 —— 这就是「城市是整体」。
 */
export function buildingRoadClearance(params: PipelineRules): number {
  return Math.max(0.5, params.mobility.sidewalkWidth + 0.4);
}

/** 步道中心相对道路带外缘的实际偏移：永远留在建筑退界线内侧 */
export function sidewalkOffsetWithin(params: PipelineRules): number {
  return Math.min(params.mobility.sidewalkWidth, Math.max(0.3, buildingRoadClearance(params) - 0.4));
}

/** 两条有限线段之间的最短距离；严格相交时为 0 */
export function segmentDistance(a: Vec2, b: Vec2, c: Vec2, d: Vec2): number {
  if (segmentsProperlyIntersect(a, b, c, d)) return 0;
  return Math.min(
    distanceToSegment(a.x, a.z, c, d),
    distanceToSegment(b.x, b.z, c, d),
    distanceToSegment(c.x, c.z, a, b),
    distanceToSegment(d.x, d.z, a, b),
  );
}

/**
 * 相邻道路带之间必须留出的最小净距（通行廊道规则）。
 * 两侧各一条步道通行带，所以是 2 × buildingRoadClearance。
 * 由 sidewalkWidth 派生，不新增独立旋钮：调步道宽度，这条阈值同步变化。
 */
export function corridorMinGap(params: PipelineRules): number {
  return 2 * buildingRoadClearance(params);
}

/** 两条带是否近似平行（夹角约 < 20°）；不平行的相交按路口处理，不适用廊道净距 */
export function nearParallel(a: { a: { x: number; z: number }; b: { x: number; z: number } },
  b: { a: { x: number; z: number }; b: { x: number; z: number } }): boolean {
  const ax = a.b.x - a.a.x; const az = a.b.z - a.a.z;
  const bx = b.b.x - b.a.x; const bz = b.b.z - b.a.z;
  const al = Math.hypot(ax, az) || 1;
  const bl = Math.hypot(bx, bz) || 1;
  return Math.abs((ax * bx + az * bz) / (al * bl)) >= 0.94;
}

/** 两条带是否共享端点（同一条路的连续段 / 同一路口的相邻边），这类不算「两条过近的路」 */
export function shareEndpoint(
  a: { a: { x: number; z: number }; b: { x: number; z: number } },
  b: { a: { x: number; z: number }; b: { x: number; z: number } },
  tol = 0.5,
): boolean {
  for (const p of [a.a, a.b]) {
    for (const q of [b.a, b.b]) {
      if (Math.hypot(p.x - q.x, p.z - q.z) <= tol) return true;
    }
  }
  return false;
}

export function clearanceFor(element: ElementKind, params: PipelineRules): number {
  switch (element) {
    case 'building': return params.parcels.setback;
    case 'park':
    case 'plaza': return params.parks.inset;
    // 水面除岸线退界外，还必须把步道让出来（与建筑共用同一通行带净宽），
    // 否则 bankSetback=0 时行人路径会穿水
    case 'water': return Math.max(params.extensions.bankSetback, buildingRoadClearance(params));
    case 'tree': return params.trees.roadSetback;
    // 车辆在道路带「内」、行人在道路带「外」，方向与退界相反，
    // 不能套用 setbackFromBand；由 mobility.ts 用 laneOffset / sidewalkWidth 单独计算。
    case 'vehicle':
    case 'pedestrian': return 0;
    default: return 0;
  }
}

/** 某条道路带对指定要素要求的总退界（到中心线） */
export function setbackFromBand(band: RoadBand, element: ElementKind, params: PipelineRules): number {
  return band.width / 2 + clearanceFor(element, params);
}

/**
 * 道路带四边形（外扩 extra 米）。生成侧与校验侧必须共用这一个口径，
 * 否则又会出现「校验说 PASS、画面上压路」的漂移。
 */
export function bandPolygon(band: RoadBand, extra = 0): Polygon {
  const dx = band.b.x - band.a.x;
  const dz = band.b.z - band.a.z;
  const len = Math.hypot(dx, dz) || 1;
  const half = band.width / 2 + extra;
  const nx = (-dz / len) * half;
  const nz = (dx / len) * half;
  return [
    v(band.a.x + nx, band.a.z + nz), v(band.b.x + nx, band.b.z + nz),
    v(band.b.x - nx, band.b.z - nz), v(band.a.x - nx, band.a.z - nz),
  ];
}

export interface SetbackOutcome {
  polygon: Polygon | null;
  /** 实际参与裁剪的道路带数量 */
  clippedBy: number;
  reason?: string;
}

/**
 * 把多边形从所有相关道路带退让开：只裁临路一侧，背街一侧保持不变。
 *
 * 用半平面裁剪而不是整体内缩 —— 公园背街边界不该因为「临路要退界」而一起缩。
 * 凹多边形被半平面裁后可能自交，此时明确失败，由调用方保守回退，绝不返回非法几何。
 */
export function setbackFromRoads(
  poly: Polygon,
  bands: RoadBand[],
  clearance: number,
): SetbackOutcome {
  let out: Polygon = poly.slice();
  let clippedBy = 0;
  for (const band of bands) {
    if (band.suppressed || band.boundary) continue;
    const half = band.width / 2 + clearance;
    const rbb = {
      minX: Math.min(band.a.x, band.b.x) - half, maxX: Math.max(band.a.x, band.b.x) + half,
      minZ: Math.min(band.a.z, band.b.z) - half, maxZ: Math.max(band.a.z, band.b.z) + half,
    };
    const bb = boundsOf(out);
    if (bb.maxX < rbb.minX || bb.minX > rbb.maxX || bb.maxZ < rbb.minZ || bb.minZ > rbb.maxZ) continue;

    const dx = band.b.x - band.a.x;
    const dz = band.b.z - band.a.z;
    const len = Math.hypot(dx, dz) || 1;
    const nx = -dz / len;
    const nz = dx / len;
    const aDot = band.a.x * nx + band.a.z * nz;
    const c = centroid(out);
    const side = (c.x - band.a.x) * nx + (c.z - band.a.z) * nz;
    // 保留质心所在一侧，且距中心线不小于 half
    const clipped = side >= 0
      ? clipHalfPlane(out, nx, nz, -(aDot + half))
      : clipHalfPlane(out, -nx, -nz, aDot - half);
    if (clipped.length < 3) return { polygon: null, clippedBy, reason: '多边形被道路退界完全裁掉' };
    out = clipped;
    clippedBy++;
  }
  const clean = dedupe(out);
  if (!isSimple(clean)) return { polygon: null, clippedBy, reason: '退界后多边形自交' };
  if (polygonArea(clean) < 1) return { polygon: null, clippedBy, reason: '退界后面积退化' };
  return { polygon: clean, clippedBy };
}

/** 多边形到任一道路带外缘的最小距离（诊断用） */
export function minDistanceToRoads(poly: Polygon, bands: RoadBand[]): number {
  let best = Infinity;
  for (const band of bands) {
    if (band.suppressed || band.boundary) continue;
    for (const q of poly) {
      best = Math.min(best, distanceToSegment(q.x, q.z, band.a, band.b) - band.width / 2);
    }
  }
  return best;
}

export const toPolygon2 = (p: Polygon): Polygon2 => p.map((q) => ({ x: q.x, z: q.z }));
