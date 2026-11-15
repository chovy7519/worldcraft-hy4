/**
 * WorldCraft — Scene Schema 与生成结果类型定义
 *
 * 设计原则：
 * 1. SceneDocument 只保存「规则 + 种子 + 人工覆写」，不保存生成结果。
 *    生成结果永远由 generateScene(doc) 纯函数推导，保证保存/重载一致。
 * 2. 对象 ID 由阶段内的稳定序号派生，与生成顺序、其他分区规则无关。
 * 3. 所有规则字段必须在 fields.ts 的 RULE_FIELDS 注册，否则命令层拒绝写入。
 * 4. 空间对象统一携带 AABB（bounds），阶段间以「包含 / 不相交」为硬约束。
 */

import type { RegionLayer } from './regions';
import type { MobilityScene } from './mobility';

export const SCHEMA_VERSION = '1.3.0';
/**
 * 可迁移的旧版本：v1.0.0 无 pipeline 分组；v1.1.0 无可编辑道路图；
 * v1.2.0 无区域叠加层 regions 与 E1/E2 参数，加载时补默认值。
 */
export const MIGRATABLE_VERSIONS = ['1.0.0', '1.1.0', '1.2.0'];

export type ZoneId = 'core' | 'east' | 'west' | 'north' | 'south';
export type ZoneSelector = ZoneId | 'all';
export type CommandSource = 'nl' | 'llm' | 'inspector' | 'structured' | 'system';

export const ZONE_IDS: ZoneId[] = ['core', 'east', 'west', 'north', 'south'];

export const ZONE_LABELS: Record<ZoneId, string> = {
  core: '核心区', east: '东侧', west: '西侧', north: '北侧', south: '南侧',
};

/** 制图淡彩分区板（仅展示层使用，不参与场景指纹）。依据 docs/VISUAL_STYLE.md §6 */
export const ZONE_COLORS: Record<ZoneId, string> = {
  core: '#f2b544', east: '#ef6b6b', west: '#5aa9f5', north: '#7ed6a5', south: '#b48ce8',
};

export const LAND_USE_LABELS: Record<LandUseId, string> = {
  office: '办公', residential: '居住', research: '研发', commercial: '商业',
  park: '公园', plaza: '广场', waterReserved: '水系预留', terrainReserved: '地形预留',
};

/** 制图淡彩功能板（仅展示层使用，不参与场景指纹） */
export const LAND_USE_COLORS: Record<LandUseId, string> = {
  office: '#4f8fd0', residential: '#d9a45b', research: '#7f7bd4', commercial: '#d16f8a',
  park: '#3f9e6b', plaza: '#98a3ac', waterReserved: '#2f86ab', terrainReserved: '#8a7a5c',
};

export const ARCHETYPE_LABELS: Record<ArchetypeId, string> = {
  tower: '高层塔楼', slab: '板式楼', podium: '商业裙房', research: '研发楼', incubator: '孵化单元',
};

export const PARK_SIZE_LABELS: Record<ParkSizeClass, string> = {
  pocket: '口袋公园', neighborhood: '社区公园', central: '中央公园',
};

/** 二维矩形（世界坐标 m），与 pipeline/geometry.ts 的 Rect 同形 */
export interface Bounds { minX: number; maxX: number; minZ: number; maxZ: number }
/** 二维点（X 东西、Z 南北） */
export interface Point2 { x: number; z: number }
/** 多边形：环序顶点，不重复首点，可凹 */
export type Polygon2 = Point2[];

// --- 可编辑道路图 ---------------------------------------------------------
export interface GraphNode { id: string; x: number; z: number; boundary?: boolean }
export interface GraphEdge {
  id: string; from: string; to: string;
  cls: RoadClass; width: number; boundary?: boolean;
}
export interface RoadGraph { nodes: GraphNode[]; edges: GraphEdge[] }

/** 地块编辑以「空间操作序列」持久化：改道路后按空间锚点重放，关系始终一致 */
export type ParcelEdit =
  | { id: string; kind: 'split'; a: Point2; b: Point2 }
  | { id: string; kind: 'merge'; a: Point2; b: Point2 }
  | { id: string; kind: 'vertex'; at: Point2; to: Point2 };

