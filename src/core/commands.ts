/**
 * 受控命令层 —— 自然语言 / LLM / Inspector / 手工 JSON 全部收敛到同一条执行路径。
 *
 * 安全边界：
 *   - Command 是封闭联合类型，validateCommand() 做运行时白名单校验
 *   - rule.set 只能写 RULE_FIELDS 注册过的路径，取值经 validateRuleValue 夹紧
 *   - 不存在 eval / 动态代码 / 任意 Three.js 构造；LLM 永远无法生成三维代码
 *   - applyCommands 是纯函数：相同 (doc, commands) → 相同 result
 */
import { FIELD_BY_PATH, getRuleValue, isRegisteredPath, setRuleValue, validateRuleValue } from './fields';
import { clamp } from './rng';
import { cloneDoc, createDefaultDocument } from './schema';
import { buildGridGraph } from './geom/defaultGraph';
import { distanceToSegment } from './geom/polygon';
import {
  ZONE_IDS, ZONE_LABELS,
  type ApplyResult, type Command, type CommandSource, type ObjectOverride, type Point2,
  type RoadClass, type RuleChange, type SceneDocument, type ZoneSelector,
} from './types';

const ZONE_SELECTORS: ZoneSelector[] = ['all', ...ZONE_IDS];
const ID_PATTERN = /^bld\.-?\d+\.-?\d+$/;
const NODE_ID = /^[A-Za-z0-9_.-]{1,40}$/;
const EDGE_ID = /^[A-Za-z0-9_.-]{1,60}$/;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
function readPoint(v: unknown): Point2 | null {
  if (typeof v !== 'object' || v === null) return null;
  const p = v as Record<string, unknown>;
  if (!finite(p.x) || !finite(p.z) || Math.abs(p.x) > 1e5 || Math.abs(p.z) > 1e5) return null;
  return { x: p.x, z: p.z };
}
function nextId(prefix: string, used: Set<string>): string {
  let i = 0;
  while (used.has(`${prefix}.${i}`)) i++;
  return `${prefix}.${i}`;
}

export interface CommandValidation { ok: boolean; command?: Command; error?: string }

