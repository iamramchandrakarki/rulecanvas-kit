import {
  getEnabledTransitions,
  getInitialState,
  replayTrace,
  stepModel,
  validateModel,
  type EnabledTransition,
  type StateSnapshot,
  type TraceStep,
  type TransitionSystemModel,
  type ValidationError,
  type VerifyResult,
} from '@rulecanvas/core';
import {
  cloneAndFreezeSnapshot,
  deepCloneAndFreezeModel,
  isPlainObject,
  MAX_REPLAY_STEPS,
  MAX_SAFE_ARRAY_LENGTH,
  readOwnDataProp,
  readOwnStringArray,
  readSafeArray,
  snapshotsEqual,
  stringArraysEqual,
} from './safe-input.js';

export type ReplayMode = 'trace' | 'manual';

export interface VerdictReplayOptions {
  readonly startAt?: 'initial' | 'terminal';
}

export interface ReplaySession {
  readonly mode: ReplayMode;
  readonly model: TransitionSystemModel;
  readonly cursor: number;
  readonly totalSteps: number;
  readonly canStepBack: boolean;
  readonly canStepForward: boolean;
  readonly initialState: StateSnapshot;
  readonly currentState: StateSnapshot;
  readonly activeStep: TraceStep | null;
  readonly changedVars: readonly string[];
  readonly steps: readonly TraceStep[];
  readonly enabledTransitions: readonly EnabledTransition[];
  readonly violatedInvariantIds: readonly string[];
  readonly goalReached?: boolean;
}

export type ReplaySessionInitResult =
  | { readonly ok: true; readonly session: ReplaySession }
  | {
      readonly ok: false;
      readonly stepIndex: number;
      readonly error: ValidationError;
      readonly errors: readonly ValidationError[];
      readonly completedSteps: readonly TraceStep[];
    };

export type ReplayStepNavResult =
  | { readonly ok: true; readonly session: ReplaySession }
  | {
      readonly ok: false;
      readonly error: ValidationError;
      readonly errors: readonly ValidationError[];
      readonly session?: ReplaySession;
    };

export type ManualStepResult =
  | { readonly ok: true; readonly session: ReplaySession; readonly step: TraceStep }
  | {
      readonly ok: false;
      readonly error: ValidationError;
      readonly errors: readonly ValidationError[];
      readonly session?: ReplaySession;
    };

const EMPTY_STEPS: readonly TraceStep[] = Object.freeze([]);
const CANONICAL_SESSIONS = new WeakSet<ReplaySession>();

function createError(code: string, path: string, message: string): ValidationError {
  return Object.freeze({ code, path, message });
}

function createUnexpectedError(): ValidationError {
  return createError(
    'UNEXPECTED_INPUT_ERROR',
    '$',
    'Unexpected error while inspecting untrusted input.',
  );
}

function freezeError(error: ValidationError): ValidationError {
  return Object.freeze({
    code: error.code,
    path: error.path,
    message: error.message,
  });
}

function freezeErrors(errors: readonly ValidationError[]): readonly ValidationError[] {
  return Object.freeze(errors.map(freezeError));
}

function extractCoreErrors(res: { readonly error: ValidationError }): readonly ValidationError[] {
  const errsProp = readOwnDataProp(res as unknown as Record<string, unknown>, 'errors');
  if (errsProp.kind === 'value' && Array.isArray(errsProp.value) && errsProp.value.length > 0) {
    return errsProp.value as readonly ValidationError[];
  }
  return [res.error];
}

function freezeStep(step: TraceStep): TraceStep | null {
  const before = cloneAndFreezeSnapshot(step.stateBefore);
  const after = cloneAndFreezeSnapshot(step.stateAfter);
  const changed = readOwnStringArray(step.changedVars);
  if (before === null || after === null || !changed.ok) {
    return null;
  }
  return Object.freeze({
    ruleId: step.ruleId,
    stateBefore: before,
    stateAfter: after,
    changedVars: Object.freeze([...changed.items]),
  });
}

function freezeSteps(steps: readonly TraceStep[]): readonly TraceStep[] {
  if (steps.length === 0) return EMPTY_STEPS;
  const frozen: TraceStep[] = [];
  for (const step of steps) {
    const f = freezeStep(step);
    if (f !== null) {
      frozen.push(f);
    }
  }
  return Object.freeze(frozen);
}

function freezeTransition(transition: EnabledTransition): EnabledTransition {
  return Object.freeze({
    ruleId: transition.ruleId,
    label: transition.label,
    enabled: transition.enabled,
  });
}

function makeInitFailure(
  stepIndex: number,
  errors: readonly ValidationError[],
  completedSteps: readonly TraceStep[] = EMPTY_STEPS,
): ReplaySessionInitResult {
  const frozenErrors =
    errors.length > 0 ? freezeErrors(errors) : Object.freeze([createUnexpectedError()]);
  return Object.freeze({
    ok: false,
    stepIndex,
    error: frozenErrors[0]!,
    errors: frozenErrors,
    completedSteps: freezeSteps(completedSteps),
  });
}

function makeNavFailure(
  errors: readonly ValidationError[],
  session?: ReplaySession,
): ReplayStepNavResult {
  const frozenErrors =
    errors.length > 0 ? freezeErrors(errors) : Object.freeze([createUnexpectedError()]);
  return Object.freeze({
    ok: false,
    error: frozenErrors[0]!,
    errors: frozenErrors,
    ...(session !== undefined ? { session } : {}),
  });
}