// ---------------------------------------------------------------------------
// 规则
// ---------------------------------------------------------------------------

export interface TerrainRules {
  width: number; depth: number; cellSize: number;
  blockPeriod: number; streetWidth: number; groundLevel: number;
}

export type HeightProfile = 'centerHigh' | 'uniform' | 'random';
export type RoofStyle = 'flat' | 'stepped' | 'mixed';
export type PaletteId = 'future' | 'concrete' | 'warm' | 'mono';

export interface HeightRules {
  base: number; max: number; taper: number; jitter: number;
  profile: HeightProfile; zoneMultipliers: Record<ZoneId, number>;
}

export interface DensityRules {
  base: number; zoneMultipliers: Record<ZoneId, number>;
}

export interface OpenSpaceRules {
  enabled: boolean;
  shape: 'circle' | 'rect';
  radius: number; width: number; depth: number;
  style: 'park' | 'plaza' | 'water';
  offsetX: number; offsetZ: number;
  treeCount: number;
}

export interface MaterialRules {
  palette: PaletteId; glassRatio: number; roofStyle: RoofStyle; emissive: number;
}

export type MixPreset = 'balanced' | 'office' | 'research' | 'green';
/** 功能配比模式：preset = 用内置权重表；custom = 用可逐类调节的自定义权重 */
export type MixMode = 'preset' | 'custom';
/** 四类可建功能（与 park/plaza/预留地相对），是自定义占比的键空间 */
export type BuiltUseId = 'office' | 'residential' | 'research' | 'commercial';
export const BUILT_USE_IDS: BuiltUseId[] = ['office', 'residential', 'research', 'commercial'];
export const BUILT_USE_LABELS: Record<BuiltUseId, string> = {
  office: '办公', residential: '住宅', research: '研发', commercial: '商业',
};
export type LandUseMix = Record<BuiltUseId, number>;
/** 与 MIX_WEIGHTS.balanced 一致，作为自定义占比的默认值与全零回退值 */
export const DEFAULT_LAND_USE_MIX: LandUseMix = {
  office: 0.34, residential: 0.22, research: 0.22, commercial: 0.22,
};
export type LandUseId =
  | 'office' | 'residential' | 'research' | 'commercial'
  | 'park' | 'plaza' | 'waterReserved' | 'terrainReserved';
export type ArchetypeId = 'tower' | 'slab' | 'podium' | 'research' | 'incubator';
export type ParkSizeClass = 'pocket' | 'neighborhood' | 'central';
export type RoadClass = 'arterial' | 'local';

/**
 * 统一可配置生成流程参数。所有项均注册到 RULE_FIELDS，
 * 因而自动出现在 Inspector、命令白名单与 LLM 工具目录中。
 */
export interface PipelineRules {
  roads: {
    arterialPeriod: number;
    localWidth: number;
    arterialWidth: number;
    suppressParkInterior: boolean;
  };
  parcels: {
    targetSize: number;
    maxSplit: number;
    gap: number;
    setback: number;
    splitJitter: number;
  };
  landUse: {
    mixPreset: MixPreset;
    /** custom 时生效：四类可建功能的相对权重，生成阶段自动归一化 */
    mixMode: MixMode;
    mix: LandUseMix;
    parkRatio: number;
    clusterBias: number;
    plazaRatio: number;
    waterReserveRatio: number;
    terrainReserveRatio: number;
  };
  buildings: {
    archetypeJitter: number;
    maxPerParcel: number;
    spacing: number;
  };
  parks: {
    centralBlocks: number;
    inset: number;
    pocketMaxArea: number;
    neighborhoodMaxArea: number;
    styleJitter: number;
  };
  trees: {
    streetInterval: number;
    parkSpacing: number;
    roadSetback: number;
    boundarySetback: number;
    minSpacing: number;
    jitter: number;
    maxTrees: number;
  };
  extensions: {
    water: boolean;
    terrain: boolean;
    /** E1 水面相对地块红线的退界（m） */
    bankSetback: number;
    /** E1 水面高程（相对 groundLevel，m） */
    waterLevel: number;
    /** E2 高程场最大起伏（m） */
    terrainAmplitude: number;
    /** E2 高程场空间频率（1/m） */
    terrainFrequency: number;
  };
  /** 人流 / 车流：路径必须沿已定义好的通行网络，不是独立撒点 */
  mobility: {
    enabled: boolean;
    /** 车辆总数上限（按路段配额分配） */
    vehicles: number;
    /** 行人总数上限（按步道与开放空间配额分配） */
    pedestrians: number;
    vehicleSpeed: number;
    pedestrianSpeed: number;
    /** 车道中心相对道路中心线的横向偏移（m），必须小于道路半宽 */
    laneOffset: number;
    /** 步道中心相对道路带外缘的向外偏移（m） */
    sidewalkWidth: number;
  };
}

