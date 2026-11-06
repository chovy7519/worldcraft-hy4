/**
 * Scene Schema 持久化与校验。
 * 磁盘/ localStorage 中只存 SceneDocument（规则 + 种子 + 覆写），
 * 三维几何不落盘 —— 加载时由 generateScene() 重新推导并用指纹核对。
 */
import { RULE_FIELDS, getRuleValue, validateRuleValue } from './fields';
import { buildGridGraph } from './geom/defaultGraph';
import {
  MIGRATABLE_VERSIONS, SCHEMA_VERSION, ZONE_IDS,
  type ObjectOverride, type ParcelEdit, type PipelineRules, type RoadGraph,
  type SceneDocument, type SceneRules,
} from './types';
import { fingerprintOf } from './rng';

export const DEFAULT_SEED = 20261106;
export const STORAGE_KEY = 'worldcraft.scene.v1';

/**
 * 管线默认参数。各字段的合法区间与单位见 fields.ts / docs/PCG_PIPELINE.md。
 * 默认值满足路面净距约束：gap/2 + boundarySetback ≥ roadSetback，
 * 且 boundarySetback < parcels.setback（行道树落在退界绿带内，不与建筑冲突）。
 */
export function defaultPipelineRules(): PipelineRules {
  return {
    roads: { arterialPeriod: 3, localWidth: 7, arterialWidth: 11, suppressParkInterior: true },
    parcels: { targetSize: 20, maxSplit: 2, gap: 1, setback: 3, splitJitter: 0.25 },
    landUse: { mixPreset: 'balanced', parkRatio: 0.12, clusterBias: 0.45, plazaRatio: 0.035, waterReserveRatio: 0.02, terrainReserveRatio: 0.02 },
    buildings: { archetypeJitter: 0.12, maxPerParcel: 3, spacing: 1 },
    parks: { centralBlocks: 2, inset: 1.5, pocketMaxArea: 3000, neighborhoodMaxArea: 9000, styleJitter: 0.2 },
    trees: { streetInterval: 9, parkSpacing: 7, roadSetback: 2, boundarySetback: 1, minSpacing: 3.5, jitter: 0.5, maxTrees: 1600 },
    extensions: { water: false, terrain: false },
  };
}

export function defaultRules(): SceneRules {
  return {
    terrain: {
      width: 400, depth: 400, cellSize: 8, blockPeriod: 6, streetWidth: 7, groundLevel: 0,
    },
    height: {
      base: 18, max: 165, taper: 1.35, jitter: 0.22, profile: 'centerHigh',
      zoneMultipliers: { core: 1, east: 1, west: 1, north: 1, south: 1 },
    },
    density: {
      base: 0.82,
      zoneMultipliers: { core: 1, east: 1, west: 1, north: 1, south: 1 },
    },
    openSpace: {
      enabled: true, shape: 'circle', radius: 46, width: 90, depth: 90,
      style: 'park', offsetX: 0, offsetZ: 0, treeCount: 84,
    },
    material: {
      palette: 'future', glassRatio: 0.55, roofStyle: 'mixed', emissive: 0.25,
    },
    pipeline: defaultPipelineRules(),
  };
}

export function createDefaultDocument(seed = DEFAULT_SEED): SceneDocument {
  const now = new Date().toISOString();
  const rules = defaultRules();
  return {
    schemaVersion: SCHEMA_VERSION,
    id: `scene-${fingerprintOf([seed, now]).toLowerCase()}`,
    name: '未来城市 · 400 × 400 m',
    seed,
    revision: 1,
    rules,
    graph: buildGridGraph(rules.terrain, rules.pipeline.roads),
    parcelEdits: [],
    overrides: {},
    createdAt: now,
    updatedAt: now,
  };
}

export function cloneDoc(doc: SceneDocument): SceneDocument {
  return structuredClone(doc);
}

/** 文档指纹：仅涵盖影响几何的内容，时间戳/名称/id 被排除 */
export function documentFingerprint(doc: SceneDocument): string {
  return fingerprintOf({ seed: doc.seed, rules: doc.rules, graph: doc.graph, parcelEdits: doc.parcelEdits, overrides: doc.overrides });
}

