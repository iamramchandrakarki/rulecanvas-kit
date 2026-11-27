import type { StateSchema, TransitionSystemModel, VarDef, VerifyResult } from '@rulecanvas/core';
import {
  inspectVerificationSnapshot,
  type VerificationReportGoalStatus,
} from './report.js';
import {
  isPlainObject,
  normalizeStateValue,
  readOwnDataProp,
  snapshotsEqual,
  stringArraysEqual,
} from './safe-input.js';

export type VerdictDeltaClassification =
  | 'repaired'
  | 'verified-with-spec-change'
  | 'vacuous-lockout'
  | 'inconclusive-after-violation'
  | 'still-violated'
  | 'regression'
  | 'unchanged'
  | 'other';

export type VerdictDeltaChangedSection =
  | 'schema'
  | 'initialState'
  | 'invariants'
  | 'goal'
  | 'assumptions'
  | 'bounds'
  | 'rules';

export interface VerdictDeltaEndpoint {
  readonly status: VerifyResult['status'];
  readonly goalStatus: VerificationReportGoalStatus;
  readonly traceLength?: number;
}

export interface VerdictDelta {
  readonly classification: VerdictDeltaClassification;
  readonly before: VerdictDeltaEndpoint;
  readonly after: VerdictDeltaEndpoint;
  readonly changedSections: readonly VerdictDeltaChangedSection[];
  readonly specOrBoundsChanged: boolean;
  readonly rulesChanged: boolean;
  readonly summary: string;
}

export type VerdictDeltaResult =
  | { readonly ok: true; readonly delta: VerdictDelta }
  | { readonly ok: false; readonly reason: string };

type StaleRead = 'missing' | 'true' | 'invalid';

function readStaleFlag(snapshot: unknown): StaleRead {
  if (!isPlainObject(snapshot)) {
    return 'invalid';
  }
  const prop = readOwnDataProp(snapshot, 'stale');
  if (prop.kind === 'accessor') {
    return 'invalid';
  }
  if (prop.kind === 'missing' || prop.value === undefined) {
    return 'missing';
  }
  if (prop.value !== true && prop.value !== false) {
    return 'invalid';
  }
  return prop.value ? 'true' : 'missing';
}

function deepFreezeValue<T>(value: T): T {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  Object.freeze(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      deepFreezeValue(value[i]);
    }
    return value;
  }
  for (const key of Object.keys(value)) {
    deepFreezeValue((value as Record<string, unknown>)[key]);
  }
  return value;
}

function varDefsEqual(a: VarDef, b: VarDef): boolean {
  if (a.kind !== b.kind) {
    return false;
  }
  if (a.kind === 'enum' && b.kind === 'enum') {
    return stringArraysEqual(a.values, b.values);
  }
  if (a.kind === 'int' && b.kind === 'int') {
    return a.min === b.min && a.max === b.max;
  }
  return true;
}

function schemasEqual(a: StateSchema, b: StateSchema): boolean {
  const keysA = Object.keys(a).sort();
  const keysB = Object.keys(b).sort();
  if (!stringArraysEqual(keysA, keysB)) {
    return false;
  }
  for (const key of keysA) {
    const left = a[key];
    const right = b[key];
    if (left === undefined || right === undefined || !varDefsEqual(left, right)) {
      return false;
    }
  }
  return true;
}

function deepValuesEqual(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') {
    return Object.is(normalizeStateValue(a), normalizeStateValue(b));
  }
  if (Object.is(a, b)) {
    return true;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    for (let i = 0; i < a.length; i += 1) {
      if (!deepValuesEqual(a[i], b[i])) {
        return false;
      }
    }
    return true;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keysA = Object.keys(a).sort();
    const keysB = Object.keys(b).sort();
    if (!stringArraysEqual(keysA, keysB)) {
      return false;
    }
    for (const key of keysA) {
      if (!deepValuesEqual(a[key], b[key])) {
        return false;
      }
    }
    return true;
  }
  return false;
}

function invariantsEqual(
  a: TransitionSystemModel['invariants'],
  b: TransitionSystemModel['invariants'],
): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i];
    const right = b[i];
    if (left === undefined || right === undefined) {
      return false;
    }
    if (left.id !== right.id || left.label !== right.label || !deepValuesEqual(left.holds, right.holds)) {
      return false;
    }
  }
  return true;
}

