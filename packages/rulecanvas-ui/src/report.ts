import {
  replayTrace,
  stepModel,
  validateModel,
  validateOptions,
  verifyModel,
  type ModelAssumption,
  type StateSchema,
  type StateSnapshot,
  type StateValue,
  type TraceStep,
  type TransitionSystemModel,
  type ValidationError,
  type VarDef,
  type VerifyOptions,
  type VerifyResult,
  type VerifyStats,
} from '@rulecanvas/core';
import { formatBoolExpr, formatStateValue } from './format.js';
import {
  cloneAndFreezeSnapshot,
  deepCloneAndFreezeModel,
  isPlainObject,
  normalizeStateValue,
  readOwnDataProp,
  readOwnStringArray,
  readSafeArray,
  snapshotsEqual,
  stringArraysEqual,
  type OwnPropRead,
} from './safe-input.js';

export const VERIFICATION_REPORT_SCHEMA_VERSION = '1.0.0';

const MAX_TRACE_STEPS = 10_000;
const MAX_ASSUMPTIONS = 64;
const MAX_CHANGED_VARS = 256;
const MAX_VALIDATION_ERRORS = 100_000;
const MAX_FILENAME_STEM = 64;

export type VerificationReportProvenance = 'validated-snapshot' | 'recomputed-core';

export type VerificationReportGoalStatus =
  | 'REACHED'
  | 'UNREACHABLE'
  | 'WITNESSED_ON_PREFIX'
  | 'NOT_EVALUATED'
  | 'NO_GOAL_DECLARED';

export interface VerificationReportGoalRef {
  readonly id: string;
  readonly label: string;
  readonly expression: string;
}

export interface VerificationReportInvariantRef {
  readonly id: string;
  readonly label: string;
  readonly expression: string;
}

export interface VerificationReportModelSummary {
  readonly id: string;
  readonly name: string;
  readonly schema: StateSchema;
  readonly initialState: StateSnapshot;
  readonly variableCount: number;
  readonly ruleCount: number;
  readonly invariantCount: number;
  readonly hasGoal: boolean;
  readonly goal?: VerificationReportGoalRef;
}

export interface VerificationReportTraceDiff {
  readonly variable: string;
  readonly before: StateValue;
  readonly after: StateValue;
}

export interface VerificationReportTraceStep {
  readonly stepIndex: number;
  readonly ruleId: string;
  readonly ruleLabel: string;
  readonly stateBefore: StateSnapshot;
  readonly stateAfter: StateSnapshot;
  readonly changedVars: readonly string[];
  readonly diffs: readonly VerificationReportTraceDiff[];
}

export interface VerificationReportInconclusive {
  readonly reason: 'MAX_STATES' | 'MAX_DEPTH';
  readonly completedDepth: number;
  readonly frontierRemaining: number;
}

export interface VerificationReport<
  P extends VerificationReportProvenance = VerificationReportProvenance,
> {
  readonly schemaVersion: typeof VERIFICATION_REPORT_SCHEMA_VERSION;
  readonly provenance: P;
  readonly proofScopeNotice: string;
  readonly executionMode?: 'worker' | 'main-thread';
  readonly bigIntEncoding: 'decimal-string';
  readonly model: VerificationReportModelSummary;
  readonly bounds: VerifyOptions;
  readonly verdict: VerifyResult['status'];
  readonly goalStatus: VerificationReportGoalStatus;
  readonly vacuousGoalWarning: boolean;
  readonly vacuousWarningMessage?: string;
  readonly stats?: VerifyStats;
  readonly violatedInvariantIds: readonly string[];
  readonly violatedInvariants: readonly VerificationReportInvariantRef[];
  readonly trace?: readonly VerificationReportTraceStep[];
  readonly terminalState?: StateSnapshot;
  readonly inconclusive?: VerificationReportInconclusive;
  readonly invalidKind?: 'validation' | 'runtime-out-of-domain';
  readonly errors: readonly ValidationError[];
  readonly assumptions: readonly ModelAssumption[];
  readonly notModeled: readonly string[];
  readonly scopeDisclaimer: string;
}

export type ReportBuildResult<
  P extends VerificationReportProvenance = VerificationReportProvenance,
> =
  | { readonly ok: true; readonly report: VerificationReport<P> }
  | { readonly ok: false; readonly errors: readonly ValidationError[] };

const TRUSTED_REPORTS = new WeakSet<VerificationReport>();

const EMPTY_STRINGS: readonly string[] = Object.freeze([]);
const EMPTY_ERRORS: readonly ValidationError[] = Object.freeze([]);
const EMPTY_TRACE_STEPS: readonly TraceStep[] = Object.freeze([]);

const SNAPSHOT_PROOF_SCOPE_NOTICE =
  'This report restates a structurally validated verification snapshot. Trace replay checks VIOLATED counterexample consistency, and runtime INVALID prefixes only; it does not independently establish VERIFIED, INCONCLUSIVE, or INVALID verdicts. The verdict is only as reliable as the snapshot it restates.';

const RECOMPUTED_PROOF_SCOPE_NOTICE =
  'This report was produced by calling @rulecanvas/core verifyModel directly on the validated model under the declared bounds and assumptions. The verdict, statistics, and trace in this report are the result of that call.';

const VACUOUS_WARNING_MESSAGE =
  'The declared goal is unreachable in every reachable state of this model. Invariants hold, but the goal predicate is never satisfied; this verdict is not evidence that the goal is achievable.';

const SCOPE_DISCLAIMER =
  'This report describes only the declared finite model under the listed assumptions. It does not describe or vouch for any real-world system, and no third-party certification is implied.';

// ---------------------------------------------------------------------------
// Descriptor-safe inspection helpers
// ---------------------------------------------------------------------------

type InspectFailure = { readonly ok: false; readonly errors: readonly ValidationError[] };

function reportError(code: string, path: string, message: string): ValidationError {
  return Object.freeze({ code, path, message });
}

function failure(code: string, path: string, message: string): InspectFailure {
  return { ok: false, errors: Object.freeze([reportError(code, path, message)]) };
}

function inspectPlainRecord(value: unknown): Record<string, unknown> | null {
  if (!isPlainObject(value)) {
    return null;
  }
  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    if (typeof key === 'symbol') {
      return null;
    }
    const desc = Object.getOwnPropertyDescriptor(value, key);
    if (desc === undefined || 'get' in desc || 'set' in desc) {
      return null;
    }
  }
  return value;
}

function readPreferredField(
  record: Record<string, unknown>,
  primary: string,
  fallback: string,
): OwnPropRead {
  const primaryRead = readOwnDataProp(record, primary);
  if (primaryRead.kind === 'accessor') {
    return primaryRead;
  }
  if (primaryRead.kind === 'value' && primaryRead.value !== undefined) {
    return primaryRead;
  }
  return readOwnDataProp(record, fallback);
}

type DefinedPropRead = 'missing' | 'defined' | 'accessor';

function hasDefinedProp(record: Record<string, unknown>, key: string): DefinedPropRead {
  const prop = readOwnDataProp(record, key);
  if (prop.kind === 'accessor') {
    return 'accessor';
  }
  if (prop.kind === 'value' && prop.value !== undefined) {
    return 'defined';
  }
  return 'missing';
}

