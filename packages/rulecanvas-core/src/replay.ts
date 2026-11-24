import {
  applyRule,
  compileModel,
  computeChangedVars,
  encodeState,
  evaluateBool,
  evaluateViolatedInvariants,
  toSnapshot,
  type CompiledModel,
  type CompiledTuple,
} from './eval.js';
import type {
  EnabledTransition,
  EnabledTransitionsResult,
  InitialStateResult,
  ReplayResult,
  StepResult,
  TraceStep,
  ValidationError,
} from './types.js';
import { createUnexpectedInputError, parseModel, parseRuleIds, parseStateSnapshot } from './validate.js';

type ExecutedStep =
  | { readonly ok: true; readonly step: TraceStep; readonly nextTuple: CompiledTuple }
  | { readonly ok: false; readonly error: ValidationError };

function executeRuleStep(
  compiled: CompiledModel,
  preTuple: CompiledTuple,
  ruleId: unknown,
  path: string,
): ExecutedStep {
  if (typeof ruleId !== 'string') {
    return {
      ok: false,
      error: Object.freeze({ code: 'UNKNOWN_RULE', path, message: 'Rule id must be a string.' }),
    };
  }
  const rule = compiled.ruleById.get(ruleId);
  if (rule === undefined) {
    return {
      ok: false,
      error: Object.freeze({ code: 'UNKNOWN_RULE', path, message: `Unknown rule "${ruleId}".` }),
    };
  }
  if (!evaluateBool(rule.guard, preTuple)) {
    return {
      ok: false,
      error: Object.freeze({
        code: 'RULE_DISABLED',
        path,
        message: `Rule "${rule.id}" guard is false in the current state.`,
      }),
    };
  }
  const applied = applyRule(rule, preTuple);
  if (!applied.ok) return { ok: false, error: applied.error };

  return {
    ok: true,
    nextTuple: applied.nextTuple,
    step: {
      ruleId: rule.id,
      stateBefore: toSnapshot(compiled, preTuple),
      stateAfter: toSnapshot(compiled, applied.nextTuple),
      changedVars: computeChangedVars(compiled, preTuple, applied.nextTuple),
    },
  };
}

export function getInitialState(model: unknown): InitialStateResult {
  try {
    const parsedModel = parseModel(model);
    if (!parsedModel.ok) return { ok: false, errors: parsedModel.errors };
    const compiled = compileModel(parsedModel.model);
    return { ok: true, state: toSnapshot(compiled, compiled.initialTuple) };
  } catch {
    return { ok: false, errors: Object.freeze([createUnexpectedInputError()]) };
  }
}

export function getEnabledTransitions(model: unknown, state: unknown): EnabledTransitionsResult {
  try {
    const parsedModel = parseModel(model);
    if (!parsedModel.ok) return { ok: false, errors: parsedModel.errors };

    const parsedState = parseStateSnapshot(parsedModel.model.schema, state, 'state');
    if (!parsedState.ok) return { ok: false, errors: parsedState.errors };

    const compiled = compileModel(parsedModel.model);
    const tuple = encodeState(compiled.vars, parsedState.state);
    const transitions: EnabledTransition[] = [];
    const enabledRuleIds: string[] = [];

    for (let i = 0; i < compiled.rules.length; i += 1) {
      const rule = compiled.rules[i]!;
      const enabled = evaluateBool(rule.guard, tuple);
      transitions.push({ ruleId: rule.id, label: rule.label, enabled });
      if (enabled) enabledRuleIds.push(rule.id);
    }
    return { ok: true, transitions, enabledRuleIds };
  } catch {
    return { ok: false, errors: Object.freeze([createUnexpectedInputError()]) };
  }
}

export function stepModel(model: unknown, state: unknown, ruleId: unknown): StepResult {
  try {
    const parsedModel = parseModel(model);
    if (!parsedModel.ok) return { ok: false, error: parsedModel.errors[0]!, errors: parsedModel.errors };

    const parsedState = parseStateSnapshot(parsedModel.model.schema, state, 'state');
    if (!parsedState.ok) return { ok: false, error: parsedState.errors[0]!, errors: parsedState.errors };

    const compiled = compileModel(parsedModel.model);
    const preTuple = encodeState(compiled.vars, parsedState.state);
    const executed = executeRuleStep(compiled, preTuple, ruleId, 'ruleId');
    return executed.ok ? { ok: true, step: executed.step } : { ok: false, error: executed.error };
  } catch {
    const err = createUnexpectedInputError();
    return { ok: false, error: err, errors: Object.freeze([err]) };
  }
}

export function replayTrace(model: unknown, ruleIds: unknown): ReplayResult {
  try {
    const parsedModel = parseModel(model);
    if (!parsedModel.ok) {
      return { ok: false, stepIndex: -1, error: parsedModel.errors[0]!, errors: parsedModel.errors, steps: [] };
    }

    const parsedRuleIds = parseRuleIds(ruleIds);
    if (!parsedRuleIds.ok) {
      return {
        ok: false,
        stepIndex: parsedRuleIds.stepIndex,
        error: parsedRuleIds.errors[0]!,
        errors: parsedRuleIds.errors,
        steps: [],
      };
    }

    const compiled = compileModel(parsedModel.model);
    let currentTuple = compiled.initialTuple;
    const steps: TraceStep[] = [];

    for (let i = 0; i < parsedRuleIds.ruleIds.length; i += 1) {
      const executed = executeRuleStep(compiled, currentTuple, parsedRuleIds.ruleIds[i]!, `ruleIds[${i}]`);
      if (!executed.ok) {
        return { ok: false, stepIndex: i, error: executed.error, steps };
      }
      steps.push(executed.step);
      currentTuple = executed.nextTuple;
    }

    if (parsedRuleIds.malformedEntry !== undefined) {
      return {
        ok: false,
        stepIndex: parsedRuleIds.malformedEntry.stepIndex,
        error: parsedRuleIds.malformedEntry.error,
        errors: parsedRuleIds.malformedEntry.errors,
        steps,
      };
    }

    const finalState = toSnapshot(compiled, currentTuple);
    const violatedInvariantIds = evaluateViolatedInvariants(compiled, currentTuple);
    return {
      ok: true,
      steps,
      finalState,
      violatedInvariantIds,
      ...(compiled.goal !== null ? { goalReached: evaluateBool(compiled.goal.reached, currentTuple) } : {}),
    };
  } catch {
    const err = createUnexpectedInputError();
    return {
      ok: false,
      stepIndex: -1,
      error: err,
      errors: Object.freeze([err]),
      steps: [],
    };
  }
}
