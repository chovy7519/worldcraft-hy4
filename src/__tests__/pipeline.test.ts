import { describe, expect, it } from 'vitest';
import {
  STAGE_GRAPH, STAGE_RUNNERS, buildStagePlan, downstreamOf, extensionStatus,
  stageForPath, validateStageGraph, type StageContext, type StageOutputs,
} from '../core/pipeline';
import { generateScene } from '../core/pcg';
import { canonicalize } from '../core/rng';
import { createDefaultDocument, defaultPipelineRules, parseSceneDocument, serializeScene, parseSceneJSON } from '../core/schema';
import type { SceneDocument } from '../core/types';
import type { StageId } from '../core/pipeline';

describe('阶段依赖定义与执行器', () => {
  it('依赖图静态校验无重复、无缺失、无环、core 不依赖扩展点', () => {
    expect(validateStageGraph()).toEqual([]);
  });

  it('拓扑序满足所有 deps 先于下游，且 S4a/S4b 同层可并行', () => {
    const plan = buildStagePlan();
    expect(plan.order[0]).toBe('terrain');
    expect(plan.order[plan.order.length - 1]).toBe('assembly');
    const pos = Object.fromEntries(plan.order.map((id, i) => [id, i])) as Record<StageId, number>;
    for (const meta of STAGE_GRAPH) {
      for (const d of meta.deps) expect(pos[d]).toBeLessThan(pos[meta.id]);
    }
    const bLevel = plan.levels.find((l) => l.includes('buildings'))!;
    expect(bLevel).toContain('parks');
    expect(pos.trees).toBeGreaterThan(pos.buildings);
    expect(pos.trees).toBeGreaterThan(pos.parks);
  });

  it('树木阶段刻意不依赖 buildings，密度编辑不会波及树木', () => {
    const treesDeps = STAGE_GRAPH.find((s) => s.id === 'trees')!.deps;
    expect(treesDeps).not.toContain('buildings');
    expect(treesDeps).toEqual(expect.arrayContaining(['roads', 'parcels', 'landuse', 'parks']));
    expect(downstreamOf('buildings')).not.toContain('trees');
    expect(downstreamOf('roads')).toEqual(expect.arrayContaining(['parcels', 'trees', 'assembly']));
  });

  it('运行时依赖守卫：阶段只能读到自己声明的上游', () => {
    const requested: string[] = [];
    const doc = createDefaultDocument(11);
    const fakeOutputs = {} as StageOutputs;
    const ctx: StageContext = {
      doc, rules: doc.rules, params: doc.rules.pipeline, seed: doc.seed,
      upstream: <K extends StageId>(id: K) => {
        requested.push(id);
        if (id !== 'terrain') throw new Error(`未声明依赖 ${id}`);
        return fakeOutputs[id];
      },
    };
    fakeOutputs.terrain = { cols: 50, rows: 50, cellSize: 8, groundLevel: 0, site: { minX: -200, maxX: 200, minZ: -200, maxZ: 200 } };
    const roads = STAGE_RUNNERS.roads(ctx);
    expect(requested).toEqual(['terrain']);
    expect(roads.bands.length).toBeGreaterThan(0);

    expect(() => buildStagePlan([
      { id: 'a' as StageId, label: 'a', deps: ['b' as StageId], kind: 'core', description: '' },
      { id: 'b' as StageId, label: 'b', deps: ['a' as StageId], kind: 'core', description: '' },
    ])).toThrow(/环/);
  });

  it('参数路径 → 首影响阶段映射正确', () => {
    expect(stageForPath('pipeline.roads.arterialPeriod')).toBe('roads');
    expect(stageForPath('pipeline.parcels.maxSplit')).toBe('parcels');
    expect(stageForPath('pipeline.landUse.parkRatio')).toBe('landuse');
    expect(stageForPath('pipeline.trees.streetInterval')).toBe('trees');
    expect(stageForPath('pipeline.extensions.water')).toBe('water');
    expect(stageForPath('density.zoneMultipliers.east')).toBe('buildings');
  });
});

