/**
 * 规则字段注册表 —— 单一事实来源（Single Source of Truth）
 *
 * 同一份声明同时驱动：
 *   1. PCG Inspector 的控件生成（标签 / 单位 / 范围 / 枚举）
 *   2. 命令层 rule.set 的路径白名单与取值校验
 *   3. 可选 LLM 适配器的工具 JSON Schema（LLM 只能看到这些字段）
 *
 * 因此 LLM 或自然语言无法写入任意字段、无法注入任意三维代码。
 */
import { ZONE_IDS, ZONE_LABELS, type SceneRules } from './types';

export type FieldType = 'number' | 'enum' | 'boolean';

export interface RuleField {
  path: string;
  label: string;
  group: string;
  type: FieldType;
  description: string;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  options?: Array<{ value: string; label: string }>;
  advanced?: boolean;
}

const numberField = (
  path: string, label: string, group: string, min: number, max: number, step: number,
  description: string, unit = '', advanced = false,
): RuleField => ({ path, label, group, type: 'number', min, max, step, unit, description, advanced });

const enumField = (
  path: string, label: string, group: string,
  options: Array<{ value: string; label: string }>, description: string, advanced = false,
): RuleField => ({ path, label, group, type: 'enum', options, description, advanced });

export const RULE_FIELDS: RuleField[] = [
  numberField('terrain.width', '场地宽度', '地形与路网', 80, 1200, 20, '场地东西向总尺寸', 'm'),
  numberField('terrain.depth', '场地进深', '地形与路网', 80, 1200, 20, '场地南北向总尺寸', 'm'),
  numberField('terrain.cellSize', '地块网格', '地形与路网', 4, 24, 1, '单个可建地块的边长', 'm', true),
  numberField('terrain.blockPeriod', '街区间隔', '地形与路网', 3, 16, 1, '每隔多少格出现一条街道', '格', true),
  numberField('terrain.streetWidth', '街道宽度', '地形与路网', 3, 20, 1, '街道带视觉宽度', 'm', true),

  numberField('height.base', '外围基准高度', '建筑高度', 6, 120, 2, '外围区域的最低建筑高度', 'm'),
  numberField('height.max', '中心峰值高度', '建筑高度', 20, 400, 5, '中心区域的最高建筑高度', 'm'),
  numberField('height.taper', '高度衰减指数', '建筑高度', 0.2, 4, 0.1, '越大则中心向外下降越快', '', true),
  numberField('height.jitter', '高度扰动', '建筑高度', 0, 0.8, 0.05, '单体高度的确定性随机扰动幅度', '', true),
  enumField('height.profile', '高度剖面', '建筑高度', [
    { value: 'centerHigh', label: '中心高 / 外围低' },
    { value: 'uniform', label: '均一高度' },
    { value: 'random', label: '随机起伏' },
  ], '建筑高度的空间分布模式'),

  numberField('density.base', '全局基准密度', '分布密度', 0.05, 1, 0.01, '地块被建筑占用的基础概率'),

  enumField('openSpace.enabled', '启用中央开放空间', '中央开放空间', [
    { value: 'true', label: '启用' }, { value: 'false', label: '关闭' },
  ], '在场地中心保留禁止建设的公共空间'),
  enumField('openSpace.shape', '开放空间形状', '中央开放空间', [
    { value: 'circle', label: '圆形' }, { value: 'rect', label: '矩形' },
  ], '开放空间几何形状'),
  numberField('openSpace.radius', '圆形半径', '中央开放空间', 10, 160, 2, '圆形开放空间半径', 'm'),
  numberField('openSpace.width', '矩形宽度', '中央开放空间', 20, 300, 5, '矩形开放空间东西向尺寸', 'm', true),
  numberField('openSpace.depth', '矩形进深', '中央开放空间', 20, 300, 5, '矩形开放空间南北向尺寸', 'm', true),
  enumField('openSpace.style', '景观类型', '中央开放空间', [
    { value: 'park', label: '公园绿地' }, { value: 'plaza', label: '硬质广场' }, { value: 'water', label: '水面' },
  ], '开放空间的地表与植被表现'),
  numberField('openSpace.treeCount', '乔木数量', '中央开放空间', 0, 240, 4, '公园模式下确定性布置的乔木数量', '株', true),
  numberField('openSpace.offsetX', '东西偏移', '中央开放空间', -150, 150, 5, '相对场地中心的 X 偏移', 'm', true),
  numberField('openSpace.offsetZ', '南北偏移', '中央开放空间', -150, 150, 5, '相对场地中心的 Z 偏移', 'm', true),

  enumField('material.palette', '材质配色', '材质与表现', [
    { value: 'future', label: '未来都市 · 冷玻璃' },
    { value: 'concrete', label: '清水混凝土' },
    { value: 'warm', label: '暖色陶板' },
    { value: 'mono', label: '极简灰白' },
  ], '建筑立面色彩集合'),
  numberField('material.glassRatio', '玻璃幕墙占比', '材质与表现', 0, 1, 0.05, '采用高反射玻璃色的建筑比例', '', true),
  enumField('material.roofStyle', '屋顶形式', '材质与表现', [
    { value: 'flat', label: '平屋顶' }, { value: 'stepped', label: '退台' }, { value: 'mixed', label: '混合' },
  ], '屋顶构件形式', true),
  numberField('material.emissive', '夜景自发光', '材质与表现', 0, 1, 0.05, '立面自发光强度', '', true),
];

