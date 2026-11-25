import {
  getEnabledTransitions,
  replayTrace,
  verifyModel,
  type TransitionSystemModel,
  type VerifyOptions,
} from '@rulecanvas/core';
import { describe, expect, it } from 'vitest';
import {
  approvalLaunderingBrokenModel,
  approvalLaunderingNaivePatchAModel,
  approvalLaunderingNaivePatchBModel,
  approvalLaunderingPrincipledFixModel,
} from '../../../apps/agent-gate/src/index.js';
import {
  bsl3AirlockBrokenModel,
  bsl3AirlockDefaultOptions,
} from '../../../apps/interlock-sim/src/index.js';
import {
  applyManualStep,
  createManualSimulationSession,
  createTraceReplaySession,
  createVerdictReplaySession,
  jumpReplayToStep,
  resetReplaySession,
  stepReplayBackward,
  stepReplayForward,
  type ReplaySession,
} from '../src/index.js';

const DEFAULT_OPTS: VerifyOptions = { maxStates: 10_000, maxDepth: 50 };

function assertReplayParityAtEveryCursor(model: TransitionSystemModel, ruleIds: readonly string[]): void {
  const init = createTraceReplaySession(model, ruleIds);
  expect(init.ok).toBe(true);
  if (!init.ok) return;

  let session: ReplaySession = init.session;
  expect(session.mode).toBe('trace');
  expect(session.cursor).toBe(0);
  expect(session.totalSteps).toBe(ruleIds.length);
  expect(session.canStepBack).toBe(false);
  expect(session.canStepForward).toBe(ruleIds.length > 0);
  expect(session.activeStep).toBeNull();
  expect(session.changedVars).toEqual([]);
  expect(Object.isFrozen(session)).toBe(true);
  expect(Object.isFrozen(session.currentState)).toBe(true);
  expect(Object.isFrozen(session.steps)).toBe(true);
  expect(Object.isFrozen(session.enabledTransitions)).toBe(true);
  expect(Object.isFrozen(session.violatedInvariantIds)).toBe(true);

  const checkCursorMatchesCore = (s: ReplaySession): void => {
    const prefixRuleIds = ruleIds.slice(0, s.cursor);
    const coreReplay = replayTrace(model, prefixRuleIds);
    expect(coreReplay.ok).toBe(true);
    if (!coreReplay.ok) return;

    const coreEnabled = getEnabledTransitions(model, coreReplay.finalState);
    expect(coreEnabled.ok).toBe(true);
    if (!coreEnabled.ok) return;

    expect(s.currentState).toEqual(coreReplay.finalState);
    expect(s.violatedInvariantIds).toEqual(coreReplay.violatedInvariantIds);
    expect(s.enabledTransitions).toEqual(coreEnabled.transitions);

    if (Object.hasOwn(coreReplay, 'goalReached')) {
      expect(Object.hasOwn(s, 'goalReached')).toBe(true);
      expect(s.goalReached).toBe(coreReplay.goalReached);
    } else {
      expect(Object.hasOwn(s, 'goalReached')).toBe(false);
    }

    if (s.cursor === 0) {
      expect(s.activeStep).toBeNull();
      expect(s.changedVars).toEqual([]);
    } else {
      const expectedStep = coreReplay.steps[s.cursor - 1]!;
      expect(s.activeStep).toEqual(expectedStep);
      expect(s.changedVars).toEqual(expectedStep.changedVars);
    }
  };

  // Walk forward from 0 to N checking parity at every position
  checkCursorMatchesCore(session);
  for (let expectedCursor = 1; expectedCursor <= ruleIds.length; expectedCursor += 1) {
    const next = stepReplayForward(session);
    expect(next.ok).toBe(true);
    if (!next.ok) return;
    session = next.session;
    expect(session.cursor).toBe(expectedCursor);
    expect(session.canStepBack).toBe(true);
    expect(session.canStepForward).toBe(expectedCursor < ruleIds.length);
    checkCursorMatchesCore(session);
  }

  // Stepping past end fails with INVALID_STEP_INDEX
  const pastEnd = stepReplayForward(session);
  expect(pastEnd.ok).toBe(false);
  if (!pastEnd.ok) {
    expect(pastEnd.error.code).toBe('INVALID_STEP_INDEX');
    expect(Object.isFrozen(pastEnd.error)).toBe(true);
    expect(Object.isFrozen(pastEnd.errors)).toBe(true);
  }

  // Walk backward from N down to 0 checking parity
  for (let expectedCursor = ruleIds.length - 1; expectedCursor >= 0; expectedCursor -= 1) {
    const prev = stepReplayBackward(session);
    expect(prev.ok).toBe(true);
    if (!prev.ok) return;
    session = prev.session;
    expect(session.cursor).toBe(expectedCursor);
    checkCursorMatchesCore(session);
  }

  // Jump directly to terminal state, then reset back to 0 keeping trace steps
  const jumped = jumpReplayToStep(session, ruleIds.length);
  expect(jumped.ok).toBe(true);
  if (!jumped.ok) return;
  expect(jumped.session.cursor).toBe(ruleIds.length);
  checkCursorMatchesCore(jumped.session);

  const reset = resetReplaySession(jumped.session);
  expect(reset.ok).toBe(true);
  if (!reset.ok) return;
  expect(reset.session.mode).toBe('trace');
  expect(reset.session.cursor).toBe(0);
  expect(reset.session.totalSteps).toBe(ruleIds.length);
  checkCursorMatchesCore(reset.session);
}

