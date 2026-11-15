/**
 * 管线执行器：注册表 → 拓扑排序 → 逐阶段运行（带依赖守卫）→ 汇总 GeneratedScene。
 *
 * v1.3.0：阶段元数据与 runner 由 StageRegistry 提供，因此可以在不修改本文件的前提下
 * 注册自定义阶段（registry.register），也可以把整张节点图导出给外部工具。
 * 内置阶段的顺序与产物保持与 v1.2.0 完全一致。
 */
import {
  buildStagePlan, STAGE_GRAPH, STAGE_LABELS, downstreamOf, validateStageGraph,
  type StageContext, type StageId, type StageOutputs, type StagePlan, type StageMeta,
} from './contracts';
import { stageForPath } from './stages';
import { getDefaultRegistry, StageRegistry } from './registry';
import { buildMobility, validateMobility } from '../mobility';
export { STAGE_RUNNERS, emptyExtensionLayer } from './stages';
import type {
  AssemblyLayer, BuildingLayer, LandUseLayer, ParcelLayer, ParkLayer, RoadLayer,
  TerrainFeatureLayer, TreeLayer, WaterLayer,
} from './contracts';
import {
  SCHEMA_VERSION,
  type GeneratedScene, type PlazaObject, type RoadObject, type SceneDocument, type StageRunInfo,
} from '../types';

export {
  buildStagePlan, STAGE_GRAPH, STAGE_LABELS, downstreamOf, validateStageGraph, stageForPath,
  getDefaultRegistry, StageRegistry,
};
export type { StageContext, StageId, StageOutputs, StagePlan, StageMeta };
export { ARCHETYPES, ARCHETYPE_ORDER, MIX_WEIGHTS } from './stages';
export type { ArchetypeSpec } from './stages';
export { validateSpatialLayout } from './validate';
export type { LayoutInput } from './validate';
export type { NodeGraphDescription, StageModule } from './registry';

function countProduced(id: string, layer: unknown): number {
  if (!layer || typeof layer !== 'object') return 0;
  const o = layer as Record<string, unknown>;
  switch (id) {
    case 'roads': return (o.bands as unknown[] | undefined)?.length ?? 0;
    case 'parcels': return (o.parcels as unknown[] | undefined)?.length ?? 0;
    case 'landuse': return (o.uses as unknown[] | undefined)?.length ?? 0;
    case 'buildings': return (o.buildings as unknown[] | undefined)?.length ?? 0;
    case 'parks': return (o.parks as unknown[] | undefined)?.length ?? 0;
    case 'trees': return (o.trees as unknown[] | undefined)?.length ?? 0;
    // 启用时报告真实几何数，关闭时回落到预留地块数（保持 v1.2.0 的统计契约）
    case 'water': return (o.surfaces as unknown[] | undefined)?.length
      || (o.reservedParcelIds as unknown[] | undefined)?.length || 0;
    case 'terrainFeatures': return (o.features as unknown[] | undefined)?.length
      || (o.reservedParcelIds as unknown[] | undefined)?.length || 0;
    case 'terrain': return 1;
    case 'assembly': return 1;
    default: return 0;
  }
}

export interface RunPipelineOptions { registry?: StageRegistry }