export interface SceneRules {
  terrain: TerrainRules;
  height: HeightRules;
  density: DensityRules;
  openSpace: OpenSpaceRules;
  material: MaterialRules;
  pipeline: PipelineRules;
}

export interface ObjectOverride {
  height?: number; color?: string; footprintScale?: number; visible?: boolean; deleted?: boolean;
}

export interface SceneDocument {
  schemaVersion: string;
  id: string; name: string; seed: number; revision: number;
  rules: SceneRules;
  /** 可编辑道路图（持久化，不是派生数据） */
  graph: RoadGraph;
  /** 地块生成 / 拆分 / 合并 / 顶点编辑的空间操作序列 */
  parcelEdits: ParcelEdit[];
  /** v1.3.0 区域选择器叠加层；缺省为空数组，是倍率计算的恒等元 */
  regions?: RegionLayer[];
  overrides: Record<string, ObjectOverride>;
  createdAt: string; updatedAt: string;
}

// ---------------------------------------------------------------------------
// 生成结果对象（派生数据，不持久化）
// ---------------------------------------------------------------------------

export interface RoadBand {
  id: string;
  axis: 'x' | 'z' | 'free';
  coord: number;
  width: number;
  cls: RoadClass;
  bounds: Bounds;
  a: Point2; b: Point2;
  /** 被中央公园抑制的内部道路不属于最终路网 */
  suppressed: boolean;
  boundary: boolean;
  length: number;
  angle: number;
}

export interface RoadSegment {
  id: string;
  bandId: string;
  axis: 'x' | 'z' | 'free';
  x: number; z: number; w: number; d: number;
  cls: RoadClass;
  bounds: Bounds;
  a: Point2; b: Point2;
  length: number;
  angle: number;
  boundary: boolean;
  edgeId: string;
  fromNode: string;
  toNode: string;
}

export interface BlockObject {
  id: string;
  kind: 'block';
  serial: number;
  gx: number; gz: number;
  bounds: Bounds;
  isCentralPark: boolean;
}

export interface ParcelObject {
  id: string;
  kind: 'parcel';
  serial: number;
  blockId: string;
  bounds: Bounds;
  /** 兼容字段：包围盒内缩，仅用于快速空间索引；真实约束以 polygon 为准 */
  buildable: Bounds;
  /** 地块红线多边形（可非矩形、可凹），与相邻地块共享边 */
  polygon: Polygon2;
  isConcave: boolean;
  area: number;
  zone: ZoneId;
  frontage: Array<{ side: 'W' | 'E' | 'N' | 'S' | 'FREE'; roadId: string }>;
  isCentralPark: boolean;
  sourceFaceKey: string;
  editDepth: number;
}

export interface ParcelUse {
  parcelId: string;
  use: LandUseId;
  clusterId: string | null;
  sizeClass: ParkSizeClass | null;
}

export interface ParkCluster {
  id: string;
  parcelIds: string[];
  bounds: Bounds;
  area: number;
  sizeClass: ParkSizeClass;
  isCentral: boolean;
}

export interface ParkObject {
  id: string;
  kind: 'park';
  clusterId: string;
  parcelIds: string[];
  bounds: Bounds;
  x: number; z: number;
  width: number; depth: number; radius: number;
  shape: 'circle' | 'rect' | 'polygon';
  /** 贴合地块的公园范围多边形（可凹） */
  polygon: Polygon2;
  style: 'park' | 'plaza' | 'water';
  sizeClass: ParkSizeClass;
  zone: ZoneId;
  area: number;
  hash: number;
}

