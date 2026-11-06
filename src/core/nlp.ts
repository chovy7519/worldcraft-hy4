/**
 * 中文自然语言 → 结构化命令（本地规则解析器，零 AI 依赖）。
 *
 * 定位：确定性、可审计、可离线。它不是通用语义理解器，只覆盖
 * WorldCraft V0.1 已注册规则能表达的意图。识别不了就明确拒绝，
 * 绝不猜测、绝不静默执行。配置 LLM 时，LLM 的输出同样要过
 * validateCommands() 才能进入执行器 —— 两条路径共用同一份 Command 契约。
 */
import type { Command, ZoneSelector } from './types';

type AdjustCommand = Extract<Command, { op: 'density.adjust' | 'height.adjust' }>;

export type UiAction = 'undo' | 'redo' | 'save' | 'load' | 'export' | 'deleteSelected' | 'showRules';

export interface ParseContext { seed?: number; selectedId?: string | null }

export interface ParseResult {
  commands: Command[];
  uiActions: UiAction[];
  matched: string[];
  confidence: number;
  explanation: string;
}

const ZONE_WORDS: Array<[string, ZoneSelector]> = ([
  ['所有区域', 'all'], ['全部区域', 'all'], ['整个城市', 'all'],
  ['东侧', 'east'], ['东边', 'east'], ['东部', 'east'], ['东区', 'east'], ['东面', 'east'], ['东片区', 'east'],
  ['西侧', 'west'], ['西边', 'west'], ['西部', 'west'], ['西区', 'west'], ['西面', 'west'], ['西片区', 'west'],
  ['北侧', 'north'], ['北边', 'north'], ['北部', 'north'], ['北区', 'north'], ['北面', 'north'], ['北片区', 'north'],
  ['南侧', 'south'], ['南边', 'south'], ['南部', 'south'], ['南区', 'south'], ['南面', 'south'], ['南片区', 'south'],
  ['核心区', 'core'], ['中心区', 'core'], ['中央区', 'core'], ['中心', 'core'], ['中央', 'core'],
  ['全局', 'all'], ['整体', 'all'], ['全部', 'all'], ['所有', 'all'], ['整座城市', 'all'],
] as Array<[string, ZoneSelector]>).sort((a, b) => b[0].length - a[0].length);

function findZone(text: string): { zone: ZoneSelector; word: string } | null {
  for (const [word, zone] of ZONE_WORDS) {
    if (text.includes(word)) return { zone, word };
  }
  return null;
}

const DOWN = /降低|减少|下调|调低|减小|压缩|变稀|稀疏|降低到|降/;
const UP = /提高|增加|上调|调高|增大|提升|加密|变密|密集|升/;
const SET = /设为|设置为|调整为|改为|指定为|改成|设为|设置成/;

function readAmount(text: string): { value: number; raw: string } | null {
  const m = text.match(/(\d+(?:\.\d+)?)\s*([%％]?)/);
  if (!m) return null;
  const n = Number(m[1]);
  // 带 % 或数值 > 1 → 视作百分比；0..1 的小数视作比例
  return { value: m[2] ? n / 100 : n > 1 ? n / 100 : n, raw: m[0].trim() };
}

function parseAdjustment(text: string, kind: 'density' | 'height'): AdjustCommand | null {
  const zoneHit = findZone(text);
  const amount = readAmount(text);
  if (!amount) return null;
  const hasSet = SET.test(text);
  const down = DOWN.test(text);
  const up = UP.test(text);
  if (!hasSet && !down && !up) return null;

  if (hasSet) {
    return {
      op: kind === 'density' ? 'density.adjust' : 'height.adjust',
      zone: zoneHit?.zone ?? 'all', mode: 'absolute', value: amount.value,
    };
  }
  const sign = down ? -1 : 1;
  return {
    op: kind === 'density' ? 'density.adjust' : 'height.adjust',
    zone: zoneHit?.zone ?? 'all', mode: 'relative', delta: sign * amount.value,
  };
}

function dedupeRuleSet(commands: Command[]): Command[] {
  const seen = new Map<string, number>();
  const out: Command[] = [];
  for (const cmd of commands) {
    if (cmd.op === 'rule.set') {
      const prev = seen.get(cmd.path);
      if (prev !== undefined) { out[prev] = cmd; continue; }
      seen.set(cmd.path, out.length);
    }
    out.push(cmd);
  }
  return out;
}

