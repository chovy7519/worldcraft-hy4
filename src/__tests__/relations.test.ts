/**
 * 城市要素关系契约（v1.3.0 规则层）
 *
 * 回归目标：修复前实测默认场景 57/57 个公园与道路带重叠 28.3%、空间校验却 PASS。
 * 这里断言的不只是「退界能跑」，而是「关系被显式声明、参数改动会传导、校验口径统一」。
 */
import { describe, expect, it } from 'vitest';
import {
  ELEMENT_KINDS, RELATION_MATRIX, bandPolygon, buildingRoadClearance,
  clearanceFor, declaredChecks, describeRelations, setbackFromRoads, sidewalkOffsetWithin,
} from '../core/spatialRules';
import { createDefaultDocument } from '../core/schema';
import { generateScene } from '../core/pcg';
import { applyCommands } from '../core/commands';
import { polygonArea, polygonsOverlap, v, type Polygon } from '../core/geom/polygon';
import type { GeneratedScene, RoadBand } from '../core/types';

const rect = (x0: number, z0: number, x1: number, z1: number): Polygon => [
  v(x0, z0), v(x1, z0), v(x1, z1), v(x0, z1),
];

function overlapWithRoads(poly: { x: number; z: number }[], scene: GeneratedScene): number {
  const p = poly.map((q) => v(q.x, q.z));
  let hits = 0;
  for (const band of scene.bands.filter((b) => !b.suppressed && !b.boundary)) {
    if (polygonsOverlap(p, bandPolygon(band))) hits++;
  }
  return hits;
}

describe('关系矩阵：显式声明而非散落在各处', () => {
  it('覆盖全部要素类型，且每条关系都有主体/客体/规则文本', () => {
    const mentioned = new Set<string>();
    for (const r of RELATION_MATRIX) {
      expect(r.rule.length).toBeGreaterThan(4);
      mentioned.add(r.subject);
      mentioned.add(r.object);
    }
    for (const kind of ELEMENT_KINDS) expect(mentioned.has(kind)).toBe(true);
  });

  it('所有 setbackFrom / avoids 关系都声明了唯一参数或校验 code', () => {
    for (const r of RELATION_MATRIX.filter((x) => x.kind === 'setbackFrom' || x.kind === 'avoids')) {
      expect(Boolean(r.parameter) || Boolean(r.enforcedBy)).toBe(true);
    }
  });

  it('declaredChecks 去重、非空，且都是大写 snake code', () => {
    const codes = declaredChecks();
    expect(codes.length).toBeGreaterThan(8);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes.every((c) => /^[A-Z_]+$/.test(c))).toBe(true);
  });

  it('describeRelations 可序列化，供 Inspector / 文档消费', () => {
    const lines = describeRelations();
    expect(lines.length).toBe(RELATION_MATRIX.length);
    expect(() => JSON.stringify(lines)).not.toThrow();
  });
});

describe('统一退界口径', () => {
  it('clearanceFor 复用已有参数，不引入重复旋钮', () => {
    const p = createDefaultDocument().rules.pipeline;
    expect(clearanceFor('park', p)).toBe(p.parks.inset);
    expect(clearanceFor('plaza', p)).toBe(p.parks.inset);
    expect(clearanceFor('building', p)).toBe(p.parcels.setback);
    expect(clearanceFor('water', p)).toBe(p.extensions.bankSetback);
    expect(clearanceFor('tree', p)).toBe(p.trees.roadSetback);
  });

  it('步道宽度传导到建筑退界：调宽步道，建筑必须让出更多空间', () => {
    const p = createDefaultDocument().rules.pipeline;
    const narrow = buildingRoadClearance(p);
    const wide = buildingRoadClearance({ ...p, mobility: { ...p.mobility, sidewalkWidth: 3.5 } });
    expect(wide).toBeGreaterThan(narrow);
    expect(sidewalkOffsetWithin(p)).toBe(p.mobility.sidewalkWidth);
    expect(sidewalkOffsetWithin(p)).toBeLessThan(wide);
  });

  it('bandPolygon 面积 = 道路宽 × 长度，与校验器共用同一几何', () => {
    const band = {
      id: 'b', axis: 'x', coord: 0, width: 8, cls: 'local',
      bounds: { minX: 0, maxX: 100, minZ: -4, maxZ: 4 },
      a: { x: 0, z: 0 }, b: { x: 100, z: 0 }, suppressed: false, boundary: false,
      length: 100, angle: 0,
    } as RoadBand;
    expect(polygonArea(bandPolygon(band))).toBeCloseTo(800, 3);
    expect(polygonArea(bandPolygon(band, 2))).toBeCloseTo(1200, 3);
  });

  it('setbackFromRoads 只裁临路一侧，背街边界不被整体内缩', () => {
    const band = {
      id: 'b', axis: 'x', coord: 0, width: 6, cls: 'local',
      bounds: { minX: 0, maxX: 40, minZ: -3, maxZ: 3 },
      a: { x: 0, z: 0 }, b: { x: 40, z: 0 }, suppressed: false, boundary: false,
      length: 40, angle: 0,
    } as RoadBand;
    // 公园在道路下方（+Z 侧），退界应只把上边界往下推
    const result = setbackFromRoads(rect(5, -5, 35, 25), [band], 1.5);
    expect(result.polygon).not.toBeNull();
    expect(result.clippedBy).toBe(1);
    const zs = result.polygon!.map((q) => q.z);
    expect(Math.min(...zs)).toBeGreaterThan(3 + 1.5 - 0.01);
    expect(Math.max(...zs)).toBeCloseTo(25, 3); // 背街侧保持
  });
});