function makeManualFailure(
  errors: readonly ValidationError[],
  session?: ReplaySession,
): ManualStepResult {
  const frozenErrors =
    errors.length > 0 ? freezeErrors(errors) : Object.freeze([createUnexpectedError()]);
  return Object.freeze({
    ok: false,
    error: frozenErrors[0]!,
    errors: frozenErrors,
    ...(session !== undefined ? { session } : {}),
  });
}

function buildSessionAtCursor(
  mode: ReplayMode,
  frozenModel: TransitionSystemModel,
  initialState: StateSnapshot,
  steps: readonly TraceStep[],
  cursor: number,
):
  | { readonly ok: true; readonly session: ReplaySession }
  | { readonly ok: false; readonly errors: readonly ValidationError[] } {
  if (steps.length > MAX_REPLAY_STEPS) {
    return {
      ok: false,
      errors: Object.freeze([
        createError(
          'TRACE_TOO_LONG',
          'steps',
          `Trace length exceeds maximum supported replay length (${MAX_REPLAY_STEPS}).`,
        ),
      ]),
    };
  }

  const prefixRuleIds = steps.slice(0, cursor).map((s) => s.ruleId);
  const prefixReplay = replayTrace(frozenModel, prefixRuleIds);
  if (!prefixReplay.ok) {
    return { ok: false, errors: freezeErrors(extractCoreErrors(prefixReplay)) };
  }

  const frozenInitial = cloneAndFreezeSnapshot(initialState);
  const currentState = cloneAndFreezeSnapshot(prefixReplay.finalState);
  if (frozenInitial === null || currentState === null) {
    return { ok: false, errors: Object.freeze([createUnexpectedError()]) };
  }

  const frozenSteps = freezeSteps(steps);
  if (frozenSteps.length !== steps.length) {
    return { ok: false, errors: Object.freeze([createUnexpectedError()]) };
  }

  const activeStep = cursor === 0 ? null : frozenSteps[cursor - 1]!;
  const enabledRes = getEnabledTransitions(frozenModel, currentState);
  if (!enabledRes.ok) {
    return { ok: false, errors: freezeErrors(enabledRes.errors) };
  }

  const frozenChangedVars: readonly string[] =
    activeStep === null ? Object.freeze([]) : activeStep.changedVars;
  const frozenTransitions = Object.freeze(enabledRes.transitions.map(freezeTransition));
  const frozenViolated = Object.freeze([...prefixReplay.violatedInvariantIds]);
  const goalProp = readOwnDataProp(prefixReplay as unknown as Record<string, unknown>, 'goalReached');
  const hasGoal = goalProp.kind === 'value' && typeof goalProp.value === 'boolean';
  const goalReached = hasGoal ? goalProp.value : undefined;

  const session: ReplaySession = Object.freeze({
    mode,
    model: frozenModel,
    cursor,
    totalSteps: frozenSteps.length,
    canStepBack: cursor > 0,
    canStepForward: cursor < frozenSteps.length,
    initialState: frozenInitial,
    currentState,
    activeStep,
    changedVars: frozenChangedVars,
    steps: frozenSteps,
    enabledTransitions: frozenTransitions,
    violatedInvariantIds: frozenViolated,
    ...(hasGoal && goalReached !== undefined ? { goalReached } : {}),
  });

  CANONICAL_SESSIONS.add(session);
  return { ok: true, session };
}

interface ValidatedSessionParts {
  readonly mode: ReplayMode;
  readonly model: TransitionSystemModel;
  readonly cursor: number;
  readonly initialState: StateSnapshot;
  readonly currentState: StateSnapshot;
  readonly steps: readonly TraceStep[];
  readonly canonicalSession: ReplaySession;
}

const OPTIONAL_SESSION_FIELDS = [
  'totalSteps',
  'canStepBack',
  'canStepForward',
  'activeStep',
  'changedVars',
  'enabledTransitions',
  'violatedInvariantIds',
  'goalReached',
] as const;

