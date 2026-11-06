/**
 * 阶段契约与依赖图（DAG）。
 *
 * 阶段依赖是一等公民：`STAGE_GRAPH` 声明每个阶段的 deps，runner 用拓扑排序执行，
 * 并通过 ctx.upstream(id) 做**运行时依赖守卫** —— 阶段只能读取自己声明过的上游输出，
 * 越界读取直接抛错。这样「阶段依赖清晰」是代码约束，不只是文档描述。
 */
import type {
  ArchetypeId, BlockObject, BuildingObject, Bounds, GraphEdge, GraphNode, LandUseId, ParcelObject, ParcelUse,
  ParkCluster, ParkObject, PipelineRules, Polygon2, RoadBand, RoadSegment, SceneDocument,
  SceneRules, SceneStats, SpatialReport, TerrainFeature, TreeObject, WaterSurface, ZoneId,
} from '../types';
import type { Face } from '../geom/planar';

export const STAGE_IDS = [
  'terrain', 'roads', 'parcels', 'landuse', 'buildings', 'parks', 'trees',
  'water', 'terrainFeatures', 'assembly',
] as const;
export type StageId = typeof STAGE_IDS[number];

export const STAGE_LABELS: Record<StageId, string> = {
  terrain: 'S0 场地基底',
  roads: 'S1 道路网络确定',
  parcels: 'S2 地块划分',
  landuse: 'S3 地块功能分配',
  buildings: 'S4a 多类型建筑生成',
  parks: 'S4b 多尺寸公园生成',
  trees: 'S5 树木分布',
  water: 'E1 水系（扩展点）',
  terrainFeatures: 'E2 地形要素（扩展点）',
  assembly: 'S6 汇总与校验',
};

// ---------------------------------------------------------------------------
// 阶段输出层
// ---------------------------------------------------------------------------

export interface TerrainLayer {
  cols: number; rows: number; cellSize: number; site: Bounds; groundLevel: number;
}

