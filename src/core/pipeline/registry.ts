/**
 * 可插拔阶段模块注册表（v1.3.0）
 *
 * v1.2.0 的阶段集合硬编码在 STAGE_GRAPH / STAGE_RUNNERS 两处，新增模块要同时改两个表，
 * 也无法把管线结构导出给外部工具。本模块把「阶段的声明」与「阶段的执行」收拢成一等公民：
 *
 *   StageModule = 元数据 + 依赖 + 类型化端口 + 参数 + runner + 外部节点映射
 *
 * 同时导出与 Blender Geometry Nodes / Unreal PCG 数据模型对齐的节点图描述（纯 JSON）。
 * 注意这是**描述层对齐**，不是插件：没有生成 .blend / .uasset，也没有实现自由拖拽节点图编辑。
 *
 * 兼容性：内置阶段仍使用 contracts.ts 的强类型 StageId；自定义阶段在运行时用字符串 ID，
 * 通过 StageMeta 兼容层进入同一套拓扑排序与依赖守卫。自定义模块的输出层为 unknown，
 * 由模块作者自行断言上游类型（内置 assembly 不会消费自定义层）。
 */
import {
  buildStagePlan, STAGE_GRAPH, validateStageGraph,
  type StageContext, type StageId, type StageMeta, type StagePlan,
} from './contracts';
import { STAGE_RUNNERS } from './stages';
import type { PipelineRules } from '../types';

export interface PortSpec {
  name: string;
  type: 'geometry' | 'polygon' | 'graph' | 'field' | 'rules' | 'stats' | 'scalar';
  description: string;
}

export interface NodeTarget {
  /** Blender Geometry Nodes 中语义最接近的节点组 */
  blender: string;
  /** Unreal PCG 中语义最接近的节点 */
  unreal: string;
  note?: string;
}

export interface StageModule {
  id: string;
  label: string;
  deps: string[];
  kind: 'core' | 'extension' | 'assembly';
  description: string;
  inputs: PortSpec[];
  outputs: PortSpec[];
  params: string[];
  target: NodeTarget;
  contract?: string;
  enabledBy?: (p: PipelineRules) => boolean;
  runner: (ctx: StageContext) => unknown;
}

export interface NodeGraphNode {
  id: string;
  label: string;
  kind: string;
  deps: string[];
  inputs: PortSpec[];
  outputs: PortSpec[];
  params: string[];
  target: NodeTarget;
  contract?: string;
}

export interface NodeGraphLink {
  from: string;
  fromPort: string;
  to: string;
  toPort: string;
}

export interface NodeGraphDescription {
  format: 'worldcraft.node-graph/v1';
  schemaVersion: string;
  nodes: NodeGraphNode[];
  links: NodeGraphLink[];
  plan: { order: string[]; levels: string[][] };
  /** 外部工具消费时需要注意的语义差异 */
  interoperability: string[];
}

const G = (name: string, description: string): PortSpec => ({ name, type: 'geometry', description });