function validateSessionInput(
  raw: unknown,
):
  | { readonly ok: true; readonly parts: ValidatedSessionParts }
  | { readonly ok: false; readonly errors: readonly ValidationError[] } {
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      errors: Object.freeze([
        createError('INVALID_SESSION', 'session', 'Replay session must be a plain object.'),
      ]),
    };
  }

  if (CANONICAL_SESSIONS.has(raw as unknown as ReplaySession)) {
    const trusted = raw as unknown as ReplaySession;
    return {
      ok: true,
      parts: {
        mode: trusted.mode,
        model: trusted.model,
        cursor: trusted.cursor,
        initialState: trusted.initialState,
        currentState: trusted.currentState,
        steps: trusted.steps,
        canonicalSession: trusted,
      },
    };
  }

  for (const field of OPTIONAL_SESSION_FIELDS) {
    const prop = readOwnDataProp(raw, field);
    if (prop.kind === 'accessor') {
      return {
        ok: false,
        errors: Object.freeze([
          createError(
            'INVALID_SESSION',
            `session.${field}`,
            `Replay session ${field} must not be an accessor property.`,
          ),
        ]),
      };
    }
  }

  const modeProp = readOwnDataProp(raw, 'mode');
  const modelProp = readOwnDataProp(raw, 'model');
  const cursorProp = readOwnDataProp(raw, 'cursor');
  const initialStateProp = readOwnDataProp(raw, 'initialState');
  const currentStateProp = readOwnDataProp(raw, 'currentState');
  const stepsProp = readOwnDataProp(raw, 'steps');

  if (
    modeProp.kind !== 'value' ||
    modelProp.kind !== 'value' ||
    cursorProp.kind !== 'value' ||
    initialStateProp.kind !== 'value' ||
    currentStateProp.kind !== 'value' ||
    stepsProp.kind !== 'value'
  ) {
    return {
      ok: false,
      errors: Object.freeze([
        createError(
          'INVALID_SESSION',
          'session',
          'Replay session is missing required data properties.',
        ),
      ]),
    };
  }

  if (modeProp.value !== 'trace' && modeProp.value !== 'manual') {
    return {
      ok: false,
      errors: Object.freeze([
        createError(
          'INVALID_SESSION',
          'session.mode',
          'Replay session mode must be "trace" or "manual".',
        ),
      ]),
    };
  }

  const modelErrors = validateModel(modelProp.value);
  if (modelErrors.length > 0) {
    return { ok: false, errors: freezeErrors(modelErrors) };
  }
  const frozenModel = deepCloneAndFreezeModel(modelProp.value as TransitionSystemModel);

  const frozenInitial = cloneAndFreezeSnapshot(initialStateProp.value);
  if (frozenInitial === null) {
    return {
      ok: false,
      errors: Object.freeze([
        createError(
          'INVALID_SESSION',
          'session.initialState',
          'Replay session initialState must be a flat primitive state snapshot.',
        ),
      ]),
    };
  }

  const frozenCurrent = cloneAndFreezeSnapshot(currentStateProp.value);
  if (frozenCurrent === null) {
    return {
      ok: false,
      errors: Object.freeze([
        createError(
          'INVALID_SESSION',
          'session.currentState',
          'Replay session currentState must be a flat primitive state snapshot.',
        ),
      ]),
    };
  }

  const stepsRead = readSafeArray(stepsProp.value, MAX_REPLAY_STEPS);
  if (!stepsRead.ok) {
    return {
      ok: false,
      errors: Object.freeze([
        createError(
          'INVALID_SESSION',
          'session.steps',
          `Replay session steps must be a dense array with at most ${MAX_REPLAY_STEPS} entries.`,
        ),
      ]),
    };
  }

  const validatedSteps: TraceStep[] = [];
  for (let i = 0; i < stepsRead.items.length; i += 1) {
    const entry = stepsRead.items[i];
    if (!isPlainObject(entry)) {
      return {
        ok: false,
        errors: Object.freeze([
          createError(
            'INVALID_SESSION',
            `session.steps[${i}]`,
            'Replay session step must be a plain object.',
          ),
        ]),
      };
    }
    const ruleIdProp = readOwnDataProp(entry, 'ruleId');
    const beforeProp = readOwnDataProp(entry, 'stateBefore');
    const afterProp = readOwnDataProp(entry, 'stateAfter');
    const changedProp = readOwnDataProp(entry, 'changedVars');
    if (
      ruleIdProp.kind !== 'value' ||
      typeof ruleIdProp.value !== 'string' ||
      beforeProp.kind !== 'value' ||
      afterProp.kind !== 'value' ||
      changedProp.kind !== 'value'
    ) {
      return {
        ok: false,
        errors: Object.freeze([
          createError(
            'INVALID_SESSION',
            `session.steps[${i}]`,
            'Replay session step has invalid fields.',
          ),
        ]),
      };
    }
    const frozenBefore = cloneAndFreezeSnapshot(beforeProp.value);
    const frozenAfter = cloneAndFreezeSnapshot(afterProp.value);
    const changedArr = readOwnStringArray(changedProp.value);
    if (frozenBefore === null || frozenAfter === null || !changedArr.ok) {
      return {
        ok: false,
        errors: Object.freeze([
          createError(
            'INVALID_SESSION',
            `session.steps[${i}]`,
            'Replay session step contains invalid snapshot or changedVars data.',
          ),
        ]),
      };
    }
    validatedSteps.push(
      Object.freeze({
        ruleId: ruleIdProp.value,
        stateBefore: frozenBefore,
        stateAfter: frozenAfter,
        changedVars: Object.freeze([...changedArr.items]),
      }),
    );
  }

  if (
    typeof cursorProp.value !== 'number' ||
    !Number.isSafeInteger(cursorProp.value) ||
    cursorProp.value < 0 ||
    cursorProp.value > validatedSteps.length
  ) {
    return {
      ok: false,
      errors: Object.freeze([
        createError(
          'INVALID_SESSION',
          'session.cursor',
          'Replay session cursor must be a safe integer within [0, steps.length].',
        ),
      ]),
    };
  }

  const initRes = getInitialState(frozenModel);
  if (!initRes.ok) {
    return { ok: false, errors: freezeErrors(initRes.errors) };
  }
  if (!snapshotsEqual(frozenInitial, initRes.state)) {
    return {
      ok: false,
      errors: Object.freeze([
        createError(
          'INVALID_SESSION',
          'session.initialState',
          'Replay session initialState disagrees with the model initial state.',
        ),
      ]),
    };
  }

  const fullReplay = replayTrace(
    frozenModel,
    validatedSteps.map((s) => s.ruleId),
  );
  if (!fullReplay.ok || fullReplay.steps.length !== validatedSteps.length) {
    return {
      ok: false,
      errors: Object.freeze([
        createError(
          'INVALID_SESSION',
          'session.steps',
          'Replay session steps cannot be replayed against the declared model.',
        ),
      ]),
    };
  }

  for (let i = 0; i < validatedSteps.length; i += 1) {
    const provided = validatedSteps[i]!;
    const expected = fullReplay.steps[i]!;
    if (
      provided.ruleId !== expected.ruleId ||
      !snapshotsEqual(provided.stateBefore, expected.stateBefore) ||
      !snapshotsEqual(provided.stateAfter, expected.stateAfter) ||
      !stringArraysEqual(provided.changedVars, expected.changedVars)
    ) {
      return {
        ok: false,
        errors: Object.freeze([
          createError(
            'INVALID_SESSION',
            `session.steps[${i}]`,
            'Replay session step snapshot or diff disagrees with model replay semantics.',
          ),
        ]),
      };
    }
  }

  const expectedCurrent =
    cursorProp.value === 0 ? initRes.state : fullReplay.steps[cursorProp.value - 1]!.stateAfter;
  if (!snapshotsEqual(frozenCurrent, expectedCurrent)) {
    return {
      ok: false,
      errors: Object.freeze([
        createError(
          'INVALID_SESSION',
          'session.currentState',
          'Replay session currentState disagrees with the trace state at session.cursor.',
        ),
      ]),
    };
  }

  const canonical = buildSessionAtCursor(
    modeProp.value,
    frozenModel,
    initRes.state,
    fullReplay.steps,
    cursorProp.value,
  );
  if (!canonical.ok) {
    return { ok: false, errors: canonical.errors };
  }

  return {
    ok: true,
    parts: {
      mode: modeProp.value,
      model: frozenModel,
      cursor: cursorProp.value,
      initialState: initRes.state,
      currentState: canonical.session.currentState,
      steps: canonical.session.steps,
      canonicalSession: canonical.session,
    },
  };
}

