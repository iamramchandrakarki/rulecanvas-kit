import { verifyModel, type VerifyOptions, type VerifyResult } from '@rulecanvas/core';
import { buildVerdictSummaryView, type VerdictSummaryView } from '@rulecanvas/ui';
import { AGENT_GATE_PRESETS, loadPresetModel, type PresetDescriptor } from './presets.js';

export const DEFAULT_VERIFY_OPTIONS: VerifyOptions = {
  maxStates: 10_000,
  maxDepth: 50,
};

export interface PresetComparisonRow {
  readonly preset: PresetDescriptor;
  readonly result: VerifyResult;
  readonly summary: VerdictSummaryView;
  readonly traceLength: number | null;
  readonly statesExplored: number | null;
  readonly goalReachable: boolean | undefined;
  readonly bypassSummary: string;
}

function describeOutcome(preset: PresetDescriptor, result: VerifyResult): string {
  if (result.status === 'VIOLATED') {
    const sequence = result.trace.map((step) => step.ruleId).join(' -> ');
    return `${result.trace.length}-step counterexample: ${sequence}`;
  }
  if (result.status === 'VERIFIED') {
    if (result.goalReachable === false) {
      return `Invariants hold across ${result.stats.statesExplored} states, but goal is unreachable (vacuous lock).`;
    }
    if (result.goalReachable === true) {
      return `All ${result.stats.statesExplored} reachable states satisfy invariants with clean release goal reachable.`;
    }
    return `All ${result.stats.statesExplored} reachable states satisfy declared invariants.`;
  }
  if (result.status === 'INCONCLUSIVE') {
    return `Stopped at ${result.reason} (completed depth ${result.completedDepth}, ${result.frontierRemaining} frontier remaining).`;
  }
  return `${preset.shortLabel} invalid (${result.errors.length} validation errors).`;
}

export function runPresetComparison(
  options: VerifyOptions = DEFAULT_VERIFY_OPTIONS,
): readonly PresetComparisonRow[] {
  return AGENT_GATE_PRESETS.map((preset) => {
    const model = loadPresetModel(preset.variant);
    const result = verifyModel(model, options);
    const summary = buildVerdictSummaryView(result);
    const traceLength = result.status === 'VIOLATED' ? result.trace.length : null;
    const statesExplored =
      result.status === 'INVALID'
        ? (result.stats?.statesExplored ?? null)
        : result.stats.statesExplored;
    const goalReachable =
      result.status === 'VERIFIED'
        ? result.goalReachable
        : result.status === 'VIOLATED' || result.status === 'INCONCLUSIVE'
          ? result.goalReachable
          : undefined;

    return {
      preset,
      result,
      summary,
      traceLength,
      statesExplored,
      goalReachable,
      bypassSummary: describeOutcome(preset, result),
    };
  });
}
