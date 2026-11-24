import { describe, expect, it } from 'vitest';
import {
  getEnabledTransitions,
  getInitialState,
  replayTrace,
  stepModel,
  validateModel,
  validateOptions,
  verifyModel,
  type BoolExpr,
  type ModelAssumption,
  type TransitionSystemModel,
  type ValueExpr,
  type VerifyOptions,
} from '../src/index.js';

const DEFAULT_ASSUMPTIONS: readonly ModelAssumption[] = [
  {
    id: 'a-atomic',
    category: 'semantics',
    statement: 'Transitions execute atomically one rule at a time.',
    notModeled: 'Concurrent interleaved memory writes.',
  },
];

const DEFAULT_OPTS: VerifyOptions = { maxStates: 1000, maxDepth: 50 };

function baseModel(overrides: Partial<TransitionSystemModel> = {}): TransitionSystemModel {
  return {
    id: 'test-model',
    name: 'Test Model',
    schema: { x: { kind: 'int', min: 0, max: 3 } },
    initialState: { x: 0 },
    rules: [],
    invariants: [{ id: 'inv-ok', label: 'Always ok', holds: { op: 'lit', value: true } }],
    assumptions: DEFAULT_ASSUMPTIONS,
    ...overrides,
  };
}

describe('verifyModel core unit and edge cases', () => {
  it('detects s0 invariant violation with empty trace, 1 state, 0 transitions, and omits goalReachable even when s0 satisfies goal', () => {
    const model = baseModel({
      schema: { x: { kind: 'int', min: 0, max: 2 }, ok: { kind: 'boolean' } },
      initialState: { x: 0, ok: false },
      rules: [
        {
          id: 'fix',
          label: 'Fix ok',
          guard: { op: 'lit', value: true },
          updates: [{ var: 'ok', value: { op: 'lit', value: true } }],
        },
      ],
      invariants: [
        { id: 'inv-1', label: 'ok must hold', holds: { op: 'var', name: 'ok' } },
        { id: 'inv-2', label: 'x positive', holds: { op: 'gt', left: { op: 'var', name: 'x' }, right: { op: 'lit', value: 0 } } },
      ],
      goal: {
        id: 'goal-s0',
        label: 'Already satisfied at s0',
        reached: { op: 'eq', left: { op: 'var', name: 'x' }, right: { op: 'lit', value: 0 } },
      },
    });

    const res = verifyModel(model, { maxStates: 1, maxDepth: 0 });
    expect(res.status).toBe('VIOLATED');
    if (res.status !== 'VIOLATED') return;

    expect(res.trace).toEqual([]);
    expect(res.terminalState).toEqual({ x: 0, ok: false });
    expect(res.violatedInvariantIds).toEqual(['inv-1', 'inv-2']);
    expect(res.stats).toEqual({
      theoreticalStates: '6',
      statesExplored: 1,
      transitionsEvaluated: 0,
      maxDepthReached: 0,
      deadlockStatesFound: 0,
    });
    expect('goalReachable' in res).toBe(false);
  });

  it('handles legal self-loops (updates: []) and multi-state cycles without looping infinitely', () => {
    const model = baseModel({
      schema: { phase: { kind: 'enum', values: ['a', 'b', 'c'] } },
      initialState: { phase: 'a' },
      rules: [
        {
          id: 'noop-self',
          label: 'No-op self-loop',
          guard: { op: 'lit', value: true },
          updates: [],
        },
        {
          id: 'a-to-b',
          label: 'A to B',
          guard: { op: 'eq', left: { op: 'var', name: 'phase' }, right: { op: 'lit', value: 'a' } },
          updates: [{ var: 'phase', value: { op: 'lit', value: 'b' } }],
        },
        {
          id: 'b-to-c',
          label: 'B to C',
          guard: { op: 'eq', left: { op: 'var', name: 'phase' }, right: { op: 'lit', value: 'b' } },
          updates: [{ var: 'phase', value: { op: 'lit', value: 'c' } }],
        },
        {
          id: 'c-to-a',
          label: 'C to A',
          guard: { op: 'eq', left: { op: 'var', name: 'phase' }, right: { op: 'lit', value: 'c' } },
          updates: [{ var: 'phase', value: { op: 'lit', value: 'a' } }],
        },
      ],
    });

    const res = verifyModel(model, DEFAULT_OPTS);
    expect(res.status).toBe('VERIFIED');
    if (res.status !== 'VERIFIED') return;

    expect(res.stats).toEqual({
      theoreticalStates: '3',
      statesExplored: 3,
      transitionsEvaluated: 6,
      maxDepthReached: 2,
      deadlockStatesFound: 0,
    });
  });

  it('treats empty rules: [] as a valid 1-state deadlock', () => {
    const model = baseModel({ rules: [] });
    const res = verifyModel(model, DEFAULT_OPTS);

    expect(res.status).toBe('VERIFIED');
    if (res.status !== 'VERIFIED') return;

    expect(res.stats).toEqual({
      theoreticalStates: '4',
      statesExplored: 1,
      transitionsEvaluated: 0,
      maxDepthReached: 0,
      deadlockStatesFound: 1,
    });
    expect('goalReachable' in res).toBe(false);
  });

  it('applies simultaneous atomic swap x = y; y = x against the immutable pre-state', () => {
    const model = baseModel({
      schema: {
        x: { kind: 'int', min: 0, max: 5 },
        y: { kind: 'int', min: 0, max: 5 },
      },
      initialState: { x: 1, y: 4 },
      rules: [
        {
          id: 'swap',
          label: 'Swap x and y',
          guard: { op: 'lit', value: true },
          updates: [
            { var: 'x', value: { op: 'var', name: 'y' } },
            { var: 'y', value: { op: 'var', name: 'x' } },
          ],
        },
      ],
      invariants: [
        {
          id: 'sum-5',
          label: 'Sum remains 5',
          holds: {
            op: 'eq',
            left: { op: 'add', left: { op: 'var', name: 'x' }, right: { op: 'var', name: 'y' } },
            right: { op: 'lit', value: 5 },
          },
        },
        {
          id: 'distinct',
          label: 'Values remain distinct',
          holds: { op: 'neq', left: { op: 'var', name: 'x' }, right: { op: 'var', name: 'y' } },
        },
      ],
    });

    const step = stepModel(model, { x: 1, y: 4 }, 'swap');
    expect(step.ok).toBe(true);
    if (step.ok) {
      expect(step.step.stateBefore).toEqual({ x: 1, y: 4 });
      expect(step.step.stateAfter).toEqual({ x: 4, y: 1 });
      expect(step.step.changedVars).toEqual(['x', 'y']);
    }

    const res = verifyModel(model, DEFAULT_OPTS);
    expect(res.status).toBe('VERIFIED');
    if (res.status !== 'VERIFIED') return;
    expect(res.stats.statesExplored).toBe(2);
    expect(res.stats.transitionsEvaluated).toBe(2);
    expect(res.stats.maxDepthReached).toBe(1);
  });

  it('normalizes -0 to 0 everywhere so Object.is(..., -0) never occurs or splits visited keys', () => {
    const model = baseModel({
      schema: { n: { kind: 'int', min: -2, max: 2 } },
      initialState: { n: -0 },
      rules: [
        {
          id: 'assign-neg-zero',
          label: 'Assign -0',
          guard: { op: 'eq', left: { op: 'var', name: 'n' }, right: { op: 'lit', value: -0 } },
          updates: [{ var: 'n', value: { op: 'lit', value: -0 } }],
        },
        {
          id: 'sub-zero',
          label: 'n := n - 0',
          guard: { op: 'lit', value: true },
          updates: [{ var: 'n', value: { op: 'sub', left: { op: 'var', name: 'n' }, right: { op: 'lit', value: -0 } } }],
        },
      ],
    });

    const init = getInitialState(model);
    expect(init.ok).toBe(true);
    if (init.ok) {
      expect(init.state['n']).toBe(0);
      expect(Object.is(init.state['n'], -0)).toBe(false);
    }

    const step = stepModel(model, { n: -0 }, 'assign-neg-zero');
    expect(step.ok).toBe(true);
    if (step.ok) {
      expect(Object.is(step.step.stateBefore['n'], -0)).toBe(false);
      expect(Object.is(step.step.stateAfter['n'], -0)).toBe(false);
      expect(step.step.changedVars).toEqual([]);
    }

    const res = verifyModel(model, DEFAULT_OPTS);
    expect(res.status).toBe('VERIFIED');
    if (res.status !== 'VERIFIED') return;
    expect(res.stats.statesExplored).toBe(1);
    expect(res.stats.transitionsEvaluated).toBe(2);
  });

  it('rejects a shared-reference AST DAG bomb immediately with AST_COMPLEXITY_EXCEEDED (< 100 ms)', () => {
    let boolBomb: BoolExpr = { op: 'lit', value: true };
    for (let i = 0; i <= 30; i += 1) {
      boolBomb = { op: 'and', args: [boolBomb, boolBomb] };
    }

    const modelWithBoolBomb = baseModel({
      invariants: [{ id: 'inv-bomb', label: 'DAG bomb', holds: boolBomb }],
    });

    const start = performance.now();
    const res = verifyModel(modelWithBoolBomb, DEFAULT_OPTS);
    const elapsedMs = performance.now() - start;

    expect(elapsedMs).toBeLessThan(100);
    expect(res.status).toBe('INVALID');
    if (res.status !== 'INVALID') return;
    expect(res.errors.some((e) => e.code === 'AST_COMPLEXITY_EXCEEDED')).toBe(true);

    let valBomb: ValueExpr = { op: 'lit', value: 1 };
    for (let i = 0; i <= 30; i += 1) {
      valBomb = { op: 'add', left: valBomb, right: valBomb };
    }
    const modelWithValBomb = baseModel({
      rules: [
        {
          id: 'r-bomb',
          label: 'Val DAG bomb',
          guard: { op: 'lit', value: true },
          updates: [{ var: 'x', value: valBomb }],
        },
      ],
    });
    const startVal = performance.now();
    const valErrors = validateModel(modelWithValBomb);
    expect(performance.now() - startVal).toBeLessThan(100);
    expect(valErrors.some((e) => e.code === 'AST_COMPLEXITY_EXCEEDED')).toBe(true);
  });

  it('uses exact bigint arithmetic in guards and updates and never silently clamps out-of-domain updates', () => {
    const hi = Number.MAX_SAFE_INTEGER;
    const guardModel = baseModel({
      schema: { x: { kind: 'int', min: hi - 2, max: hi } },
      initialState: { x: hi },
      rules: [
        {
          id: 'precision-guard-step',
          label: 'Distinguishes (MAX_SAFE + 2) > (MAX_SAFE + 1) and computes (x + 2) - 3',
          guard: {
            op: 'gt',
            left: { op: 'add', left: { op: 'var', name: 'x' }, right: { op: 'lit', value: 2 } },
            right: { op: 'add', left: { op: 'var', name: 'x' }, right: { op: 'lit', value: 1 } },
          },
          updates: [
            {
              var: 'x',
              value: {
                op: 'sub',
                left: { op: 'add', left: { op: 'var', name: 'x' }, right: { op: 'lit', value: 2 } },
                right: { op: 'lit', value: 3 },
              },
            },
          ],
        },
      ],
      goal: {
        id: 'reached-minus-1',
        label: 'Reached MAX_SAFE - 1',
        reached: { op: 'eq', left: { op: 'var', name: 'x' }, right: { op: 'lit', value: hi - 1 } },
      },
    });

    const step = stepModel(guardModel, { x: hi }, 'precision-guard-step');
    expect(step.ok).toBe(true);
    if (step.ok) {
      expect(step.step.stateAfter).toEqual({ x: hi - 1 });
    }

    const overflowUpdateModel = baseModel({
      schema: { x: { kind: 'int', min: hi - 2, max: hi } },
      initialState: { x: hi },
      rules: [
        {
          id: 'overflow',
          label: 'Increment past MAX_SAFE_INTEGER',
          guard: { op: 'lit', value: true },
          updates: [{ var: 'x', value: { op: 'add', left: { op: 'var', name: 'x' }, right: { op: 'lit', value: 1 } } }],
        },
      ],
    });

    const overflowRes = verifyModel(overflowUpdateModel, DEFAULT_OPTS);
    expect(overflowRes.status).toBe('INVALID');
    if (overflowRes.status !== 'INVALID') return;
    expect(overflowRes.errors[0]?.code).toBe('OUT_OF_DOMAIN_TRANSITION');
    expect(overflowRes.trace).toEqual([]);

    const underflowModel = baseModel({
      schema: { x: { kind: 'int', min: 0, max: 3 } },
      initialState: { x: 0 },
      rules: [
        {
          id: 'dec',
          label: 'Decrement below min',
          guard: { op: 'lit', value: true },
          updates: [{ var: 'x', value: { op: 'sub', left: { op: 'var', name: 'x' }, right: { op: 'lit', value: 1 } } }],
        },
      ],
    });
    const underflowRes = verifyModel(underflowModel, DEFAULT_OPTS);
    expect(underflowRes.status).toBe('INVALID');
    if (underflowRes.status !== 'INVALID') return;
    expect(underflowRes.errors[0]?.code).toBe('OUT_OF_DOMAIN_TRANSITION');
  });

  it('checks OUT_OF_DOMAIN_TRANSITION before visited deduplication and before maxDepth/maxStates limits', () => {
    const oodFromS0 = baseModel({
      schema: { x: { kind: 'int', min: 0, max: 1 } },
      initialState: { x: 1 },
      rules: [
        {
          id: 'boom',
          label: 'Exceed max',
          guard: { op: 'lit', value: true },
          updates: [{ var: 'x', value: { op: 'add', left: { op: 'var', name: 'x' }, right: { op: 'lit', value: 1 } } }],
        },
      ],
    });

    const resDepthZero = verifyModel(oodFromS0, { maxStates: 10, maxDepth: 0 });
    expect(resDepthZero.status).toBe('INVALID');
    if (resDepthZero.status === 'INVALID') {
      expect(resDepthZero.errors[0]?.code).toBe('OUT_OF_DOMAIN_TRANSITION');
      expect(resDepthZero.stats?.transitionsEvaluated).toBe(1);
    }

    const resMaxStatesOne = verifyModel(oodFromS0, { maxStates: 1, maxDepth: 10 });
    expect(resMaxStatesOne.status).toBe('INVALID');
    if (resMaxStatesOne.status === 'INVALID') {
      expect(resMaxStatesOne.errors[0]?.code).toBe('OUT_OF_DOMAIN_TRANSITION');
    }

    const resBothTight = verifyModel(oodFromS0, { maxStates: 1, maxDepth: 0 });
    expect(resBothTight.status).toBe('INVALID');
    if (resBothTight.status === 'INVALID') {
      expect(resBothTight.errors[0]?.code).toBe('OUT_OF_DOMAIN_TRANSITION');
    }
  });

  it('allows toString and hasOwnProperty as schema variables while rejecting __proto__, constructor, and prototype', () => {
    const safeProtoNameModel = baseModel({
      schema: {
        toString: { kind: 'boolean' as const },
        hasOwnProperty: { kind: 'enum' as const, values: ['idle', 'done'] },
      },
      initialState: { toString: false, hasOwnProperty: 'idle' },
      rules: [
        {
          id: 'flip',
          label: 'Toggle toString and advance hasOwnProperty',
          guard: { op: 'not', arg: { op: 'var', name: 'toString' } },
          updates: [
            { var: 'toString', value: { op: 'lit', value: true } },
            { var: 'hasOwnProperty', value: { op: 'lit', value: 'done' } },
          ],
        },
      ],
      invariants: [
        {
          id: 'inv-proto-safe',
          label: 'Coherent state',
          holds: {
            op: 'or',
            args: [
              { op: 'not', arg: { op: 'var', name: 'toString' } },
              { op: 'eq', left: { op: 'var', name: 'hasOwnProperty' }, right: { op: 'lit', value: 'done' } },
            ],
          },
        },
      ],
      goal: {
        id: 'g-done',
        label: 'Done',
        reached: { op: 'var', name: 'toString' },
      },
    });

    const verified = verifyModel(safeProtoNameModel, DEFAULT_OPTS);
    expect(verified.status).toBe('VERIFIED');
    if (verified.status === 'VERIFIED') {
      expect(verified.stats.statesExplored).toBe(2);
      expect(verified.goalReachable).toBe(true);
    }

    const replayed = replayTrace(safeProtoNameModel, ['flip']);
    expect(replayed.ok).toBe(true);
    if (replayed.ok) {
      expect(Object.hasOwn(replayed.finalState, 'toString')).toBe(true);
      expect(Object.hasOwn(replayed.finalState, 'hasOwnProperty')).toBe(true);
      expect(replayed.finalState['toString']).toBe(true);
      expect(replayed.finalState['hasOwnProperty']).toBe('done');
    }

    for (const reserved of ['__proto__', 'constructor', 'prototype'] as const) {
      const schema: Record<string, unknown> = {};
      Object.defineProperty(schema, reserved, {
        value: { kind: 'boolean' },
        enumerable: true,
        writable: true,
        configurable: true,
      });
      const initialState: Record<string, unknown> = {};
      Object.defineProperty(initialState, reserved, {
        value: false,
        enumerable: true,
        writable: true,
        configurable: true,
      });

      const badModel = {
        ...baseModel(),
        schema,
        initialState,
      };
      const errors = validateModel(badModel);
      expect(errors.some((e) => e.code === 'RESERVED_VAR_NAME' && e.path === `schema.${reserved}`)).toBe(true);
    }
  });

  it('enforces exact maxDepth: 0 and maxStates: 1 boundaries for 0-rule, self-loop, and novel-successor models', () => {
    const selfLoopModel = baseModel({
      rules: [{ id: 'stay', label: 'Stay', guard: { op: 'lit', value: true }, updates: [] }],
    });

    expect(verifyModel(baseModel({ rules: [] }), { maxStates: 1, maxDepth: 0 }).status).toBe('VERIFIED');
    expect(verifyModel(selfLoopModel, { maxStates: 1, maxDepth: 0 }).status).toBe('VERIFIED');

    const novelModel = baseModel({
      rules: [
        {
          id: 'inc',
          label: 'Increment',
          guard: { op: 'lt', left: { op: 'var', name: 'x' }, right: { op: 'lit', value: 3 } },
          updates: [{ var: 'x', value: { op: 'add', left: { op: 'var', name: 'x' }, right: { op: 'lit', value: 1 } } }],
        },
      ],
    });

    const depthRes = verifyModel(novelModel, { maxStates: 10, maxDepth: 0 });
    expect(depthRes.status).toBe('INCONCLUSIVE');
    if (depthRes.status === 'INCONCLUSIVE') {
      expect(depthRes.reason).toBe('MAX_DEPTH');
      expect(depthRes.completedDepth).toBe(-1);
      expect(depthRes.frontierRemaining).toBe(1);
    }

    const statesRes = verifyModel(novelModel, { maxStates: 1, maxDepth: 10 });
    expect(statesRes.status).toBe('INCONCLUSIVE');
    if (statesRes.status === 'INCONCLUSIVE') {
      expect(statesRes.reason).toBe('MAX_STATES');
      expect(statesRes.completedDepth).toBe(-1);
      expect(statesRes.frontierRemaining).toBe(1);
    }
  });

  it('returns VERIFIED (not INCONCLUSIVE) on full queue drain at exact maxStates', () => {
    const exactThreeStateCycle = baseModel({
      schema: { x: { kind: 'int', min: 0, max: 2 } },
      initialState: { x: 0 },
      rules: [
        {
          id: 'next',
          label: 'Advance modulo 3',
          guard: { op: 'lt', left: { op: 'var', name: 'x' }, right: { op: 'lit', value: 2 } },
          updates: [{ var: 'x', value: { op: 'add', left: { op: 'var', name: 'x' }, right: { op: 'lit', value: 1 } } }],
        },
        {
          id: 'wrap',
          label: 'Wrap back to 0',
          guard: { op: 'eq', left: { op: 'var', name: 'x' }, right: { op: 'lit', value: 2 } },
          updates: [{ var: 'x', value: { op: 'lit', value: 0 } }],
        },
      ],
    });

    const res = verifyModel(exactThreeStateCycle, { maxStates: 3, maxDepth: 10 });
    expect(res.status).toBe('VERIFIED');
    if (res.status !== 'VERIFIED') return;
    expect(res.stats.statesExplored).toBe(3);
    expect(res.stats.transitionsEvaluated).toBe(3);
    expect(res.stats.maxDepthReached).toBe(2);
  });

  it('computes exact completedDepth === d - 1 and frontierRemaining === states.length - head on multi-layer truncation', () => {
    const branchingModel = baseModel({
      schema: {
        branch: { kind: 'enum', values: ['root', 'left', 'right'] },
        depth: { kind: 'int', min: 0, max: 3 },
      },
      initialState: { branch: 'root', depth: 0 },
      rules: [
        {
          id: 'go-left',
          label: 'Go left',
          guard: { op: 'eq', left: { op: 'var', name: 'branch' }, right: { op: 'lit', value: 'root' } },
          updates: [
            { var: 'branch', value: { op: 'lit', value: 'left' } },
            { var: 'depth', value: { op: 'lit', value: 1 } },
          ],
        },
        {
          id: 'go-right',
          label: 'Go right',
          guard: { op: 'eq', left: { op: 'var', name: 'branch' }, right: { op: 'lit', value: 'root' } },
          updates: [
            { var: 'branch', value: { op: 'lit', value: 'right' } },
            { var: 'depth', value: { op: 'lit', value: 1 } },
          ],
        },
        {
          id: 'deepen',
          label: 'Deepen branch',
          guard: {
            op: 'and',
            args: [
              { op: 'neq', left: { op: 'var', name: 'branch' }, right: { op: 'lit', value: 'root' } },
              { op: 'lt', left: { op: 'var', name: 'depth' }, right: { op: 'lit', value: 3 } },
            ],
          },
          updates: [{ var: 'depth', value: { op: 'add', left: { op: 'var', name: 'depth' }, right: { op: 'lit', value: 1 } } }],
        },
      ],
    });

    // Queue admits (root,0) [d=0], then (left,1) [d=1], (right,1) [d=1].
    // Expanding head=1 ((left,1), d=1) finds novel (left,2) at nextDepth=2 -> hits maxStates: 3.
    const truncStates = verifyModel(branchingModel, { maxStates: 3, maxDepth: 10 });
    expect(truncStates.status).toBe('INCONCLUSIVE');
    if (truncStates.status === 'INCONCLUSIVE') {
      expect(truncStates.reason).toBe('MAX_STATES');
      expect(truncStates.completedDepth).toBe(0); // d - 1 = 1 - 1
      expect(truncStates.frontierRemaining).toBe(2); // states.length (3) - head (1)
    }

    // With maxDepth: 2, depth 0 -> depth 1 (left,1 & right,1) -> depth 2 (left,2 & right,2).
    // Expanding head=3 ((left,2), d=2) finds novel (left,3) at nextDepth=3 > 2.
    const truncDepth = verifyModel(branchingModel, { maxStates: 100, maxDepth: 2 });
    expect(truncDepth.status).toBe('INCONCLUSIVE');
    if (truncDepth.status === 'INCONCLUSIVE') {
      expect(truncDepth.reason).toBe('MAX_DEPTH');
      expect(truncDepth.completedDepth).toBe(1); // d - 1 = 2 - 1
      expect(truncDepth.frontierRemaining).toBe(2); // states.length (5) - head (3)
    }
  });

  it('tracks goalReachable accurately across VERIFIED, VIOLATED, INCONCLUSIVE, and INVALID outcomes', () => {
    const chainModel = baseModel({
      schema: { x: { kind: 'int', min: 0, max: 3 } },
      initialState: { x: 0 },
      rules: [
        {
          id: 'inc',
          label: 'Increment',
          guard: { op: 'lt', left: { op: 'var', name: 'x' }, right: { op: 'lit', value: 3 } },
          updates: [{ var: 'x', value: { op: 'add', left: { op: 'var', name: 'x' }, right: { op: 'lit', value: 1 } } }],
        },
      ],
      goal: {
        id: 'g-1',
        label: 'Reach x == 1',
        reached: { op: 'eq', left: { op: 'var', name: 'x' }, right: { op: 'lit', value: 1 } },
      },
    });

    // VERIFIED with reachable goal
    const verifiedReachable = verifyModel(chainModel, DEFAULT_OPTS);
    expect(verifiedReachable.status).toBe('VERIFIED');
    if (verifiedReachable.status === 'VERIFIED') {
      expect(verifiedReachable.goalReachable).toBe(true);
    }

    // VERIFIED with vacuous fix blocking goal -> goalReachable: false
    const vacuous = verifyModel({ ...chainModel, rules: [] }, DEFAULT_OPTS);
    expect(vacuous.status).toBe('VERIFIED');
    if (vacuous.status === 'VERIFIED') {
      expect(vacuous.goalReachable).toBe(false);
    }

    // VERIFIED without goal -> goalReachable omitted
    const { goal: _omitted, ...noGoalModel } = chainModel;
    const verifiedNoGoal = verifyModel(noGoalModel, DEFAULT_OPTS);
    expect(verifiedNoGoal.status).toBe('VERIFIED');
    expect('goalReachable' in verifiedNoGoal).toBe(false);

    // VIOLATED after witnessing goal at x == 1 (violation at x == 2) -> goalReachable: true
    const violatedAfterGoal = verifyModel(
      {
        ...chainModel,
        invariants: [{ id: 'no-2', label: 'x != 2', holds: { op: 'neq', left: { op: 'var', name: 'x' }, right: { op: 'lit', value: 2 } } }],
      },
      DEFAULT_OPTS,
    );
    expect(violatedAfterGoal.status).toBe('VIOLATED');
    if (violatedAfterGoal.status === 'VIOLATED') {
      expect(violatedAfterGoal.goalReachable).toBe(true);
    }

    // VIOLATED before witnessing goal (violation at x == 1, same state as goal) -> goalReachable omitted
    const violatedAtGoal = verifyModel(
      {
        ...chainModel,
        invariants: [{ id: 'no-1', label: 'x != 1', holds: { op: 'neq', left: { op: 'var', name: 'x' }, right: { op: 'lit', value: 1 } } }],
      },
      DEFAULT_OPTS,
    );
    expect(violatedAtGoal.status).toBe('VIOLATED');
    expect('goalReachable' in violatedAtGoal).toBe(false);

    // INCONCLUSIVE after witnessing goal at x == 1 -> goalReachable: true
    const inconclusiveAfterGoal = verifyModel(chainModel, { maxStates: 2, maxDepth: 10 });
    expect(inconclusiveAfterGoal.status).toBe('INCONCLUSIVE');
    if (inconclusiveAfterGoal.status === 'INCONCLUSIVE') {
      expect(inconclusiveAfterGoal.goalReachable).toBe(true);
    }

    // INCONCLUSIVE before witnessing goal -> goalReachable omitted
    const inconclusiveBeforeGoal = verifyModel(chainModel, { maxStates: 1, maxDepth: 10 });
    expect(inconclusiveBeforeGoal.status).toBe('INCONCLUSIVE');
    expect('goalReachable' in inconclusiveBeforeGoal).toBe(false);

    // INVALID -> goalReachable omitted
    const invalidRes = verifyModel(chainModel, { maxStates: 0, maxDepth: 10 });
    expect(invalidRes.status).toBe('INVALID');
    expect('goalReachable' in invalidRes).toBe(false);
  });

  it('supports getInitialState, getEnabledTransitions, stepModel, and replayTrace with structured error codes', () => {
    const model = baseModel({
      schema: {
        step: { kind: 'int', min: 0, max: 2 },
        armed: { kind: 'boolean' },
      },
      initialState: { step: 0, armed: false },
      rules: [
        {
          id: 'arm',
          label: 'Arm system',
          guard: { op: 'not', arg: { op: 'var', name: 'armed' } },
          updates: [{ var: 'armed', value: { op: 'lit', value: true } }],
        },
        {
          id: 'advance',
          label: 'Advance step',
          guard: { op: 'var', name: 'armed' },
          updates: [{ var: 'step', value: { op: 'add', left: { op: 'var', name: 'step' }, right: { op: 'lit', value: 1 } } }],
        },
      ],
      invariants: [
        { id: 'inv-step', label: 'step <= 1', holds: { op: 'lte', left: { op: 'var', name: 'step' }, right: { op: 'lit', value: 1 } } },
      ],
      goal: {
        id: 'g-armed',
        label: 'Armed at step 1',
        reached: {
          op: 'and',
          args: [
            { op: 'var', name: 'armed' },
            { op: 'eq', left: { op: 'var', name: 'step' }, right: { op: 'lit', value: 1 } },
          ],
        },
      },
    });

    const init = getInitialState(model);
    expect(init).toEqual({ ok: true, state: { step: 0, armed: false } });

    const enabled0 = getEnabledTransitions(model, { step: 0, armed: false });
    expect(enabled0).toEqual({
      ok: true,
      transitions: [
        { ruleId: 'arm', label: 'Arm system', enabled: true },
        { ruleId: 'advance', label: 'Advance step', enabled: false },
      ],
      enabledRuleIds: ['arm'],
    });

    const s1 = stepModel(model, { step: 0, armed: false }, 'arm');
    expect(s1.ok).toBe(true);
    if (s1.ok) {
      expect(s1.step.ruleId).toBe('arm');
      expect(s1.step.stateAfter).toEqual({ step: 0, armed: true });
      expect(s1.step.changedVars).toEqual(['armed']);
    }

    // Valid replay
    const okReplay = replayTrace(model, ['arm', 'advance']);
    expect(okReplay.ok).toBe(true);
    if (okReplay.ok) {
      expect(okReplay.steps).toHaveLength(2);
      expect(okReplay.finalState).toEqual({ step: 1, armed: true });
      expect(okReplay.violatedInvariantIds).toEqual([]);
      expect(okReplay.goalReached).toBe(true);
    }

    // Replay hitting invariant violation
    const violatingReplay = replayTrace(model, ['arm', 'advance', 'advance']);
    expect(violatingReplay.ok).toBe(true);
    if (violatingReplay.ok) {
      expect(violatingReplay.finalState).toEqual({ step: 2, armed: true });
      expect(violatingReplay.violatedInvariantIds).toEqual(['inv-step']);
      expect(violatingReplay.goalReached).toBe(false);
    }

    // UNKNOWN_RULE
    const unknownStep = stepModel(model, { step: 0, armed: false }, 'does-not-exist');
    expect(unknownStep.ok).toBe(false);
    if (!unknownStep.ok) expect(unknownStep.error.code).toBe('UNKNOWN_RULE');

    const unknownReplay = replayTrace(model, ['arm', 'nope']);
    expect(unknownReplay.ok).toBe(false);
    if (!unknownReplay.ok) {
      expect(unknownReplay.stepIndex).toBe(1);
      expect(unknownReplay.error.code).toBe('UNKNOWN_RULE');
      expect(unknownReplay.steps).toHaveLength(1);
    }

    // RULE_DISABLED
    const disabledStep = stepModel(model, { step: 0, armed: false }, 'advance');
    expect(disabledStep.ok).toBe(false);
    if (!disabledStep.ok) expect(disabledStep.error.code).toBe('RULE_DISABLED');

    const disabledReplay = replayTrace(model, ['arm', 'arm']);
    expect(disabledReplay.ok).toBe(false);
    if (!disabledReplay.ok) {
      expect(disabledReplay.stepIndex).toBe(1);
      expect(disabledReplay.error.code).toBe('RULE_DISABLED');
      expect(disabledReplay.steps).toHaveLength(1);
    }

    // OUT_OF_DOMAIN_TRANSITION
    const oodStep = stepModel(model, { step: 2, armed: true }, 'advance');
    expect(oodStep.ok).toBe(false);
    if (!oodStep.ok) expect(oodStep.error.code).toBe('OUT_OF_DOMAIN_TRANSITION');

    const oodReplay = replayTrace(model, ['arm', 'advance', 'advance', 'advance']);
    expect(oodReplay.ok).toBe(false);
    if (!oodReplay.ok) {
      expect(oodReplay.stepIndex).toBe(3);
      expect(oodReplay.error.code).toBe('OUT_OF_DOMAIN_TRANSITION');
      expect(oodReplay.steps).toHaveLength(3);
    }

    // Non-array ruleIds -> INVALID_TRACE
    const badTrace = replayTrace(model, 'arm');
    expect(badTrace.ok).toBe(false);
    if (!badTrace.ok) {
      expect(badTrace.stepIndex).toBe(-1);
      expect(badTrace.error.code).toBe('INVALID_TRACE');
    }

    // validateOptions sanity
    expect(validateOptions({ maxStates: 1, maxDepth: 0 })).toEqual([]);
    expect(validateOptions({ maxStates: Number.NaN, maxDepth: 0 }).length).toBeGreaterThan(0);
  });

  it('safely formats uncoercible objects like JSON.parse(\'{"toString":null}\') without throwing across validateModel, verifyModel, and replayTrace', () => {
    const uncoercible = (): unknown => JSON.parse('{"toString":null}');

    const cases: Array<{ label: string; model: unknown; expectedCode: string }> = [
      {
        label: 'holds.op',
        model: {
          ...baseModel(),
          invariants: [{ id: 'inv-bad-op', label: 'Bad op', holds: { op: uncoercible() } }],
        },
        expectedCode: 'INVALID_EXPR_OP',
      },
      {
        label: 'holds.name',
        model: {
          ...baseModel(),
          invariants: [{ id: 'inv-bad-name', label: 'Bad name', holds: { op: 'var', name: uncoercible() } }],
        },
        expectedCode: 'UNKNOWN_VAR',
      },
      {
        label: 'updates[0].var',
        model: {
          ...baseModel(),
          rules: [
            {
              id: 'r-bad-var',
              label: 'Bad update var',
              guard: { op: 'lit', value: true },
              updates: [{ var: uncoercible(), value: { op: 'lit', value: 1 } }],
            },
          ],
        },
        expectedCode: 'UNKNOWN_VAR',
      },
      {
        label: 'ValueExpr.op',
        model: {
          ...baseModel(),
          rules: [
            {
              id: 'r-bad-val-op',
              label: 'Bad value op',
              guard: { op: 'lit', value: true },
              updates: [{ var: 'x', value: { op: uncoercible() } }],
            },
          ],
        },
        expectedCode: 'INVALID_EXPR_OP',
      },
    ];

    for (const c of cases) {
      const valErrors = validateModel(c.model);
      expect(valErrors.some((e) => e.code === c.expectedCode), `validateModel(${c.label})`).toBe(true);

      const verRes = verifyModel(c.model, DEFAULT_OPTS);
      expect(verRes.status, `verifyModel(${c.label})`).toBe('INVALID');
      if (verRes.status === 'INVALID') {
        expect(verRes.errors.some((e) => e.code === c.expectedCode)).toBe(true);
      }

      const repRes = replayTrace(c.model, []);
      expect(repRes.ok, `replayTrace(${c.label})`).toBe(false);
      if (!repRes.ok) {
        expect(repRes.errors?.some((e) => e.code === c.expectedCode)).toBe(true);
      }
    }
  });

  it('rejects accessor getter properties with INVALID_ACCESSOR_PROPERTY without invoking getters or throwing', () => {
    let optionsGetterInvoked = false;
    const hostileOptions = {
      get maxStates(): number {
        optionsGetterInvoked = true;
        throw new Error('getter invoked');
      },
      maxDepth: 0,
    };

    const optErrors = validateOptions(hostileOptions);
    expect(optionsGetterInvoked).toBe(false);
    expect(optErrors.some((e) => e.code === 'INVALID_ACCESSOR_PROPERTY' && e.path === 'maxStates')).toBe(true);

    const verOptRes = verifyModel(baseModel(), hostileOptions);
    expect(optionsGetterInvoked).toBe(false);
    expect(verOptRes.status).toBe('INVALID');
    if (verOptRes.status === 'INVALID') {
      expect(verOptRes.errors.some((e) => e.code === 'INVALID_ACCESSOR_PROPERTY' && e.path === 'maxStates')).toBe(true);
    }

    let modelGetterInvoked = false;
    const hostileModel = {
      id: 'hostile-getter-model',
      name: 'Hostile Getter Model',
      get schema(): unknown {
        modelGetterInvoked = true;
        throw new Error('boom');
      },
      initialState: { x: 0 },
      rules: [],
      invariants: [{ id: 'inv-ok', label: 'Always ok', holds: { op: 'lit', value: true } }],
      assumptions: DEFAULT_ASSUMPTIONS,
    };

    const modErrors = validateModel(hostileModel);
    expect(modelGetterInvoked).toBe(false);
    expect(modErrors.some((e) => e.code === 'INVALID_ACCESSOR_PROPERTY' && e.path === 'schema')).toBe(true);

    const verModRes = verifyModel(hostileModel, DEFAULT_OPTS);
    expect(modelGetterInvoked).toBe(false);
    expect(verModRes.status).toBe('INVALID');
    if (verModRes.status === 'INVALID') {
      expect(verModRes.errors.some((e) => e.code === 'INVALID_ACCESSOR_PROPERTY' && e.path === 'schema')).toBe(true);
    }

    const repModRes = replayTrace(hostileModel, []);
    expect(modelGetterInvoked).toBe(false);
    expect(repModRes.ok).toBe(false);
    if (!repModRes.ok) {
      expect(repModRes.error.code).toBe('INVALID_ACCESSOR_PROPERTY');
      expect(repModRes.error.path).toBe('schema');
    }

    let traceElemGetterInvoked = false;
    const hostileRuleIds: unknown[] = [];
    Object.defineProperty(hostileRuleIds, 0, {
      enumerable: true,
      configurable: true,
      get() {
        traceElemGetterInvoked = true;
        throw new Error('trace getter invoked');
      },
    });
    const repElemRes = replayTrace(baseModel(), hostileRuleIds);
    expect(traceElemGetterInvoked).toBe(false);
    expect(repElemRes.ok).toBe(false);
    if (!repElemRes.ok) {
      expect(repElemRes.stepIndex).toBe(0);
      expect(repElemRes.error.code).toBe('INVALID_ACCESSOR_PROPERTY');
      expect(repElemRes.error.path).toBe('ruleIds[0]');
    }

    const throwingProxy = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error('proxy trap boom');
        },
      },
    );
    expect(validateModel(throwingProxy)[0]?.code).toBe('UNEXPECTED_INPUT_ERROR');
    expect(validateOptions(throwingProxy)[0]?.code).toBe('UNEXPECTED_INPUT_ERROR');
    expect(verifyModel(throwingProxy, DEFAULT_OPTS).status).toBe('INVALID');
    expect(getInitialState(throwingProxy).ok).toBe(false);
    expect(getEnabledTransitions(baseModel(), throwingProxy).ok).toBe(false);
    expect(stepModel(baseModel(), throwingProxy, 'r').ok).toBe(false);
    expect(replayTrace(throwingProxy, []).ok).toBe(false);
  });

  it('ignores ambient Object.prototype.goal so inherited goal never leaks into goal-free models', () => {
    const model = baseModel();
    Object.defineProperty(Object.prototype, 'goal', {
      configurable: true,
      writable: true,
      value: { id: 'ambient', label: 'Ambient', reached: { op: 'lit', value: true } },
    });

    try {
      expect(validateModel(model)).toEqual([]);

      const res = verifyModel(model, DEFAULT_OPTS);
      expect(res.status).toBe('VERIFIED');
      expect(Object.hasOwn(res, 'goalReachable')).toBe(false);

      const replayed = replayTrace(model, []);
      expect(replayed.ok).toBe(true);
      if (replayed.ok) {
        expect(Object.hasOwn(replayed, 'goalReached')).toBe(false);
      }
    } finally {
      Reflect.deleteProperty(Object.prototype, 'goal');
    }
  });

  it('rejects own Symbol.iterator tampering on rules and other inputs with INVALID_SYMBOL_PROPERTY (never false VERIFIED)', () => {
    let symbolGetterInvoked = false;
    const tamperedRules: TransitionSystemModel['rules'][number][] = [
      {
        id: 'set_x',
        label: 'Set x to true',
        guard: { op: 'lit', value: true },
        updates: [{ var: 'x', value: { op: 'lit', value: true } }],
      },
    ];
    Object.defineProperty(tamperedRules, Symbol.iterator, {
      configurable: true,
      get() {
        symbolGetterInvoked = true;
        return () => [][Symbol.iterator]();
      },
    });

    const tamperedModel = baseModel({
      schema: { x: { kind: 'boolean' } },
      initialState: { x: false },
      rules: tamperedRules,
      invariants: [{ id: 'inv-not-x', label: 'x must stay false', holds: { op: 'not', arg: { op: 'var', name: 'x' } } }],
    });

    const valErrors = validateModel(tamperedModel);
    expect(symbolGetterInvoked).toBe(false);
    expect(valErrors.some((e) => e.code === 'INVALID_SYMBOL_PROPERTY' && e.path === 'rules')).toBe(true);

    const verRes = verifyModel(tamperedModel, DEFAULT_OPTS);
    expect(symbolGetterInvoked).toBe(false);
    expect(verRes.status).toBe('INVALID');
    if (verRes.status === 'INVALID') {
      expect(verRes.errors.some((e) => e.code === 'INVALID_SYMBOL_PROPERTY' && e.path === 'rules')).toBe(true);
    }

    const initRes = getInitialState(tamperedModel);
    expect(initRes.ok).toBe(false);
    if (!initRes.ok) {
      expect(initRes.errors.some((e) => e.code === 'INVALID_SYMBOL_PROPERTY')).toBe(true);
    }

    const enabledRes = getEnabledTransitions(tamperedModel, { x: false });
    expect(enabledRes.ok).toBe(false);
    if (!enabledRes.ok) {
      expect(enabledRes.errors.some((e) => e.code === 'INVALID_SYMBOL_PROPERTY')).toBe(true);
    }

    const stepRes = stepModel(tamperedModel, { x: false }, 'set_x');
    expect(stepRes.ok).toBe(false);
    if (!stepRes.ok) {
      expect(stepRes.errors?.some((e) => e.code === 'INVALID_SYMBOL_PROPERTY')).toBe(true);
    }

    const replayRes = replayTrace(tamperedModel, ['set_x']);
    expect(replayRes.ok).toBe(false);
    if (!replayRes.ok) {
      expect(replayRes.errors?.some((e) => e.code === 'INVALID_SYMBOL_PROPERTY')).toBe(true);
    }
    expect(symbolGetterInvoked).toBe(false);

    // Also reject own symbol properties on options, state, and ruleIds, plus sparse arrays and Array subclasses
    const symOpts: Record<PropertyKey, unknown> = { maxStates: 100, maxDepth: 10 };
    symOpts[Symbol.toPrimitive] = () => 1;
    expect(validateOptions(symOpts).some((e) => e.code === 'INVALID_SYMBOL_PROPERTY')).toBe(true);

    const cleanModel = baseModel({
      schema: { x: { kind: 'boolean' } },
      initialState: { x: false },
      rules: [
        {
          id: 'set_x',
          label: 'Set x to true',
          guard: { op: 'lit', value: true },
          updates: [{ var: 'x', value: { op: 'lit', value: true } }],
        },
      ],
      invariants: [{ id: 'inv-not-x', label: 'x must stay false', holds: { op: 'not', arg: { op: 'var', name: 'x' } } }],
    });

    const symState: Record<PropertyKey, unknown> = { x: false };
    symState[Symbol.toStringTag] = 'FakeState';
    const symStateRes = getEnabledTransitions(cleanModel, symState);
    expect(symStateRes.ok).toBe(false);
    if (!symStateRes.ok) expect(symStateRes.errors.some((e) => e.code === 'INVALID_SYMBOL_PROPERTY')).toBe(true);

    const symRuleIds = ['set_x'];
    Object.defineProperty(symRuleIds, Symbol.iterator, { value: () => [][Symbol.iterator](), configurable: true });
    const symReplayRes = replayTrace(cleanModel, symRuleIds);
    expect(symReplayRes.ok).toBe(false);
    if (!symReplayRes.ok) expect(symReplayRes.error.code).toBe('INVALID_SYMBOL_PROPERTY');

    const sparseRules: unknown[] = [];
    sparseRules.length = 1;
    const sparseRes = verifyModel({ ...cleanModel, rules: sparseRules }, DEFAULT_OPTS);
    expect(sparseRes.status).toBe('INVALID');
    if (sparseRes.status === 'INVALID') {
      expect(sparseRes.errors.some((e) => e.code === 'INVALID_SPARSE_ARRAY')).toBe(true);
    }

    class SubArray<T> extends Array<T> {}
    const subRules = new SubArray(...cleanModel.rules);
    const subRes = verifyModel({ ...cleanModel, rules: subRules }, DEFAULT_OPTS);
    expect(subRes.status).toBe('INVALID');
    if (subRes.status === 'INVALID') {
      expect(subRes.errors.some((e) => e.code === 'INVALID_RULES')).toBe(true);
    }
  });

  it('parses caller inputs in a single pass so stateful Proxy TOCTOU mutations cannot diverge compilation from validation', () => {
    const violatingRule = {
      id: 'set_x',
      label: 'Set x to true',
      guard: { op: 'lit' as const, value: true },
      updates: [{ var: 'x', value: { op: 'lit' as const, value: true } }],
    };
    const harmlessRule = {
      id: 'noop',
      label: 'No-op',
      guard: { op: 'lit' as const, value: false },
      updates: [],
    };

    const makeStatefulRulesProxy = () => {
      let lengthReads = 0;
      let elem0Reads = 0;
      let getTrapCalled = false;
      const backing = [violatingRule];
      const proxy = new Proxy(backing, {
        get() {
          getTrapCalled = true;
          throw new Error('direct get trap should never be invoked');
        },
        getOwnPropertyDescriptor(target, prop) {
          if (prop === 'length') {
            lengthReads += 1;
            if (lengthReads === 1) {
              return { value: 1, writable: true, enumerable: false, configurable: false };
            }
            return { value: 0, writable: true, enumerable: false, configurable: false };
          }
          if (prop === '0') {
            elem0Reads += 1;
            return {
              value: elem0Reads === 1 ? violatingRule : harmlessRule,
              writable: true,
              enumerable: true,
              configurable: true,
            };
          }
          return Reflect.getOwnPropertyDescriptor(target, prop);
        },
      });
      return {
        proxy,
        stats: () => ({ lengthReads, elem0Reads, getTrapCalled }),
      };
    };

    const forVerify = makeStatefulRulesProxy();
    const modelForVerify = baseModel({
      schema: { x: { kind: 'boolean' } },
      initialState: { x: false },
      rules: forVerify.proxy,
      invariants: [{ id: 'inv-not-x', label: 'x must stay false', holds: { op: 'not', arg: { op: 'var', name: 'x' } } }],
    });

    const verRes = verifyModel(modelForVerify, DEFAULT_OPTS);
    expect(forVerify.stats()).toEqual({ lengthReads: 1, elem0Reads: 1, getTrapCalled: false });
    expect(verRes.status).toBe('VIOLATED');
    if (verRes.status === 'VIOLATED') {
      expect(verRes.trace).toHaveLength(1);
      expect(verRes.trace[0]?.ruleId).toBe('set_x');
      expect(verRes.violatedInvariantIds).toEqual(['inv-not-x']);
    }

    const forValidate = makeStatefulRulesProxy();
    const modelForValidate = baseModel({
      schema: { x: { kind: 'boolean' } },
      initialState: { x: false },
      rules: forValidate.proxy,
      invariants: [{ id: 'inv-not-x', label: 'x must stay false', holds: { op: 'not', arg: { op: 'var', name: 'x' } } }],
    });
    expect(validateModel(modelForValidate)).toEqual([]);
    expect(forValidate.stats()).toEqual({ lengthReads: 1, elem0Reads: 1, getTrapCalled: false });

    // Hostile Proxy throwing in ownKeys returns UNEXPECTED_INPUT_ERROR consistently
    const throwingOwnKeysProxy = new Proxy([], {
      ownKeys() {
        throw new Error('ownKeys boom');
      },
    });
    const hostileModel = baseModel({ rules: throwingOwnKeysProxy });
    expect(validateModel(hostileModel)[0]?.code).toBe('UNEXPECTED_INPUT_ERROR');
    const hostileVer = verifyModel(hostileModel, DEFAULT_OPTS);
    expect(hostileVer.status).toBe('INVALID');
    if (hostileVer.status === 'INVALID') {
      expect(hostileVer.errors[0]?.code).toBe('UNEXPECTED_INPUT_ERROR');
    }
  });

  it('remains sound and returns VIOLATED even when Array.prototype[Symbol.iterator] is monkeypatched', () => {
    const violatingModel = baseModel({
      schema: {
        x: { kind: 'boolean' },
        mode: { kind: 'enum', values: ['safe', 'bad'] },
      },
      initialState: { x: false, mode: 'safe' },
      rules: [
        {
          id: 'set_x',
          label: 'Trigger violation',
          guard: { op: 'in', expr: { op: 'var', name: 'mode' }, values: ['safe'] },
          updates: [
            { var: 'x', value: { op: 'lit', value: true } },
            { var: 'mode', value: { op: 'lit', value: 'bad' } },
          ],
        },
      ],
      invariants: [
        {
          id: 'inv-safe',
          label: 'Must stay safe and not x',
          holds: {
            op: 'and',
            args: [
              { op: 'not', arg: { op: 'var', name: 'x' } },
              { op: 'in', expr: { op: 'var', name: 'mode' }, values: ['safe'] },
            ],
          },
        },
      ],
    });

    const originalIterator = Array.prototype[Symbol.iterator];
    Object.defineProperty(Array.prototype, Symbol.iterator, {
      configurable: true,
      writable: true,
      value() {
        return {
          next() {
            return { value: undefined, done: true as const };
          },
        };
      },
    });

    try {
      expect(validateModel(violatingModel)).toEqual([]);

      const verRes = verifyModel(violatingModel, DEFAULT_OPTS);
      expect(verRes.status).toBe('VIOLATED');
      if (verRes.status === 'VIOLATED') {
        expect(verRes.trace).toHaveLength(1);
        expect(verRes.trace[0]?.ruleId).toBe('set_x');
        expect(verRes.violatedInvariantIds).toEqual(['inv-safe']);
      }

      const repRes = replayTrace(violatingModel, ['set_x']);
      expect(repRes.ok).toBe(true);
      if (repRes.ok) {
        expect(repRes.violatedInvariantIds).toEqual(['inv-safe']);
      }
    } finally {
      Object.defineProperty(Array.prototype, Symbol.iterator, {
        configurable: true,
        writable: true,
        value: originalIterator,
      });
    }
  });

  it('preserves completed valid prefix steps and reports earliest failure index in replayTrace', () => {
    const model = baseModel({
      schema: { x: { kind: 'boolean' } },
      initialState: { x: false },
      rules: [
        {
          id: 'set',
          label: 'Set x to true',
          guard: { op: 'not', arg: { op: 'var', name: 'x' } },
          updates: [{ var: 'x', value: { op: 'lit', value: true } }],
        },
      ],
    });

    // Valid prefix 'set' must be executed and returned in steps before reporting malformed entry at index 1
    const withValidPrefix = replayTrace(model, ['set', 0]);
    expect(withValidPrefix.ok).toBe(false);
    if (!withValidPrefix.ok) {
      expect(withValidPrefix.stepIndex).toBe(1);
      expect(withValidPrefix.error.code).toBe('UNKNOWN_RULE');
      expect(withValidPrefix.steps).toHaveLength(1);
      expect(withValidPrefix.steps[0]?.ruleId).toBe('set');
      expect(withValidPrefix.steps[0]?.stateAfter).toEqual({ x: true });
    }

    // Earlier execution failure at index 0 must be reported before malformed entry at index 1
    const withEarlierFailure = replayTrace(model, ['missing', 0]);
    expect(withEarlierFailure.ok).toBe(false);
    if (!withEarlierFailure.ok) {
      expect(withEarlierFailure.stepIndex).toBe(0);
      expect(withEarlierFailure.error.code).toBe('UNKNOWN_RULE');
      expect(withEarlierFailure.steps).toEqual([]);
    }
  });

  it('ignores inherited Object.prototype.get/set data properties during validation, verification, and replay', () => {
    const model = baseModel({
      schema: { x: { kind: 'boolean' } },
      initialState: { x: false },
      rules: [
        {
          id: 'set',
          label: 'Set x',
          guard: { op: 'not', arg: { op: 'var', name: 'x' } },
          updates: [{ var: 'x', value: { op: 'lit', value: true } }],
        },
      ],
    });

    let errors: ReturnType<typeof validateModel>;
    let verified: ReturnType<typeof verifyModel>;
    let replayed: ReturnType<typeof replayTrace>;

    Object.defineProperty(Object.prototype, 'get', {
      value: () => 'polluted',
      configurable: true,
      writable: true,
    });

    try {
      errors = validateModel(model);
      verified = verifyModel(model, DEFAULT_OPTS);
      replayed = replayTrace(model, ['set']);
    } finally {
      Reflect.deleteProperty(Object.prototype, 'get');
    }

    expect(errors).toEqual([]);
    expect(verified.status).toBe('VERIFIED');
    expect(replayed.ok).toBe(true);
    if (replayed.ok) {
      expect(replayed.finalState).toEqual({ x: true });
    }
  });

  it('preserves replayTrace prefix on Proxy element-level descriptor throws and reports earlier step errors first', () => {
    const model = baseModel({
      schema: { x: { kind: 'boolean' } },
      initialState: { x: false },
      rules: [
        {
          id: 'set',
          label: 'Set x to true',
          guard: { op: 'not', arg: { op: 'var', name: 'x' } },
          updates: [{ var: 'x', value: { op: 'lit', value: true } }],
        },
        {
          id: 'reset',
          label: 'Reset x to false',
          guard: { op: 'var', name: 'x' },
          updates: [{ var: 'x', value: { op: 'lit', value: false } }],
        },
      ],
    });

    const makeThrowingIndex1Proxy = (firstRuleId: string): readonly string[] =>
      new Proxy([firstRuleId, 'placeholder'], {
        getOwnPropertyDescriptor(target, prop) {
          if (prop === '1') {
            throw new Error('index 1 descriptor trap boom');
          }
          return Reflect.getOwnPropertyDescriptor(target, prop);
        },
      });

    // Valid enabled index 0 -> executes step 0 and reports UNEXPECTED_INPUT_ERROR at stepIndex 1
    const withValidPrefix = replayTrace(model, makeThrowingIndex1Proxy('set'));
    expect(withValidPrefix.ok).toBe(false);
    if (!withValidPrefix.ok) {
      expect(withValidPrefix.stepIndex).toBe(1);
      expect(withValidPrefix.error.code).toBe('UNEXPECTED_INPUT_ERROR');
      expect(withValidPrefix.error.path).toBe('ruleIds[1]');
      expect(Object.isFrozen(withValidPrefix.error)).toBe(true);
      expect(Object.isFrozen(withValidPrefix.errors)).toBe(true);
      expect(withValidPrefix.steps).toHaveLength(1);
      expect(withValidPrefix.steps[0]?.ruleId).toBe('set');
      expect(withValidPrefix.steps[0]?.stateAfter).toEqual({ x: true });
    }

    // Unknown rule at index 0 -> reports UNKNOWN_RULE at stepIndex 0 before reaching index 1 trap
    const withUnknownFirst = replayTrace(model, makeThrowingIndex1Proxy('does-not-exist'));
    expect(withUnknownFirst.ok).toBe(false);
    if (!withUnknownFirst.ok) {
      expect(withUnknownFirst.stepIndex).toBe(0);
      expect(withUnknownFirst.error.code).toBe('UNKNOWN_RULE');
      expect(withUnknownFirst.steps).toEqual([]);
    }

    // Disabled rule at index 0 -> reports RULE_DISABLED at stepIndex 0 before reaching index 1 trap
    const withDisabledFirst = replayTrace(model, makeThrowingIndex1Proxy('reset'));
    expect(withDisabledFirst.ok).toBe(false);
    if (!withDisabledFirst.ok) {
      expect(withDisabledFirst.stepIndex).toBe(0);
      expect(withDisabledFirst.error.code).toBe('RULE_DISABLED');
      expect(withDisabledFirst.steps).toEqual([]);
    }
  });

  it('rejects extra own getters/setters on otherwise valid options, models, nested objects, and arrays without invoking accessors', () => {
    let extraOptGetterInvoked = false;
    const optsWithExtraGetter = {
      maxStates: 100,
      maxDepth: 10,
      get extra(): number {
        extraOptGetterInvoked = true;
        throw new Error('extra options getter invoked');
      },
    };

    const optErrors = validateOptions(optsWithExtraGetter);
    expect(extraOptGetterInvoked).toBe(false);
    expect(optErrors.some((e) => e.code === 'INVALID_ACCESSOR_PROPERTY' && e.path === 'extra')).toBe(true);

    const verOptRes = verifyModel(baseModel(), optsWithExtraGetter);
    expect(extraOptGetterInvoked).toBe(false);
    expect(verOptRes.status).toBe('INVALID');
    if (verOptRes.status === 'INVALID') {
      expect(verOptRes.errors.some((e) => e.code === 'INVALID_ACCESSOR_PROPERTY' && e.path === 'extra')).toBe(true);
    }

    let extraModelSetterInvoked = false;
    const modelWithHiddenSetter = { ...baseModel() };
    Object.defineProperty(modelWithHiddenSetter, 'hiddenTrap', {
      enumerable: false,
      configurable: true,
      set() {
        extraModelSetterInvoked = true;
        throw new Error('extra model setter invoked');
      },
    });

    const modErrors = validateModel(modelWithHiddenSetter);
    expect(extraModelSetterInvoked).toBe(false);
    expect(modErrors.some((e) => e.code === 'INVALID_ACCESSOR_PROPERTY' && e.path === 'hiddenTrap')).toBe(true);

    const verModRes = verifyModel(modelWithHiddenSetter, DEFAULT_OPTS);
    expect(extraModelSetterInvoked).toBe(false);
    expect(verModRes.status).toBe('INVALID');
    if (verModRes.status === 'INVALID') {
      expect(verModRes.errors.some((e) => e.code === 'INVALID_ACCESSOR_PROPERTY' && e.path === 'hiddenTrap')).toBe(true);
    }

    let extraArrayGetterInvoked = false;
    const rulesWithExtraGetter: TransitionSystemModel['rules'][number][] = [];
    Object.defineProperty(rulesWithExtraGetter, 'sneaky', {
      enumerable: false,
      configurable: true,
      get() {
        extraArrayGetterInvoked = true;
        throw new Error('array extra getter invoked');
      },
    });
    const arrErrors = validateModel(baseModel({ rules: rulesWithExtraGetter }));
    expect(extraArrayGetterInvoked).toBe(false);
    expect(arrErrors.some((e) => e.code === 'INVALID_ACCESSOR_PROPERTY' && e.path === 'rules.sneaky')).toBe(true);

    let extraExprGetterInvoked = false;
    const holdsWithExtraGetter = { op: 'lit' as const, value: true };
    Object.defineProperty(holdsWithExtraGetter, 'extra', {
      enumerable: true,
      configurable: true,
      get() {
        extraExprGetterInvoked = true;
        throw new Error('expr extra getter invoked');
      },
    });
    const exprErrors = validateModel(
      baseModel({
        invariants: [{ id: 'inv-extra', label: 'Extra accessor on expr', holds: holdsWithExtraGetter }],
      }),
    );
    expect(extraExprGetterInvoked).toBe(false);
    expect(exprErrors.some((e) => e.code === 'INVALID_ACCESSOR_PROPERTY' && e.path === 'invariants[0].holds.extra')).toBe(true);
  });

  it('rejects non-enumerable own keys in schema and state (both undeclared and declared)', () => {
    const cleanModel = baseModel({
      schema: { x: { kind: 'boolean' } },
      initialState: { x: false },
      rules: [
        {
          id: 'set',
          label: 'Set x',
          guard: { op: 'not', arg: { op: 'var', name: 'x' } },
          updates: [{ var: 'x', value: { op: 'lit', value: true } }],
        },
      ],
    });

    // Undeclared non-enumerable property on state
    const stateWithHiddenExtra: Record<string, unknown> = { x: false };
    Object.defineProperty(stateWithHiddenExtra, 'hiddenExtra', {
      value: true,
      enumerable: false,
      writable: true,
      configurable: true,
    });

    const initValErrors = validateModel({ ...cleanModel, initialState: stateWithHiddenExtra });
    expect(
      initValErrors.some((e) => e.code === 'UNKNOWN_STATE_VAR' && e.path === 'initialState.hiddenExtra'),
    ).toBe(true);

    const enabledRes = getEnabledTransitions(cleanModel, stateWithHiddenExtra);
    expect(enabledRes.ok).toBe(false);
    if (!enabledRes.ok) {
      expect(enabledRes.errors.some((e) => e.code === 'UNKNOWN_STATE_VAR' && e.path === 'state.hiddenExtra')).toBe(true);
    }

    const stepRes = stepModel(cleanModel, stateWithHiddenExtra, 'set');
    expect(stepRes.ok).toBe(false);
    if (!stepRes.ok) {
      expect(stepRes.errors?.some((e) => e.code === 'UNKNOWN_STATE_VAR' && e.path === 'state.hiddenExtra')).toBe(true);
    }

    // Non-enumerable declared property on state
    const stateWithNonEnumDeclared: Record<string, unknown> = {};
    Object.defineProperty(stateWithNonEnumDeclared, 'x', {
      value: false,
      enumerable: false,
      writable: true,
      configurable: true,
    });

    const nonEnumInitErrors = validateModel({ ...cleanModel, initialState: stateWithNonEnumDeclared });
    expect(
      nonEnumInitErrors.some((e) => e.code === 'INVALID_STATE_VALUE' && e.path === 'initialState.x'),
    ).toBe(true);

    const nonEnumEnabled = getEnabledTransitions(cleanModel, stateWithNonEnumDeclared);
    expect(nonEnumEnabled.ok).toBe(false);
    if (!nonEnumEnabled.ok) {
      expect(nonEnumEnabled.errors.some((e) => e.code === 'INVALID_STATE_VALUE' && e.path === 'state.x')).toBe(true);
    }

    // Non-enumerable declared property in schema
    const schemaWithNonEnum: Record<string, unknown> = { x: { kind: 'boolean' } };
    Object.defineProperty(schemaWithNonEnum, 'hiddenVar', {
      value: { kind: 'boolean' },
      enumerable: false,
      writable: true,
      configurable: true,
    });

    const nonEnumSchemaErrors = validateModel({ ...cleanModel, schema: schemaWithNonEnum });
    expect(
      nonEnumSchemaErrors.some((e) => e.code === 'INVALID_SCHEMA' && e.path === 'schema.hiddenVar'),
    ).toBe(true);
  });

  it('freezes and isolates returned ValidationError diagnostics so caller mutation cannot leak across calls', () => {
    const throwingProxy = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error('proxy trap boom');
        },
      },
    );

    const errs1 = validateModel(throwingProxy);
    expect(errs1).toHaveLength(1);
    expect(Object.isFrozen(errs1)).toBe(true);
    expect(Object.isFrozen(errs1[0])).toBe(true);
    expect(() => {
      (errs1[0] as { code: string }).code = 'MUTATED';
    }).toThrow(TypeError);
    expect(() => {
      (errs1 as unknown as unknown[]).push({ code: 'EXTRA', path: '', message: '' });
    }).toThrow(TypeError);

    const errs2 = validateModel(throwingProxy);
    expect(errs2[0]).not.toBe(errs1[0]);
    expect(errs2[0]?.code).toBe('UNEXPECTED_INPUT_ERROR');

    const optErrs = validateOptions(throwingProxy);
    expect(Object.isFrozen(optErrs)).toBe(true);
    expect(Object.isFrozen(optErrs[0])).toBe(true);
    expect(optErrs[0]?.code).toBe('UNEXPECTED_INPUT_ERROR');

    const initRes = getInitialState(throwingProxy);
    expect(initRes.ok).toBe(false);
    if (!initRes.ok) {
      expect(Object.isFrozen(initRes.errors)).toBe(true);
      expect(Object.isFrozen(initRes.errors[0])).toBe(true);
      expect(initRes.errors[0]?.code).toBe('UNEXPECTED_INPUT_ERROR');
    }

    // Also verify frozen diagnostics from applyRule and executeRuleStep
    const oodModel = baseModel({
      schema: { x: { kind: 'int', min: 0, max: 0 } },
      initialState: { x: 0 },
      rules: [
        {
          id: 'inc',
          label: 'Increment out of bounds',
          guard: { op: 'lit', value: true },
          updates: [{ var: 'x', value: { op: 'add', left: { op: 'var', name: 'x' }, right: { op: 'lit', value: 1 } } }],
        },
      ],
    });
    const oodStep = stepModel(oodModel, { x: 0 }, 'inc');
    expect(oodStep.ok).toBe(false);
    if (!oodStep.ok) {
      expect(oodStep.error.code).toBe('OUT_OF_DOMAIN_TRANSITION');
      expect(Object.isFrozen(oodStep.error)).toBe(true);
    }

    const unknownStep = stepModel(oodModel, { x: 0 }, 'missing');
    expect(unknownStep.ok).toBe(false);
    if (!unknownStep.ok) {
      expect(unknownStep.error.code).toBe('UNKNOWN_RULE');
      expect(Object.isFrozen(unknownStep.error)).toBe(true);
    }

    // Single Reflect.ownKeys snapshot per inspected object and INVALID_ACCESSOR_PROPERTY on symbol accessors
    let ownKeysCalls = 0;
    const hiddenSym = Symbol('late-accessor');
    let symGetterInvoked = false;
    const proxyTarget: Record<PropertyKey, unknown> = { maxStates: 10, maxDepth: 5 };
    Object.defineProperty(proxyTarget, hiddenSym, {
      configurable: true,
      get() {
        symGetterInvoked = true;
        throw new Error('symbol getter should not run');
      },
    });
    const singlePassOptsProxy = new Proxy(proxyTarget, {
      ownKeys() {
        ownKeysCalls += 1;
        return ownKeysCalls === 1 ? ['maxStates', 'maxDepth'] : ['maxStates', 'maxDepth', hiddenSym];
      },
    });
    expect(validateOptions(singlePassOptsProxy)).toEqual([]);
    expect(ownKeysCalls).toBe(1);
    expect(symGetterInvoked).toBe(false);

    const directSymAccessorErrs = validateOptions(proxyTarget);
    expect(symGetterInvoked).toBe(false);
    expect(directSymAccessorErrs.some((e) => e.code === 'INVALID_SYMBOL_PROPERTY')).toBe(true);
    expect(directSymAccessorErrs.some((e) => e.code === 'INVALID_ACCESSOR_PROPERTY')).toBe(true);
  });
});
