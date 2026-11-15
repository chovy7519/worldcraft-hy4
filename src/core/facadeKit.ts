/**
 * 共享模块化构件库 + 按功能装配（kitbash）。
 *
 * 设计约束（对应 docs/ART_DIRECTION.md §4 / §7）：
 *  1. 一套构件原型全城共用，差异只允许出现在 L4 装饰层与内轮廓数量；
 *     L2 窗格对所有功能使用同一 3.2 m 开间 / 3.0 m 层高模数。
 *  2. 所有构件都是 box 原型 + 实例矩阵，渲染层只需 1 个 InstancedMesh；
 *     不生成独立几何、不改 SceneDocument、不进场景指纹。
 *  3. 全部随机走 sample(seed, 盐, 稳定序号)，禁止 Math.random()，
 *     同一 (scene, seed) 永远产出逐位一致的结果。
 *  4. 「不整齐」和朝向由稳定序号决定，保证生活感不破坏确定性。
 */
import { sample } from './rng';
import {
  BUILT_USE_IDS,
  type BuiltUseId, type BuildingObject, type GeneratedScene, type Point2,
} from './types';

export type KitPartId =
  | 'window' | 'balcony' | 'awning' | 'sign' | 'canopy' | 'acUnit'
  | 'planter' | 'bike' | 'bench' | 'stationSign' | 'lamp' | 'vending' | 'noticeBoard';

export type KitLayer = 'L2' | 'L3' | 'L4';
export type AssemblyKind = BuiltUseId | 'transit' | 'leisure';

/** 统一色板（低饱和，点缀色只给招牌 / 标识等生活信息） */
export const KIT_PALETTE = {
  wall: '#F2EDE2',
  frame: '#6B655C',
  outline: '#4A4640',
  glass: '#DCE6E8',
  wood: '#B98A5E',
  tile: '#C87F5C',
  concrete: '#D9D4C8',
  accentRed: '#D9705B',
  accentYellow: '#E8B44A',
  accentBlue: '#4E7E96',
  green: '#7FA86B',
} as const;

/** 日常主题下的建筑功能色；由 sceneTheme 决定，不写入 SceneDocument */
export const EVERYDAY_USE_COLORS: Record<AssemblyKind, string> = {
  residential: '#E8C9A0',
  commercial: '#F0D8C0',
  office: '#DCE6E8',
  research: '#DCE6E8',
  transit: '#DCE3D8',
  leisure: '#D5E4C4',
};

export const EVERYDAY_ROOF_COLORS: Record<AssemblyKind, string> = {
  residential: KIT_PALETTE.tile,
  commercial: KIT_PALETTE.wood,
  office: '#A9B9BC',
  research: '#A9B9BC',
  transit: '#8FA39B',
  leisure: KIT_PALETTE.wood,
};

export interface KitPartSpec {
  id: KitPartId;
  label: string;
  layer: KitLayer;
  /** 默认尺寸 [宽, 高, 厚]（m）；厚度方向贴在立面法向上 */
  size: [number, number, number];
  color: string;
  /** 构件底面离地高度（m） */
  baseY: number;
  note: string;
}

