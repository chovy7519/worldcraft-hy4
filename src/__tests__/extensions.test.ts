/**
 * v1.3.0 E1 水系 / E2 地形要素契约
 * 验收：不再是 placeholder，水面有真实多边形与岸线退界，地形有高程场与道路纵断，
 * 且扩展点开启后空间校验仍 PASS、确定性仍成立。
 */
import { describe, expect, it } from 'vitest';
import { createDefaultDocument } from '../core/schema';
import { generateScene } from '../core/pcg';
import { applyCommands } from '../core/commands';
import { pointInPolygon, polygonArea, v } from '../core/geom/polygon';

function enable(water: boolean, terrain: boolean) {
  return applyCommands(createDefaultDocument(), [
    { op: 'rule.set', path: 'pipeline.extensions.water', value: water },
    { op: 'rule.set', path: 'pipeline.extensions.terrain', value: terrain },
  ], 'structured').doc;
}

describe('E1 水系扩展点', () => {
  it('关闭时无几何，但仍登记预留地块统计', () => {
    const scene = generateScene(enable(false, false));
    expect(scene.water).toHaveLength(0);
    expect(scene.stats.waterSurfaces).toBe(0);
    expect(scene.spatial.ok).toBe(true);
  });

  it('开启后生成真实水面多边形、原始岸线与退界值', () => {
    const scene = generateScene(enable(true, false));
    expect(scene.water.length).toBeGreaterThan(0);
    expect(scene.stats.waterSurfaces).toBe(scene.water.length);
    for (const w of scene.water) {
      expect(w.placeholder).toBe(false);
      expect(w.polygon!.length).toBeGreaterThanOrEqual(3);
      expect(w.shoreline!.length).toBeGreaterThanOrEqual(3);
      expect(w.parcelIds.length).toBeGreaterThan(0);
      expect(w.level).toBe(-1.2);
      expect(Number.isFinite(w.width)).toBe(true);
      // 退界后的水面必须落在原始红线内
      const shore = w.shoreline!.map((q) => v(q.x, q.z));
      expect(w.polygon!.every((q) => pointInPolygon(shore, q.x, q.z))).toBe(true);
    }
    expect(scene.spatial.ok, JSON.stringify(scene.spatial.issues)).toBe(true);
  });

  it('岸线退界确实缩小水面；退界为 0 时水面与岸线一致', () => {
    const doc = enable(true, false);
    const withBank = generateScene(doc);
    const noBank = generateScene(applyCommands(doc, [
      { op: 'rule.set', path: 'pipeline.extensions.bankSetback', value: 0 },
    ], 'structured').doc);
    const areaWith = withBank.water.reduce((s, w) => s + polygonArea(w.polygon!.map((q) => v(q.x, q.z))), 0);
    const areaWithout = noBank.water.reduce((s, w) => s + polygonArea(w.polygon!.map((q) => v(q.x, q.z))), 0);
    expect(areaWith).toBeLessThan(areaWithout);
    expect(withBank.fingerprint).not.toBe(noBank.fingerprint);
    expect(noBank.spatial.ok).toBe(true);
  });

  it('相邻预留地块连成单一水面时 connected=true', () => {
    const doc = applyCommands(createDefaultDocument(), [
      { op: 'rule.set', path: 'pipeline.extensions.water', value: true },
      { op: 'rule.set', path: 'pipeline.landUse.waterReserveRatio', value: 0.25 },
    ], 'structured').doc;
    const scene = generateScene(doc);
    expect(scene.water.some((w) => w.connected)).toBe(true);
    expect(scene.spatial.ok, JSON.stringify(scene.spatial.issues)).toBe(true);
  });
});

describe('E2 地形要素扩展点', () => {
  it('每个地形要素含高程场、坡度与道路纵断采样', () => {
    const scene = generateScene(enable(false, true));
    expect(scene.terrainFeatures.length).toBeGreaterThan(0);
    expect(scene.stats.terrainPatches).toBe(scene.terrainFeatures.length);
    for (const f of scene.terrainFeatures) {
      expect(f.placeholder).toBe(false);
      expect(f.polygon!.length).toBeGreaterThanOrEqual(3);
      expect(f.heightfield!).toHaveLength(9);
      expect(f.heightfield!.every((s) => Number.isFinite(s.y))).toBe(true);
      expect(f.slope!).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(f.retainingLines)).toBe(true);
      for (const profile of f.roadProfiles ?? []) {
        expect(profile.samples).toHaveLength(5);
        expect(profile.samples.every((s) => Number.isFinite(s.y))).toBe(true);
      }
    }
    expect(scene.spatial.ok, JSON.stringify(scene.spatial.issues)).toBe(true);
  });

  it('起伏幅度为 0 时高程恒等于基准，纵断平坦', () => {
    const doc = applyCommands(enable(false, true), [
      { op: 'rule.set', path: 'pipeline.extensions.terrainAmplitude', value: 0 },
    ], 'structured').doc;
    const scene = generateScene(doc);
    expect(scene.terrainFeatures.every((f) => f.heightfield!.every((s) => s.y === 0))).toBe(true);
    expect(scene.terrainFeatures.every((f) => f.slope === 0)).toBe(true);
  });
});

describe('两个扩展点同时开启', () => {
  it('空间校验 PASS，且确定性成立', () => {
    const doc = enable(true, true);
    const a = generateScene(doc);
    const b = generateScene(doc);
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.spatial.ok, JSON.stringify(a.spatial.issues)).toBe(true);
    expect(a.water.length).toBeGreaterThan(0);
    expect(a.terrainFeatures.length).toBeGreaterThan(0);
    expect(a.stages.find((s) => s.id === 'water')!.deps).toContain('roads');
  });
});
