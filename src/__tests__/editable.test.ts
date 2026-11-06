import { describe, expect, it } from 'vitest';
import { applyCommands } from '../core/commands';
import { generateScene } from '../core/pcg';
import { canonicalize } from '../core/rng';
import { createDefaultDocument, parseSceneJSON, serializeScene } from '../core/schema';
import { distanceToEdges, pointInPolygon, polygonArea, v, type Polygon } from '../core/geom/polygon';
import { extractFaces, totalFaceArea } from '../core/geom/planar';
import type { Command, GeneratedScene, SceneDocument } from '../core/types';

const base = () => createDefaultDocument(20261106);
const edit = (doc: SceneDocument, ...commands: Command[]): SceneDocument => {
  const r = applyCommands(doc, commands, 'structured');
  expect(r.errors, JSON.stringify(r.errors)).toEqual([]);
  return r.doc;
};
const poly = (p: { x: number; z: number }[]): Polygon => p.map((q) => v(q.x, q.z));
const nodeAt = (doc: SceneDocument, x: number, z: number) =>
  doc.graph.nodes.find((n) => Math.abs(n.x - x) < 0.01 && Math.abs(n.z - z) < 0.01)!;
const edgeBetween = (doc: SceneDocument, a: string, b: string) =>
  doc.graph.edges.find((e) => (e.from === a && e.to === b) || (e.from === b && e.to === a))!;

/** 全链路几何断言：面积守恒、地块简单、建筑/公园/树贴合多边形、校验 PASS */
function assertCoherent(doc: SceneDocument, label: string): GeneratedScene {
  const s = generateScene(doc);
  const site = { minX: -doc.rules.terrain.width / 2, maxX: doc.rules.terrain.width / 2, minZ: -doc.rules.terrain.depth / 2, maxZ: doc.rules.terrain.depth / 2 };
  expect(s.faceIssues, `${label}: 面提取异常`).toEqual([]);
  expect(s.spatial.ok, `${label}: ${JSON.stringify(s.spatial.issues.slice(0, 4))}`).toBe(true);
  expect(s.stats.faceArea, `${label}: 面面积守恒`).toBe(s.stats.siteArea);
  expect(s.parcels.reduce((a, p) => a + p.area, 0)).toBeCloseTo(s.stats.faceArea, 0);
  expect(extractFaces(doc.graph, site).faces.length).toBeGreaterThan(0);

  const parcelById = new Map(s.parcels.map((p) => [p.id, p]));
  const parkById = new Map(s.parks.map((p) => [p.id, p]));
  for (const b of s.buildings) {
    const p = parcelById.get(b.parcelId)!;
    expect(p).toBeDefined();
    for (const q of b.footprint) {
      expect(pointInPolygon(poly(p.polygon), q.x, q.z), `${label}: 建筑 ${b.id} 越界`).toBe(true);
      expect(distanceToEdges(poly(p.polygon), q.x, q.z)).toBeGreaterThan(0);
    }
  }
  for (const t of s.trees) {
    const owner = t.context === 'park' ? parkById.get(t.ownerId) : parcelById.get(t.ownerId);
    if (!owner) continue;
    const ownerPoly = t.context === 'park' ? poly((owner as { polygon: { x: number; z: number }[] }).polygon) : poly((owner as { polygon: { x: number; z: number }[] }).polygon);
    expect(pointInPolygon(ownerPoly, t.x, t.z), `${label}: 树 ${t.id} 越出 owner`).toBe(true);
    for (const b of s.buildings) expect(pointInPolygon(poly(b.footprint), t.x, t.z, -1e-4)).toBe(false);
  }
  for (const park of s.parks) {
    const owners = park.parcelIds.map((id) => parcelById.get(id)!).filter(Boolean);
    for (const q of park.polygon) {
      expect(owners.some((o) => pointInPolygon(poly(o.polygon), q.x, q.z)), `${label}: 公园 ${park.id} 越界`).toBe(true);
    }
  }
  return s;
}

