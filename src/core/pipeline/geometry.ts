/**
 * 二维空间几何基础 —— 所有阶段共用同一套 AABB 语义。
 * 坐标：X 东西（+东），Z 南北（+南 / -北），单位 m。
 * 约定：矩形闭区间 [minX,maxX]×[minZ,maxZ]，比较统一带 EPS 消除浮点边界误判。
 */
export const EPS = 1e-6;

export interface Rect { minX: number; maxX: number; minZ: number; maxZ: number }

export function rectFromEdges(minX: number, maxX: number, minZ: number, maxZ: number): Rect {
  return { minX, maxX, minZ, maxZ };
}

/** 以中心点 + 尺寸构造 */
export function rectFromCenter(x: number, z: number, w: number, d: number): Rect {
  return { minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2 };
}

export function rectWidth(r: Rect): number { return r.maxX - r.minX; }
export function rectDepth(r: Rect): number { return r.maxZ - r.minZ; }
export function rectArea(r: Rect): number { return Math.max(0, rectWidth(r)) * Math.max(0, rectDepth(r)); }
export function rectCenter(r: Rect): { x: number; z: number } {
  return { x: (r.minX + r.maxX) / 2, z: (r.minZ + r.maxZ) / 2 };
}

/** 正值内缩，负值外扩 */
export function inset(r: Rect, by: number): Rect {
  return { minX: r.minX + by, maxX: r.maxX - by, minZ: r.minZ + by, maxZ: r.maxZ - by };
}

export function unionRect(rects: Rect[]): Rect {
  if (rects.length === 0) return rectFromEdges(0, 0, 0, 0);
  let minX = Infinity; let maxX = -Infinity; let minZ = Infinity; let maxZ = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.minX); maxX = Math.max(maxX, r.maxX);
    minZ = Math.min(minZ, r.minZ); maxZ = Math.max(maxZ, r.maxZ);
  }
  return rectFromEdges(minX, maxX, minZ, maxZ);
}

/** 严格相交（共边不算相交） */
export function intersects(a: Rect, b: Rect, eps = EPS): boolean {
  return a.minX < b.maxX - eps && a.maxX > b.minX + eps
    && a.minZ < b.maxZ - eps && a.maxZ > b.minZ + eps;
}

export function containsRect(outer: Rect, inner: Rect, eps = EPS): boolean {
  return inner.minX >= outer.minX - eps && inner.maxX <= outer.maxX + eps
    && inner.minZ >= outer.minZ - eps && inner.maxZ <= outer.maxZ + eps;
}

export function containsPoint(r: Rect, x: number, z: number, margin = 0): boolean {
  return x >= r.minX + margin && x <= r.maxX - margin
    && z >= r.minZ + margin && z <= r.maxZ - margin;
}

export function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
  const d = Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ);
  return w > 0 && d > 0 ? w * d : 0;
}

/** 点到矩形的最短距离；点在内部时返回 0 */
export function distanceToRect(r: Rect, x: number, z: number): number {
  const dx = Math.max(r.minX - x, 0, x - r.maxX);
  const dz = Math.max(r.minZ - z, 0, z - r.maxZ);
  return Math.hypot(dx, dz);
}

/** 圆是否完全落在矩形内 */
export function circleInRect(r: Rect, cx: number, cz: number, radius: number, eps = EPS): boolean {
  return cx - radius >= r.minX - eps && cx + radius <= r.maxX + eps
    && cz - radius >= r.minZ - eps && cz + radius <= r.maxZ + eps;
}

/**
 * 均匀格网空间索引：用于建筑互不相交、树木最小株距等邻域查询。
 * 桶键按数值排序输出，保证遍历顺序确定。
 */
export class SpatialGrid<T> {
  private readonly buckets = new Map<string, Array<{ id: string; rect: Rect; value: T }>>();
  private readonly size: number;

  constructor(cellSize = 16) { this.size = Math.max(1, cellSize); }

  private key(ix: number, iz: number): string { return `${ix},${iz}`; }
  private range(r: Rect): [number, number, number, number] {
    return [Math.floor(r.minX / this.size), Math.floor(r.maxX / this.size),
      Math.floor(r.minZ / this.size), Math.floor(r.maxZ / this.size)];
  }

  insert(id: string, rect: Rect, value: T): void {
    const [x0, x1, z0, z1] = this.range(rect);
    for (let ix = x0; ix <= x1; ix++) {
      for (let iz = z0; iz <= z1; iz++) {
        const k = this.key(ix, iz);
        let list = this.buckets.get(k);
        if (!list) { list = []; this.buckets.set(k, list); }
        list.push({ id, rect, value });
      }
    }
  }

  /** 返回与查询矩形所在桶相交的候选（去重后按 id 稳定排序） */
  query(rect: Rect): Array<{ id: string; rect: Rect; value: T }> {
    const seen = new Set<string>();
    const out: Array<{ id: string; rect: Rect; value: T }> = [];
    const [x0, x1, z0, z1] = this.range(rect);
    for (let ix = x0; ix <= x1; ix++) {
      for (let iz = z0; iz <= z1; iz++) {
        const list = this.buckets.get(this.key(ix, iz));
        if (!list) continue;
        for (const item of list) {
          if (seen.has(item.id)) continue;
          seen.add(item.id);
          out.push(item);
        }
      }
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  get size_(): number { return this.buckets.size; }
}
