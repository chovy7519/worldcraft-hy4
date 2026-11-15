/**
 * 功能占比的单一计算口径。
 *
 * 生成阶段、Inspector 展示、命令预设共用这三个函数，避免「面板显示一套、
 * 实际抽样用另一套」。权重是相对值，不要求和为 1：生成前统一归一化，
 * 全零 / 非法值回退到 DEFAULT_LAND_USE_MIX，绝不让 pickWeighted 除以 0。
 */
import {
  BUILT_USE_IDS, DEFAULT_LAND_USE_MIX,
  type BuiltUseId, type LandUseMix, type PipelineRules,
} from './types';

/** 夹紧非法值并归一化；全零回退到内置均衡配比 */
export function normalizeLandUseMix(input: Partial<LandUseMix> | undefined | null): LandUseMix {
  const safe = {} as LandUseMix;
  let total = 0;
  for (const id of BUILT_USE_IDS) {
    const raw = input?.[id];
    const v = typeof raw === 'number' && Number.isFinite(raw) ? Math.max(0, raw) : 0;
    safe[id] = v;
    total += v;
  }
  if (total <= 0) return { ...DEFAULT_LAND_USE_MIX };
  for (const id of BUILT_USE_IDS) safe[id] /= total;
  return safe;
}

/** 供 Inspector 显示：把权重换算成百分比（整数，和为 100） */
export function mixPercentages(input: Partial<LandUseMix> | undefined | null): Record<BuiltUseId, number> {
  const mix = normalizeLandUseMix(input);
  const out = {} as Record<BuiltUseId, number>;
  let assigned = 0;
  for (const id of BUILT_USE_IDS.slice(0, -1)) {
    out[id] = Math.round(mix[id] * 100);
    assigned += out[id];
  }
  out[BUILT_USE_IDS[BUILT_USE_IDS.length - 1]] = 100 - assigned;
  return out;
}

/**
 * 生成阶段唯一入口：preset 模式仍走 MIX_WEIGHTS（默认结果逐位不变），
 * custom 模式用用户可调的 mix。返回的权重和恒为 1。
 */
export function resolveMixWeights(
  landUse: PipelineRules['landUse'],
  presets: Record<string, Record<BuiltUseId, number>>,
): LandUseMix {
  if (landUse.mixMode === 'custom') return normalizeLandUseMix(landUse.mix);
  const preset = presets[landUse.mixPreset];
  return normalizeLandUseMix(preset);
}
