/**
 * 城市要素空间关系诊断（可复现）：npx vite-node scripts/diagnose-spatial.ts
 *
 * 目的：核实「广场和绿地压在道路上」到底是几何重叠，还是只是渲染层高度差造成的错觉。
 * 方法：对每条有效道路带构造实际四边形，用布尔交集计算重叠面积，逐图层统计。
 */
import polygonClipping from 'polygon-clipping';
import type { MultiPolygon, Polygon as PcPolygon } from 'polygon-clipping';
import { createDefaultDocument } from '../src/core/schema';
import { generateScene } from '../src/core/pcg';
import { applyCommands } from '../src/core/commands';
import type { Command, GeneratedScene, RoadBand, SceneDocument } from '../src/core/types';

const pc = polygonClipping as unknown as {
  intersection: (a: PcPolygon, ...rest: PcPolygon[]) => MultiPolygon;
};

type Pt = { x: number; z: number };

function toGeom(poly: Pt[]): PcPolygon {
  const ring = poly.map((q) => [q.x, q.z] as [number, number]);
  ring.push([poly[0].x, poly[0].z]);
  return [ring];
}

function bandQuad(b: RoadBand): PcPolygon {
  const dx = b.b.x - b.a.x;
  const dz = b.b.z - b.a.z;
  const len = Math.hypot(dx, dz) || 1;
  const nx = (-dz / len) * b.width / 2;
  const nz = (dx / len) * b.width / 2;
  const ring: Array<[number, number]> = [
    [b.a.x + nx, b.a.z + nz], [b.b.x + nx, b.b.z + nz],
    [b.b.x - nx, b.b.z - nz], [b.a.x - nx, b.a.z - nz],
  ];
  ring.push([ring[0][0], ring[0][1]]);
  return [ring];
}

function ringArea(ring: Array<[number, number]>): number {
  let s = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    s += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return Math.abs(s / 2);
}

function mpArea(mp: MultiPolygon): number {
  let total = 0;
  for (const poly of mp) {
    if (poly.length === 0) continue;
    total += ringArea(poly[0]);
    for (let i = 1; i < poly.length; i++) total -= ringArea(poly[i]);
  }
  return total;
}

function overlapArea(poly: Pt[], quads: PcPolygon[]): number {
  let sum = 0;
  const geom = toGeom(poly);
  for (const q of quads) {
    try { sum += mpArea(pc.intersection(geom, q)); } catch { /* 退化输入跳过 */ }
  }
  return sum;
}

function polyArea(poly: Pt[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]; const b = poly[(i + 1) % poly.length];
    s += a.x * b.z - b.x * a.z;
  }
  return Math.abs(s / 2);
}

function diagnose(label: string, doc: SceneDocument): void {
  const scene: GeneratedScene = generateScene(doc);
  const active = scene.bands.filter((b) => !b.suppressed && !b.boundary);
  const quads = active.map(bandQuad);

  let parkTotal = 0;
  let parkOverlap = 0;
  let parkHit = 0;
  let parkAreaSum = 0;
  let plazaTotal = 0;
  let plazaOverlap = 0;
  for (const p of scene.parks) {
    const area = polyArea(p.polygon);
    const ov = overlapArea(p.polygon, quads);
    parkTotal++;
    parkAreaSum += area;
    if (ov > 0.01) { parkHit++; parkOverlap += ov; }
    if (p.style === 'plaza') { plazaTotal++; plazaOverlap += ov; }
  }
  let buildingHit = 0;
  let buildingOverlap = 0;
  for (const b of scene.buildings) {
    const ov = overlapArea(b.footprint, quads);
    if (ov > 0.01) { buildingHit++; buildingOverlap += ov; }
  }
  let waterOverlap = 0;
  let waterArea = 0;
  for (const w of scene.water) {
    if (!w.polygon) continue;
    waterArea += polyArea(w.polygon);
    waterOverlap += overlapArea(w.polygon, quads);
  }
  const treeHit = scene.trees.filter((t) => t.roadClearance < 0).length;

  console.log(`\n【${label}】道路带 ${active.length} 条 | 空间校验 ${scene.spatial.ok ? 'PASS' : 'FAIL(' + scene.spatial.issues.length + ')'}`);
  if (!scene.spatial.ok) {
    console.log(`    冲突明细：${scene.spatial.issues.slice(0, 4).map((i) => `${i.code}@${i.a}: ${i.detail}`).join(' | ')}`);
  }
  console.log(`  公园/广场 ${parkTotal} 个（面积 ${parkAreaSum.toFixed(0)} m²）：与道路重叠 ${parkHit} 个，重叠面积 ${parkOverlap.toFixed(0)} m²（${parkAreaSum > 0 ? (parkOverlap / parkAreaSum * 100).toFixed(1) : 0}%）`);
  console.log(`    其中广场 ${plazaTotal} 个，重叠面积 ${plazaOverlap.toFixed(0)} m²`);
  console.log(`  建筑 ${scene.buildings.length} 栋：与道路重叠 ${buildingHit} 栋，面积 ${buildingOverlap.toFixed(0)} m²`);
  console.log(`  水面 ${scene.water.length} 个（面积 ${waterArea.toFixed(0)} m²）：重叠 ${waterOverlap.toFixed(0)} m²`);
  console.log(`  乔木 ${scene.trees.length} 株：路缘净距为负 ${treeHit} 株`);
  const mob = scene.mobility;
  const flowIssues = scene.flowWarnings ?? [];
  console.log(`  流动：车辆 ${mob?.stats.vehicles ?? 0} / 行人 ${mob?.stats.pedestrians ?? 0} | 路径 ${mob?.paths.length ?? 0} 条（公园环 ${mob?.stats.parkLoops ?? 0}）| 流动校验问题 ${flowIssues.length}`);
  if (flowIssues.length > 0) console.log(`    ${flowIssues.slice(0, 3).map((i) => `${i.code}: ${i.detail}`).join(' | ')}`);
  console.log(`  渲染层高度：道路顶面 0.10 / 公园面 0.14 / 水面 0.18 / 地块红线 0.22 / 岸线 0.24`);
}

const base = createDefaultDocument();
diagnose('默认场景 400×400 m', base);
diagnose('公园比例 30%', applyCommands(base, [
  { op: 'rule.set', path: 'pipeline.landUse.parkRatio', value: 0.3 },
], 'structured').doc);
diagnose('中央公园 3×3 街区', applyCommands(base, [
  { op: 'rule.set', path: 'pipeline.parks.centralBlocks', value: 3 },
], 'structured').doc);

const withWater = applyCommands(base, [
  { op: 'rule.set', path: 'pipeline.extensions.water', value: true },
  { op: 'rule.set', path: 'pipeline.landUse.waterReserveRatio', value: 0.1 },
] as Command[], 'structured').doc;
diagnose('开启 E1 水系', withWater);

const noBank = applyCommands(base, [
  { op: 'rule.set', path: 'pipeline.extensions.water', value: true },
  { op: 'rule.set', path: 'pipeline.extensions.bankSetback', value: 0 },
] as Command[], 'structured').doc;
diagnose('E1 岸线退界 = 0', noBank);

const movedNode = applyCommands(base, [
  { op: 'graph.node.move', id: 'gn.9', x: -95, z: -108 },
] as Command[], 'structured').doc;
diagnose('节点移动：邻路过近（应判违规）', movedNode);
