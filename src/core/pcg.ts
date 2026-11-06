/**
 * PCG Engine 统一入口（兼容层）。
 *
 * V0.1 的扁平流水线已重构为显式阶段 DAG，实现位于 ./pipeline/：
 *   S0 场地 → S1 道路网络 → S2 地块划分 → S3 功能分配
 *   → S4a 多类型建筑 / S4b 多尺寸公园（可并行）
 *   → S5 树木分布 → S6 汇总校验
 *   E1 水系 / E2 地形要素为默认禁用的扩展点。
 *
 * `generateScene(doc)` 签名保持不变，store / UI / 测试无需改动。
 */
export { runPipeline as generateScene } from './pipeline';
export {
  STAGE_GRAPH, STAGE_LABELS, buildStagePlan, validateStageGraph, downstreamOf,
  extensionStatus, validateSpatialLayout, ARCHETYPES, ARCHETYPE_ORDER, MIX_WEIGHTS, stageForPath,
} from './pipeline';
