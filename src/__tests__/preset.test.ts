/**
 * 用户默认场景预设（800 × 800 m）的契约。
 *
 * 核心断言：工作台首屏 / 重置生成的场景，必须与用户导出的存档逐位一致。
 * 只抄规则参数会失败 —— 存档里的图是 400 m 默认网格（77 节点）按 800 m
 * 缩放后的持久化图，而 buildGridGraph(800m) 会生成 285 节点的规则网格。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import presetJson from '../data/default-scene.json';
import { applyCommands } from '../core/commands';
import { createPresetDocument, PRESET_NAME } from '../core/preset';
import { createDefaultDocument, defaultRules, parseSceneDocument } from '../core/schema';
import { buildGridGraph } from '../core/geom/defaultGraph';
import { generateScene } from '../core/pcg';
import { assembleFacadeKit } from '../core/facadeKit';

const restored = parseSceneDocument(presetJson).doc!;

describe('用户默认预设 · 打开就这样', () => {
  it('预设是合法存档，且被解析为当前 schema', () => {
    expect(parseSceneDocument(presetJson).ok).toBe(true);
    expect(restored.schemaVersion).toBe('1.3.0');
    expect(restored.name).toBe(PRESET_NAME);
  });

  it('首屏文档与用户存档生成结果逐位一致（含已编辑道路图）', () => {
    const fresh = createPresetDocument();
    expect(fresh.rules).toEqual(restored.rules);
    expect(fresh.graph).toEqual(restored.graph);
    expect(fresh.graph.nodes.length).toBe(77);
    expect(fresh.graph.edges.length).toBe(112);
    expect(generateScene(fresh).fingerprint).toBe(generateScene(restored).fingerprint);
  });

  it('用户调过的 9 处参数全部落到默认里', () => {
    const r = createPresetDocument().rules;
    expect(r.terrain.width).toBe(800);
    expect(r.terrain.depth).toBe(800);
    expect(r.height.base).toBe(20);
    expect(r.height.max).toBe(65);
    expect(r.openSpace.shape).toBe('rect');
    expect(r.pipeline.parks.centralBlocks).toBe(1);
    expect(r.pipeline.trees.minSpacing).toBe(5);
    expect(r.pipeline.mobility.pedestrians).toBe(400);
    expect(r.pipeline.mobility.vehicleSpeed).toBe(12);
  });

  it('预设场景空间校验 PASS，且构件层不截断', () => {
    const doc = createPresetDocument();
    const scene = generateScene(doc);
    expect(scene.spatial.ok, JSON.stringify(scene.spatial.issues.slice(0, 3))).toBe(true);
    expect(scene.flowWarnings ?? []).toEqual([]);
    expect(scene.stats.visibleBuildings).toBeGreaterThan(700);
    const kit = assembleFacadeKit(scene, doc.seed);
    expect(kit.truncated).toBe(0);
    expect(kit.instances.length).toBeGreaterThan(10000);
  });

  it('同一 seed 下重复创建指纹稳定；不同 seed 会改变布局', () => {
    const a = generateScene(createPresetDocument());
    const b = generateScene(createPresetDocument());
    expect(a.fingerprint).toBe(b.fingerprint);
    const c = generateScene(createPresetDocument(20261107));
    expect(c.fingerprint).not.toBe(a.fingerprint);
    expect(c.stats.parcels).toBe(a.stats.parcels);
  });

  it('400 m 工程测试基准保留不变，与用户预设明确区分', () => {
    expect(defaultRules().terrain.width).toBe(400);
    expect(createDefaultDocument().rules.terrain.width).toBe(400);
    expect(generateScene(createDefaultDocument()).fingerprint)
      .not.toBe(generateScene(createPresetDocument()).fingerprint);
  });
});

describe('默认预设 · 命令与入口一致性', () => {
  it('scene.reset 回到预设，而不是 400 m 工程基准', () => {
    const doc = applyCommands(createDefaultDocument(), [{ op: 'scene.reset' }], 'structured').doc;
    expect(doc.rules.terrain.width).toBe(800);
    expect(doc.graph.nodes.length).toBe(77);
    expect(generateScene(doc).fingerprint).toBe(generateScene(restored).fingerprint);
  });

  it('不指定尺寸的 scene.create 使用预设；指定尺寸时同步重建道路图', () => {
    const same = applyCommands(createDefaultDocument(), [{ op: 'scene.create' }], 'structured').doc;
    expect(same.rules.terrain.width).toBe(800);
    expect(same.graph.nodes.length).toBe(77);

    const smaller = applyCommands(createDefaultDocument(), [
      { op: 'scene.create', width: 400, depth: 400 },
    ], 'structured').doc;
    // 400 m 默认网格同样是 77 节点，所以不能用节点数区分；
    // 用「图与规则重建结果逐位一致 + 坐标范围回到 ±200」验证重建确实发生。
    const expected = buildGridGraph(smaller.rules.terrain, smaller.rules.pipeline.roads);
    expect(smaller.graph).toEqual(expected);
    expect(Math.max(...smaller.graph.nodes.map((n) => n.x))).toBe(200);
    expect(Math.max(...createPresetDocument().graph.nodes.map((n) => n.x))).toBe(400);
    expect(generateScene(smaller).spatial.ok).toBe(true);
  });

  it('首屏与重置都指向预设（静态入口检查）', () => {
    const store = readFileSync(resolve(process.cwd(), 'src/core/store.ts'), 'utf8');
    expect(store).toContain('return createPresetDocument();');
    expect(store).toContain('createPresetDocument(s.doc.seed)');
    expect(store).not.toContain('return createDefaultDocument();');
  });
});
