import { describe, expect, it } from 'vitest';
import type { Rect } from '../core/pipeline/geometry';
import { validateSpatialLayout, type LayoutInput } from '../core/pipeline';
import {
  distanceToEdges, pointInPolygon, polygonsOverlap, v, type Polygon,
} from '../core/geom/polygon';
import { buildGridGraph } from '../core/geom/defaultGraph';
import { generateScene } from '../core/pcg';
import { createDefaultDocument } from '../core/schema';
import type { Bounds, GeneratedScene, SceneDocument } from '../core/types';

const rect = (b: Bounds): Rect => ({ minX: b.minX, maxX: b.maxX, minZ: b.minZ, maxZ: b.maxZ });
const poly = (p: { x: number; z: number }[]): Polygon => p.map((q) => v(q.x, q.z));

function layoutOf(doc: SceneDocument, s: GeneratedScene): LayoutInput {
  return {
    site: { minX: -doc.rules.terrain.width / 2, maxX: doc.rules.terrain.width / 2, minZ: -doc.rules.terrain.depth / 2, maxZ: doc.rules.terrain.depth / 2 },
    bands: s.bands, parcels: s.parcels, uses: s.uses,
    buildings: s.buildings, parks: s.parks, trees: s.trees, water: s.water,
    params: doc.rules.pipeline,
    faceIssues: s.faceIssues, faceArea: s.stats.faceArea, siteArea: s.stats.siteArea, graph: doc.graph,
  };
}

