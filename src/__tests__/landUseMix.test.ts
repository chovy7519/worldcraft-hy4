import { describe, expect, it } from 'vitest';
import { generateScene } from '../core/pcg';
import { applyCommands } from '../core/commands';
import { MIX_WEIGHTS } from '../core/pipeline';
import { mixPercentages, normalizeLandUseMix, resolveMixWeights } from '../core/landUseMix';
import { createDefaultDocument, defaultPipelineRules, parseSceneDocument } from '../core/schema';
import { BUILT_USE_IDS, DEFAULT_LAND_USE_MIX, type LandUseMix, type SceneDocument } from '../core/types';

const sum = (mix: LandUseMix): number => BUILT_USE_IDS.reduce((s, k) => s + mix[k], 0);
const countsOf = (doc: SceneDocument) => generateScene(doc).stats.landUseCounts;

describe('功能占比 · 归一化口径', () => {
  it('权重自动归一化，无需凑满 1', () => {
    const mix = normalizeLandUseMix({ office: 3, residential: 1, research: 0, commercial: 0 });
    expect(sum(mix)).toBeCloseTo(1, 10);
    expect(mix.office).toBeCloseTo(0.75, 10);
    expect(mix.residential).toBeCloseTo(0.25, 10);
  });

  it('全零 / 负数 / NaN 一律回退到内置均衡配比，不让抽样除以 0', () => {
    for (const bad of [
      { office: 0, residential: 0, research: 0, commercial: 0 },
      { office: -2, residential: Number.NaN, research: 0, commercial: -1 },
      undefined,
      {},
    ]) {
      expect(normalizeLandUseMix(bad)).toEqual(DEFAULT_LAND_USE_MIX);
    }
  });

  it('百分比展示与生成口径同源，四项之和为 100', () => {
    const p = mixPercentages({ office: 1, residential: 1, research: 1, commercial: 1 });
    expect(BUILT_USE_IDS.reduce((s, k) => s + p[k], 0)).toBe(100);
    expect(p.office).toBe(25);
  });

  it('preset 模式仍走内置权重表；custom 模式只用用户权重', () => {
    const lu = defaultPipelineRules().landUse;
    expect(resolveMixWeights(lu, MIX_WEIGHTS)).toEqual(DEFAULT_LAND_USE_MIX);
    const officePreset = resolveMixWeights({ ...lu, mixPreset: 'office' }, MIX_WEIGHTS);
    expect(officePreset.office).toBeGreaterThan(officePreset.residential);
    const custom = resolveMixWeights({
      ...lu, mixPreset: 'office', mixMode: 'custom',
      mix: { office: 0, residential: 1, research: 0, commercial: 0 },
    }, MIX_WEIGHTS);
    expect(custom.residential).toBe(1);
    expect(custom.office).toBe(0);
  });
});