export function runPipeline(doc: SceneDocument, options: RunPipelineOptions = {}): GeneratedScene {
  const registry = options.registry ?? getDefaultRegistry();
  const metaById = new Map(registry.graph().map((m) => [m.id as string, m]));
  const plan = registry.plan();
  // 自定义阶段的输出层是 unknown，统一存进字符串键表；内置阶段在读取处做类型收窄
  const outputs: Record<string, unknown> = {};
  const stageInfo: StageRunInfo[] = [];
  const params = doc.rules.pipeline;

  for (const id of plan.order as string[]) {
    const meta = metaById.get(id)!;
    // 扩展阶段始终运行（成本极低）：关闭时只登记预留地块、不生成几何，
    // 这样「水系/地形预留」统计不会因扩展点未启用而丢失。
    const enabled = meta.kind !== 'extension' || (meta.enabledBy?.(params) ?? false);

    const ctx: StageContext = {
      doc,
      rules: doc.rules,
      params,
      seed: doc.seed,
      upstream: <K extends StageId>(dep: K): StageOutputs[K] => {
        if (!meta.deps.includes(dep)) {
          throw new Error(`阶段依赖违规：${id} 未声明对 ${dep} 的依赖，却尝试读取其输出`);
        }
        const value = outputs[dep as string];
        if (value === undefined) {
          throw new Error(`阶段依赖违规：${id} 的上游 ${dep} 尚未产出（拓扑序错误）`);
        }
        return value as StageOutputs[K];
      },
    };

    const t0 = Date.now();
    const runner = registry.runner(id);
    if (!runner) throw new Error(`阶段 ${id} 没有注册 runner`);
    const layer = runner(ctx);
    outputs[id] = layer;
    stageInfo.push({
      id: id as StageId, label: meta.label, deps: meta.deps, kind: meta.kind,
      enabled, produced: countProduced(id, layer), durationMs: Date.now() - t0,
    });
  }

  const roads = outputs.roads as RoadLayer;
  const parcels = outputs.parcels as ParcelLayer;
  const land = outputs.landuse as LandUseLayer;
  const build = outputs.buildings as BuildingLayer;
  const parkLayer = outputs.parks as ParkLayer;
  const trees = outputs.trees as TreeLayer;
  const water = outputs.water as WaterLayer;
  const tf = outputs.terrainFeatures as TerrainFeatureLayer;
  const assembly = outputs.assembly as AssemblyLayer;

  const roadObjects: RoadObject[] = roads.segments.map((s) => ({
    id: s.id, kind: 'road', axis: s.axis, x: s.x, z: s.z, w: s.w, d: s.d,
    cls: s.cls, bounds: s.bounds,
    a: s.a, b: s.b, length: s.length, angle: s.angle, boundary: s.boundary,
  }));

  const central = parkLayer.parks.find((p) => p.sizeClass === 'central');
  const plaza: PlazaObject | null = central ? {
    id: central.id, kind: 'plaza', x: central.x, z: central.z,
    radius: central.radius, width: central.width, depth: central.depth,
    style: central.style, shape: central.shape, polygon: central.polygon,
  } : null;

  const result: GeneratedScene = {
    buildings: build.buildings,
    roads: roadObjects,
    trees: trees.trees,
    plaza,
    bands: roads.bands,
    blocks: roads.blocks,
    parcels: parcels.parcels,
    uses: land.uses,
    clusters: land.clusters,
    parks: parkLayer.parks,
    water: water.surfaces,
    terrainFeatures: tf.features,
    graphNodes: roads.nodes,
    roadEdges: roads.segments,
    skippedEdits: parcels.skippedEdits,
    faceIssues: roads.faceIssues,
    spatial: assembly.spatial,
    stages: stageInfo,
    stats: assembly.stats,
    fingerprint: assembly.fingerprint,
  };

  // 流动层在汇总之后生成：依赖路网、退界后的公园、建筑与水面，但不属于阶段 DAG，
  // 也不进入指纹（相位/速度由 seed 决定，不改变几何）。
  // 分层：静态要素关系决定 spatial.ok；派生代理的局部瑕疵记为 flowWarnings。
  // 图形编辑可能把两条道路挪到过近、中间放不下步道，警告会如实暴露该几何冲突，
  // 但不会让用户拖一个节点就把整个场景判为「空间校验 FAIL」。
  result.mobility = buildMobility(doc, result);
  result.flowWarnings = validateMobility(result.mobility, result);
  return result;
}

/** 导出与 Blender Geometry Nodes / Unreal PCG 对齐的节点图描述（纯 JSON） */
export function exportNodeGraph(registry: StageRegistry = getDefaultRegistry()) {
  return registry.exportNodeGraph(SCHEMA_VERSION);
}

/** 地形/水系扩展点的启用状态（供 Inspector 展示） */
export function extensionStatus(doc: SceneDocument, registry: StageRegistry = getDefaultRegistry()) {
  return registry.graph()
    .filter((m) => m.kind === 'extension')
    .map((m) => ({
      id: m.id as string,
      label: m.label,
      enabled: m.enabledBy?.(doc.rules.pipeline) ?? false,
      contract: m.contract ?? '',
    }));
}