/** 全城共享的构件原型注册表：新增构件只需要在这里加一行 */
export const KIT_PARTS: Record<KitPartId, KitPartSpec> = {
  window: { id: 'window', label: '窗格', layer: 'L2', size: [1.4, 1.6, 0.1], color: KIT_PALETTE.glass, baseY: 0.9, note: '统一模数，所有功能共用' },
  balcony: { id: 'balcony', label: '阳台 / 栏杆', layer: 'L4', size: [2.4, 0.16, 0.85], color: KIT_PALETTE.wall, baseY: 3.1, note: '住宅重复中出现个体变异' },
  awning: { id: 'awning', label: '遮阳棚', layer: 'L4', size: [2.2, 0.12, 0.9], color: KIT_PALETTE.accentRed, baseY: 3.0, note: '商业逐店不同' },
  sign: { id: 'sign', label: '门头招牌', layer: 'L4', size: [1.7, 0.85, 0.14], color: KIT_PALETTE.accentYellow, baseY: 3.3, note: '必须朝路，宽度 ≤ 开间 0.8' },
  canopy: { id: 'canopy', label: '入口雨棚', layer: 'L3', size: [2.8, 0.16, 1.1], color: KIT_PALETTE.concrete, baseY: 3.1, note: '办公 / 交通统一制式' },
  acUnit: { id: 'acUnit', label: '空调外机', layer: 'L4', size: [0.75, 0.6, 0.35], color: KIT_PALETTE.frame, baseY: 2.4, note: '住宅生活痕迹' },
  planter: { id: 'planter', label: '花盆 / 树池', layer: 'L4', size: [0.6, 0.5, 0.6], color: KIT_PALETTE.green, baseY: 0.25, note: '可带一处歪斜' },
  bike: { id: 'bike', label: '自行车', layer: 'L4', size: [1.3, 0.9, 0.35], color: KIT_PALETTE.accentBlue, baseY: 0.45, note: '沿住宅 / 交通节点成组' },
  bench: { id: 'bench', label: '长椅', layer: 'L4', size: [1.6, 0.45, 0.55], color: KIT_PALETTE.wood, baseY: 0.25, note: '休闲空间成组' },
  stationSign: { id: 'stationSign', label: '站牌 / 导向标识', layer: 'L4', size: [0.7, 2.0, 0.16], color: KIT_PALETTE.accentBlue, baseY: 1.0, note: '全线统一制式' },
  lamp: { id: 'lamp', label: '路灯 / 庭院灯', layer: 'L4', size: [0.2, 3.2, 0.2], color: KIT_PALETTE.frame, baseY: 1.6, note: '等距、不变异' },
  vending: { id: 'vending', label: '自动贩卖机', layer: 'L4', size: [1.0, 1.8, 0.7], color: KIT_PALETTE.accentRed, baseY: 0.9, note: '商业沿街' },
  noticeBoard: { id: 'noticeBoard', label: '铭牌 / 公告栏', layer: 'L4', size: [1.1, 1.2, 0.14], color: KIT_PALETTE.wood, baseY: 1.5, note: '办公每栋 1 处' },
};

export const KIT_PART_IDS = Object.keys(KIT_PARTS) as KitPartId[];

export interface AssemblyRule {
  label: string;
  /** 每立面 L4 装饰件数区间（细节密度梯度） */
  detailRange: [number, number];
  parts: KitPartId[];
  /** 个体变异概率：办公 = 0（严格重复），商业最高 */
  variation: number;
  note: string;
}

/**
 * 五类功能 + 研发的装配规则。密度梯度：办公/研发 4–6 ＜ 休闲 5–8 ＜ 交通 6–8
 * ＜ 住宅 8–14 ＜ 商业 14–22。差异只在 L4，L2 窗格全城同模数。
 */
export const ASSEMBLY_RULES: Record<AssemblyKind, AssemblyRule> = {
  office: {
    label: '办公', detailRange: [4, 6], parts: ['canopy', 'lamp', 'noticeBoard'], variation: 0,
    note: '严格重复，不允许个体变异；只有入口铭牌与雨棚',
  },
  research: {
    label: '研发', detailRange: [4, 6], parts: ['canopy', 'lamp', 'noticeBoard'], variation: 0,
    note: '与办公同制式，水平带窗节奏',
  },
  residential: {
    label: '住宅', detailRange: [8, 14], parts: ['balcony', 'acUnit', 'planter', 'bike', 'awning'], variation: 0.35,
    note: '模数重复 + 每层 1–2 处个体变异（晾衣 / 花盆 / 帘色）',
  },
  commercial: {
    label: '商业', detailRange: [14, 22], parts: ['sign', 'awning', 'vending', 'planter', 'noticeBoard', 'canopy'], variation: 0.8,
    note: '逐店不同，招牌朝路；招牌宽度受开间约束',
  },
  transit: {
    label: '交通', detailRange: [6, 8], parts: ['stationSign', 'lamp', 'bench', 'bike', 'noticeBoard'], variation: 0,
    note: '设施实例层挂在路口节点，全线统一制式',
  },
  leisure: {
    label: '休闲', detailRange: [5, 8], parts: ['bench', 'planter', 'lamp', 'noticeBoard'], variation: 0.4,
    note: '设施实例层挂在公园多边形内，手作感、允许不对称',
  },
};

export const ASSEMBLY_KINDS = Object.keys(ASSEMBLY_RULES) as AssemblyKind[];

export interface KitInstance {
  part: KitPartId;
  kind: AssemblyKind;
  layer: KitLayer;
  ownerId: string;
  x: number; y: number; z: number;
  sx: number; sy: number; sz: number;
  rotY: number;
  color: string;
}

export interface KitBuild {
  instances: KitInstance[];
  byPart: Record<KitPartId, number>;
  byKind: Record<AssemblyKind, number>;
  /** 被截断的构件数（超过性能上限时丢弃，保证大场景可控） */
  truncated: number;
  /** L2 窗格数量，用于验证「基底统一」 */
  windowCount: number;
}

