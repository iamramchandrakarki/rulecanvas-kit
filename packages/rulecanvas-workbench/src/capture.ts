import {
  replayTrace,
  stepModel,
  validateModel,
  validateOptions,
  type ModelAssumption,
  type StateSnapshot,
  type TraceStep,
  type TransitionSystemModel,
  type ValidationError,
  type VerifyOptions,
  type VerifyResult,
  type VerifyStats,
} from '@rulecanvas/core';

const MAX_CAPTURE_DEPTH = 128;
const MAX_MODEL_CAPTURE_NODES = 100_000;
const MAX_RESULT_CAPTURE_NODES = 2_500_000;
const RESERVED_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
const POSITIVE_DECIMAL_RE = /^[1-9][0-9]*$/;

export type CapturedRequestResult =
  | {
      readonly ok: true;
      readonly model: TransitionSystemModel;
      readonly options: VerifyOptions;
    }
  | {
      readonly ok: false;
      readonly code: 'CAPTURE_ERROR';
      readonly message: string;
      readonly errors?: readonly ValidationError[];
    };

export type ValidatedResultOutcome =
  | { readonly ok: true; readonly result: VerifyResult }
  | { readonly ok: false; readonly message: string };

interface CaptureBudget {
  visited: number;
  readonly maxNodes: number;
}

function isAccessorDescriptor(desc: PropertyDescriptor): boolean {
  return (
    Object.hasOwn(desc, 'get') ||
    Object.hasOwn(desc, 'set') ||
    desc.get !== undefined ||
    desc.set !== undefined
  );
}

function defineEnumerableData(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function isCanonicalArrayIndex(key: string, length: number): boolean {
  if (key.length === 0) return false;
  if (key.length > 1 && key[0] === '0') return false;
  let value = 0;
  for (let i = 0; i < key.length; i += 1) {
    const code = key.charCodeAt(i);
    if (code < 48 || code > 57) return false;
    value = value * 10 + (code - 48);
    if (value >= length) return false;
  }
  return value >= 0 && value < length;
}

export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Object.isFrozen(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      deepFreeze(value[i]);
    }
    return Object.freeze(value);
  }
  for (const key of Reflect.ownKeys(value)) {
    const desc = Object.getOwnPropertyDescriptor(value, key);
    if (desc !== undefined && !isAccessorDescriptor(desc)) {
      deepFreeze(desc.value);
    }
  }
  return Object.freeze(value);
}

function normalizeNumber(n: number): number {
  return Object.is(n, -0) ? 0 : n;
}

/**
 * Descriptor-safe clone for verification capture and result ownership.
 * Materializes core-admitted own data properties (including dense non-enumerable
 * array data slots) into fresh plain objects and dense arrays so structuredClone
 * and direct execution see identical canonical data without invoking getters.
 */