for (const zone of ZONE_IDS) {
  RULE_FIELDS.push(numberField(
    `density.zoneMultipliers.${zone}`, `${ZONE_LABELS[zone]}密度倍率`, '分布密度',
    0, 2, 0.05, `${ZONE_LABELS[zone]}的密度倍率，1 = 与全局基准一致`, '×',
  ));
}
for (const zone of ZONE_IDS) {
  RULE_FIELDS.push(numberField(
    `height.zoneMultipliers.${zone}`, `${ZONE_LABELS[zone]}高度倍率`, '建筑高度',
    0.2, 2, 0.05, `${ZONE_LABELS[zone]}的高度倍率，1 = 与全局剖面一致`, '×', true,
  ));
}

// ---------------------------------------------------------------------------
// 分阶段 PCG 管线参数（S1–S5 + 扩展点）
// ---------------------------------------------------------------------------

const boolField = (path: string, label: string, group: string, description: string, advanced = false): RuleField =>
  enumField(path, label, group, [
    { value: 'true', label: '启用' }, { value: 'false', label: '关闭' },
  ], description, advanced);

const G_ROAD = '管线 · S1 道路网络';
const G_PARCEL = '管线 · S2 地块划分';
const G_USE = '管线 · S3 功能分配';
const G_BLD = '管线 · S4a 建筑原型';
const G_PARK = '管线 · S4b 公园';
const G_TREE = '管线 · S5 树木分布';
const G_EXT = '管线 · 扩展点';