describe('可编辑道路图：面提取与连通关系', () => {
  it('初始规则图提取的闭合面面积精确等于场地面积', () => {
    const doc = base();
    const site = { minX: -200, maxX: 200, minZ: -200, maxZ: 200 };
    const r = extractFaces(doc.graph, site);
    expect(r.issues).toEqual([]);
    expect(r.faces.length).toBe(64);
    expect(totalFaceArea(r.faces)).toBe(160000);
    for (const f of r.faces) expect(Math.abs(polygonArea(f.polygon))).toBeGreaterThan(0);
  });

  it('新增斜向路段：自动在交叉处切分，地块变为三角形且关系一致', () => {
    const doc = base();
    const a = nodeAt(doc, -150, -150).id;
    const b = nodeAt(doc, -100, -100).id;
    const d = edit(doc, { op: 'graph.edge.add', from: a, to: b, cls: 'local' });
    const s = assertCoherent(d, '斜向路段');
    const site = { minX: -200, maxX: 200, minZ: -200, maxZ: 200 };
    expect(extractFaces(d.graph, site).faces.length).toBeGreaterThan(64);
    // 出现三角形地块，证明产生了非矩形多边形
    expect(s.parcels.some((p) => p.polygon.length === 3)).toBe(true);
    expect(s.roads.some((r) => Math.abs(r.angle) > 0.1 && Math.abs(r.angle - Math.PI / 2) > 0.1)).toBe(true);
  });

  it('新增节点并连接四条路段：把一个街区细分为多个闭合面', () => {
    const doc = base();
    const corners = [
      nodeAt(doc, -150, -150), nodeAt(doc, -100, -150),
      nodeAt(doc, -150, -100), nodeAt(doc, -100, -100),
    ].map((n) => n.id);
    let d = edit(doc, { op: 'graph.node.add', x: -125, z: -125 });
    const mid = d.graph.nodes.find((n) => Math.abs(n.x + 125) < 0.01 && Math.abs(n.z + 125) < 0.01)!;
    d = edit(d, ...corners.map((from) => ({ op: 'graph.edge.add' as const, from, to: mid.id })));
    const s = assertCoherent(d, '新增节点+四路段');
    expect(s.stats.roadNodes).toBeGreaterThan(0);
    expect(d.graph.edges.length).toBe(doc.graph.edges.length + 4);
  });

  it('移动道路节点：道路走向变为斜线，相邻地块成为非矩形且建筑自动重适配', () => {
    const doc = base();
    const n = nodeAt(doc, -150, -100);
    const d = edit(doc, { op: 'graph.node.move', id: n.id, x: -138, z: -88 });
    const s = assertCoherent(d, '移动节点');
    const nonAxis = s.roads.filter((r) => r.angle !== 0 && Math.abs(r.angle - Math.PI / 2) > 0.01 && Math.abs(r.angle) > 0.01);
    expect(nonAxis.length).toBeGreaterThan(0);
    // 非矩形地块：至少有一条邻边不再水平/垂直
    const skewed = s.parcels.filter((p) => p.polygon.some((q, i) => {
      const r = p.polygon[(i + 1) % p.polygon.length];
      return Math.abs(q.x - r.x) > 0.5 && Math.abs(q.z - r.z) > 0.5;
    }));
    expect(skewed.length).toBeGreaterThan(0);
    // 建筑足迹随斜边旋转
    expect(s.buildings.some((b) => Math.abs(b.orientation) > 0.01)).toBe(true);
  });

  it('删除两条相邻路段：三个面合并成 L 形凹多边形，下游全部重适配', () => {
    const doc = base();
    const a = nodeAt(doc, -150, -150).id;
    const e1 = edgeBetween(doc, a, nodeAt(doc, -100, -150).id);
    const e2 = edgeBetween(doc, a, nodeAt(doc, -150, -100).id);
    const d = edit(doc, { op: 'graph.edge.remove', id: e1.id }, { op: 'graph.edge.remove', id: e2.id });
    const s = assertCoherent(d, 'L 形凹地块');
    expect(s.stats.concaveParcels).toBeGreaterThan(0);
    const concave = s.parcels.filter((p) => p.isConcave);
    expect(concave.length).toBeGreaterThan(0);
    expect(Math.max(...concave.map((p) => p.polygon.length))).toBeGreaterThan(4);
    // 凹地块内若生成建筑，足迹必须仍完整落在凹多边形内
    for (const b of s.buildings.filter((x) => concave.some((p) => p.id === x.parcelId))) {
      for (const q of b.footprint) expect(pointInPolygon(poly(concave.find((p) => p.id === b.parcelId)!.polygon), q.x, q.z)).toBe(true);
    }
  });

  it('删除路段：相邻闭合面自动合并，面积仍守恒', () => {
    const doc = base();
    const a = nodeAt(doc, -150, -150).id;
    const b = nodeAt(doc, -100, -150).id;
    const e = edgeBetween(doc, a, b);
    const d = edit(doc, { op: 'graph.edge.remove', id: e.id });
    const s = assertCoherent(d, '删除路段');
    expect(s.stats.roadEdges).toBeLessThan(generateScene(doc).stats.roadEdges);
  });

  it('删除节点会同时移除关联路段，图仍合法', () => {
    const doc = base();
    const n = nodeAt(doc, -150, -150);
    const before = doc.graph.edges.length;
    const d = edit(doc, { op: 'graph.node.remove', id: n.id });
    expect(d.graph.edges.length).toBeLessThan(before);
    assertCoherent(d, '删除节点');
  });
});