export function createTraceReplaySession(
  model: unknown,
  ruleIds: unknown,
): ReplaySessionInitResult {
  try {
    const modelErrors = validateModel(model);
    if (modelErrors.length > 0) {
      return makeInitFailure(-1, modelErrors);
    }

    const frozenModel = deepCloneAndFreezeModel(model as TransitionSystemModel);
    let capturedInput: unknown = ruleIds;
    if (Array.isArray(ruleIds)) {
      const lenDesc = Object.getOwnPropertyDescriptor(ruleIds, 'length');
      if (
        lenDesc === undefined ||
        'get' in lenDesc ||
        'set' in lenDesc ||
        typeof lenDesc.value !== 'number' ||
        !Number.isSafeInteger(lenDesc.value) ||
        lenDesc.value < 0
      ) {
        return makeInitFailure(-1, [
          createError('INVALID_TRACE', 'ruleIds', 'ruleIds must be an array of rule id strings.'),
        ]);
      }
      if (lenDesc.value > MAX_REPLAY_STEPS) {
        return makeInitFailure(-1, [
          createError(
            'TRACE_TOO_LONG',
            'ruleIds',
            `Trace length exceeds maximum supported replay length (${MAX_REPLAY_STEPS}).`,
          ),
        ]);
      }

      const capturedRuleIds: unknown[] = [];
      const failWithPrefix = (idx: number, err: ValidationError): ReplaySessionInitResult => {
        const prefixRes = replayTrace(frozenModel, capturedRuleIds);
        if (!prefixRes.ok) {
          return makeInitFailure(prefixRes.stepIndex, extractCoreErrors(prefixRes), prefixRes.steps);
        }
        return makeInitFailure(idx, [err], prefixRes.steps);
      };

      for (let i = 0; i < lenDesc.value; i += 1) {
        let elemDesc: PropertyDescriptor | undefined;
        try {
          elemDesc = Object.getOwnPropertyDescriptor(ruleIds, i);
        } catch {
          return failWithPrefix(i, createUnexpectedError());
        }
        if (elemDesc === undefined) {
          return failWithPrefix(
            i,
            createError('INVALID_TRACE', `ruleIds[${i}]`, `Sparse hole at ruleIds[${i}] is not permitted.`),
          );
        }
        if ('get' in elemDesc || 'set' in elemDesc) {
          return failWithPrefix(
            i,
            createError(
              'INVALID_ACCESSOR_PROPERTY',
              `ruleIds[${i}]`,
              `Property "ruleIds[${i}]" must be a plain data property, not an accessor.`,
            ),
          );
        }
        capturedRuleIds.push(elemDesc.value);
      }

      capturedInput = capturedRuleIds;
    }

    const replayed = replayTrace(frozenModel, capturedInput);
    if (!replayed.ok) {
      return makeInitFailure(replayed.stepIndex, extractCoreErrors(replayed), replayed.steps);
    }

    const initState = getInitialState(frozenModel);
    if (!initState.ok) {
      return makeInitFailure(-1, initState.errors);
    }

    const built = buildSessionAtCursor(
      'trace',
      frozenModel,
      initState.state,
      replayed.steps,
      0,
    );
    if (!built.ok) {
      return makeInitFailure(-1, built.errors, replayed.steps);
    }

    return Object.freeze({ ok: true, session: built.session });
  } catch {
    return makeInitFailure(-1, [createUnexpectedError()]);
  }
}

export function createManualSimulationSession(model: unknown): ReplaySessionInitResult {
  try {
    const modelErrors = validateModel(model);
    if (modelErrors.length > 0) {
      return makeInitFailure(-1, modelErrors);
    }

    const frozenModel = deepCloneAndFreezeModel(model as TransitionSystemModel);
    const initState = getInitialState(frozenModel);
    if (!initState.ok) {
      return makeInitFailure(-1, initState.errors);
    }

    const built = buildSessionAtCursor(
      'manual',
      frozenModel,
      initState.state,
      EMPTY_STEPS,
      0,
    );
    if (!built.ok) {
      return makeInitFailure(-1, built.errors);
    }

    return Object.freeze({ ok: true, session: built.session });
  } catch {
    return makeInitFailure(-1, [createUnexpectedError()]);
  }
}

