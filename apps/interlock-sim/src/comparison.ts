import { verifyModel, type VerifyOptions, type VerifyResult } from '@rulecanvas/core';
import { buildVerdictSummaryView, type VerdictSummaryView } from '@rulecanvas/ui';
import { bsl3AirlockDefaultOptions } from './scenarios/bsl3-airlock.js';
import {
  INTERLOCK_SIM_PRESETS,
  loadInterlockPresetModel,
  type InterlockPresetDescriptor,
} from './presets.js';

export const DEFAULT_VERIFY_OPTIONS: VerifyOptions = bsl3AirlockDefaultOptions;

export interface InterlockPresetComparisonRow {
  readonly preset: InterlockPresetDescriptor;
  readonly result: VerifyResult;
  readonly summary: VerdictSummaryView;
  readonly traceLength: number | null;
  readonly statesExplored: number | null;
  readonly transitionsEvaluated: number | null;
  readonly goalReachable: boolean | undefined;
  readonly outcomeSummary: string;
}

function describeOutcome(preset: InterlockPresetDescriptor, result: VerifyResult): string {
  if (result.status === 'VIOLATED') {
    const sequence = result.trace.map((step) => step.ruleId).join(' -> ');
    return `${result.trace.length}-step breach (${result.violatedInvariantIds.join(', ')}): ${sequence}`;
  }
  if (result.status === 'VERIFIED') {
    if (result.goalReachable === false) {
      return `Invariants hold across ${result.stats.statesExplored} states, but goal_safe_lab_entry is unreachable.`;
    }
    if (result.goalReachable === true) {
      return `All ${result.stats.statesExplored} reachable states satisfy containment and UV invariants with goal_safe_lab_entry reachable.`;
    }
    return `All ${result.stats.statesExplored} reachable states satisfy declared invariants.`;
  }
  if (result.status === 'INCONCLUSIVE') {
    return `Stopped at ${result.reason} (depth ${result.completedDepth}, ${result.frontierRemaining} frontier states remaining).`;
  }
  return `${preset.shortLabel} invalid (${result.errors.length} validation errors).`;
}

export function runInterlockPresetComparison(
  options: VerifyOptions = DEFAULT_VERIFY_OPTIONS,
): readonly InterlockPresetComparisonRow[] {
  return INTERLOCK_SIM_PRESETS.map((preset) => {
    const model = loadInterlockPresetModel(preset.variant);
    const result = verifyModel(model, options);
    const summary = buildVerdictSummaryView(result);
    const traceLength = result.status === 'VIOLATED' ? result.trace.length : null;
    const statesExplored =
      result.status === 'INVALID'
        ? (result.stats?.statesExplored ?? null)
        : result.stats.statesExplored;
    const transitionsEvaluated =
      result.status === 'INVALID'
        ? (result.stats?.transitionsEvaluated ?? null)
        : result.stats.transitionsEvaluated;
    const goalReachable =
      result.status === 'VERIFIED' ||
      result.status === 'VIOLATED' ||
      result.status === 'INCONCLUSIVE'
        ? result.goalReachable
        : undefined;

    return {
      preset,
      result,
      summary,
      traceLength,
      statesExplored,
      transitionsEvaluated,
      goalReachable,
      outcomeSummary: describeOutcome(preset, result),
    };
  });
}