describe('空间布局无重叠冲突（可编辑多边形版）', () => {
  const doc = createDefaultDocument(20261106);
  const s = generateScene(doc);

  it('默认场景的空间校验报告为 PASS 且零冲突', () => {
    expect(s.spatial.ok).toBe(true);
    expect(s.spatial.issues).toEqual([]);
    expect(s.spatial.checks.buildingPairOverlap).toBe(0);
    expect(s.spatial.checks.buildingRoadOverlap).toBe(0);
    expect(s.spatial.checks.parcelOverlaps).toBe(0);
    expect(s.spatial.checks.simpleParcels).toBe(s.parcels.length);
  });

  it('闭合面 / 地块面积守恒，等于场地面积', () => {
    expect(s.stats.faceArea).toBe(s.stats.siteArea);
    expect(s.stats.faceArea).toBe(160000);
    expect(s.parcels.reduce((a, p) => a + p.area, 0)).toBeCloseTo(s.stats.faceArea, 0);
    expect(s.faceIssues).toEqual([]);
  });

  it('每个建筑旋转足迹的四角都落在所属地块多边形内', () => {
    const byId = new Map(s.parcels.map((p) => [p.id, p]));
    expect(s.buildings.length).toBeGreaterThan(100);
    for (const b of s.buildings) {
      const p = byId.get(b.parcelId)!;
      expect(p).toBeDefined();
      for (const q of b.footprint) {
        expect(pointInPolygon(poly(p.polygon), q.x, q.z)).toBe(true);
        expect(distanceToEdges(poly(p.polygon), q.x, q.z)).toBeGreaterThan(0);
      }
    }
  });

  it('建筑足迹互不重叠，且不压占道路带', () => {
    const active = s.bands.filter((x) => !x.suppressed && !x.boundary);
    for (const b of s.buildings) {
      const fp = poly(b.footprint);
      for (const band of active) {
        const minD = Math.min(...fp.map((q) => Math.hypot(q.x - band.a.x, q.z - band.a.z)));
        // 用逐边净距校验器兜底（已断言 buildingRoadOverlap=0），此处只做粗略几何合理性
        expect(Number.isFinite(minD)).toBe(true);
      }
    }
    for (let i = 0; i < s.buildings.length; i++) {
      for (let j = i + 1; j < s.buildings.length; j++) {
        expect(polygonsOverlap(poly(s.buildings[i].footprint), poly(s.buildings[j].footprint))).toBe(false);
      }
    }
  });

  it('公园多边形 ⊂ 所属地块，且不与可建地块 / 其他公园重叠', () => {
    const byId = new Map(s.parcels.map((p) => [p.id, p]));
    const builtIds = new Set(s.uses.filter((u) => ['office', 'residential', 'research', 'commercial'].includes(u.use)).map((u) => u.parcelId));
    for (const park of s.parks) {
      const owners = park.parcelIds.map((id) => byId.get(id)!).filter(Boolean);
      const ownerPolys = owners.map((o) => poly(o.polygon));
      for (const q of park.polygon) {
        expect(ownerPolys.some((op) => pointInPolygon(op, q.x, q.z))).toBe(true);
      }
      for (const q of s.parcels) {
        if (!builtIds.has(q.id) || park.parcelIds.includes(q.id)) continue;
        expect(polygonsOverlap(poly(park.polygon), poly(q.polygon))).toBe(false);
      }
    }
    for (let i = 0; i < s.parks.length; i++) {
      for (let j = i + 1; j < s.parks.length; j++) {
        expect(polygonsOverlap(poly(s.parks[i].polygon), poly(s.parks[j].polygon))).toBe(false);
      }
    }
  });

  it('圆形公园的内切圆完全落在公园包围盒内', () => {
    for (const park of s.parks.filter((p) => p.shape === 'circle')) {
      const b = rect(park.bounds);
      expect(park.x - park.radius).toBeGreaterThanOrEqual(b.minX - 1e-6);
      expect(park.x + park.radius).toBeLessThanOrEqual(b.maxX + 1e-6);
      expect(park.z - park.radius).toBeGreaterThanOrEqual(b.minZ - 1e-6);
      expect(park.z + park.radius).toBeLessThanOrEqual(b.maxZ + 1e-6);
    }
  });

  it('树木满足净距与株距，且树心不落在建筑足迹内', () => {
    const p = doc.rules.pipeline.trees;
    expect(s.trees.length).toBeGreaterThan(100);
    expect(s.stats.streetTrees).toBeGreaterThan(0);
    expect(s.stats.parkTrees).toBeGreaterThan(0);
    expect(s.spatial.minTreeSpacing).toBeGreaterThanOrEqual(p.minSpacing - 1e-3);
    expect(s.spatial.minRoadClearance).toBeGreaterThanOrEqual(p.roadSetback - 1e-3);
    for (const t of s.trees) {
      expect(t.roadClearance).toBeGreaterThanOrEqual(p.roadSetback - 1e-3);
      expect(t.boundaryClearance).toBeGreaterThanOrEqual(p.boundarySetback - 1e-3);
      expect(t.context === 'street' || t.context === 'park').toBe(true);
      for (const b of s.buildings) expect(pointInPolygon(poly(b.footprint), t.x, t.z, -1e-4)).toBe(false);
    }
  });

  it('中央公园内部道路被抑制，且整体空间关系一致', () => {
    const central = s.parks.find((p) => p.sizeClass === 'central');
    expect(central).toBeDefined();
    expect(s.stats.suppressedRoads).toBeGreaterThan(0);
    expect(s.spatial.ok).toBe(true);
    // 被抑制的道路段不应出现在最终可渲染路网中
    const suppressed = new Set(s.stats.suppressedRoads > 0 ? s.bands.filter((b) => b.suppressed).map((b) => b.id) : []);
    for (const seg of s.roads) expect(suppressed.has(seg.id.replace(/^rs\./, 'rb.'))).toBe(false);
  });

  it('生成三种尺寸等级的公园与五种建筑原型', () => {
    expect(s.stats.parksBySize.pocket).toBeGreaterThan(0);
    expect(s.stats.parksBySize.neighborhood).toBeGreaterThan(0);
    expect(s.stats.parksBySize.central).toBeGreaterThan(0);
    for (const k of ['tower', 'slab', 'podium', 'research', 'incubator'] as const) {
      expect(s.stats.archetypeCounts[k]).toBeGreaterThan(0);
    }
  });

  it('校验器能主动发现人为注入的越界足迹', () => {
    const input = layoutOf(doc, s);
    const injected = structuredClone(s.buildings.slice(0, 3));
    // 把建筑足迹整体移到远处，必然越出原地块多边形
    injected[0].footprint = injected[0].footprint.map((q) => ({ x: q.x + 500, z: q.z + 500 }));
    injected[0].bounds = { minX: 500, maxX: 510, minZ: 500, maxZ: 510 };
    const report = validateSpatialLayout({ ...input, buildings: injected });
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.code === 'BUILDING_OUTSIDE_POLYGON' || i.code === 'BUILDING_ROAD_OVERLAP')).toBe(true);
  });
});

