/**
 * 文档级 diff：比较两份 SceneDocument 的规则 / 种子 / 人工覆写。
 * 用于撤销、重做、加载、导入、重置等操作后仍能看到「究竟哪条规则变了」，
 * 保证规则可追溯性不因历史操作而中断。
 */
import { RULE_FIELDS, FIELD_BY_PATH, getRuleValue } from './fields';
import { canonicalize } from './rng';
import {
  ZONE_IDS, ZONE_LABELS,
  type CommandSource, type RuleChange, type SceneDocument,
} from './types';

function scopeOfPath(path: string): string {
  for (const z of ZONE_IDS) if (path.endsWith(`.${z}`)) return ZONE_LABELS[z];
  return '全局';
}

export function diffDocuments(
  before: SceneDocument,
  after: SceneDocument,
  source: CommandSource = 'system',
  note?: string,
): RuleChange[] {
  const changes: RuleChange[] = [];

  if (before.seed !== after.seed) {
    changes.push({ path: 'seed', label: '随机种子', before: before.seed, after: after.seed, scope: '全局', source, note });
  }

  for (const field of RULE_FIELDS) {
    const b = getRuleValue(before.rules, field.path);
    const a = getRuleValue(after.rules, field.path);
    if (canonicalize(b) === canonicalize(a)) continue;
    changes.push({
      path: field.path,
      label: FIELD_BY_PATH[field.path]?.label ?? field.path,
      before: b, after: a,
      scope: scopeOfPath(field.path),
      source, note,
    });
  }

  const ids = new Set([...Object.keys(before.overrides), ...Object.keys(after.overrides)]);
  for (const id of Array.from(ids).sort()) {
    const b = before.overrides[id];
    const a = after.overrides[id];
    if (canonicalize(b) === canonicalize(a)) continue;
    changes.push({ path: id, label: `对象覆写 ${id}`, before: b ?? null, after: a ?? null, scope: '单体', source, note });
  }

  return changes;
}
