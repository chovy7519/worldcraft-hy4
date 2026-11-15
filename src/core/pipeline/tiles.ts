/**
 * 瓦片索引与视口裁剪（v1.3.0，LOD/分块生成的第一阶段）
 *
 * 实测依据（npm run bench，本机）：
 *   400 m → 116 ms；800 m → 890 ms；1200 m → 1959 ms；2000 m → 6579 ms。
 * 2 km 场地单次全量生成 6.6 s，交互已不可用。同时路网节点数在 1200/2000 m
 * 都停在 289、乔木被 maxTrees=1600 截断 —— 说明当前「扩大场地」实际是放大格子，
 * 而不是提高路网密度；单纯加 LOD 掩盖不了生成侧的线性增长。
 *
 * 本模块提供的是**可复用的分块索引与裁剪层**，不是分块生成器：
 * - 生成侧仍是全量纯函数（确定性契约要求相同 SceneDocument → 相同全部对象）；
 * - 真正按瓦片生成需要把管线拆成「全局拓扑（道路图 + 闭合面）」+「局部几何（逐瓦片）」
 *   两阶段，并处理跨瓦片道路与地块的边界归属，属于下一阶段工程投入。
 *
 * 边界准确性：对象按中心点入桶，查询时按 tileSize 外扩一圈候选瓦片，
 * 再用对象 bounds 与视口做精确相交，因此不会漏掉跨界对象。
 */
import type { Bounds, BuildingObject, GeneratedScene, TreeObject } from '../types';

export const DEFAULT_TILE_SIZE = 200;

export interface TileStats {
  id: string;
  col: number;
  row: number;
  bounds: Bounds;
  buildings: number;
  trees: number;
  parcels: number;
}

export interface TileIndex {
  tileSize: number;
  cols: number;
  rows: number;
  site: Bounds;
  tiles: TileStats[];
  buildingsByTile: Map<string, BuildingObject[]>;
  treesByTile: Map<string, TreeObject[]>;
}

const intersects = (a: Bounds, b: Bounds): boolean =>
  !(a.maxX < b.minX || a.minX > b.maxX || a.maxZ < b.minZ || a.minZ > b.maxZ);

export function tileId(col: number, row: number): string { return `t.${col}.${row}`; }

export function buildTileIndex(
  scene: GeneratedScene,
  tileSize = DEFAULT_TILE_SIZE,
  siteBounds?: Bounds,
): TileIndex {
  const size = Math.max(20, tileSize);
  // 场地以原点为中心（与 normalizeXZ / zoneOf 一致）；优先用调用方给的精确 AABB
  const fallbackSide = scene.stats.siteArea > 0 ? Math.sqrt(scene.stats.siteArea) : 400;
  const site: Bounds = siteBounds ?? {
    minX: -fallbackSide / 2, maxX: fallbackSide / 2,
    minZ: -fallbackSide / 2, maxZ: fallbackSide / 2,
  };
  const cols = Math.max(1, Math.ceil((site.maxX - site.minX) / size));
  const rows = Math.max(1, Math.ceil((site.maxZ - site.minZ) / size));

  const tiles: TileStats[] = [];
  const buildingsByTile = new Map<string, BuildingObject[]>();
  const treesByTile = new Map<string, TreeObject[]>();
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const id = tileId(col, row);
      tiles.push({
        id, col, row,
        bounds: {
          minX: site.minX + col * size, maxX: site.minX + (col + 1) * size,
          minZ: site.minZ + row * size, maxZ: site.minZ + (row + 1) * size,
        },
        buildings: 0, trees: 0, parcels: 0,
      });
      buildingsByTile.set(id, []);
      treesByTile.set(id, []);
    }
  }
  const byId = new Map(tiles.map((t) => [t.id, t]));
  const bucket = (x: number, z: number): string => {
    const col = Math.min(cols - 1, Math.max(0, Math.floor((x - site.minX) / size)));
    const row = Math.min(rows - 1, Math.max(0, Math.floor((z - site.minZ) / size)));
    return tileId(col, row);
  };

  for (const b of scene.buildings) {
    const id = bucket(b.x, b.z);
    buildingsByTile.get(id)!.push(b);
    byId.get(id)!.buildings++;
  }
  for (const t of scene.trees) {
    const id = bucket(t.x, t.z);
    treesByTile.get(id)!.push(t);
    byId.get(id)!.trees++;
  }
  for (const p of scene.parcels) {
    const c = { x: (p.bounds.minX + p.bounds.maxX) / 2, z: (p.bounds.minZ + p.bounds.maxZ) / 2 };
    byId.get(bucket(c.x, c.z))!.parcels++;
  }
  return { tileSize: size, cols, rows, site, tiles, buildingsByTile, treesByTile };
}

/** 与视口 AABB 相交的瓦片；padding 用于外扩候选，避免漏掉跨界对象 */
export function queryTiles(index: TileIndex, view: Bounds, padding = 0): TileStats[] {
  const pad = Math.max(0, padding);
  const probe: Bounds = {
    minX: view.minX - pad, maxX: view.maxX + pad,
    minZ: view.minZ - pad, maxZ: view.maxZ + pad,
  };
  return index.tiles.filter((t) => intersects(t.bounds, probe));
}

export function visibleBuildings(index: TileIndex, view: Bounds): BuildingObject[] {
  const out: BuildingObject[] = [];
  for (const tile of queryTiles(index, view, index.tileSize)) {
    for (const b of index.buildingsByTile.get(tile.id) ?? []) {
      if (intersects(b.bounds, view)) out.push(b);
    }
  }
  return out;
}

export function visibleTrees(index: TileIndex, view: Bounds): TreeObject[] {
  const out: TreeObject[] = [];
  for (const tile of queryTiles(index, view, index.tileSize)) {
    for (const t of index.treesByTile.get(tile.id) ?? []) {
      if (t.x >= view.minX && t.x <= view.maxX && t.z >= view.minZ && t.z <= view.maxZ) out.push(t);
    }
  }
  return out;
}

export interface CullingReport {
  totalBuildings: number;
  visibleBuildings: number;
  totalTrees: number;
  visibleTrees: number;
  candidateTiles: number;
  totalTiles: number;
}

export function cullingReport(index: TileIndex, view: Bounds): CullingReport {
  return {
    totalBuildings: index.tiles.reduce((s, t) => s + t.buildings, 0),
    visibleBuildings: visibleBuildings(index, view).length,
    totalTrees: index.tiles.reduce((s, t) => s + t.trees, 0),
    visibleTrees: visibleTrees(index, view).length,
    candidateTiles: queryTiles(index, view, index.tileSize).length,
    totalTiles: index.tiles.length,
  };
}