function goalsEqual(
  a: TransitionSystemModel['goal'],
  b: TransitionSystemModel['goal'],
): boolean {
  if (a === undefined || b === undefined) {
    return a === undefined && b === undefined;
  }
  return a.id === b.id && a.label === b.label && deepValuesEqual(a.reached, b.reached);
}

function assumptionsEqual(
  a: TransitionSystemModel['assumptions'],
  b: TransitionSystemModel['assumptions'],
): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i];
    const right = b[i];
    if (left === undefined || right === undefined) {
      return false;
    }
    if (
      left.id !== right.id ||
      left.category !== right.category ||
      left.statement !== right.statement ||
      left.notModeled !== right.notModeled
    ) {
      return false;
    }
  }
  return true;
}

function rulesEqual(
  a: TransitionSystemModel['rules'],
  b: TransitionSystemModel['rules'],
): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i];
    const right = b[i];
    if (left === undefined || right === undefined) {
      return false;
    }
    if (left.id !== right.id || left.label !== right.label) {
      return false;
    }
    if (!deepValuesEqual(left.guard, right.guard)) {
      return false;
    }
    if (left.updates.length !== right.updates.length) {
      return false;
    }
    for (let j = 0; j < left.updates.length; j += 1) {
      const updateLeft = left.updates[j];
      const updateRight = right.updates[j];
      if (updateLeft === undefined || updateRight === undefined) {
        return false;
      }
      if (updateLeft.var !== updateRight.var || !deepValuesEqual(updateLeft.value, updateRight.value)) {
        return false;
      }
    }
  }
  return true;
}

function endpointOf(
  status: VerifyResult['status'],
  goalStatus: VerificationReportGoalStatus,
  traceLength: number | undefined,
): VerdictDeltaEndpoint {
  return Object.freeze({
    status,
    goalStatus,
    ...(traceLength !== undefined ? { traceLength } : {}),
  });
}

function goalNote(after: VerdictDeltaEndpoint): string {
  return after.goalStatus === 'NO_GOAL_DECLARED' ? ' No goal declared.' : '';
}

function buildSummary(
  classification: VerdictDeltaClassification,
  before: VerdictDeltaEndpoint,
  after: VerdictDeltaEndpoint,
  changedSections: readonly VerdictDeltaChangedSection[],
  rulesChanged: boolean,
): string {
  const sectionsText = changedSections.length === 0 ? 'none' : changedSections.join(', ');

  switch (classification) {
    case 'repaired': {
      const base = rulesChanged
        ? 'The verdict changed from VIOLATED to VERIFIED with no change to the schema, initial state, invariants, goal, assumptions, or bounds. The rule set changed, and all declared invariants hold across every reachable state of the new rule set.'
        : 'The verdict changed from VIOLATED to VERIFIED with no change to the schema, initial state, invariants, goal, assumptions, bounds, or rules. The restated VERIFIED verdict was not independently re-run.';
      const goalText =
        after.goalStatus === 'REACHED'
          ? ' The declared goal is reachable in the new rule set.'
          : ' No goal declared.';
      return base + goalText;
    }
    case 'verified-with-spec-change':
      return `The verdict changed from VIOLATED to VERIFIED, but the specification or bounds changed between the snapshots (changed sections: ${sectionsText}). The verdict change cannot be attributed to the rule set alone.${goalNote(after)}`;
    case 'vacuous-lockout':
      return 'The verdict changed from VIOLATED to VERIFIED, but the declared goal is unreachable in every reachable state. Invariants hold while the goal is locked out.';
    case 'inconclusive-after-violation':
      return `The earlier snapshot was VIOLATED and the later snapshot is INCONCLUSIVE at the declared bounds. The earlier counterexample is not shown to be resolved.${goalNote(after)}`;
    case 'still-violated':
      return `Both snapshots are VIOLATED. Changed sections: ${sectionsText}.${goalNote(after)}`;
    case 'regression':
      return `The verdict changed from VERIFIED to VIOLATED. Changed sections: ${sectionsText}.${goalNote(after)}`;
    case 'unchanged':
      return `Both snapshots report the same verdict and goal status, and no compared section changed.${goalNote(after)}`;
    case 'other':
      return `The verdict moved from ${before.status} to ${after.status} with goal status ${after.goalStatus}. Changed sections: ${sectionsText}.${goalNote(after)}`;
  }
}