function parseStartAtOption(
  options: unknown,
):
  | { readonly ok: true; readonly startAt: 'initial' | 'terminal' }
  | { readonly ok: false; readonly error: ValidationError } {
  if (options === undefined) {
    return { ok: true, startAt: 'initial' };
  }
  if (!isPlainObject(options)) {
    return {
      ok: false,
      error: createError(
        'INVALID_REPLAY_OPTIONS',
        'options',
        'Verdict replay options must be a plain object when provided.',
      ),
    };
  }
  const startAtProp = readOwnDataProp(options, 'startAt');
  if (startAtProp.kind === 'missing') {
    return { ok: true, startAt: 'initial' };
  }
  if (startAtProp.kind !== 'value') {
    return {
      ok: false,
      error: createError(
        'INVALID_REPLAY_OPTIONS',
        'options.startAt',
        'options.startAt must be a plain data property.',
      ),
    };
  }
  if (startAtProp.value === undefined) {
    return { ok: true, startAt: 'initial' };
  }
  if (startAtProp.value !== 'initial' && startAtProp.value !== 'terminal') {
    return {
      ok: false,
      error: createError(
        'INVALID_REPLAY_OPTIONS',
        'options.startAt',
        'options.startAt must be "initial" or "terminal".',
      ),
    };
  }
  return { ok: true, startAt: startAtProp.value };
}