function validPoint(p: unknown): p is { x: number; z: number } {
  if (typeof p !== 'object' || p === null) return false;
  const q = p as Record<string, unknown>;
  return typeof q.x === 'number' && Number.isFinite(q.x) && Math.abs(q.x) <= 100000
    && typeof q.z === 'number' && Number.isFinite(q.z) && Math.abs(q.z) <= 100000;
}

/** 可编辑图与地块编辑序列的严格校验 */
export function parseGraph(input: unknown): { ok: boolean; graph?: RoadGraph; error?: string } {
  if (typeof input !== 'object' || input === null) return { ok: false, error: 'graph 必须是对象' };
  const g = input as Record<string, unknown>;
  if (!Array.isArray(g.nodes) || !Array.isArray(g.edges)) return { ok: false, error: 'graph.nodes/edges 必须是数组' };
  if (g.nodes.length > 4000 || g.edges.length > 8000) return { ok: false, error: '道路图规模超出上限' };
  const ids = new Set<string>();
  const nodes: RoadGraph['nodes'] = [];
  for (const raw of g.nodes) {
    if (typeof raw !== 'object' || raw === null) return { ok: false, error: '非法节点' };
    const n = raw as Record<string, unknown>;
    if (typeof n.id !== 'string' || !/^[A-Za-z0-9_.-]{1,40}$/.test(n.id) || ids.has(n.id)) return { ok: false, error: `非法或重复节点 ID：${String(n.id)}` };
    if (!Number.isFinite(n.x) || !Number.isFinite(n.z)) return { ok: false, error: `节点 ${n.id} 坐标非法` };
    ids.add(n.id);
    nodes.push({ id: n.id, x: n.x as number, z: n.z as number, ...(n.boundary ? { boundary: true } : {}) });
  }
  const edgeIds = new Set<string>();
  const edges: RoadGraph['edges'] = [];
  for (const raw of g.edges) {
    if (typeof raw !== 'object' || raw === null) return { ok: false, error: '非法路段' };
    const e = raw as Record<string, unknown>;
    if (typeof e.id !== 'string' || !/^[A-Za-z0-9_.-]{1,60}$/.test(e.id) || edgeIds.has(e.id)) return { ok: false, error: `非法或重复路段 ID：${String(e.id)}` };
    if (typeof e.from !== 'string' || typeof e.to !== 'string' || !ids.has(e.from) || !ids.has(e.to) || e.from === e.to) {
      return { ok: false, error: `路段 ${e.id} 的端点非法` };
    }
    const cls = e.cls === 'arterial' ? 'arterial' : 'local';
    const width = Number(e.width);
    edges.push({ id: e.id, from: e.from, to: e.to, cls, width: Number.isFinite(width) ? Math.max(0, Math.min(40, width)) : 7 });
    edgeIds.add(e.id);
  }
  return { ok: true, graph: { nodes, edges } };
}

export function parseParcelEdits(input: unknown): { ok: boolean; edits?: ParcelEdit[]; error?: string } {
  if (input === undefined) return { ok: true, edits: [] };
  if (!Array.isArray(input)) return { ok: false, error: 'parcelEdits 必须是数组' };
  if (input.length > 200) return { ok: false, error: '地块编辑序列超过上限 200' };
  const edits: ParcelEdit[] = [];
  for (let i = 0; i < input.length; i++) {
    const e = input[i] as Record<string, unknown>;
    if (typeof e !== 'object' || e === null || typeof e.kind !== 'string') return { ok: false, error: `第 ${i + 1} 条地块编辑非法` };
    const id = typeof e.id === 'string' && /^[A-Za-z0-9_.-]{1,40}$/.test(e.id) ? e.id : `pe.${i}`;
    if (e.kind === 'split' || e.kind === 'merge') {
      if (!validPoint(e.a) || !validPoint(e.b)) return { ok: false, error: `第 ${i + 1} 条编辑的两点非法` };
      edits.push({ id, kind: e.kind, a: { x: e.a.x, z: e.a.z }, b: { x: e.b.x, z: e.b.z } });
    } else if (e.kind === 'vertex') {
      if (!validPoint(e.at) || !validPoint(e.to)) return { ok: false, error: `第 ${i + 1} 条编辑的顶点非法` };
      edits.push({ id, kind: 'vertex', at: { x: e.at.x, z: e.at.z }, to: { x: e.to.x, z: e.to.z } });
    } else return { ok: false, error: `未知地块编辑类型：${e.kind}` };
  }
  return { ok: true, edits };
}

