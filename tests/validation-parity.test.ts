import { verifyModel } from '../packages/rulecanvas-core/src/index.ts';
import { buildVerificationReportFromSnapshot } from '../packages/rulecanvas-ui/src/index.ts';
import { sanitizeAndFreezeVerifyResult } from '../packages/rulecanvas-workbench/src/verify.ts';
import type {
  BoolExpr,
  Goal,
  Invariant,
  TransitionRule,
  TransitionSystemModel,
  VerifyOptions,
} from '../packages/rulecanvas-core/src/index.ts';
import { describe, expect, it } from 'vitest';

const VAR_X = { op: 'var', name: 'x' } as const;

function boolLit(value: boolean): BoolExpr {
  return { op: 'lit', value };
}

function intLit(value: number): { readonly op: 'lit'; readonly value: number } {
  return { op: 'lit', value };
}

function atMost(n: number): Invariant {
  return {
    id: 'inv',
    label: `x at most ${n}`,
    holds: { op: 'lte', left: VAR_X, right: intLit(n) },
  };
}

function atLeast(n: number): Invariant {
  return {
    id: 'inv',
    label: `x at least ${n}`,
    holds: { op: 'gte', left: VAR_X, right: intLit(n) },
  };
}

function goalAtLeast(n: number): Goal {
  return {
    id: 'goal',
    label: `x reaches ${n}`,
    reached: { op: 'gte', left: VAR_X, right: intLit(n) },
  };
}

function increment(guard: BoolExpr): TransitionRule {
  return {
    id: 'inc',
    label: 'Increment',
    guard,
    updates: [{ var: 'x', value: { op: 'add', left: VAR_X, right: intLit(1) } }],
  };
}

function makeModel(overrides: {
  readonly max?: number;
  readonly rules?: readonly TransitionRule[];
  readonly invariant?: Invariant;
  readonly goal?: Goal;
}): TransitionSystemModel {
  return {
    id: 'parity-model',
    name: 'Parity model',
    schema: { x: { kind: 'int', min: 0, max: overrides.max ?? 2 } },
    initialState: { x: 0 },
    rules: [...(overrides.rules ?? [increment({ op: 'lt', left: VAR_X, right: intLit(2) })])],
    invariants: [overrides.invariant ?? atMost(10)],
    ...(overrides.goal !== undefined ? { goal: overrides.goal } : {}),
    assumptions: [
      { id: 'a1', category: 'scope', statement: 'Finite declared model.', notModeled: 'Physical.' },
    ],
  };
}

function reportAccepts(model: TransitionSystemModel, options: VerifyOptions, result: unknown): boolean {
  return buildVerificationReportFromSnapshot({ model, options, result }).ok;
}

function workerAccepts(model: TransitionSystemModel, options: VerifyOptions, result: unknown): boolean {
  return sanitizeAndFreezeVerifyResult(result, model, options).ok;
}

function expectParity(
  model: TransitionSystemModel,
  options: VerifyOptions,
  result: unknown,
  expected: boolean,
): void {
  const report = reportAccepts(model, options, result);
  const worker = workerAccepts(model, options, result);
  expect(report).toBe(expected);
  expect(worker).toBe(expected);
}

function genuine(model: TransitionSystemModel, options: VerifyOptions): unknown {
  return verifyModel(model, options);
}

const OPTIONS: VerifyOptions = { maxStates: 100, maxDepth: 10 };

