import { describe, expect, it } from 'vitest';
import { generateScene } from '../core/pcg';
import { createDefaultDocument } from '../core/schema';
import {
  ASSEMBLY_KINDS, ASSEMBLY_RULES, KIT_PART_IDS, KIT_PARTS,
  assembleFacadeKit,
} from '../core/facadeKit';

const scene = generateScene(createDefaultDocument());
const seed = 20261106;

describe('共享模块化构件库 · 注册表', () => {
  it('构件目录与原型表一一对应，每个原型都有合法层与尺寸', () => {
    expect(KIT_PART_IDS.length).toBeGreaterThanOrEqual(12);
    for (const id of KIT_PART_IDS) {
      const spec = KIT_PARTS[id];
      expect(spec.id).toBe(id);
      expect(['L2', 'L3', 'L4']).toContain(spec.layer);
      expect(spec.size.every((n) => Number.isFinite(n) && n > 0)).toBe(true);
      expect(/^#[0-9a-fA-F]{6}$/.test(spec.color)).toBe(true);
    }
  });

  it('细节密度梯度严格递增：办公/研发 < 休闲 < 交通 < 住宅 < 商业', () => {
    const maxOf = (k: (typeof ASSEMBLY_KINDS)[number]) => ASSEMBLY_RULES[k].detailRange[1];
    expect(maxOf('office')).toBeLessThanOrEqual(maxOf('leisure'));
    expect(maxOf('research')).toBeLessThanOrEqual(maxOf('leisure'));
    expect(maxOf('leisure')).toBeLessThanOrEqual(maxOf('transit'));
    expect(maxOf('transit')).toBeLessThanOrEqual(maxOf('residential'));
    expect(maxOf('residential')).toBeLessThanOrEqual(maxOf('commercial'));
    expect(ASSEMBLY_RULES.office.variation).toBe(0);
    expect(ASSEMBLY_RULES.commercial.variation).toBeGreaterThan(0.5);
  });

  it('L2 窗格是全城共用模数，且不出现在任何功能的 L4 选件表里', () => {
    expect(KIT_PARTS.window.layer).toBe('L2');
    for (const kind of ASSEMBLY_KINDS) {
      expect(ASSEMBLY_RULES[kind].parts).not.toContain('window');
    }
  });
});

describe('共享模块化构件库 · 装配', () => {
  it('同一 (scene, seed) 产出逐位一致，无 Math.random', () => {
    const a = assembleFacadeKit(scene, seed);
    const b = assembleFacadeKit(scene, seed);
    expect(a.instances).toEqual(b.instances);
    expect(a.byPart).toEqual(b.byPart);
    expect(a.truncated).toBe(0);
  });

  it('装配是纯派生：不修改场景对象，也不改变指纹', () => {
    const before = JSON.stringify({ b: scene.buildings.length, f: scene.fingerprint, s: scene.spatial.ok });
    assembleFacadeKit(scene, seed);
    const after = JSON.stringify({ b: scene.buildings.length, f: scene.fingerprint, s: scene.spatial.ok });
    expect(after).toBe(before);
  });

  it('产出窗格、装饰、交通与休闲设施，且全部实例坐标有限、颜色合法', () => {
    const kit = assembleFacadeKit(scene, seed);
    expect(kit.windowCount).toBeGreaterThan(0);
    expect(kit.byPart.window).toBe(kit.windowCount);
    expect(kit.byKind.transit).toBeGreaterThan(0);
    expect(kit.byKind.leisure).toBeGreaterThan(0);
    expect(kit.instances.length).toBe(
      KIT_PART_IDS.reduce((s, p) => s + kit.byPart[p], 0),
    );
    for (const inst of kit.instances) {
      expect(Number.isFinite(inst.x) && Number.isFinite(inst.y) && Number.isFinite(inst.z)).toBe(true);
      expect(inst.sx > 0 && inst.sy > 0 && inst.sz > 0).toBe(true);
      expect(Number.isFinite(inst.rotY)).toBe(true);
      expect(/^#[0-9a-fA-F]{6}$/.test(inst.color)).toBe(true);
      expect(KIT_PARTS[inst.part]).toBeDefined();
    }
  });

  it('按功能装配：把可建功能全改为商业后，招牌数量上升', () => {
    const base = assembleFacadeKit(scene, seed);
    const commercialScene = {
      ...scene,
      buildings: scene.buildings.map((b) => ({ ...b, landUse: 'commercial' as const })),
    };
    const after = assembleFacadeKit(commercialScene, seed);
    expect(after.byPart.sign).toBeGreaterThan(base.byPart.sign);
    expect(after.byKind.commercial).toBeGreaterThan(base.byKind.commercial);
  });

  it('性能上限生效：超出如实记录截断数，不静默丢件', () => {
    const kit = assembleFacadeKit(scene, seed, 120);
    expect(kit.instances.length).toBeLessThanOrEqual(120);
    expect(kit.truncated).toBeGreaterThan(0);
    expect(kit.byPart.window).toBe(kit.windowCount);
    expect(kit.instances.length).toBe(KIT_PART_IDS.reduce((s, p) => s + kit.byPart[p], 0));
  });

  it('不同 seed 会改变生活物件的选择，但窗格模数不变', () => {
    const a = assembleFacadeKit(scene, seed);
    const b = assembleFacadeKit(scene, seed + 1);
    expect(a.windowCount).toBe(b.windowCount);
    expect(a.instances.some((x, i) => b.instances[i] && x.part !== b.instances[i].part)).toBe(true);
  });
});
