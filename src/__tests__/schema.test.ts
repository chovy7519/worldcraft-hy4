import { describe, expect, it } from 'vitest';
import { documentFingerprint, parseSceneDocument, parseSceneJSON, serializeScene, createDefaultDocument } from '../core/schema';
import { DEFAULT_SEED } from '../core/schema';
import { SCHEMA_VERSION } from '../core/types';
import { generateScene } from '../core/pcg';

describe('Scene Schema 校验与持久化', () => {
  it('默认文档通过校验，版本与种子固定', () => {
    const doc = createDefaultDocument(DEFAULT_SEED);
    expect(doc.schemaVersion).toBe(SCHEMA_VERSION);
    expect(parseSceneDocument(doc).ok).toBe(true);
    expect(doc.rules.terrain.width).toBe(400);
  });

  it('拒绝未知版本、错误种子类型与缺失字段', () => {
    const doc = createDefaultDocument(1) as unknown as Record<string, unknown>;
    expect(parseSceneDocument({ ...doc, schemaVersion: '9.9.9' }).error).toContain('不支持的场景版本');
    expect(parseSceneDocument({ ...doc, seed: 'abc' }).error).toContain('seed');
    const broken = structuredClone(doc) as Record<string, Record<string, unknown>>;
    delete (broken.rules as Record<string, unknown>).material;
    expect(parseSceneDocument(broken).ok).toBe(false);
  });

  it('拒绝注入未注册规则字段与非法对象 ID', () => {
    const doc = createDefaultDocument(1) as unknown as Record<string, unknown>;
    const injected = structuredClone(doc) as Record<string, Record<string, unknown>>;
    (injected.rules.terrain as Record<string, unknown>).evil = 1;
    expect(parseSceneDocument(injected).error).toContain('未注册的规则字段');
    const badOverride = structuredClone(doc);
    badOverride.overrides = { 'javascript:alert(1)': { height: 50 } };
    expect(parseSceneDocument(badOverride).error).toContain('非法对象 ID');
  });

  it('文档指纹忽略名称与时间戳，只反映规则/种子/覆写', () => {
    const a = createDefaultDocument(10);
    const b = { ...structuredClone(a), name: '另一个名字', updatedAt: '2000-01-01T00:00:00.000Z' };
    expect(documentFingerprint(a)).toBe(documentFingerprint(b));
    const c = structuredClone(a);
    c.rules.density.base = 0.3;
    expect(documentFingerprint(c)).not.toBe(documentFingerprint(a));
  });

  it('导入 JSON 后重新生成的几何与指纹一致', () => {
    const doc = createDefaultDocument(31415);
    const text = serializeScene(doc);
    const parsed = parseSceneJSON(text);
    expect(parsed.ok).toBe(true);
    expect(generateScene(parsed.doc!).fingerprint).toBe(generateScene(doc).fingerprint);
    expect(parseSceneJSON('{ not json').error).toContain('JSON 解析失败');
  });
});