const VERIFIED_WITH_GOAL = makeModel({ goal: goalAtLeast(1) });
const VERIFIED_WITHOUT_GOAL = makeModel({});
const VIOLATED_INITIAL = makeModel({
  max: 1,
  rules: [{ id: 'stay', label: 'Stay', guard: boolLit(true), updates: [{ var: 'x', value: intLit(0) }] }],
  invariant: atLeast(1),
});
const VIOLATED_WITNESS = makeModel({ max: 2, invariant: atMost(1), goal: goalAtLeast(1) });
const VIOLATED_NO_WITNESS = makeModel({ max: 2, invariant: atMost(1) });
const INCONCLUSIVE_STATES = makeModel({ max: 6, rules: [increment({ op: 'lt', left: VAR_X, right: intLit(6) })] });
const INCONCLUSIVE_DEPTH = makeModel({
  max: 10,
  rules: [increment({ op: 'lt', left: VAR_X, right: intLit(10) })],
});
const INCONCLUSIVE_DEPTH_ZERO = makeModel({ max: 2 });
const RUNTIME_DEPTH_ZERO = makeModel({
  max: 1,
  rules: [
    {
      id: 'overflow',
      label: 'Overflow',
      guard: boolLit(true),
      updates: [{ var: 'x', value: { op: 'add', left: VAR_X, right: intLit(2) } }],
    },
  ],
});
const RUNTIME_DEPTH_N = makeModel({
  max: 1,
  rules: [
    {
      id: 'to_one',
      label: 'Move to one',
      guard: { op: 'eq', left: VAR_X, right: intLit(0) },
      updates: [{ var: 'x', value: intLit(1) }],
    },
    {
      id: 'overflow',
      label: 'Overflow',
      guard: { op: 'eq', left: VAR_X, right: intLit(1) },
      updates: [{ var: 'x', value: { op: 'add', left: VAR_X, right: intLit(1) } }],
    },
  ],
});

const VALIDATION_INVALID = {
  status: 'INVALID',
  errors: [{ code: 'INVALID_MODEL', path: 'model', message: 'Model is malformed.' }],
};

const INCONCLUSIVE_STATES_OPTIONS: VerifyOptions = { maxStates: 2, maxDepth: 10 };
const INCONCLUSIVE_DEPTH_OPTIONS: VerifyOptions = { maxStates: 100, maxDepth: 2 };
const INCONCLUSIVE_DEPTH_ZERO_OPTIONS: VerifyOptions = { maxStates: 100, maxDepth: 0 };

