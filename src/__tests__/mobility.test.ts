/**
 * 人流 / 车流契约
 * 重点：确定性可复现、路径受空间关系约束、配额随城市要素变化而传导。
 */
import { describe, expect, it } from 'vitest';
import { positionOnPath, validateMobility } from '../core/mobility';
import { createDefaultDocument } from '../core/schema';
import { generateScene } from '../core/pcg';
import { applyCommands } from '../core/commands';

function sceneWith(commands: Parameters<typeof applyCommands>[1] = []) {
  return generateScene(applyCommands(createDefaultDocument(), commands, 'structured').doc);
}

describe('确定性', () => {
  it('同一 SceneDocument 两次生成得到完全相同的路径与代理', () => {
    const doc = createDefaultDocument();
    const a = generateScene(doc);
    const b = generateScene(doc);
    expect(JSON.stringify(a.mobility?.paths)).toBe(JSON.stringify(b.mobility?.paths));
    expect(JSON.stringify(a.mobility?.agents)).toBe(JSON.stringify(b.mobility?.agents));
    expect(a.fingerprint).toBe(b.fingerprint);
  });

  it('不同 seed 产生不同相位，但配额与路径结构相同', () => {
    const a = generateScene(createDefaultDocument(111));
    const b = generateScene(createDefaultDocument(222));
    expect(a.mobility?.stats.vehicles).toBe(b.mobility?.stats.vehicles);
    expect(a.mobility?.stats.pedestrians).toBe(b.mobility?.stats.pedestrians);
    expect(a.mobility?.agents[0].phase).not.toBe(b.mobility?.agents[0].phase);
  });

  it('配额总数精确等于配置值（最大余数法不丢不重）', () => {
    const s = sceneWith();
    const cfg = createDefaultDocument().rules.pipeline.mobility;
    expect(s.mobility?.stats.vehicles).toBe(cfg.vehicles);
    expect(s.mobility?.stats.pedestrians).toBe(cfg.pedestrians);
    expect(s.mobility?.agents).toHaveLength(cfg.vehicles + cfg.pedestrians);
  });

  it('关闭后不生成任何路径与代理', () => {
    const s = sceneWith([{ op: 'rule.set', path: 'pipeline.mobility.enabled', value: false }]);
    expect(s.mobility?.enabled).toBe(false);
    expect(s.mobility?.paths).toEqual([]);
    expect(s.mobility?.agents).toEqual([]);
  });

  it('positionOnPath 是闭合且连续的：t=0 与 t=1 重合，小步长位移小', () => {
    const s = sceneWith();
    const path = s.mobility!.paths.find((p) => p.kind === 'vehicle')!;
    const p0 = positionOnPath(path, 0);
    const p1 = positionOnPath(path, 1);
    expect(Math.hypot(p0.x - p1.x, p0.z - p1.z)).toBeLessThan(0.01);
    const step = Math.min(0.002, 2 / path.length);
    const q0 = positionOnPath(path, 0.3);
    const q1 = positionOnPath(path, 0.3 + step);
    expect(Math.hypot(q0.x - q1.x, q0.z - q1.z)).toBeLessThan(path.length * step + 1);
  });
});

describe('路径受空间关系契约约束', () => {
  it('默认场景 validateMobility 返回空，且并入统一空间报告后仍 PASS', () => {
    const s = sceneWith();
    expect(validateMobility(s.mobility!, s)).toEqual([]);
    expect(s.spatial.issues.filter((i) => i.code.startsWith('VEHICLE') || i.code.startsWith('PEDESTRIAN'))).toEqual([]);
    expect(s.spatial.ok).toBe(true);
  });

  it('车辆与行人都有合法路径引用，且路径长度非零', () => {
    const s = sceneWith();
    const ids = new Set(s.mobility!.paths.map((p) => p.id));
    expect(s.mobility!.agents.every((a) => ids.has(a.pathId))).toBe(true);
    expect(s.mobility!.paths.every((p) => p.length > 4 && p.points.length >= 2)).toBe(true);
  });

  it('公园比例提高会增加公园环线数量，人流配额重新分配', () => {
    const a = sceneWith();
    const b = sceneWith([{ op: 'rule.set', path: 'pipeline.landUse.parkRatio', value: 0.3 }]);
    expect(b.mobility!.stats.parkLoops).toBeGreaterThan(a.mobility!.stats.parkLoops);
    expect(b.mobility!.stats.pedestrians).toBe(a.mobility!.stats.pedestrians);
    expect(b.spatial.ok).toBe(true);
  });

  it('调宽步道不改变空间校验结论，且路径仍不穿建筑', () => {
    const s = sceneWith([{ op: 'rule.set', path: 'pipeline.mobility.sidewalkWidth', value: 3.5 }]);
    expect(validateMobility(s.mobility!, s).filter((i) => i.code === 'PEDESTRIAN_INSIDE_BUILDING')).toEqual([]);
    expect(s.spatial.ok).toBe(true);
  });

  it('开启水系后行人路径不穿过水面', () => {
    const s = sceneWith([
      { op: 'rule.set', path: 'pipeline.extensions.water', value: true },
      { op: 'rule.set', path: 'pipeline.landUse.waterReserveRatio', value: 0.1 },
    ]);
    expect(s.water.length).toBeGreaterThan(0);
    expect(validateMobility(s.mobility!, s).filter((i) => i.code === 'PEDESTRIAN_IN_WATER')).toEqual([]);
    expect(s.spatial.ok).toBe(true);
  });

  it('车辆数量参数生效且不破坏合法性', () => {
    const s = sceneWith([
      { op: 'rule.set', path: 'pipeline.mobility.vehicles', value: 24 },
      { op: 'rule.set', path: 'pipeline.mobility.pedestrians', value: 40 },
    ]);
    expect(s.mobility?.stats.vehicles).toBe(24);
    expect(s.mobility?.stats.pedestrians).toBe(40);
    expect(validateMobility(s.mobility!, s)).toEqual([]);
  });
});