const emptyCounts = <K extends string>(keys: K[]): Record<K, number> =>
  Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

interface Frontage {
  a: Point2; b: Point2;
  /** 指向建筑外部的单位法向 */
  nx: number; nz: number;
  length: number;
  /** box 实例绕 Y 的旋转，使局部 X 轴与立面边平行 */
  rotY: number;
}

/** 主立面 = 离最近车行道中心线最近的足迹边；斜向 / 多边形地块同样成立 */
function frontageOf(b: BuildingObject, bands: GeneratedScene['bands']): Frontage | null {
  const fp = b.footprint;
  if (!fp || fp.length < 3) return null;
  let best: Frontage | null = null;
  let bestDist = Infinity;
  for (let i = 0; i < fp.length; i++) {
    const a = fp[i];
    const c = fp[(i + 1) % fp.length];
    const dx = c.x - a.x;
    const dz = c.z - a.z;
    const length = Math.hypot(dx, dz);
    if (length < 2) continue;
    const mx = (a.x + c.x) / 2;
    const mz = (a.z + c.z) / 2;
    let dist = Infinity;
    for (const band of bands) {
      const ex = band.b.x - band.a.x;
      const ez = band.b.z - band.a.z;
      const l2 = ex * ex + ez * ez || 1;
      const t = clamp(((mx - band.a.x) * ex + (mz - band.a.z) * ez) / l2, 0, 1);
      const d = Math.hypot(mx - (band.a.x + ex * t), mz - (band.a.z + ez * t));
      if (d < dist) dist = d;
    }
    if (dist >= bestDist) continue;
    let nx = -dz / length;
    let nz = dx / length;
    if (nx * (mx - b.x) + nz * (mz - b.z) < 0) { nx = -nx; nz = -nz; }
    bestDist = dist;
    best = { a, b: c, nx, nz, length, rotY: Math.atan2(-dz, dx) };
  }
  return best;
}

function pointAlong(f: Frontage, t: number, outward: number): { x: number; z: number } {
  return {
    x: f.a.x + (f.b.x - f.a.x) * t + f.nx * outward,
    z: f.a.z + (f.b.z - f.a.z) * t + f.nz * outward,
  };
}

/**
 * 生成整套构件实例。scene 只读；seed 决定所有「不整齐」与选件。
 * limit 是性能保护（默认 16000 件），超出后停止装配并如实记录截断数。
 */
