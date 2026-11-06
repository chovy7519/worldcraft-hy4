import { describe, expect, it } from 'vitest';
import { diffDocuments } from '../core/diff';
import { applyCommands } from '../core/commands';
import { createDefaultDocument } from '../core/schema';

describe('规则变化可追溯（含撤销/加载）', () => {
  it('局部编辑只产生一条规则 diff，且作用域标为东侧', () => {
    const base = createDefaultDocument(1);
    const next = applyCommands(base, [
      { op: 'density.adjust', zone: 'east', mode: 'relative', delta: -0.3 },
    ], 'nl').doc;
    const changes = diffDocuments(base, next, 'nl');
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      path: 'density.zoneMultipliers.east', before: 1, after: 0.7, scope: '东侧', source: 'nl',
    });
  });

  it('撤销的 diff 方向相反，可证明规则被还原', () => {
    const base = createDefaultDocument(1);
    const next = applyCommands(base, [
      { op: 'density.adjust', zone: 'east', mode: 'relative', delta: -0.3 },
    ], 'nl').doc;
    const back = diffDocuments(next, base, 'system', '撤销');
    expect(back[0]).toMatchObject({ before: 0.7, after: 1, note: '撤销' });
  });

  it('加载相同文档不产生 diff；修改种子则产生 seed diff', () => {
    const base = createDefaultDocument(1);
    expect(diffDocuments(base, structuredClone(base))).toEqual([]);
    const other = structuredClone(base);
    other.seed = 99;
    const changes = diffDocuments(base, other);
    expect(changes).toHaveLength(1);
    expect(changes[0].path).toBe('seed');
  });

  it('人工覆写变化也进入 diff', () => {
    const base = createDefaultDocument(1);
    const next = applyCommands(base, [
      { op: 'object.override', id: 'bld.3.4', patch: { height: 88 } },
    ], 'inspector').doc;
    const changes = diffDocuments(base, next);
    expect(changes).toHaveLength(1);
    expect(changes[0].path).toBe('bld.3.4');
    expect(changes[0].scope).toBe('单体');
  });
});
