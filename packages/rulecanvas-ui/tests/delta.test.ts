import {
  verifyModel,
  type BoolExpr,
  type Goal,
  type Invariant,
  type TransitionRule,
  type TransitionSystemModel,
  type VerifyOptions,
} from '@rulecanvas/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  computeVerdictDelta,
  type VerdictDelta,
} from '../src/index.js';

declare const process: {
  readonly env: { readonly [key: string]: string | undefined };
};

function resolveSeed(): number {
  const raw = process.env['FC_SEED'];
  if (raw !== undefined && raw.trim().length > 0) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return 20261127;
}

const SEED = resolveSeed();
const NUM_RUNS = 150;

const VAR_X = { op: 'var', name: 'x' } as const;

function boolLit(value: boolean): { readonly op: 'lit'; readonly value: boolean } {
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

function goalReachable(): Goal {
  return { id: 'goal', label: 'Reach one', reached: { op: 'gte', left: VAR_X, right: intLit(1) } };
}

function goalUnreachable(): Goal {
  return { id: 'goal', label: 'Below zero', reached: { op: 'lt', left: VAR_X, right: intLit(0) } };
}

function increment(guard: BoolExpr): TransitionRule {
  return {
    id: 'inc',
    label: 'Increment',
    guard,
    updates: [
      {
        var: 'x',
        value: { op: 'add', left: VAR_X, right: intLit(1) },
      },
    ],
  };
}

const ASSUMPTIONS = [
  { id: 'a1', category: 'scope', statement: 'Finite declared model.', notModeled: 'Physical system.' },
] as const;

function baseModel(overrides: {
  readonly id?: string;
  readonly rule?: TransitionRule;
  readonly invariant?: Invariant;
  readonly goal?: Goal;
  readonly initialX?: number;
  readonly min?: number;
}): TransitionSystemModel {
  const invariant = overrides.invariant ?? atMost(1);
  return {
    id: overrides.id ?? 'delta-model',
    name: 'Delta model',
    schema: { x: { kind: 'int', min: overrides.min ?? 0, max: 2 } },
    initialState: { x: overrides.initialX ?? 0 },
    rules: [overrides.rule ?? increment(boolLit(true))],
    invariants: [invariant],
    ...(overrides.goal !== undefined ? { goal: overrides.goal } : {}),
    assumptions: ASSUMPTIONS.map((entry) => ({ ...entry })),
  };
}

const DEFAULT_OPTIONS: VerifyOptions = { maxStates: 100, maxDepth: 10 };

function snapshotOf(
  model: TransitionSystemModel,
  options: VerifyOptions = DEFAULT_OPTIONS,
): Record<string, unknown> {
  return { model, options, result: verifyModel(model, options) };
}

function deltaOf(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): VerdictDelta {
  const result = computeVerdictDelta(before, after);
  if (!result.ok) {
    throw new Error(`Expected a verdict delta but got: ${result.reason}`);
  }
  return result.delta;
}

describe('@rulecanvas/ui verdict delta', () => {
  describe('classifications', () => {
    it('classifies repaired when the rule set changed and the spec did not', () => {
      const before = snapshotOf(baseModel({}));
      const after = snapshotOf(
        baseModel({ rule: increment({ op: 'lt', left: VAR_X, right: intLit(1) }) }),
      );
      const delta = deltaOf(before, after);
      expect(delta.classification).toBe('repaired');
      expect(delta.rulesChanged).toBe(true);
      expect(delta.specOrBoundsChanged).toBe(false);
      expect(delta.summary).toContain('No goal declared');
    });

    it('classifies repaired with a reachable goal without claiming a spec change', () => {
      const before = snapshotOf(baseModel({ goal: goalReachable() }));
      const after = snapshotOf(
        baseModel({
          goal: goalReachable(),
          rule: increment({ op: 'lt', left: VAR_X, right: intLit(1) }),
        }),
      );
      const delta = deltaOf(before, after);
      expect(delta.classification).toBe('repaired');
      expect(delta.after.goalStatus).toBe('REACHED');
      expect(delta.specOrBoundsChanged).toBe(false);
    });

    it('classifies verified-with-spec-change when invariants changed', () => {
      const guarded = increment({ op: 'lt', left: VAR_X, right: intLit(2) });
      const before = snapshotOf(baseModel({ rule: guarded, invariant: atMost(1) }));
      const after = snapshotOf(baseModel({ rule: guarded, invariant: atMost(2) }));
      const delta = deltaOf(before, after);
      expect(delta.classification).toBe('verified-with-spec-change');
      expect(delta.changedSections).toContain('invariants');
      expect(delta.specOrBoundsChanged).toBe(true);
    });

    it('classifies vacuous-lockout when the repaired goal is unreachable', () => {
      const before = snapshotOf(baseModel({ goal: goalUnreachable() }));
      const after = snapshotOf(
        baseModel({
          goal: goalUnreachable(),
          rule: increment({ op: 'lt', left: VAR_X, right: intLit(1) }),
        }),
      );
      const delta = deltaOf(before, after);
      expect(delta.classification).toBe('vacuous-lockout');
      expect(delta.after.goalStatus).toBe('UNREACHABLE');
    });

    it('classifies inconclusive-after-violation when bounds tighten', () => {
      const before = snapshotOf(baseModel({}));
      const after = snapshotOf(baseModel({}), { maxStates: 1, maxDepth: 10 });
      const delta = deltaOf(before, after);
      expect(delta.classification).toBe('inconclusive-after-violation');
      expect(delta.before.status).toBe('VIOLATED');
      expect(delta.after.status).toBe('INCONCLUSIVE');
    });

    it('classifies still-violated for two violating snapshots', () => {
      const before = snapshotOf(baseModel({}));
      const after = snapshotOf(baseModel({}));
      const delta = deltaOf(before, after);
      expect(delta.classification).toBe('still-violated');
      expect(delta.changedSections).toEqual([]);
    });

    it('classifies regression when a verified model becomes violating', () => {
      const before = snapshotOf(
        baseModel({
          invariant: atMost(2),
          rule: increment({ op: 'lt', left: VAR_X, right: intLit(1) }),
        }),
      );
      const after = snapshotOf(baseModel({ invariant: atMost(1) }));
      const delta = deltaOf(before, after);
      expect(delta.classification).toBe('regression');
      expect(delta.before.status).toBe('VERIFIED');
      expect(delta.after.status).toBe('VIOLATED');
    });

    it('classifies unchanged when both snapshots agree completely', () => {
      const before = snapshotOf(
        baseModel({
          invariant: atMost(2),
          rule: increment({ op: 'lt', left: VAR_X, right: intLit(1) }),
        }),
      );
      const after = snapshotOf(
        baseModel({
          invariant: atMost(2),
          rule: increment({ op: 'lt', left: VAR_X, right: intLit(1) }),
        }),
      );
      const delta = deltaOf(before, after);
      expect(delta.classification).toBe('unchanged');
      expect(delta.changedSections).toEqual([]);
      expect(delta.summary).toContain('No goal declared');
    });

    it('classifies other when both snapshots verify but the spec changed', () => {
      const before = snapshotOf(
        baseModel({
          invariant: atMost(2),
          rule: increment({ op: 'lt', left: VAR_X, right: intLit(1) }),
        }),
      );
      const after = snapshotOf(
        baseModel({
          invariant: atMost(3),
          rule: increment({ op: 'lt', left: VAR_X, right: intLit(1) }),
        }),
      );
      const delta = deltaOf(before, after);
      expect(delta.classification).toBe('other');
      expect(delta.changedSections).toContain('invariants');
    });
  });

  describe('rejections and normalization', () => {
    it('rejects stale snapshots', () => {
      const before = { ...snapshotOf(baseModel({})), stale: true };
      const after = snapshotOf(baseModel({}));
      const result = computeVerdictDelta(before, after);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain('stale');
      }
    });

    it('rejects snapshots that describe unrelated models', () => {
      const before = snapshotOf(baseModel({ id: 'model-a' }));
      const after = snapshotOf(baseModel({ id: 'model-b' }));
      const result = computeVerdictDelta(before, after);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain('unrelated');
      }
    });

    it('rejects malformed snapshots', () => {
      const before = { model: { id: 'x' }, options: {}, result: { status: 'VERIFIED' } };
      const after = snapshotOf(baseModel({}));
      const result = computeVerdictDelta(before, after);
      expect(result.ok).toBe(false);
    });

    it('normalizes negative zero in schema bounds and initial state', () => {
      const before = snapshotOf(baseModel({ initialX: -0, min: -0 }));
      const after = snapshotOf(baseModel({ initialX: 0, min: 0 }));
      const delta = deltaOf(before, after);
      expect(delta.changedSections).toEqual([]);
      expect(delta.classification).toBe('still-violated');
    });
  });

  describe('PBT-DELTA-1: repaired is always qualified', () => {
    it('never produces repaired outside the exact VIOLATED to VERIFIED conditions', () => {
      const invariantChoice = fc.constantFrom(1, 2, 3);
      const goalChoice = fc.constantFrom('none', 'reachable', 'unreachable');
      const ruleChoice = fc.constantFrom('unbounded', 'bounded', 'noop');
      const boundsChoice = fc.constantFrom(
        { maxStates: 1, maxDepth: 0 },
        { maxStates: 1, maxDepth: 1 },
        { maxStates: 4, maxDepth: 2 },
        { maxStates: 100, maxDepth: 10 },
      );
      const configArb = fc.record({
        invariant: invariantChoice,
        goal: goalChoice,
        rule: ruleChoice,
        bounds: boundsChoice,
      });

      fc.assert(
        fc.property(configArb, configArb, (configBefore, configAfter) => {
          const build = (config: {
            readonly invariant: number;
            readonly goal: string;
            readonly rule: string;
            readonly bounds: { readonly maxStates: number; readonly maxDepth: number };
          }): Record<string, unknown> => {
            const guard: BoolExpr =
              config.rule === 'bounded'
                ? { op: 'lt', left: VAR_X, right: intLit(2) }
                : boolLit(true);
            const rule: TransitionRule =
              config.rule === 'noop'
                ? {
                    id: 'inc',
                    label: 'Reset',
                    guard: boolLit(true),
                    updates: [{ var: 'x', value: intLit(0) }],
                  }
                : increment(guard);
            const goal =
              config.goal === 'reachable'
                ? goalReachable()
                : config.goal === 'unreachable'
                  ? goalUnreachable()
                  : undefined;
            return snapshotOf(
              baseModel({
                invariant: atMost(config.invariant),
                rule,
                ...(goal !== undefined ? { goal } : {}),
              }),
              config.bounds,
            );
          };

          const result = computeVerdictDelta(build(configBefore), build(configAfter));
          expect(result.ok).toBe(true);
          if (!result.ok) return;

          const delta = result.delta;
          if (delta.classification === 'repaired') {
            expect(delta.before.status).toBe('VIOLATED');
            expect(delta.after.status).toBe('VERIFIED');
            expect(delta.after.goalStatus).not.toBe('UNREACHABLE');
            expect(delta.specOrBoundsChanged).toBe(false);
            expect(
              delta.after.goalStatus === 'REACHED' ||
                delta.after.goalStatus === 'NO_GOAL_DECLARED',
            ).toBe(true);
            for (const section of delta.changedSections) {
              expect(section).toBe('rules');
            }
          }

          if (delta.specOrBoundsChanged) {
            expect(delta.classification).not.toBe('repaired');
          }
          if (delta.after.goalStatus === 'UNREACHABLE') {
            expect(delta.classification).not.toBe('repaired');
          }

          const again = computeVerdictDelta(build(configBefore), build(configAfter));
          expect(again.ok).toBe(true);
          if (again.ok) {
            expect(JSON.stringify(again.delta)).toBe(JSON.stringify(delta));
          }
        }),
        { seed: SEED, numRuns: NUM_RUNS },
      );
    });
  });
});