export interface RoadLayer {
  /** 由可编辑图提取的闭合面（地块原始形状） */
  faces: Face[];
  centralFaceKeys: string[];
  bands: RoadBand[];
  segments: RoadSegment[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  blocks: BlockObject[];
  suppressedIds: string[];
  centralBounds: Bounds | null;
  faceIssues: string[];
  faceArea: number;
  siteArea: number;
}

export interface ParcelLayer {
  parcels: ParcelObject[];
  byId: Record<string, ParcelObject>;
  skippedEdits: string[];
  concaveCount: number;
  polygonByParcel: Record<string, Polygon2>;
}

export interface LandUseLayer {
  uses: ParcelUse[];
  byParcel: Record<string, ParcelUse>;
  clusters: ParkCluster[];
  counts: Record<LandUseId, number>;
}

export interface BuildingLayer {
  buildings: BuildingObject[];
  counts: Record<ArchetypeId, number>;
  /** 各分区被评估的建筑候选槽位，用于计算 0..1 的占用率 */
  slotsByZone: Record<ZoneId, number>;
}

export interface ParkLayer { parks: ParkObject[] }

export interface TreeLayer {
  trees: TreeObject[];
  candidateCount: number;
  rejected: Record<string, number>;
}

export interface WaterLayer {
  surfaces: WaterSurface[];
  reservedParcelIds: string[];
}

export interface TerrainFeatureLayer {
  features: TerrainFeature[];
  reservedParcelIds: string[];
}

export interface AssemblyLayer {
  stats: SceneStats;
  fingerprint: string;
  spatial: SpatialReport;
}

export interface StageOutputs {
  terrain: TerrainLayer;
  roads: RoadLayer;
  parcels: ParcelLayer;
  landuse: LandUseLayer;
  buildings: BuildingLayer;
  parks: ParkLayer;
  trees: TreeLayer;
  water: WaterLayer;
  terrainFeatures: TerrainFeatureLayer;
  assembly: AssemblyLayer;
}

// ---------------------------------------------------------------------------
// 上下文与阶段定义
// ---------------------------------------------------------------------------

export interface StageContext {
  doc: SceneDocument;
  rules: SceneRules;
  params: PipelineRules;
  seed: number;
  /** 只允许读取本阶段 deps 中声明的上游；越界读取抛错 */
  upstream: <K extends StageId>(id: K) => StageOutputs[K];
}

export type StageRunner<K extends StageId = StageId> = (ctx: StageContext) => StageOutputs[K];

export interface StageMeta {
  id: StageId;
  label: string;
  deps: StageId[];
  kind: 'core' | 'extension' | 'assembly';
  description: string;
  /** 扩展点启用开关；core 阶段恒为 true */
  enabledBy?: (p: PipelineRules) => boolean;
  /** 后续实现该扩展时需要消费的上游与输出契约 */
  contract?: string;
}

/**
 * 依赖图。注意 trees 的 deps 刻意**不含 buildings**：
 * 树木只与道路网络、地块边界、公园边界协调，因此调整建筑密度不会扰动树木，
 * 「其他区域不变」在整条链路上成立。
 */
export const STAGE_GRAPH: StageMeta[] = [
  {
    id: 'terrain', label: STAGE_LABELS.terrain, deps: [], kind: 'core',
    description: '由 terrain 参数建立场地 AABB 与单元格尺寸，是所有空间计算的基准。',
  },
  {
    id: 'roads', label: STAGE_LABELS.roads, deps: ['terrain'], kind: 'core',
    description: '按 blockPeriod 生成道路中心线，按 arterialPeriod 分级；中央公园内部道路被抑制；由相邻道路带围合出街区 Block。',
  },
  {
    id: 'parcels', label: STAGE_LABELS.parcels, deps: ['roads'], kind: 'core',
    description: '每个 Block 按 targetSize / maxSplit 细分为 Parcel，计算 bounds、buildable（退界后）与临路面前线。',
  },
  {
    id: 'landuse', label: STAGE_LABELS.landuse, deps: ['parcels'], kind: 'core',
    description: '按 mixPreset 权重 + 分区 + 独立哈希分配功能；相邻公园地块聚类为不同尺寸等级；登记水系/地形预留地块。',
  },
  {
    id: 'buildings', label: STAGE_LABELS.buildings, deps: ['landuse', 'parcels', 'roads'], kind: 'core',
    description: '按功能与分区选择建筑原型（塔楼/板楼/裙房/研发/孵化），在 parcel.buildable 内生成且互不重叠。',
  },
  {
    id: 'parks', label: STAGE_LABELS.parks, deps: ['landuse', 'parcels', 'roads'], kind: 'core',
    description: '每个公园聚类生成一个 ParkObject；中央公园占整数街区，圆形为内切圆，尺寸等级由面积决定。',
  },
  {
    id: 'trees', label: STAGE_LABELS.trees, deps: ['roads', 'parcels', 'landuse', 'parks'], kind: 'core',
    description: '行道树沿道路两侧按株距布置，公园树在公园边界内网格布置；统一做路缘净距、地块边界净距、最小株距约束。',
  },
  {
    id: 'water', label: STAGE_LABELS.water, deps: ['landuse', 'parcels', 'parks'], kind: 'extension',
    enabledBy: (p) => p.extensions.water,
    description: '消费 waterReserved 地块，生成水面多边形并与公园/道路边界求交。V0.1 仅提供占位实现。',
    contract: '输入：waterReserved parcels + 公园边界；输出：WaterSurface[]（polygon / width / bank setback）；不得跨越道路带。',
  },
  {
    id: 'terrainFeatures', label: STAGE_LABELS.terrainFeatures, deps: ['roads', 'parcels', 'landuse'], kind: 'extension',
    enabledBy: (p) => p.extensions.terrain,
    description: '消费 terrainReserved 地块，生成台地/坡地/挡墙等地形要素。V0.1 仅提供占位实现。',
    contract: '输入：terrainReserved parcels + 道路纵断；输出：TerrainFeature[]（heightfield patch / slope / retaining line）；需回填到 terrain 阶段的高程。',
  },
  {
    id: 'assembly', label: STAGE_LABELS.assembly, deps: ['terrain', 'roads', 'parcels', 'landuse', 'buildings', 'parks', 'trees', 'water', 'terrainFeatures'], kind: 'assembly',
    description: '汇总全部图层、计算分区与阶段统计、执行空间无重叠校验、生成确定性指纹。',
  },
];

export interface StagePlan {
  /** 拓扑序（稳定：同层按 STAGE_GRAPH 声明顺序） */
  order: StageId[];
  /** 可分并行的层级 */
  levels: StageId[][];
}

/** Kahn 拓扑排序；缺依赖或成环时抛错 */
export function buildStagePlan(graph: StageMeta[] = STAGE_GRAPH): StagePlan {
  const known = new Set(graph.map((s) => s.id));
  for (const s of graph) {
    for (const d of s.deps) {
      if (!known.has(d)) throw new Error(`阶段 ${s.id} 声明了不存在的依赖 ${d}`);
    }
    if (s.deps.includes(s.id)) throw new Error(`阶段 ${s.id} 自依赖`);
  }
  const remaining = new Map(graph.map((s) => [s.id, s]));
  const done = new Set<StageId>();
  const levels: StageId[][] = [];
  const order: StageId[] = [];
  while (remaining.size > 0) {
    const level = graph
      .filter((s) => remaining.has(s.id) && s.deps.every((d) => done.has(d)))
      .map((s) => s.id);
    if (level.length === 0) {
      throw new Error(`阶段依赖图存在环：${Array.from(remaining.keys()).join(', ')}`);
    }
    levels.push(level);
    order.push(...level);
    for (const id of level) { done.add(id); remaining.delete(id); }
  }
  return { order, levels };
}

export interface GraphIssue { code: string; detail: string }

/** 供测试与 Inspector 使用的静态依赖图校验 */
export function validateStageGraph(graph: StageMeta[] = STAGE_GRAPH): GraphIssue[] {
  const issues: GraphIssue[] = [];
  const ids = graph.map((s) => s.id);
  if (new Set(ids).size !== ids.length) issues.push({ code: 'DUPLICATE_STAGE', detail: '存在重复阶段 ID' });
  const known = new Set(ids);
  for (const s of graph) {
    for (const d of s.deps) if (!known.has(d)) issues.push({ code: 'MISSING_DEP', detail: `${s.id} → ${d}` });
    if (s.kind === 'core' && s.deps.some((d) => graph.find((g) => g.id === d)?.kind === 'extension')) {
      issues.push({ code: 'CORE_DEPENDS_ON_EXTENSION', detail: `${s.id} 依赖了默认禁用的扩展阶段` });
    }
  }
  try { buildStagePlan(graph); } catch (e) { issues.push({ code: 'CYCLE', detail: (e as Error).message }); }
  return issues;
}

/** 依赖闭包：某阶段变更会波及哪些下游（参数敏感性分析用） */
export function downstreamOf(id: StageId, graph: StageMeta[] = STAGE_GRAPH): StageId[] {
  const out: StageId[] = [];
  const visit = (target: StageId) => {
    for (const s of graph) {
      if (s.deps.includes(target) && !out.includes(s.id)) { out.push(s.id); visit(s.id); }
    }
  };
  visit(id);
  return out;
}
