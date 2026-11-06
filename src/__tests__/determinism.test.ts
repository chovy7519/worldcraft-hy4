import { describe, expect, it } from 'vitest';
import { createDefaultDocument, parseSceneJSON, serializeScene } from '../core/schema';
import { generateScene } from '../core/pcg';
import { canonicalize, sample } from '../core/rng';
import { applyCommands } from '../core/commands';
import { DEFAULT_SEED } from '../core/schema';

describe('PCG 确定性契约', () => {
  it('同一 SceneDocument 重复生成 20 次，指纹与全部对象逐位一致', () => {
    const doc = createDefaultDocument(424242);
    const baseline = generateScene(doc);
    for (let i = 0; i < 20; i++) {
      const s = generateScene(doc);
      expect(s.fingerprint).toBe(baseline.fingerprint);
      expect(canonicalize(s.buildings)).toBe(canonicalize(baseline.buildings));
    }
  });

  it('序列化往返（保存 → 加载 → 重新生成）得到相同指纹', () => {
    const doc = createDefaultDocument(987654);
    const before = generateScene(doc);
    const parsed = parseSceneJSON(serializeScene(doc));
    expect(parsed.ok).toBe(true);
    const after = generateScene(parsed.doc!);
    expect(after.fingerprint).toBe(before.fingerprint);
    expect(canonicalize(after.buildings)).toBe(canonicalize(before.buildings));
  });

  it('不同种子产生不同布局，但对象 ID 集合仍由网格决定', () => {
    const a = generateScene(createDefaultDocument(1));
    const b = generateScene(createDefaultDocument(2));
    expect(a.fingerprint).not.toBe(b.fingerprint);
    const roadA = a.roads.map((r) => r.id);
    expect(b.roads.map((r) => r.id)).toEqual(roadA);
  });

  it('按坐标+属性盐的采样与调用顺序无关', () => {
    const seed = DEFAULT_SEED;
    const seq = [sample(seed, 'occupy', 31, 18), sample(seed, 'height', 31, 18), sample(seed, 'occupy', 2, 2)];
    const reversed = [sample(seed, 'occupy', 2, 2), sample(seed, 'occupy', 31, 18), sample(seed, 'height', 31, 18)];
    expect(sample(seed, 'occupy', 31, 18)).toBe(seq[0]);
    expect(sample(seed, 'occupy', 2, 2)).toBe(reversed[0]);
    expect(sample(seed, 'occupy', 2, 2)).toBe(seq[2]);
    expect(sample(seed, 'occupy', 31, 18)).not.toBe(sample(seed, 'occupy', 31, 19));
  });

  it('人工覆写只影响目标对象，其余建筑逐位不变', () => {
    const doc = createDefaultDocument(555);
    const s0 = generateScene(doc);
    const id = s0.buildings[10].id;
    const r1 = applyCommands(doc, [{ op: 'object.override', id, patch: { height: 99 } }], 'inspector');
    const s1 = generateScene(r1.doc);
    expect(s1.buildings.find((b) => b.id === id)!.h).toBe(99);
    expect(canonicalize(s1.buildings.filter((b) => b.id !== id)))
      .toBe(canonicalize(s0.buildings.filter((b) => b.id !== id)));
  });
});