/** 运行时校验：任何外部来源（含 LLM 输出）都必须过这一关 */
export function validateCommand(input: unknown): CommandValidation {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, error: '命令必须是对象' };
  }
  const c = input as Record<string, unknown>;
  const op = c.op;

  switch (op) {
    case 'scene.create': {
      const cmd: Command = { op: 'scene.create' };
      if (c.name !== undefined) {
        if (typeof c.name !== 'string' || c.name.length > 80) return { ok: false, error: 'scene.create.name 非法' };
        cmd.name = c.name;
      }
      for (const key of ['width', 'depth', 'seed'] as const) {
        if (c[key] !== undefined) {
          if (typeof c[key] !== 'number' || !Number.isFinite(c[key])) return { ok: false, error: `scene.create.${key} 必须是数值` };
          cmd[key] = c[key] as number;
        }
      }
      return { ok: true, command: cmd };
    }
    case 'scene.reset': return { ok: true, command: { op: 'scene.reset' } };
    case 'seed.set': {
      if (typeof c.value !== 'number' || !Number.isFinite(c.value)) return { ok: false, error: 'seed.set.value 必须是数值' };
      return { ok: true, command: { op: 'seed.set', value: Math.trunc(c.value) } };
    }
    case 'rule.set': {
      if (typeof c.path !== 'string' || !isRegisteredPath(c.path)) {
        return { ok: false, error: `未注册的规则路径：${String(c.path)}` };
      }
      const check = validateRuleValue(c.path, c.value);
      if (!check.ok) return { ok: false, error: check.error };
      return { ok: true, command: { op: 'rule.set', path: c.path, value: check.value as number | string | boolean } };
    }
    case 'density.adjust':
    case 'height.adjust': {
      if (!ZONE_SELECTORS.includes(c.zone as ZoneSelector)) return { ok: false, error: `非法分区：${String(c.zone)}` };
      if (c.mode !== 'relative' && c.mode !== 'absolute') return { ok: false, error: 'mode 必须是 relative / absolute' };
      const cmd: {
        op: 'density.adjust' | 'height.adjust';
        zone: ZoneSelector;
        mode: 'relative' | 'absolute';
        delta?: number;
        value?: number;
      } = { op, zone: c.zone as ZoneSelector, mode: c.mode as 'relative' | 'absolute' };
      if (c.delta !== undefined) {
        if (typeof c.delta !== 'number' || !Number.isFinite(c.delta)) return { ok: false, error: 'delta 必须是数值' };
        cmd.delta = clamp(c.delta, -0.95, 5);
      }
      if (c.value !== undefined) {
        if (typeof c.value !== 'number' || !Number.isFinite(c.value)) return { ok: false, error: 'value 必须是数值' };
        cmd.value = c.value;
      }
      if (cmd.mode === 'relative' && cmd.delta === undefined) return { ok: false, error: 'relative 模式需要 delta' };
      if (cmd.mode === 'absolute' && cmd.value === undefined) return { ok: false, error: 'absolute 模式需要 value' };
      return { ok: true, command: cmd };
    }
    case 'object.override': {
      if (typeof c.id !== 'string' || !ID_PATTERN.test(c.id)) return { ok: false, error: 'object.override.id 非法' };
      if (typeof c.patch !== 'object' || c.patch === null || Array.isArray(c.patch)) return { ok: false, error: 'patch 必须是对象' };
      const p = c.patch as Record<string, unknown>;
      const patch: ObjectOverride = {};
      if (p.height !== undefined) {
        if (typeof p.height !== 'number' || !Number.isFinite(p.height)) return { ok: false, error: 'patch.height 非法' };
        patch.height = clamp(p.height, 4, 500);
      }
      if (p.footprintScale !== undefined) {
        if (typeof p.footprintScale !== 'number' || !Number.isFinite(p.footprintScale)) return { ok: false, error: 'patch.footprintScale 非法' };
        patch.footprintScale = clamp(p.footprintScale, 0.2, 2);
      }
      if (p.color !== undefined) {
        if (typeof p.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(p.color)) return { ok: false, error: 'patch.color 必须是 #RRGGBB' };
        patch.color = p.color;
      }
      if (p.visible !== undefined) patch.visible = Boolean(p.visible);
      if (p.deleted !== undefined) patch.deleted = Boolean(p.deleted);
      if (Object.keys(patch).length === 0) return { ok: false, error: 'patch 为空' };
      return { ok: true, command: { op: 'object.override', id: c.id, patch } };
    }
    case 'object.delete':
    case 'object.restore': {
      if (typeof c.id !== 'string' || !ID_PATTERN.test(c.id)) return { ok: false, error: 'id 非法' };
      return { ok: true, command: { op, id: c.id } };
    }
    case 'camera.set': {
      const presets = ['iso', 'top', 'front', 'ne35'];
      if (!presets.includes(String(c.preset))) return { ok: false, error: 'camera.set.preset 非法' };
      return { ok: true, command: { op: 'camera.set', preset: c.preset as 'iso' | 'top' | 'front' | 'ne35' } };
    }
    // --- 可编辑道路图 -----------------------------------------------------
    case 'graph.regenerate': return { ok: true, command: { op: 'graph.regenerate' } };
    case 'graph.node.add': {
      if (!finite(c.x) || !finite(c.z) || Math.abs(c.x) > 1e5 || Math.abs(c.z) > 1e5) return { ok: false, error: 'graph.node.add 需要场地量级的 x/z 数值' };
      const cmd: Command = { op: 'graph.node.add', x: Number(c.x), z: Number(c.z) };
      if (c.id !== undefined) {
        if (typeof c.id !== 'string' || !NODE_ID.test(c.id)) return { ok: false, error: '节点 ID 非法' };
        cmd.id = c.id;
      }
      return { ok: true, command: cmd };
    }
    case 'graph.node.move': {
      if (typeof c.id !== 'string' || !NODE_ID.test(c.id) || !finite(c.x) || !finite(c.z)) return { ok: false, error: 'graph.node.move 参数非法' };
      return { ok: true, command: { op: 'graph.node.move', id: c.id, x: Number(c.x), z: Number(c.z) } };
    }
    case 'graph.node.remove': {
      if (typeof c.id !== 'string' || !NODE_ID.test(c.id)) return { ok: false, error: '节点 ID 非法' };
      return { ok: true, command: { op: 'graph.node.remove', id: c.id } };
    }
    case 'graph.edge.add': {
      if (typeof c.from !== 'string' || typeof c.to !== 'string' || !NODE_ID.test(c.from) || !NODE_ID.test(c.to) || c.from === c.to) {
        return { ok: false, error: 'graph.edge.add 需要两个不同的合法节点 ID' };
      }
      const cmd: Command = { op: 'graph.edge.add', from: c.from, to: c.to };
      if (c.id !== undefined) {
        if (typeof c.id !== 'string' || !EDGE_ID.test(c.id)) return { ok: false, error: '路段 ID 非法' };
        cmd.id = c.id;
      }
      if (c.cls !== undefined) {
        if (c.cls !== 'arterial' && c.cls !== 'local') return { ok: false, error: '道路等级非法' };
        cmd.cls = c.cls;
      }
      if (c.width !== undefined) {
        if (!finite(c.width)) return { ok: false, error: '道路宽度必须是数值' };
        cmd.width = clamp(Number(c.width), 1, 40);
      }
      return { ok: true, command: cmd };
    }
    case 'graph.edge.remove': {
      if (typeof c.id !== 'string' || !EDGE_ID.test(c.id)) return { ok: false, error: '路段 ID 非法' };
      return { ok: true, command: { op: 'graph.edge.remove', id: c.id } };
    }
    case 'graph.edge.update': {
      if (typeof c.id !== 'string' || !EDGE_ID.test(c.id)) return { ok: false, error: '路段 ID 非法' };
      const cmd: Command = { op: 'graph.edge.update', id: c.id };
      if (c.cls !== undefined) {
        if (c.cls !== 'arterial' && c.cls !== 'local') return { ok: false, error: '道路等级非法' };
        cmd.cls = c.cls as RoadClass;
      }
      if (c.width !== undefined) {
        if (!finite(c.width)) return { ok: false, error: '道路宽度必须是数值' };
        cmd.width = clamp(Number(c.width), 1, 40);
      }
      return { ok: true, command: cmd };
    }
    // --- 可编辑多边形地块 -------------------------------------------------
    case 'parcel.split':
    case 'parcel.merge': {
      const a = readPoint(c.a); const b = readPoint(c.b);
      if (!a || !b || Math.hypot(a.x - b.x, a.z - b.z) < 1) return { ok: false, error: `${String(op)} 需要两个不同的合法点` };
      return { ok: true, command: { op, a, b } };
    }
    case 'parcel.vertex': {
      const at = readPoint(c.at); const to = readPoint(c.to);
      if (!at || !to) return { ok: false, error: 'parcel.vertex 需要 at/to 两个合法点' };
      return { ok: true, command: { op: 'parcel.vertex', at, to } };
    }
    case 'parcel.edits.clear': return { ok: true, command: { op: 'parcel.edits.clear' } };
    default:
      return { ok: false, error: `不支持的操作：${String(op)}` };
  }
}