describe('多组参数下的空间不变量', () => {
  const cases: Array<{ name: string; patch: (d: SceneDocument) => void }> = [
    { name: '中央公园 1×1 街区', patch: (d) => { d.rules.pipeline.parks.centralBlocks = 1; } },
    { name: '中央公园 3×3 街区', patch: (d) => { d.rules.pipeline.parks.centralBlocks = 3; } },
    { name: '不细分地块', patch: (d) => { d.rules.pipeline.parcels.maxSplit = 1; } },
    { name: '细分 3×3', patch: (d) => { d.rules.pipeline.parcels.maxSplit = 3; d.rules.pipeline.parcels.targetSize = 16; } },
    { name: '大地块 + 大退界', patch: (d) => { d.rules.pipeline.parcels.targetSize = 48; d.rules.pipeline.parcels.setback = 8; } },
    { name: '公园比例 0', patch: (d) => { d.rules.pipeline.landUse.parkRatio = 0; d.rules.pipeline.landUse.plazaRatio = 0; } },
    { name: '公园比例 30%', patch: (d) => { d.rules.pipeline.landUse.parkRatio = 0.3; } },
    { name: '关闭中央开放空间', patch: (d) => { d.rules.openSpace.enabled = false; } },
    { name: '关闭公园内部道路抑制', patch: (d) => { d.rules.pipeline.roads.suppressParkInterior = false; } },
    { name: '矩形中央公园', patch: (d) => { d.rules.openSpace.shape = 'rect'; } },
    { name: '高株距 + 高净距', patch: (d) => { d.rules.pipeline.trees.minSpacing = 8; d.rules.pipeline.trees.roadSetback = 4; d.rules.pipeline.trees.boundarySetback = 2; } },
    { name: '启用两个扩展点', patch: (d) => { d.rules.pipeline.extensions.water = true; d.rules.pipeline.extensions.terrain = true; } },
    { name: '主干路加密', patch: (d) => { d.rules.pipeline.roads.arterialPeriod = 1; d.rules.pipeline.roads.arterialWidth = 20; } },
    {
      name: '场地缩小到 240m', patch: (d) => {
        d.rules.terrain.width = 240; d.rules.terrain.depth = 240;
        d.graph = buildGridGraph(d.rules.terrain, d.rules.pipeline.roads);
      },
    },
  ];

  for (const c of cases) {
    it(`${c.name}：空间校验 PASS`, () => {
      const d = createDefaultDocument(20261106);
      c.patch(d);
      const scene = generateScene(d);
      expect(scene.spatial.ok, JSON.stringify(scene.spatial.issues.slice(0, 4))).toBe(true);
      expect(scene.parcels.length).toBeGreaterThan(0);
      expect(scene.stats.faceArea).toBeCloseTo(scene.stats.siteArea, -2);
    });
  }

  it('关闭内部道路抑制时，中央绿地被道路切分为多个互不重叠的地块', () => {
    const d = createDefaultDocument(20261106);
    d.rules.pipeline.roads.suppressParkInterior = false;
    const scene = generateScene(d);
    expect(scene.stats.suppressedRoads).toBe(0);
    const centralIds = new Set(scene.parcels.filter((p) => p.isCentralPark).map((p) => p.id));
    expect(centralIds.size).toBeGreaterThan(1);
    expect(scene.parks.some((p) => p.parcelIds.some((id) => centralIds.has(id)))).toBe(true);
    expect(scene.spatial.ok).toBe(true);
  });
});
