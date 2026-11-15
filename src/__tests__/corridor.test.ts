/**
 * 相邻道路带最小净距（通行廊道）静态规则
 *
 * 背景：用户确认「判为违规并给出提示」。此前图形编辑可把两条平行道路挪到过近，
 * 中间放不下双侧步道，静态校验却 PASS，只有派生的人流层先暴露。
 */
import { describe, expect, it } from 'vitest';
import { createDefaultDocument } from '../core/schema';
import { applyCommands } from '../core/commands';
import { generateScene } from '../core/pcg';
import {
  RELATION_MATRIX, corridorMinGap, nearParallel, segmentDistance, shareEndpoint,
} from '../core/spatialRules';
import { v } from '../core/geom/polygon';

const CODE = 'ROAD_CORRIDOR_NARROW';

const movedDoc = () => applyCommands(createDefaultDocument(), [
  { op: 'graph.node.move', id: 'gn.9', x: -95, z: -108 },
], 'structured').doc;

describe('相邻道路带最小净距', () => {
  it('关系矩阵登记该规则，绑定参数与校验 code', () => {
    const rule = RELATION_MATRIX.find((r) => r.enforcedBy === CODE);
    expect(rule).toBeDefined();
    expect(rule!.kind).toBe('setbackFrom');
    expect(rule!.parameter).toBe('pipeline.mobility.sidewalkWidth');
  });

  it('默认正交路网不误报', () => {
    const s = generateScene(createDefaultDocument());
    expect(s.spatial.issues.filter((i) => i.code === CODE)).toEqual([]);
    expect(s.spatial.ok).toBe(true);
    expect(s.spatial.checks.corridorNarrowPairs).toBe(0);
    expect(s.spatial.checks.corridorMinGap).toBeCloseTo(4.4, 2);
  });

  it('节点移动把两条平行路挪到过近 → 判违规，spatial.ok = false', () => {
    const s = generateScene(movedDoc());
    const hits = s.spatial.issues.filter((i) => i.code === CODE);
    expect(hits.length).toBeGreaterThan(0);
    expect(s.spatial.ok).toBe(false);
    expect(hits[0].detail).toContain('净距');
    expect(hits[0].detail).toContain('要求');
  });

  it('提示包含路段 ID、要求净距与三种可操作修复动作', () => {
    const s = generateScene(movedDoc());
    const hit = s.spatial.issues.find((i) => i.code === CODE)!;
    expect(hit.a).toBeTruthy();
    expect(hit.b).toBeTruthy();
    expect(hit.advice).toBeTruthy();
    expect(hit.advice).toContain('移开');
    expect(hit.advice).toContain('删除多余路段');
    expect(hit.advice).toContain('sidewalkWidth');
    expect(hit.advice).toMatch(/\d+\.\d+ m/);
  });

  it('阈值由步道宽度派生：调小可消除该违规（关系传导）', () => {
    const doc = movedDoc();
    expect(generateScene(doc).spatial.issues.some((i) => i.code === CODE)).toBe(true);
    const smaller = applyCommands(doc, [
      { op: 'rule.set', path: 'pipeline.mobility.sidewalkWidth', value: 0.8 },
    ], 'structured').doc;
    const s = generateScene(smaller);
    expect(corridorMinGap(smaller.rules.pipeline)).toBeCloseTo(2.4, 2);
    expect(s.spatial.checks.corridorMinGap).toBeCloseTo(2.4, 2);
    expect(s.spatial.issues.filter((i) => i.code === CODE)).toEqual([]);
    expect(s.spatial.ok).toBe(true);
  });

  it('调大步道宽度提高阈值，不缩小违规判定', () => {
    const doc = applyCommands(movedDoc(), [
      { op: 'rule.set', path: 'pipeline.mobility.sidewalkWidth', value: 3.5 },
    ], 'structured').doc;
    const s = generateScene(doc);
    expect(s.spatial.checks.corridorMinGap).toBeCloseTo(7.8, 2);
    expect(s.spatial.issues.some((i) => i.code === CODE)).toBe(true);
  });

  it('几何工具：平行 / 共享端点 / 线段最短距离', () => {
    const h1 = { a: { x: 0, z: 0 }, b: { x: 10, z: 0 } };
    const h2 = { a: { x: 0, z: 5 }, b: { x: 10, z: 5 } };
    const vert = { a: { x: 0, z: 0 }, b: { x: 0, z: 10 } };
    expect(nearParallel(h1, h2)).toBe(true);
    expect(nearParallel(h1, vert)).toBe(false);
    expect(shareEndpoint(h1, vert)).toBe(true);
    expect(shareEndpoint(h1, h2)).toBe(false);
    expect(segmentDistance(v(0, 0), v(10, 0), v(0, 5), v(10, 5))).toBeCloseTo(5, 6);
  });
});