export interface BuildingObject {
  id: string;
  kind: 'building';
  cell: [number, number];
  zone: ZoneId;
  x: number; z: number; w: number; d: number; h: number;
  bounds: Bounds;
  color: string;
  roof: 'flat' | 'stepped' | 'antenna';
  visible: boolean;
  deleted: boolean;
  hash: number;
  trace: string[];
  overridden: boolean;
  parcelId: string;
  archetype: ArchetypeId;
  landUse: LandUseId;
  setback: number;
  /** 建筑足迹绕 Y 轴旋转角（弧度），用于贴合斜向/多边形地块 */
  orientation: number;
  /** 足迹四角（世界坐标），供空间校验与轮廓渲染 */
  footprint: Point2[];
}

/** 渲染用道路段（扁平化，供 InstancedMesh 消费） */
export interface RoadObject {
  id: string; kind: 'road';
  axis: 'x' | 'z' | 'free'; x: number; z: number; w: number; d: number;
  cls: RoadClass; bounds: Bounds;
  a: Point2; b: Point2; length: number; angle: number; boundary: boolean;
}

export interface TreeObject {
  id: string; kind: 'tree';
  x: number; z: number; scale: number; hash: number;
  context: 'street' | 'park';
  ownerId: string;
  /** 生成时实测净距，供规则追溯与空间校验复核 */
  roadClearance: number;
  boundaryClearance: number;
}

/** 兼容旧字段的中央开放空间别名（指向 sizeClass=central 的公园） */
export interface PlazaObject {
  id: string; kind: 'plaza';
  x: number; z: number; radius: number; width: number; depth: number;
  style: OpenSpaceRules['style']; shape: OpenSpaceRules['shape'] | 'polygon';
  polygon: Polygon2;
}

export interface WaterSurface {
  id: string; kind: 'water';
  bounds: Bounds; parcelIds: string[]; placeholder: boolean;
  /** v1.3.0 E1：退界后的水面多边形（岸线） */
  polygon?: Polygon2;
  /** v1.3.0 E1：退界前的原始地块红线并集 */
  shoreline?: Polygon2;
  width?: number;
  bankSetback?: number;
  level?: number;
  /** 是否由多个相邻预留地块连通合并而来 */
  connected?: boolean;
}

export interface HeightSample { x: number; z: number; y: number }

export interface RoadProfileSample { t: number; y: number }

export interface TerrainFeature {
  id: string; kind: 'terrainFeature';
  bounds: Bounds; parcelIds: string[]; placeholder: boolean;
  /** v1.3.0 E2：地形要素范围多边形 */
  polygon?: Polygon2;
  heightfield?: HeightSample[];
  /** 最大坡度（无量纲，dy/dx） */
  slope?: number;
  retainingLines?: Point2[][];
  roadProfiles?: Array<{ edgeId: string; samples: RoadProfileSample[] }>;
}

export type SceneObject =
  | BuildingObject | RoadObject | TreeObject | PlazaObject
  | ParcelObject | BlockObject | ParkObject | WaterSurface | TerrainFeature;

export interface ZoneStats {
  zone: ZoneId; availableCells: number; buildings: number;
  occupancy: number; avgHeight: number; maxHeight: number;
}

export interface SpatialIssue {
  code: string;
  a: string;
  b: string;
  detail: string;
  /** 可操作的修复建议；面向使用者，不是内部日志 */
  advice?: string;
}

export interface SpatialReport {
  ok: boolean;
  issues: SpatialIssue[];
  checks: Record<string, number>;
  minTreeSpacing: number;
  minRoadClearance: number;
}

export interface StageRunInfo {
  id: string; label: string; deps: string[]; kind: string;
  enabled: boolean; produced: number; durationMs: number;
}

