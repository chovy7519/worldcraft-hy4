/**
 * v1.3.0 多边形布尔运算契约
 * 关键：快速路径（共边）与布尔兜底（重叠 / 端点不匹配）都不能产出非法地块。
 */
import { describe, expect, it } from 'vitest';
import {
  insetPolygon, intersectionPolygons, mergePolygonsRobust, subtractPolygons, unionPolygons,
} from '../core/geom/boolean';
import { isSimple, mergePolygons, polygonArea, v, type Polygon } from '../core/geom/polygon';

const rect = (x0: number, z0: number, x1: number, z1: number): Polygon => [
  v(x0, z0), v(x1, z0), v(x1, z1), v(x0, z1),
];

describe('布尔并集', () => {
  it('共边矩形：面积守恒、外环唯一、简单多边形', () => {
    const result = unionPolygons([rect(0, 0, 10, 10), rect(10, 0, 20, 10)]);
    expect(result.rejected).toEqual([]);
    expect(result.polygons).toHaveLength(1);
    expect(polygonArea(result.polygons[0])).toBeCloseTo(200, 4);
    expect(isSimple(result.polygons[0])).toBe(true);
  });

  it('长边与短边端点不匹配（v1.2.0 会失败的场景）由布尔兜底接管', () => {
    const a = rect(0, 0, 10, 10);
    const b = rect(10, 3, 20, 7);
    expect(mergePolygons(a, b)).toBeNull(); // 旧共边快速路径确实失败
    const merged = mergePolygonsRobust(a, b);
    expect(merged.polygon).not.toBeNull();
    expect(isSimple(merged.polygon!)).toBe(true);
    expect(polygonArea(merged.polygon!)).toBeCloseTo(140, 3);
  });

  it('部分重叠：并集面积 = A + B - 交集，不重复计数', () => {
    const a = rect(0, 0, 10, 10);
    const b = rect(5, 5, 15, 15);
    const merged = mergePolygonsRobust(a, b);
    expect(merged.polygon).not.toBeNull();
    expect(polygonArea(merged.polygon!)).toBeCloseTo(175, 3);
  });

  it('完全分离的两块：并集产生 2 个外环，稳健合并拒绝', () => {
    const result = unionPolygons([rect(0, 0, 10, 10), rect(50, 50, 60, 60)]);
    expect(result.polygons).toHaveLength(2);
    const merged = mergePolygonsRobust(rect(0, 0, 10, 10), rect(50, 50, 60, 60));
    expect(merged.polygon).toBeNull();
    expect(merged.reason).toContain('不连通');
  });

  it('退化输入不抛异常：布尔库容错时产出可用外环，否则给出可读原因', () => {
    const result = unionPolygons([rect(0, 0, 0, 0), rect(0, 0, 10, 10)]);
    expect(Array.isArray(result.polygons)).toBe(true);
    // polygon-clipping 会静默丢弃退化环，这是可接受的；关键是绝不把非简单环放回管线
    expect(result.polygons.every((p) => isSimple(p))).toBe(true);
  });
});

describe('交集、差集与带洞结果', () => {
  it('交集面积正确', () => {
    const r = intersectionPolygons(rect(0, 0, 10, 10), rect(5, 0, 15, 10));
    expect(r.polygons).toHaveLength(1);
    expect(polygonArea(r.polygons[0])).toBeCloseTo(50, 3);
  });

  it('差集产生内环时被明确拒绝，绝不生成带洞地块', () => {
    const r = subtractPolygons(rect(0, 0, 30, 30), rect(10, 10, 20, 20));
    expect(r.holeCount).toBe(1);
    expect(r.polygons).toHaveLength(0);
    expect(r.rejected.join()).toContain('内环');
  });
});

describe('多边形内缩（岸线退界）', () => {
  it('凸多边形内缩 d 后面积收缩且仍为简单多边形', () => {
    const p = rect(0, 0, 20, 20);
    const inner = insetPolygon(p, 3);
    expect(inner).not.toBeNull();
    expect(polygonArea(inner!)).toBeCloseTo(196, 3); // 14 × 14
    expect(isSimple(inner!)).toBe(true);
  });

  it('d <= 0 时返回原多边形副本', () => {
    const p = rect(0, 0, 20, 20);
    const inner = insetPolygon(p, 0);
    expect(inner).toEqual(p);
    expect(inner).not.toBe(p);
  });

  it('内缩量超过多边形尺度时返回 null（保守回退），不产生越界桥接', () => {
    expect(insetPolygon(rect(0, 0, 2, 2), 5)).toBeNull();
  });

  it('凹多边形内缩：要么合法收缩，要么明确失败', () => {
    const concave: Polygon = [
      v(0, 0), v(20, 0), v(20, 20), v(12, 20), v(12, 8), v(0, 8),
    ];
    const inner = insetPolygon(concave, 1.5);
    if (inner) {
      expect(isSimple(inner)).toBe(true);
      expect(polygonArea(inner)).toBeLessThan(polygonArea(concave));
    } else {
      expect(inner).toBeNull();
    }
  });
});
