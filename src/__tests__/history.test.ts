import { beforeAll, describe, expect, it } from 'vitest';
import { generateScene } from '../core/pcg';
import { serializeScene } from '../core/schema';

type StoreModule = typeof import('../core/store');
let store: StoreModule;
const mem = new Map<string, string>();

beforeAll(async () => {
  const stub = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => { mem.set(k, v); },
    removeItem: (k: string) => { mem.delete(k); },
    clear: () => mem.clear(),
    key: (i: number) => Array.from(mem.keys())[i] ?? null,
    get length() { return mem.size; },
  };
  Object.defineProperty(globalThis, 'localStorage', { value: stub, configurable: true, writable: true });
  store = await import('../core/store');
});

describe('撤销 / 重做 / 保存 / 加载', () => {
  const state = () => store.useAppStore.getState();

  it('撤销精确恢复上一份 SceneDocument，重做再次到达新状态', () => {
    const fp0 = generateScene(state().doc).fingerprint;
    state().execute(
      [{ op: 'density.adjust', zone: 'east', mode: 'relative', delta: -0.3 }],
      { input: '将东侧建筑密度降低 30%', source: 'nl' },
    );
    const fp1 = generateScene(state().doc).fingerprint;
    expect(fp1).not.toBe(fp0);
    expect(state().lastChanges[0].path).toBe('density.zoneMultipliers.east');

    state().undo();
    expect(generateScene(state().doc).fingerprint).toBe(fp0);
    expect(state().doc.rules.density.zoneMultipliers.east).toBe(1);
    state().redo();
    expect(generateScene(state().doc).fingerprint).toBe(fp1);
    expect(state().doc.rules.density.zoneMultipliers.east).toBeCloseTo(0.7, 6);
  });

  it('保存后修改种子，再加载得到与保存时完全一致的生成结果', () => {
    state().save();
    const savedFp = generateScene(state().doc).fingerprint;
    const savedBuildings = JSON.stringify(generateScene(state().doc).buildings);

    state().execute([{ op: 'seed.set', value: 999999 }], { input: '改种子', source: 'inspector' });
    expect(generateScene(state().doc).fingerprint).not.toBe(savedFp);

    state().load();
    expect(state().statusMessage).toContain('一致性校验通过');
    expect(generateScene(state().doc).fingerprint).toBe(savedFp);
    expect(JSON.stringify(generateScene(state().doc).buildings)).toBe(savedBuildings);
  });

  it('命令日志记录输入、来源、规则变化与前后指纹', () => {
    const before = state().commandLog.length;
    state().execute(
      [{ op: 'height.adjust', zone: 'west', mode: 'relative', delta: -0.2 }],
      { input: '西侧建筑高度降低 20%', source: 'nl' },
    );
    const entry = state().commandLog[0];
    expect(state().commandLog.length).toBe(before + 1);
    expect(entry.source).toBe('nl');
    expect(entry.ok).toBe(true);
    expect(entry.fingerprintBefore).not.toBe(entry.fingerprintAfter);
    expect(entry.changes[0].path).toBe('height.zoneMultipliers.west');
  });

  it('导入 JSON 经 schema 校验后替换当前场景', () => {
    const doc = state().doc;
    const modified = structuredClone(doc);
    modified.rules.material.palette = 'warm';
    state().importJSON(serializeScene(modified));
    expect(state().doc.rules.material.palette).toBe('warm');
    expect(state().statusMessage).toContain('已导入');
    state().importJSON('{"schemaVersion":"0.0.1"}');
    expect(state().statusMessage).toContain('导入失败');
  });
});
