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

export const SCHEMA_VERSION = '1.2.0';
/** 可迁移的旧版本：v1.0.0 无 pipeline 分组；v1.1.0 无可编辑道路图，均由规则重建 */
export const MIGRATABLE_VERSIONS = ['1.0.0', '1.1.0'];

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
}

export interface TerrainFeature {
  id: string; kind: 'terrainFeature';
  bounds: Bounds; parcelIds: string[]; placeholder: boolean;
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