function detachOwnedValue(
  value: unknown,
  path: string,
  depth: number,
  budget: CaptureBudget,
  ancestors: Set<object>,
  allowNonEnumerableArrayElements: boolean,
): unknown {
  budget.visited += 1;
  if (depth > MAX_CAPTURE_DEPTH || budget.visited > budget.maxNodes) {
    throw new RangeError(`Value exceeded capture depth or node budget at "${path}".`);
  }

  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === 'boolean' || typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Non-finite number at "${path}".`);
    }
    return normalizeNumber(value);
  }
  if (typeof value !== 'object') {
    throw new TypeError(`Unsupported value type "${typeof value}" at "${path}".`);
  }

  if (ancestors.has(value)) {
    throw new TypeError(`Cyclic object reference detected at "${path}".`);
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw new TypeError(`Custom Array prototype is not allowed at "${path}".`);
      }
      const lenDesc = Object.getOwnPropertyDescriptor(value, 'length');
      if (
        lenDesc === undefined ||
        isAccessorDescriptor(lenDesc) ||
        typeof lenDesc.value !== 'number' ||
        !Number.isSafeInteger(lenDesc.value) ||
        lenDesc.value < 0
      ) {
        throw new TypeError(`Invalid array length descriptor at "${path}".`);
      }
      const length = lenDesc.value;
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key === 'symbol') {
          throw new TypeError(`Symbol property on array is not allowed at "${path}".`);
        }
        if (key === 'length') continue;
        if (RESERVED_KEYS.has(key) || !isCanonicalArrayIndex(key, length)) {
          throw new TypeError(`Unexpected array property "${key}" at "${path}".`);
        }
      }
      const out: unknown[] = [];
      for (let i = 0; i < length; i += 1) {
        const desc = Object.getOwnPropertyDescriptor(value, i);
        if (desc === undefined) {
          throw new TypeError(`Sparse array slot at "${path}[${i}]".`);
        }
        if (isAccessorDescriptor(desc)) {
          throw new TypeError(`Accessor array element at "${path}[${i}]".`);
        }
        if (!allowNonEnumerableArrayElements && !desc.enumerable) {
          throw new TypeError(`Non-enumerable array element at "${path}[${i}]".`);
        }
        out.push(
          detachOwnedValue(
            desc.value,
            `${path}[${i}]`,
            depth + 1,
            budget,
            ancestors,
            allowNonEnumerableArrayElements,
          ),
        );
      }
      return out;
    }

    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError(`Non-plain object prototype at "${path}".`);
    }

    const out: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === 'symbol') {
        throw new TypeError(`Symbol property is not allowed at "${path}".`);
      }
      if (RESERVED_KEYS.has(key)) {
        throw new TypeError(`Reserved key "${key}" is not allowed at "${path}".`);
      }
      const desc = Object.getOwnPropertyDescriptor(value, key);
      if (desc === undefined) continue;
      if (isAccessorDescriptor(desc)) {
        throw new TypeError(`Accessor property "${key}" is not allowed at "${path}".`);
      }
      if (!desc.enumerable) {
        throw new TypeError(`Non-enumerable property "${key}" is not allowed at "${path}".`);
      }
      const detachedChild = detachOwnedValue(
        desc.value,
        path === '$' ? key : `${path}.${key}`,
        depth + 1,
        budget,
        ancestors,
        allowNonEnumerableArrayElements,
      );
      defineEnumerableData(out, key, detachedChild);
    }
    return out;
  } finally {
    ancestors.delete(value);
  }
}

export function captureVerificationRequest(
  model: unknown,
  options: unknown,
): CapturedRequestResult {
  try {
    const optBudget: CaptureBudget = { visited: 0, maxNodes: MAX_MODEL_CAPTURE_NODES };
    const detachedOpts = detachOwnedValue(
      options,
      'options',
      0,
      optBudget,
      new Set<object>(),
      false,
    );
    const optionErrors = validateOptions(detachedOpts);
    if (optionErrors.length > 0) {
      return {
        ok: false,
        code: 'CAPTURE_ERROR',
        message: optionErrors[0]?.message ?? 'Verification options failed validation.',
        errors: deepFreeze([...optionErrors]),
      };
    }
    const { maxStates, maxDepth } = detachedOpts as VerifyOptions;
    const cleanOptions: VerifyOptions = deepFreeze({ maxStates, maxDepth });

    const modelBudget: CaptureBudget = { visited: 0, maxNodes: MAX_MODEL_CAPTURE_NODES };
    const detachedModel = detachOwnedValue(
      model,
      '$',
      0,
      modelBudget,
      new Set<object>(),
      true,
    );
    if (typeof detachedModel !== 'object' || detachedModel === null || Array.isArray(detachedModel)) {
      return { ok: false, code: 'CAPTURE_ERROR', message: 'Model must be a plain object.' };
    }
    const modelErrors = validateModel(detachedModel);
    if (modelErrors.length > 0) {
      return {
        ok: false,
        code: 'CAPTURE_ERROR',
        message: modelErrors[0]?.message ?? 'Model failed validation.',
        errors: deepFreeze([...modelErrors]),
      };
    }

    return {
      ok: true,
      model: deepFreeze(detachedModel as TransitionSystemModel),
      options: cleanOptions,
    };
  } catch (err) {
    return {
      ok: false,
      code: 'CAPTURE_ERROR',
      message: err instanceof Error ? err.message : 'Unable to capture verification request.',
    };
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const MAX_CAPTURE_TRACE_STEPS = 10_000;
const MAX_CAPTURE_ERRORS = 100_000;
const MAX_CAPTURE_VIOLATED_IDS = 256;

function hasDefinedProp(obj: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(obj, key) && obj[key] !== undefined;
}

function findForbiddenProp(
  obj: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    if (hasDefinedProp(obj, key)) {
      return key;
    }
  }
  return null;
}

function isSafeIntInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

function validateOwnedAssumptions(
  rawAssumptions: unknown,
  capturedAssumptions: readonly ModelAssumption[],
): boolean {
  if (!Array.isArray(rawAssumptions) || rawAssumptions.length !== capturedAssumptions.length) {
    return false;
  }
  for (let i = 0; i < capturedAssumptions.length; i += 1) {
    const expected = capturedAssumptions[i]!;
    const actual = rawAssumptions[i];
    if (!isPlainRecord(actual)) return false;
    if (
      actual['id'] !== expected.id ||
      actual['category'] !== expected.category ||
      actual['statement'] !== expected.statement ||
      actual['notModeled'] !== expected.notModeled
    ) {
      return false;
    }
  }
  return true;
}

function validateOwnedStateSnapshot(
  rawState: unknown,
  model: TransitionSystemModel,
): rawState is StateSnapshot {
  if (!isPlainRecord(rawState)) return false;
  const schemaKeys = Object.keys(model.schema);
  const stateKeys = Object.keys(rawState);
  if (stateKeys.length !== schemaKeys.length) return false;
  for (const key of schemaKeys) {
    if (!Object.hasOwn(rawState, key)) return false;
    const def = model.schema[key]!;
    const val = rawState[key];
    if (def.kind === 'boolean') {
      if (typeof val !== 'boolean') return false;
    } else if (def.kind === 'enum') {
      if (typeof val !== 'string' || !def.values.includes(val)) return false;
    } else {
      if (typeof val !== 'number' || !Number.isSafeInteger(val) || val < def.min || val > def.max) {
        return false;
      }
    }
  }
  return true;
}

function expectedTheoreticalStates(model: TransitionSystemModel): string {
  let product = 1n;
  for (const name of Object.keys(model.schema)) {
    const def = model.schema[name]!;
    if (def.kind === 'boolean') {
      product *= 2n;
    } else if (def.kind === 'enum') {
      product *= BigInt(def.values.length);
    } else {
      product *= BigInt(def.max) - BigInt(def.min) + 1n;
    }
  }
  return product.toString();
}

function rebuildStateSnapshot(
  rawState: unknown,
  model: TransitionSystemModel,
): StateSnapshot | null {
  if (!validateOwnedStateSnapshot(rawState, model)) return null;
  const source = rawState as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(model.schema)) {
    defineEnumerableData(out, key, source[key]);
  }
  return out as StateSnapshot;
}

function rebuildTraceSteps(
  rawTrace: unknown,
  model: TransitionSystemModel,
): TraceStep[] | null {
  if (!Array.isArray(rawTrace) || rawTrace.length > MAX_CAPTURE_TRACE_STEPS) return null;
  const out: TraceStep[] = [];
  for (let i = 0; i < rawTrace.length; i += 1) {
    const step: unknown = rawTrace[i];
    if (!isPlainRecord(step)) return null;
    const ruleId = step['ruleId'];
    if (typeof ruleId !== 'string') return null;
    const stateBefore = rebuildStateSnapshot(step['stateBefore'], model);
    const stateAfter = rebuildStateSnapshot(step['stateAfter'], model);
    if (stateBefore === null || stateAfter === null) return null;
    const rawChanged = step['changedVars'];
    if (!Array.isArray(rawChanged)) return null;
    const changedVars: string[] = [];
    for (let j = 0; j < rawChanged.length; j += 1) {
      const name: unknown = rawChanged[j];
      if (typeof name !== 'string' || !Object.hasOwn(model.schema, name)) return null;
      changedVars.push(name);
    }
    out.push({ ruleId, stateBefore, stateAfter, changedVars });
  }
  return out;
}

function rebuildAssumptions(
  rawAssumptions: unknown,
  capturedAssumptions: readonly ModelAssumption[],
): ModelAssumption[] | null {
  if (!validateOwnedAssumptions(rawAssumptions, capturedAssumptions)) return null;
  return capturedAssumptions.map((a) => ({
    id: a.id,
    category: a.category,
    statement: a.statement,
    notModeled: a.notModeled,
  }));
}

function rebuildErrors(rawErrors: unknown): ValidationError[] | null {
  if (!validateOwnedErrors(rawErrors)) return null;
  const out: ValidationError[] = [];
  for (let i = 0; i < rawErrors.length; i += 1) {
    const err = rawErrors[i]!;
    out.push({ code: err['code'], path: err['path'], message: err['message'] });
  }
  return out;
}

function rebuildStats(
  rawStats: unknown,
  model: TransitionSystemModel,
  options: VerifyOptions,
): VerifyStats | null {
  if (!validateOwnedStats(rawStats, options)) return null;
  const source = rawStats as Record<string, unknown>;
  const theoreticalStates = source['theoreticalStates'] as string;
  if (theoreticalStates !== expectedTheoreticalStates(model)) return null;
  return {
    theoreticalStates,
    statesExplored: source['statesExplored'] as number,
    transitionsEvaluated: source['transitionsEvaluated'] as number,
    maxDepthReached: source['maxDepthReached'] as number,
    deadlockStatesFound: source['deadlockStatesFound'] as number,
  };
}

function stateSnapshotsEqual(
  left: StateSnapshot,
  right: StateSnapshot,
  model: TransitionSystemModel,
): boolean {
  const keys = Object.keys(model.schema);
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i]!;
    if (left[key] !== right[key]) return false;
  }
  return true;
}

function stringListsEqual(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function traceStepsEqual(
  candidate: readonly TraceStep[],
  expected: readonly TraceStep[],
  model: TransitionSystemModel,
): boolean {
  if (candidate.length !== expected.length) return false;
  for (let i = 0; i < candidate.length; i += 1) {
    const left = candidate[i]!;
    const right = expected[i]!;
    if (left.ruleId !== right.ruleId) return false;
    if (!stateSnapshotsEqual(left.stateBefore, right.stateBefore, model)) return false;
    if (!stateSnapshotsEqual(left.stateAfter, right.stateAfter, model)) return false;
    if (!stringListsEqual(left.changedVars, right.changedVars)) return false;
  }
  return true;
}

function validateOwnedStats(
  rawStats: unknown,
  options: VerifyOptions,
): rawStats is {
  theoreticalStates: string;
  statesExplored: number;
  transitionsEvaluated: number;
  maxDepthReached: number;
  deadlockStatesFound: number;
} {
  if (!isPlainRecord(rawStats)) return false;
  if (
    typeof rawStats['theoreticalStates'] !== 'string' ||
    !POSITIVE_DECIMAL_RE.test(rawStats['theoreticalStates'])
  ) {
    return false;
  }
  if (!isSafeIntInRange(rawStats['statesExplored'], 1, options.maxStates)) return false;
  const statesExplored = rawStats['statesExplored'] as number;
  if (!isSafeIntInRange(rawStats['maxDepthReached'], 0, options.maxDepth)) return false;
  if (
    typeof rawStats['transitionsEvaluated'] !== 'number' ||
    !Number.isSafeInteger(rawStats['transitionsEvaluated']) ||
    rawStats['transitionsEvaluated'] < 0
  ) {
    return false;
  }
  if (
    typeof rawStats['deadlockStatesFound'] !== 'number' ||
    !Number.isSafeInteger(rawStats['deadlockStatesFound']) ||
    rawStats['deadlockStatesFound'] < 0 ||
    rawStats['deadlockStatesFound'] > statesExplored
  ) {
    return false;
  }
  return true;
}

function validateOwnedErrors(rawErrors: unknown): rawErrors is ValidationError[] {
  if (
    !Array.isArray(rawErrors) ||
    rawErrors.length === 0 ||
    rawErrors.length > MAX_CAPTURE_ERRORS
  ) {
    return false;
  }
  for (const err of rawErrors) {
    if (!isPlainRecord(err)) return false;
    if (
      typeof err['code'] !== 'string' ||
      typeof err['path'] !== 'string' ||
      typeof err['message'] !== 'string'
    ) {
      return false;
    }
  }
  return true;
}

function runtimeDiagnosticKey(diagnostic: ValidationError): string {
  return `${diagnostic.code.length}:${diagnostic.code}:${diagnostic.path.length}:${diagnostic.path}:${diagnostic.message}`;
}

export function sanitizeAndFreezeVerifyResult(
  raw: unknown,
  capturedModel: TransitionSystemModel,
  capturedOptions: VerifyOptions,
): ValidatedResultOutcome {
  try {
    const budget: CaptureBudget = { visited: 0, maxNodes: MAX_RESULT_CAPTURE_NODES };
    const owned = detachOwnedValue(raw, 'result', 0, budget, new Set<object>(), false);
    if (!isPlainRecord(owned)) {
      return { ok: false, message: 'Verification result must be a plain object.' };
    }
    const status = owned['status'];
    if (
      status !== 'VERIFIED' &&
      status !== 'VIOLATED' &&
      status !== 'INCONCLUSIVE' &&
      status !== 'INVALID'
    ) {
      return { ok: false, message: 'Verification result has an unrecognized status.' };
    }

    if (status === 'INVALID') {
      const forbidden = findForbiddenProp(owned, [
        'assumptions',
        'goalReachable',
        'terminalState',
        'violatedInvariantIds',
        'reason',
        'completedDepth',
        'frontierRemaining',
      ]);
      if (forbidden !== null) {
        return { ok: false, message: `INVALID result must not include ${forbidden}.` };
      }
      const errors = rebuildErrors(owned['errors']);
      if (errors === null) {
        return { ok: false, message: 'INVALID verification result has malformed diagnostics.' };
      }

      const runtimeErrors = errors.filter((err) => err.code === 'OUT_OF_DOMAIN_TRANSITION');
      if (runtimeErrors.length > 0 && runtimeErrors.length !== errors.length) {
        return {
          ok: false,
          message:
            'INVALID verification result must not mix validation errors with runtime out-of-domain diagnostics.',
        };
      }

      if (runtimeErrors.length === 0) {
        if (hasDefinedProp(owned, 'stats') || hasDefinedProp(owned, 'trace')) {
          return {
            ok: false,
            message: 'Validation INVALID result must not include exploration statistics or traces.',
          };
        }
        const validationResult: VerifyResult = { status: 'INVALID', errors };
        return { ok: true, result: deepFreeze(validationResult) };
      }

      if (!hasDefinedProp(owned, 'stats') || !hasDefinedProp(owned, 'trace')) {
        return {
          ok: false,
          message: 'Runtime out-of-domain INVALID result must include stats and a prefix trace.',
        };
      }
      const stats = rebuildStats(owned['stats'], capturedModel, capturedOptions);
      if (stats === null) {
        return {
          ok: false,
          message: 'INVALID verification result has out-of-bounds or mismatched stats.',
        };
      }

      const rebuiltTrace = rebuildTraceSteps(owned['trace'], capturedModel);
      if (rebuiltTrace === null) {
        return { ok: false, message: 'INVALID verification result has a malformed trace.' };
      }
      // Bounds are checked before any deterministic replay work.
      if (
        rebuiltTrace.length > stats.maxDepthReached ||
        stats.maxDepthReached > capturedOptions.maxDepth
      ) {
        return {
          ok: false,
          message: 'INVALID verification result trace exceeds the captured depth bound.',
        };
      }
      const replay = replayTrace(
        capturedModel,
        rebuiltTrace.map((step) => step.ruleId),
      );
      if (!replay.ok || !traceStepsEqual(rebuiltTrace, replay.steps, capturedModel)) {
        return {
          ok: false,
          message: 'INVALID verification result trace does not replay deterministically.',
        };
      }
      const reproduced = new Set<string>();
      for (const rule of capturedModel.rules) {
        const stepped = stepModel(capturedModel, replay.finalState, rule.id);
        if (!stepped.ok && stepped.error.code === 'OUT_OF_DOMAIN_TRANSITION') {
          reproduced.add(runtimeDiagnosticKey(stepped.error));
        }
      }
      if (
        reproduced.size === 0 ||
        !runtimeErrors.every((diagnostic) => reproduced.has(runtimeDiagnosticKey(diagnostic)))
      ) {
        return {
          ok: false,
          message:
            'INVALID verification result trace does not reproduce its out-of-domain diagnostic.',
        };
      }

      const trace = replay.steps.map((step) => ({
        ruleId: step.ruleId,
        stateBefore: { ...step.stateBefore },
        stateAfter: { ...step.stateAfter },
        changedVars: [...step.changedVars],
      }));
      const result: VerifyResult = {
        status: 'INVALID',
        errors,
        stats,
        trace,
      };
      return { ok: true, result: deepFreeze(result) };
    }

    const stats = rebuildStats(owned['stats'], capturedModel, capturedOptions);
    if (stats === null) {
      return {
        ok: false,
        message: `${status} result has missing, out-of-bounds, or mismatched stats.`,
      };
    }

    const assumptions = rebuildAssumptions(owned['assumptions'], capturedModel.assumptions);
    if (assumptions === null) {
      return {
        ok: false,
        message: `${status} result assumptions do not match the captured model snapshot.`,
      };
    }

    if (status === 'VERIFIED') {
      const forbidden = findForbiddenProp(owned, [
        'trace',
        'terminalState',
        'violatedInvariantIds',
        'reason',
        'completedDepth',
        'frontierRemaining',
        'errors',
      ]);
      if (forbidden !== null) {
        return { ok: false, message: `VERIFIED result must not include ${forbidden}.` };
      }
      const goalReachable = owned['goalReachable'];
      if (goalReachable !== undefined && typeof goalReachable !== 'boolean') {
        return { ok: false, message: 'VERIFIED result has non-boolean goalReachable.' };
      }
      if (capturedModel.goal !== undefined && typeof goalReachable !== 'boolean') {
        return { ok: false, message: 'VERIFIED result is missing goalReachable for declared goal.' };
      }
      if (capturedModel.goal === undefined && goalReachable !== undefined) {
        return { ok: false, message: 'VERIFIED result reported goalReachable without a declared goal.' };
      }
      const result: VerifyResult = {
        status: 'VERIFIED',
        stats,
        ...(typeof goalReachable === 'boolean' ? { goalReachable } : {}),
        assumptions,
      };
      return { ok: true, result: deepFreeze(result) };
    }

    if (status === 'VIOLATED') {
      const forbidden = findForbiddenProp(owned, [
        'reason',
        'completedDepth',
        'frontierRemaining',
        'errors',
      ]);
      if (forbidden !== null) {
        return { ok: false, message: `VIOLATED result must not include ${forbidden}.` };
      }
      const trace = rebuildTraceSteps(owned['trace'], capturedModel);
      if (trace === null) {
        return { ok: false, message: 'VIOLATED result trace is malformed.' };
      }
      // Bounds are checked before any deterministic replay work.
      if (trace.length > stats.maxDepthReached || stats.maxDepthReached > capturedOptions.maxDepth) {
        return { ok: false, message: 'VIOLATED result trace exceeds maxDepthReached.' };
      }
      if (trace.length !== stats.maxDepthReached) {
        return { ok: false, message: 'VIOLATED result trace length must match maxDepthReached.' };
      }
      const terminalState = rebuildStateSnapshot(owned['terminalState'], capturedModel);
      if (terminalState === null) {
        return { ok: false, message: 'VIOLATED result terminalState does not match model schema.' };
      }
      const invIds = new Set(capturedModel.invariants.map((inv) => inv.id));
      const rawViolated = owned['violatedInvariantIds'];
      if (
        !Array.isArray(rawViolated) ||
        rawViolated.length === 0 ||
        rawViolated.length > MAX_CAPTURE_VIOLATED_IDS ||
        !rawViolated.every((id) => typeof id === 'string' && invIds.has(id))
      ) {
        return { ok: false, message: 'VIOLATED result has invalid violatedInvariantIds.' };
      }
      const violatedInvariantIds = rawViolated as string[];

      const replay = replayTrace(
        capturedModel,
        trace.map((step) => step.ruleId),
      );
      if (!replay.ok) {
        return { ok: false, message: 'VIOLATED result trace does not replay deterministically.' };
      }
      if (!traceStepsEqual(trace, replay.steps, capturedModel)) {
        return {
          ok: false,
          message: 'VIOLATED result trace does not match deterministic replay steps.',
        };
      }
      if (!stateSnapshotsEqual(terminalState, replay.finalState, capturedModel)) {
        return {
          ok: false,
          message: 'VIOLATED result terminalState does not match deterministic replay.',
        };
      }
      if (!stringListsEqual(violatedInvariantIds, replay.violatedInvariantIds)) {
        return {
          ok: false,
          message: 'VIOLATED result violatedInvariantIds do not match deterministic replay.',
        };
      }

      const goalReachable = owned['goalReachable'];
      if (
        goalReachable !== undefined &&
        (goalReachable !== true || capturedModel.goal === undefined || trace.length === 0)
      ) {
        return { ok: false, message: 'VIOLATED result has inconsistent goalReachable metadata.' };
      }

      const result: VerifyResult = {
        status: 'VIOLATED',
        trace: replay.steps.map((step) => ({
          ruleId: step.ruleId,
          stateBefore: { ...step.stateBefore },
          stateAfter: { ...step.stateAfter },
          changedVars: [...step.changedVars],
        })),
        terminalState: { ...replay.finalState },
        violatedInvariantIds: [...replay.violatedInvariantIds],
        stats,
        ...(goalReachable === true ? { goalReachable: true as const } : {}),
        assumptions,
      };
      return { ok: true, result: deepFreeze(result) };
    }

    // status === 'INCONCLUSIVE'
    const forbiddenInconclusive = findForbiddenProp(owned, [
      'trace',
      'terminalState',
      'violatedInvariantIds',
      'errors',
    ]);
    if (forbiddenInconclusive !== null) {
      return {
        ok: false,
        message: `INCONCLUSIVE result must not include ${forbiddenInconclusive}.`,
      };
    }
    const reason = owned['reason'];
    if (reason !== 'MAX_STATES' && reason !== 'MAX_DEPTH') {
      return { ok: false, message: 'INCONCLUSIVE result has an unrecognized truncation reason.' };
    }
    if (!isSafeIntInRange(owned['frontierRemaining'], 1, stats.statesExplored)) {
      return { ok: false, message: 'INCONCLUSIVE result frontierRemaining is out of bounds.' };
    }
    const completedDepth = owned['completedDepth'];
    if (typeof completedDepth !== 'number' || !Number.isSafeInteger(completedDepth)) {
      return { ok: false, message: 'INCONCLUSIVE result completedDepth must be a safe integer.' };
    }
    const depthRelationOk =
      completedDepth >= -1 &&
      (completedDepth < stats.maxDepthReached ||
        (stats.maxDepthReached === 0 && completedDepth === -1));
    if (!depthRelationOk) {
      return { ok: false, message: 'INCONCLUSIVE result completedDepth is inconsistent with maxDepthReached.' };
    }
    if (reason === 'MAX_STATES' && stats.statesExplored !== capturedOptions.maxStates) {
      return {
        ok: false,
        message: 'MAX_STATES result does not match captured maxStates bound.',
      };
    }
    if (
      reason === 'MAX_DEPTH' &&
      (stats.maxDepthReached !== capturedOptions.maxDepth ||
        completedDepth !== capturedOptions.maxDepth - 1)
    ) {
      return {
        ok: false,
        message: 'MAX_DEPTH result does not match captured maxDepth bound.',
      };
    }
    const goalReachable = owned['goalReachable'];
    if (
      goalReachable !== undefined &&
      (goalReachable !== true || capturedModel.goal === undefined)
    ) {
      return { ok: false, message: 'INCONCLUSIVE result has inconsistent goalReachable metadata.' };
    }
    const result: VerifyResult = {
      status: 'INCONCLUSIVE',
      reason,
      completedDepth,
      frontierRemaining: owned['frontierRemaining'] as number,
      stats,
      ...(goalReachable === true ? { goalReachable: true as const } : {}),
      assumptions,
    };
    return { ok: true, result: deepFreeze(result) };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : 'Unable to validate verification result.',
    };
  }
}
