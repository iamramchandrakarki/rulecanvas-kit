import type {
  ModelAssumption,
  TransitionSystemModel,
  ValidationError,
  VerifyResult,
  VerifyStats,
} from '@rulecanvas/core';
import { describe, expect, it } from 'vitest';
import {
  buildInvariantsPanelView,
  buildStateTableView,
  buildVerdictSummaryView,
  createTraceReplaySession,
  escapeHtml,
  jumpReplayToStep,
  renderAssumptionsPanelHtml,
  renderInvariantsPanelHtml,
  renderReplayTimelineHtml,
  renderStateTableHtml,
  renderValidationErrorsHtml,
  renderVerdictSummaryHtml,
} from '../src/index.js';

const BASE_STATS: VerifyStats = {
  theoreticalStates: '24',
  statesExplored: 12,
  transitionsEvaluated: 30,
  maxDepthReached: 4,
  deadlockStatesFound: 2,
};

const BASE_ASSUMPTIONS: readonly ModelAssumption[] = [
  {
    id: 'a_atomic',
    category: 'execution',
    statement: 'Rules execute atomically against discrete state.',
    notModeled: 'Concurrent writes or hardware faults.',
  },
];

const SAMPLE_MODEL: TransitionSystemModel = {
  id: 'sample-gate',
  name: 'Sample Release Model',
  schema: {
    reviewed: { kind: 'boolean' },
    stage: { kind: 'enum', values: ['draft', 'live'] },
    retries: { kind: 'int', min: 0, max: 3 },
  },
  initialState: {
    reviewed: false,
    stage: 'draft',
    retries: 0,
  },
  rules: [
    {
      id: 'mark_reviewed',
      label: 'Mark reviewed',
      guard: { op: 'not', arg: { op: 'var', name: 'reviewed' } },
      updates: [{ var: 'reviewed', value: { op: 'lit', value: true } }],
    },
    {
      id: 'promote_live',
      label: 'Promote to live',
      guard: { op: 'eq', left: { op: 'var', name: 'stage' }, right: { op: 'lit', value: 'draft' } },
      updates: [{ var: 'stage', value: { op: 'lit', value: 'live' } }],
    },
  ],
  invariants: [
    {
      id: 'inv_reviewed_before_live',
      label: 'Live stage requires review',
      holds: {
        op: 'or',
        args: [
          { op: 'neq', left: { op: 'var', name: 'stage' }, right: { op: 'lit', value: 'live' } },
          { op: 'var', name: 'reviewed' },
        ],
      },
    },
  ],
  goal: {
    id: 'goal_live',
    label: 'Reach live stage',
    reached: { op: 'eq', left: { op: 'var', name: 'stage' }, right: { op: 'lit', value: 'live' } },
  },
  assumptions: BASE_ASSUMPTIONS,
};