describe('@rulecanvas/ui replay-controller', () => {
  describe('real multi-step counterexample replay parity', () => {
    it('replays @rulecanvas/agent-gate broken 5-step counterexample with exact core parity', () => {
      const verdict = verifyModel(approvalLaunderingBrokenModel, DEFAULT_OPTS);
      expect(verdict.status).toBe('VIOLATED');
      if (verdict.status !== 'VIOLATED') return;
      expect(verdict.trace).toHaveLength(5);

      const ruleIds = verdict.trace.map((s) => s.ruleId);
      assertReplayParityAtEveryCursor(approvalLaunderingBrokenModel, ruleIds);

      const fromVerdictTerminal = createVerdictReplaySession(
        approvalLaunderingBrokenModel,
        verdict,
        { startAt: 'terminal' },
      );
      expect(fromVerdictTerminal.ok).toBe(true);
      if (!fromVerdictTerminal.ok) return;
      expect(fromVerdictTerminal.session.cursor).toBe(5);
      expect(fromVerdictTerminal.session.violatedInvariantIds).toEqual([
        'inv_no_confidential_publish',
      ]);
      expect(fromVerdictTerminal.session.currentState).toEqual(verdict.terminalState);
    });

    it('replays @rulecanvas/agent-gate naive-patch-a 6-step counterexample with exact core parity', () => {
      const verdict = verifyModel(approvalLaunderingNaivePatchAModel, DEFAULT_OPTS);
      expect(verdict.status).toBe('VIOLATED');
      if (verdict.status !== 'VIOLATED') return;
      expect(verdict.trace).toHaveLength(6);

      assertReplayParityAtEveryCursor(
        approvalLaunderingNaivePatchAModel,
        verdict.trace.map((s) => s.ruleId),
      );
    });

    it('replays @rulecanvas/agent-gate naive-patch-b 7-step counterexample with exact core parity', () => {
      const verdict = verifyModel(approvalLaunderingNaivePatchBModel, DEFAULT_OPTS);
      expect(verdict.status).toBe('VIOLATED');
      if (verdict.status !== 'VIOLATED') return;
      expect(verdict.trace).toHaveLength(7);

      assertReplayParityAtEveryCursor(
        approvalLaunderingNaivePatchBModel,
        verdict.trace.map((s) => s.ruleId),
      );
    });

    it('replays @rulecanvas/interlock-sim broken 6-step counterexample with exact core parity', () => {
      const verdict = verifyModel(bsl3AirlockBrokenModel, bsl3AirlockDefaultOptions);
      expect(verdict.status).toBe('VIOLATED');
      if (verdict.status !== 'VIOLATED') return;
      expect(verdict.trace).toHaveLength(6);

      assertReplayParityAtEveryCursor(
        bsl3AirlockBrokenModel,
        verdict.trace.map((s) => s.ruleId),
      );
    });
  });

  describe('createVerdictReplaySession variants and initial-state violations', () => {
    it('handles initial-state (s0) violation trace with empty ruleIds', () => {
      const s0ViolatingModel: TransitionSystemModel = {
        id: 's0-violation',
        name: 'Initial Violation Model',
        schema: {
          flag: { kind: 'boolean' },
        },
        initialState: { flag: true },
        rules: [
          {
            id: 'clear_flag',
            label: 'Clear flag',
            guard: { op: 'var', name: 'flag' },
            updates: [{ var: 'flag', value: { op: 'lit', value: false } }],
          },
        ],
        invariants: [
          {
            id: 'inv_flag_false',
            label: 'Flag must stay false',
            holds: { op: 'not', arg: { op: 'var', name: 'flag' } },
          },
        ],
        assumptions: [
          {
            id: 'a1',
            category: 'scope',
            statement: 'Single boolean state.',
            notModeled: 'External overrides.',
          },
        ],
      };

      const verdict = verifyModel(s0ViolatingModel, DEFAULT_OPTS);
      expect(verdict.status).toBe('VIOLATED');
      if (verdict.status !== 'VIOLATED') return;
      expect(verdict.trace).toEqual([]);

      const sessionRes = createVerdictReplaySession(s0ViolatingModel, verdict);
      expect(sessionRes.ok).toBe(true);
      if (!sessionRes.ok) return;

      expect(sessionRes.session.cursor).toBe(0);
      expect(sessionRes.session.totalSteps).toBe(0);
      expect(sessionRes.session.canStepBack).toBe(false);
      expect(sessionRes.session.canStepForward).toBe(false);
      expect(sessionRes.session.violatedInvariantIds).toEqual(['inv_flag_false']);
      expect(Object.hasOwn(sessionRes.session, 'goalReached')).toBe(false);
    });

    it('defaults startAt to initial for VIOLATED verdicts and starts manual mode for VERIFIED/INCONCLUSIVE', () => {
      const violated = verifyModel(approvalLaunderingBrokenModel, DEFAULT_OPTS);
      expect(violated.status).toBe('VIOLATED');
      const violatedSession = createVerdictReplaySession(approvalLaunderingBrokenModel, violated);
      expect(violatedSession.ok).toBe(true);
      if (violatedSession.ok) {
        expect(violatedSession.session.mode).toBe('trace');
        expect(violatedSession.session.cursor).toBe(0);
        expect(violatedSession.session.totalSteps).toBe(5);
      }

      const verified = verifyModel(approvalLaunderingPrincipledFixModel, DEFAULT_OPTS);
      expect(verified.status).toBe('VERIFIED');
      const verifiedSession = createVerdictReplaySession(
        approvalLaunderingPrincipledFixModel,
        verified,
      );
      expect(verifiedSession.ok).toBe(true);
      if (verifiedSession.ok) {
        expect(verifiedSession.session.mode).toBe('manual');
        expect(verifiedSession.session.cursor).toBe(0);
        expect(verifiedSession.session.totalSteps).toBe(0);
        expect(verifiedSession.session.goalReached).toBe(false);
      }

      const inconclusive = verifyModel(approvalLaunderingPrincipledFixModel, {
        maxStates: 2,
        maxDepth: 50,
      });
      expect(inconclusive.status).toBe('INCONCLUSIVE');
      const inconclusiveSession = createVerdictReplaySession(
        approvalLaunderingPrincipledFixModel,
        inconclusive,
      );
      expect(inconclusiveSession.ok).toBe(true);
      if (inconclusiveSession.ok) {
        expect(inconclusiveSession.session.mode).toBe('manual');
        expect(inconclusiveSession.session.cursor).toBe(0);
      }
    });

    it('propagates errors and prefix trace for INVALID verdicts', () => {
      const oodModel: TransitionSystemModel = {
        id: 'ood-model',
        name: 'Out of domain model',
        schema: { n: { kind: 'int', min: 0, max: 1 } },
        initialState: { n: 0 },
        rules: [
          {
            id: 'inc',
            label: 'Increment',
            guard: { op: 'lit', value: true },
            updates: [
              { var: 'n', value: { op: 'add', left: { op: 'var', name: 'n' }, right: { op: 'lit', value: 1 } } },
            ],
          },
        ],
        invariants: [
          { id: 'inv_ok', label: 'Always ok', holds: { op: 'gte', left: { op: 'var', name: 'n' }, right: { op: 'lit', value: 0 } } },
        ],
        assumptions: [
          { id: 'a1', category: 'scope', statement: 'Counter.', notModeled: 'Overflow wrapping.' },
        ],
      };

      const invalidVerdict = verifyModel(oodModel, DEFAULT_OPTS);
      expect(invalidVerdict.status).toBe('INVALID');
      if (invalidVerdict.status !== 'INVALID') return;

      const init = createVerdictReplaySession(oodModel, invalidVerdict);
      expect(init.ok).toBe(false);
      if (init.ok) return;

      expect(init.stepIndex).toBe(-1);
      expect(init.error.code).toBe('OUT_OF_DOMAIN_TRANSITION');
      expect(init.completedSteps).toHaveLength(1);
      expect(Object.isFrozen(init.error)).toBe(true);
      expect(Object.isFrozen(init.errors)).toBe(true);
      expect(Object.isFrozen(init.completedSteps)).toBe(true);
    });
  });

  describe('manual simulation, branching, and execution errors', () => {
    const counterModel: TransitionSystemModel = {
      id: 'counter-sim',
      name: 'Bounded Counter',
      schema: {
        count: { kind: 'int', min: 0, max: 2 },
        armed: { kind: 'boolean' },
      },
      initialState: { count: 0, armed: false },
      rules: [
        {
          id: 'inc',
          label: 'Increment count',
          guard: { op: 'lit', value: true },
          updates: [
            {
              var: 'count',
              value: { op: 'add', left: { op: 'var', name: 'count' }, right: { op: 'lit', value: 1 } },
            },
          ],
        },
        {
          id: 'arm',
          label: 'Arm when positive',
          guard: { op: 'gt', left: { op: 'var', name: 'count' }, right: { op: 'lit', value: 0 } },
          updates: [{ var: 'armed', value: { op: 'lit', value: true } }],
        },
      ],
      invariants: [
        {
          id: 'inv_not_max_while_armed',
          label: 'Not armed at max count',
          holds: {
            op: 'not',
            arg: {
              op: 'and',
              args: [
                { op: 'var', name: 'armed' },
                { op: 'eq', left: { op: 'var', name: 'count' }, right: { op: 'lit', value: 2 } },
              ],
            },
          },
        },
      ],
      goal: {
        id: 'goal_armed_at_one',
        label: 'Armed at count 1',
        reached: {
          op: 'and',
          args: [
            { op: 'var', name: 'armed' },
            { op: 'eq', left: { op: 'var', name: 'count' }, right: { op: 'lit', value: 1 } },
          ],
        },
      },
      assumptions: [
        { id: 'a1', category: 'scope', statement: 'Discrete steps.', notModeled: 'Timing.' },
      ],
    };

    it('supports manual stepping, stepping back and branching, error codes, and manual reset', () => {
      const init = createManualSimulationSession(counterModel);
      expect(init.ok).toBe(true);
      if (!init.ok) return;

      // RULE_DISABLED at initial state
      const disabledAttempt = applyManualStep(init.session, 'arm');
      expect(disabledAttempt.ok).toBe(false);
      if (!disabledAttempt.ok) {
        expect(disabledAttempt.error.code).toBe('RULE_DISABLED');
        expect(disabledAttempt.session).toBe(init.session);
      }

      // UNKNOWN_RULE
      const unknownAttempt = applyManualStep(init.session, 'no_such_rule');
      expect(unknownAttempt.ok).toBe(false);
      if (!unknownAttempt.ok) {
        expect(unknownAttempt.error.code).toBe('UNKNOWN_RULE');
        expect(unknownAttempt.session).toBe(init.session);
      }

      // Step 1: inc -> count=1
      const s1 = applyManualStep(init.session, 'inc');
      expect(s1.ok).toBe(true);
      if (!s1.ok) return;
      expect(s1.session.cursor).toBe(1);
      expect(s1.session.currentState).toEqual({ count: 1, armed: false });
      expect(s1.session.changedVars).toEqual(['count']);
      expect(s1.session.goalReached).toBe(false);

      // Step 2: inc -> count=2
      const s2 = applyManualStep(s1.session, 'inc');
      expect(s2.ok).toBe(true);
      if (!s2.ok) return;
      expect(s2.session.cursor).toBe(2);
      expect(s2.session.currentState).toEqual({ count: 2, armed: false });

      // OUT_OF_DOMAIN_TRANSITION at count=2 -> count=3 exceeds max 2
      const ood = applyManualStep(s2.session, 'inc');
      expect(ood.ok).toBe(false);
      if (!ood.ok) {
        expect(ood.error.code).toBe('OUT_OF_DOMAIN_TRANSITION');
        expect(ood.session).toBe(s2.session);
      }

      // Step back to cursor=1 and branch by applying 'arm' -> truncates old step 2
      const back = stepReplayBackward(s2.session);
      expect(back.ok).toBe(true);
      if (!back.ok) return;
      expect(back.session.cursor).toBe(1);
      expect(back.session.totalSteps).toBe(2);

      const branched = applyManualStep(back.session, 'arm');
      expect(branched.ok).toBe(true);
      if (!branched.ok) return;
      expect(branched.session.cursor).toBe(2);
      expect(branched.session.totalSteps).toBe(2);
      expect(branched.session.steps.map((st) => st.ruleId)).toEqual(['inc', 'arm']);
      expect(branched.session.currentState).toEqual({ count: 1, armed: true });
      expect(branched.session.goalReached).toBe(true);
      expect(branched.session.violatedInvariantIds).toEqual([]);

      // Step 3: inc -> count=2, armed=true -> violates invariant
      const violatedStep = applyManualStep(branched.session, 'inc');
      expect(violatedStep.ok).toBe(true);
      if (!violatedStep.ok) return;
      expect(violatedStep.session.violatedInvariantIds).toEqual(['inv_not_max_while_armed']);
      expect(violatedStep.session.goalReached).toBe(false);

      // Reset in manual mode clears steps
      const reset = resetReplaySession(violatedStep.session);
      expect(reset.ok).toBe(true);
      if (!reset.ok) return;
      expect(reset.session.mode).toBe('manual');
      expect(reset.session.cursor).toBe(0);
      expect(reset.session.totalSteps).toBe(0);
      expect(reset.session.steps).toEqual([]);
      expect(reset.session.currentState).toEqual({ count: 0, armed: false });
    });
  });

  describe('invalid step indices and hostile unknown inputs', () => {
    it('rejects non-safe-integer and out-of-range step indices without clamping or throwing', () => {
      const init = createTraceReplaySession(approvalLaunderingBrokenModel, ['draft_public_notes']);
      expect(init.ok).toBe(true);
      if (!init.ok) return;

      const badIndices: unknown[] = [
        -1,
        2,
        99,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
        0.5,
        '0',
        null,
        undefined,
      ];

      for (const idx of badIndices) {
        const res = jumpReplayToStep(init.session, idx as number);
        expect(res.ok).toBe(false);
        if (!res.ok) {
          expect(res.error.code).toBe('INVALID_STEP_INDEX');
          expect(Object.isFrozen(res.error)).toBe(true);
          expect(Object.isFrozen(res.errors)).toBe(true);
        }
      }

      const backAtZero = stepReplayBackward(init.session);
      expect(backAtZero.ok).toBe(false);
      if (!backAtZero.ok) {
        expect(backAtZero.error.code).toBe('INVALID_STEP_INDEX');
      }
    });

    it('preserves prefix completedSteps when createTraceReplaySession hits a failing rule', () => {
      const res = createTraceReplaySession(approvalLaunderingBrokenModel, [
        'draft_public_notes',
        'publish_release_notes',
      ]);
      expect(res.ok).toBe(false);
      if (res.ok) return;

      expect(res.stepIndex).toBe(1);
      expect(res.error.code).toBe('RULE_DISABLED');
      expect(res.completedSteps).toHaveLength(1);
      expect(res.completedSteps[0]?.ruleId).toBe('draft_public_notes');
      expect(Object.isFrozen(res.completedSteps)).toBe(true);
    });

    it('never throws on hostile, malformed, or Proxy-trapped unknown inputs', () => {
      const throwingProxy = new Proxy(
        {},
        {
          getOwnPropertyDescriptor() {
            throw new Error('trap exploded');
          },
          getPrototypeOf() {
            throw new Error('proto trap exploded');
          },
        },
      );

      const getterTrap = Object.defineProperty({}, 'status', {
        enumerable: true,
        get() {
          throw new Error('getter should not run');
        },
      });

      expect(createTraceReplaySession(null, []).ok).toBe(false);
      expect(createTraceReplaySession(throwingProxy, []).ok).toBe(false);
      expect(createTraceReplaySession(approvalLaunderingBrokenModel, throwingProxy).ok).toBe(false);
      expect(createManualSimulationSession(throwingProxy).ok).toBe(false);
      expect(createVerdictReplaySession(approvalLaunderingBrokenModel, getterTrap as never).ok).toBe(false);
      expect(createVerdictReplaySession(approvalLaunderingBrokenModel, throwingProxy as never).ok).toBe(false);
      expect(
        createVerdictReplaySession(
          approvalLaunderingBrokenModel,
          verifyModel(approvalLaunderingBrokenModel, DEFAULT_OPTS),
          { startAt: 'bad' as never },
        ).ok,
      ).toBe(false);
      expect(jumpReplayToStep(throwingProxy as never, 0).ok).toBe(false);
      expect(stepReplayForward(null as never).ok).toBe(false);
      expect(stepReplayBackward(undefined as never).ok).toBe(false);
      expect(resetReplaySession({} as never).ok).toBe(false);
      expect(applyManualStep(throwingProxy as never, 'x').ok).toBe(false);

      const validInit = createManualSimulationSession(approvalLaunderingBrokenModel);
      expect(validInit.ok).toBe(true);
      if (validInit.ok) {
        const badRule = applyManualStep(validInit.session, throwingProxy);
        expect(badRule.ok).toBe(false);
        if (!badRule.ok) {
          expect(badRule.error.code).toBe('UNKNOWN_RULE');
        }
      }
    });

    it('deep-clones and deep-freezes session.model and returns canonical frozen sessions on failures', () => {
      const mutableModel = structuredClone(approvalLaunderingPrincipledFixModel) as unknown as {
        id: string;
        name: string;
        schema: Record<string, unknown>;
        initialState: Record<string, unknown>;
        rules: Array<Record<string, unknown>>;
        invariants: Array<Record<string, unknown>>;
        assumptions: Array<Record<string, unknown>>;
      };

      const init = createManualSimulationSession(mutableModel);
      expect(init.ok).toBe(true);
      if (!init.ok) return;

      // Mutating caller's input model does not affect session.model
      mutableModel.name = 'Mutated Name';
      mutableModel.schema['extraVar'] = { kind: 'boolean' };

      expect(init.session.model.name).toBe(approvalLaunderingPrincipledFixModel.name);
      expect(Object.hasOwn(init.session.model.schema, 'extraVar')).toBe(false);
      expect(Object.isFrozen(init.session.model)).toBe(true);
      expect(Object.isFrozen(init.session.model.schema)).toBe(true);
      expect(Object.isFrozen(init.session.model.rules)).toBe(true);

      // Caller-crafted mutable session passed to failing navigation/step returns canonical frozen session
      const mutableSession = {
        mode: 'manual',
        model: structuredClone(approvalLaunderingPrincipledFixModel),
        cursor: 0,
        initialState: { ...init.session.initialState },
        currentState: { ...init.session.currentState },
        steps: [],
      } as unknown as ReplaySession;

      const failedJump = jumpReplayToStep(mutableSession, 99);
      expect(failedJump.ok).toBe(false);
      if (!failedJump.ok) {
        expect(failedJump.error.code).toBe('INVALID_STEP_INDEX');
        expect(failedJump.session).toBeDefined();
        expect(failedJump.session).not.toBe(mutableSession);
        expect(Object.isFrozen(failedJump.session)).toBe(true);
        expect(Object.isFrozen(failedJump.session?.model)).toBe(true);
        expect(Object.isFrozen(failedJump.session?.model.schema)).toBe(true);
      }

      const failedStep = applyManualStep(mutableSession, 'no_such_rule');
      expect(failedStep.ok).toBe(false);
      if (!failedStep.ok) {
        expect(failedStep.error.code).toBe('UNKNOWN_RULE');
        expect(failedStep.session).toBeDefined();
        expect(failedStep.session).not.toBe(mutableSession);
        expect(Object.isFrozen(failedStep.session?.model.schema)).toBe(true);
      }
    });

    it('rejects conflicting session state/history and nested snapshot objects with INVALID_SESSION', () => {
      const simpleModel: TransitionSystemModel = {
        id: 'simple-counter',
        name: 'Simple Counter',
        schema: { n: { kind: 'int', min: 0, max: 5 } },
        initialState: { n: 0 },
        rules: [
          {
            id: 'inc',
            label: 'Increment',
            guard: { op: 'lt', left: { op: 'var', name: 'n' }, right: { op: 'lit', value: 5 } },
            updates: [
              { var: 'n', value: { op: 'add', left: { op: 'var', name: 'n' }, right: { op: 'lit', value: 1 } } },
            ],
          },
        ],
        invariants: [
          { id: 'inv_n', label: 'n >= 0', holds: { op: 'gte', left: { op: 'var', name: 'n' }, right: { op: 'lit', value: 0 } } },
        ],
        assumptions: [{ id: 'a1', category: 'scope', statement: 'Discrete.', notModeled: 'None.' }],
      };

      const conflictingSession = {
        mode: 'manual',
        model: simpleModel,
        cursor: 1,
        initialState: { n: 0 },
        currentState: { n: 2 },
        steps: [
          {
            ruleId: 'inc',
            stateBefore: { n: 0 },
            stateAfter: { n: 1 },
            changedVars: ['n'],
          },
        ],
      } as unknown as ReplaySession;

      const stepRes = applyManualStep(conflictingSession, 'inc');
      expect(stepRes.ok).toBe(false);
      if (!stepRes.ok) {
        expect(stepRes.error.code).toBe('INVALID_SESSION');
        expect(stepRes.session).toBeUndefined();
      }

      const jumpRes = jumpReplayToStep(conflictingSession, 0);
      expect(jumpRes.ok).toBe(false);
      if (!jumpRes.ok) {
        expect(jumpRes.error.code).toBe('INVALID_SESSION');
      }

      const nestedSnapshotSession = {
        mode: 'manual',
        model: simpleModel,
        cursor: 0,
        initialState: { n: { nested: true } },
        currentState: { n: { nested: true } },
        steps: [],
      } as unknown as ReplaySession;

      const nestedRes = jumpReplayToStep(nestedSnapshotSession, 0);
      expect(nestedRes.ok).toBe(false);
      if (!nestedRes.ok) {
        expect(nestedRes.error.code).toBe('INVALID_SESSION');
      }

      // Untrusted steps/changedVars arrays must not invoke custom .every getter
      let everyGetterCalled = false;
      const trappedSteps: unknown[] = [];
      Object.defineProperty(trappedSteps, 'every', {
        get() {
          everyGetterCalled = true;
          throw new Error('every should not be invoked');
        },
      });
      const trappedSession = {
        mode: 'manual',
        model: simpleModel,
        cursor: 0,
        initialState: { n: 0 },
        currentState: { n: 0 },
        steps: trappedSteps,
      } as unknown as ReplaySession;
      expect(jumpReplayToStep(trappedSession, 0).ok).toBe(true);
      expect(everyGetterCalled).toBe(false);
    });

    it('preserves INVALID verdict diagnostics when optional trace throws via Proxy', () => {
      const throwingTraceProxy = new Proxy([], {
        getOwnPropertyDescriptor(_target, prop) {
          if (prop === 'length') {
            throw new Error('trace length trap');
          }
          throw new Error('trace descriptor trap');
        },
      });

      const invalidWithBadTrace = {
        status: 'INVALID',
        errors: [
          {
            code: 'OUT_OF_DOMAIN_TRANSITION',
            path: 'rules[0].updates[0]',
            message: 'Original domain diagnostic must survive.',
          },
        ],
        trace: throwingTraceProxy,
      } as unknown as ReturnType<typeof verifyModel>;

      const init = createVerdictReplaySession(approvalLaunderingBrokenModel, invalidWithBadTrace);
      expect(init.ok).toBe(false);
      if (!init.ok) {
        expect(init.error.code).toBe('OUT_OF_DOMAIN_TRANSITION');
        expect(init.error.message).toBe('Original domain diagnostic must survive.');
        expect(init.completedSteps).toEqual([]);
      }
    });

    it('accepts core-valid 32-deep nested 1-arg and expressions and extra ignored function metadata', () => {
      let expr: TransitionSystemModel['invariants'][number]['holds'] = { op: 'var', name: 'flag' };
      for (let depth = 0; depth < 31; depth += 1) {
        expr = { op: 'and', args: [expr] };
      }

      const deepModelWithMeta = {
        id: 'deep-and-model',
        name: 'Deep And Model',
        metadataFn: () => 'ignored by core',
        schema: { flag: { kind: 'boolean' } },
        initialState: { flag: true },
        rules: [
          {
            id: 'toggle',
            label: 'Toggle',
            guard: { op: 'var', name: 'flag' },
            updates: [{ var: 'flag', value: { op: 'lit', value: false } }],
          },
        ],
        invariants: [
          {
            id: 'inv_deep',
            label: 'Deep invariant',
            holds: expr,
          },
        ],
        assumptions: [
          { id: 'a1', category: 'scope', statement: 'Discrete.', notModeled: 'None.' },
        ],
      } as unknown as TransitionSystemModel;

      const manualInit = createManualSimulationSession(deepModelWithMeta);
      expect(manualInit.ok).toBe(true);
      if (manualInit.ok) {
        expect(Object.isFrozen(manualInit.session.model)).toBe(true);
        expect('metadataFn' in manualInit.session.model).toBe(false);
      }

      const traceInit = createTraceReplaySession(deepModelWithMeta, ['toggle']);
      expect(traceInit.ok).toBe(true);
    });

    it('never invokes an inherited Object.prototype.goalReached getter during session construction', () => {
      let getterCalled = false;
      Object.defineProperty(Object.prototype, 'goalReached', {
        configurable: true,
        get() {
          getterCalled = true;
          throw new Error('inherited goalReached getter must not run');
        },
      });

      try {
        const goalFreeModel: TransitionSystemModel = {
          id: 'goal-free',
          name: 'Goal Free Model',
          schema: { flag: { kind: 'boolean' } },
          initialState: { flag: true },
          rules: [
            {
              id: 'flip',
              label: 'Flip',
              guard: { op: 'var', name: 'flag' },
              updates: [{ var: 'flag', value: { op: 'lit', value: false } }],
            },
          ],
          invariants: [
            { id: 'inv_true', label: 'Always true', holds: { op: 'lit', value: true } },
          ],
          assumptions: [
            { id: 'a1', category: 'scope', statement: 'Discrete.', notModeled: 'None.' },
          ],
        };

        const manual = createManualSimulationSession(goalFreeModel);
        expect(manual.ok).toBe(true);
        if (manual.ok) {
          expect(Object.hasOwn(manual.session, 'goalReached')).toBe(false);
        }

        const trace = createTraceReplaySession(goalFreeModel, ['flip']);
        expect(trace.ok).toBe(true);
        expect(getterCalled).toBe(false);
      } finally {
        delete (Object.prototype as Record<string, unknown>)['goalReached'];
      }
    });

    it('truncates INVALID verdict optional trace at first malformed entry and enforces MAX_REPLAY_STEPS consistently', () => {
      const validStep = {
        ruleId: 'draft_public_notes',
        stateBefore: { ...approvalLaunderingBrokenModel.initialState },
        stateAfter: { ...approvalLaunderingBrokenModel.initialState, draftPublic: true },
        changedVars: ['draftPublic'],
      };
      const gappedInvalid = {
        status: 'INVALID',
        errors: [
          {
            code: 'OUT_OF_DOMAIN_TRANSITION',
            path: 'rules[0]',
            message: 'Failed after step 1.',
          },
        ],
        trace: [validStep, null, validStep],
      } as unknown as ReturnType<typeof verifyModel>;

      const gappedInit = createVerdictReplaySession(approvalLaunderingBrokenModel, gappedInvalid);
      expect(gappedInit.ok).toBe(false);
      if (!gappedInit.ok) {
        expect(gappedInit.completedSteps).toHaveLength(1);
        expect(gappedInit.completedSteps[0]?.ruleId).toBe('draft_public_notes');
      }

      const tooLongRuleIds = new Array<string>(10_001).fill('draft_public_notes');
      const longInit = createTraceReplaySession(approvalLaunderingBrokenModel, tooLongRuleIds);
      expect(longInit.ok).toBe(false);
      if (!longInit.ok) {
        expect(longInit.error.code).toBe('TRACE_TOO_LONG');
      }

      // Changing-length Proxy on ruleIds cannot bypass MAX_REPLAY_STEPS after single-snapshot capture
      const backing = ['draft_public_notes'];
      let expanded = false;
      const changingLengthProxy = new Proxy(backing, {
        getOwnPropertyDescriptor(target, prop) {
          if (prop === '0' && !expanded) {
            expanded = true;
            const desc = Object.getOwnPropertyDescriptor(target, prop);
            for (let i = 0; i < 10_000; i += 1) {
              target.push('draft_public_notes');
            }
            return desc;
          }
          return Object.getOwnPropertyDescriptor(target, prop);
        },
      });
      const proxyCapture = createTraceReplaySession(approvalLaunderingBrokenModel, changingLengthProxy);
      expect(proxyCapture.ok).toBe(true);
      if (proxyCapture.ok) {
        expect(proxyCapture.session.totalSteps).toBe(1);
      }

      // Sparse hole in ruleIds preserves valid prefix steps and fails at hole index
      const sparseRuleIds: string[] = ['draft_public_notes'];
      sparseRuleIds[2] = 'draft_public_notes';
      const sparseTraceRes = createTraceReplaySession(approvalLaunderingBrokenModel, sparseRuleIds);
      expect(sparseTraceRes.ok).toBe(false);
      if (!sparseTraceRes.ok) {
        expect(sparseTraceRes.stepIndex).toBe(1);
        expect(sparseTraceRes.error.code).toBe('INVALID_TRACE');
        expect(sparseTraceRes.completedSteps).toHaveLength(1);
      }

      // Sparse INVALID verdict optional trace retains valid prefix before hole
      const sparseInvalidTrace: unknown[] = [validStep];
      sparseInvalidTrace[2] = validStep;
      const sparseInvalidVerdict = {
        status: 'INVALID',
        errors: [
          {
            code: 'OUT_OF_DOMAIN_TRANSITION',
            path: 'rules[0]',
            message: 'Failed after step 1.',
          },
        ],
        trace: sparseInvalidTrace,
      } as unknown as ReturnType<typeof verifyModel>;
      const sparseVerdictInit = createVerdictReplaySession(
        approvalLaunderingBrokenModel,
        sparseInvalidVerdict,
      );
      expect(sparseVerdictInit.ok).toBe(false);
      if (!sparseVerdictInit.ok) {
        expect(sparseVerdictInit.completedSteps).toHaveLength(1);
        expect(sparseVerdictInit.completedSteps[0]?.ruleId).toBe('draft_public_notes');
      }
    });
  });

  describe('verdict/model consistency and strict VIOLATED/VERIFIED/INCONCLUSIVE validation', () => {
    const baseFlagModel = (nextFlag: boolean): TransitionSystemModel => ({
      id: `flag-model-${String(nextFlag)}`,
      name: `Flag Model (${String(nextFlag)})`,
      schema: {
        flag: { kind: 'boolean' },
      },
      initialState: { flag: false },
      rules: [
        {
          id: 'step_flag',
          label: 'Step flag',
          guard: { op: 'lit', value: true },
          updates: [{ var: 'flag', value: { op: 'lit', value: nextFlag } }],
        },
      ],
      invariants: [
        {
          id: 'inv_flag_false',
          label: 'Flag must remain false',
          holds: { op: 'not', arg: { op: 'var', name: 'flag' } },
        },
      ],
      assumptions: [
        { id: 'a1', category: 'scope', statement: 'Single boolean.', notModeled: 'None.' },
      ],
    });

    it('rejects replaying a VIOLATED verdict against a different model with the same ruleId', () => {
      const brokenModel = baseFlagModel(true);
      const fixedModel = baseFlagModel(false);

      const brokenVerdict = verifyModel(brokenModel, DEFAULT_OPTS);
      expect(brokenVerdict.status).toBe('VIOLATED');
      if (brokenVerdict.status !== 'VIOLATED') return;

      const mismatch = createVerdictReplaySession(fixedModel, brokenVerdict);
      expect(mismatch.ok).toBe(false);
      if (!mismatch.ok) {
        expect(mismatch.error.code).toBe('VERDICT_MODEL_MISMATCH');
        expect(mismatch.stepIndex).toBe(0);
        expect(mismatch.error.path).toBe('result.trace[0]');
      }
    });

    it('detects mismatches in stateBefore, stateAfter, changedVars, terminalState, violatedInvariantIds, and goalReachable', () => {
      const brokenModel = baseFlagModel(true);
      const verdict = verifyModel(brokenModel, DEFAULT_OPTS);
      expect(verdict.status).toBe('VIOLATED');
      if (verdict.status !== 'VIOLATED') return;

      const step0 = verdict.trace[0]!;

      const badBefore = {
        ...verdict,
        trace: [{ ...step0, stateBefore: { flag: true } }],
      };
      const resBefore = createVerdictReplaySession(brokenModel, badBefore);
      expect(resBefore.ok).toBe(false);
      if (!resBefore.ok) {
        expect(resBefore.error.code).toBe('VERDICT_MODEL_MISMATCH');
        expect(resBefore.error.path).toBe('result.trace[0]');
      }

      const badAfter = {
        ...verdict,
        trace: [{ ...step0, stateAfter: { flag: false } }],
      };
      const resAfter = createVerdictReplaySession(brokenModel, badAfter);
      expect(resAfter.ok).toBe(false);
      if (!resAfter.ok) {
        expect(resAfter.error.code).toBe('VERDICT_MODEL_MISMATCH');
        expect(resAfter.error.path).toBe('result.trace[0]');
      }

      const badChanged = {
        ...verdict,
        trace: [{ ...step0, changedVars: [] }],
      };
      const resChanged = createVerdictReplaySession(brokenModel, badChanged);
      expect(resChanged.ok).toBe(false);
      if (!resChanged.ok) {
        expect(resChanged.error.code).toBe('VERDICT_MODEL_MISMATCH');
        expect(resChanged.error.path).toBe('result.trace[0]');
      }

      const badTerminal = {
        ...verdict,
        terminalState: { flag: false },
      };
      const resTerminal = createVerdictReplaySession(brokenModel, badTerminal);
      expect(resTerminal.ok).toBe(false);
      if (!resTerminal.ok) {
        expect(resTerminal.error.code).toBe('VERDICT_MODEL_MISMATCH');
        expect(resTerminal.error.path).toBe('result.terminalState');
      }

      const badViolated = {
        ...verdict,
        violatedInvariantIds: ['inv_other'],
      };
      const resViolated = createVerdictReplaySession(brokenModel, badViolated);
      expect(resViolated.ok).toBe(false);
      if (!resViolated.ok) {
        expect(resViolated.error.code).toBe('VERDICT_MODEL_MISMATCH');
        expect(resViolated.error.path).toBe('result.violatedInvariantIds');
      }

      const badGoal = {
        ...verdict,
        goalReachable: true as const,
      };
      const resGoal = createVerdictReplaySession(brokenModel, badGoal);
      expect(resGoal.ok).toBe(false);
      if (!resGoal.ok) {
        expect(resGoal.error.code).toBe('VERDICT_MODEL_MISMATCH');
        expect(resGoal.error.path).toBe('result.goalReachable');
      }

      // Empty s0 trace with mismatched terminalState
      const s0Model: TransitionSystemModel = {
        ...brokenModel,
        initialState: { flag: true },
      };
      const s0Verdict = verifyModel(s0Model, DEFAULT_OPTS);
      expect(s0Verdict.status).toBe('VIOLATED');
      if (s0Verdict.status !== 'VIOLATED') return;
      const s0BadTerminal = createVerdictReplaySession(s0Model, {
        ...s0Verdict,
        terminalState: { flag: false },
      });
      expect(s0BadTerminal.ok).toBe(false);
      if (!s0BadTerminal.ok) {
        expect(s0BadTerminal.error.code).toBe('VERDICT_MODEL_MISMATCH');
        expect(s0BadTerminal.error.path).toBe('result.terminalState');
      }
    });

    it('rejects missing, empty, or accessor terminalState/violatedInvariantIds with INVALID_VERIFY_RESULT without invoking getters', () => {
      const brokenModel = baseFlagModel(true);
      const verdict = verifyModel(brokenModel, DEFAULT_OPTS);
      expect(verdict.status).toBe('VIOLATED');
      if (verdict.status !== 'VIOLATED') return;

      const missingTerminal = {
        status: 'VIOLATED',
        trace: verdict.trace,
        violatedInvariantIds: verdict.violatedInvariantIds,
        stats: verdict.stats,
        assumptions: verdict.assumptions,
      } as unknown as ReturnType<typeof verifyModel>;
      const resMissingTerminal = createVerdictReplaySession(brokenModel, missingTerminal);
      expect(resMissingTerminal.ok).toBe(false);
      if (!resMissingTerminal.ok) {
        expect(resMissingTerminal.error.code).toBe('INVALID_VERIFY_RESULT');
        expect(resMissingTerminal.error.path).toBe('result.terminalState');
      }

      const emptyViolated = {
        ...verdict,
        violatedInvariantIds: [],
      } as unknown as ReturnType<typeof verifyModel>;
      const resEmptyViolated = createVerdictReplaySession(brokenModel, emptyViolated);
      expect(resEmptyViolated.ok).toBe(false);
      if (!resEmptyViolated.ok) {
        expect(resEmptyViolated.error.code).toBe('INVALID_VERIFY_RESULT');
        expect(resEmptyViolated.error.path).toBe('result.violatedInvariantIds');
      }

      let terminalGetterCalled = false;
      const accessorTerminal = {
        status: 'VIOLATED',
        trace: verdict.trace,
        violatedInvariantIds: verdict.violatedInvariantIds,
        stats: verdict.stats,
        assumptions: verdict.assumptions,
      };
      Object.defineProperty(accessorTerminal, 'terminalState', {
        enumerable: true,
        get() {
          terminalGetterCalled = true;
          return { flag: true };
        },
      });
      const resAccTerminal = createVerdictReplaySession(brokenModel, accessorTerminal as never);
      expect(resAccTerminal.ok).toBe(false);
      expect(terminalGetterCalled).toBe(false);
      if (!resAccTerminal.ok) {
        expect(resAccTerminal.error.code).toBe('INVALID_VERIFY_RESULT');
        expect(resAccTerminal.error.path).toBe('result.terminalState');
      }

      let violatedGetterCalled = false;
      const accessorViolated = {
        status: 'VIOLATED',
        trace: verdict.trace,
        terminalState: verdict.terminalState,
        stats: verdict.stats,
        assumptions: verdict.assumptions,
      };
      Object.defineProperty(accessorViolated, 'violatedInvariantIds', {
        enumerable: true,
        get() {
          violatedGetterCalled = true;
          return ['inv_flag_false'];
        },
      });
      const resAccViolated = createVerdictReplaySession(brokenModel, accessorViolated as never);
      expect(resAccViolated.ok).toBe(false);
      expect(violatedGetterCalled).toBe(false);
      if (!resAccViolated.ok) {
        expect(resAccViolated.error.code).toBe('INVALID_VERIFY_RESULT');
        expect(resAccViolated.error.path).toBe('result.violatedInvariantIds');
      }
    });

    it('rejects goalReachable: false on VIOLATED and INCONCLUSIVE with INVALID_VERIFY_RESULT', () => {
      const brokenModel = baseFlagModel(true);
      const violated = verifyModel(brokenModel, DEFAULT_OPTS);
      expect(violated.status).toBe('VIOLATED');
      if (violated.status !== 'VIOLATED') return;

      const violatedFalseGoal = createVerdictReplaySession(brokenModel, {
        ...violated,
        goalReachable: false,
      } as unknown as ReturnType<typeof verifyModel>);
      expect(violatedFalseGoal.ok).toBe(false);
      if (!violatedFalseGoal.ok) {
        expect(violatedFalseGoal.error.code).toBe('INVALID_VERIFY_RESULT');
        expect(violatedFalseGoal.error.path).toBe('result.goalReachable');
      }

      const fixedModel = baseFlagModel(false);
      const inconclusiveFalseGoal = createVerdictReplaySession(fixedModel, {
        status: 'INCONCLUSIVE',
        reason: 'MAX_STATES',
        completedDepth: 1,
        frontierRemaining: 1,
        goalReachable: false,
        stats: violated.stats,
        assumptions: violated.assumptions,
      } as unknown as ReturnType<typeof verifyModel>);
      expect(inconclusiveFalseGoal.ok).toBe(false);
      if (!inconclusiveFalseGoal.ok) {
        expect(inconclusiveFalseGoal.error.code).toBe('INVALID_VERIFY_RESULT');
        expect(inconclusiveFalseGoal.error.path).toBe('result.goalReachable');
      }
    });

    it('rejects VERIFIED and INCONCLUSIVE verdicts contradicting s0 invariants or goal reachability', () => {
      const s0ViolatingModel: TransitionSystemModel = {
        ...baseFlagModel(false),
        initialState: { flag: true },
      };
      const verifiedVerdict = verifyModel(baseFlagModel(false), DEFAULT_OPTS);
      expect(verifiedVerdict.status).toBe('VERIFIED');
      if (verifiedVerdict.status !== 'VERIFIED') return;

      const verifiedVsS0 = createVerdictReplaySession(s0ViolatingModel, verifiedVerdict);
      expect(verifiedVsS0.ok).toBe(false);
      if (!verifiedVsS0.ok) {
        expect(verifiedVsS0.error.code).toBe('VERDICT_MODEL_MISMATCH');
        expect(verifiedVsS0.error.path).toBe('result.status');
      }

      const inconclusiveVsS0 = createVerdictReplaySession(s0ViolatingModel, {
        status: 'INCONCLUSIVE',
        reason: 'MAX_DEPTH',
        completedDepth: 0,
        frontierRemaining: 1,
        stats: verifiedVerdict.stats,
        assumptions: verifiedVerdict.assumptions,
      });
      expect(inconclusiveVsS0.ok).toBe(false);
      if (!inconclusiveVsS0.ok) {
        expect(inconclusiveVsS0.error.code).toBe('VERDICT_MODEL_MISMATCH');
        expect(inconclusiveVsS0.error.path).toBe('result.status');
      }

      const goalReachedAtS0Model: TransitionSystemModel = {
        ...baseFlagModel(false),
        goal: {
          id: 'goal_flag_false',
          label: 'Flag is false',
          reached: { op: 'not', arg: { op: 'var', name: 'flag' } },
        },
      };
      const vacuousContradiction = createVerdictReplaySession(goalReachedAtS0Model, {
        ...verifiedVerdict,
        goalReachable: false,
      });
      expect(vacuousContradiction.ok).toBe(false);
      if (!vacuousContradiction.ok) {
        expect(vacuousContradiction.error.code).toBe('VERDICT_MODEL_MISMATCH');
        expect(vacuousContradiction.error.path).toBe('result.goalReachable');
      }

      const goalFreeWithGoalVerdict = createVerdictReplaySession(baseFlagModel(false), {
        ...verifiedVerdict,
        goalReachable: true,
      });
      expect(goalFreeWithGoalVerdict.ok).toBe(false);
      if (!goalFreeWithGoalVerdict.ok) {
        expect(goalFreeWithGoalVerdict.error.code).toBe('VERDICT_MODEL_MISMATCH');
        expect(goalFreeWithGoalVerdict.error.path).toBe('result.goalReachable');
      }
    });
  });
});
