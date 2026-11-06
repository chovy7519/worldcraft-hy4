import { describe, expect, it } from 'vitest';
import { applyCommands, validateCommand, validateCommands } from '../core/commands';
import { RULE_FIELDS, llmFieldCatalog } from '../core/fields';
import { createDefaultDocument } from '../core/schema';

describe('受控命令白名单', () => {
  it('拒绝未知 op、任意代码字符串与未注册路径', () => {
    expect(validateCommand({ op: 'mesh.create', code: 'new THREE.Mesh()' }).ok).toBe(false);
    expect(validateCommand({ op: 'rule.set', path: 'terrain.__proto__.polluted', value: 1 }).ok).toBe(false);
    expect(validateCommand({ op: 'rule.set', path: 'density.base', value: '__proto__' }).ok).toBe(false);
    expect(validateCommand(null).ok).toBe(false);
    expect(validateCommands([{ op: 'density.adjust', zone: 'east', mode: 'relative', delta: -0.3 }]).ok).toBe(true);
  });

  it('相对调整是乘法语义，且被夹紧在合法区间', () => {
    const doc = createDefaultDocument(1);
    const r = applyCommands(doc, [
      { op: 'density.adjust', zone: 'east', mode: 'relative', delta: -0.3 },
    ]);
    expect(r.doc.rules.density.zoneMultipliers.east).toBeCloseTo(0.7, 6);
    const r2 = applyCommands(r.doc, [
      { op: 'density.adjust', zone: 'east', mode: 'relative', delta: -0.9 },
    ]);
    expect(r2.doc.rules.density.zoneMultipliers.east).toBeGreaterThanOrEqual(0);
    expect(r.changes[0].scope).toBe('东侧');
  });

  it('非法取值被夹紧且写入变更记录', () => {
    const doc = createDefaultDocument(1);
    const r = applyCommands(doc, [{ op: 'rule.set', path: 'height.max', value: 99999 }]);
    expect(r.doc.rules.height.max).toBe(400);
    expect(r.changes[0].before).toBe(doc.rules.height.max);
    expect(r.changes[0].after).toBe(400);
  });

  it('command 数组上限与空数组都被拒绝', () => {
    expect(validateCommands([]).ok).toBe(false);
    const many = Array.from({ length: 33 }, () => ({ op: 'seed.set', value: 1 }));
    expect(validateCommands(many).ok).toBe(false);
  });

  it('字段注册表无重复路径，且 LLM 工具目录与之一一对应', () => {
    const paths = RULE_FIELDS.map((f) => f.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(llmFieldCatalog().map((f) => f.path)).toEqual(paths);
    for (const f of RULE_FIELDS) {
      if (f.type === 'number') expect(f.max).toBeGreaterThan(f.min!);
    }
  });

  it('applyCommands 为纯函数，不修改入参', () => {
    const doc = createDefaultDocument(7);
    const snapshot = JSON.stringify(doc);
    applyCommands(doc, [{ op: 'density.adjust', zone: 'south', mode: 'relative', delta: -0.5 }]);
    expect(JSON.stringify(doc)).toBe(snapshot);
  });
});
