/**
 * v1.3.0 瓦片索引契约：分块数、裁剪正确性、跨界对象不漏、确定性。
 */
import { describe, expect, it } from 'vitest';
import { buildTileIndex, cullingReport, queryTiles, tileId, visibleBuildings, visibleTrees } from '../core/pipeline/tiles';
import { createDefaultDocument } from '../core/schema';
import { generateScene } from '../core/pcg';
import type { Bounds } from '../core/types';

const site: Bounds = { minX: -200, maxX: 200, minZ: -200, maxZ: 200 };
const scene = generateScene(createDefaultDocument());

describe('瓦片划分', () => {
  it('400 m 场地 / 200 m 瓦片 → 2×2，且建筑总数守恒', () => {
    const index = buildTileIndex(scene, 200, site);
    expect(index.cols).toBe(2);
    expect(index.rows).toBe(2);
    expect(index.tiles).toHaveLength(4);
    const sum = index.tiles.reduce((s, t) => s + t.buildings, 0);
    expect(sum).toBe(scene.buildings.length);
    expect(index.tiles.map((t) => t.id)).toContain(tileId(1, 1));
  });

  it('非正方形场地按 X/Z 分别计算行列', () => {
    const index = buildTileIndex(scene, 100, { minX: -200, maxX: 200, minZ: -100, maxZ: 100 });
    expect(index.cols).toBe(4);
    expect(index.rows).toBe(2);
  });

  it('索引构建是确定性的', () => {
    const a = buildTileIndex(scene, 200, site);
    const b = buildTileIndex(scene, 200, site);
    expect(a.tiles).toEqual(b.tiles);
    expect(Array.from(a.buildingsByTile.keys())).toEqual(Array.from(b.buildingsByTile.keys()));
  });
});

describe('视口裁剪', () => {
  it('全视口返回全部建筑与乔木', () => {
    const index = buildTileIndex(scene, 200, site);
    expect(visibleBuildings(index, site)).toHaveLength(scene.buildings.length);
    expect(visibleTrees(index, site)).toHaveLength(scene.trees.length);
    expect(queryTiles(index, site)).toHaveLength(4);
  });

  it('小视口返回严格子集，且所有返回对象落在视口内', () => {
    const index = buildTileIndex(scene, 100, site);
    const view: Bounds = { minX: -60, maxX: 60, minZ: -60, maxZ: 60 };
    const buildings = visibleBuildings(index, view);
    const trees = visibleTrees(index, view);
    expect(buildings.length).toBeGreaterThan(0);
    expect(buildings.length).toBeLessThan(scene.buildings.length);
    // 裁剪按 bounds 与视口相交判定（跨界对象也应保留），不是按中心点
    expect(buildings.every((b) =>
      !(b.bounds.maxX < view.minX || b.bounds.minX > view.maxX
        || b.bounds.maxZ < view.minZ || b.bounds.minZ > view.maxZ))).toBe(true);
    expect(trees.every((t) => t.x >= view.minX && t.x <= view.maxX && t.z >= view.minZ && t.z <= view.maxZ)).toBe(true);
  });

  it('外扩候选瓦片保证跨界对象不漏：与暴力全量过滤结果一致', () => {
    const index = buildTileIndex(scene, 80, site);
    const view: Bounds = { minX: -37, maxX: 41, minZ: -55, maxZ: 12 };
    const brute = scene.buildings.filter((b) =>
      !(b.bounds.maxX < view.minX || b.bounds.minX > view.maxX
        || b.bounds.maxZ < view.minZ || b.bounds.minZ > view.maxZ));
    expect(visibleBuildings(index, view).map((b) => b.id).sort())
      .toEqual(brute.map((b) => b.id).sort());
  });

  it('cullingReport 给出可见比例，供 LOD 决策', () => {
    const index = buildTileIndex(scene, 100, site);
    const report = cullingReport(index, { minX: -50, maxX: 50, minZ: -50, maxZ: 50 });
    expect(report.totalBuildings).toBe(scene.buildings.length);
    expect(report.visibleBuildings).toBeLessThan(report.totalBuildings);
    expect(report.candidateTiles).toBeLessThanOrEqual(report.totalTiles);
  });
});