function rejectForbiddenProps(
  record: Record<string, unknown>,
  keys: readonly string[],
  status: string,
): InspectFailure | null {
  for (const key of keys) {
    const read = hasDefinedProp(record, key);
    if (read === 'accessor') {
      return failure(
        'INVALID_RESULT',
        `result.${key}`,
        `${status} result must not declare ${key} through an accessor.`,
      );
    }
    if (read === 'defined') {
      return failure(
        'INVALID_RESULT',
        `result.${key}`,
        `${status} result must not include ${key}.`,
      );
    }
  }
  return null;
}

function canonicalizeModel(raw: unknown): { readonly ok: true; readonly model: TransitionSystemModel } | InspectFailure {
  const errors = validateModel(raw);
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  try {
    return { ok: true, model: deepCloneAndFreezeModel(raw as TransitionSystemModel) };
  } catch {
    return failure('INVALID_MODEL', 'model', 'Model could not be cloned as plain data.');
  }
}

function canonicalizeOptions(
  raw: unknown,
): { readonly ok: true; readonly options: VerifyOptions } | InspectFailure {
  const errors = validateOptions(raw);
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  const record = inspectPlainRecord(raw);
  if (record === null) {
    return failure('INVALID_OPTIONS', 'options', 'Verify options must be a plain data object.');
  }
  const maxStatesProp = readOwnDataProp(record, 'maxStates');
  const maxDepthProp = readOwnDataProp(record, 'maxDepth');
  if (
    maxStatesProp.kind !== 'value' ||
    typeof maxStatesProp.value !== 'number' ||
    maxDepthProp.kind !== 'value' ||
    typeof maxDepthProp.value !== 'number'
  ) {
    return failure('INVALID_OPTIONS', 'options', 'Verify options must declare maxStates and maxDepth.');
  }
  return {
    ok: true,
    options: Object.freeze({
      maxStates: maxStatesProp.value,
      maxDepth: maxDepthProp.value,
    }),
  };
}

