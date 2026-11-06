import { describe, expect, it } from 'vitest';
import { zoneOf, inOpenSpace } from '../core/zones';
import { createDefaultDocument } from '../core/schema';
import { ZONE_IDS } from '../core/types';

describe('分区与开放空间几何', () => {
  it('五个分区互斥且完备：任意归一化坐标只落入一个分区', () => {
    for (let i = -20; i <= 20; i++) {
      for (let j = -20; j <= 20; j++) {
        const nx = i / 20;
        const nz = j / 20;
        const z = zoneOf(nx, nz);
        expect(ZONE_IDS).toContain(z);
      }
    }
    expect(zoneOf(0, 0)).toBe('core');
    expect(zoneOf(0.9, 0)).toBe('east');
    expect(zoneOf(-0.9, 0)).toBe('west');
    expect(zoneOf(0, -0.9)).toBe('north');
    expect(zoneOf(0, 0.9)).toBe('south');
    expect(zoneOf(0.8, -0.9)).toBe('north'); // 轴主导，东北角归北不归东
  });

  it('东/西、南/北镜像对称', () => {
    expect(zoneOf(0.7, 0.2)).toBe('east');
    expect(zoneOf(-0.7, 0.2)).toBe('west');
    expect(zoneOf(0.2, 0.7)).toBe('south');
    expect(zoneOf(0.2, -0.7)).toBe('north');
  });

  it('开放空间排除区按形状生效', () => {
    const rules = createDefaultDocument().rules.openSpace;
    expect(inOpenSpace(0, 0, rules)).toBe(true);
    expect(inOpenSpace(rules.radius + 10, 0, rules)).toBe(false);
    const rect = { ...rules, shape: 'rect' as const, width: 100, depth: 60 };
    expect(inOpenSpace(40, 20, rect)).toBe(true);
    expect(inOpenSpace(60, 20, rect)).toBe(false);
  });
});