/** 内置阶段的端口与节点映射表 */
const BUILTIN: Record<StageId, Omit<StageModule, 'id' | 'label' | 'deps' | 'kind' | 'description' | 'runner' | 'enabledBy' | 'contract'>> = {
  terrain: {
    inputs: [{ name: 'rules', type: 'rules', description: '场地尺寸与网格参数' }],
    outputs: [G('site', '场地 AABB 与单元格')],
    params: ['terrain.*'],
    target: { blender: 'Group Input + Mesh Line / Grid', unreal: 'PCG Create Points Grid (site bounds)' },
  },
  roads: {
    inputs: [G('site', '场地范围')],
    outputs: [G('roadGraph', '道路中心线'), { name: 'faces', type: 'polygon', description: '平面闭合面' }],
    params: ['pipeline.roads.*', 'terrain.blockPeriod'],
    target: { blender: 'Curve to Mesh / Mesh Boolean', unreal: 'PCG Spline + Surface Sampler' },
  },
  parcels: {
    inputs: [{ name: 'faces', type: 'polygon', description: '闭合面' }],
    outputs: [{ name: 'parcels', type: 'polygon', description: '地块红线多边形' }],
    params: ['pipeline.parcels.*'],
    target: { blender: 'Mesh Boolean (split) / Split Edges', unreal: 'PCG Split Spline / Polygon Boolean' },
  },
  landuse: {
    inputs: [{ name: 'parcels', type: 'polygon', description: '地块红线' }],
    outputs: [{ name: 'uses', type: 'field', description: '逐地块功能标签' }],
    params: ['pipeline.landUse.*'],
    target: { blender: 'Distribute Points on Faces + Random Value', unreal: 'PCG Random Choice / Attribute Partition' },
  },
  buildings: {
    inputs: [{ name: 'parcels', type: 'polygon', description: '可建地块' }],
    outputs: [G('buildings', '建筑实例与足迹')],
    params: ['density.*', 'height.*', 'pipeline.buildings.*'],
    target: { blender: 'Instance on Points + Realize Instances', unreal: 'PCG Static Mesh Spawner' },
  },
  parks: {
    inputs: [{ name: 'parcels', type: 'polygon', description: '公园地块' }],
    outputs: [{ name: 'parks', type: 'polygon', description: '公园范围' }],
    params: ['pipeline.parks.*', 'openSpace.*'],
    target: { blender: 'Mesh Boolean (union) + Fill', unreal: 'PCG Union / Polygon Merge' },
  },
  trees: {
    inputs: [G('roads', '路网'), G('parks', '公园范围')],
    outputs: [G('trees', '乔木点位')],
    params: ['pipeline.trees.*'],
    target: { blender: 'Distribute Points on Faces / Poisson', unreal: 'PCG Poisson Sampler / Self Pruning' },
  },
  water: {
    inputs: [{ name: 'parcels', type: 'polygon', description: '水系预留地块' }],
    outputs: [{ name: 'water', type: 'polygon', description: '水面与岸线' }],
    params: ['pipeline.extensions.*'],
    target: { blender: 'Set Position + Fill Curve', unreal: 'PCG Water Body / Surface Sampler' },
  },
  terrainFeatures: {
    inputs: [G('roads', '道路纵断'), { name: 'parcels', type: 'polygon', description: '地形预留地块' }],
    outputs: [{ name: 'heightfield', type: 'field', description: '高程场与挡墙线' }],
    params: ['pipeline.extensions.*'],
    target: { blender: 'Set Position (noise field)', unreal: 'PCG Heightfield / Landscape Layer' },
  },
  assembly: {
    inputs: [G('allLayers', '全部上游图层')],
    outputs: [{ name: 'scene', type: 'stats', description: '汇总统计、空间校验与指纹' }],
    params: [],
    target: { blender: 'Join Geometry + Viewer', unreal: 'PCG Gather + Quality Check' },
  },
};

function builtinModules(): StageModule[] {
  return STAGE_GRAPH.map((meta) => {
    const ports = BUILTIN[meta.id];
    return {
      id: meta.id,
      label: meta.label,
      deps: [...meta.deps],
      kind: meta.kind,
      description: meta.description,
      inputs: ports.inputs,
      outputs: ports.outputs,
      params: ports.params,
      target: ports.target,
      ...(meta.contract ? { contract: meta.contract } : {}),
      ...(meta.enabledBy ? { enabledBy: meta.enabledBy } : {}),
      runner: STAGE_RUNNERS[meta.id] as (ctx: StageContext) => unknown,
    };
  });
}

export interface RegisterOutcome { ok: boolean; error?: string }

export class StageRegistry {
  private modules = new Map<string, StageModule>();

  constructor(modules: StageModule[] = builtinModules()) {
    for (const m of modules) this.modules.set(m.id, m);
  }

  static builtin(): StageRegistry { return new StageRegistry(builtinModules()); }