export function validateCommands(input: unknown): { ok: boolean; commands?: Command[]; error?: string } {
  if (!Array.isArray(input)) return { ok: false, error: '命令集必须是数组' };
  if (input.length === 0) return { ok: false, error: '命令集为空' };
  if (input.length > 32) return { ok: false, error: '单次命令数超过上限 32' };
  const commands: Command[] = [];
  for (let i = 0; i < input.length; i++) {
    const v = validateCommand(input[i]);
    if (!v.ok || !v.command) return { ok: false, error: `第 ${i + 1} 条命令：${v.error}` };
    commands.push(v.command);
  }
  return { ok: true, commands };
}

function change(path: string, before: unknown, after: unknown, source: CommandSource, scope = '全局', note?: string): RuleChange {
  return {
    path,
    label: FIELD_BY_PATH[path]?.label ?? path,
    before, after, scope, source, note,
  };
}

function round(v: number): number { return Math.round(v * 10000) / 10000; }

/** 纯函数执行器。不修改入参 doc，返回新文档与全部规则变更记录。 */
export function applyCommands(doc: SceneDocument, commands: Command[], source: CommandSource = 'structured'): ApplyResult {
  let next = cloneDoc(doc);
  const changes: RuleChange[] = [];
  const errors: string[] = [];
  let cameraPreset: ApplyResult['cameraPreset'];

  for (const cmd of commands) {
    switch (cmd.op) {
      case 'scene.create': {
        const created = createDefaultDocument(cmd.seed ?? next.seed);
        if (cmd.width !== undefined) created.rules.terrain.width = clamp(cmd.width, 80, 1200);
        if (cmd.depth !== undefined) created.rules.terrain.depth = clamp(cmd.depth, 80, 1200);
        if (cmd.name !== undefined) created.name = cmd.name;
        created.id = next.id;
        created.createdAt = next.createdAt;
        created.revision = next.revision + 1;
        changes.push(change('scene', `rev.${next.revision}`, `rev.${created.revision}`, source, '全局', '重建场景：规则恢复为默认，清空人工覆写'));
        next = created;
        break;
      }
      case 'scene.reset': {
        const reset = createDefaultDocument(next.seed);
        reset.id = next.id;
        reset.createdAt = next.createdAt;
        reset.revision = next.revision + 1;
        changes.push(change('scene', `rev.${next.revision}`, `rev.${reset.revision}`, source, '全局', '恢复默认规则'));
        next = reset;
        break;
      }
      case 'seed.set': {
        const before = next.seed;
        next.seed = Math.trunc(cmd.value);
        next.revision++;
        changes.push(change('seed', before, next.seed, source, '全局', '改变随机种子会重建全部地块抽样'));
        break;
      }
      case 'rule.set': {
        const before = getRuleValue(next.rules, cmd.path);
        const check = validateRuleValue(cmd.path, cmd.value);
        if (!check.ok) { errors.push(check.error ?? '取值非法'); break; }
        next.rules = setRuleValue(next.rules, cmd.path, check.value);
        // 场地尺寸变化必须同步缩放持久化道路图，否则图节点会越界、闭合面面积不再守恒
        if ((cmd.path === 'terrain.width' || cmd.path === 'terrain.depth')
          && typeof before === 'number' && before > 0 && typeof check.value === 'number') {
          const scale = check.value / before;
          const axis = cmd.path === 'terrain.width' ? 'x' : 'z';
          for (const n of next.graph.nodes) n[axis] = Math.round(n[axis] * scale * 1000) / 1000;
        }
        next.revision++;
        changes.push(change(cmd.path, before, check.value, source, scopeOfPath(cmd.path), check.error));
        break;
      }
      case 'density.adjust': {
        if (cmd.zone === 'all') {
          const before = next.rules.density.base;
          const after = clamp(cmd.mode === 'relative' ? before * (1 + (cmd.delta ?? 0)) : (cmd.value ?? before), 0.01, 1);
          next.rules.density.base = round(after);
          next.revision++;
          changes.push(change('density.base', before, next.rules.density.base, source, '全部区域'));
        } else {
          const before = next.rules.density.zoneMultipliers[cmd.zone];
          const after = clamp(cmd.mode === 'relative' ? before * (1 + (cmd.delta ?? 0)) : (cmd.value ?? before), 0, 2);
          next.rules.density.zoneMultipliers[cmd.zone] = round(after);
          next.revision++;
          changes.push(change(
            `density.zoneMultipliers.${cmd.zone}`, before, next.rules.density.zoneMultipliers[cmd.zone],
            source, ZONE_LABELS[cmd.zone],
            cmd.mode === 'relative' ? `相对调整 ${(cmd.delta! * 100).toFixed(0)}%` : '设为目标倍率',
          ));
        }
        break;
      }
      case 'height.adjust': {
        if (cmd.zone === 'all') {
          const b0 = next.rules.height.base;
          const m0 = next.rules.height.max;
          const factor = cmd.mode === 'relative' ? 1 + (cmd.delta ?? 0) : (cmd.value ?? 1);
          next.rules.height.base = round(clamp(b0 * factor, 6, 120));
          next.rules.height.max = round(clamp(m0 * factor, 20, 400));
          next.revision++;
          changes.push(change('height.base', b0, next.rules.height.base, source, '全部区域'));
          changes.push(change('height.max', m0, next.rules.height.max, source, '全部区域'));
        } else {
          const before = next.rules.height.zoneMultipliers[cmd.zone];
          const after = clamp(cmd.mode === 'relative' ? before * (1 + (cmd.delta ?? 0)) : (cmd.value ?? before), 0.2, 2);
          next.rules.height.zoneMultipliers[cmd.zone] = round(after);
          next.revision++;
          changes.push(change(
            `height.zoneMultipliers.${cmd.zone}`, before, next.rules.height.zoneMultipliers[cmd.zone],
            source, ZONE_LABELS[cmd.zone],
            cmd.mode === 'relative' ? `相对调整 ${(cmd.delta! * 100).toFixed(0)}%` : '设为目标倍率',
          ));
        }
        break;
      }
      case 'object.override': {
        const prev = next.overrides[cmd.id] ?? {};
        next.overrides[cmd.id] = { ...prev, ...cmd.patch };
        next.revision++;
        changes.push(change(cmd.id, prev, next.overrides[cmd.id], source, '单体'));
        break;
      }
      case 'object.delete':
      case 'object.restore': {
        const prev = next.overrides[cmd.id] ?? {};
        next.overrides[cmd.id] = { ...prev, deleted: cmd.op === 'object.delete' };
        next.revision++;
        changes.push(change(cmd.id, prev.deleted ?? false, cmd.op === 'object.delete', source, '单体'));
        break;
      }
      // --- 可编辑道路图 ---------------------------------------------------
      case 'graph.regenerate': {
        const before = `${next.graph.nodes.length} 节点 / ${next.graph.edges.length} 段`;
        next.graph = buildGridGraph(next.rules.terrain, next.rules.pipeline.roads);
        next.revision++;
        changes.push(change('graph', before, `${next.graph.nodes.length} 节点 / ${next.graph.edges.length} 段`, source, '全局', '按当前规则重建正交道路图'));
        break;
      }
      case 'graph.node.add': {
        const used = new Set(next.graph.nodes.map((n) => n.id));
        const id = cmd.id ?? nextId('gn', used);
        if (used.has(id)) { errors.push(`节点 ID 已存在：${id}`); break; }
        const { width, depth } = next.rules.terrain;
        next.graph.nodes.push({ id, x: clamp(cmd.x, -width / 2, width / 2), z: clamp(cmd.z, -depth / 2, depth / 2) });
        next.revision++;
        changes.push(change(`graph.node.${id}`, null, `(${cmd.x}, ${cmd.z})`, source, '道路图', '新增道路节点'));
        break;
      }
      case 'graph.node.move': {
        const n = next.graph.nodes.find((x) => x.id === cmd.id);
        if (!n) { errors.push(`节点不存在：${cmd.id}`); break; }
        const { width, depth } = next.rules.terrain;
        const before = `(${n.x}, ${n.z})`;
        n.x = clamp(cmd.x, -width / 2, width / 2);
        n.z = clamp(cmd.z, -depth / 2, depth / 2);
        next.revision++;
        changes.push(change(`graph.node.${cmd.id}`, before, `(${n.x}, ${n.z})`, source, '道路图', '移动节点，所有关联地块自动重适配'));
        break;
      }
      case 'graph.node.remove': {
        const before = next.graph.nodes.length;
        next.graph.nodes = next.graph.nodes.filter((n) => n.id !== cmd.id);
        if (next.graph.nodes.length === before) { errors.push(`节点不存在：${cmd.id}`); break; }
        const removedEdges = next.graph.edges.filter((e) => e.from === cmd.id || e.to === cmd.id).length;
        next.graph.edges = next.graph.edges.filter((e) => e.from !== cmd.id && e.to !== cmd.id);
        next.revision++;
        changes.push(change(`graph.node.${cmd.id}`, '存在', '已删除', source, '道路图', `同时移除 ${removedEdges} 条关联路段以保持拓扑合法`));
        break;
      }
      case 'graph.edge.add': {
        const ids = new Set(next.graph.nodes.map((n) => n.id));
        if (!ids.has(cmd.from) || !ids.has(cmd.to)) { errors.push('路段端点不存在'); break; }
        const used = new Set(next.graph.edges.map((e) => e.id));
        const id = cmd.id ?? nextId('ge', used);
        if (used.has(id)) { errors.push(`路段 ID 已存在：${id}`); break; }
        const cls: RoadClass = cmd.cls ?? 'local';
        next.graph.edges.push({
          id, from: cmd.from, to: cmd.to, cls,
          width: cmd.width ?? (cls === 'arterial' ? next.rules.pipeline.roads.arterialWidth : next.rules.pipeline.roads.localWidth),
        });
        next.revision++;
        changes.push(change(`graph.edge.${id}`, null, `${cmd.from} → ${cmd.to} (${cls})`, source, '道路图', '新增路段；交叉处自动插入节点并切分地块'));
        break;
      }
      case 'graph.edge.remove': {
        const before = next.graph.edges.length;
        next.graph.edges = next.graph.edges.filter((e) => e.id !== cmd.id);
        if (next.graph.edges.length === before) { errors.push(`路段不存在：${cmd.id}`); break; }
        next.revision++;
        changes.push(change(`graph.edge.${cmd.id}`, '存在', '已删除', source, '道路图', '相邻地块自动合并为新的闭合面'));
        break;
      }
      case 'graph.edge.update': {
        const e = next.graph.edges.find((x) => x.id === cmd.id);
        if (!e) { errors.push(`路段不存在：${cmd.id}`); break; }
        const before = `${e.cls} / ${e.width}m`;
        if (cmd.cls) e.cls = cmd.cls;
        if (cmd.width !== undefined) e.width = cmd.width;
        next.revision++;
        changes.push(change(`graph.edge.${cmd.id}`, before, `${e.cls} / ${e.width}m`, source, '道路图'));
        break;
      }
      // --- 多边形地块编辑 -------------------------------------------------
      case 'parcel.split':
      case 'parcel.merge': {
        const used = new Set(next.parcelEdits.map((e) => e.id));
        const id = nextId('pe', used);
        next.parcelEdits.push({ id, kind: cmd.op === 'parcel.split' ? 'split' : 'merge', a: cmd.a, b: cmd.b });
        next.revision++;
        changes.push(change(`parcelEdits.${id}`, null, `${cmd.op} (${cmd.a.x},${cmd.a.z})→(${cmd.b.x},${cmd.b.z})`, source, '地块', '按空间锚点重放，改道路后仍附着于对应位置'));
        break;
      }
      case 'parcel.vertex': {
        // 顶点若在道路图上，必须同步移动节点，否则地块边界会偏离道路中心线，
        // 建筑将压占道路带。非图节点（细分产生的地块内部顶点）只需局部重放。
        let target: (typeof next.graph.nodes)[number] | null = null;
        let bestD = Infinity;
        for (const n of next.graph.nodes) {
          const d = Math.hypot(n.x - cmd.at.x, n.z - cmd.at.z);
          if (d < bestD) { bestD = d; target = n; }
        }
        const byId = new Map(next.graph.nodes.map((n) => [n.id, n]));
        const onRoad = next.graph.edges.some((e) => {
          const a = byId.get(e.from); const b = byId.get(e.to);
          return a && b && distanceToSegment(cmd.at.x, cmd.at.z, { x: a.x, z: a.z }, { x: b.x, z: b.z }) < 0.75;
        });
        if (onRoad && !(target && bestD < 0.75)) {
          errors.push('该顶点位于道路段上：请先新增道路节点，或用「移动道路节点」保持一致，否则地块边界会偏离道路中心线');
          break;
        }
        if (target && bestD < 0.75) {
          const { width, depth } = next.rules.terrain;
          const before = `(${target.x}, ${target.z})`;
          target.x = clamp(cmd.to.x, -width / 2, width / 2);
          target.z = clamp(cmd.to.z, -depth / 2, depth / 2);
          next.revision++;
          changes.push(change(`graph.node.${target.id}`, before, `(${target.x}, ${target.z})`, source, '道路图', '顶点位于道路图：同步移动节点，道路与所有关联地块边界保持一致'));
        } else {
          const used = new Set(next.parcelEdits.map((e) => e.id));
          const id = nextId('pe', used);
          next.parcelEdits.push({ id, kind: 'vertex', at: cmd.at, to: cmd.to });
          next.revision++;
          changes.push(change(`parcelEdits.${id}`, null, `顶点 (${cmd.at.x},${cmd.at.z})→(${cmd.to.x},${cmd.to.z})`, source, '地块', '地块间内部顶点：共享该顶点的所有地块同步移动，保持边界闭合'));
        }
        break;
      }
      case 'parcel.edits.clear': {
        const before = next.parcelEdits.length;
        next.parcelEdits = [];
        next.revision++;
        changes.push(change('parcelEdits', `${before} 条`, '0 条', source, '地块', '清空地块编辑，恢复由道路图直接划分的面'));
        break;
      }
      case 'camera.set': {
        cameraPreset = cmd.preset;
        break;
      }
    }
  }

  return { doc: next, changes, cameraPreset, errors };
}

