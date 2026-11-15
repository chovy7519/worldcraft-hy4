/**
 * v1.3.0 可插拔阶段注册表契约
 * 重点：节点图 links 由 deps 推导，注册不能破坏拓扑，自定义模块真的被执行。
 */
import { describe, expect, it } from 'vitest';
import { StageRegistry, getDefaultRegistry } from '../core/pipeline/registry';
import { exportNodeGraph, runPipeline } from '../core/pipeline';
import { STAGE_GRAPH, validateStageGraph } from '../core/pipeline/contracts';
import { createDefaultDocument } from '../core/schema';
import { SCHEMA_VERSION } from '../core/types';

describe('内置阶段注册表', () => {
  it('阶段数、ID 与 v1.2.0 的 STAGE_GRAPH 一致', () => {
    const reg = getDefaultRegistry();
    expect(reg.list()).toHaveLength(STAGE_GRAPH.length);
    expect(reg.graph().map((m) => m.id)).toEqual(STAGE_GRAPH.map((m) => m.id));
    expect(validateStageGraph(reg.graph())).toEqual([]);
    expect(reg.issues()).toEqual([]);
  });

  it('拓扑序稳定，且 assembly 排在最后', () => {
    const plan = getDefaultRegistry().plan();
    expect(plan.order[plan.order.length - 1]).toBe('assembly');
    expect(plan.levels.length).toBeGreaterThan(3);
    expect(plan.order).toContain('water');
    expect(plan.order).toContain('terrainFeatures');
  });

  it('节点图描述可被 JSON 序列化，包含端口与双目标映射', () => {
    const graph = exportNodeGraph();
    expect(graph.format).toBe('worldcraft.node-graph/v1');
    expect(graph.schemaVersion).toBe(SCHEMA_VERSION);
    expect(graph.nodes).toHaveLength(STAGE_GRAPH.length);
    const depsTotal = STAGE_GRAPH.reduce((s, m) => s + m.deps.length, 0);
    expect(graph.links).toHaveLength(depsTotal);
    expect(graph.nodes.every((n) => n.target.blender && n.target.unreal)).toBe(true);
    expect(graph.nodes.every((n) => n.inputs.length > 0 && n.outputs.length > 0)).toBe(true);
    expect(() => JSON.stringify(graph)).not.toThrow();
    expect(graph.interoperability.length).toBeGreaterThan(0);
  });
});

describe('自定义阶段插拔', () => {
  const module = {
    id: 'audit.custom',
    label: '自定义审计阶段',
    deps: ['parcels', 'landuse'],
    kind: 'core' as const,
    description: '统计地块与功能数量，验证自定义 runner 能读取声明过的上游',
    inputs: [{ name: 'parcels', type: 'polygon' as const, description: '地块' }],
    outputs: [{ name: 'report', type: 'stats' as const, description: '审计结果' }],
    params: [],
    target: { blender: 'Group Output', unreal: 'PCG Custom Node' },
    runner: (ctx: Parameters<Parameters<StageRegistry['register']>[0]['runner']>[0]) => {
      const parcels = ctx.upstream('parcels');
      const land = ctx.upstream('landuse');
      return { parcels: parcels.parcels.length, uses: land.uses.length };
    },
  };

  it('注册后进入执行计划，runner 真实运行且能读上游', () => {
    const reg = StageRegistry.builtin();
    const outcome = reg.register(module);
    expect(outcome.ok).toBe(true);
    expect(reg.plan().order).toContain('audit.custom');
    const scene = runPipeline(createDefaultDocument(), { registry: reg });
    const info = scene.stages.find((s) => s.id === 'audit.custom');
    expect(info).toBeDefined();
    expect(info!.deps).toEqual(['parcels', 'landuse']);
    expect(scene.spatial.ok).toBe(true);
  });

  it('导出节点图包含自定义模块及其 links', () => {
    const reg = StageRegistry.builtin();
    reg.register(module);
    const graph = reg.exportNodeGraph(SCHEMA_VERSION);
    expect(graph.nodes.find((n) => n.id === 'audit.custom')).toBeDefined();
    expect(graph.links.filter((l) => l.to === 'audit.custom')).toHaveLength(2);
  });

  it('重复 ID / 未声明依赖 / 内置阶段移除都被拒绝', () => {
    const reg = StageRegistry.builtin();
    expect(reg.register(module).ok).toBe(true);
    expect(reg.register(module).ok).toBe(false);
    expect(reg.register({ ...module, id: 'audit.bad', deps: ['not.exists'] }).ok).toBe(false);
    expect(reg.unregister('parcels').ok).toBe(false);
    expect(reg.unregister('audit.custom').ok).toBe(true);
    expect(reg.has('audit.custom')).toBe(false);
  });

  it('自定义阶段仍受依赖守卫约束：读未声明上游会抛错', () => {
    const reg = StageRegistry.builtin();
    const bad = {
      ...module,
      id: 'audit.guard',
      deps: ['parcels'],
      runner: (ctx: Parameters<Parameters<StageRegistry['register']>[0]['runner']>[0]) => {
        ctx.upstream('landuse');
        return {};
      },
    };
    expect(reg.register(bad).ok).toBe(true);
    expect(() => runPipeline(createDefaultDocument(), { registry: reg }))
      .toThrow(/阶段依赖违规/);
  });
});
