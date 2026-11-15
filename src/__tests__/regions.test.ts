/**
 * v1.3.0 区域选择器与规则叠加层契约
 * 重点不是「功能能跑」，而是三条不变量：空层恒等、局部性、命令闭环。
 */
import { describe, expect, it } from 'vitest';
import {
  evaluateRegions, makeRegionLayer, matchesSelector, parseRegionLayer, parseRegionLayers,
  type RegionLayer,
} from '../core/regions';
import { applyCommands, validateCommand } from '../core/commands';
import { createDefaultDocument, parseSceneJSON, serializeScene } from '../core/schema';
import { generateScene } from '../core/pcg';
import { zoneOf } from '../core/zones';

const site = { width: 400, depth: 400 };

const band = (over: Partial<RegionLayer> = {}): RegionLayer => makeRegionLayer({
  id: 'r.westband',
  name: '西侧带',
  selector: { kind: 'band', axis: 'x', min: -200, max: -100 },
  density: 0.5,
  height: 0.8,
  priority: 10,
  ...over,
});

describe('区域选择器：纯函数语义', () => {
  it('空叠加层是恒等元，任意坐标倍率都为 1', () => {
    for (const [x, z] of [[0, 0], [-180, 120], [199, -199]]) {
      const f = evaluateRegions([], x, z, site);
      expect(f.density).toBe(1);
      expect(f.height).toBe(1);
      expect(f.matched).toEqual([]);
    }
  });

  it('band 只命中范围内坐标，端点包含', () => {
    const sel = { kind: 'band', axis: 'x', min: -100, max: 100 } as const;
    expect(matchesSelector(sel, -100, 180, site)).toBe(true);
    expect(matchesSelector(sel, 100, 0, site)).toBe(true);
    expect(matchesSelector(sel, 100.1, 0, site)).toBe(false);
    expect(matchesSelector(sel, 0, 500, site)).toBe(true); // 另一轴不受约束
  });

  it('radius 与 polygon 选择器按几何判定', () => {
    const r = { kind: 'radius', cx: 10, cz: 20, r: 15 } as const;
    expect(matchesSelector(r, 10, 20, site)).toBe(true);
    expect(matchesSelector(r, 26, 20, site)).toBe(false);
    const p = { kind: 'polygon', polygon: [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }, { x: 0, z: 10 }] } as RegionLayer['selector'];
    expect(matchesSelector(p, 5, 5, site)).toBe(true);
    expect(matchesSelector(p, 15, 5, site)).toBe(false);
  });

  it('zone 选择器与互斥分区 zoneOf 完全一致（穷举 41×41）', () => {
    for (let i = -20; i <= 20; i++) {
      for (let j = -20; j <= 20; j++) {
        const x = i * 10;
        const z = j * 10;
        const nx = x / 200;
        const nz = z / 200;
        expect(matchesSelector({ kind: 'zone', zone: zoneOf(nx, nz) }, x, z, site)).toBe(true);
      }
    }
  });

  it('multiply 按 (priority, id) 稳定叠加，override 覆盖先前结果', () => {
    const a = band({ id: 'r.a', density: 0.5, priority: 5, selector: { kind: 'all' } });
    const b = band({ id: 'r.b', density: 0.8, priority: 20, selector: { kind: 'all' } });
    const f = evaluateRegions([b, a], 0, 0, site); // 故意乱序
    expect(f.matched).toEqual(['r.a', 'r.b']);
    expect(f.density).toBe(0.4);
    expect(f.height).toBe(0.64);
    const c = band({ id: 'r.c', density: 1.2, height: 1.5, priority: 30, blend: 'override', selector: { kind: 'all' } });
    const g = evaluateRegions([b, a, c], 0, 0, site);
    expect(g.density).toBe(1.2);
    expect(g.height).toBe(1.5);
  });

  it('禁用的层不参与求值', () => {
    const f = evaluateRegions([band({ enabled: false })], -150, 0, site);
    expect(f.density).toBe(1);
  });
});