  has(id: string): boolean { return this.modules.has(id); }
  get(id: string): StageModule | undefined { return this.modules.get(id); }
  list(): StageModule[] { return Array.from(this.modules.values()); }

  /** 依赖图元数据：供 buildStagePlan / validateStageGraph / 依赖守卫复用 */
  graph(): StageMeta[] {
    return this.list().map((m) => ({
      id: m.id as StageId,
      label: m.label,
      deps: m.deps as StageId[],
      kind: m.kind,
      description: m.description,
      ...(m.contract ? { contract: m.contract } : {}),
      ...(m.enabledBy ? { enabledBy: m.enabledBy } : {}),
    }));
  }

  runner(id: string): ((ctx: StageContext) => unknown) | undefined {
    return this.modules.get(id)?.runner;
  }

  plan(): StagePlan { return buildStagePlan(this.graph()); }

  issues(): Array<{ code: string; detail: string }> { return validateStageGraph(this.graph()); }

  /** 注册自定义阶段；依赖必须已存在，且注册后不得成环 */
  register(module: StageModule): RegisterOutcome {
    if (this.modules.has(module.id)) return { ok: false, error: `阶段 ID 已存在：${module.id}` };
    for (const d of module.deps) {
      if (!this.modules.has(d)) return { ok: false, error: `未声明的前置阶段：${d}` };
    }
    const next = new Map(this.modules);
    next.set(module.id, module);
    const probe = new StageRegistry(Array.from(next.values()));
    try {
      buildStagePlan(probe.graph());
    } catch (e) {
      return { ok: false, error: `注册会造成依赖图异常：${(e as Error).message}` };
    }
    this.modules = next;
    return { ok: true };
  }

  /** 只能移除自定义阶段；内置阶段是 assembly 的硬依赖 */
  unregister(id: string): RegisterOutcome {
    if (STAGE_GRAPH.some((m) => m.id === id)) {
      return { ok: false, error: `内置阶段不可移除：${id}` };
    }
    if (!this.modules.has(id)) return { ok: false, error: `阶段不存在：${id}` };
    if (this.list().some((m) => m.deps.includes(id))) {
      return { ok: false, error: `阶段 ${id} 仍被其他模块依赖` };
    }
    this.modules.delete(id);
    return { ok: true };
  }

  /**
   * 导出节点图描述。links 由 deps 推导，因此不会出现「文档说依赖 A、实际读 B」的漂移。
   */
  exportNodeGraph(schemaVersion: string): NodeGraphDescription {
    const plan = this.plan();
    const nodes: NodeGraphNode[] = this.list().map((m) => ({
      id: m.id, label: m.label, kind: m.kind, deps: [...m.deps],
      inputs: m.inputs, outputs: m.outputs, params: m.params, target: m.target,
      ...(m.contract ? { contract: m.contract } : {}),
    }));
    const links: NodeGraphLink[] = [];
    for (const m of this.list()) {
      for (const dep of m.deps) {
        const from = this.modules.get(dep);
        links.push({
          from: dep,
          fromPort: from?.outputs[0]?.name ?? 'geometry',
          to: m.id,
          toPort: m.inputs[0]?.name ?? 'geometry',
        });
      }
    }
    return {
      format: 'worldcraft.node-graph/v1',
      schemaVersion,
      nodes,
      links,
      plan: { order: plan.order, levels: plan.levels },
      interoperability: [
        'WorldCraft 的阶段输出是纯数据图层，不对应 Blender 的几何数据流；端口类型仅表示语义类别。',
        '确定性哈希采样在 Blender 中需用 Index + White Noise 节点复现，Unreal 中需用固定 Seed + Deterministic Random。',
        '本描述不含 runner 实现代码，导出后需在目标工具中重新搭建节点网络。',
      ],
    };
  }
}

let defaultRegistry: StageRegistry | null = null;
export function getDefaultRegistry(): StageRegistry {
  if (!defaultRegistry) defaultRegistry = StageRegistry.builtin();
  return defaultRegistry;
}
export function resetDefaultRegistry(): void { defaultRegistry = null; }
