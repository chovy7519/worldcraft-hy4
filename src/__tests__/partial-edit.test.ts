import { describe, expect, it } from 'vitest';
import { applyCommands } from '../core/commands';
import { generateScene } from '../core/pcg';
import { canonicalize } from '../core/rng';
import { createDefaultDocument } from '../core/schema';

/** 验收场景的核心断言：局部编辑不得扰动未修改区域 */
describe('连续多轮编辑 · 局部不变性', () => {
  const base = createDefaultDocument(424242);

  it('「东侧密度降低 30%」后，非东侧全部建筑逐位不变', () => {
    const s0 = generateScene(base);
    const result = applyCommands(base, [
      { op: 'density.adjust', zone: 'east', mode: 'relative', delta: -0.3 },
    ], 'nl');
    expect(result.errors).toEqual([]);
    expect(result.doc.rules.density.zoneMultipliers.east).toBeCloseTo(0.7, 6);
    const s1 = generateScene(result.doc);

    const before = canonicalize(s0.buildings.filter((b) => b.zone !== 'east'));
    const after = canonicalize(s1.buildings.filter((b) => b.zone !== 'east'));
    expect(after).toBe(before);
  });

  it('东侧建筑数量约下降 30%，其他分区统计完全不变', () => {
    const s0 = generateScene(base);
    const s1 = generateScene(applyCommands(base, [
      { op: 'density.adjust', zone: 'east', mode: 'relative', delta: -0.3 },
    ], 'nl').doc);
    const e0 = s0.stats.byZone.find((z) => z.zone === 'east')!.buildings;
    const e1 = s1.stats.byZone.find((z) => z.zone === 'east')!.buildings;
    // 多槽位地块的每个槽位独立抽样，倍率下降对 k>0 槽位影响叠加，
    // 因此总数降幅可大于 30%；核心不变量是「其他分区逐位不变」（另有测试断言）。
    expect(e1).toBeGreaterThan(0);
    expect(e1).toBeLessThan(e0 * 0.85);
    for (const z of ['core', 'west', 'north', 'south'] as const) {
      expect(s1.stats.byZone.find((x) => x.zone === z))
        .toEqual(s0.stats.byZone.find((x) => x.zone === z));
    }
  });

  it('道路、乔木、开放空间在密度编辑前后逐位不变', () => {
    const s0 = generateScene(base);
    const s1 = generateScene(applyCommands(base, [
      { op: 'density.adjust', zone: 'east', mode: 'relative', delta: -0.3 },
    ], 'nl').doc);
    expect(canonicalize(s1.roads)).toBe(canonicalize(s0.roads));
    expect(canonicalize(s1.trees)).toBe(canonicalize(s0.trees));
    expect(canonicalize(s1.plaza)).toBe(canonicalize(s0.plaza));
  });

  it('「降低东侧建筑高度」只改变东侧高度，其他区域高度不变', () => {
    const s0 = generateScene(base);
    const s1 = generateScene(applyCommands(base, [
      { op: 'height.adjust', zone: 'east', mode: 'relative', delta: -0.35 },
    ], 'nl').doc);
    expect(s1.buildings.filter((b) => b.zone === 'east').every((b) =>
      b.h < (s0.buildings.find((x) => x.id === b.id)?.h ?? Infinity))).toBe(true);
    expect(canonicalize(s1.buildings.filter((b) => b.zone !== 'east')))
      .toBe(canonicalize(s0.buildings.filter((b) => b.zone !== 'east')));
  });

  it('多轮编辑可精确回退：倍率还原后指纹与几何均与原场景一致', () => {
    const s0 = generateScene(base);
    const r1 = applyCommands(base, [
      { op: 'density.adjust', zone: 'east', mode: 'relative', delta: -0.3 },
    ], 'nl');
    expect(generateScene(r1.doc).fingerprint).not.toBe(s0.fingerprint);
    const r2 = applyCommands(r1.doc, [
      { op: 'density.adjust', zone: 'east', mode: 'absolute', value: 1 },
    ], 'nl');
    expect(generateScene(r2.doc).fingerprint).toBe(s0.fingerprint);
    expect(canonicalize(generateScene(r2.doc).buildings)).toBe(canonicalize(s0.buildings));
  });

  it('规则变更记录可追溯：包含路径、作用域、前后值与来源', () => {
    const result = applyCommands(base, [
      { op: 'density.adjust', zone: 'east', mode: 'relative', delta: -0.3 },
    ], 'nl');
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({
      path: 'density.zoneMultipliers.east',
      scope: '东侧',
      before: 1,
      after: 0.7,
      source: 'nl',
    });
  });
});