function computeTheoreticalStates(schema: StateSchema): string {
  let product = 1n;
  for (const name of Object.keys(schema)) {
    const def = schema[name];
    if (def === undefined) {
      continue;
    }
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

function canonicalizeStats(
  raw: unknown,
  model: TransitionSystemModel,
): { readonly ok: true; readonly stats: VerifyStats } | InspectFailure {
  const record = inspectPlainRecord(raw);
  if (record === null) {
    return failure('INVALID_STATS', 'result.stats', 'Verification statistics must be a plain data object.');
  }
  const theoreticalProp = readOwnDataProp(record, 'theoreticalStates');
  const exploredProp = readOwnDataProp(record, 'statesExplored');
  const transitionsProp = readOwnDataProp(record, 'transitionsEvaluated');
  const depthProp = readOwnDataProp(record, 'maxDepthReached');
  const deadlocksProp = readOwnDataProp(record, 'deadlockStatesFound');
  if (
    theoreticalProp.kind !== 'value' ||
    typeof theoreticalProp.value !== 'string' ||
    exploredProp.kind !== 'value' ||
    typeof exploredProp.value !== 'number' ||
    !Number.isSafeInteger(exploredProp.value) ||
    exploredProp.value < 0 ||
    transitionsProp.kind !== 'value' ||
    typeof transitionsProp.value !== 'number' ||
    !Number.isSafeInteger(transitionsProp.value) ||
    transitionsProp.value < 0 ||
    depthProp.kind !== 'value' ||
    typeof depthProp.value !== 'number' ||
    !Number.isSafeInteger(depthProp.value) ||
    depthProp.value < 0 ||
    deadlocksProp.kind !== 'value' ||
    typeof deadlocksProp.value !== 'number' ||
    !Number.isSafeInteger(deadlocksProp.value) ||
    deadlocksProp.value < 0
  ) {
    return failure('INVALID_STATS', 'result.stats', 'Verification statistics are malformed.');
  }

  const expected = computeTheoreticalStates(model.schema);
  if (theoreticalProp.value !== expected) {
    return failure(
      'STATS_SCHEMA_MISMATCH',
      'result.stats.theoreticalStates',
      'Reported theoretical state count does not match the exact product of the declared schema domains.',
    );
  }

  return {
    ok: true,
    stats: Object.freeze({
      theoreticalStates: expected,
      statesExplored: exploredProp.value,
      transitionsEvaluated: transitionsProp.value,
      maxDepthReached: depthProp.value,
      deadlockStatesFound: deadlocksProp.value,
    }),
  };
}

function statsRespectBounds(stats: VerifyStats, options: VerifyOptions): boolean {
  return (
    stats.statesExplored >= 1 &&
    stats.statesExplored <= options.maxStates &&
    stats.maxDepthReached >= 0 &&
    stats.maxDepthReached <= options.maxDepth &&
    stats.transitionsEvaluated >= 0 &&
    stats.deadlockStatesFound >= 0 &&
    stats.deadlockStatesFound <= stats.statesExplored
  );
}

function readAssumptions(raw: unknown): readonly ModelAssumption[] | null {
  const arr = readSafeArray(raw, MAX_ASSUMPTIONS);
  if (!arr.ok) {
    return null;
  }
  const out: ModelAssumption[] = [];
  for (const item of arr.items) {
    const record = inspectPlainRecord(item);
    if (record === null) {
      return null;
    }
    const idProp = readOwnDataProp(record, 'id');
    const categoryProp = readOwnDataProp(record, 'category');
    const statementProp = readOwnDataProp(record, 'statement');
    const notModeledProp = readOwnDataProp(record, 'notModeled');
    if (
      idProp.kind !== 'value' ||
      typeof idProp.value !== 'string' ||
      categoryProp.kind !== 'value' ||
      typeof categoryProp.value !== 'string' ||
      statementProp.kind !== 'value' ||
      typeof statementProp.value !== 'string' ||
      notModeledProp.kind !== 'value' ||
      typeof notModeledProp.value !== 'string'
    ) {
      return null;
    }
    out.push(
      Object.freeze({
        id: idProp.value,
        category: categoryProp.value,
        statement: statementProp.value,
        notModeled: notModeledProp.value,
      }),
    );
  }
  return Object.freeze(out);
}

function assumptionsMatch(
  a: readonly ModelAssumption[],
  b: readonly ModelAssumption[],
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

function readTraceSteps(raw: unknown): readonly TraceStep[] | null {
  const arr = readSafeArray(raw, MAX_TRACE_STEPS);
  if (!arr.ok) {
    return null;
  }
  const steps: TraceStep[] = [];
  for (const item of arr.items) {
    const record = inspectPlainRecord(item);
    if (record === null) {
      return null;
    }
    const ruleIdProp = readOwnDataProp(record, 'ruleId');
    const beforeProp = readOwnDataProp(record, 'stateBefore');
    const afterProp = readOwnDataProp(record, 'stateAfter');
    const changedProp = readOwnDataProp(record, 'changedVars');
    if (
      ruleIdProp.kind !== 'value' ||
      typeof ruleIdProp.value !== 'string' ||
      beforeProp.kind !== 'value' ||
      afterProp.kind !== 'value' ||
      changedProp.kind !== 'value'
    ) {
      return null;
    }
    const before = cloneAndFreezeSnapshot(beforeProp.value);
    const after = cloneAndFreezeSnapshot(afterProp.value);
    const changed = readOwnStringArray(changedProp.value, MAX_CHANGED_VARS);
    if (before === null || after === null || !changed.ok) {
      return null;
    }
    steps.push(
      Object.freeze({
        ruleId: ruleIdProp.value,
        stateBefore: before,
        stateAfter: after,
        changedVars: Object.freeze([...changed.items]),
      }),
    );
  }
  return Object.freeze(steps);
}

interface CanonicalReplay {
  readonly steps: readonly TraceStep[];
  readonly finalState: StateSnapshot;
  readonly violatedInvariantIds: readonly string[];
}

function replayCanonicalTrace(
  model: TransitionSystemModel,
  steps: readonly TraceStep[],
): CanonicalReplay | InspectFailure {
  const ruleIds: string[] = [];
  for (const step of steps) {
    ruleIds.push(step.ruleId);
  }
  const replay = replayTrace(model, ruleIds);
  if (!replay.ok) {
    return failure('TRACE_REPLAY_FAILED', 'result.trace', 'Trace does not replay through the declared model.');
  }
  if (replay.steps.length !== steps.length) {
    return failure('TRACE_REPLAY_FAILED', 'result.trace', 'Trace step count does not match the replayed path.');
  }
  for (let i = 0; i < steps.length; i += 1) {
    const expected = steps[i];
    const actual = replay.steps[i];
    if (expected === undefined || actual === undefined) {
      return failure('TRACE_REPLAY_FAILED', 'result.trace', 'Trace step could not be compared.');
    }
    if (
      expected.ruleId !== actual.ruleId ||
      !snapshotsEqual(expected.stateBefore, actual.stateBefore) ||
      !snapshotsEqual(expected.stateAfter, actual.stateAfter) ||
      !stringArraysEqual(expected.changedVars, actual.changedVars)
    ) {
      return failure(
        'TRACE_REPLAY_MISMATCH',
        `result.trace[${i}]`,
        'Trace step does not match the replayed path through the declared model.',
      );
    }
  }
  const finalState = cloneAndFreezeSnapshot(replay.finalState);
  if (finalState === null) {
    return failure('TRACE_REPLAY_FAILED', 'result.trace', 'Replayed final state is not a valid snapshot.');
  }
  return {
    steps,
    finalState,
    violatedInvariantIds: Object.freeze([...replay.violatedInvariantIds]),
  };
}

function readValidationErrors(raw: unknown): readonly ValidationError[] | null {
  const arr = readSafeArray(raw, MAX_VALIDATION_ERRORS);
  if (!arr.ok) {
    return null;
  }
  const out: ValidationError[] = [];
  for (const item of arr.items) {
    const record = inspectPlainRecord(item);
    if (record === null) {
      return null;
    }
    const codeProp = readOwnDataProp(record, 'code');
    const pathProp = readOwnDataProp(record, 'path');
    const messageProp = readOwnDataProp(record, 'message');
    if (
      codeProp.kind !== 'value' ||
      typeof codeProp.value !== 'string' ||
      pathProp.kind !== 'value' ||
      typeof pathProp.value !== 'string' ||
      messageProp.kind !== 'value' ||
      typeof messageProp.value !== 'string'
    ) {
      return null;
    }
    out.push(
      Object.freeze({
        code: codeProp.value,
        path: pathProp.value,
        message: messageProp.value,
      }),
    );
  }
  return Object.freeze(out);
}

type GoalReachRead =
  | { readonly present: false }
  | { readonly present: true; readonly value: unknown };

function readGoalReachable(record: Record<string, unknown>): GoalReachRead | null {
  const prop = readOwnDataProp(record, 'goalReachable');
  if (prop.kind === 'accessor') {
    return null;
  }
  if (prop.kind === 'missing' || prop.value === undefined) {
    return { present: false };
  }
  return { present: true, value: prop.value };
}

function allRuntimeDiagnosticsReproduced(
  model: TransitionSystemModel,
  endpoint: StateSnapshot,
  runtimeErrors: readonly ValidationError[],
): boolean {
  for (const diagnostic of runtimeErrors) {
    let reproduced = false;
    for (const rule of model.rules) {
      const stepped = stepModel(model, endpoint, rule.id);
      if (stepped.ok) {
        continue;
      }
      const produced = stepped.error;
      if (
        produced.code === diagnostic.code &&
        produced.path === diagnostic.path &&
        produced.message === diagnostic.message
      ) {
        reproduced = true;
        break;
      }
    }
    if (!reproduced) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Snapshot inspection (shared with delta.ts)
// ---------------------------------------------------------------------------

export type InspectedVerificationSnapshot =
  | {
      readonly ok: true;
      readonly model: TransitionSystemModel;
      readonly options: VerifyOptions;
      readonly status: VerifyResult['status'];
      readonly goalStatus: VerificationReportGoalStatus;
      readonly goalReachable?: boolean;
      readonly stats?: VerifyStats;
      readonly errors: readonly ValidationError[];
      readonly violatedInvariantIds: readonly string[];
      readonly replaySteps: readonly TraceStep[];
      readonly terminalState?: StateSnapshot;
      readonly inconclusive?: VerificationReportInconclusive;
      readonly invalidKind?: 'validation' | 'runtime-out-of-domain';
      readonly traceLength?: number;
      readonly executionMode?: 'worker' | 'main-thread';
    }
  | InspectFailure;

export function inspectVerificationSnapshot(snapshot: unknown): InspectedVerificationSnapshot {
  try {
    const record = inspectPlainRecord(snapshot);
    if (record === null) {
      return failure('INVALID_SNAPSHOT', 'snapshot', 'Snapshot must be a plain data object without accessors or symbols.');
    }

    const modelRead = readPreferredField(record, 'model', 'capturedModel');
    if (modelRead.kind !== 'value') {
      return failure('INVALID_SNAPSHOT', 'snapshot.model', 'Snapshot must carry a model or capturedModel field.');
    }
    const optionsRead = readPreferredField(record, 'options', 'capturedOptions');
    if (optionsRead.kind !== 'value') {
      return failure('INVALID_SNAPSHOT', 'snapshot.options', 'Snapshot must carry an options or capturedOptions field.');
    }
    const resultRead = readOwnDataProp(record, 'result');
    if (resultRead.kind !== 'value') {
      return failure('INVALID_SNAPSHOT', 'snapshot.result', 'Snapshot must carry a result field.');
    }

    let executionMode: 'worker' | 'main-thread' | undefined;
    const executionModeRead = readOwnDataProp(record, 'executionMode');
    if (executionModeRead.kind === 'accessor') {
      return failure('INVALID_SNAPSHOT', 'snapshot.executionMode', 'Execution mode must be a plain data property.');
    }
    if (executionModeRead.kind === 'value' && executionModeRead.value !== undefined) {
      if (executionModeRead.value !== 'worker' && executionModeRead.value !== 'main-thread') {
        return failure('INVALID_SNAPSHOT', 'snapshot.executionMode', 'Execution mode must be "worker" or "main-thread".');
      }
      executionMode = executionModeRead.value;
    }

    const modelResult = canonicalizeModel(modelRead.value);
    if (!modelResult.ok) {
      return modelResult;
    }
    const optionsResult = canonicalizeOptions(optionsRead.value);
    if (!optionsResult.ok) {
      return optionsResult;
    }

    const model = modelResult.model;
    const options = optionsResult.options;
    const hasGoal = model.goal !== undefined;

    const resultRecord = inspectPlainRecord(resultRead.value);
    if (resultRecord === null) {
      return failure('INVALID_RESULT', 'result', 'Verification result must be a plain data object.');
    }
    const statusProp = readOwnDataProp(resultRecord, 'status');
    if (statusProp.kind !== 'value' || typeof statusProp.value !== 'string') {
      return failure('INVALID_RESULT', 'result.status', 'Verification result must declare a string status.');
    }
    const status = statusProp.value;

    if (status === 'VERIFIED') {
      const forbidden = rejectForbiddenProps(
        resultRecord,
        [
          'trace',
          'terminalState',
          'violatedInvariantIds',
          'reason',
          'completedDepth',
          'frontierRemaining',
          'errors',
        ],
        'VERIFIED',
      );
      if (forbidden !== null) {
        return forbidden;
      }
      const statsRead = readOwnDataProp(resultRecord, 'stats');
      if (statsRead.kind !== 'value') {
        return failure('INVALID_RESULT', 'result.stats', 'VERIFIED result must include statistics.');
      }
      const statsResult = canonicalizeStats(statsRead.value, model);
      if (!statsResult.ok) {
        return statsResult;
      }
      if (!statsRespectBounds(statsResult.stats, options)) {
        return failure('INVALID_STATS', 'result.stats', 'Statistics fall outside the declared bounds.');
      }
      const goalRead = readGoalReachable(resultRecord);
      if (goalRead === null) {
        return failure('INVALID_RESULT', 'result.goalReachable', 'Goal reachability must be a plain boolean when present.');
      }
      if (hasGoal) {
        if (!goalRead.present || typeof goalRead.value !== 'boolean') {
          return failure(
            'INVALID_RESULT',
            'result.goalReachable',
            'VERIFIED result must state goal reachability for a declared goal.',
          );
        }
      } else if (goalRead.present) {
        return failure(
          'INVALID_RESULT',
          'result.goalReachable',
          'VERIFIED result must not state goal reachability when no goal is declared.',
        );
      }
      const assumptionsRead = readOwnDataProp(resultRecord, 'assumptions');
      if (assumptionsRead.kind !== 'value') {
        return failure('INVALID_RESULT', 'result.assumptions', 'VERIFIED result must restate the declared assumptions.');
      }
      const assumptions = readAssumptions(assumptionsRead.value);
      if (assumptions === null || !assumptionsMatch(assumptions, model.assumptions)) {
        return failure(
          'ASSUMPTIONS_MISMATCH',
          'result.assumptions',
          'Result assumptions do not match the declared model assumptions.',
        );
      }

      const goalStatus: VerificationReportGoalStatus = hasGoal
        ? goalRead.present && goalRead.value === true
          ? 'REACHED'
          : 'UNREACHABLE'
        : 'NO_GOAL_DECLARED';

      return {
        ok: true,
        model,
        options,
        status: 'VERIFIED',
        goalStatus,
        ...(hasGoal && goalRead.present ? { goalReachable: goalRead.value === true } : {}),
        stats: statsResult.stats,
        errors: EMPTY_ERRORS,
        violatedInvariantIds: EMPTY_STRINGS,
        replaySteps: EMPTY_TRACE_STEPS,
        ...(executionMode !== undefined ? { executionMode } : {}),
      };
    }

    if (status === 'VIOLATED') {
      const forbidden = rejectForbiddenProps(
        resultRecord,
        ['reason', 'completedDepth', 'frontierRemaining', 'errors'],
        'VIOLATED',
      );
      if (forbidden !== null) {
        return forbidden;
      }
      const statsRead = readOwnDataProp(resultRecord, 'stats');
      if (statsRead.kind !== 'value') {
        return failure('INVALID_RESULT', 'result.stats', 'VIOLATED result must include statistics.');
      }
      const statsResult = canonicalizeStats(statsRead.value, model);
      if (!statsResult.ok) {
        return statsResult;
      }
      if (!statsRespectBounds(statsResult.stats, options)) {
        return failure('INVALID_STATS', 'result.stats', 'Statistics fall outside the declared bounds.');
      }

      const traceRead = readOwnDataProp(resultRecord, 'trace');
      if (traceRead.kind !== 'value') {
        return failure('INVALID_RESULT', 'result.trace', 'VIOLATED result must include a trace.');
      }
      const steps = readTraceSteps(traceRead.value);
      if (steps === null) {
        return failure('INVALID_RESULT', 'result.trace', 'VIOLATED trace is malformed.');
      }
      if (
        steps.length > statsResult.stats.maxDepthReached ||
        steps.length !== statsResult.stats.maxDepthReached ||
        statsResult.stats.maxDepthReached > options.maxDepth
      ) {
        return failure(
          'TRACE_BOUNDS_MISMATCH',
          'result.trace',
          'VIOLATED trace length must equal stats.maxDepthReached within options.maxDepth.',
        );
      }
      const replay = replayCanonicalTrace(model, steps);
      if ('ok' in replay && replay.ok === false) {
        return replay;
      }
      if (!('finalState' in replay)) {
        return failure('TRACE_REPLAY_FAILED', 'result.trace', 'Trace replay did not produce a final state.');
      }

      const terminalRead = readOwnDataProp(resultRecord, 'terminalState');
      if (terminalRead.kind !== 'value') {
        return failure('INVALID_RESULT', 'result.terminalState', 'VIOLATED result must include a terminal state.');
      }
      const terminalState = cloneAndFreezeSnapshot(terminalRead.value);
      if (terminalState === null || !snapshotsEqual(terminalState, replay.finalState)) {
        return failure(
          'TERMINAL_STATE_MISMATCH',
          'result.terminalState',
          'Terminal state does not match the replayed trace endpoint.',
        );
      }

      const violatedRead = readOwnDataProp(resultRecord, 'violatedInvariantIds');
      if (violatedRead.kind !== 'value') {
        return failure(
          'INVALID_RESULT',
          'result.violatedInvariantIds',
          'VIOLATED result must include violated invariant ids.',
        );
      }
      const violatedReadArray = readOwnStringArray(violatedRead.value, 256);
      if (!violatedReadArray.ok || violatedReadArray.items.length === 0) {
        return failure(
          'INVALID_RESULT',
          'result.violatedInvariantIds',
          'Violated invariant ids must be a non-empty string array.',
        );
      }
      if (!stringArraysEqual(violatedReadArray.items, replay.violatedInvariantIds)) {
        return failure(
          'VIOLATED_INVARIANTS_MISMATCH',
          'result.violatedInvariantIds',
          'Violated invariant ids do not match the replayed trace endpoint.',
        );
      }

      const goalRead = readGoalReachable(resultRecord);
      if (goalRead === null) {
        return failure('INVALID_RESULT', 'result.goalReachable', 'Goal reachability must be a plain boolean when present.');
      }
      if (goalRead.present) {
        if (goalRead.value !== true || !hasGoal || steps.length === 0) {
          return failure(
            'INVALID_RESULT',
            'result.goalReachable',
            'VIOLATED goal reachability is only allowed as true for a declared goal with a non-empty trace.',
          );
        }
      }

      const assumptionsRead = readOwnDataProp(resultRecord, 'assumptions');
      if (assumptionsRead.kind !== 'value') {
        return failure('INVALID_RESULT', 'result.assumptions', 'VIOLATED result must restate the declared assumptions.');
      }
      const assumptions = readAssumptions(assumptionsRead.value);
      if (assumptions === null || !assumptionsMatch(assumptions, model.assumptions)) {
        return failure(
          'ASSUMPTIONS_MISMATCH',
          'result.assumptions',
          'Result assumptions do not match the declared model assumptions.',
        );
      }

      const goalStatus: VerificationReportGoalStatus = hasGoal
        ? goalRead.present
          ? 'WITNESSED_ON_PREFIX'
          : 'NOT_EVALUATED'
        : 'NO_GOAL_DECLARED';

      return {
        ok: true,
        model,
        options,
        status: 'VIOLATED',
        goalStatus,
        ...(goalRead.present ? { goalReachable: true } : {}),
        stats: statsResult.stats,
        errors: EMPTY_ERRORS,
        violatedInvariantIds: replay.violatedInvariantIds,
        replaySteps: replay.steps,
        terminalState,
        traceLength: steps.length,
        ...(executionMode !== undefined ? { executionMode } : {}),
      };
    }

    if (status === 'INCONCLUSIVE') {
      const forbidden = rejectForbiddenProps(
        resultRecord,
        ['trace', 'terminalState', 'violatedInvariantIds', 'errors'],
        'INCONCLUSIVE',
      );
      if (forbidden !== null) {
        return forbidden;
      }
      const statsRead = readOwnDataProp(resultRecord, 'stats');
      if (statsRead.kind !== 'value') {
        return failure('INVALID_RESULT', 'result.stats', 'INCONCLUSIVE result must include statistics.');
      }
      const statsResult = canonicalizeStats(statsRead.value, model);
      if (!statsResult.ok) {
        return statsResult;
      }
      if (!statsRespectBounds(statsResult.stats, options)) {
        return failure('INVALID_STATS', 'result.stats', 'Statistics fall outside the declared bounds.');
      }

      const reasonProp = readOwnDataProp(resultRecord, 'reason');
      if (
        reasonProp.kind !== 'value' ||
        (reasonProp.value !== 'MAX_STATES' && reasonProp.value !== 'MAX_DEPTH')
      ) {
        return failure('INVALID_RESULT', 'result.reason', 'INCONCLUSIVE reason must be MAX_STATES or MAX_DEPTH.');
      }
      const depthProp = readOwnDataProp(resultRecord, 'completedDepth');
      const frontierProp = readOwnDataProp(resultRecord, 'frontierRemaining');
      if (
        depthProp.kind !== 'value' ||
        typeof depthProp.value !== 'number' ||
        !Number.isSafeInteger(depthProp.value) ||
        depthProp.value < -1 ||
        depthProp.value > options.maxDepth ||
        frontierProp.kind !== 'value' ||
        typeof frontierProp.value !== 'number' ||
        !Number.isSafeInteger(frontierProp.value) ||
        frontierProp.value < 1 ||
        frontierProp.value > statsResult.stats.statesExplored
      ) {
        return failure('INVALID_RESULT', 'result', 'INCONCLUSIVE limit metadata is malformed.');
      }

      const completedDepth = depthProp.value;
      const frontierRemaining = frontierProp.value;
      const depthRelationOk =
        completedDepth < statsResult.stats.maxDepthReached ||
        (statsResult.stats.maxDepthReached === 0 && completedDepth === -1);
      if (!depthRelationOk) {
        return failure(
          'INCONCLUSIVE_BOUNDS_MISMATCH',
          'result.completedDepth',
          'INCONCLUSIVE completedDepth is inconsistent with stats.maxDepthReached.',
        );
      }
      if (reasonProp.value === 'MAX_DEPTH') {
        if (
          completedDepth !== options.maxDepth - 1 ||
          statsResult.stats.maxDepthReached !== options.maxDepth
        ) {
          return failure(
            'INCONCLUSIVE_BOUNDS_MISMATCH',
            'result.completedDepth',
            'INCONCLUSIVE MAX_DEPTH metadata does not agree with the declared depth bound.',
          );
        }
      } else if (statsResult.stats.statesExplored !== options.maxStates) {
        return failure(
          'INCONCLUSIVE_BOUNDS_MISMATCH',
          'result.stats.statesExplored',
          'INCONCLUSIVE MAX_STATES metadata does not agree with the declared state bound.',
        );
      }

      const goalRead = readGoalReachable(resultRecord);
      if (goalRead === null) {
        return failure('INVALID_RESULT', 'result.goalReachable', 'Goal reachability must be a plain boolean when present.');
      }
      if (goalRead.present && (goalRead.value !== true || !hasGoal)) {
        return failure(
          'INVALID_RESULT',
          'result.goalReachable',
          'INCONCLUSIVE goal reachability is only allowed as true for a declared goal.',
        );
      }

      const assumptionsRead = readOwnDataProp(resultRecord, 'assumptions');
      if (assumptionsRead.kind !== 'value') {
        return failure(
          'INVALID_RESULT',
          'result.assumptions',
          'INCONCLUSIVE result must restate the declared assumptions.',
        );
      }
      const assumptions = readAssumptions(assumptionsRead.value);
      if (assumptions === null || !assumptionsMatch(assumptions, model.assumptions)) {
        return failure(
          'ASSUMPTIONS_MISMATCH',
          'result.assumptions',
          'Result assumptions do not match the declared model assumptions.',
        );
      }

      const goalStatus: VerificationReportGoalStatus = hasGoal
        ? goalRead.present
          ? 'WITNESSED_ON_PREFIX'
          : 'NOT_EVALUATED'
        : 'NO_GOAL_DECLARED';

      return {
        ok: true,
        model,
        options,
        status: 'INCONCLUSIVE',
        goalStatus,
        ...(goalRead.present ? { goalReachable: true } : {}),
        stats: statsResult.stats,
        errors: EMPTY_ERRORS,
        violatedInvariantIds: EMPTY_STRINGS,
        replaySteps: EMPTY_TRACE_STEPS,
        inconclusive: Object.freeze({
          reason: reasonProp.value,
          completedDepth,
          frontierRemaining,
        }),
        ...(executionMode !== undefined ? { executionMode } : {}),
      };
    }

    if (status === 'INVALID') {
      const forbidden = rejectForbiddenProps(
        resultRecord,
        [
          'assumptions',
          'goalReachable',
          'terminalState',
          'violatedInvariantIds',
          'reason',
          'completedDepth',
          'frontierRemaining',
        ],
        'INVALID',
      );
      if (forbidden !== null) {
        return forbidden;
      }
      const errorsRead = readOwnDataProp(resultRecord, 'errors');
      if (errorsRead.kind !== 'value') {
        return failure('INVALID_RESULT', 'result.errors', 'INVALID result must include validation errors.');
      }
      const errors = readValidationErrors(errorsRead.value);
      if (errors === null || errors.length === 0) {
        return failure('INVALID_RESULT', 'result.errors', 'INVALID result must include at least one error.');
      }

      const goalRead = readGoalReachable(resultRecord);
      if (goalRead === null) {
        return failure('INVALID_RESULT', 'result.goalReachable', 'Goal reachability must be a plain boolean when present.');
      }
      if (goalRead.present) {
        return failure('INVALID_RESULT', 'result.goalReachable', 'INVALID result must not state goal reachability.');
      }

      const runtimeErrors = errors.filter((entry) => entry.code === 'OUT_OF_DOMAIN_TRANSITION');
      if (runtimeErrors.length > 0 && runtimeErrors.length !== errors.length) {
        return failure(
          'INVALID_RESULT',
          'result.errors',
          'INVALID result must not mix validation errors with runtime out-of-domain diagnostics.',
        );
      }
      const goalStatus: VerificationReportGoalStatus = hasGoal ? 'NOT_EVALUATED' : 'NO_GOAL_DECLARED';

      if (runtimeErrors.length === 0) {
        const statsProp = readOwnDataProp(resultRecord, 'stats');
        const traceProp = readOwnDataProp(resultRecord, 'trace');
        if (
          (statsProp.kind === 'value' && statsProp.value !== undefined) ||
          (traceProp.kind === 'value' && traceProp.value !== undefined) ||
          statsProp.kind === 'accessor' ||
          traceProp.kind === 'accessor'
        ) {
          return failure(
            'INVALID_RESULT',
            'result',
            'Validation INVALID results must not carry exploration statistics or traces.',
          );
        }
        return {
          ok: true,
          model,
          options,
          status: 'INVALID',
          goalStatus,
          errors,
          violatedInvariantIds: EMPTY_STRINGS,
          replaySteps: EMPTY_TRACE_STEPS,
          invalidKind: 'validation',
          ...(executionMode !== undefined ? { executionMode } : {}),
        };
      }

      const statsProp = readOwnDataProp(resultRecord, 'stats');
      const traceProp = readOwnDataProp(resultRecord, 'trace');
      if (statsProp.kind !== 'value' || traceProp.kind !== 'value') {
        return failure(
          'INVALID_RESULT',
          'result',
          'Runtime out-of-domain results must carry statistics and a prefix trace.',
        );
      }
      const statsResult = canonicalizeStats(statsProp.value, model);
      if (!statsResult.ok) {
        return statsResult;
      }
      if (!statsRespectBounds(statsResult.stats, options)) {
        return failure('INVALID_STATS', 'result.stats', 'Statistics fall outside the declared bounds.');
      }

      const steps = readTraceSteps(traceProp.value);
      if (steps === null) {
        return failure('INVALID_RESULT', 'result.trace', 'Runtime prefix trace is malformed.');
      }
      if (
        steps.length > statsResult.stats.maxDepthReached ||
        statsResult.stats.maxDepthReached > options.maxDepth
      ) {
        return failure(
          'TRACE_BOUNDS_MISMATCH',
          'result.trace',
          'Runtime prefix trace length exceeds stats.maxDepthReached or options.maxDepth.',
        );
      }
      const replay = replayCanonicalTrace(model, steps);
      if ('ok' in replay && replay.ok === false) {
        return replay;
      }
      if (!('finalState' in replay)) {
        return failure('TRACE_REPLAY_FAILED', 'result.trace', 'Trace replay did not produce a final state.');
      }

      if (!allRuntimeDiagnosticsReproduced(model, replay.finalState, runtimeErrors)) {
        return failure(
          'RUNTIME_DIAGNOSTIC_MISMATCH',
          'result.errors',
          'No rule at the replayed prefix endpoint reproduces the reported out-of-domain diagnostic.',
        );
      }

      return {
        ok: true,
        model,
        options,
        status: 'INVALID',
        goalStatus,
        stats: statsResult.stats,
        errors,
        violatedInvariantIds: EMPTY_STRINGS,
        replaySteps: replay.steps,
        invalidKind: 'runtime-out-of-domain',
        traceLength: steps.length,
        ...(executionMode !== undefined ? { executionMode } : {}),
      };
    }

    return failure('INVALID_RESULT', 'result.status', 'Unrecognized verification status.');
  } catch {
    return failure('UNEXPECTED_INPUT_ERROR', 'snapshot', 'Snapshot inspection failed due to an unexpected runtime error.');
  }
}

// ---------------------------------------------------------------------------
// Report assembly and provenance minting
// ---------------------------------------------------------------------------

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

function buildTraceStep(
  model: TransitionSystemModel,
  step: TraceStep,
  index: number,
): VerificationReportTraceStep {
  let ruleLabel = step.ruleId;
  for (const rule of model.rules) {
    if (rule.id === step.ruleId) {
      ruleLabel = rule.label;
      break;
    }
  }
  const diffs: VerificationReportTraceDiff[] = [];
  for (const name of step.changedVars) {
    const before = step.stateBefore[name];
    const after = step.stateAfter[name];
    if (before === undefined || after === undefined) {
      continue;
    }
    diffs.push(
      Object.freeze({
        variable: name,
        before: normalizeStateValue(before),
        after: normalizeStateValue(after),
      }),
    );
  }
  return Object.freeze({
    stepIndex: index + 1,
    ruleId: step.ruleId,
    ruleLabel,
    stateBefore: step.stateBefore,
    stateAfter: step.stateAfter,
    changedVars: Object.freeze([...step.changedVars]),
    diffs: Object.freeze(diffs),
  });
}

function assembleReport<P extends VerificationReportProvenance>(
  inspected: Extract<InspectedVerificationSnapshot, { readonly ok: true }>,
  provenance: P,
  proofScopeNotice: string,
): VerificationReport<P> {
  const model = inspected.model;
  const hasGoal = model.goal !== undefined;

  const goalRef: VerificationReportGoalRef | undefined =
    model.goal !== undefined
      ? Object.freeze({
          id: model.goal.id,
          label: model.goal.label,
          expression: formatBoolExpr(model.goal.reached),
        })
      : undefined;

  const modelSummary: VerificationReportModelSummary = Object.freeze({
    id: model.id,
    name: model.name,
    schema: model.schema,
    initialState: model.initialState,
    variableCount: Object.keys(model.schema).length,
    ruleCount: model.rules.length,
    invariantCount: model.invariants.length,
    hasGoal,
    ...(goalRef !== undefined ? { goal: goalRef } : {}),
  });

  const violatedInvariants: VerificationReportInvariantRef[] = [];
  for (const id of inspected.violatedInvariantIds) {
    let matched: VerificationReportInvariantRef | undefined;
    for (const invariant of model.invariants) {
      if (invariant.id === id) {
        matched = Object.freeze({
          id: invariant.id,
          label: invariant.label,
          expression: formatBoolExpr(invariant.holds),
        });
        break;
      }
    }
    violatedInvariants.push(
      matched ??
        Object.freeze({
          id,
          label: id,
          expression: '<unavailable>',
        }),
    );
  }

  const includesTrace = inspected.status === 'VIOLATED' || inspected.invalidKind === 'runtime-out-of-domain';
  const traceSteps: VerificationReportTraceStep[] = [];
  if (includesTrace) {
    for (let i = 0; i < inspected.replaySteps.length; i += 1) {
      const step = inspected.replaySteps[i];
      if (step !== undefined) {
        traceSteps.push(buildTraceStep(model, step, i));
      }
    }
  }

  const notModeled: string[] = [];
  for (const assumption of model.assumptions) {
    if (!notModeled.includes(assumption.notModeled)) {
      notModeled.push(assumption.notModeled);
    }
  }

  const vacuous = inspected.status === 'VERIFIED' && inspected.goalStatus === 'UNREACHABLE';

  const report: VerificationReport<P> = {
    schemaVersion: VERIFICATION_REPORT_SCHEMA_VERSION,
    provenance,
    proofScopeNotice,
    ...(inspected.executionMode !== undefined ? { executionMode: inspected.executionMode } : {}),
    bigIntEncoding: 'decimal-string',
    model: modelSummary,
    bounds: inspected.options,
    verdict: inspected.status,
    goalStatus: inspected.goalStatus,
    vacuousGoalWarning: vacuous,
    ...(vacuous ? { vacuousWarningMessage: VACUOUS_WARNING_MESSAGE } : {}),
    ...(inspected.stats !== undefined ? { stats: inspected.stats } : {}),
    violatedInvariantIds: Object.freeze([...inspected.violatedInvariantIds]),
    violatedInvariants: Object.freeze(violatedInvariants),
    ...(includesTrace ? { trace: Object.freeze(traceSteps) } : {}),
    ...(inspected.terminalState !== undefined ? { terminalState: inspected.terminalState } : {}),
    ...(inspected.inconclusive !== undefined ? { inconclusive: inspected.inconclusive } : {}),
    ...(inspected.invalidKind !== undefined ? { invalidKind: inspected.invalidKind } : {}),
    errors: inspected.errors,
    assumptions: model.assumptions,
    notModeled: Object.freeze(notModeled),
    scopeDisclaimer: SCOPE_DISCLAIMER,
  };

  TRUSTED_REPORTS.add(report);
  return deepFreezeValue(report);
}

export function buildVerificationReportFromSnapshot(
  snapshot: unknown,
): ReportBuildResult<'validated-snapshot'> {
  const inspected = inspectVerificationSnapshot(snapshot);
  if (!inspected.ok) {
    return { ok: false, errors: inspected.errors };
  }
  return {
    ok: true,
    report: assembleReport(inspected, 'validated-snapshot', SNAPSHOT_PROOF_SCOPE_NOTICE),
  };
}

export function verifyAndBuildReport(
  model: unknown,
  options: unknown,
): ReportBuildResult<'recomputed-core'> {
  const modelResult = canonicalizeModel(model);
  if (!modelResult.ok) {
    return { ok: false, errors: modelResult.errors };
  }
  const optionsResult = canonicalizeOptions(options);
  if (!optionsResult.ok) {
    return { ok: false, errors: optionsResult.errors };
  }
  const result = verifyModel(modelResult.model, optionsResult.options);
  const inspected = inspectVerificationSnapshot({
    model: modelResult.model,
    options: optionsResult.options,
    result,
  });
  if (!inspected.ok) {
    return { ok: false, errors: inspected.errors };
  }
  return {
    ok: true,
    report: assembleReport(inspected, 'recomputed-core', RECOMPUTED_PROOF_SCOPE_NOTICE),
  };
}

export function isTrustedVerificationReport(value: unknown): value is VerificationReport {
  return (
    typeof value === 'object' && value !== null && TRUSTED_REPORTS.has(value as VerificationReport)
  );
}

export function serializeVerificationReportJson(report: VerificationReport): string {
  if (!isTrustedVerificationReport(report)) {
    throw new TypeError('Refusing to serialize an untrusted or forged verification report.');
  }
  return JSON.stringify(report, null, 2);
}

// ---------------------------------------------------------------------------
// Hostile-string neutralization for Markdown
// ---------------------------------------------------------------------------

const MARKDOWN_ACTIVE_CHARS = new Set<string>([
  '\\',
  '`',
  '*',
  '_',
  '[',
  ']',
  '(',
  ')',
  '!',
  '#',
  '|',
  '~',
]);

const HTML_ENTITIES: Readonly<Record<string, string>> = Object.freeze({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
});

const FORMULA_PREFIX_PATTERN =
  /^[\s\u0000-\u001f\u007f-\u009f\u200e\u200f\u061c\u202a-\u202e\u2066-\u2069]*[=+\-@]/;

function escapeUnicodeUnit(code: number): string {
  return `\\u${code.toString(16).toUpperCase().padStart(4, '0')}`;
}

function isBidiControl(code: number): boolean {
  return (
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069) ||
    code === 0x200e ||
    code === 0x200f ||
    code === 0x061c
  );
}

function sanitizeInline(value: string): string {
  if (typeof value !== 'string') {
    return '';
  }
  let out = '';
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 0x0a) {
      out += '\\n';
      continue;
    }
    if (code === 0x0d) {
      out += '\\r';
      continue;
    }
    if (code === 0x2028) {
      out += '\\u2028';
      continue;
    }
    if (code === 0x2029) {
      out += '\\u2029';
      continue;
    }
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f) || isBidiControl(code)) {
      out += escapeUnicodeUnit(code);
      continue;
    }
    const ch = value.charAt(i);
    const entity = HTML_ENTITIES[ch];
    if (entity !== undefined) {
      out += entity;
      continue;
    }
    if (MARKDOWN_ACTIVE_CHARS.has(ch)) {
      out += '\\';
      out += ch;
      continue;
    }
    out += ch;
  }
  return out;
}