describe('整条链路的确定性与扩展点', () => {
  it('同一 SceneDocument 连续生成，所有图层逐位一致', () => {
    const doc = createDefaultDocument(20261106);
    const a = generateScene(doc);
    for (let i = 0; i < 5; i++) {
      const b = generateScene(doc);
      expect(b.fingerprint).toBe(a.fingerprint);
      expect(canonicalize([b.bands, b.blocks, b.parcels, b.uses, b.clusters, b.parks, b.buildings, b.trees, b.water, b.terrainFeatures]))
        .toBe(canonicalize([a.bands, a.blocks, a.parcels, a.uses, a.clusters, a.parks, a.buildings, a.trees, a.water, a.terrainFeatures]));
    }
  });

  it('序列化往返后全链路重新生成一致', () => {
    const doc = createDefaultDocument(7788);
    const parsed = parseSceneJSON(serializeScene(doc));
    expect(parsed.ok).toBe(true);
    const a = generateScene(doc);
    const b = generateScene(parsed.doc!);
    expect(b.fingerprint).toBe(a.fingerprint);
    expect(canonicalize(b.parks)).toBe(canonicalize(a.parks));
    expect(canonicalize(b.trees)).toBe(canonicalize(a.trees));
  });

  it('v1.0.0 旧存档可迁移：补齐 pipeline 默认值后重新生成', () => {
    const doc = createDefaultDocument(999) as unknown as Record<string, unknown>;
    const legacy = { ...doc, schemaVersion: '1.0.0', rules: { ...(doc.rules as object) } } as Record<string, unknown>;
    delete (legacy.rules as Record<string, unknown>).pipeline;
    const parsed = parseSceneDocument(legacy);
    expect(parsed.ok).toBe(true);
    expect(parsed.doc!.schemaVersion).toBe('1.2.0');
    expect(parsed.doc!.rules.pipeline).toEqual(defaultPipelineRules());
    expect(generateScene(parsed.doc!).fingerprint).toBe(generateScene(createDefaultDocument(999)).fingerprint);
  });

  it('扩展点默认关闭但仍登记预留地块；启用后生成占位水面且改变指纹', () => {
    const doc = createDefaultDocument(4242);
    const off = generateScene(doc);
    expect(extensionStatus(doc).every((e) => !e.enabled)).toBe(true);
    expect(off.water).toHaveLength(0);
    expect(off.stats.reservedWater).toBeGreaterThan(0);
    expect(off.stats.reservedTerrain).toBeGreaterThan(0);
    expect(off.stages.find((s) => s.id === 'water')!.enabled).toBe(false);
    expect(off.stages.find((s) => s.id === 'water')!.produced).toBe(off.stats.reservedWater);

    const on: SceneDocument = structuredClone(doc);
    on.rules.pipeline.extensions.water = true;
    const enabled = generateScene(on);
    expect(enabled.water.length).toBe(enabled.stats.reservedWater);
    expect(enabled.water.every((w) => w.placeholder)).toBe(true);
    expect(enabled.fingerprint).not.toBe(off.fingerprint);
    expect(enabled.spatial.ok).toBe(true);
  });

  it('阶段执行记录包含依赖、启用状态与产出数量', () => {
    const s = generateScene(createDefaultDocument(1));
    expect(s.stages).toHaveLength(STAGE_GRAPH.length);
    for (const info of s.stages) {
      const meta = STAGE_GRAPH.find((m) => m.id === info.id)!;
      expect(info.deps).toEqual(meta.deps);
      expect(info.produced).toBeGreaterThanOrEqual(0);
    }
    expect(s.stages.find((x) => x.id === 'parcels')!.produced).toBe(s.parcels.length);
    expect(s.stages.find((x) => x.id === 'trees')!.produced).toBe(s.trees.length);
  });
});