describe('功能占比 · 生成阶段传导', () => {
  it('默认 preset 与「显式 custom + 同一权重」产出逐位一致的地块功能', () => {
    const base = createDefaultDocument();
    const custom: SceneDocument = {
      ...base,
      rules: {
        ...base.rules,
        pipeline: {
          ...base.rules.pipeline,
          landUse: { ...base.rules.pipeline.landUse, mixMode: 'custom', mix: { ...DEFAULT_LAND_USE_MIX } },
        },
      },
    };
    expect(countsOf(custom)).toEqual(countsOf(base));
  });

  it('住宅权重提高后住宅地块显著增加，且其他空间不变量保持 PASS', () => {
    const base = createDefaultDocument();
    const doc = applyCommands(base, [
      { op: 'rule.set', path: 'pipeline.landUse.mixMode', value: 'custom' },
      { op: 'rule.set', path: 'pipeline.landUse.mix.residential', value: 0.85 },
      { op: 'rule.set', path: 'pipeline.landUse.mix.commercial', value: 0.05 },
      { op: 'rule.set', path: 'pipeline.landUse.mix.office', value: 0.05 },
      { op: 'rule.set', path: 'pipeline.landUse.mix.research', value: 0.05 },
    ], 'structured').doc;
    const before = countsOf(base);
    const after = generateScene(doc);
    expect(after.stats.landUseCounts.residential).toBeGreaterThan(before.residential);
    expect(after.stats.landUseCounts.residential).toBeGreaterThan(after.stats.landUseCounts.office);
    expect(after.spatial.ok, JSON.stringify(after.spatial.issues.slice(0, 3))).toBe(true);
  });

  it('商业主导时商业为四类之首；改占比不改变几何与指纹以外的守恒量', () => {
    const base = createDefaultDocument();
    const doc = applyCommands(base, [
      { op: 'rule.set', path: 'pipeline.landUse.mixMode', value: 'custom' },
      { op: 'rule.set', path: 'pipeline.landUse.mix.commercial', value: 0.9 },
      { op: 'rule.set', path: 'pipeline.landUse.mix.residential', value: 0.04 },
      { op: 'rule.set', path: 'pipeline.landUse.mix.office', value: 0.03 },
      { op: 'rule.set', path: 'pipeline.landUse.mix.research', value: 0.03 },
    ], 'structured').doc;
    const s = generateScene(doc);
    const built = BUILT_USE_IDS.map((k) => s.stats.landUseCounts[k]);
    expect(Math.max(...built)).toBe(s.stats.landUseCounts.commercial);
    expect(s.stats.faceArea).toBe(s.stats.siteArea);
    expect(s.spatial.ok, JSON.stringify(s.spatial.issues.slice(0, 3))).toBe(true);
  });

  it('同一文档重复生成结果一致（占比走稳定哈希，无 Math.random）', () => {
    const doc = applyCommands(createDefaultDocument(), [
      { op: 'rule.set', path: 'pipeline.landUse.mixMode', value: 'custom' },
      { op: 'rule.set', path: 'pipeline.landUse.mix.residential', value: 0.5 },
      { op: 'rule.set', path: 'pipeline.landUse.mix.commercial', value: 0.3 },
      { op: 'rule.set', path: 'pipeline.landUse.mix.office', value: 0.1 },
      { op: 'rule.set', path: 'pipeline.landUse.mix.research', value: 0.1 },
    ], 'structured').doc;
    expect(generateScene(doc).fingerprint).toBe(generateScene(doc).fingerprint);
    expect(countsOf(doc)).toEqual(countsOf(doc));
  });

  it('切回 preset 后，自定义权重保留但不生效', () => {
    const custom = applyCommands(createDefaultDocument(), [
      { op: 'rule.set', path: 'pipeline.landUse.mixMode', value: 'custom' },
      { op: 'rule.set', path: 'pipeline.landUse.mix.commercial', value: 0.9 },
    ], 'structured').doc;
    const back = applyCommands(custom, [
      { op: 'rule.set', path: 'pipeline.landUse.mixMode', value: 'preset' },
    ], 'structured').doc;
    expect(back.rules.pipeline.landUse.mix.commercial).toBe(0.9);
    expect(countsOf(back)).toEqual(countsOf(createDefaultDocument()));
  });
});

describe('功能占比 · 命令与存档边界', () => {
  it('五个新路径全部在命令白名单内，未注册功能项被拒绝', () => {
    const ok = applyCommands(createDefaultDocument(), [
      { op: 'rule.set', path: 'pipeline.landUse.mixMode', value: 'custom' },
      { op: 'rule.set', path: 'pipeline.landUse.mix.residential', value: 0.4 },
      { op: 'rule.set', path: 'pipeline.landUse.mix.commercial', value: 0.3 },
      { op: 'rule.set', path: 'pipeline.landUse.mix.office', value: 0.2 },
      { op: 'rule.set', path: 'pipeline.landUse.mix.research', value: 0.1 },
    ], 'structured');
    expect(ok.errors).toEqual([]);
    expect(ok.doc.rules.pipeline.landUse.mixMode).toBe('custom');

    const bad = applyCommands(createDefaultDocument(), [
      { op: 'rule.set', path: 'pipeline.landUse.mix.park', value: 0.5 } as never,
    ], 'structured');
    expect(bad.errors.length).toBeGreaterThan(0);
  });

  it('旧存档缺 mixMode / mix 时自动补默认，生成结果不漂移', () => {
    const doc = createDefaultDocument() as unknown as Record<string, unknown>;
    const rules = doc.rules as Record<string, unknown>;
    const pipeline = rules.pipeline as Record<string, unknown>;
    const landUse = pipeline.landUse as Record<string, unknown>;
    delete landUse.mixMode;
    delete landUse.mix;
    const parsed = parseSceneDocument(doc);
    expect(parsed.ok).toBe(true);
    expect(parsed.doc!.rules.pipeline.landUse.mixMode).toBe('preset');
    expect(parsed.doc!.rules.pipeline.landUse.mix).toEqual(DEFAULT_LAND_USE_MIX);
    expect(countsOf(parsed.doc!)).toEqual(countsOf(createDefaultDocument()));
  });

  it('未注册的功能占比项与非数值被存档校验拒绝', () => {
    const base = createDefaultDocument() as unknown as Record<string, unknown>;
    const withExtra = structuredClone(base);
    const lu = ((withExtra.rules as Record<string, unknown>).pipeline as Record<string, unknown>).landUse as Record<string, unknown>;
    lu.mix = { ...DEFAULT_LAND_USE_MIX, themePark: 0.5 };
    expect(parseSceneDocument(withExtra).error).toContain('未注册的功能占比项');

    const withBad = structuredClone(base);
    const lu2 = ((withBad.rules as Record<string, unknown>).pipeline as Record<string, unknown>).landUse as Record<string, unknown>;
    lu2.mix = { ...DEFAULT_LAND_USE_MIX, office: 'many' };
    expect(parseSceneDocument(withBad).ok).toBe(false);
  });
});