describe('@rulecanvas/ui components', () => {
  describe('escapeHtml', () => {
    it('escapes &, <, >, ", and single quotes', () => {
      expect(escapeHtml(`<script>alert("xss" & '1')</script>`)).toBe(
        '&lt;script&gt;alert(&quot;xss&quot; &amp; &#39;1&#39;)&lt;/script&gt;',
      );
    });
  });

  describe('verdict summary view and renderer', () => {
    it('renders VERIFIED with goalReachable: true as success', () => {
      const result: VerifyResult = {
        status: 'VERIFIED',
        stats: BASE_STATS,
        goalReachable: true,
        assumptions: BASE_ASSUMPTIONS,
      };

      const view = buildVerdictSummaryView(result);
      expect(view.badge).toBe('VERIFIED');
      expect(view.tone).toBe('success');
      expect(view.vacuousGoalWarning).toBe(false);
      expect(view.goalReachable).toBe(true);
      expect(view.role).toBe('status');

      const html = renderVerdictSummaryHtml(result);
      expect(html).toContain('role="status"');
      expect(html).toContain('aria-live="polite"');
      expect(html).toContain('data-status="VERIFIED"');
      expect(html).toContain('data-tone="success"');
      expect(html).toContain('VERIFIED');
      expect(html).toContain('Goal reachable: Yes');
      expect(html).not.toContain('data-vacuous-goal="true"');
      expect(html).toContain('States explored');
      expect(html).toContain('12');
    });

    it('flags vacuous fixes when VERIFIED has goalReachable: false', () => {
      const result: VerifyResult = {
        status: 'VERIFIED',
        stats: BASE_STATS,
        goalReachable: false,
        assumptions: BASE_ASSUMPTIONS,
      };

      const view = buildVerdictSummaryView(result);
      expect(view.badge).toBe('VERIFIED (GOAL UNREACHABLE)');
      expect(view.tone).toBe('warning');
      expect(view.vacuousGoalWarning).toBe(true);
      expect(view.goalReachable).toBe(false);

      const html = renderVerdictSummaryHtml(result);
      expect(html).toContain('VERIFIED (GOAL UNREACHABLE)');
      expect(html).toContain('data-tone="warning"');
      expect(html).toContain('data-vacuous-goal="true"');
      expect(html).toContain('Goal reachable: No');
    });

    it('omits goalReachable when VERIFIED has no goal', () => {
      const result: VerifyResult = {
        status: 'VERIFIED',
        stats: BASE_STATS,
        assumptions: BASE_ASSUMPTIONS,
      };

      const view = buildVerdictSummaryView(result);
      expect(view.badge).toBe('VERIFIED');
      expect(view.tone).toBe('success');
      expect(Object.hasOwn(view, 'goalReachable')).toBe(false);
    });

    it('renders VIOLATED, INCONCLUSIVE, and INVALID verdicts with accessible semantics', () => {
      const violated: VerifyResult = {
        status: 'VIOLATED',
        trace: [
          {
            ruleId: 'promote_live',
            stateBefore: { reviewed: false, stage: 'draft', retries: 0 },
            stateAfter: { reviewed: false, stage: 'live', retries: 0 },
            changedVars: ['stage'],
          },
        ],
        terminalState: { reviewed: false, stage: 'live', retries: 0 },
        violatedInvariantIds: ['inv_reviewed_before_live'],
        stats: BASE_STATS,
        assumptions: BASE_ASSUMPTIONS,
      };
      const violatedHtml = renderVerdictSummaryHtml(violated);
      expect(violatedHtml).toContain('role="alert"');
      expect(violatedHtml).toContain('data-status="VIOLATED"');
      expect(violatedHtml).toContain('inv_reviewed_before_live');
      expect(violatedHtml).toContain('Counterexample found in 1 step.');

      const inconclusive: VerifyResult = {
        status: 'INCONCLUSIVE',
        reason: 'MAX_STATES',
        completedDepth: 3,
        frontierRemaining: 9,
        stats: BASE_STATS,
        assumptions: BASE_ASSUMPTIONS,
      };
      const inconclusiveHtml = renderVerdictSummaryHtml(inconclusive);
      expect(inconclusiveHtml).toContain('data-status="INCONCLUSIVE"');
      expect(inconclusiveHtml).toContain('MAX_STATES');
      expect(inconclusiveHtml).toContain('Completed depth');
      expect(inconclusiveHtml).toContain('3');
      expect(inconclusiveHtml).toContain('Frontier remaining');
      expect(inconclusiveHtml).toContain('9');

      const invalid: VerifyResult = {
        status: 'INVALID',
        errors: [
          { code: 'SCHEMA_EMPTY', path: 'schema', message: 'Schema must define at least one variable.' },
        ],
      };
      const invalidHtml = renderVerdictSummaryHtml(invalid);
      expect(invalidHtml).toContain('role="alert"');
      expect(invalidHtml).toContain('data-status="INVALID"');
      expect(invalidHtml).toContain('Schema must define at least one variable.');
    });
  });

  describe('state table, invariants panel, replay timeline, assumptions, and errors', () => {
    it('renders state table with domain descriptions and Modified/Unchanged badges', () => {
      const state = { reviewed: true, stage: 'draft', retries: 0 };
      const view = buildStateTableView(SAMPLE_MODEL, state, ['reviewed']);
      expect(view.changedCount).toBe(1);
      expect(view.rows).toEqual([
        {
          name: 'reviewed',
          domainText: 'boolean',
          valueText: 'true',
          changed: true,
          changeLabel: 'Modified',
        },
        {
          name: 'stage',
          domainText: 'enum ("draft" | "live")',
          valueText: '"draft"',
          changed: false,
          changeLabel: 'Unchanged',
        },
        {
          name: 'retries',
          domainText: 'int [0..3]',
          valueText: '0',
          changed: false,
          changeLabel: 'Unchanged',
        },
      ]);

      const html = renderStateTableHtml(SAMPLE_MODEL, state, ['reviewed']);
      expect(html).toContain('<table class="rc-state-table" aria-label="State variables for Sample Release Model">');
      expect(html).toContain('<th scope="col">Variable</th>');
      expect(html).toContain('<th scope="col">Domain</th>');
      expect(html).toContain('enum (&quot;draft&quot; | &quot;live&quot;)');
      expect(html).toContain('int [0..3]');
      expect(html).toContain('data-var="reviewed" data-changed="true"');
      expect(html).toContain('Modified');
      expect(html).toContain('Unchanged');
    });

    it('renders invariants and goal panel with PASS/VIOLATED and REACHED/NOT REACHED badges', () => {
      const view = buildInvariantsPanelView(SAMPLE_MODEL, ['inv_reviewed_before_live'], true);
      expect(view.status).toBe('VALID');
      expect(view.invariants[0]?.status).toBe('VIOLATED');
      expect(view.goal?.status).toBe('REACHED');

      const html = renderInvariantsPanelHtml(SAMPLE_MODEL, ['inv_reviewed_before_live'], true);
      expect(html).toContain('VIOLATED');
      expect(html).toContain('inv_reviewed_before_live');
      expect(html).toContain('stage != &quot;live&quot; || reviewed');
      expect(html).toContain('REACHED');
      expect(html).toContain('goal_live');

      const passHtml = renderInvariantsPanelHtml(SAMPLE_MODEL, [], false);
      expect(passHtml).toContain('PASS');
      expect(passHtml).toContain('NOT REACHED');

      const unevaluatedView = buildInvariantsPanelView(SAMPLE_MODEL, []);
      expect(unevaluatedView.goal?.reached).toBeNull();
      expect(unevaluatedView.goal?.status).toBe('NOT EVALUATED');

      const unevaluatedHtml = renderInvariantsPanelHtml(SAMPLE_MODEL, []);
      expect(unevaluatedHtml).toContain('data-status="not-evaluated"');
      expect(unevaluatedHtml).toContain('NOT EVALUATED');
      expect(unevaluatedHtml).not.toContain('NOT REACHED');
    });

    it('renders replay timeline controls, aria-current="step", diffs, and enabled transitions', () => {
      const init = createTraceReplaySession(SAMPLE_MODEL, ['promote_live']);
      expect(init.ok).toBe(true);
      if (!init.ok) return;

      const atStartHtml = renderReplayTimelineHtml(init.session);
      expect(atStartHtml).toContain('<button type="button" data-action="reset" disabled>Reset</button>');
      expect(atStartHtml).toContain('<button type="button" data-action="step-back" disabled>Previous step</button>');
      expect(atStartHtml).toContain('Step 0 of 1');
      expect(atStartHtml).toContain('<button type="button" data-action="step-forward">Next step</button>');
      expect(atStartHtml).toContain('data-step-index="0" aria-current="step"');
      expect(atStartHtml).toContain('<code>&quot;draft&quot;</code> -&gt; <code>&quot;live&quot;</code>');
      expect(atStartHtml).toContain('ENABLED');
      expect(atStartHtml).toContain('!reviewed');

      const jumped = jumpReplayToStep(init.session, 1);
      expect(jumped.ok).toBe(true);
      if (!jumped.ok) return;

      const atEndHtml = renderReplayTimelineHtml(jumped.session);
      expect(atEndHtml).toContain('<button type="button" data-action="reset">Reset</button>');
      expect(atEndHtml).toContain('<button type="button" data-action="step-back">Previous step</button>');
      expect(atEndHtml).toContain('Step 1 of 1');
      expect(atEndHtml).toContain('<button type="button" data-action="step-forward" disabled>Next step</button>');
      expect(atEndHtml).toContain('data-step-index="1" data-rule-id="promote_live" aria-current="step"');
      expect(atEndHtml).toContain('DISABLED');
    });

    it('renders assumptions panel and validation errors alert', () => {
      const assumptionsHtml = renderAssumptionsPanelHtml(BASE_ASSUMPTIONS);
      expect(assumptionsHtml).toContain('Verification scope:');
      expect(assumptionsHtml).toContain('execution');
      expect(assumptionsHtml).toContain('Rules execute atomically against discrete state.');
      expect(assumptionsHtml).toContain('Concurrent writes or hardware faults.');

      const errors: readonly ValidationError[] = [
        { code: 'INVALID_GUARD', path: 'rules[0].guard', message: 'Guard must be boolean.' },
      ];
      const errorsHtml = renderValidationErrorsHtml(errors);
      expect(errorsHtml).toContain('role="alert"');
      expect(errorsHtml).toContain('INVALID_GUARD');
      expect(errorsHtml).toContain('rules[0].guard');
      expect(errorsHtml).toContain('Guard must be boolean.');
    });
  });

  describe('XSS HTML-escaping safety', () => {
    it('escapes script tags and attribute breakout payloads across all renderers', () => {
      const xss = `<script>alert("xss")</script>" onmouseover="alert('x')`;
      const xssModel: TransitionSystemModel = {
        id: `id-${xss}`,
        name: `Model ${xss}`,
        schema: {
          mode: { kind: 'enum', values: [xss, 'safe'] },
        },
        initialState: { mode: xss },
        rules: [
          {
            id: `rule-${xss}`,
            label: `Rule ${xss}`,
            guard: { op: 'eq', left: { op: 'var', name: 'mode' }, right: { op: 'lit', value: xss } },
            updates: [{ var: 'mode', value: { op: 'lit', value: 'safe' } }],
          },
        ],
        invariants: [
          {
            id: `inv-${xss}`,
            label: `Inv ${xss}`,
            holds: { op: 'eq', left: { op: 'var', name: 'mode' }, right: { op: 'lit', value: 'safe' } },
          },
        ],
        goal: {
          id: `goal-${xss}`,
          label: `Goal ${xss}`,
          reached: { op: 'eq', left: { op: 'var', name: 'mode' }, right: { op: 'lit', value: 'safe' } },
        },
        assumptions: [
          {
            id: `assump-${xss}`,
            category: `cat-${xss}`,
            statement: `Stmt ${xss}`,
            notModeled: `NotModeled ${xss}`,
          },
        ],
      };

      const sessionRes = createTraceReplaySession(xssModel, [`rule-${xss}`]);
      expect(sessionRes.ok).toBe(true);
      if (!sessionRes.ok) return;

      const xssErrors: readonly ValidationError[] = [
        { code: `ERR_${xss}`, path: `path.${xss}`, message: `Msg ${xss}` },
      ];
      const xssVerdict: VerifyResult = {
        status: 'VIOLATED',
        trace: sessionRes.session.steps,
        terminalState: sessionRes.session.currentState,
        violatedInvariantIds: [`inv-${xss}`],
        stats: BASE_STATS,
        assumptions: xssModel.assumptions,
      };

      const outputs = [
        renderVerdictSummaryHtml(xssVerdict),
        renderVerdictSummaryHtml({ status: 'INVALID', errors: xssErrors }),
        renderStateTableHtml(xssModel, xssModel.initialState, ['mode']),
        renderInvariantsPanelHtml(xssModel, [`inv-${xss}`], false),
        renderReplayTimelineHtml(sessionRes.session),
        renderAssumptionsPanelHtml(xssModel.assumptions),
        renderValidationErrorsHtml(xssErrors),
      ];

      for (const html of outputs) {
        expect(html).not.toContain('<script>');
        expect(html).not.toContain('</script>');
        expect(html).not.toContain('" onmouseover="');
        expect(html).toContain('&lt;script&gt;');
      }
    });
  });

  describe('untrusted input, getter isolation, and prototype pollution safety', () => {
    it('never throws or invokes getters on malformed or Proxy-trapped inputs across builders and renderers', () => {
      let statsGetterCalled = false;
      const verdictWithGetterStats = {
        status: 'VERIFIED',
        assumptions: BASE_ASSUMPTIONS,
      };
      Object.defineProperty(verdictWithGetterStats, 'stats', {
        enumerable: true,
        get() {
          statsGetterCalled = true;
          throw new Error('stats getter must not execute');
        },
      });

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

      const getterView = buildVerdictSummaryView(verdictWithGetterStats as never);
      expect(getterView.status).toBe('INVALID');
      expect(statsGetterCalled).toBe(false);

      const getterHtml = renderVerdictSummaryHtml(verdictWithGetterStats as never);
      expect(getterHtml).toContain('data-status="INVALID"');
      expect(statsGetterCalled).toBe(false);

      expect(buildVerdictSummaryView(null as never).status).toBe('INVALID');
      expect(buildVerdictSummaryView(throwingProxy as never).status).toBe('INVALID');
      expect(renderVerdictSummaryHtml(throwingProxy as never)).toContain('data-status="INVALID"');

      expect(buildStateTableView(throwingProxy as never, {} as never).rows).toEqual([]);
      expect(renderStateTableHtml(throwingProxy as never, throwingProxy as never)).toContain('rc-state-table');

      expect(buildInvariantsPanelView(throwingProxy as never, []).invariants).toEqual([]);
      expect(renderInvariantsPanelHtml(throwingProxy as never, throwingProxy as never)).toContain('rc-invariants');

      expect(renderReplayTimelineHtml(throwingProxy as never)).toContain('data-status="invalid"');
      expect(renderAssumptionsPanelHtml(throwingProxy as never)).toContain('Invalid modeling assumptions');
      expect(renderValidationErrorsHtml(throwingProxy as never)).toContain('Invalid validation error list');

      expect(escapeHtml(null as never)).toBe('');

      // Crafted timeline session with inconsistent coordinates or non-primitive snapshot values
      const init = createTraceReplaySession(SAMPLE_MODEL, ['promote_live']);
      expect(init.ok).toBe(true);
      if (init.ok) {
        const badCoords = {
          ...init.session,
          cursor: -5,
          totalSteps: 999,
        } as unknown as Parameters<typeof renderReplayTimelineHtml>[0];
        expect(renderReplayTimelineHtml(badCoords)).toContain('data-status="invalid"');

        const badCanFlags = {
          ...init.session,
          canStepBack: true,
        } as unknown as Parameters<typeof renderReplayTimelineHtml>[0];
        expect(renderReplayTimelineHtml(badCanFlags)).toContain('data-status="invalid"');

        const nonPrimitiveStep = {
          ...init.session,
          steps: [
            {
              ruleId: 'promote_live',
              stateBefore: { reviewed: false, stage: { nested: true }, retries: 0 },
              stateAfter: { reviewed: false, stage: 'live', retries: 0 },
              changedVars: ['stage'],
            },
          ],
        } as unknown as Parameters<typeof renderReplayTimelineHtml>[0];
        const timelineHtml = renderReplayTimelineHtml(nonPrimitiveStep);
        expect(timelineHtml).toContain('&lt;invalid&gt;');
        expect(timelineHtml).not.toContain('&lt;missing&gt;');
      }
    });

    it('ignores inherited Object.prototype properties such as goalReachable and goal', () => {
      Object.defineProperty(Object.prototype, 'goalReachable', {
        value: false,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(Object.prototype, 'goal', {
        value: {
          id: 'polluted-goal',
          label: 'Polluted goal',
          reached: { op: 'lit', value: true },
        },
        configurable: true,
        writable: true,
      });

      try {
        const verifiedWithoutOwnGoal: VerifyResult = {
          status: 'VERIFIED',
          stats: BASE_STATS,
          assumptions: BASE_ASSUMPTIONS,
        };
        const view = buildVerdictSummaryView(verifiedWithoutOwnGoal);
        expect(view.vacuousGoalWarning).toBe(false);
        expect(view.badge).toBe('VERIFIED');
        expect(Object.hasOwn(view, 'goalReachable')).toBe(false);

        const html = renderVerdictSummaryHtml(verifiedWithoutOwnGoal);
        expect(html).not.toContain('data-vacuous-goal="true"');
        expect(html).not.toContain('Goal reachable: No');

        const modelWithoutOwnGoal: TransitionSystemModel = {
          id: 'no-goal',
          name: 'No Goal Model',
          schema: SAMPLE_MODEL.schema,
          initialState: SAMPLE_MODEL.initialState,
          rules: SAMPLE_MODEL.rules,
          invariants: SAMPLE_MODEL.invariants,
          assumptions: SAMPLE_MODEL.assumptions,
        };
        const invView = buildInvariantsPanelView(modelWithoutOwnGoal, []);
        expect(invView.status).toBe('VALID');
        expect(Object.hasOwn(invView, 'goal')).toBe(false);
        expect(renderInvariantsPanelHtml(modelWithoutOwnGoal, [])).not.toContain('polluted-goal');
      } finally {
        delete (Object.prototype as Record<string, unknown>)['goalReachable'];
        delete (Object.prototype as Record<string, unknown>)['goal'];
      }
    });

    it('rejects malformed violatedInvariantIds, goalReached, model.goal, and changedVars without fabricating PASS/Unchanged', () => {
      let called = false;
      const evil: string[] = [];
      Object.defineProperty(evil, 0, {
        enumerable: true,
        get() {
          called = true;
          return 'inv_reviewed_before_live';
        },
      });

      const evilView = buildInvariantsPanelView(SAMPLE_MODEL, evil);
      expect(called).toBe(false);
      expect(evilView.status).toBe('INVALID');
      expect(evilView.invariants).toEqual([]);
      expect(evilView.error).toBeDefined();

      const evilHtml = renderInvariantsPanelHtml(SAMPLE_MODEL, evil);
      expect(called).toBe(false);
      expect(evilHtml).toContain('role="alert"');
      expect(evilHtml).toContain('data-status="invalid"');
      expect(evilHtml).not.toContain('PASS');
      expect(evilHtml).not.toContain('data-status="pass"');

      const sparse: string[] = [];
      sparse[1] = 'inv_reviewed_before_live';
      const throwingProxy = new Proxy([], {
        getOwnPropertyDescriptor() {
          throw new Error('trap exploded');
        },
      });

      for (const badViolated of [null, [123], sparse, throwingProxy]) {
        const view = buildInvariantsPanelView(SAMPLE_MODEL, badViolated as never);
        expect(view.status).toBe('INVALID');
        expect(view.invariants).toEqual([]);
        const html = renderInvariantsPanelHtml(SAMPLE_MODEL, badViolated as never);
        expect(html).toContain('role="alert"');
        expect(html).toContain('data-status="invalid"');
        expect(html).not.toContain('PASS');
      }

      // Accessor model.goal
      let goalGetterCalled = false;
      const modelWithAccessorGoal = { ...SAMPLE_MODEL };
      Object.defineProperty(modelWithAccessorGoal, 'goal', {
        enumerable: true,
        get() {
          goalGetterCalled = true;
          return SAMPLE_MODEL.goal;
        },
      });
      const accGoalView = buildInvariantsPanelView(modelWithAccessorGoal as never, []);
      expect(goalGetterCalled).toBe(false);
      expect(accGoalView.status).toBe('INVALID');
      expect(renderInvariantsPanelHtml(modelWithAccessorGoal as never, [])).toContain('data-status="invalid"');

      // Non-boolean goalReached
      const badGoalReachedView = buildInvariantsPanelView(SAMPLE_MODEL, [], 'yes' as never);
      expect(badGoalReachedView.status).toBe('INVALID');
      expect(renderInvariantsPanelHtml(SAMPLE_MODEL, [], 'yes' as never)).toContain('data-status="invalid"');

      // Invalid changedVars on buildStateTableView returns emptyFallback instead of all Unchanged
      const badChangedView = buildStateTableView(
        SAMPLE_MODEL,
        SAMPLE_MODEL.initialState,
        [123] as never,
      );
      expect(badChangedView.modelId).toBe('<invalid>');
      expect(badChangedView.rows).toEqual([]);
    });

    it('enforces partial-exploration goalReachable semantics on INCONCLUSIVE and VIOLATED verdicts', () => {
      const baseViolated = {
        status: 'VIOLATED' as const,
        trace: [
          {
            ruleId: 'promote_live',
            stateBefore: { reviewed: false, stage: 'draft', retries: 0 },
            stateAfter: { reviewed: false, stage: 'live', retries: 0 },
            changedVars: ['stage'],
          },
        ],
        terminalState: { reviewed: false, stage: 'live', retries: 0 },
        violatedInvariantIds: ['inv_reviewed_before_live'],
        stats: BASE_STATS,
        assumptions: BASE_ASSUMPTIONS,
      };
      const baseInconclusive = {
        status: 'INCONCLUSIVE' as const,
        reason: 'MAX_STATES' as const,
        completedDepth: 3,
        frontierRemaining: 9,
        stats: BASE_STATS,
        assumptions: BASE_ASSUMPTIONS,
      };

      // goalReachable: false rejected on both VIOLATED and INCONCLUSIVE
      for (const bad of [
        { ...baseViolated, goalReachable: false },
        { ...baseInconclusive, goalReachable: false },
      ]) {
        const view = buildVerdictSummaryView(bad as never);
        expect(view.status).toBe('INVALID');
        const html = renderVerdictSummaryHtml(bad as never);
        expect(html).toContain('data-status="INVALID"');
        expect(html).not.toContain('Goal reachable: No');
      }

      // goalReachable omitted preserves undecided reachability
      for (const undecided of [baseViolated, baseInconclusive]) {
        const view = buildVerdictSummaryView(undecided);
        expect(view.status).toBe(undecided.status);
        expect(Object.hasOwn(view, 'goalReachable')).toBe(false);
        const html = renderVerdictSummaryHtml(undecided);
        expect(html).not.toContain('Goal reachable: Yes');
        expect(html).not.toContain('Goal reachable: No');
      }

      // goalReachable: true renders Goal reachable: Yes
      for (const reached of [
        { ...baseViolated, goalReachable: true as const },
        { ...baseInconclusive, goalReachable: true as const },
      ]) {
        const view = buildVerdictSummaryView(reached);
        expect(view.status).toBe(reached.status);
        expect(view.goalReachable).toBe(true);
        const html = renderVerdictSummaryHtml(reached);
        expect(html).toContain('Goal reachable: Yes');
      }
    });

    it('rejects malformed, null, and nested-accessor expressions in invariants, goals, schema definitions, and rule guards', () => {
      // Null goal.reached expression
      const nullGoalReachedModel = {
        ...SAMPLE_MODEL,
        goal: { id: 'g', label: 'Goal', reached: null },
      } as unknown as TransitionSystemModel;

      const nullGoalView = buildInvariantsPanelView(nullGoalReachedModel, [], true);
      expect(nullGoalView.status).toBe('INVALID');
      expect(nullGoalView.invariants).toEqual([]);
      expect(nullGoalView.goal).toBeUndefined();

      const nullGoalHtml = renderInvariantsPanelHtml(nullGoalReachedModel, [], true);
      expect(nullGoalHtml).toContain('role="alert"');
      expect(nullGoalHtml).toContain('data-status="invalid"');
      expect(nullGoalHtml).not.toContain('PASS');
      expect(nullGoalHtml).not.toContain('data-status="pass"');
      expect(nullGoalHtml).not.toContain('REACHED');

      // Malformed and nested-accessor goal.reached expressions
      let goalExprGetterCalls = 0;
      const notAccessorExpr: Record<string, unknown> = { op: 'not' };
      Object.defineProperty(notAccessorExpr, 'arg', {
        enumerable: true,
        get() {
          goalExprGetterCalls += 1;
          return { op: 'lit', value: true };
        },
      });
      const nestedAndAccessorExpr = { op: 'and', args: [notAccessorExpr] };

      for (const badExpr of [{ op: 'bogus' }, notAccessorExpr, nestedAndAccessorExpr]) {
        const badGoalModel = {
          ...SAMPLE_MODEL,
          goal: { id: 'g', label: 'Goal', reached: badExpr },
        } as unknown as TransitionSystemModel;

        const view = buildInvariantsPanelView(badGoalModel, [], true);
        expect(view.status).toBe('INVALID');
        expect(view.invariants).toEqual([]);
        expect(view.goal).toBeUndefined();

        const html = renderInvariantsPanelHtml(badGoalModel, [], true);
        expect(html).toContain('role="alert"');
        expect(html).toContain('data-status="invalid"');
        expect(html).not.toContain('PASS');
        expect(html).not.toContain('data-status="pass"');
        expect(html).not.toContain('REACHED');
      }
      expect(goalExprGetterCalls).toBe(0);

      // Sibling: malformed, null, and nested-accessor invariant holds expressions
      let invExprGetterCalls = 0;
      const invAccessorExpr: Record<string, unknown> = { op: 'not' };
      Object.defineProperty(invAccessorExpr, 'arg', {
        enumerable: true,
        get() {
          invExprGetterCalls += 1;
          return { op: 'lit', value: true };
        },
      });
      const invNestedAccessorExpr = { op: 'and', args: [invAccessorExpr] };

      for (const badHolds of [null, { op: 'bogus' }, invAccessorExpr, invNestedAccessorExpr]) {
        const badInvModel = {
          ...SAMPLE_MODEL,
          invariants: [
            {
              id: 'inv_bad',
              label: 'Invalid invariant',
              holds: badHolds,
            },
          ],
        } as unknown as TransitionSystemModel;

        const view = buildInvariantsPanelView(badInvModel, [], true);
        expect(view.status).toBe('INVALID');
        expect(view.invariants).toEqual([]);
        expect(view.goal).toBeUndefined();

        const html = renderInvariantsPanelHtml(badInvModel, [], true);
        expect(html).toContain('role="alert"');
        expect(html).toContain('data-status="invalid"');
        expect(html).not.toContain('PASS');
        expect(html).not.toContain('data-status="pass"');
      }
      expect(invExprGetterCalls).toBe(0);

      // Sibling: malformed and accessor schema VarDef in buildStateTableView
      let varDefGetterCalls = 0;
      const accessorVarDef: Record<string, unknown> = { kind: 'enum' };
      Object.defineProperty(accessorVarDef, 'values', {
        enumerable: true,
        get() {
          varDefGetterCalls += 1;
          return ['draft', 'live'];
        },
      });

      for (const badVarDef of [null, { kind: 'bogus' }, { kind: 'int', min: 5, max: 1 }, accessorVarDef]) {
        const badSchemaModel = {
          ...SAMPLE_MODEL,
          schema: {
            ...SAMPLE_MODEL.schema,
            stage: badVarDef,
          },
        } as unknown as TransitionSystemModel;

        const tableView = buildStateTableView(badSchemaModel, SAMPLE_MODEL.initialState, ['stage']);
        expect(tableView.modelId).toBe('<invalid>');
        expect(tableView.modelName).toBe('<invalid>');
        expect(tableView.rows).toEqual([]);
        expect(tableView.changedCount).toBe(0);
      }
      expect(varDefGetterCalls).toBe(0);

      // Sibling: malformed, null, and nested-accessor rule guard in renderReplayTimelineHtml
      const init = createTraceReplaySession(SAMPLE_MODEL, ['promote_live']);
      expect(init.ok).toBe(true);
      if (init.ok) {
        let guardGetterCalls = 0;
        const guardAccessorExpr: Record<string, unknown> = { op: 'not' };
        Object.defineProperty(guardAccessorExpr, 'arg', {
          enumerable: true,
          get() {
            guardGetterCalls += 1;
            return { op: 'lit', value: true };
          },
        });
        const guardNestedAccessorExpr = { op: 'and', args: [guardAccessorExpr] };

        for (const badGuard of [null, { op: 'bogus' }, guardAccessorExpr, guardNestedAccessorExpr]) {
          const badRuleSession = {
            ...init.session,
            model: {
              ...SAMPLE_MODEL,
              rules: [
                {
                  ...SAMPLE_MODEL.rules[0]!,
                  guard: badGuard,
                },
                ...SAMPLE_MODEL.rules.slice(1),
              ],
            },
          } as unknown as Parameters<typeof renderReplayTimelineHtml>[0];

          const html = renderReplayTimelineHtml(badRuleSession);
          expect(html).toContain('role="alert"');
          expect(html).toContain('data-status="invalid"');
        }
        expect(guardGetterCalls).toBe(0);
      }
    });
  });
});