export function computeVerdictDelta(before: unknown, after: unknown): VerdictDeltaResult {
  try {
    const beforeStale = readStaleFlag(before);
    if (beforeStale === 'invalid') {
      return { ok: false, reason: 'Before snapshot is malformed.' };
    }
    if (beforeStale === 'true') {
      return { ok: false, reason: 'Before snapshot is marked stale.' };
    }
    const afterStale = readStaleFlag(after);
    if (afterStale === 'invalid') {
      return { ok: false, reason: 'After snapshot is malformed.' };
    }
    if (afterStale === 'true') {
      return { ok: false, reason: 'After snapshot is marked stale.' };
    }

    const beforeInspected = inspectVerificationSnapshot(before);
    if (!beforeInspected.ok) {
      const code = beforeInspected.errors[0]?.code ?? 'UNKNOWN';
      return { ok: false, reason: `Before snapshot failed structural validation (${code}).` };
    }
    const afterInspected = inspectVerificationSnapshot(after);
    if (!afterInspected.ok) {
      const code = afterInspected.errors[0]?.code ?? 'UNKNOWN';
      return { ok: false, reason: `After snapshot failed structural validation (${code}).` };
    }

    if (beforeInspected.model.id !== afterInspected.model.id) {
      return { ok: false, reason: 'Snapshots describe unrelated models.' };
    }

    const changedSections: VerdictDeltaChangedSection[] = [];
    if (!schemasEqual(beforeInspected.model.schema, afterInspected.model.schema)) {
      changedSections.push('schema');
    }
    if (!snapshotsEqual(beforeInspected.model.initialState, afterInspected.model.initialState)) {
      changedSections.push('initialState');
    }
    if (!invariantsEqual(beforeInspected.model.invariants, afterInspected.model.invariants)) {
      changedSections.push('invariants');
    }
    if (!goalsEqual(beforeInspected.model.goal, afterInspected.model.goal)) {
      changedSections.push('goal');
    }
    if (!assumptionsEqual(beforeInspected.model.assumptions, afterInspected.model.assumptions)) {
      changedSections.push('assumptions');
    }
    if (
      beforeInspected.options.maxStates !== afterInspected.options.maxStates ||
      beforeInspected.options.maxDepth !== afterInspected.options.maxDepth
    ) {
      changedSections.push('bounds');
    }
    if (!rulesEqual(beforeInspected.model.rules, afterInspected.model.rules)) {
      changedSections.push('rules');
    }

    const frozenSections = Object.freeze([...changedSections]);
    const rulesChanged = changedSections.includes('rules');
    const specOrBoundsChanged = changedSections.some((section) => section !== 'rules');

    const beforeEndpoint = endpointOf(
      beforeInspected.status,
      beforeInspected.goalStatus,
      beforeInspected.traceLength,
    );
    const afterEndpoint = endpointOf(
      afterInspected.status,
      afterInspected.goalStatus,
      afterInspected.traceLength,
    );

    let classification: VerdictDeltaClassification;
    if (beforeInspected.status === 'VIOLATED' && afterInspected.status === 'VERIFIED') {
      if (afterInspected.goalStatus === 'UNREACHABLE') {
        classification = 'vacuous-lockout';
      } else if (specOrBoundsChanged) {
        classification = 'verified-with-spec-change';
      } else if (
        afterInspected.goalStatus === 'REACHED' ||
        afterInspected.goalStatus === 'NO_GOAL_DECLARED'
      ) {
        classification = 'repaired';
      } else {
        classification = 'other';
      }
    } else if (beforeInspected.status === 'VIOLATED' && afterInspected.status === 'INCONCLUSIVE') {
      classification = 'inconclusive-after-violation';
    } else if (beforeInspected.status === 'VIOLATED' && afterInspected.status === 'VIOLATED') {
      classification = 'still-violated';
    } else if (beforeInspected.status === 'VERIFIED' && afterInspected.status === 'VIOLATED') {
      classification = 'regression';
    } else if (
      beforeInspected.status === afterInspected.status &&
      beforeInspected.goalStatus === afterInspected.goalStatus &&
      changedSections.length === 0
    ) {
      classification = 'unchanged';
    } else {
      classification = 'other';
    }

    const summary = buildSummary(
      classification,
      beforeEndpoint,
      afterEndpoint,
      frozenSections,
      rulesChanged,
    );

    const delta: VerdictDelta = {
      classification,
      before: beforeEndpoint,
      after: afterEndpoint,
      changedSections: frozenSections,
      specOrBoundsChanged,
      rulesChanged,
      summary,
    };

    return { ok: true, delta: deepFreezeValue(delta) };
  } catch {
    return { ok: false, reason: 'Snapshot comparison failed due to an unexpected runtime error.' };
  }
}
