/**
 * 管线执行器：拓扑排序 → 逐阶段运行（带依赖守卫）→ 汇总 GeneratedScene。
 */
import {
  buildStagePlan, STAGE_GRAPH, STAGE_LABELS, downstreamOf, validateStageGraph,
  type StageContext, type StageId, type StageOutputs, type StagePlan, type StageMeta,
} from './contracts';
import { STAGE_RUNNERS, stageForPath } from './stages';
export { STAGE_RUNNERS, emptyExtensionLayer } from './stages';
import type {
  GeneratedScene, PlazaObject, RoadObject, SceneDocument, StageRunInfo,
} from '../types';

export {
  buildStagePlan, STAGE_GRAPH, STAGE_LABELS, downstreamOf, validateStageGraph, stageForPath,
};
export type { StageContext, StageId, StageOutputs, StagePlan, StageMeta };
export { ARCHETYPES, ARCHETYPE_ORDER, MIX_WEIGHTS } from './stages';
export type { ArchetypeSpec } from './stages';
export { validateSpatialLayout } from './validate';
export type { LayoutInput } from './validate';

function countProduced(id: StageId, layer: unknown): number {
  if (!layer || typeof layer !== 'object') return 0;
  const o = layer as Record<string, unknown>;
  switch (id) {
    case 'roads': return (o.bands as unknown[] | undefined)?.length ?? 0;
    case 'parcels': return (o.parcels as unknown[] | undefined)?.length ?? 0;
    case 'landuse': return (o.uses as unknown[] | undefined)?.length ?? 0;
    case 'buildings': return (o.buildings as unknown[] | undefined)?.length ?? 0;
    case 'parks': return (o.parks as unknown[] | undefined)?.length ?? 0;
    case 'trees': return (o.trees as unknown[] | undefined)?.length ?? 0;
    case 'water': return (o.reservedParcelIds as unknown[] | undefined)?.length ?? 0;
    case 'terrainFeatures': return (o.reservedParcelIds as unknown[] | undefined)?.length ?? 0;
    case 'terrain': return 1;
    case 'assembly': return 1;
  }
}

export function runPipeline(doc: SceneDocument): GeneratedScene {
  const plan = buildStagePlan();
  const outputs: Partial<StageOutputs> = {};
  const stageInfo: StageRunInfo[] = [];
  const params = doc.rules.pipeline;

  for (const id of plan.order) {
    const meta = STAGE_GRAPH.find((m) => m.id === id)!;
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
        const value = outputs[dep];
        if (value === undefined) {
          throw new Error(`阶段依赖违规：${id} 的上游 ${dep} 尚未产出（拓扑序错误）`);
        }
        return value as StageOutputs[K];
      },
    };

    const t0 = Date.now();
    const layer = (STAGE_RUNNERS[id] as (c: StageContext) => unknown)(ctx);
    outputs[id] = layer as never;
    stageInfo.push({
      id, label: meta.label, deps: meta.deps, kind: meta.kind,
      enabled, produced: countProduced(id, layer), durationMs: Date.now() - t0,
    });
  }

  const roads = outputs.roads!;
  const parcels = outputs.parcels!;
  const land = outputs.landuse!;
  const build = outputs.buildings!;
  const parkLayer = outputs.parks!;
  const trees = outputs.trees!;
  const water = outputs.water!;
  const tf = outputs.terrainFeatures!;
  const assembly = outputs.assembly!;

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

  return {
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
}

/** 地形/水系扩展点的启用状态（供 Inspector 展示） */
export function extensionStatus(doc: SceneDocument): Array<{ id: string; label: string; enabled: boolean; contract: string }> {
  return STAGE_GRAPH.filter((m) => m.kind === 'extension').map((m) => ({
    id: m.id,
    label: m.label,
    enabled: m.enabledBy?.(doc.rules.pipeline) ?? false,
    contract: m.contract ?? '',
  }));
}