export interface ParseResult { ok: boolean; doc?: SceneDocument; error?: string }

/** 严格校验：字段白名单 + 类型 + 区间；拒绝任意额外规则字段 */
export function parseSceneDocument(input: unknown): ParseResult {
  if (typeof input !== 'object' || input === null) return { ok: false, error: '场景文档不是对象' };
  const raw = input as Record<string, unknown>;

  const version = String(raw.schemaVersion);
  const isLegacy = MIGRATABLE_VERSIONS.includes(version);
  if (version !== SCHEMA_VERSION && !isLegacy) {
    return {
      ok: false,
      error: `不支持的场景版本 ${version}，当前仅支持 ${SCHEMA_VERSION}（可迁移 ${MIGRATABLE_VERSIONS.join('/')}）`,
    };
  }
  if (!Number.isInteger(raw.seed)) return { ok: false, error: 'seed 必须是整数' };
  if (typeof raw.rules !== 'object' || raw.rules === null) return { ok: false, error: '缺少 rules' };

  // v1.0.0 → v1.1.0 迁移：补齐 pipeline 分组，其余规则原样保留
  const rulesCandidate = structuredClone(raw.rules) as Record<string, unknown>;
  if (isLegacy && rulesCandidate.pipeline === undefined) {
    rulesCandidate.pipeline = defaultPipelineRules();
  }
  const rules = rulesCandidate as unknown as SceneRules;
  for (const field of RULE_FIELDS) {
    const value = getRuleValue(rules, field.path);
    if (value === undefined) return { ok: false, error: `缺少规则字段 ${field.path}` };
    const check = validateRuleValue(field.path, value);
    if (!check.ok) return { ok: false, error: `${field.path}: ${check.error}` };
    if (field.type === 'number' && typeof value !== 'number') {
      return { ok: false, error: `${field.path} 必须是数值` };
    }
  }

  // 规则对象不允许携带未注册字段（防止 LLM 注入任意结构）
  const allowedTop = new Set(['terrain', 'height', 'density', 'openSpace', 'material', 'pipeline']);
  for (const key of Object.keys(rules)) {
    if (!allowedTop.has(key)) return { ok: false, error: `未注册的规则分组：${key}` };
  }
  for (const [group, allowedKeys] of Object.entries({
    terrain: ['width', 'depth', 'cellSize', 'blockPeriod', 'streetWidth', 'groundLevel'],
    height: ['base', 'max', 'taper', 'jitter', 'profile', 'zoneMultipliers'],
    density: ['base', 'zoneMultipliers'],
    openSpace: ['enabled', 'shape', 'radius', 'width', 'depth', 'style', 'offsetX', 'offsetZ', 'treeCount'],
    material: ['palette', 'glassRatio', 'roofStyle', 'emissive'],
    pipeline: ['roads', 'parcels', 'landUse', 'buildings', 'parks', 'trees', 'extensions'],
  })) {
    const obj = (rules as unknown as Record<string, Record<string, unknown>>)[group];
    if (obj === undefined || obj === null) return { ok: false, error: `缺少规则分组：${group}` };
    for (const key of Object.keys(obj)) {
      if (!allowedKeys.includes(key)) return { ok: false, error: `未注册的规则字段：${group}.${key}` };
    }
  }
  for (const [sub, allowedKeys] of Object.entries({
    roads: ['arterialPeriod', 'localWidth', 'arterialWidth', 'suppressParkInterior'],
    parcels: ['targetSize', 'maxSplit', 'gap', 'setback', 'splitJitter'],
    landUse: ['mixPreset', 'parkRatio', 'clusterBias', 'plazaRatio', 'waterReserveRatio', 'terrainReserveRatio'],
    buildings: ['archetypeJitter', 'maxPerParcel', 'spacing'],
    parks: ['centralBlocks', 'inset', 'pocketMaxArea', 'neighborhoodMaxArea', 'styleJitter'],
    trees: ['streetInterval', 'parkSpacing', 'roadSetback', 'boundarySetback', 'minSpacing', 'jitter', 'maxTrees'],
    extensions: ['water', 'terrain'],
  })) {
    const obj = (rules.pipeline as unknown as Record<string, Record<string, unknown>>)[sub];
    if (obj === undefined || obj === null) return { ok: false, error: `缺少管线参数分组：pipeline.${sub}` };
    for (const key of Object.keys(obj)) {
      if (!allowedKeys.includes(key)) return { ok: false, error: `未注册的管线参数：pipeline.${sub}.${key}` };
    }
  }
  for (const group of ['density', 'height'] as const) {
    const mult = rules[group].zoneMultipliers;
    for (const z of ZONE_IDS) {
      if (typeof mult[z] !== 'number' || !Number.isFinite(mult[z])) {
        return { ok: false, error: `${group}.zoneMultipliers.${z} 非法` };
      }
    }
  }

  // v1.0.0 / v1.1.0 迁移：按当前规则重建初始正交道路图，地块编辑序列为空
  const graphResult = raw.graph === undefined
    ? { ok: true as const, graph: buildGridGraph(rules.terrain, rules.pipeline.roads) }
    : parseGraph(raw.graph);
  if (!graphResult.ok || !graphResult.graph) return { ok: false, error: `道路图校验失败：${graphResult.error}` };
  const editsResult = parseParcelEdits(raw.parcelEdits);
  if (!editsResult.ok || !editsResult.edits) return { ok: false, error: `地块编辑序列校验失败：${editsResult.error}` };

  const overrides: Record<string, ObjectOverride> = {};
  if (raw.overrides !== undefined) {
    if (typeof raw.overrides !== 'object' || raw.overrides === null || Array.isArray(raw.overrides)) {
      return { ok: false, error: 'overrides 必须是对象' };
    }
    for (const [id, value] of Object.entries(raw.overrides as Record<string, unknown>)) {
      if (!/^bld\.-?\d+\.-?\d+$/.test(id)) return { ok: false, error: `非法对象 ID：${id}` };
      if (typeof value !== 'object' || value === null) return { ok: false, error: `覆写 ${id} 必须是对象` };
      const patch = value as Record<string, unknown>;
      const safe: ObjectOverride = {};
      if (patch.height !== undefined) {
        if (typeof patch.height !== 'number' || patch.height < 1 || patch.height > 500) return { ok: false, error: `${id}.height 越界` };
        safe.height = patch.height;
      }
      if (patch.footprintScale !== undefined) {
        if (typeof patch.footprintScale !== 'number' || patch.footprintScale < 0.2 || patch.footprintScale > 2) return { ok: false, error: `${id}.footprintScale 越界` };
        safe.footprintScale = patch.footprintScale;
      }
      if (patch.color !== undefined) {
        if (typeof patch.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(patch.color)) return { ok: false, error: `${id}.color 非法` };
        safe.color = patch.color;
      }
      if (patch.visible !== undefined) safe.visible = Boolean(patch.visible);
      if (patch.deleted !== undefined) safe.deleted = Boolean(patch.deleted);
      overrides[id] = safe;
    }
  }

  const doc: SceneDocument = {
    schemaVersion: SCHEMA_VERSION,
    id: typeof raw.id === 'string' ? raw.id : `scene-restored-${String(raw.seed)}`,
    name: typeof raw.name === 'string' ? raw.name : '未命名场景',
    seed: raw.seed as number,
    revision: typeof raw.revision === 'number' ? raw.revision : 1,
    rules: structuredClone(rules),
    graph: structuredClone(graphResult.graph),
    parcelEdits: structuredClone(editsResult.edits),
    overrides,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(),
  };
  return { ok: true, doc };
}

export function parseSceneJSON(text: string): ParseResult {
  try {
    return parseSceneDocument(JSON.parse(text));
  } catch (e) {
    return { ok: false, error: `JSON 解析失败：${(e as Error).message}` };
  }
}

export function serializeScene(doc: SceneDocument): string {
  return JSON.stringify(doc, null, 2);
}
