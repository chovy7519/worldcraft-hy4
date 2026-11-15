/**
 * 用户默认场景预设（2026-11-15 由用户导出的 800 × 800 m 存档固化）。
 *
 * 为什么不是改 defaultRules()：
 *  1. 这份存档的 graph 是 400 m 默认网格（77 节点 / 112 边）在用户把场地
 *     调到 800 m 时按坐标缩放后的**持久化图**（±400 m），不是
 *     buildGridGraph(800m) 会生成的 285 节点 / 480 边规则网格。只抄规则参数
 *     会得到另一座城市（727 栋 vs 752 栋、指纹不同），「打开就这样」不成立。
 *  2. 194 个既有用例以 createDefaultDocument() 的 400 m 场景为基准。把工程基准
 *     改成 800 m 会让大量断言失效，且测试耗时从 ~1.5 分钟涨到 5 分钟以上。
 *  3. 因此 400 m 基准保留给测试与迁移补默认值，用户打开工作台 / 点「重置」
 *     走 createPresetDocument()（见 store.ts::initialDoc / reset）。
 *
 * 预设数据经 parseSceneDocument() 校验后才返回，损坏时开发期直接抛错，
 * 不会静默退回一个「看起来能跑但画面不对」的场景。
 */
import presetJson from '../data/default-scene.json';
import { DEFAULT_SEED, parseSceneDocument } from './schema';
import { fingerprintOf } from './rng';
import { SCHEMA_VERSION, type SceneDocument } from './types';

/** 预设展示名，供 UI / 文档引用 */
export const PRESET_NAME = '未来城市 · 800 × 800 m';

export function createPresetDocument(seed = DEFAULT_SEED): SceneDocument {
  const parsed = parseSceneDocument({ ...presetJson, seed });
  if (!parsed.ok || !parsed.doc) {
    throw new Error(`内置默认场景预设损坏：${parsed.error ?? '未知错误'}`);
  }
  const now = new Date().toISOString();
  return {
    ...parsed.doc,
    schemaVersion: SCHEMA_VERSION,
    id: `scene-${fingerprintOf([seed, now]).toLowerCase()}`,
    name: PRESET_NAME,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  };
}