export function createVerdictReplaySession(
  model: unknown,
  result: VerifyResult,
  options?: VerdictReplayOptions,
): ReplaySessionInitResult {
  try {
    const parsedOptions = parseStartAtOption(options);
    if (!parsedOptions.ok) {
      return makeInitFailure(-1, [parsedOptions.error]);
    }

    const rawResult: unknown = result;
    if (!isPlainObject(rawResult)) {
      return makeInitFailure(-1, [
        createError('INVALID_VERIFY_RESULT', 'result', 'Expected a valid VerifyResult object.'),
      ]);
    }

    const statusProp = readOwnDataProp(rawResult, 'status');
    if (statusProp.kind !== 'value' || typeof statusProp.value !== 'string') {
      return makeInitFailure(-1, [
        createError(
          'INVALID_VERIFY_RESULT',
          'result.status',
          'VerifyResult must have a string status property.',
        ),
      ]);
    }

    if (statusProp.value === 'VIOLATED') {
      const traceProp = readOwnDataProp(rawResult, 'trace');
      if (traceProp.kind !== 'value') {
        return makeInitFailure(-1, [
          createError(
            'INVALID_VERIFY_RESULT',
            'result.trace',
            'VIOLATED VerifyResult must include a trace array.',
          ),
        ]);
      }
      const traceRead = readSafeArray(traceProp.value, MAX_REPLAY_STEPS);
      if (!traceRead.ok) {
        return makeInitFailure(-1, [
          createError(
            'INVALID_VERIFY_RESULT',
            'result.trace',
            `VIOLATED VerifyResult must include a dense trace array with at most ${MAX_REPLAY_STEPS} steps.`,
          ),
        ]);
      }

      const ruleIds: string[] = [];
      const expectedSteps: TraceStep[] = [];
      for (let i = 0; i < traceRead.items.length; i += 1) {
        const stepObj = traceRead.items[i];
        if (!isPlainObject(stepObj)) {
          return makeInitFailure(-1, [
            createError(
              'INVALID_VERIFY_RESULT',
              `result.trace[${i}]`,
              'Trace step must be a plain object.',
            ),
          ]);
        }
        const ruleIdProp = readOwnDataProp(stepObj, 'ruleId');
        if (ruleIdProp.kind !== 'value' || typeof ruleIdProp.value !== 'string') {
          return makeInitFailure(-1, [
            createError(
              'INVALID_VERIFY_RESULT',
              `result.trace[${i}].ruleId`,
              'Trace step ruleId must be a string.',
            ),
          ]);
        }
        const beforeProp = readOwnDataProp(stepObj, 'stateBefore');
        if (beforeProp.kind !== 'value') {
          return makeInitFailure(-1, [
            createError(
              'INVALID_VERIFY_RESULT',
              `result.trace[${i}].stateBefore`,
              'Trace step stateBefore must be a plain state snapshot.',
            ),
          ]);
        }
        const expectedBefore = cloneAndFreezeSnapshot(beforeProp.value);
        if (expectedBefore === null) {
          return makeInitFailure(-1, [
            createError(
              'INVALID_VERIFY_RESULT',
              `result.trace[${i}].stateBefore`,
              'Trace step stateBefore must be a valid state snapshot.',
            ),
          ]);
        }
        const afterProp = readOwnDataProp(stepObj, 'stateAfter');
        if (afterProp.kind !== 'value') {
          return makeInitFailure(-1, [
            createError(
              'INVALID_VERIFY_RESULT',
              `result.trace[${i}].stateAfter`,
              'Trace step stateAfter must be a plain state snapshot.',
            ),
          ]);
        }
        const expectedAfter = cloneAndFreezeSnapshot(afterProp.value);
        if (expectedAfter === null) {
          return makeInitFailure(-1, [
            createError(
              'INVALID_VERIFY_RESULT',
              `result.trace[${i}].stateAfter`,
              'Trace step stateAfter must be a valid state snapshot.',
            ),
          ]);
        }
        const changedProp = readOwnDataProp(stepObj, 'changedVars');
        if (changedProp.kind !== 'value') {
          return makeInitFailure(-1, [
            createError(
              'INVALID_VERIFY_RESULT',
              `result.trace[${i}].changedVars`,
              'Trace step changedVars must be a string array.',
            ),
          ]);
        }
        const changedRead = readOwnStringArray(changedProp.value);
        if (!changedRead.ok) {
          return makeInitFailure(-1, [
            createError(
              'INVALID_VERIFY_RESULT',
              `result.trace[${i}].changedVars`,
              'Trace step changedVars must be a valid string array.',
            ),
          ]);
        }

        ruleIds.push(ruleIdProp.value);
        expectedSteps.push(
          Object.freeze({
            ruleId: ruleIdProp.value,
            stateBefore: expectedBefore,
            stateAfter: expectedAfter,
            changedVars: Object.freeze([...changedRead.items]),
          }),
        );
      }

      const terminalProp = readOwnDataProp(rawResult, 'terminalState');
      if (terminalProp.kind !== 'value') {
        return makeInitFailure(-1, [
          createError(
            'INVALID_VERIFY_RESULT',
            'result.terminalState',
            'VIOLATED VerifyResult must include a terminalState snapshot.',
          ),
        ]);
      }
      const expectedTerminalState = cloneAndFreezeSnapshot(terminalProp.value);
      if (expectedTerminalState === null) {
        return makeInitFailure(-1, [
          createError(
            'INVALID_VERIFY_RESULT',
            'result.terminalState',
            'VIOLATED VerifyResult terminalState must be a valid state snapshot.',
          ),
        ]);
      }

      const violatedProp = readOwnDataProp(rawResult, 'violatedInvariantIds');
      if (violatedProp.kind !== 'value') {
        return makeInitFailure(-1, [
          createError(
            'INVALID_VERIFY_RESULT',
            'result.violatedInvariantIds',
            'VIOLATED VerifyResult must include a non-empty violatedInvariantIds array.',
          ),
        ]);
      }
      const violatedRead = readOwnStringArray(violatedProp.value, 256);
      if (!violatedRead.ok || violatedRead.items.length === 0) {
        return makeInitFailure(-1, [
          createError(
            'INVALID_VERIFY_RESULT',
            'result.violatedInvariantIds',
            'VIOLATED VerifyResult must include a non-empty violatedInvariantIds string array.',
          ),
        ]);
      }
      const expectedViolatedIds = violatedRead.items;

      const goalReachableProp = readOwnDataProp(rawResult, 'goalReachable');
      if (
        goalReachableProp.kind === 'accessor' ||
        (goalReachableProp.kind === 'value' &&
          goalReachableProp.value !== undefined &&
          goalReachableProp.value !== true)
      ) {
        return makeInitFailure(-1, [
          createError(
            'INVALID_VERIFY_RESULT',
            'result.goalReachable',
            'VIOLATED VerifyResult goalReachable must be true when present.',
          ),
        ]);
      }
      const expectedGoalReachable =
        goalReachableProp.kind === 'value' && goalReachableProp.value === true;

      const init = createTraceReplaySession(model, ruleIds);
      if (!init.ok) {
        return init;
      }

      const terminalNav =
        init.session.totalSteps === 0
          ? { ok: true as const, session: init.session }
          : jumpReplayToStep(init.session, init.session.totalSteps);
      if (!terminalNav.ok) {
        return makeInitFailure(-1, terminalNav.errors, init.session.steps);
      }

      for (let i = 0; i < expectedSteps.length; i += 1) {
        const actual = terminalNav.session.steps[i];
        const expected = expectedSteps[i]!;
        if (
          actual === undefined ||
          actual.ruleId !== expected.ruleId ||
          !snapshotsEqual(actual.stateBefore, expected.stateBefore) ||
          !snapshotsEqual(actual.stateAfter, expected.stateAfter) ||
          !stringArraysEqual(actual.changedVars, expected.changedVars)
        ) {
          return makeInitFailure(i, [
            createError(
              'VERDICT_MODEL_MISMATCH',
              `result.trace[${i}]`,
              `Replayed trace step ${i} does not match the supplied VIOLATED verdict.`,
            ),
          ]);
        }
      }

      if (!snapshotsEqual(terminalNav.session.currentState, expectedTerminalState)) {
        return makeInitFailure(-1, [
          createError(
            'VERDICT_MODEL_MISMATCH',
            'result.terminalState',
            'Replayed terminal state does not match the supplied VIOLATED verdict.',
          ),
        ]);
      }

      if (!stringArraysEqual(terminalNav.session.violatedInvariantIds, expectedViolatedIds)) {
        return makeInitFailure(-1, [
          createError(
            'VERDICT_MODEL_MISMATCH',
            'result.violatedInvariantIds',
            'Replayed violated invariants do not match the supplied VIOLATED verdict.',
          ),
        ]);
      }

      if (expectedGoalReachable && !Object.hasOwn(terminalNav.session, 'goalReached')) {
        return makeInitFailure(-1, [
          createError(
            'VERDICT_MODEL_MISMATCH',
            'result.goalReachable',
            'VIOLATED verdict reports goalReachable: true, but the model declares no goal.',
          ),
        ]);
      }

      if (parsedOptions.startAt === 'terminal') {
        return Object.freeze({ ok: true, session: terminalNav.session });
      }

      return init;
    }

    if (statusProp.value === 'INVALID') {
      const errorsProp = readOwnDataProp(rawResult, 'errors');
      if (errorsProp.kind !== 'value') {
        return makeInitFailure(-1, [
          createError(
            'INVALID_VERIFY_RESULT',
            'result.errors',
            'INVALID VerifyResult must include a non-empty errors array.',
          ),
        ]);
      }
      const errorsRead = readSafeArray(errorsProp.value, MAX_SAFE_ARRAY_LENGTH);
      if (!errorsRead.ok || errorsRead.items.length === 0) {
        return makeInitFailure(-1, [
          createError(
            'INVALID_VERIFY_RESULT',
            'result.errors',
            'INVALID VerifyResult must include a non-empty errors array.',
          ),
        ]);
      }

      const extractedErrors: ValidationError[] = [];
      for (let i = 0; i < errorsRead.items.length; i += 1) {
        const errObj = errorsRead.items[i];
        if (!isPlainObject(errObj)) {
          return makeInitFailure(-1, [
            createError(
              'INVALID_VERIFY_RESULT',
              `result.errors[${i}]`,
              'Validation error entry must be a plain object.',
            ),
          ]);
        }
        const codeProp = readOwnDataProp(errObj, 'code');
        const pathProp = readOwnDataProp(errObj, 'path');
        const msgProp = readOwnDataProp(errObj, 'message');
        if (
          codeProp.kind !== 'value' ||
          typeof codeProp.value !== 'string' ||
          pathProp.kind !== 'value' ||
          typeof pathProp.value !== 'string' ||
          msgProp.kind !== 'value' ||
          typeof msgProp.value !== 'string'
        ) {
          return makeInitFailure(-1, [
            createError(
              'INVALID_VERIFY_RESULT',
              `result.errors[${i}]`,
              'Validation error entry must have string code, path, and message.',
            ),
          ]);
        }
        extractedErrors.push(createError(codeProp.value, pathProp.value, msgProp.value));
      }

      let completedSteps: readonly TraceStep[] = EMPTY_STEPS;
      try {
        const traceProp = readOwnDataProp(rawResult, 'trace');
        if (traceProp.kind === 'value' && Array.isArray(traceProp.value)) {
          const traceVal = traceProp.value;
          const lenDesc = Object.getOwnPropertyDescriptor(traceVal, 'length');
          if (
            lenDesc !== undefined &&
            !('get' in lenDesc) &&
            !('set' in lenDesc) &&
            typeof lenDesc.value === 'number' &&
            Number.isSafeInteger(lenDesc.value) &&
            lenDesc.value >= 0
          ) {
            const limit = Math.min(lenDesc.value, MAX_REPLAY_STEPS);
            const validSteps: TraceStep[] = [];
            for (let i = 0; i < limit; i += 1) {
              try {
                const elemDesc = Object.getOwnPropertyDescriptor(traceVal, i);
                if (elemDesc === undefined || 'get' in elemDesc || 'set' in elemDesc) {
                  break;
                }
                const entry = elemDesc.value;
                if (!isPlainObject(entry)) {
                  break;
                }
                const ruleIdProp = readOwnDataProp(entry, 'ruleId');
                const beforeProp = readOwnDataProp(entry, 'stateBefore');
                const afterProp = readOwnDataProp(entry, 'stateAfter');
                const changedProp = readOwnDataProp(entry, 'changedVars');
                if (
                  ruleIdProp.kind !== 'value' ||
                  typeof ruleIdProp.value !== 'string' ||
                  beforeProp.kind !== 'value' ||
                  afterProp.kind !== 'value' ||
                  changedProp.kind !== 'value'
                ) {
                  break;
                }
                const frozenBefore = cloneAndFreezeSnapshot(beforeProp.value);
                const frozenAfter = cloneAndFreezeSnapshot(afterProp.value);
                const changedArr = readOwnStringArray(changedProp.value);
                if (frozenBefore === null || frozenAfter === null || !changedArr.ok) {
                  break;
                }
                validSteps.push(
                  Object.freeze({
                    ruleId: ruleIdProp.value,
                    stateBefore: frozenBefore,
                    stateAfter: frozenAfter,
                    changedVars: Object.freeze([...changedArr.items]),
                  }),
                );
              } catch {
                break;
              }
            }
            completedSteps = Object.freeze(validSteps);
          }
        }
      } catch {
        completedSteps = EMPTY_STEPS;
      }

      return makeInitFailure(-1, extractedErrors, completedSteps);
    }

    if (statusProp.value === 'VERIFIED' || statusProp.value === 'INCONCLUSIVE') {
      const goalReachableProp = readOwnDataProp(rawResult, 'goalReachable');
      if (goalReachableProp.kind === 'accessor') {
        return makeInitFailure(-1, [
          createError(
            'INVALID_VERIFY_RESULT',
            'result.goalReachable',
            'VerifyResult goalReachable must be a plain data property.',
          ),
        ]);
      }

      const goalReachablePresent =
        goalReachableProp.kind === 'value' && goalReachableProp.value !== undefined;
      let goalReachableValue: boolean | undefined;
      if (goalReachablePresent) {
        if (statusProp.value === 'INCONCLUSIVE') {
          if (goalReachableProp.value !== true) {
            return makeInitFailure(-1, [
              createError(
                'INVALID_VERIFY_RESULT',
                'result.goalReachable',
                'INCONCLUSIVE VerifyResult goalReachable must be true when present.',
              ),
            ]);
          }
          goalReachableValue = true;
        } else {
          if (typeof goalReachableProp.value !== 'boolean') {
            return makeInitFailure(-1, [
              createError(
                'INVALID_VERIFY_RESULT',
                'result.goalReachable',
                'VERIFIED VerifyResult goalReachable must be a boolean when present.',
              ),
            ]);
          }
          goalReachableValue = goalReachableProp.value;
        }
      }

      const manualInit = createManualSimulationSession(model);
      if (!manualInit.ok) {
        return manualInit;
      }

      if (manualInit.session.violatedInvariantIds.length > 0) {
        return makeInitFailure(-1, [
          createError(
            'VERDICT_MODEL_MISMATCH',
            'result.status',
            `${statusProp.value} verdict contradicts a model whose initial state violates invariants.`,
          ),
        ]);
      }

      if (goalReachablePresent && !Object.hasOwn(manualInit.session, 'goalReached')) {
        return makeInitFailure(-1, [
          createError(
            'VERDICT_MODEL_MISMATCH',
            'result.goalReachable',
            `${statusProp.value} verdict reports goalReachable, but the model declares no goal.`,
          ),
        ]);
      }

      if (
        statusProp.value === 'VERIFIED' &&
        goalReachableValue === false &&
        manualInit.session.goalReached === true
      ) {
        return makeInitFailure(-1, [
          createError(
            'VERDICT_MODEL_MISMATCH',
            'result.goalReachable',
            'VERIFIED verdict reports goalReachable: false, but the initial state already reaches the goal.',
          ),
        ]);
      }

      return manualInit;
    }

    return makeInitFailure(-1, [
      createError(
        'INVALID_VERIFY_RESULT',
        'result.status',
        'Unrecognized VerifyResult status value.',
      ),
    ]);
  } catch {
    return makeInitFailure(-1, [createUnexpectedError()]);
  }
}