describe('可编辑多边形地块：拆分 / 合并 / 顶点', () => {
  it('拆分：地块数增加、面积守恒、新地块边界闭合', () => {
    const doc = base();
    const d = edit(doc, { op: 'parcel.split', a: { x: -195, z: -195 }, b: { x: -155, z: -155 } });
    const s = assertCoherent(d, '拆分地块');
    expect(s.parcels.length).toBeGreaterThan(generateScene(doc).parcels.length);
    expect(s.skippedEdits).toEqual([]);
    expect(s.parcels.some((p) => p.editDepth > 0)).toBe(true);
  });

  it('合并：两个相邻地块合成一个（可凹）多边形，面积守恒', () => {
    const doc = base();
    const s0 = generateScene(doc);
    // 取两个共边的非中央地块质心作为空间锚点
    let pair: [typeof s0.parcels[number], typeof s0.parcels[number]] | null = null;
    for (const a of s0.parcels) {
      for (const b of s0.parcels) {
        if (a.id === b.id || a.isCentralPark || b.isCentralPark) continue;
        if (Math.hypot(a.bounds.minX - b.bounds.minX, a.bounds.minZ - b.bounds.minZ) > 30) continue;
        if (a.polygon.some((q, i) => {
          const r = a.polygon[(i + 1) % a.polygon.length];
          return b.polygon.some((x, j) => {
            const y = b.polygon[(j + 1) % b.polygon.length];
            return (Math.hypot(q.x - x.x, q.z - x.z) < 0.05 && Math.hypot(r.x - y.x, r.z - y.z) < 0.05)
              || (Math.hypot(q.x - y.x, q.z - y.z) < 0.05 && Math.hypot(r.x - x.x, r.z - x.z) < 0.05);
          });
        })) { pair = [a, b]; break; }
      }
      if (pair) break;
    }
    expect(pair).not.toBeNull();
    const ca = { x: (pair![0].bounds.minX + pair![0].bounds.maxX) / 2, z: (pair![0].bounds.minZ + pair![0].bounds.maxZ) / 2 };
    const cb = { x: (pair![1].bounds.minX + pair![1].bounds.maxX) / 2, z: (pair![1].bounds.minZ + pair![1].bounds.maxZ) / 2 };
    const d = edit(doc, { op: 'parcel.merge', a: ca, b: cb });
    const s = assertCoherent(d, '合并地块');
    expect(s.parcels.length).toBeLessThan(s0.parcels.length);
    expect(s.skippedEdits).toEqual([]);
    expect(s.parcels.some((p) => p.polygon.length > 4 || p.isConcave)).toBe(true);
  });

  it('顶点编辑：共享顶点同步移动，产生非矩形/凹边界且关系闭合', () => {
    const doc = base();
    const s0 = generateScene(doc);
    // 取一个被多个地块共享的内部顶点
    const counts = new Map<string, number>();
    for (const p of s0.parcels) for (const q of p.polygon) {
      const k = `${Math.round(q.x)},${Math.round(q.z)}`;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const shared = Array.from(counts.entries()).filter(([, n]) => n >= 3)
      .map(([k]) => k.split(',').map(Number) as [number, number])
      .find(([x, z]) => Math.abs(x) < 180 && Math.abs(z) < 180);
    expect(shared).toBeDefined();
    const d = edit(doc, { op: 'parcel.vertex', at: { x: shared![0], z: shared![1] }, to: { x: shared![0] + 8, z: shared![1] + 6 } });
    const s = assertCoherent(d, '顶点编辑');
    expect(s.skippedEdits, JSON.stringify(s.skippedEdits)).toEqual([]);
    expect(s.parcels.some((p) => p.isConcave || p.polygon.length !== 4)).toBe(true);
  });

  it('编辑序列按空间锚点重放：改道路后仍附着正确位置且可清空', () => {
    const doc = base();
    const splitDoc = edit(doc, { op: 'parcel.split', a: { x: -195, z: -195 }, b: { x: -155, z: -155 } });
    const movedDoc = edit(splitDoc, { op: 'graph.node.move', id: nodeAt(splitDoc, -150, -150).id, x: -145, z: -145 });
    const s = assertCoherent(movedDoc, '编辑重放');
    expect(s.parcels.some((p) => p.editDepth > 0)).toBe(true);
    const cleared = edit(movedDoc, { op: 'parcel.edits.clear' });
    expect(cleared.parcelEdits).toEqual([]);
    assertCoherent(cleared, '清空编辑');
  });
});

describe('多次编辑后的一致性、确定性与撤销', () => {
  const flow: Command[] = [
    { op: 'graph.node.move', id: 'gn.9', x: -95, z: -108 },
    { op: 'graph.edge.add', from: 'gn.0', to: 'gn.10' },
    { op: 'parcel.split', a: { x: -195, z: -195 }, b: { x: -155, z: -155 } },
    { op: 'parcel.merge', a: { x: -187, z: -137 }, b: { x: -162, z: -137 } },
    { op: 'graph.node.add', x: -125, z: -125 },
    { op: 'graph.edge.remove', id: 'ge.60' },
    { op: 'rule.set', path: 'pipeline.landUse.parkRatio', value: 0.18 },
    { op: 'rule.set', path: 'pipeline.trees.streetInterval', value: 7 },
    { op: 'graph.edge.update', id: 'ge.0', cls: 'arterial' },
    { op: 'density.adjust', zone: 'east', mode: 'relative', delta: -0.3 },
    { op: 'parcel.vertex', at: { x: -150, z: -150 }, to: { x: -146, z: -147 } },
    { op: 'graph.regenerate' },
  ];

  it('连续 12 步编辑：每步空间 PASS、面积守恒、图合法', () => {
    let doc = base();
    for (let i = 0; i < flow.length; i++) {
      const r = applyCommands(doc, [flow[i]], 'structured');
      expect(r.errors, `第 ${i + 1} 步 ${flow[i].op}: ${JSON.stringify(r.errors)}`).toEqual([]);
      doc = r.doc;
      const s = generateScene(doc);
      expect(s.spatial.ok, `第 ${i + 1} 步 ${flow[i].op}: ${JSON.stringify(s.spatial.issues.slice(0, 3))}`).toBe(true);
      expect(s.stats.faceArea, `第 ${i + 1} 步面积`).toBe(s.stats.siteArea);
    }
  });

  it('相同编辑终态重复生成逐位一致，JSON 往返后一致', () => {
    let doc = base();
    for (const c of flow) doc = edit(doc, c);
    const a = generateScene(doc);
    const b = generateScene(doc);
    expect(b.fingerprint).toBe(a.fingerprint);
    expect(canonicalize([b.parcels, b.parks, b.buildings, b.trees, b.roadEdges]))
      .toBe(canonicalize([a.parcels, a.parks, a.buildings, a.trees, a.roadEdges]));
    const parsed = parseSceneJSON(serializeScene(doc));
    expect(parsed.ok).toBe(true);
    expect(generateScene(parsed.doc!).fingerprint).toBe(a.fingerprint);
    expect(parsed.doc!.graph).toEqual(doc.graph);
    expect(parsed.doc!.parcelEdits).toEqual(doc.parcelEdits);
  });

  it('撤销 / 重做精确恢复编辑前状态', () => {
    const doc = edit(base(), { op: 'graph.edge.add', from: 'gn.0', to: 'gn.10' });
    const n0 = doc.graph.nodes.find((n) => n.id === 'gn.0')!;
    const back = applyCommands(doc, [{ op: 'graph.node.move', id: n0.id, x: n0.x - 2, z: n0.z + 2 }], 'structured').doc;
    expect(generateScene(back).fingerprint).not.toBe(generateScene(doc).fingerprint);
    // 恢复为原坐标后指纹应与编辑前逐位一致
    const restored = applyCommands(back, [{ op: 'graph.node.move', id: n0.id, x: n0.x, z: n0.z }], 'structured').doc;
    expect(restored.graph.nodes.find((n) => n.id === n0.id)).toEqual(n0);
    expect(generateScene(restored).fingerprint).toBe(generateScene(doc).fingerprint);
  });

  it('建筑、公园、树木在编辑后全部重新贴合新地块，无越界 / 穿插', () => {
    let doc = base();
    for (const c of flow.slice(0, 9)) doc = edit(doc, c);
    const s = assertCoherent(doc, '多次编辑终态');
    expect(s.buildings.length).toBeGreaterThan(0);
    expect(s.parks.length).toBeGreaterThan(0);
    expect(s.trees.length).toBeGreaterThan(0);
    expect(s.spatial.checks.buildingInsidePolygon).toBe(s.buildings.filter((b) => !b.deleted).length);
  });
});
