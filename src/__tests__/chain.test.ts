import { describe, expect, it } from 'vitest';
import { applyCommands } from '../core/commands';
import { generateScene } from '../core/pcg';
import { canonicalize } from '../core/rng';
import { createDefaultDocument, serializeScene } from '../core/schema';
import { LAND_USE_LABELS, type SceneDocument } from '../core/types';

const base = () => createDefaultDocument(20261106);

/** 链路各层快照，用于逐层比对「改了什么、没改什么」 */
function layers(doc: SceneDocument) {
  const s = generateScene(doc);
  return {
    s,
    roads: canonicalize(s.bands),
    blocks: canonicalize(s.blocks),
    parcels: canonicalize(s.parcels),
    uses: canonicalize(s.uses),
    clusters: canonicalize(s.clusters),
    parks: canonicalize(s.parks),
    trees: canonicalize(s.trees),
    water: canonicalize(s.water),
    buildingsNonEast: canonicalize(s.buildings.filter((b) => b.zone !== 'east')),
    buildingsEast: canonicalize(s.buildings.filter((b) => b.zone === 'east')),
  };
}

describe('道路—地块—功能—建筑/公园—树木 全链路', () => {
  it('链路完整：每个建筑都能回溯到地块与功能，每株树都有合法 owner', () => {
    const s = generateScene(base());
    const parcelById = new Map(s.parcels.map((p) => [p.id, p]));
    const useByParcel = new Map(s.uses.map((u) => [u.parcelId, u]));
    const parkById = new Map(s.parks.map((p) => [p.id, p]));
    expect(s.blocks.length).toBeGreaterThan(0);
    expect(s.parcels.length).toBeGreaterThan(s.blocks.length);
    expect(s.uses.length).toBe(s.parcels.length);
    for (const b of s.buildings) {
      const parcel = parcelById.get(b.parcelId)!;
      expect(parcel).toBeDefined();
      expect(parcel.sourceFaceKey).toBeTruthy();
      expect(s.blocks.some((x) => parcel.sourceFaceKey.startsWith(x.id.replace(/^blk\./, '')))).toBe(true);
      const use = useByParcel.get(b.parcelId)!;
      expect(LAND_USE_LABELS[use.use]).toBeDefined();
      expect(['office', 'residential', 'research', 'commercial']).toContain(use.use);
      expect(b.landUse).toBe(use.use);
    }
    for (const park of s.parks) {
      for (const id of park.parcelIds) {
        const use = useByParcel.get(id)!;
        expect(['park', 'plaza']).toContain(use.use);
      }
    }
    for (const t of s.trees) {
      if (t.context === 'park') expect(parkById.has(t.ownerId)).toBe(true);
      else expect(parcelById.has(t.ownerId)).toBe(true);
    }
  });

  it('局部密度编辑：道路/街区/地块/功能/公园/树木/水系全部逐位不变，只有东侧建筑减少', () => {
    const a = layers(base());
    const edited = applyCommands(base(), [
      { op: 'density.adjust', zone: 'east', mode: 'relative', delta: -0.3 },
    ], 'nl').doc;
    const b = layers(edited);
    expect(b.roads).toBe(a.roads);
    expect(b.blocks).toBe(a.blocks);
    expect(b.parcels).toBe(a.parcels);
    expect(b.uses).toBe(a.uses);
    expect(b.clusters).toBe(a.clusters);
    expect(b.parks).toBe(a.parks);
    expect(b.trees).toBe(a.trees);
    expect(b.water).toBe(a.water);
    expect(b.buildingsNonEast).toBe(a.buildingsNonEast);
    expect(b.buildingsEast).not.toBe(a.buildingsEast);
    expect(b.s.stats.byZone.find((z) => z.zone === 'east')!.buildings)
      .toBeLessThan(a.s.stats.byZone.find((z) => z.zone === 'east')!.buildings * 0.85);
  });

  it('每种管线参数只影响其声明阶段及下游，且保持空间校验 PASS', () => {
    const a = layers(base());

    // 道路图是持久化可编辑实体：只改规则不会偷偷重建图（编辑结果不能被参数覆盖）
    const ruleOnly = base();
    ruleOnly.rules.pipeline.roads.arterialPeriod = 1;
    expect(layers(ruleOnly).roads).toBe(a.roads);
    // 显式 graph.regenerate 才会按当前规则重建路网并让下游全部重适配
    const roadDoc = applyCommands(ruleOnly, [{ op: 'graph.regenerate' }], 'structured').doc;
    const r = layers(roadDoc);
    expect(r.roads).not.toBe(a.roads);
    expect(r.s.fingerprint).not.toBe(a.s.fingerprint);
    expect(r.s.spatial.ok).toBe(true);

    const parcelDoc = base();
    parcelDoc.rules.pipeline.parcels.maxSplit = 3;
    const q = layers(parcelDoc);
    expect(q.parcels).not.toBe(a.parcels);
    expect(q.roads).toBe(a.roads);
    expect(q.s.spatial.ok).toBe(true);

    const useDoc = base();
    useDoc.rules.pipeline.landUse.parkRatio = 0.25;
    const u = layers(useDoc);
    expect(u.uses).not.toBe(a.uses);
    expect(u.parks).not.toBe(a.parks);
    expect(u.roads).toBe(a.roads);
    expect(u.parcels).toBe(a.parcels);
    expect(u.s.spatial.ok).toBe(true);

    const treeDoc = base();
    treeDoc.rules.pipeline.trees.streetInterval = 6;
    const t = layers(treeDoc);
    expect(t.trees).not.toBe(a.trees);
    expect(t.buildingsNonEast).toBe(a.buildingsNonEast);
    expect(t.buildingsEast).toBe(a.buildingsEast);
    expect(t.parcels).toBe(a.parcels);
    expect(t.parks).toBe(a.parks);
    expect(t.s.spatial.ok).toBe(true);

    const parkDoc = base();
    parkDoc.rules.pipeline.parks.centralBlocks = 3;
    const pk = layers(parkDoc);
    expect(pk.parks).not.toBe(a.parks);
    expect(pk.s.spatial.ok).toBe(true);
  });

  it('参数经受控命令写入后，diff 时间线可追溯且保存/重载一致', () => {
    const result = applyCommands(base(), [
      { op: 'rule.set', path: 'pipeline.trees.streetInterval', value: 7 },
      { op: 'rule.set', path: 'pipeline.landUse.mixPreset', value: 'green' },
    ], 'structured');
    expect(result.errors).toEqual([]);
    expect(result.changes).toHaveLength(2);
    expect(result.changes[0].path).toBe('pipeline.trees.streetInterval');
    const s1 = generateScene(result.doc);
    const s2 = generateScene(JSON.parse(serializeScene(result.doc)));
    expect(s2.fingerprint).toBe(s1.fingerprint);
    expect(s2.spatial.ok).toBe(true);
  });
});