export interface SceneStats {
  cols: number; rows: number; totalCells: number; roadCells: number; availableCells: number;
  buildingCount: number; visibleBuildings: number;
  avgHeight: number; maxHeight: number; coverage: number;
  byZone: ZoneStats[];
  roadLength: number;
  arterialSegments: number;
  localSegments: number;
  suppressedRoads: number;
  blocks: number;
  parcels: number;
  parks: number;
  parkArea: number;
  parksBySize: Record<ParkSizeClass, number>;
  landUseCounts: Record<LandUseId, number>;
  archetypeCounts: Record<ArchetypeId, number>;
  streetTrees: number;
  parkTrees: number;
  reservedWater: number;
  reservedTerrain: number;
  roadNodes: number;
  roadEdges: number;
  concaveParcels: number;
  polygonParcels: number;
  faceArea: number;
  siteArea: number;
  skippedEdits: number;
  /** v1.3.0：生效的区域叠加层数量 */
  regionLayers: number;
  /** v1.3.0：E1 生成的水面连通体数量 */
  waterSurfaces: number;
  /** v1.3.0：E2 生成的地形要素数量 */
  terrainPatches: number;
}

export interface GeneratedScene {
  buildings: BuildingObject[];
  roads: RoadObject[];
  trees: TreeObject[];
  plaza: PlazaObject | null;
  bands: RoadBand[];
  blocks: BlockObject[];
  parcels: ParcelObject[];
  uses: ParcelUse[];
  clusters: ParkCluster[];
  parks: ParkObject[];
  water: WaterSurface[];
  terrainFeatures: TerrainFeature[];
  graphNodes: GraphNode[];
  roadEdges: RoadSegment[];
  skippedEdits: string[];
  faceIssues: string[];
  spatial: SpatialReport;
  stages: StageRunInfo[];
  stats: SceneStats;
  fingerprint: string;
  /** v1.3.0 人流/车流：由 doc + scene 纯函数推导，不进阶段 DAG、不进指纹 */
  mobility?: MobilityScene;
  /**
   * 流动代理的局部路径警告。与 spatial.issues 分层：
   * 静态城市要素的关系决定 spatial.ok；派生表现层的问题只警告、不改判整个场景。
   */
  flowWarnings?: SpatialIssue[];
}

// ---------------------------------------------------------------------------
// 命令与变更记录
// ---------------------------------------------------------------------------

export type Command =
  | { op: 'scene.create'; name?: string; width?: number; depth?: number; seed?: number }
  | { op: 'scene.reset' }
  | { op: 'seed.set'; value: number }
  | { op: 'rule.set'; path: string; value: number | string | boolean }
  | { op: 'density.adjust'; zone: ZoneSelector; mode: 'relative' | 'absolute'; delta?: number; value?: number }
  | { op: 'height.adjust'; zone: ZoneSelector; mode: 'relative' | 'absolute'; delta?: number; value?: number }
  | { op: 'object.override'; id: string; patch: ObjectOverride }
  | { op: 'object.delete'; id: string }
  | { op: 'object.restore'; id: string }
  | { op: 'graph.regenerate' }
  | { op: 'graph.node.add'; x: number; z: number; id?: string }
  | { op: 'graph.node.move'; id: string; x: number; z: number }
  | { op: 'graph.node.remove'; id: string }
  | { op: 'graph.edge.add'; from: string; to: string; cls?: RoadClass; width?: number; id?: string }
  | { op: 'graph.edge.remove'; id: string }
  | { op: 'graph.edge.update'; id: string; cls?: RoadClass; width?: number }
  | { op: 'parcel.split'; a: Point2; b: Point2 }
  | { op: 'parcel.merge'; a: Point2; b: Point2 }
  | { op: 'parcel.vertex'; at: Point2; to: Point2 }
  | { op: 'parcel.edits.clear' }
  | { op: 'region.add'; layer: RegionLayer }
  | { op: 'region.update'; id: string; patch: Partial<RegionLayer> }
  | { op: 'region.remove'; id: string }
  | { op: 'region.clear' }
  | { op: 'camera.set'; preset: 'iso' | 'top' | 'front' | 'ne35' };

export interface RuleChange {
  path: string; label: string; before: unknown; after: unknown;
  scope: string; source: CommandSource; note?: string;
}

export interface CommandLogEntry {
  id: string; time: string; input: string; source: CommandSource;
  commands: Command[]; changes: RuleChange[];
  fingerprintBefore: string; fingerprintAfter: string;
  ok: boolean; message: string;
}

export interface ApplyResult {
  doc: SceneDocument; changes: RuleChange[];
  cameraPreset?: 'iso' | 'top' | 'front' | 'ne35'; errors: string[];
}