function sanitizeTableCell(value: string): string {
  const sanitized = sanitizeInline(value);
  if (FORMULA_PREFIX_PATTERN.test(value)) {
    return `'${sanitized}`;
  }
  return sanitized;
}

function sanitizeListItem(value: string): string {
  let out = sanitizeInline(value);
  out = out.replace(/^ +/, (spaces) => '&#32;'.repeat(spaces.length));
  out = out.replace(/^((?:&#32;)*)([+-])(?=\s|$|-)/, '$1\\$2');
  out = out.replace(/^((?:&#32;)*[0-9]{1,9})\.(?=\s|$)/, '$1\\.');
  return out;
}

function longestBacktickRun(value: string): number {
  let longest = 0;
  let current = 0;
  for (let i = 0; i < value.length; i += 1) {
    if (value.charAt(i) === '`') {
      current += 1;
      if (current > longest) {
        longest = current;
      }
    } else {
      current = 0;
    }
  }
  return longest;
}

function fencedBlock(rawLines: readonly string[]): string {
  const raw = rawLines.join('\n');
  const fenceLength = Math.max(3, longestBacktickRun(raw) + 1);
  const fence = '`'.repeat(fenceLength);
  const body: string[] = [];
  for (const line of rawLines) {
    body.push(sanitizeInline(line));
  }
  return `${fence}text\n${body.join('\n')}\n${fence}`;
}

interface TraceRenderStep {
  readonly ruleId: string;
  readonly ruleLabel: string;
  readonly stateBefore: StateSnapshot;
  readonly stateAfter: StateSnapshot;
  readonly changedVars: readonly string[];
}

function traceBlock(steps: readonly TraceRenderStep[]): string {
  const rawLines: string[] = [];
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    if (step === undefined) {
      continue;
    }
    const diffParts: string[] = [];
    for (const name of step.changedVars) {
      const before = step.stateBefore[name];
      const after = step.stateAfter[name];
      if (before === undefined || after === undefined) {
        continue;
      }
      diffParts.push(
        `${name}: ${formatStateValue(before)} \u2192 ${formatStateValue(after)}`,
      );
    }
    const diffText = diffParts.length > 0 ? diffParts.join('; ') : 'no state changes';
    rawLines.push(`Step ${i + 1}: ${step.ruleLabel} (${step.ruleId}); ${diffText}`);
  }
  return fencedBlock(rawLines);
}

function renderTraceSection(
  steps: readonly TraceRenderStep[],
  summaryLabel: string,
  emptyText: string,
): string[] {
  const lines: string[] = [];
  if (steps.length === 0) {
    lines.push(emptyText);
    return lines;
  }
  const block = traceBlock(steps);
  if (steps.length > 8) {
    lines.push('<details>');
    lines.push(`<summary>${summaryLabel} (${steps.length} steps)</summary>`);
    lines.push('');
    lines.push(block);
    lines.push('');
    lines.push('</details>');
    return lines;
  }
  lines.push(block);
  return lines;
}

function tableRow(cells: readonly string[]): string {
  return `| ${cells.join(' | ')} |`;
}

function tableHeader(cells: readonly string[]): string[] {
  return [tableRow(cells), `| ${cells.map(() => '---').join(' | ')} |`];
}

export function formatVerificationReportMarkdown(report: VerificationReport): string {
  if (!isTrustedVerificationReport(report)) {
    throw new TypeError('Refusing to format an untrusted or forged verification report.');
  }

  const lines: string[] = [];
  lines.push('# Verification Audit Report');
  lines.push('');
  lines.push(`- **Model:** ${sanitizeInline(report.model.name)}`);
  lines.push(`- **Model ID:** ${sanitizeInline(report.model.id)}`);
  lines.push(`- **Schema version:** ${sanitizeInline(report.schemaVersion)}`);
  lines.push(`- **Variables:** ${String(report.model.variableCount)}`);
  lines.push(`- **Rules:** ${String(report.model.ruleCount)}`);
  lines.push(`- **Invariants:** ${String(report.model.invariantCount)}`);
  lines.push(`- **Goal declared:** ${report.model.hasGoal ? 'yes' : 'no'}`);
  lines.push('');

  lines.push('## Verdict');
  lines.push('');
  lines.push(`**${report.verdict}**`);
  lines.push('');
  lines.push(`Goal status: **${report.goalStatus}**`);
  lines.push('');

  lines.push('## Provenance and execution mode');
  lines.push('');
  lines.push(`- **Provenance:** ${sanitizeInline(report.provenance)}`);
  lines.push(
    `- **Execution mode:** ${
      report.executionMode !== undefined ? sanitizeInline(report.executionMode) : 'not provided'
    }`,
  );
  lines.push(`- **BigInt encoding:** ${sanitizeInline(report.bigIntEncoding)}`);
  lines.push('');

  lines.push('## Proof scope');
  lines.push('');
  lines.push(report.proofScopeNotice);
  lines.push('');

  lines.push('## Bounds and statistics');
  lines.push('');
  lines.push(...tableHeader(['Bound', 'Value']));
  lines.push(tableRow(['maxStates', sanitizeTableCell(String(report.bounds.maxStates))]));
  lines.push(tableRow(['maxDepth', sanitizeTableCell(String(report.bounds.maxDepth))]));
  lines.push('');
  if (report.stats !== undefined) {
    lines.push(...tableHeader(['Statistic', 'Value']));
    lines.push(tableRow(['theoreticalStates', sanitizeTableCell(report.stats.theoreticalStates)]));
    lines.push(tableRow(['statesExplored', sanitizeTableCell(String(report.stats.statesExplored))]));
    lines.push(
      tableRow(['transitionsEvaluated', sanitizeTableCell(String(report.stats.transitionsEvaluated))]),
    );
    lines.push(tableRow(['maxDepthReached', sanitizeTableCell(String(report.stats.maxDepthReached))]));
    lines.push(
      tableRow(['deadlockStatesFound', sanitizeTableCell(String(report.stats.deadlockStatesFound))]),
    );
  } else {
    lines.push('No statistics were recorded for this verdict.');
  }
  lines.push('');

  lines.push('## Goal');
  lines.push('');
  if (report.model.goal !== undefined) {
    lines.push(...tableHeader(['Field', 'Value']));
    lines.push(tableRow(['id', sanitizeTableCell(report.model.goal.id)]));
    lines.push(tableRow(['label', sanitizeTableCell(report.model.goal.label)]));
    lines.push(tableRow(['expression', sanitizeTableCell(report.model.goal.expression)]));
    lines.push(tableRow(['status', sanitizeTableCell(report.goalStatus)]));
  } else {
    lines.push('No goal declared.');
  }
  lines.push('');
  if (report.vacuousGoalWarning) {
    lines.push('### Vacuous-goal warning');
    lines.push('');
    lines.push(report.vacuousWarningMessage ?? VACUOUS_WARNING_MESSAGE);
    lines.push('');
  }

  lines.push('## Violated invariants');
  lines.push('');
  if (report.violatedInvariants.length === 0) {
    lines.push('No invariants were reported as violated.');
  } else {
    lines.push(...tableHeader(['ID', 'Label', 'Expression']));
    for (const invariant of report.violatedInvariants) {
      lines.push(
        tableRow([
          sanitizeTableCell(invariant.id),
          sanitizeTableCell(invariant.label),
          sanitizeTableCell(invariant.expression),
        ]),
      );
    }
  }
  lines.push('');

  if (report.verdict === 'VIOLATED') {
    lines.push('## Counterexample trace');
    lines.push('');
    lines.push(
      ...renderTraceSection(
        report.trace ?? [],
        'Counterexample trace',
        'The initial state already violates the reported invariant.',
      ),
    );
    lines.push('');
  }

  if (report.inconclusive !== undefined) {
    lines.push('## Inconclusive exploration');
    lines.push('');
    lines.push(...tableHeader(['Field', 'Value']));
    lines.push(tableRow(['reason', sanitizeTableCell(report.inconclusive.reason)]));
    lines.push(
      tableRow(['completedDepth', sanitizeTableCell(String(report.inconclusive.completedDepth))]),
    );
    lines.push(
      tableRow([
        'frontierRemaining',
        sanitizeTableCell(String(report.inconclusive.frontierRemaining)),
      ]),
    );
    lines.push('');
  }

  if (report.errors.length > 0) {
    lines.push('## Validation and runtime errors');
    lines.push('');
    lines.push(...tableHeader(['Code', 'Path', 'Message']));
    for (const error of report.errors) {
      lines.push(
        tableRow([
          sanitizeTableCell(error.code),
          sanitizeTableCell(error.path),
          sanitizeTableCell(error.message),
        ]),
      );
    }
    lines.push('');
    if (report.invalidKind === 'runtime-out-of-domain' && report.trace !== undefined) {
      lines.push('### Runtime out-of-domain prefix trace');
      lines.push('');
      lines.push(
        ...renderTraceSection(
          report.trace,
          'Runtime prefix trace',
          'The runtime failure occurred at the initial state.',
        ),
      );
      lines.push('');
    }
  }

  lines.push('## Declared assumptions');
  lines.push('');
  if (report.assumptions.length === 0) {
    lines.push('No assumptions declared.');
  } else {
    lines.push(...tableHeader(['ID', 'Category', 'Statement', 'Not modeled']));
    for (const assumption of report.assumptions) {
      lines.push(
        tableRow([
          sanitizeTableCell(assumption.id),
          sanitizeTableCell(assumption.category),
          sanitizeTableCell(assumption.statement),
          sanitizeTableCell(assumption.notModeled),
        ]),
      );
    }
  }
  lines.push('');

  lines.push('## What is not modeled');
  lines.push('');
  if (report.notModeled.length === 0) {
    lines.push('Nothing was listed as not modeled.');
  } else {
    for (const entry of report.notModeled) {
      lines.push(`- ${sanitizeListItem(entry)}`);
    }
  }
  lines.push('');

  lines.push('## Scope disclaimer');
  lines.push('');
  lines.push(report.scopeDisclaimer);
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Filename sanitization
// ---------------------------------------------------------------------------

const ALLOWED_REPORT_EXTENSIONS = new Set<string>(['md', 'json', '.md', '.json']);

const RESERVED_WINDOWS_STEMS = new Set<string>([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
]);

export function sanitizeReportFilename(modelId: unknown, ext: unknown): string {
  if (typeof ext !== 'string' || !ALLOWED_REPORT_EXTENSIONS.has(ext)) {
    throw new TypeError('Report filename extension must be one of "md", ".md", "json", or ".json".');
  }
  const cleanExt = ext.startsWith('.') ? ext.slice(1) : ext;

  let stem = '';
  if (typeof modelId === 'string') {
    stem = modelId.toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
  }
  stem = stem.replace(/^[-_]+/, '').replace(/[-_]+$/, '');
  stem = stem.slice(0, MAX_FILENAME_STEM);
  stem = stem.replace(/[-_]+$/, '');

  if (stem.length === 0 || RESERVED_WINDOWS_STEMS.has(stem)) {
    stem = 'rulecanvas-model';
  }

  return `${stem}.${cleanExt}`;
}