export function jumpReplayToStep(
  session: ReplaySession,
  stepIndex: number,
): ReplayStepNavResult {
  try {
    const validated = validateSessionInput(session);
    if (!validated.ok) {
      return makeNavFailure(validated.errors);
    }

    const { parts } = validated;
    const rawIndex: unknown = stepIndex;
    if (
      typeof rawIndex !== 'number' ||
      !Number.isSafeInteger(rawIndex) ||
      rawIndex < 0 ||
      rawIndex > parts.steps.length
    ) {
      return makeNavFailure(
        [
          createError(
            'INVALID_STEP_INDEX',
            'stepIndex',
            `Step index must be a safe integer between 0 and ${parts.steps.length}.`,
          ),
        ],
        parts.canonicalSession,
      );
    }

    const built = buildSessionAtCursor(
      parts.mode,
      parts.model,
      parts.initialState,
      parts.steps,
      rawIndex,
    );
    if (!built.ok) {
      return makeNavFailure(built.errors, parts.canonicalSession);
    }

    return Object.freeze({ ok: true, session: built.session });
  } catch {
    return makeNavFailure([createUnexpectedError()]);
  }
}

export function stepReplayForward(session: ReplaySession): ReplayStepNavResult {
  try {
    const validated = validateSessionInput(session);
    if (!validated.ok) {
      return makeNavFailure(validated.errors);
    }
    return jumpReplayToStep(validated.parts.canonicalSession, validated.parts.cursor + 1);
  } catch {
    return makeNavFailure([createUnexpectedError()]);
  }
}

