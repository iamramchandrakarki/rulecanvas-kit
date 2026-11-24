import {
  applyRule,
  compileModel,
  computeChangedVars,
  evaluateBool,
  evaluateViolatedInvariants,
  toSnapshot,
  tupleKey,
  type CompiledModel,
  type CompiledTuple,
} from './eval.js';
import type {
  TraceStep,
  ValidationError,
  VerifyResult,
  VerifyStats,
} from './types.js';
import { createUnexpectedInputError, parseModel, parseOptions } from './validate.js';

function reconstructTrace(
  compiled: CompiledModel,
  states: readonly CompiledTuple[],
  parentState: readonly number[],
  parentRule: readonly number[],
  targetIndex: number,
): readonly TraceStep[] {
  const reversed: number[] = [];
  let current = targetIndex;
  while (parentState[current]! !== -1) {
    reversed.push(current);
    current = parentState[current]!;
  }

  const steps: TraceStep[] = [];
  for (let i = reversed.length - 1; i >= 0; i -= 1) {
    const afterIdx = reversed[i]!;
    const beforeIdx = parentState[afterIdx]!;
    const ruleIdx = parentRule[afterIdx]!;
    const beforeTuple = states[beforeIdx]!;
    const afterTuple = states[afterIdx]!;
    steps.push({
      ruleId: compiled.rules[ruleIdx]!.id,
      stateBefore: toSnapshot(compiled, beforeTuple),
      stateAfter: toSnapshot(compiled, afterTuple),
      changedVars: computeChangedVars(compiled, beforeTuple, afterTuple),
    });
  }
  return steps;
}

export function verifyModel(model: unknown, options: unknown): VerifyResult {
  try {
    const parsedModel = parseModel(model);
    const parsedOptions = parseOptions(options);
    if (!parsedModel.ok || !parsedOptions.ok) {
      const errors: ValidationError[] = [];
      if (!parsedModel.ok) {
        for (let i = 0; i < parsedModel.errors.length; i += 1) {
          errors.push(parsedModel.errors[i]!);
        }
      }
      if (!parsedOptions.ok) {
        for (let i = 0; i < parsedOptions.errors.length; i += 1) {
          errors.push(parsedOptions.errors[i]!);
        }
      }
      return { status: 'INVALID', errors: Object.freeze(errors) };
    }

    const validOptions = parsedOptions.options;
    const compiled = compileModel(parsedModel.model);
    const s0 = compiled.initialTuple;

    const initialViolations = evaluateViolatedInvariants(compiled, s0);
    if (initialViolations.length > 0) {
      return {
        status: 'VIOLATED',
        trace: [],
        terminalState: toSnapshot(compiled, s0),
        violatedInvariantIds: initialViolations,
        stats: {
          theoreticalStates: compiled.theoreticalStates,
          statesExplored: 1,
          transitionsEvaluated: 0,
          maxDepthReached: 0,
          deadlockStatesFound: 0,
        },
        assumptions: compiled.assumptions,
      };
    }

    let goalWitnessed = compiled.goal !== null && evaluateBool(compiled.goal.reached, s0);

    const states: CompiledTuple[] = [s0];
    const parentState: number[] = [-1];
    const parentRule: number[] = [-1];
    const depths: number[] = [0];
    const visited = new Map<string, number>();
    visited.set(tupleKey(s0), 0);

    let head = 0;
    let transitionsEvaluated = 0;
    let maxDepthReached = 0;
    let deadlockStatesFound = 0;

    const currentStats = (): VerifyStats => ({
      theoreticalStates: compiled.theoreticalStates,
      statesExplored: states.length,
      transitionsEvaluated,
      maxDepthReached,
      deadlockStatesFound,
    });

    while (head < states.length) {
      const u = head;
      const uTuple = states[u]!;
      const d = depths[u]!;
      let enabledCount = 0;

      for (let rIdx = 0; rIdx < compiled.rules.length; rIdx += 1) {
        const rule = compiled.rules[rIdx]!;
        if (!evaluateBool(rule.guard, uTuple)) continue;

        enabledCount += 1;
        transitionsEvaluated += 1;

        const applied = applyRule(rule, uTuple);
        if (!applied.ok) {
          return {
            status: 'INVALID',
            errors: Object.freeze([applied.error]),
            stats: currentStats(),
            trace: reconstructTrace(compiled, states, parentState, parentRule, u),
          };
        }

        const vTuple = applied.nextTuple;
        const key = tupleKey(vTuple);
        if (visited.has(key)) continue;

        const nextDepth = d + 1;
        const limitReason =
          nextDepth > validOptions.maxDepth
            ? 'MAX_DEPTH'
            : states.length >= validOptions.maxStates
              ? 'MAX_STATES'
              : null;
        if (limitReason !== null) {
          return {
            status: 'INCONCLUSIVE',
            reason: limitReason,
            completedDepth: d - 1,
            frontierRemaining: states.length - head,
            stats: currentStats(),
            ...(goalWitnessed ? { goalReachable: true as const } : {}),
            assumptions: compiled.assumptions,
          };
        }

        const vIdx = states.length;
        states.push(vTuple);
        parentState.push(u);
        parentRule.push(rIdx);
        depths.push(nextDepth);
        visited.set(key, vIdx);
        if (nextDepth > maxDepthReached) maxDepthReached = nextDepth;

        const violations = evaluateViolatedInvariants(compiled, vTuple);
        if (violations.length > 0) {
          return {
            status: 'VIOLATED',
            trace: reconstructTrace(compiled, states, parentState, parentRule, vIdx),
            terminalState: toSnapshot(compiled, vTuple),
            violatedInvariantIds: violations,
            stats: currentStats(),
            ...(goalWitnessed ? { goalReachable: true as const } : {}),
            assumptions: compiled.assumptions,
          };
        }

        if (compiled.goal !== null && !goalWitnessed && evaluateBool(compiled.goal.reached, vTuple)) {
          goalWitnessed = true;
        }
      }

      if (enabledCount === 0) deadlockStatesFound += 1;
      head += 1;
    }

    return {
      status: 'VERIFIED',
      stats: currentStats(),
      ...(compiled.goal !== null ? { goalReachable: goalWitnessed } : {}),
      assumptions: compiled.assumptions,
    };
  } catch {
    return { status: 'INVALID', errors: Object.freeze([createUnexpectedInputError()]) };
  }
}