RULE_FIELDS.push(
  numberField('pipeline.roads.arterialPeriod', '主干路间隔', G_ROAD, 1, 8, 1, '每隔 N 条道路线升为主干路', '条'),
  numberField('pipeline.roads.localWidth', '支路宽度', G_ROAD, 3, 16, 0.5, '支路路面宽度', 'm'),
  numberField('pipeline.roads.arterialWidth', '主干路宽度', G_ROAD, 4, 24, 0.5, '主干路路面宽度', 'm'),
  boolField('pipeline.roads.suppressParkInterior', '抑制公园内部道路', G_ROAD, '中央公园所占街区之间的道路不生成，保证公园与路网零重叠'),

  numberField('pipeline.parcels.targetSize', '目标地块边长', G_PARCEL, 8, 60, 1, '地块划分的目标尺度，越小地块越碎', 'm'),
  numberField('pipeline.parcels.maxSplit', '单街区最大细分', G_PARCEL, 1, 4, 1, '每个方向最多切成几块', '块'),
  numberField('pipeline.parcels.gap', '地块间缝隙', G_PARCEL, 0, 6, 0.5, '相邻地块红线之间的空隙', 'm'),
  numberField('pipeline.parcels.setback', '建筑退界', G_PARCEL, 1, 12, 0.5, '建筑可建范围相对地块红线的内缩；同时形成行道树绿带', 'm'),
  numberField('pipeline.parcels.splitJitter', '细分扰动', G_PARCEL, 0, 1, 0.05, '按街区哈希增加一格细分的概率', '', true),

  enumField('pipeline.landUse.mixPreset', '功能配比预设', G_USE, [
    { value: 'balanced', label: '均衡' }, { value: 'office', label: '办公主导' },
    { value: 'research', label: '研发主导' }, { value: 'green', label: '绿地优先' },
  ], '四类可建功能的权重表'),
  numberField('pipeline.landUse.parkRatio', '分散公园比例', G_USE, 0, 0.5, 0.01, '非中央公园地块被分配为公园的概率'),
  numberField('pipeline.landUse.clusterBias', '公园聚集倾向', G_USE, 0, 1, 0.05, '外围分区公园概率的增益，用于形成不同尺寸公园', '', true),
  numberField('pipeline.landUse.plazaRatio', '广场比例', G_USE, 0, 0.3, 0.01, '硬质广场地块比例', '', true),
  numberField('pipeline.landUse.waterReserveRatio', '水系预留比例', G_USE, 0, 0.3, 0.01, '登记为水系扩展点预留的地块比例（不生成建筑）', '', true),
  numberField('pipeline.landUse.terrainReserveRatio', '地形预留比例', G_USE, 0, 0.3, 0.01, '登记为地形要素扩展点预留的地块比例', '', true),

  numberField('pipeline.buildings.archetypeJitter', '原型自由度', G_BLD, 0, 1, 0.02, '脱离功能权重表自由抽选建筑原型的概率', '', true),
  numberField('pipeline.buildings.maxPerParcel', '单地块最多栋数', G_BLD, 1, 4, 1, '一个地块内可生成的建筑槽位上限', '栋'),
  numberField('pipeline.buildings.spacing', '同地块建筑间距', G_BLD, 0, 8, 0.5, '相邻槽位之间的净距', 'm'),

  numberField('pipeline.parks.centralBlocks', '中央公园街区数', G_PARK, 1, 4, 1, '中央公园占用的 N×N 个连续街区', '街区'),
  numberField('pipeline.parks.inset', '公园边界内缩', G_PARK, 0, 8, 0.5, '公园相对所属地块并集的内缩', 'm'),
  numberField('pipeline.parks.pocketMaxArea', '口袋公园面积上限', G_PARK, 200, 3000, 50, '小于该面积归为口袋公园', 'm²', true),
  numberField('pipeline.parks.neighborhoodMaxArea', '社区公园面积上限', G_PARK, 1000, 15000, 100, '小于该面积归为社区公园', 'm²', true),
  numberField('pipeline.parks.styleJitter', '公园风格扰动', G_PARK, 0, 1, 0.05, '分散公园改为硬质广场的概率', '', true),

  numberField('pipeline.trees.streetInterval', '行道树株距', G_TREE, 4, 30, 1, '沿地块临路面布置行道树的间距', 'm'),
  numberField('pipeline.trees.parkSpacing', '公园树网格间距', G_TREE, 3, 20, 0.5, '公园内候选点网格间距', 'm'),
  numberField('pipeline.trees.roadSetback', '树心距路缘净距', G_TREE, 0, 8, 0.5, '树心到道路带边缘的最小距离', 'm'),
  numberField('pipeline.trees.boundarySetback', '树心距地块边界净距', G_TREE, 0, 8, 0.5, '树心到地块/公园边界的最小距离', 'm'),
  numberField('pipeline.trees.minSpacing', '最小株距', G_TREE, 1, 12, 0.5, '任意两株树之间的最小中心距', 'm'),
  numberField('pipeline.trees.jitter', '树位扰动', G_TREE, 0, 3, 0.1, '候选点的确定性位置扰动幅度', 'm', true),
  numberField('pipeline.trees.maxTrees', '树木总数上限', G_TREE, 100, 4000, 50, '性能保护：超过上限的候选被丢弃', '株', true),

  boolField('pipeline.extensions.water', 'E1 水系扩展点', G_EXT, '启用后为 waterReserved 地块生成占位水面（正式水系拓扑留待后续）'),
  boolField('pipeline.extensions.terrain', 'E2 地形扩展点', G_EXT, '启用后为 terrainReserved 地块生成占位地形要素'),
);

