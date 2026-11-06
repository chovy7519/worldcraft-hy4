/** 从规则参数生成初始规则化正交道路图；之后所有编辑都作用于这份持久化图。 */
import { clamp } from '../rng';
import type { PipelineRules, TerrainRules } from '../types';
import type { GraphEdge, GraphNode, RoadGraph } from './planar';

export function buildGridGraph(terrain: TerrainRules, roads: PipelineRules['roads']): RoadGraph {
  const { width, depth, cellSize, blockPeriod } = terrain;
  const nx = clamp(Math.round(width / Math.max(12, blockPeriod * cellSize)), 2, 16);
  const nz = clamp(Math.round(depth / Math.max(12, blockPeriod * cellSize)), 2, 16);
  const xs = Array.from({ length: nx + 1 }, (_, i) => -width / 2 + (width * i) / nx);
  const zs = Array.from({ length: nz + 1 }, (_, j) => -depth / 2 + (depth * j) / nz);

  const nodes: GraphNode[] = [];
  const index = new Map<string, string>();
  const nodeAt = (x: number, z: number): string => {
    const k = `${Math.round(x * 1000)},${Math.round(z * 1000)}`;
    const found = index.get(k);
    if (found) return found;
    const id = `gn.${nodes.length}`;
    index.set(k, id);
    nodes.push({ id, x, z });
    return id;
  };

  const edges: GraphEdge[] = [];
  const arterialN = Math.max(1, Math.round(roads.arterialPeriod));
  const addEdge = (a: string, b: string, clsIndex: number) => {
    const cls = clsIndex % arterialN === 0 ? 'arterial' : 'local';
    edges.push({
      id: `ge.${edges.length}`, from: a, to: b, cls,
      width: cls === 'arterial' ? roads.arterialWidth : roads.localWidth,
    });
  };

  // 竖向道路（x 固定），端点延伸到场地上下边界
  for (let i = 1; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      addEdge(nodeAt(xs[i], zs[j]), nodeAt(xs[i], zs[j + 1]), i);
    }
  }
  // 横向道路（z 固定），端点延伸到场地左右边界
  for (let j = 1; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      addEdge(nodeAt(xs[i], zs[j]), nodeAt(xs[i + 1], zs[j]), j);
    }
  }
  return { nodes, edges };
}