function scopeOfPath(path: string): string {
  for (const z of ZONE_IDS) {
    if (path.endsWith(`.${z}`)) return ZONE_LABELS[z];
  }
  return '全局';
}

/** UI 用：把命令翻译成人话 */
export function describeCommand(cmd: Command): string {
  switch (cmd.op) {
    case 'scene.create': return `生成场景 ${cmd.width ?? 400} × ${cmd.depth ?? 400} m`;
    case 'scene.reset': return '恢复默认规则';
    case 'seed.set': return `设置种子 = ${cmd.value}`;
    case 'rule.set': return `设置 ${FIELD_BY_PATH[cmd.path]?.label ?? cmd.path} = ${String(cmd.value)}`;
    case 'density.adjust': return `${cmd.zone === 'all' ? '全局' : ZONE_LABELS[cmd.zone]}密度 ${cmd.mode === 'relative' ? `相对${(cmd.delta! * 100 > 0 ? '提高' : '降低')} ${Math.abs(cmd.delta! * 100).toFixed(0)}%` : `设为 ${cmd.value}`}`;
    case 'height.adjust': return `${cmd.zone === 'all' ? '全局' : ZONE_LABELS[cmd.zone]}高度 ${cmd.mode === 'relative' ? `相对${(cmd.delta! * 100 > 0 ? '提高' : '降低')} ${Math.abs(cmd.delta! * 100).toFixed(0)}%` : `设为 ${cmd.value}`}`;
    case 'object.override': return `覆写对象 ${cmd.id}`;
    case 'object.delete': return `删除对象 ${cmd.id}`;
    case 'object.restore': return `恢复对象 ${cmd.id}`;
    case 'graph.regenerate': return '按规则重建正交道路图';
    case 'graph.node.add': return `新增道路节点 (${cmd.x}, ${cmd.z})`;
    case 'graph.node.move': return `移动道路节点 ${cmd.id} → (${cmd.x}, ${cmd.z})`;
    case 'graph.node.remove': return `删除道路节点 ${cmd.id} 及其关联路段`;
    case 'graph.edge.add': return `新增路段 ${cmd.from} → ${cmd.to}`;
    case 'graph.edge.remove': return `删除路段 ${cmd.id}`;
    case 'graph.edge.update': return `修改路段 ${cmd.id}`;
    case 'parcel.split': return `按 (${cmd.a.x},${cmd.a.z})→(${cmd.b.x},${cmd.b.z}) 拆分地块`;
    case 'parcel.merge': return `合并 (${cmd.a.x},${cmd.a.z}) 与 (${cmd.b.x},${cmd.b.z}) 所在地块`;
    case 'parcel.vertex': return `移动地块顶点 (${cmd.at.x},${cmd.at.z}) → (${cmd.to.x},${cmd.to.z})`;
    case 'parcel.edits.clear': return '清空全部地块编辑';
    case 'camera.set': return `切换视角：${cmd.preset}`;
  }
}
