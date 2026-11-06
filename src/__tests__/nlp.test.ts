import { describe, expect, it } from 'vitest';
import { parseNaturalLanguage } from '../core/nlp';
import { validateCommands } from '../core/commands';

describe('中文自然语言 → 受控命令', () => {
  it('验收语句 1：400×400 未来城市 / 中心高外围低 / 中央开放空间', () => {
    const r = parseNaturalLanguage(
      '生成一座 400m × 400m 的未来城市，中央建筑较高，外围建筑较低，保留一片中央公共开放空间。',
      { seed: 20261106 },
    );
    expect(r.confidence).toBeGreaterThan(0.5);
    expect(r.commands[0]).toMatchObject({ op: 'scene.create', width: 400, depth: 400 });
    expect(r.commands.some((c) => c.op === 'rule.set' && c.path === 'height.profile' && c.value === 'centerHigh')).toBe(true);
    expect(r.commands.some((c) => c.op === 'rule.set' && c.path === 'openSpace.enabled' && c.value === true)).toBe(true);
    expect(r.commands.some((c) => c.op === 'rule.set' && c.path === 'material.palette' && c.value === 'future')).toBe(true);
    expect(validateCommands(r.commands).ok).toBe(true);
  });

  it('验收语句 2：东侧密度降低 30%，其他区域不变', () => {
    const r = parseNaturalLanguage('将东侧建筑密度降低 30%，其他区域不变。', { seed: 20261106 });
    expect(r.commands).toHaveLength(1);
    expect(r.commands[0]).toMatchObject({ op: 'density.adjust', zone: 'east', mode: 'relative' });
    expect((r.commands[0] as { delta: number }).delta).toBeCloseTo(-0.3, 6);
    expect(r.matched.join('')).toContain('保持不变');
    expect(validateCommands(r.commands).ok).toBe(true);
  });

  it('支持连续多轮编辑中的「降低东侧建筑高度」', () => {
    const r = parseNaturalLanguage('把东侧建筑高度降低 25%');
    expect(r.commands[0]).toMatchObject({ op: 'height.adjust', zone: 'east', mode: 'relative' });
    expect((r.commands[0] as { delta: number }).delta).toBeCloseTo(-0.25, 6);
  });

  it('识别分区、绝对倍率、种子与视角', () => {
    expect(parseNaturalLanguage('将西侧密度设为 40%').commands[0])
      .toMatchObject({ op: 'density.adjust', zone: 'west', mode: 'absolute', value: 0.4 });
    expect(parseNaturalLanguage('种子改为 12345').commands[0])
      .toMatchObject({ op: 'seed.set', value: 12345 });
    expect(parseNaturalLanguage('切换到东北 35 度视角').commands[0])
      .toMatchObject({ op: 'camera.set', preset: 'ne35' });
  });

  it('识别工作台动作', () => {
    const r = parseNaturalLanguage('撤销上一步并保存');
    expect(r.uiActions).toEqual(['undo', 'save']);
  });

  it('无法识别的意图明确拒绝，不产生任何命令', () => {
    const r = parseNaturalLanguage('给我讲一个关于宇宙起源的笑话');
    expect(r.commands).toHaveLength(0);
    expect(r.uiActions).toHaveLength(0);
    expect(r.confidence).toBe(0);
    expect(r.explanation).toContain('未能识别');
  });
});
