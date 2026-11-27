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
});