export const FIELD_BY_PATH: Record<string, RuleField> = Object.fromEntries(
  RULE_FIELDS.map((f) => [f.path, f]),
);

export const RULE_GROUPS: string[] = Array.from(new Set(RULE_FIELDS.map((f) => f.group)));

export function isRegisteredPath(path: string): boolean {
  return Object.prototype.hasOwnProperty.call(FIELD_BY_PATH, path);
}

export function getRuleValue(rules: SceneRules, path: string): unknown {
  const segments = path.split('.');
  let cur: unknown = rules;
  for (const seg of segments) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** 不可变写入（结构化克隆 + 路径赋值），路径必须已注册 */
export function setRuleValue(rules: SceneRules, path: string, value: unknown): SceneRules {
  const next = structuredClone(rules) as unknown as Record<string, Record<string, unknown>>;
  const segments = path.split('.');
  let cur: Record<string, unknown> = next;
  for (let i = 0; i < segments.length - 1; i++) {
    cur = cur[segments[i]] as Record<string, unknown>;
  }
  cur[segments[segments.length - 1]] = value;
  return next as unknown as SceneRules;
}

export interface ValidationResult {
  ok: boolean;
  value?: number | string | boolean;
  error?: string;
}

/** 命令层唯一取值校验入口；越界值夹紧到合法区间并返回提示 */
export function validateRuleValue(path: string, raw: unknown): ValidationResult {
  const field = FIELD_BY_PATH[path];
  if (!field) return { ok: false, error: `未注册的规则路径：${path}` };

  if (field.type === 'boolean' || (field.type === 'enum' && field.options?.every((o) => o.value === 'true' || o.value === 'false'))) {
    let bool: boolean;
    if (typeof raw === 'boolean') bool = raw;
    else if (raw === 'true' || raw === 1 || raw === '1') bool = true;
    else if (raw === 'false' || raw === 0 || raw === '0') bool = false;
    else return { ok: false, error: `${field.label} 需要布尔值` };
    return { ok: true, value: bool };
  }

  if (field.type === 'enum') {
    const str = String(raw);
    if (!field.options?.some((o) => o.value === str)) {
      return { ok: false, error: `${field.label} 的取值必须是 ${field.options?.map((o) => o.value).join(' / ')}` };
    }
    return { ok: true, value: str };
  }

  const num = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(num)) return { ok: false, error: `${field.label} 需要数值` };
  const min = field.min ?? -Infinity;
  const max = field.max ?? Infinity;
  const clamped = Math.min(max, Math.max(min, num));
  return {
    ok: true,
    value: Math.round(clamped * 10000) / 10000,
    error: clamped !== num ? `已夹紧到 [${min}, ${max}]` : undefined,
  };
}

/** 生成传给 LLM 的字段清单（不含内部实现细节） */
export function llmFieldCatalog(): Array<{ path: string; label: string; type: string; min?: number; max?: number; options?: string[] }> {
  return RULE_FIELDS.map((f) => ({
    path: f.path,
    label: f.label,
    type: f.type,
    ...(f.min !== undefined ? { min: f.min } : {}),
    ...(f.max !== undefined ? { max: f.max } : {}),
    ...(f.options ? { options: f.options.map((o) => o.value) } : {}),
  }));
}