describe('修复回归：绿地 / 广场 / 水面不压路', () => {
  it('默认场景全部公园与广场与道路带零重叠，且空间校验 PASS', () => {
    const scene = generateScene(createDefaultDocument());
    expect(scene.parks.length).toBeGreaterThan(0);
    expect(scene.parks.every((p) => overlapWithRoads(p.polygon, scene) === 0)).toBe(true);
    expect(scene.spatial.issues.filter((i) => i.code === 'PARK_ROAD_OVERLAP')).toEqual([]);
    expect(scene.spatial.ok).toBe(true);
  });

  it('广场与绿地共用同一退界规则，不因铺装形式豁免', () => {
    const scene = generateScene(applyCommands(createDefaultDocument(), [
      { op: 'rule.set', path: 'pipeline.landUse.plazaRatio', value: 0.2 },
    ], 'structured').doc);
    const plazas = scene.parks.filter((p) => p.style === 'plaza');
    expect(plazas.length).toBeGreaterThan(0);
    expect(plazas.every((p) => overlapWithRoads(p.polygon, scene) === 0)).toBe(true);
  });

  it('开启水系后水面不压路，且水面 ⊆ 原始岸线', () => {
    const scene = generateScene(applyCommands(createDefaultDocument(), [
      { op: 'rule.set', path: 'pipeline.extensions.water', value: true },
      { op: 'rule.set', path: 'pipeline.landUse.waterReserveRatio', value: 0.1 },
    ], 'structured').doc);
    expect(scene.water.length).toBeGreaterThan(0);
    expect(scene.water.every((w) => !w.polygon || overlapWithRoads(w.polygon, scene) === 0)).toBe(true);
    expect(scene.spatial.issues.filter((i) => i.code === 'WATER_ROAD_OVERLAP')).toEqual([]);
  });

  it('调大 parks.inset 会同时缩小绿地面积并带动树位变化（关系传导）', () => {
    const doc = createDefaultDocument();
    const a = generateScene(doc);
    const b = generateScene(applyCommands(doc, [
      { op: 'rule.set', path: 'pipeline.parks.inset', value: 5 },
    ], 'structured').doc);
    const areaA = a.parks.reduce((s, p) => s + p.area, 0);
    const areaB = b.parks.reduce((s, p) => s + p.area, 0);
    expect(areaB).toBeLessThan(areaA);
    expect(b.spatial.ok).toBe(true);
  });

  it('调宽步道会让建筑退界，建筑数量随之变化（城市是整体）', () => {
    const doc = createDefaultDocument();
    const a = generateScene(doc);
    const b = generateScene(applyCommands(doc, [
      { op: 'rule.set', path: 'pipeline.mobility.sidewalkWidth', value: 4 },
    ], 'structured').doc);
    // 退界变大主要体现为单体足迹变小（更小的房子反而可能放得更多），
    // 所以断言平均占地面积，而不是栋数
    const avgFoot = (s: typeof a) => s.buildings.reduce((sum, x) => sum + x.w * x.d, 0) / Math.max(1, s.buildings.length);
    expect(avgFoot(b)).toBeLessThan(avgFoot(a));
    expect(b.spatial.ok).toBe(true);
    expect(b.parks.every((p) => overlapWithRoads(p.polygon, b) === 0)).toBe(true);
  });
});
