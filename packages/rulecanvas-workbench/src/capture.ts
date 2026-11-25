import {
  validateModel,
  type ModelAssumption,
  type StateSnapshot,
  type TraceStep,
  type TransitionSystemModel,
  type ValidationError,
  type VerifyOptions,
  type VerifyResult,
} from '@rulecanvas/core';

const MAX_CAPTURE_DEPTH = 64;
const MAX_CAPTURE_NODES = 100_000;
const RESERVED_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

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
  if (depth > MAX_CAPTURE_DEPTH || budget.visited > MAX_CAPTURE_NODES) {
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
    const optBudget: CaptureBudget = { visited: 0 };
    const detachedOpts = detachOwnedValue(
      options,
      'options',
      0,
      optBudget,
      new Set<object>(),
      false,
    );
    if (typeof detachedOpts !== 'object' || detachedOpts === null || Array.isArray(detachedOpts)) {
      return { ok: false, code: 'CAPTURE_ERROR', message: 'Verification options must be a plain object.' };
    }
    const optsRec = detachedOpts as Record<string, unknown>;
    const maxStates = optsRec['maxStates'];
    const maxDepth = optsRec['maxDepth'];
    if (
      typeof maxStates !== 'number' ||
      !Number.isSafeInteger(maxStates) ||
      maxStates < 1
    ) {
      return {
        ok: false,
        code: 'CAPTURE_ERROR',
        message: 'Verification option maxStates must be a safe integer >= 1.',
      };
    }
    if (typeof maxDepth !== 'number' || !Number.isSafeInteger(maxDepth) || maxDepth < 0) {
      return {
        ok: false,
        code: 'CAPTURE_ERROR',
        message: 'Verification option maxDepth must be a safe integer >= 0.',
      };
    }
    const cleanOptions: VerifyOptions = deepFreeze({
      maxStates: normalizeNumber(maxStates),
      maxDepth: normalizeNumber(maxDepth),
    });

    const modelBudget: CaptureBudget = { visited: 0 };
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

function validateOwnedTrace(
  rawTrace: unknown,
  model: TransitionSystemModel,
  maxAllowedLen: number,
): rawTrace is TraceStep[] {
  if (!Array.isArray(rawTrace) || rawTrace.length > maxAllowedLen) return false;
  const ruleIds = new Set(model.rules.map((r) => r.id));
  const schemaKeys = new Set(Object.keys(model.schema));
  for (let i = 0; i < rawTrace.length; i += 1) {
    const step = rawTrace[i];
    if (!isPlainRecord(step)) return false;
    if (typeof step['ruleId'] !== 'string' || !ruleIds.has(step['ruleId'])) return false;
    if (!validateOwnedStateSnapshot(step['state'], model)) return false;
    if (!Array.isArray(step['changedVars'])) return false;
    for (const v of step['changedVars']) {
      if (typeof v !== 'string' || !schemaKeys.has(v)) return false;
    }
  }
  return true;
}

function validateOwnedStats(
  rawStats: unknown,
  options: VerifyOptions,
): rawStats is { statesExplored: number; transitionsEvaluated: number; maxDepthReached: number } {
  if (!isPlainRecord(rawStats)) return false;
  if (!isSafeIntInRange(rawStats['statesExplored'], 1, options.maxStates)) return false;
  if (!isSafeIntInRange(rawStats['maxDepthReached'], 0, options.maxDepth)) return false;
  if (
    typeof rawStats['transitionsEvaluated'] !== 'number' ||
    !Number.isSafeInteger(rawStats['transitionsEvaluated']) ||
    rawStats['transitionsEvaluated'] < 0
  ) {
    return false;
  }
  return true;
}

function validateOwnedErrors(rawErrors: unknown): rawErrors is ValidationError[] {
  if (!Array.isArray(rawErrors) || rawErrors.length === 0) return false;
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

export function sanitizeAndFreezeVerifyResult(
  raw: unknown,
  capturedModel: TransitionSystemModel,
  capturedOptions: VerifyOptions,
): ValidatedResultOutcome {
  try {
    const budget: CaptureBudget = { visited: 0 };
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
      if (!validateOwnedErrors(owned['errors'])) {
        return { ok: false, message: 'INVALID verification result has malformed diagnostics.' };
      }
      if (owned['stats'] !== undefined && !validateOwnedStats(owned['stats'], capturedOptions)) {
        return { ok: false, message: 'INVALID verification result has out-of-bounds stats.' };
      }
      if (owned['trace'] !== undefined) {
        const stats = owned['stats'] as { maxDepthReached: number } | undefined;
        const maxTraceLen = stats !== undefined ? stats.maxDepthReached : capturedOptions.maxDepth;
        if (!validateOwnedTrace(owned['trace'], capturedModel, maxTraceLen)) {
          return { ok: false, message: 'INVALID verification result has a malformed trace.' };
        }
      }
      return { ok: true, result: deepFreeze(owned as unknown as VerifyResult) };
    }

    if (!validateOwnedStats(owned['stats'], capturedOptions)) {
      return { ok: false, message: `${status} result has missing or out-of-bounds stats.` };
    }
    const stats = owned['stats'];

    if (!validateOwnedAssumptions(owned['assumptions'], capturedModel.assumptions)) {
      return {
        ok: false,
        message: `${status} result assumptions do not match the captured model snapshot.`,
      };
    }

    if (status === 'VERIFIED') {
      if (owned['goalReachable'] !== undefined && typeof owned['goalReachable'] !== 'boolean') {
        return { ok: false, message: 'VERIFIED result has non-boolean goalReachable.' };
      }
      if (capturedModel.goal !== undefined && typeof owned['goalReachable'] !== 'boolean') {
        return { ok: false, message: 'VERIFIED result is missing goalReachable for declared goal.' };
      }
      if (capturedModel.goal === undefined && owned['goalReachable'] !== undefined) {
        return { ok: false, message: 'VERIFIED result reported goalReachable without a declared goal.' };
      }
      return { ok: true, result: deepFreeze(owned as unknown as VerifyResult) };
    }

    if (status === 'VIOLATED') {
      if (!validateOwnedTrace(owned['trace'], capturedModel, stats.maxDepthReached)) {
        return { ok: false, message: 'VIOLATED result trace is malformed or exceeds maxDepthReached.' };
      }
      if (!validateOwnedStateSnapshot(owned['terminalState'], capturedModel)) {
        return { ok: false, message: 'VIOLATED result terminalState does not match model schema.' };
      }
      const invIds = new Set(capturedModel.invariants.map((inv) => inv.id));
      if (
        !Array.isArray(owned['violatedInvariantIds']) ||
        owned['violatedInvariantIds'].length === 0 ||
        !owned['violatedInvariantIds'].every((id) => typeof id === 'string' && invIds.has(id))
      ) {
        return { ok: false, message: 'VIOLATED result has invalid violatedInvariantIds.' };
      }
      if (owned['goalReachable'] !== undefined && owned['goalReachable'] !== true) {
        return { ok: false, message: 'VIOLATED result goalReachable may only be true when present.' };
      }
      return { ok: true, result: deepFreeze(owned as unknown as VerifyResult) };
    }

    // status === 'INCONCLUSIVE'
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
    if (owned['goalReachable'] !== undefined && owned['goalReachable'] !== true) {
      return { ok: false, message: 'INCONCLUSIVE result goalReachable may only be true when present.' };
    }
    return { ok: true, result: deepFreeze(owned as unknown as VerifyResult) };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : 'Unable to validate verification result.',
    };
  }
}