describe('report and worker result validation parity', () => {
  it('accepts every valid core verdict category identically', () => {
    const cases: ReadonlyArray<readonly [TransitionSystemModel, VerifyOptions]> = [
      [VERIFIED_WITH_GOAL, OPTIONS],
      [VERIFIED_WITHOUT_GOAL, OPTIONS],
      [VIOLATED_INITIAL, OPTIONS],
      [VIOLATED_WITNESS, OPTIONS],
      [VIOLATED_NO_WITNESS, OPTIONS],
      [INCONCLUSIVE_STATES, INCONCLUSIVE_STATES_OPTIONS],
      [INCONCLUSIVE_DEPTH, INCONCLUSIVE_DEPTH_OPTIONS],
      [INCONCLUSIVE_DEPTH_ZERO, INCONCLUSIVE_DEPTH_ZERO_OPTIONS],
      [RUNTIME_DEPTH_ZERO, OPTIONS],
      [RUNTIME_DEPTH_N, OPTIONS],
    ];
    for (const [model, options] of cases) {
      const result = genuine(model, options);
      const status = (result as { status: string }).status;
      expect(['VERIFIED', 'VIOLATED', 'INCONCLUSIVE', 'INVALID']).toContain(status);
      expectParity(model, options, result, true);
    }
    expectParity(VERIFIED_WITHOUT_GOAL, OPTIONS, VALIDATION_INVALID, true);
  });

  it('rejects incompatible verdict-specific fields on all four statuses', () => {
    const verified = genuine(VERIFIED_WITH_GOAL, OPTIONS) as Record<string, unknown>;
    const violated = genuine(VIOLATED_NO_WITNESS, OPTIONS) as Record<string, unknown>;
    const inconclusive = genuine(INCONCLUSIVE_STATES, INCONCLUSIVE_STATES_OPTIONS) as Record<
      string,
      unknown
    >;
    const runtimeInvalid = genuine(RUNTIME_DEPTH_N, OPTIONS) as Record<string, unknown>;

    for (const field of [
      { trace: violated['trace'] },
      { terminalState: violated['terminalState'] },
      { violatedInvariantIds: ['inv'] },
      { reason: 'MAX_STATES' },
      { completedDepth: 0 },
      { frontierRemaining: 1 },
      { errors: VALIDATION_INVALID.errors },
    ]) {
      expectParity(VERIFIED_WITH_GOAL, OPTIONS, { ...verified, ...field }, false);
    }

    for (const field of [
      { reason: 'MAX_STATES' },
      { completedDepth: 0 },
      { frontierRemaining: 1 },
      { errors: VALIDATION_INVALID.errors },
    ]) {
      expectParity(VIOLATED_NO_WITNESS, OPTIONS, { ...violated, ...field }, false);
    }

    for (const field of [
      { trace: violated['trace'] },
      { terminalState: violated['terminalState'] },
      { violatedInvariantIds: ['inv'] },
      { errors: VALIDATION_INVALID.errors },
    ]) {
      expectParity(
        INCONCLUSIVE_STATES,
        INCONCLUSIVE_STATES_OPTIONS,
        { ...inconclusive, ...field },
        false,
      );
    }

    for (const field of [
      { assumptions: RUNTIME_DEPTH_N.assumptions },
      { goalReachable: true },
      { terminalState: violated['terminalState'] },
      { violatedInvariantIds: ['inv'] },
      { reason: 'MAX_STATES' },
      { completedDepth: 0 },
      { frontierRemaining: 1 },
    ]) {
      expectParity(RUNTIME_DEPTH_N, OPTIONS, { ...runtimeInvalid, ...field }, false);
    }

    for (const field of [
      { stats: verified['stats'] },
      { trace: violated['trace'] },
      { assumptions: VERIFIED_WITHOUT_GOAL.assumptions },
      { goalReachable: true },
      { terminalState: violated['terminalState'] },
      { violatedInvariantIds: ['inv'] },
      { reason: 'MAX_STATES' },
      { completedDepth: 0 },
      { frontierRemaining: 1 },
    ]) {
      expectParity(VERIFIED_WITHOUT_GOAL, OPTIONS, { ...VALIDATION_INVALID, ...field }, false);
    }

    const runtimeErrors = runtimeInvalid['errors'] as ReadonlyArray<Record<string, unknown>>;
    expectParity(
      RUNTIME_DEPTH_N,
      OPTIONS,
      {
        ...runtimeInvalid,
        errors: [...runtimeErrors, VALIDATION_INVALID.errors[0]!],
      },
      false,
    );
    expectParity(
      RUNTIME_DEPTH_N,
      OPTIONS,
      {
        ...runtimeInvalid,
        errors: [
          ...runtimeErrors,
          {
            code: 'OUT_OF_DOMAIN_TRANSITION',
            path: 'rules.missing.updates.x',
            message: 'Forged out-of-domain diagnostic.',
          },
        ],
      },
      false,
    );
  });

  it('requires paired stats and trace for runtime out-of-domain INVALID results', () => {
    const runtime = genuine(RUNTIME_DEPTH_N, OPTIONS) as Record<string, unknown>;
    expectParity(RUNTIME_DEPTH_N, OPTIONS, { ...runtime, stats: undefined }, false);
    expectParity(RUNTIME_DEPTH_N, OPTIONS, { ...runtime, trace: undefined }, false);
    const withoutStats = { ...runtime };
    delete withoutStats['stats'];
    const withoutTrace = { ...runtime };
    delete withoutTrace['trace'];
    expectParity(RUNTIME_DEPTH_N, OPTIONS, withoutStats, false);
    expectParity(RUNTIME_DEPTH_N, OPTIONS, withoutTrace, false);
    expectParity(RUNTIME_DEPTH_N, OPTIONS, { status: 'INVALID', errors: runtime['errors'] }, false);
  });

  it('rejects invalid statistics identically', () => {
    const verified = genuine(VERIFIED_WITH_GOAL, OPTIONS) as {
      stats: Record<string, unknown>;
    };
    const stats = verified.stats;
    for (const mutation of [
      { theoreticalStates: '999' },
      { statesExplored: 0 },
      { statesExplored: OPTIONS.maxStates + 1 },
      { maxDepthReached: OPTIONS.maxDepth + 1 },
      { deadlockStatesFound: (stats['statesExplored'] as number) + 1 },
    ]) {
      expectParity(
        VERIFIED_WITH_GOAL,
        OPTIONS,
        { ...verified, stats: { ...stats, ...mutation } },
        false,
      );
    }
  });

  it('rejects tampered traces, terminal states, and violated invariant ids identically', () => {
    const violated = genuine(VIOLATED_WITNESS, OPTIONS) as {
      trace: Array<Record<string, unknown>>;
      terminalState: Record<string, unknown>;
      violatedInvariantIds: string[];
    };
    expect(violated.trace.length).toBeGreaterThan(0);

    expectParity(
      VIOLATED_WITNESS,
      OPTIONS,
      {
        ...violated,
        trace: violated.trace.map((step, index) =>
          index === 0 ? { ...step, stateAfter: { x: 99 } } : step,
        ),
      },
      false,
    );
    expectParity(
      VIOLATED_WITNESS,
      OPTIONS,
      {
        ...violated,
        trace: violated.trace.map((step, index) =>
          index === 0 ? { ...step, ruleId: 'missing-rule' } : step,
        ),
      },
      false,
    );
    expectParity(VIOLATED_WITNESS, OPTIONS, { ...violated, trace: violated.trace.slice(0, -1) }, false);
    expectParity(VIOLATED_WITNESS, OPTIONS, { ...violated, terminalState: { x: 0 } }, false);
    expectParity(VIOLATED_WITNESS, OPTIONS, { ...violated, violatedInvariantIds: ['other'] }, false);
    expectParity(VIOLATED_WITNESS, OPTIONS, { ...violated, violatedInvariantIds: [] }, false);
  });

  it('rejects inconsistent inconclusive bounds identically', () => {
    const states = genuine(INCONCLUSIVE_STATES, INCONCLUSIVE_STATES_OPTIONS) as {
      stats: Record<string, unknown>;
    };
    expectParity(
      INCONCLUSIVE_STATES,
      INCONCLUSIVE_STATES_OPTIONS,
      { ...states, frontierRemaining: 0 },
      false,
    );
    expectParity(
      INCONCLUSIVE_STATES,
      INCONCLUSIVE_STATES_OPTIONS,
      { ...states, completedDepth: states.stats['maxDepthReached'] },
      false,
    );
    expectParity(
      INCONCLUSIVE_STATES,
      INCONCLUSIVE_STATES_OPTIONS,
      { ...states, stats: { ...states.stats, statesExplored: 1 } },
      false,
    );

    const depth = genuine(INCONCLUSIVE_DEPTH, INCONCLUSIVE_DEPTH_OPTIONS) as {
      stats: Record<string, unknown>;
    };
    expectParity(
      INCONCLUSIVE_DEPTH,
      INCONCLUSIVE_DEPTH_OPTIONS,
      { ...depth, completedDepth: 0 },
      false,
    );
    expectParity(
      INCONCLUSIVE_DEPTH,
      INCONCLUSIVE_DEPTH_OPTIONS,
      { ...depth, stats: { ...depth.stats, maxDepthReached: 1 } },
      false,
    );
  });

  it('handles negative zero bounds identically', () => {
    const model = makeModel({ max: 2 });
    const options = { maxStates: 100, maxDepth: -0 };
    const result = genuine(model, options);
    expect((result as { status: string }).status).toBe('INCONCLUSIVE');
    expectParity(model, options, result, true);
  });

  it('rejects forged and accessor payloads identically', () => {
    const verified = genuine(VERIFIED_WITH_GOAL, OPTIONS) as Record<string, unknown>;

    const accessorStatus: Record<string, unknown> = {};
    Object.defineProperty(accessorStatus, 'status', {
      enumerable: true,
      get() {
        return 'VERIFIED';
      },
    });
    Object.assign(accessorStatus, { stats: verified['stats'], assumptions: verified['assumptions'] });
    expectParity(VERIFIED_WITH_GOAL, OPTIONS, accessorStatus, false);

    const accessorStats = { ...verified };
    Object.defineProperty(accessorStats, 'stats', {
      enumerable: true,
      get() {
        return verified['stats'];
      },
    });
    expectParity(VERIFIED_WITH_GOAL, OPTIONS, accessorStats, false);

    const accessorTrace = { ...verified };
    Object.defineProperty(accessorTrace, 'trace', {
      enumerable: true,
      get() {
        return [];
      },
    });
    expectParity(VERIFIED_WITH_GOAL, OPTIONS, accessorTrace, false);

    const inherited = Object.create({ status: 'VERIFIED' }) as Record<string, unknown>;
    expectParity(VERIFIED_WITH_GOAL, OPTIONS, inherited, false);

    expectParity(VERIFIED_WITH_GOAL, OPTIONS, 'not-an-object', false);
    expectParity(VERIFIED_WITH_GOAL, OPTIONS, null, false);
  });

  it('handles repeated runtime diagnostics across many-rule models without per-diagnostic rule re-evaluation', () => {
    const rules: TransitionRule[] = [
      ...RUNTIME_DEPTH_N.rules,
      ...Array.from({ length: 30 }, (_, index) => ({
        id: `noop_${index}`,
        label: `No-op ${index}`,
        guard: boolLit(false),
        updates: [{ var: 'x', value: intLit(0) }],
      })),
    ];
    expect(rules).toHaveLength(32);
    const manyRuleOod = makeModel({ max: 1, rules });
    const base = genuine(manyRuleOod, OPTIONS) as {
      status: 'INVALID';
      errors: Array<{ code: string; path: string; message: string }>;
      stats: Record<string, unknown>;
      trace: unknown[];
    };
    expect(base.status).toBe('INVALID');
    expect(base.errors).toHaveLength(1);

    const repeatedErrors = Array.from({ length: 200 }, () => ({ ...base.errors[0]! }));
    expectParity(manyRuleOod, OPTIONS, { ...base, errors: repeatedErrors }, true);
    expectParity(
      manyRuleOod,
      OPTIONS,
      {
        ...base,
        errors: [
          ...repeatedErrors,
          {
            code: 'OUT_OF_DOMAIN_TRANSITION',
            path: 'rules.missing.updates.x',
            message: 'Forged trailing out-of-domain diagnostic.',
          },
        ],
      },
      false,
    );
  });

  it('rejects structured-cloned and direct arrays with unexpected properties, malformed indices, sparse holes, or bad descriptors identically', () => {
    const runtimeInvalid = structuredClone(genuine(RUNTIME_DEPTH_N, OPTIONS)) as {
      status: 'INVALID';
      errors: Array<Record<string, unknown>> & Record<string, unknown>;
      stats: Record<string, unknown>;
      trace: Array<Record<string, unknown> & { changedVars: string[] & Record<string, unknown> }> &
        Record<string, unknown>;
    };
    const violated = structuredClone(genuine(VIOLATED_WITNESS, OPTIONS)) as {
      status: 'VIOLATED';
      trace: Array<Record<string, unknown> & { changedVars: string[] & Record<string, unknown> }> &
        Record<string, unknown>;
      terminalState: Record<string, unknown>;
      violatedInvariantIds: string[] & Record<string, unknown>;
      stats: Record<string, unknown>;
      assumptions: Array<Record<string, unknown>> & Record<string, unknown>;
    };
    const verified = structuredClone(genuine(VERIFIED_WITH_GOAL, OPTIONS)) as {
      status: 'VERIFIED';
      stats: Record<string, unknown>;
      goalReachable: boolean;
      assumptions: Array<Record<string, unknown>> & Record<string, unknown>;
    };

    // Exact Finding 1 repro: runtime INVALID with result.errors.extra = 'unexpected' through structuredClone
    const runtimeExtraError = structuredClone(runtimeInvalid);
    runtimeExtraError.errors.extra = 'unexpected';
    expectParity(RUNTIME_DEPTH_N, OPTIONS, structuredClone(runtimeExtraError), false);

    // Validation INVALID with result.errors.extra = 'unexpected' through structuredClone
    const validationExtraError = structuredClone(VALIDATION_INVALID) as {
      status: 'INVALID';
      errors: Array<Record<string, unknown>> & Record<string, unknown>;
    };
    validationExtraError.errors.extra = 'unexpected';
    expectParity(VERIFIED_WITHOUT_GOAL, OPTIONS, structuredClone(validationExtraError), false);

    // result.trace.extra and result.trace[0].changedVars.extra across VIOLATED and runtime INVALID
    const violatedExtraTrace = structuredClone(violated);
    violatedExtraTrace.trace.extra = 'unexpected';
    expectParity(VIOLATED_WITNESS, OPTIONS, structuredClone(violatedExtraTrace), false);

    const runtimeExtraTrace = structuredClone(runtimeInvalid);
    runtimeExtraTrace.trace.extra = 'unexpected';
    expectParity(RUNTIME_DEPTH_N, OPTIONS, structuredClone(runtimeExtraTrace), false);

    const violatedExtraChangedVars = structuredClone(violated);
    violatedExtraChangedVars.trace[0]!.changedVars.extra = 'unexpected';
    expectParity(VIOLATED_WITNESS, OPTIONS, structuredClone(violatedExtraChangedVars), false);

    const runtimeExtraChangedVars = structuredClone(runtimeInvalid);
    runtimeExtraChangedVars.trace[0]!.changedVars.extra = 'unexpected';
    expectParity(RUNTIME_DEPTH_N, OPTIONS, structuredClone(runtimeExtraChangedVars), false);

    // result.violatedInvariantIds.extra and result.assumptions.extra
    const violatedExtraIds = structuredClone(violated);
    violatedExtraIds.violatedInvariantIds.extra = 'unexpected';
    expectParity(VIOLATED_WITNESS, OPTIONS, structuredClone(violatedExtraIds), false);

    const verifiedExtraAssumptions = structuredClone(verified);
    verifiedExtraAssumptions.assumptions.extra = 'unexpected';
    expectParity(VERIFIED_WITH_GOAL, OPTIONS, structuredClone(verifiedExtraAssumptions), false);

    // Nested arrays with unexpected properties inside extra result or error metadata
    const nestedInError = structuredClone(runtimeInvalid);
    const badNestedArr = ['ok'] as string[] & Record<string, unknown>;
    badNestedArr.extra = 'unexpected';
    nestedInError.errors[0]!['nested'] = badNestedArr;
    expectParity(RUNTIME_DEPTH_N, OPTIONS, structuredClone(nestedInError), false);

    const nestedInResultExtra = structuredClone(verified) as Record<string, unknown>;
    nestedInResultExtra['meta'] = [badNestedArr];
    expectParity(VERIFIED_WITH_GOAL, OPTIONS, structuredClone(nestedInResultExtra), false);

    // Malformed index keys (leading zero, negative, fractional, exponential, out-of-range, reserved keys)
    for (const badKey of ['01', '00', '-1', '1.5', '1e0', '5', 'constructor', 'prototype']) {
      const withBadKey = structuredClone(runtimeInvalid);
      withBadKey.errors[badKey] = 'malformed';
      expectParity(RUNTIME_DEPTH_N, OPTIONS, withBadKey, false);
      expectParity(RUNTIME_DEPTH_N, OPTIONS, structuredClone(withBadKey), false);
    }

    const withProtoKey = structuredClone(runtimeInvalid);
    Object.defineProperty(withProtoKey.errors, '__proto__', {
      value: 'malformed',
      enumerable: true,
      writable: true,
      configurable: true,
    });
    expectParity(RUNTIME_DEPTH_N, OPTIONS, withProtoKey, false);

    // Sparse arrays across errors, trace, changedVars, violatedInvariantIds, and assumptions
    const sparseLeadingError: unknown[] = [];
    sparseLeadingError[1] = runtimeInvalid.errors[0];
    expectParity(RUNTIME_DEPTH_N, OPTIONS, { ...runtimeInvalid, errors: sparseLeadingError }, false);
    expectParity(
      RUNTIME_DEPTH_N,
      OPTIONS,
      structuredClone({ ...runtimeInvalid, errors: sparseLeadingError }),
      false,
    );

    const sparseTrailingError = [...runtimeInvalid.errors];
    sparseTrailingError.length = 2;
    expectParity(RUNTIME_DEPTH_N, OPTIONS, { ...runtimeInvalid, errors: sparseTrailingError }, false);
    expectParity(
      RUNTIME_DEPTH_N,
      OPTIONS,
      structuredClone({ ...runtimeInvalid, errors: sparseTrailingError }),
      false,
    );

    const sparseTrace = [...violated.trace];
    sparseTrace.length = violated.trace.length + 1;
    expectParity(VIOLATED_WITNESS, OPTIONS, { ...violated, trace: sparseTrace }, false);
    expectParity(VIOLATED_WITNESS, OPTIONS, structuredClone({ ...violated, trace: sparseTrace }), false);

    const sparseChanged = [...violated.trace[0]!.changedVars];
    sparseChanged.length = sparseChanged.length + 1;
    expectParity(
      VIOLATED_WITNESS,
      OPTIONS,
      {
        ...violated,
        trace: violated.trace.map((step, index) =>
          index === 0 ? { ...step, changedVars: sparseChanged } : step,
        ),
      },
      false,
    );

    const sparseViolatedIds = [...violated.violatedInvariantIds];
    sparseViolatedIds.length = 2;
    expectParity(VIOLATED_WITNESS, OPTIONS, { ...violated, violatedInvariantIds: sparseViolatedIds }, false);

    const sparseAssumptions = [...verified.assumptions];
    sparseAssumptions.length = 2;
    expectParity(VERIFIED_WITH_GOAL, OPTIONS, { ...verified, assumptions: sparseAssumptions }, false);

    // Non-enumerable element, accessor element, symbol property, and custom Array prototype
    const nonEnumErrors: unknown[] = [];
    Object.defineProperty(nonEnumErrors, 0, {
      value: runtimeInvalid.errors[0],
      enumerable: false,
      writable: true,
      configurable: true,
    });
    expectParity(RUNTIME_DEPTH_N, OPTIONS, { ...runtimeInvalid, errors: nonEnumErrors }, false);

    const accessorErrors: unknown[] = [];
    Object.defineProperty(accessorErrors, 0, {
      enumerable: true,
      get() {
        return runtimeInvalid.errors[0];
      },
    });
    expectParity(RUNTIME_DEPTH_N, OPTIONS, { ...runtimeInvalid, errors: accessorErrors }, false);

    const symbolErrors = [...runtimeInvalid.errors] as unknown[] & Record<symbol, unknown>;
    symbolErrors[Symbol('tag')] = 'unexpected';
    expectParity(RUNTIME_DEPTH_N, OPTIONS, { ...runtimeInvalid, errors: symbolErrors }, false);

    class SubArray<T> extends Array<T> {}
    const subErrors = new SubArray(...runtimeInvalid.errors);
    expectParity(RUNTIME_DEPTH_N, OPTIONS, { ...runtimeInvalid, errors: subErrors }, false);

    // Valid arrays (empty depth-0 trace, nested clean arrays in metadata, direct & structured-cloned)
    const runtimeZero = genuine(RUNTIME_DEPTH_ZERO, OPTIONS);
    expectParity(RUNTIME_DEPTH_ZERO, OPTIONS, runtimeZero, true);
    expectParity(RUNTIME_DEPTH_ZERO, OPTIONS, structuredClone(runtimeZero), true);

    const violatedZero = genuine(VIOLATED_INITIAL, OPTIONS);
    expectParity(VIOLATED_INITIAL, OPTIONS, violatedZero, true);
    expectParity(VIOLATED_INITIAL, OPTIONS, structuredClone(violatedZero), true);

    const validNestedExtra = { ...verified, meta: [['a', 'b'], []] };
    expectParity(VERIFIED_WITH_GOAL, OPTIONS, validNestedExtra, true);
    expectParity(VERIFIED_WITH_GOAL, OPTIONS, structuredClone(validNestedExtra), true);
  });
});