export function assembleFacadeKit(scene: GeneratedScene, seed: number, limit = 16000): KitBuild {
  const instances: KitInstance[] = [];
  const byPart = emptyCounts(KIT_PART_IDS);
  const byKind = emptyCounts(ASSEMBLY_KINDS);
  let truncated = 0;
  let windowCount = 0;
  const bands = scene.bands.filter((b) => !b.boundary && !b.suppressed);

  const push = (inst: KitInstance): void => {
    if (instances.length >= limit) { truncated++; return; }
    instances.push(inst);
    byPart[inst.part]++;
    byKind[inst.kind]++;
    if (inst.part === 'window') windowCount++;
  };

  const asKind = (use: string): AssemblyKind =>
    (BUILT_USE_IDS as string[]).includes(use) ? use as AssemblyKind : 'office';

  for (const b of scene.buildings) {
    if (!b.visible || b.deleted) continue;
    const f = frontageOf(b, bands);
    if (!f) continue;
    const kind = asKind(b.landUse);
    const rule = ASSEMBLY_RULES[kind];
    const cols = clamp(Math.floor(f.length / 3.2), 2, 6);
    const floors = clamp(Math.floor(b.h / 3.0), 1, 5);

    // L2 结构层：全城共用模数，功能之间无差别
    for (let floor = 0; floor < floors; floor++) {
      for (let col = 0; col < cols; col++) {
        const t = (col + 0.5) / cols;
        const p = pointAlong(f, t, 0.07);
        const spec = KIT_PARTS.window;
        const width = Math.min(spec.size[0], (f.length / cols) * 0.8);
        push({
          part: 'window', kind, layer: 'L2', ownerId: b.id,
          x: p.x, y: spec.baseY + floor * 3.0 + spec.size[1] / 2, z: p.z,
          sx: width, sy: spec.size[1], sz: spec.size[2],
          rotY: f.rotY, color: KIT_PALETTE.glass,
        });
      }
    }

    // L4 装饰层：只有这里允许按功能产生密度与选件差异
    const [lo, hi] = rule.detailRange;
    const count = lo + Math.floor(sample(seed, 'kit-density', b.id) * (hi - lo + 1));
    const bayWidth = f.length / cols;
    for (let i = 0; i < count; i++) {
      const part = rule.parts[Math.floor(sample(seed, 'kit-part', b.id, i) * rule.parts.length) % rule.parts.length];
      const spec = KIT_PARTS[part];
      // 每 2–3 个开间成组：组号决定点缀色，形成「有归属」的沿街节奏
      const group = Math.floor(i / 3);
      const groupTone = Math.floor(sample(seed, 'kit-tone', b.id, group) * 3);
      const accent = [KIT_PALETTE.accentRed, KIT_PALETTE.accentYellow, KIT_PALETTE.accentBlue][groupTone];
      const t = (i + 0.5) / count;
      const uneven = rule.variation > 0 && sample(seed, 'kit-uneven', b.id, i) < rule.variation;
      const jitter = uneven ? (sample(seed, 'kit-jitter', b.id, i) - 0.5) * 0.36 : 0;
      const outward = part === 'balcony' || part === 'awning' || part === 'canopy' ? 0.5
        : part === 'planter' || part === 'bike' || part === 'bench' || part === 'vending' ? 1.1 : 0.16;
      const p = pointAlong(f, t, outward);
      const floorLift = part === 'balcony' || part === 'acUnit'
        ? Math.floor(sample(seed, 'kit-floor', b.id, i) * floors) * 3.0 : 0;
      const width = part === 'sign'
        ? Math.min(spec.size[0], bayWidth * 0.8) : spec.size[0];
      const color = part === 'sign' || part === 'awning' || part === 'vending' ? accent : spec.color;
      push({
        part, kind, layer: spec.layer, ownerId: b.id,
        x: p.x + f.nx * jitter, y: spec.baseY + spec.size[1] / 2 + floorLift, z: p.z + f.nz * jitter,
        sx: width, sy: spec.size[1], sz: spec.size[2],
        rotY: f.rotY + (uneven ? (sample(seed, 'kit-tilt', b.id, i) - 0.5) * 0.09 : 0),
        color,
      });
    }
  }

  // 交通设施：挂在路口节点（项目没有「交通建筑」，见 ART_DIRECTION §7.1 轻量路径）
  const nodes = scene.graphNodes.filter((_, i) => i % 3 === 0);
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const rule = ASSEMBLY_RULES.transit;
    const part = rule.parts[Math.floor(sample(seed, 'kit-transit-part', n.id) * rule.parts.length) % rule.parts.length];
    const spec = KIT_PARTS[part];
    const quadrant = Math.floor(sample(seed, 'kit-transit-side', n.id) * 4);
    const ox = (quadrant % 2 === 0 ? 1 : -1) * 3.4;
    const oz = (quadrant < 2 ? 1 : -1) * 3.4;
    push({
      part, kind: 'transit', layer: 'L4', ownerId: n.id,
      x: n.x + ox, y: spec.baseY + spec.size[1] / 2, z: n.z + oz,
      sx: spec.size[0], sy: spec.size[1], sz: spec.size[2],
      rotY: 0, color: spec.color,
    });
  }

  // 休闲设施：挂在退界后的公园范围内（park.polygon 已由空间契约裁剪）
  const parks = scene.parks.filter((p) => p.polygon && p.polygon.length >= 3);
  for (let i = 0; i < parks.length; i += 2) {
    const park = parks[i];
    const rule = ASSEMBLY_RULES.leisure;
    const [lo, hi] = rule.detailRange;
    const count = Math.min(3, lo + Math.floor(sample(seed, 'kit-leisure-n', park.id) * (hi - lo + 1)) - lo + 1);
    for (let k = 0; k < count; k++) {
      const part = rule.parts[Math.floor(sample(seed, 'kit-leisure-part', park.id, k) * rule.parts.length) % rule.parts.length];
      const spec = KIT_PARTS[part];
      const r = Math.min(park.width, park.depth) * 0.25;
      const px = park.x + (sample(seed, 'kit-leisure-x', park.id, k) - 0.5) * r;
      const pz = park.z + (sample(seed, 'kit-leisure-z', park.id, k) - 0.5) * r;
      push({
        part, kind: 'leisure', layer: 'L4', ownerId: park.id,
        x: px, y: spec.baseY + spec.size[1] / 2, z: pz,
        sx: spec.size[0], sy: spec.size[1], sz: spec.size[2],
        rotY: sample(seed, 'kit-leisure-rot', park.id, k) * Math.PI,
        color: spec.color,
      });
    }
  }

  return { instances, byPart, byKind, truncated, windowCount };
}