/** 主入口 */
export function parseNaturalLanguage(input: string, ctx: ParseContext = {}): ParseResult {
  const text = input.trim().replace(/\s+/g, ' ');
  const commands: Command[] = [];
  const uiActions: UiAction[] = [];
  const matched: string[] = [];

  if (!text) {
    return { commands: [], uiActions: [], matched: [], confidence: 0, explanation: '输入为空。' };
  }

  // --- 工作台动作 ---------------------------------------------------------
  if (/撤销|回退|退回上一步|undo/i.test(text)) uiActions.push('undo');
  if (/重做|恢复上一步|redo/i.test(text)) uiActions.push('redo');
  if (/保存|存档|save/i.test(text)) uiActions.push('save');
  if (/加载|读取存档|载入|load/i.test(text)) uiActions.push('load');
  if (/导出|下载场景|export/i.test(text)) uiActions.push('export');
  if (/删除选中|移除选中|删掉这栋/.test(text)) uiActions.push('deleteSelected');
  if (/查看规则|显示规则|规则变化|规则追溯/.test(text)) uiActions.push('showRules');
  if (uiActions.length > 0) matched.push(`工作台动作：${uiActions.join(' / ')}`);

  // --- 场景生成 -----------------------------------------------------------
  const createIntent = /生成|创建|新建|构建|搭建|做一座|建一座|来一座/.test(text)
    && /城市|城区|街区|场景|地块|世界|都市/.test(text);
  if (createIntent) {
    const dim = text.match(/(\d{2,4})\s*(?:m|米|公尺)?\s*[×xX*＊]\s*(\d{2,4})\s*(?:m|米|公尺)?/)
      ?? text.match(/(\d{2,4})\s*(?:m|米|公尺)?\s*见方/);
    const width = dim ? Number(dim[1]) : undefined;
    const depth = dim ? Number(dim[2] ?? dim[1]) : undefined;
    const seedMatch = text.match(/种子\s*(\d+)/);
    const cmd: Command = {
      op: 'scene.create',
      ...(width !== undefined ? { width } : {}),
      ...(depth !== undefined ? { depth } : {}),
      ...(seedMatch ? { seed: Number(seedMatch[1]) } : {}),
      name: width ? `未来城市 · ${width} × ${depth} m` : '未来城市',
    };
    commands.push(cmd);
    matched.push(`生成场景 ${width ?? 400} × ${depth ?? 400} m`);

    if (/未来|科幻|赛博|高科技/.test(text)) {
      commands.push({ op: 'rule.set', path: 'material.palette', value: 'future' });
      matched.push('材质：未来都市 · 冷玻璃');
    } else if (/清水混凝土|混凝土/.test(text)) {
      commands.push({ op: 'rule.set', path: 'material.palette', value: 'concrete' });
      matched.push('材质：清水混凝土');
    } else if (/暖色|陶板|砖石/.test(text)) {
      commands.push({ op: 'rule.set', path: 'material.palette', value: 'warm' });
      matched.push('材质：暖色陶板');
    }

    if (/(中央|中心|中间|核心).{0,8}(较?高|更高|最高|高楼)|高楼.{0,6}(集中|聚集).{0,4}(中心|中央)/.test(text)
      || /中央建筑较高/.test(text)) {
      commands.push({ op: 'rule.set', path: 'height.profile', value: 'centerHigh' });
      commands.push({ op: 'rule.set', path: 'height.max', value: 180 });
      commands.push({ op: 'rule.set', path: 'height.base', value: 16 });
      matched.push('高度剖面：中心高 / 外围低（峰值 180 m，外围 16 m）');
    }

    if (/(保留|留出|设置|布置|安排).{0,12}(开放空间|公共空间|广场|绿地|公园|中央庭院)|(中央|中心).{0,6}(开放空间|广场|绿地)/.test(text)) {
      commands.push({ op: 'rule.set', path: 'openSpace.enabled', value: true });
      commands.push({ op: 'rule.set', path: 'openSpace.shape', value: 'circle' });
      const style = /水景|水面|湖/.test(text) ? 'water' : /广场|硬质|铺装/.test(text) ? 'plaza' : 'park';
      commands.push({ op: 'rule.set', path: 'openSpace.style', value: style });
      const radius = text.match(/(?:半径|扩大到|尺寸为?)\s*(\d{1,3})\s*(?:m|米)?/);
      if (radius) commands.push({ op: 'rule.set', path: 'openSpace.radius', value: Number(radius[1]) });
      matched.push(`中央公共开放空间：圆形 · ${style === 'park' ? '公园绿地' : style === 'plaza' ? '硬质广场' : '水面'}`);
    }
  }

  // --- 密度 / 高度调整 -----------------------------------------------------
  const densityMention = /密度|建筑量|楼栋数|建筑数量|占地率/.test(text);
  const heightMention = /高度|楼高|楼层|建筑高度|天际线/.test(text);
  if (densityMention && !createIntent) {
    const cmd = parseAdjustment(text, 'density');
    if (cmd) {
      commands.push(cmd);
      const z = findZone(text);
      const pct = cmd.mode === 'relative' ? `${(cmd.delta! * 100).toFixed(0)}%` : `倍率 ${cmd.value}`;
      matched.push(`${z?.word ?? '全局'}密度 ${cmd.mode === 'relative' ? `相对调整 ${pct}` : `设为 ${pct}`}`);
    }
  }
  if (heightMention && !createIntent) {
    const cmd = parseAdjustment(text, 'height');
    if (cmd) {
      commands.push(cmd);
      const z = findZone(text);
      const pct = cmd.mode === 'relative' ? `${(cmd.delta! * 100).toFixed(0)}%` : `倍率 ${cmd.value}`;
      matched.push(`${z?.word ?? '全局'}高度 ${cmd.mode === 'relative' ? `相对调整 ${pct}` : `设为 ${pct}`}`);
    }
  }
  if (/其他区域不变|其余不变|别的地方不动|保持其他|其他不变|仅.{0,4}区域/.test(text)) {
    matched.push('约束：仅目标分区生效，其余分区逐对象保持不变（由按坐标哈希采样保证）');
  }

  // --- 种子 ---------------------------------------------------------------
  if (!createIntent) {
    const seedMatch = text.match(/(?:种子|随机种子|seed)\s*(?:改为|设为|设置成|换成|改成|[=:])?\s*(\d{1,10})/i);
    if (seedMatch) {
      commands.push({ op: 'seed.set', value: Number(seedMatch[1]) });
      matched.push(`随机种子 = ${seedMatch[1]}`);
    } else if (/换一批|重新随机|换个种子|重新生成/.test(text) && ctx.seed !== undefined) {
      commands.push({ op: 'seed.set', value: ctx.seed + 1 });
      matched.push(`随机种子递增为 ${ctx.seed + 1}`);
    }
  }

  // --- 开放空间开关与尺寸 --------------------------------------------------
  if (!createIntent && /取消|去掉|关闭|移除/.test(text) && /开放空间|广场|绿地|公园/.test(text)) {
    commands.push({ op: 'rule.set', path: 'openSpace.enabled', value: false });
    matched.push('关闭中央开放空间');
  }
  if (!createIntent && /(开放空间|广场|绿地|公园)/.test(text) && /(半径|扩大到|缩小到|尺寸)/.test(text)) {
    const r = text.match(/(?:半径|扩大到|缩小到|尺寸为?)\s*(\d{1,3})\s*(?:m|米)?/);
    if (r) {
      commands.push({ op: 'rule.set', path: 'openSpace.radius', value: Number(r[1]) });
      matched.push(`开放空间半径 = ${r[1]} m`);
    }
  }
  if (!createIntent && /(公园|绿地)/.test(text) && /(改成|改为|设为)/.test(text)) {
    commands.push({ op: 'rule.set', path: 'openSpace.style', value: 'park' });
    matched.push('开放空间景观 = 公园绿地');
  }
  if (!createIntent && /广场|硬质铺装/.test(text) && /(改成|改为|设为)/.test(text)) {
    commands.push({ op: 'rule.set', path: 'openSpace.style', value: 'plaza' });
    matched.push('开放空间景观 = 硬质广场');
  }

  // --- 材质 ---------------------------------------------------------------
  if (!createIntent) {
    if (/未来感|未来风|科幻|冷色玻璃/.test(text)) { commands.push({ op: 'rule.set', path: 'material.palette', value: 'future' }); matched.push('材质 = 未来都市'); }
    else if (/清水混凝土|混凝土风/.test(text)) { commands.push({ op: 'rule.set', path: 'material.palette', value: 'concrete' }); matched.push('材质 = 清水混凝土'); }
    else if (/暖色|陶板|暖调/.test(text)) { commands.push({ op: 'rule.set', path: 'material.palette', value: 'warm' }); matched.push('材质 = 暖色陶板'); }
    else if (/极简|灰白|单色/.test(text)) { commands.push({ op: 'rule.set', path: 'material.palette', value: 'mono' }); matched.push('材质 = 极简灰白'); }
  }

  // --- 视角 ---------------------------------------------------------------
  if (/顶视|俯视|平面图视角/.test(text)) { commands.push({ op: 'camera.set', preset: 'top' }); matched.push('视角 = 顶视'); }
  else if (/东北|35度|35°/.test(text)) { commands.push({ op: 'camera.set', preset: 'ne35' }); matched.push('视角 = 东北 35° 半鸟瞰'); }
  else if (/等轴|轴测|默认视角/.test(text)) { commands.push({ op: 'camera.set', preset: 'iso' }); matched.push('视角 = 等轴测'); }
  else if (/正视|立面视角/.test(text)) { commands.push({ op: 'camera.set', preset: 'front' }); matched.push('视角 = 正视'); }

  const finalCommands = dedupeRuleSet(commands);
  const recognized = finalCommands.length > 0 || uiActions.length > 0;
  const confidence = recognized ? Math.min(1, 0.55 + 0.12 * matched.length) : 0;
  const explanation = recognized
    ? `识别到 ${finalCommands.length} 条结构化命令、${uiActions.length} 个工作台动作。${matched.join('；')}。`
    : '未能识别可执行意图。V0.1 只支持已注册规则可表达的操作；请改用示例语句、参数面板，或在下方直接粘贴结构化命令 JSON。';

  return { commands: finalCommands, uiActions, matched, confidence, explanation };
}