export function stepReplayBackward(session: ReplaySession): ReplayStepNavResult {
  try {
    const validated = validateSessionInput(session);
    if (!validated.ok) {
      return makeNavFailure(validated.errors);
    }
    return jumpReplayToStep(validated.parts.canonicalSession, validated.parts.cursor - 1);
  } catch {
    return makeNavFailure([createUnexpectedError()]);
  }
}

export function resetReplaySession(session: ReplaySession): ReplayStepNavResult {
  try {
    const validated = validateSessionInput(session);
    if (!validated.ok) {
      return makeNavFailure(validated.errors);
    }

    const { parts } = validated;
    const nextSteps = parts.mode === 'trace' ? parts.steps : EMPTY_STEPS;
    const built = buildSessionAtCursor(
      parts.mode,
      parts.model,
      parts.initialState,
      nextSteps,
      0,
    );
    if (!built.ok) {
      return makeNavFailure(built.errors, parts.canonicalSession);
    }

    return Object.freeze({ ok: true, session: built.session });
  } catch {
    return makeNavFailure([createUnexpectedError()]);
  }
}

export function applyManualStep(
  session: ReplaySession,
  ruleId: unknown,
): ManualStepResult {
  try {
    const validated = validateSessionInput(session);
    if (!validated.ok) {
      return makeManualFailure(validated.errors);
    }

    const { parts } = validated;
    if (parts.cursor + 1 > MAX_REPLAY_STEPS) {
      return makeManualFailure(
        [
          createError(
            'TRACE_TOO_LONG',
            'steps',
            `Trace length exceeds maximum supported replay length (${MAX_REPLAY_STEPS}).`,
          ),
        ],
        parts.canonicalSession,
      );
    }

    const stepped = stepModel(parts.model, parts.canonicalSession.currentState, ruleId);
    if (!stepped.ok) {
      return makeManualFailure(extractCoreErrors(stepped), parts.canonicalSession);
    }

    const frozenStep = freezeStep(stepped.step);
    if (frozenStep === null) {
      return makeManualFailure([createUnexpectedError()], parts.canonicalSession);
    }

    const prefix = parts.steps.slice(0, parts.cursor);
    const nextSteps = Object.freeze([...prefix, frozenStep]);

    const built = buildSessionAtCursor(
      'manual',
      parts.model,
      parts.initialState,
      nextSteps,
      nextSteps.length,
    );
    if (!built.ok) {
      return makeManualFailure(built.errors, parts.canonicalSession);
    }

    const canonicalStep = built.session.activeStep;
    if (canonicalStep === null) {
      return makeManualFailure([createUnexpectedError()], parts.canonicalSession);
    }

    return Object.freeze({
      ok: true,
      session: built.session,
      step: canonicalStep,
    });
  } catch {
    return makeManualFailure([createUnexpectedError()]);
  }
}
