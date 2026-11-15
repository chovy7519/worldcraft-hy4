/**
 * 场地规模性能基准（可复现）：npx vite-node scripts/bench.ts
 *
 * 目的：为「LOD / 分块生成」提供实测依据，而不是靠文档里的估计数字。
 * 每次改动 terrain.width/depth 后重新按规则生成正交道路图，保证面提取合法。
 */
import { createDefaultDocument } from '../src/core/schema';
import { buildGridGraph } from '../src/core/geom/defaultGraph';
import { generateScene } from '../src/core/pcg';

const SIZES = [400, 800, 1200, 2000];

for (const size of SIZES) {
  const doc = createDefaultDocument();
  doc.rules.terrain.width = size;
  doc.rules.terrain.depth = size;
  doc.graph = buildGridGraph(doc.rules.terrain, doc.rules.pipeline.roads);
  const runs: number[] = [];
  let scene = generateScene(doc);
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    scene = generateScene(doc);
    runs.push(performance.now() - t0);
  }
  const avg = runs.reduce((a, b) => a + b, 0) / runs.length;
  console.log(
    `${String(size).padStart(4)} m | 建筑 ${String(scene.buildings.length).padStart(5)} | ` +
    `地块 ${String(scene.parcels.length).padStart(5)} | 乔木 ${String(scene.trees.length).padStart(5)} | ` +
    `节点 ${String(scene.graphNodes.length).padStart(4)} | ` +
    `平均 ${avg.toFixed(0)} ms | 校验 ${scene.spatial.ok ? 'PASS' : `FAIL(${scene.spatial.issues.length})`}`,
  );
}