describe('区域叠加层：校验与命令闭环', () => {
  it('非法选择器类型与越界倍率被拒绝', () => {
    expect(parseRegionLayer({ selector: { kind: 'unknown' } }).ok).toBe(false);
    expect(parseRegionLayer({ selector: { kind: 'all' }, density: 9 }).ok).toBe(false);
    expect(parseRegionLayer({ selector: { kind: 'radius', cx: 0, cz: 0, r: 0 } }).ok).toBe(false);
    expect(parseRegionLayers(new Array(25).fill({ selector: { kind: 'all' } })).ok).toBe(false);
  });

  it('validateCommand 拒绝非法 region 命令', () => {
    expect(validateCommand({ op: 'region.add', layer: { selector: { kind: 'all' }, density: 3 } }).ok).toBe(false);
    expect(validateCommand({ op: 'region.update', id: 'bad id!', patch: { density: 1 } }).ok).toBe(false);
    expect(validateCommand({ op: 'region.update', id: 'r.a', patch: {} }).ok).toBe(false);
  });

  it('add / update / remove 走同一执行器，并产生可追溯变更', () => {
    const doc = createDefaultDocument();
    const added = applyCommands(doc, [{ op: 'region.add', layer: band() }], 'structured');
    expect(added.errors).toEqual([]);
    expect(added.doc.regions).toHaveLength(1);
    expect(added.changes[0].path).toBe('regions.r.westband');

    const updated = applyCommands(added.doc, [{ op: 'region.update', id: 'r.westband', patch: { density: 0.3 } }], 'structured');
    expect(updated.doc.regions?.[0].density).toBe(0.3);

    const removed = applyCommands(updated.doc, [{ op: 'region.remove', id: 'r.westband' }], 'structured');
    expect(removed.doc.regions).toHaveLength(0);
    // 纯函数：入参未被修改
    expect(doc.regions).toEqual([]);
    expect(added.doc.regions?.[0].density).toBe(0.5);
  });

  it('叠加层随 JSON 往返，且空层不进入指纹', () => {
    const doc = createDefaultDocument();
    const plain = generateScene(doc).fingerprint;
    const round = parseSceneJSON(serializeScene(doc));
    expect(round.ok).toBe(true);
    expect(generateScene(round.doc!).fingerprint).toBe(plain);

    const withLayer = applyCommands(doc, [{ op: 'region.add', layer: band() }], 'structured').doc;
    const restored = parseSceneJSON(serializeScene(withLayer));
    expect(restored.ok).toBe(true);
    expect(restored.doc!.regions).toHaveLength(1);
    expect(generateScene(restored.doc!).fingerprint).toBe(generateScene(withLayer).fingerprint);
    expect(generateScene(withLayer).fingerprint).not.toBe(plain);
  });

  it('带内密度改变，带外所有建筑逐位不变', () => {
    const doc = createDefaultDocument();
    const before = generateScene(doc);
    const after = generateScene(applyCommands(doc, [{ op: 'region.add', layer: band() }], 'structured').doc);
    const inside = (x: number) => x >= -200 && x <= -100;
    const outsideBefore = before.buildings.filter((b) => !inside(b.x)).map((b) => JSON.stringify(b));
    const outsideAfter = after.buildings.filter((b) => !inside(b.x)).map((b) => JSON.stringify(b));
    expect(outsideAfter).toEqual(outsideBefore);
    expect(after.stats.regionLayers).toBe(1);
    expect(after.spatial.ok).toBe(true);
    expect(after.buildings.length).toBeLessThanOrEqual(before.buildings.length);
  });

  it('v1.2.0 存档（无 regions 字段）可迁移且几何指纹稳定', () => {
    const legacy = {
      schemaVersion: '1.2.0', id: 'legacy', name: '旧场景', seed: 20261106, revision: 1,
      rules: (() => {
        const r = JSON.parse(JSON.stringify(createDefaultDocument().rules));
        delete r.pipeline.extensions.bankSetback;
        delete r.pipeline.extensions.waterLevel;
        delete r.pipeline.extensions.terrainAmplitude;
        delete r.pipeline.extensions.terrainFrequency;
        return r;
      })(),
      graph: createDefaultDocument().graph,
      parcelEdits: [], overrides: {},
      createdAt: '2026-11-06T00:00:00.000Z', updatedAt: '2026-11-06T00:00:00.000Z',
    };
    const parsed = parseSceneJSON(JSON.stringify(legacy));
    expect(parsed.ok).toBe(true);
    expect(parsed.doc!.schemaVersion).toBe('1.3.0');
    expect(parsed.doc!.regions).toEqual([]);
    expect(parsed.doc!.rules.pipeline.extensions.bankSetback).toBe(4);
    expect(generateScene(parsed.doc!).spatial.ok).toBe(true);
  });
});
