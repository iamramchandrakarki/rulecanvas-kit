import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as fc from 'fast-check';
import {
  getEnabledTransitions,
  getInitialState,
  replayTrace,
  stepModel,
  validateModel,
  verifyModel,
  type BoolExpr,
  type StateSchema,
  type StateSnapshot,
  type TransitionSystemModel,
  type ValueExpr,
} from '@rulecanvas/core';
import {
  applyManualStep,
  createManualSimulationSession,
  createVerdictReplaySession,
  jumpReplayToStep,
  stepReplayBackward,
  stepReplayForward,
} from '@rulecanvas/ui';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_MODEL_JSON_LIMITS } from '@rulecanvas/workbench/model-json';
import { isCanonicalVacuousLockoutModel } from '../src/model-inspector.js';
import { App } from '../src/App.js';
import { AirlockSchematic } from '../src/components/AirlockSchematic.js';
import { ComparisonPanel } from '../src/components/ComparisonPanel.js';
import { BoolExprEditor, type LiftedIntDraftStore } from '../src/components/ExprEditor.js';
import { InterlockRuleEditor, matchesDraftPrefix } from '../src/components/InterlockRuleEditor.js';
import {
  VerificationWorkbenchPane,
  type VerifiedSnapshot,
} from '../src/components/VerificationWorkbenchPane.js';
import {
  DEFAULT_VERIFY_OPTIONS,
  INTERLOCK_SIM_PRESETS,
  VerifyWorkerClient,
  applyPrincipledInterlockRepair,
  bsl3AirlockBrokenModel,
  bsl3AirlockFixedModel,
  bsl3AirlockVacuousModel,
  createSynchronousWorkerFactory,
  explainRuleGuards,
  exportModelToJson,
  getInterlockPresetDescriptor,
  importModelFromJson,
  indexModelDiagnostics,
  isPrincipledOpenInnerDoorGuard,
  isRepairableInterlockModel,
  isWebWorkerSupported,
  loadInterlockPresetModel,
  parseStrictIntegerDraft,
  runInterlockPresetComparison,
  tryExportModelJson,
  type GuardClauseExplanation,
  type VerifyWorkerRequest,
  type WorkerLike,
} from '../src/index.js';

function enumerateReachableStates(model: TransitionSystemModel): readonly StateSnapshot[] {
  const init = getInitialState(model);
  expect(init.ok).toBe(true);
  if (!init.ok) return [];

  const serialize = (s: StateSnapshot): string =>
    Object.keys(model.schema)
      .map((k) => `${k}=${JSON.stringify(s[k])}`)
      .join('|');

  const visited = new Set<string>([serialize(init.state)]);
  const queue: StateSnapshot[] = [init.state];
  const out: StateSnapshot[] = [init.state];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const enabled = getEnabledTransitions(model, current);
    expect(enabled.ok).toBe(true);
    if (!enabled.ok) continue;

    for (const ruleId of enabled.enabledRuleIds) {
      const stepped = stepModel(model, current, ruleId);
      expect(stepped.ok).toBe(true);
      if (!stepped.ok) continue;
      const key = serialize(stepped.step.stateAfter);
      if (!visited.has(key)) {
        visited.add(key);
        queue.push(stepped.step.stateAfter);
        out.push(stepped.step.stateAfter);
      }
    }
  }
  return out;
}

function assertClauseTreeConsistency(clause: GuardClauseExplanation): void {
  expect(clause.satisfied).toBe(clause.actualValue === clause.expectedValue);
  if (!clause.satisfied && clause.children.length === 0) {
    expect(clause.summary.length).toBeGreaterThan(0);
  }
  for (const child of clause.children) {
    assertClauseTreeConsistency(child);
  }
}

function assertBidirectionalLabels(html: string): void {
  const labelForMatches = [...html.matchAll(/<label\b[^>]*\bfor="([^"]+)"/g)].map((m) => m[1]!);
  const forSet = new Set<string>(labelForMatches);
  // Form controls plus select-only combobox triggers (WorkbenchSelect renders a button)
  const controlMatches = [
    ...html.matchAll(/<(input|select|textarea)\b[^>]*>|<button\b[^>]*\brole="combobox"[^>]*>/g),
  ];
  const idsSeen = new Set<string>();

  for (const match of controlMatches) {
    const tag = match[0];
    const idMatch = tag.match(/\bid="([^"]+)"/);
    expect(idMatch).not.toBeNull();
    const id = idMatch![1]!;
    expect(idsSeen.has(id)).toBe(false);
    idsSeen.add(id);
    expect(forSet.has(id)).toBe(true);
  }
}

const PBT_SCHEMA: StateSchema = {
  flag: { kind: 'boolean' },
  mode: { kind: 'enum', values: ['idle', 'armed', 'tripped'] },
  level: { kind: 'int', min: -3, max: 3 },
};

function arbIntValueExpr(depth: number): fc.Arbitrary<ValueExpr> {
  const leaf: fc.Arbitrary<ValueExpr> = fc.oneof(
    fc.integer({ min: -3, max: 3 }).map((value): ValueExpr => ({ op: 'lit', value })),
    fc.constant<ValueExpr>({ op: 'var', name: 'level' }),
  );
  if (depth <= 0) return leaf;
  return fc.oneof(
    leaf,
    fc
      .tuple(fc.constantFrom<'add' | 'sub'>('add', 'sub'), arbIntValueExpr(depth - 1), arbIntValueExpr(depth - 1))
      .map(([op, left, right]): ValueExpr => ({ op, left, right })),
  );
}

function arbBoolExpr(depth: number): fc.Arbitrary<BoolExpr> {
  const enumValExpr: fc.Arbitrary<ValueExpr> = fc.oneof(
    fc.constantFrom('idle', 'armed', 'tripped').map((value): ValueExpr => ({ op: 'lit', value })),
    fc.constant<ValueExpr>({ op: 'var', name: 'mode' }),
  );
  const boolValExpr: fc.Arbitrary<ValueExpr> = fc.oneof(
    fc.boolean().map((value): ValueExpr => ({ op: 'lit', value })),
    fc.constant<ValueExpr>({ op: 'var', name: 'flag' }),
  );
  const leaf: fc.Arbitrary<BoolExpr> = fc.oneof(
    fc.boolean().map((value): BoolExpr => ({ op: 'lit', value })),
    fc.constant<BoolExpr>({ op: 'var', name: 'flag' }),
    fc
      .tuple(fc.constantFrom<'eq' | 'neq'>('eq', 'neq'), boolValExpr, boolValExpr)
      .map(([op, left, right]): BoolExpr => ({ op, left, right })),
    fc
      .tuple(fc.constantFrom<'eq' | 'neq'>('eq', 'neq'), enumValExpr, enumValExpr)
      .map(([op, left, right]): BoolExpr => ({ op, left, right })),
    fc
      .tuple(
        fc.constantFrom<'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte'>('eq', 'neq', 'lt', 'lte', 'gt', 'gte'),
        arbIntValueExpr(1),
        arbIntValueExpr(1),
      )
      .map(([op, left, right]): BoolExpr => ({ op, left, right })),
    fc
      .tuple(
        enumValExpr,
        fc.array(fc.constantFrom('idle', 'armed', 'tripped'), { minLength: 0, maxLength: 3 }),
      )
      .map(([expr, values]): BoolExpr => ({ op: 'in', expr, values })),
    fc
      .tuple(
        arbIntValueExpr(1),
        fc.array(fc.integer({ min: -3, max: 3 }), { minLength: 0, maxLength: 3 }),
      )
      .map(([expr, values]): BoolExpr => ({ op: 'in', expr, values })),
  );

  if (depth <= 0) return leaf;
  return fc.oneof(
    leaf,
    arbBoolExpr(depth - 1).map((arg): BoolExpr => ({ op: 'not', arg })),
    fc
      .tuple(
        fc.constantFrom<'and' | 'or'>('and', 'or'),
        fc.array(arbBoolExpr(depth - 1), { minLength: 1, maxLength: 3 }),
      )
      .map(([op, args]): BoolExpr => ({ op, args })),
  );
}

describe('InterlockSim workbench architecture, semantics, security, and UI', () => {
  it('agrees with @rulecanvas/core across every reachable state of broken, fixed, and vacuous presets', () => {
    const brokenStates = enumerateReachableStates(bsl3AirlockBrokenModel);
    const fixedStates = enumerateReachableStates(bsl3AirlockFixedModel);
    const vacuousStates = enumerateReachableStates(bsl3AirlockVacuousModel);

    expect(brokenStates.length).toBe(35);
    expect(fixedStates.length).toBe(29);
    expect(vacuousStates.length).toBe(23);

    for (const model of [bsl3AirlockBrokenModel, bsl3AirlockFixedModel, bsl3AirlockVacuousModel]) {
      const states = enumerateReachableStates(model);
      for (const state of states) {
        const core = getEnabledTransitions(model, state);
        const explained = explainRuleGuards(model, state);
        expect(core.ok).toBe(true);
        expect(explained.ok).toBe(true);
        if (!core.ok || !explained.ok) return;

        expect(explained.enabledRuleIds).toEqual(core.enabledRuleIds);
        expect(explained.rules.length).toBe(model.rules.length);

        for (let i = 0; i < explained.rules.length; i += 1) {
          const ruleExp = explained.rules[i]!;
          const coreRule = core.transitions[i]!;
          expect(ruleExp.ruleId).toBe(coreRule.ruleId);
          expect(ruleExp.enabled).toBe(coreRule.enabled);
          expect(ruleExp.rootClause).not.toBeNull();
          expect(ruleExp.rootClause?.actualValue).toBe(coreRule.enabled);
          assertClauseTreeConsistency(ruleExp.rootClause!);
          if (coreRule.enabled) {
            expect(ruleExp.blockingReasons).toEqual([]);
          } else {
            expect(ruleExp.blockingReasons.length).toBeGreaterThan(0);
          }
        }
      }
    }
  });

  it('explains all Boolean/Value operators accurately including non-short-circuiting and/or/not/in/add/sub and -0', () => {
    const customModel: TransitionSystemModel = {
      id: 'explainer-coverage',
      name: 'Explainer Coverage',
      schema: PBT_SCHEMA,
      initialState: { flag: false, mode: 'idle', level: 0 },
      rules: [
        {
          id: 'multi_block',
          label: 'Requires flag and negative level',
          guard: {
            op: 'and',
            args: [
              { op: 'var', name: 'flag' },
              { op: 'lt', left: { op: 'add', left: { op: 'var', name: 'level' }, right: { op: 'lit', value: 1 } }, right: { op: 'lit', value: 0 } },
              { op: 'in', expr: { op: 'var', name: 'mode' }, values: ['armed', 'tripped'] },
            ],
          },
          updates: [],
        },
        {
          id: 'negated_disjunction',
          label: 'De Morgan negated or',
          guard: {
            op: 'not',
            arg: {
              op: 'or',
              args: [
                { op: 'eq', left: { op: 'var', name: 'mode' }, right: { op: 'lit', value: 'armed' } },
                { op: 'gte', left: { op: 'sub', left: { op: 'var', name: 'level' }, right: { op: 'lit', value: -0 } }, right: { op: 'lit', value: 2 } },
              ],
            },
          },
          updates: [],
        },
        {
          id: 'empty_in_set',
          label: 'Empty in literal set',
          guard: { op: 'in', expr: { op: 'var', name: 'mode' }, values: [] },
          updates: [],
        },
        {
          id: 'vacuous_false',
          label: 'Literal false',
          guard: { op: 'lit', value: false },
          updates: [],
        },
      ],
      invariants: [
        { id: 'inv_ok', label: 'Always true', holds: { op: 'lit', value: true } },
      ],
      assumptions: [
        { id: 'a1', category: 'scope', statement: 'Test scope', notModeled: 'Hardware' },
      ],
    };

    const explainedIdle = explainRuleGuards(customModel, {
      flag: false,
      mode: 'idle',
      level: 0,
    });
    expect(explainedIdle.ok).toBe(true);
    if (!explainedIdle.ok) return;
    expect(explainedIdle.rules[0]!.enabled).toBe(false);
    expect(explainedIdle.rules[0]!.blockingReasons.length).toBe(3);

    const explained = explainRuleGuards(customModel, {
      flag: false,
      mode: 'armed',
      level: 0,
    });
    expect(explained.ok).toBe(true);
    if (!explained.ok) return;

    const multiBlock = explained.rules[0]!;
    expect(multiBlock.enabled).toBe(false);
    expect(multiBlock.blockingReasons.length).toBe(2);

    const negDisj = explained.rules[1]!;
    expect(negDisj.enabled).toBe(false);
    expect(negDisj.blockingReasons).toHaveLength(1);
    expect(negDisj.blockingReasons[0]).toContain('armed');

    expect(explained.rules[2]!.blockingReasons[0]).toContain('requires one of []');
    expect(explained.rules[3]!.blockingReasons[0]).toContain('permanently disabled (false)');

    // Nested literal false inside or(false, flag) must NOT falsely claim rule is permanently disabled
    const nestedFalseModel: TransitionSystemModel = {
      ...customModel,
      rules: [
        {
          id: 'nested_lit_rule',
          label: 'Nested literal false in disjunction',
          guard: { op: 'or', args: [{ op: 'lit', value: false }, { op: 'var', name: 'flag' }] },
          updates: [],
        },
      ],
    };
    const nestedExpl = explainRuleGuards(nestedFalseModel, { flag: false, mode: 'idle', level: 0 });
    expect(nestedExpl.ok).toBe(true);
    if (nestedExpl.ok) {
      const reason = nestedExpl.rules[0]!.blockingReasons[0]!;
      expect(reason).not.toContain('permanently disabled');
      expect(reason).toContain('Literal clause is false');
    }

    // Non-enumerable model.rules.map = undefined cannot throw after getEnabledTransitions succeeds
    const shadowedRules = [...nestedFalseModel.rules];
    Object.defineProperty(shadowedRules, 'map', { value: undefined, enumerable: false });
    const shadowedExpl = explainRuleGuards(
      { ...nestedFalseModel, rules: shadowedRules },
      { flag: false, mode: 'idle', level: 0 },
    );
    expect(shadowedExpl.ok).toBe(true);
    if (shadowedExpl.ok) {
      expect(shadowedExpl.rules[0]!.enabled).toBe(false);
    }

    const invalidModelResult = explainRuleGuards(
      {
        ...customModel,
        rules: [{ id: 'bad_empty_or', label: 'Empty or', guard: { op: 'or', args: [] }, updates: [] }],
      },
      { flag: false, mode: 'armed', level: 0 },
    );
    expect(invalidModelResult.ok).toBe(false);

    const invalidStateResult = explainRuleGuards(customModel, {
      flag: false,
      mode: 'nonexistent',
      level: 0,
    });
    expect(invalidStateResult.ok).toBe(false);
  });

  it('satisfies fast-check property parity with @rulecanvas/core across arbitrary nested AST guards', () => {
    const seedEnv = process.env['FC_SEED'];
    const seed = seedEnv !== undefined && Number.isFinite(Number(seedEnv)) ? Number(seedEnv) : 20261125;

    fc.assert(
      fc.property(
        fc.boolean(),
        fc.constantFrom('idle', 'armed', 'tripped'),
        fc.integer({ min: -3, max: 3 }),
        arbBoolExpr(2),
        (flag, mode, level, guard) => {
          const model: TransitionSystemModel = {
            id: 'pbt-guard-parity',
            name: 'PBT Guard Parity',
            schema: PBT_SCHEMA,
            initialState: { flag, mode, level },
            rules: [{ id: 'test_rule', label: 'PBT rule', guard, updates: [] }],
            invariants: [{ id: 'inv_t', label: 'True', holds: { op: 'lit', value: true } }],
            assumptions: [{ id: 'a', category: 'scope', statement: 'PBT', notModeled: 'Physical' }],
          };
          expect(validateModel(model)).toEqual([]);

          const snapshot: StateSnapshot = { flag, mode, level };
          const core = getEnabledTransitions(model, snapshot);
          const exp = explainRuleGuards(model, snapshot);
          expect(core.ok).toBe(true);
          expect(exp.ok).toBe(true);
          if (!core.ok || !exp.ok) return;

          const rCore = core.transitions[0]!;
          const rExp = exp.rules[0]!;
          expect(rExp.enabled).toBe(rCore.enabled);
          expect(rExp.rootClause).not.toBeNull();
          expect(rExp.rootClause?.actualValue).toBe(rCore.enabled);
          assertClauseTreeConsistency(rExp.rootClause!);
          expect(rExp.blockingReasons.length > 0).toBe(!rCore.enabled);
        },
      ),
      { seed, numRuns: 100 },
    );
  });

  it('verifies broken 6-step violation, replay stepping, manual branching, vacuous detection, and principled repair', () => {
    const broken = loadInterlockPresetModel('broken');
    const brokenVerdict = verifyModel(broken, DEFAULT_VERIFY_OPTIONS);
    expect(brokenVerdict.status).toBe('VIOLATED');
    if (brokenVerdict.status !== 'VIOLATED') return;
    expect(brokenVerdict.trace).toHaveLength(6);

    const sessionRes = createVerdictReplaySession(broken, brokenVerdict, { startAt: 'terminal' });
    expect(sessionRes.ok).toBe(true);
    if (!sessionRes.ok) return;

    expect(sessionRes.session.cursor).toBe(6);
    expect(sessionRes.session.violatedInvariantIds).toEqual(['inv_containment_seal']);

    const backRes = stepReplayBackward(sessionRes.session);
    expect(backRes.ok).toBe(true);
    if (!backRes.ok) return;
    expect(backRes.session.cursor).toBe(5);
    expect(backRes.session.violatedInvariantIds).toEqual([]);

    const step4 = jumpReplayToStep(backRes.session, 4);
    expect(step4.ok).toBe(true);
    if (!step4.ok) return;

    // Manual branch from closed airlock with occupied operator: restore negative pressure, purge, open inner door
    const branch1 = applyManualStep(step4.session, 'establish_negative_pressure');
    expect(branch1.ok).toBe(true);
    if (!branch1.ok) return;
    const branch2 = applyManualStep(branch1.session, 'run_air_purge');
    expect(branch2.ok).toBe(true);
    if (!branch2.ok) return;
    const branch3 = applyManualStep(branch2.session, 'open_inner_door');
    expect(branch3.ok).toBe(true);
    if (!branch3.ok) return;
    expect(branch3.session.mode).toBe('manual');
    expect(branch3.session.violatedInvariantIds).toEqual([]);
    expect(branch3.session.goalReached).toBe(true);

    // Principled repair transforms broken -> VERIFIED with goalReachable: true
    expect(isPrincipledOpenInnerDoorGuard(broken)).toBe(false);
    const repaired = applyPrincipledInterlockRepair(broken);
    expect(isPrincipledOpenInnerDoorGuard(repaired)).toBe(true);
    const repairedVerdict = verifyModel(repaired, DEFAULT_VERIFY_OPTIONS);
    expect(repairedVerdict.status).toBe('VERIFIED');
    if (repairedVerdict.status === 'VERIFIED') {
      expect(repairedVerdict.stats.statesExplored).toBe(29);
      expect(repairedVerdict.goalReachable).toBe(true);
    }

    // Vacuous preset preserves invariants while flagging goalReachable === false
    const vacuous = loadInterlockPresetModel('vacuous');
    const vacuousVerdict = verifyModel(vacuous, DEFAULT_VERIFY_OPTIONS);
    expect(vacuousVerdict.status).toBe('VERIFIED');
    if (vacuousVerdict.status === 'VERIFIED') {
      expect(vacuousVerdict.stats.statesExplored).toBe(23);
      expect(vacuousVerdict.goalReachable).toBe(false);
    }

    // Check forward nav from step 0 of broken replay
    const startSession = createVerdictReplaySession(broken, brokenVerdict, { startAt: 'initial' });
    expect(startSession.ok).toBe(true);
    if (!startSession.ok) return;
    const fwd = stepReplayForward(startSession.session);
    expect(fwd.ok).toBe(true);
    if (fwd.ok) {
      expect(fwd.session.cursor).toBe(1);
    }

    // Manual simulation session replay parity
    const manualInit = createManualSimulationSession(repaired);
    expect(manualInit.ok).toBe(true);
    if (manualInit.ok) {
      const m1 = applyManualStep(manualInit.session, 'equalize_pressure');
      expect(m1.ok).toBe(true);
    }
    const coreSafeTrace = replayTrace(repaired, [
      'equalize_pressure',
      'open_outer_door',
      'enter_airlock',
      'close_outer_door',
      'establish_negative_pressure',
      'run_air_purge',
      'open_inner_door',
    ]);
    expect(coreSafeTrace.ok).toBe(true);
    if (coreSafeTrace.ok) {
      expect(coreSafeTrace.goalReached).toBe(true);
    }
  });

  it('computes 3-preset comparison matrix under default and tight INCONCLUSIVE bounds', () => {
    expect(INTERLOCK_SIM_PRESETS).toHaveLength(3);
    expect(getInterlockPresetDescriptor('vacuous').shortLabel).toBe('Vacuous Lockout');

    const rows = runInterlockPresetComparison(DEFAULT_VERIFY_OPTIONS);
    expect(rows).toHaveLength(3);
    expect(rows[0]?.summary.status).toBe('VIOLATED');
    expect(rows[0]?.traceLength).toBe(6);
    expect(rows[1]?.summary.status).toBe('VERIFIED');
    expect(rows[1]?.goalReachable).toBe(true);
    expect(rows[2]?.summary.status).toBe('VERIFIED');
    expect(rows[2]?.goalReachable).toBe(false);

    const smallRows = runInterlockPresetComparison({ maxStates: 10_000, maxDepth: 2 });
    expect(smallRows[0]?.summary.status).toBe('INCONCLUSIVE');
    expect(smallRows[1]?.summary.status).toBe('INCONCLUSIVE');
    expect(smallRows[2]?.summary.status).toBe('INCONCLUSIVE');
  });

  it('supports worker cancellation, stale reply suppression, error recovery, and main-thread fallback', async () => {
    const model = loadInterlockPresetModel('fixed');
    const syncFactory = createSynchronousWorkerFactory();
    const syncClient = new VerifyWorkerClient({ workerFactory: syncFactory });
    const syncOutcome = await syncClient.verify(model, DEFAULT_VERIFY_OPTIONS);
    expect(syncOutcome.status).toBe('completed');
    if (syncOutcome.status === 'completed') {
      expect(syncOutcome.result.status).toBe('VERIFIED');
    }
    syncClient.dispose();

    // Deferred manual worker testing cancellation and stale responses
    let terminatedCount = 0;
    const workers: WorkerLike[] = [];
    const requests: VerifyWorkerRequest[] = [];
    const deferredClient = new VerifyWorkerClient({
      restartOnSupersede: true,
      workerFactory: () => {
        const w: WorkerLike = {
          onmessage: null,
          onerror: null,
          postMessage(msg) {
            requests.push(msg);
          },
          terminate() {
            terminatedCount += 1;
          },
        };
        workers.push(w);
        return w;
      },
    });

    const p1 = deferredClient.verify(model, DEFAULT_VERIFY_OPTIONS);
    const p2 = deferredClient.verify(loadInterlockPresetModel('broken'), DEFAULT_VERIFY_OPTIONS);

    const res1 = await p1;
    expect(res1.status).toBe('cancelled');
    expect(terminatedCount).toBe(1);

    // Late message from superseded worker 1 is ignored; valid response on worker 2 completes
    workers[0]?.onmessage?.({
      data: {
        type: 'result',
        requestId: requests[0]!.requestId,
        result: verifyModel(model, DEFAULT_VERIFY_OPTIONS),
      },
    });
    expect(deferredClient.isRunning()).toBe(true);

    workers[1]?.onmessage?.({
      data: {
        type: 'result',
        requestId: requests[1]!.requestId,
        result: verifyModel(loadInterlockPresetModel('broken'), DEFAULT_VERIFY_OPTIONS),
      },
    });
    const res2 = await p2;
    expect(res2.status).toBe('completed');
    if (res2.status === 'completed') {
      expect(res2.result.status).toBe('VIOLATED');
    }

    // Worker runtime error recovery
    const p3 = deferredClient.verify(model, DEFAULT_VERIFY_OPTIONS);
    workers[1]?.onerror?.({ message: 'Simulated worker failure' });
    const res3 = await p3;
    expect(res3.status).toBe('error');
    if (res3.status === 'error') {
      expect(res3.message).toContain('Simulated worker failure');
    }
    deferredClient.dispose();

    // Main-thread fallback check in Node (no Worker global)
    expect(isWebWorkerSupported()).toBe(false);
    const fallbackClient = new VerifyWorkerClient();
    expect(fallbackClient.getExecutionMode()).toBe('main-thread');
    const fallbackOutcome = await fallbackClient.verify(model, DEFAULT_VERIFY_OPTIONS);
    expect(fallbackOutcome.status).toBe('completed');
    if (fallbackOutcome.status === 'completed') {
      expect(fallbackOutcome.executionMode).toBe('main-thread');
      expect(fallbackOutcome.result.status).toBe('VERIFIED');
    }
    fallbackClient.dispose();

    // Asynchronous Worker startup failure is reported accurately as WORKER_ERROR (no silent fallback)
    const origWorker = (globalThis as { Worker?: unknown }).Worker;
    class AsyncFailingWorker {
      public onmessage: ((ev: { readonly data: unknown }) => void) | null = null;
      public onerror: ((ev: { readonly message?: string }) => void) | null = null;
      public postMessage(): void {
        queueMicrotask(() => {
          this.onerror?.({ message: 'Failed to load worker module script' });
        });
      }
      public terminate(): void {}
    }
    (globalThis as { Worker?: unknown }).Worker = AsyncFailingWorker;
    try {
      const startupFailureClient = new VerifyWorkerClient();
      expect(startupFailureClient.getExecutionMode()).toBe('worker');
      const failed = await startupFailureClient.verify(model, DEFAULT_VERIFY_OPTIONS);
      expect(failed.status).toBe('error');
      if (failed.status === 'error') {
        expect(failed.message).toContain('Failed to load worker module script');
      }
      startupFailureClient.dispose();
    } finally {
      if (origWorker === undefined) {
        delete (globalThis as { Worker?: unknown }).Worker;
      } else {
        (globalThis as { Worker?: unknown }).Worker = origWorker;
      }
    }

    // Worker construction failure (constructor throws) still falls back to the main thread cleanly
    class ThrowingWorker {
      constructor() {
        throw new Error('Worker constructor unavailable');
      }
    }
    (globalThis as { Worker?: unknown }).Worker = ThrowingWorker;
    try {
      const constructorFallbackClient = new VerifyWorkerClient();
      const recovered = await constructorFallbackClient.verify(model, DEFAULT_VERIFY_OPTIONS);
      expect(recovered.status).toBe('completed');
      if (recovered.status === 'completed') {
        expect(recovered.executionMode).toBe('main-thread');
        expect(recovered.result.status).toBe('VERIFIED');
      }
      expect(constructorFallbackClient.getExecutionMode()).toBe('main-thread');
      constructorFallbackClient.dispose();
    } finally {
      if (origWorker === undefined) {
        delete (globalThis as { Worker?: unknown }).Worker;
      } else {
        (globalThis as { Worker?: unknown }).Worker = origWorker;
      }
    }
  });

  it('rejects non-integer JSON before JSON.parse, handles malformed/hostile payloads safely, and round-trips depth-32 ASTs without crashing export', () => {
    const exportedJson = exportModelToJson(bsl3AirlockBrokenModel);
    const roundTripped = importModelFromJson(exportedJson);
    expect(roundTripped.ok).toBe(true);

    const parseSpy = vi.spyOn(JSON, 'parse');
    try {
      const decResult = importModelFromJson(
        exportedJson.replace('"purgeCycles": 0', '"purgeCycles": 1.5'),
      );
      expect(decResult.ok).toBe(false);
      if (!decResult.ok) {
        expect(decResult.errors[0]?.code).toBe('NON_INTEGER_JSON_NUMBER');
      }

      const sciResult = importModelFromJson(
        exportedJson.replace('"max": 2', '"max": 1e3'),
      );
      expect(sciResult.ok).toBe(false);
      if (!sciResult.ok) {
        expect(sciResult.errors[0]?.code).toBe('NON_INTEGER_JSON_NUMBER');
      }

      const unsafeResult = importModelFromJson(
        exportedJson.replace('"max": 2', '"max": 9007199254740993'),
      );
      expect(unsafeResult.ok).toBe(false);
      if (!unsafeResult.ok) {
        expect(unsafeResult.errors[0]?.code).toBe('UNSAFE_INTEGER_JSON_NUMBER');
      }

      expect(parseSpy).not.toHaveBeenCalled();
    } finally {
      parseSpy.mockRestore();
    }

    const malformed = importModelFromJson('{ "id": "broken", ');
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) {
      expect(malformed.errors[0]?.code).toBe('JSON_PARSE_ERROR');
    }

    // Malformed JSON syntax with decimal/unsafe int tokens reports JSON_PARSE_ERROR (never masked)
    const malformedDecimal = importModelFromJson('{"x":1.5,}');
    expect(malformedDecimal.ok).toBe(false);
    if (!malformedDecimal.ok) {
      expect(malformedDecimal.errors[0]?.code).toBe('JSON_PARSE_ERROR');
    }
    const malformedUnsafe = importModelFromJson('{"x":[9007199254740993}');
    expect(malformedUnsafe.ok).toBe(false);
    if (!malformedUnsafe.ok) {
      expect(malformedUnsafe.errors[0]?.code).toBe('JSON_PARSE_ERROR');
    }

    // Export rejects extra properties / symbols / reserved keys identically to import
    const rulesWithExtraProp = [...bsl3AirlockFixedModel.rules];
    (rulesWithExtraProp as unknown as Record<string, unknown>)['extraProp'] = 123;
    expect(
      tryExportModelJson({ ...bsl3AirlockFixedModel, rules: rulesWithExtraProp }).ok,
    ).toBe(false);

    const rulesWithSymbol = [...bsl3AirlockFixedModel.rules];
    Object.defineProperty(rulesWithSymbol, Symbol('tag'), { value: true, enumerable: true });
    expect(tryExportModelJson({ ...bsl3AirlockFixedModel, rules: rulesWithSymbol }).ok).toBe(
      false,
    );

    const schemaWithReserved = { ...bsl3AirlockFixedModel.schema };
    Object.defineProperty(schemaWithReserved, '__proto__', {
      value: { kind: 'boolean' },
      enumerable: true,
      configurable: true,
    });
    expect(
      tryExportModelJson({ ...bsl3AirlockFixedModel, schema: schemaWithReserved }).ok,
    ).toBe(false);

    // Zero-invariant drafts reject non-enumerable object props, extra array props, and symbols (never silently stripped)
    const zeroInvDraft: TransitionSystemModel = {
      ...bsl3AirlockFixedModel,
      invariants: [],
    };
    const zeroInvExported = tryExportModelJson(zeroInvDraft);
    expect(zeroInvExported.ok).toBe(true);

    const zeroInvWithNonEnumObjProp = { ...zeroInvDraft };
    Object.defineProperty(zeroInvWithNonEnumObjProp, 'hiddenMeta', {
      value: 'should-reject',
      enumerable: false,
      configurable: true,
    });
    expect(tryExportModelJson(zeroInvWithNonEnumObjProp).ok).toBe(false);

    const zeroInvRuleWithNonEnumProp = { ...zeroInvDraft.rules[0]! };
    Object.defineProperty(zeroInvRuleWithNonEnumProp, 'hiddenRuleMeta', {
      value: 1,
      enumerable: false,
      configurable: true,
    });
    expect(
      tryExportModelJson({
        ...zeroInvDraft,
        rules: [zeroInvRuleWithNonEnumProp, ...zeroInvDraft.rules.slice(1)],
      }).ok,
    ).toBe(false);

    const zeroInvRulesWithExtraEnumProp = [...zeroInvDraft.rules];
    (zeroInvRulesWithExtraEnumProp as unknown as Record<string, unknown>)['extraProp'] = 123;
    expect(
      tryExportModelJson({ ...zeroInvDraft, rules: zeroInvRulesWithExtraEnumProp }).ok,
    ).toBe(false);

    const zeroInvRulesWithNonEnumExtraProp = [...zeroInvDraft.rules];
    Object.defineProperty(zeroInvRulesWithNonEnumExtraProp, 'hiddenExtra', {
      value: 'nope',
      enumerable: false,
      configurable: true,
    });
    expect(
      tryExportModelJson({ ...zeroInvDraft, rules: zeroInvRulesWithNonEnumExtraProp }).ok,
    ).toBe(false);

    const zeroInvRulesWithSymbol = [...zeroInvDraft.rules];
    Object.defineProperty(zeroInvRulesWithSymbol, Symbol('tag'), {
      value: true,
      enumerable: true,
    });
    expect(tryExportModelJson({ ...zeroInvDraft, rules: zeroInvRulesWithSymbol }).ok).toBe(false);

    const zeroInvObjWithSymbol: Record<PropertyKey, unknown> = { ...zeroInvDraft };
    zeroInvObjWithSymbol[Symbol('meta')] = true;
    expect(tryExportModelJson(zeroInvObjWithSymbol as unknown as TransitionSystemModel).ok).toBe(
      false,
    );

    // Compact JSON fallback keeps near-limit exports re-importable, and > 512KB triggers JSON_EXPORT_ERROR
    const largePadding = 'A'.repeat(498_000);
    const compactableModel: TransitionSystemModel = {
      ...bsl3AirlockFixedModel,
      assumptions: [
        {
          id: 'large_scope',
          category: 'scope',
          statement: largePadding,
          notModeled: 'Physical dynamics.',
        },
        ...bsl3AirlockFixedModel.assumptions.slice(1),
      ],
    };
    const compactExport = tryExportModelJson(compactableModel);
    expect(compactExport.ok).toBe(true);
    if (compactExport.ok) {
      expect(compactExport.text.length).toBeLessThanOrEqual(512_000);
      expect(importModelFromJson(compactExport.text).ok).toBe(true);
    }

    const oversizedExportModel: TransitionSystemModel = {
      ...bsl3AirlockFixedModel,
      assumptions: [
        {
          id: 'too_large_scope',
          category: 'scope',
          statement: 'B'.repeat(520_000),
          notModeled: 'Physical dynamics.',
        },
      ],
    };
    const oversizedExport = tryExportModelJson(oversizedExportModel);
    expect(oversizedExport.ok).toBe(false);
    if (!oversizedExport.ok) {
      expect(oversizedExport.error.code).toBe('JSON_EXPORT_ERROR');
    }

    // Reject reserved __proto__ property, accessors, and Proxy traps
    const protoPayload = '{"id":"x","name":"x","schema":{},"initialState":{},"__proto__":{"polluted":true}}';
    const protoResult = importModelFromJson(protoPayload);
    expect(protoResult.ok).toBe(false);

    const hostileObj: Record<string, unknown> = { ...bsl3AirlockFixedModel };
    Object.defineProperty(hostileObj, 'extraGetter', {
      enumerable: true,
      get() {
        return 1;
      },
    });
    expect(importModelFromJson(hostileObj).ok).toBe(false);
    expect(tryExportModelJson(hostileObj as unknown as TransitionSystemModel).ok).toBe(false);

    const proxyHostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('blocked');
        },
      },
    );
    expect(importModelFromJson(proxyHostile).ok).toBe(false);
    expect(tryExportModelJson(proxyHostile as unknown as TransitionSystemModel).ok).toBe(false);

    // Depth-31 nested not() wraps inside MAX_AST_DEPTH = 32 cleanly and round-trips through export & import
    let depth31Guard: BoolExpr = { op: 'lit', value: true };
    for (let i = 0; i < 31; i += 1) {
      depth31Guard = { op: 'not', arg: depth31Guard };
    }
    const depth31Model: TransitionSystemModel = {
      ...bsl3AirlockFixedModel,
      rules: [
        { ...bsl3AirlockFixedModel.rules[0]!, guard: depth31Guard },
        ...bsl3AirlockFixedModel.rules.slice(1),
      ],
    };
    expect(validateModel(depth31Model)).toEqual([]);
    const depth31Exported = tryExportModelJson(depth31Model);
    expect(depth31Exported.ok).toBe(true);
    if (depth31Exported.ok) {
      const depth31Reimported = importModelFromJson(depth31Exported.text);
      expect(depth31Reimported.ok).toBe(true);
    }

    // Over-deep AST (66 levels > MAX_IMPORT_DEPTH=64) returns safe JSON_EXPORT_ERROR instead of throwing
    let depth66Guard: BoolExpr = { op: 'lit', value: true };
    for (let i = 0; i < 66; i += 1) {
      depth66Guard = { op: 'not', arg: depth66Guard };
    }
    const depth66Model: TransitionSystemModel = {
      ...bsl3AirlockFixedModel,
      rules: [
        { ...bsl3AirlockFixedModel.rules[0]!, guard: depth66Guard },
        ...bsl3AirlockFixedModel.rules.slice(1),
      ],
    };
    const overDeepExport = tryExportModelJson(depth66Model);
    expect(overDeepExport.ok).toBe(false);
    if (!overDeepExport.ok) {
      expect(overDeepExport.error.code).toBe('JSON_EXPORT_ERROR');
    }

    // Strict integer parser & rule draft pruning prefix matching
    expect(parseStrictIntegerDraft('100')).toEqual({ ok: true, value: 100 });
    expect(parseStrictIntegerDraft('-0')).toEqual({ ok: true, value: 0 });
    expect(parseStrictIntegerDraft('2.9').ok).toBe(false);
    expect(parseStrictIntegerDraft('1e4').ok).toBe(false);
    expect(matchesDraftPrefix('rule:open_inner_door.guard.args.clause-5.right.value', 'rule')).toBe(
      true,
    );
    expect(
      matchesDraftPrefix(
        'rule:open_inner_door.guard.args.clause-5.right.value',
        'rule:open_inner_door.guard',
      ),
    ).toBe(true);
  });

  it('renders accessible schematic, operator console, disclaimers, 4 unified tabs, and bidirectional form labels', () => {
    const brokenHtml = renderToStaticMarkup(createElement(App, { initialVariant: 'broken' }));
    expect(brokenHtml).toContain('InterlockSim');
    expect(brokenHtml).toContain('Not IEC 61508 / SIL Certified');
    expect(brokenHtml).toContain('continuous pressure decay');
    expect(brokenHtml).toContain('sensor faults');
    expect(brokenHtml).toContain('mechanical seal failure');
    expect(brokenHtml).toContain('inv_containment_seal');
    expect(brokenHtml).toContain('VIOLATED');
    expect(brokenHtml).toContain('Step 6 of 6');
    expect(brokenHtml).toContain('outerDoor');
    expect(brokenHtml).toContain('innerDoor');
    expect(brokenHtml).toContain('pressure');
    expect(brokenHtml).toContain('uvSterilizer');
    expect(brokenHtml).toContain('occupied');
    expect(brokenHtml).toContain('purgeCycles');
    expect(brokenHtml).toContain('maintenanceOverride');

    // All 4 unified role="tabpanel" sections remain mounted with tabIndex="0"
    expect((brokenHtml.match(/role="tabpanel"/g) ?? []).length).toBe(4);
    expect((brokenHtml.match(/role="tabpanel"[^>]*tabindex="0"/g) ?? []).length).toBe(4);
    expect(brokenHtml).toContain('id="is-tab-trace-guard"');
    expect(brokenHtml).toContain('id="is-tab-state-invariants"');
    expect(brokenHtml).toContain('id="is-tab-assumptions"');
    expect(brokenHtml).toContain('id="is-tab-json"');

    // Incompatible Boolean-only model shows UNAVAILABLE schematic, UNEVALUATED PREVIEW, and no bogus Guided Repair
    const booleanOnlyModel: TransitionSystemModel = {
      id: 'bool-only',
      name: 'Boolean Gate Model',
      schema: { ready: { kind: 'boolean' } },
      initialState: { ready: false },
      rules: [
        {
          id: 'open_inner_door',
          label: 'Unrelated boolean toggle',
          guard: { op: 'lit', value: true },
          updates: [{ var: 'ready', value: { op: 'lit', value: true } }],
        },
      ],
      invariants: [
        { id: 'inv_custom', label: 'Ready remains false', holds: { op: 'not', arg: { op: 'var', name: 'ready' } } },
      ],
      assumptions: [
        { id: 'asm_1', category: 'scope', statement: 'Bool test', notModeled: 'Hardware' },
      ],
    };
    expect(isRepairableInterlockModel(booleanOnlyModel)).toBe(false);
    expect(applyPrincipledInterlockRepair(booleanOnlyModel)).toBe(booleanOnlyModel);

    const previewSchematicHtml = renderToStaticMarkup(
      createElement(AirlockSchematic, {
        schema: booleanOnlyModel.schema,
        state: booleanOnlyModel.initialState,
        changedVars: [],
        violatedInvariantIds: [],
        evaluatedInvariantIds: [],
        isEvaluated: false,
        goalReached: undefined,
        stepNumber: 0,
        modeLabel: 'Initial State Preview (Unverified)',
      }),
    );
    expect(previewSchematicHtml).toContain('UNEVALUATED PREVIEW');
    expect(previewSchematicHtml).toContain('UNAVAILABLE');
    expect(previewSchematicHtml).not.toContain('SEAL &amp; UV SAFE');

    const safeNonAirlockSchematic = renderToStaticMarkup(
      createElement(AirlockSchematic, {
        schema: booleanOnlyModel.schema,
        state: booleanOnlyModel.initialState,
        changedVars: [],
        violatedInvariantIds: [],
        evaluatedInvariantIds: ['inv_custom'],
        isEvaluated: true,
        goalReached: undefined,
        stepNumber: 0,
        modeLabel: 'Manual Simulation',
      }),
    );
    expect(safeNonAirlockSchematic).toContain('INVARIANTS HOLD AT STEP 0 (1)');
    expect(safeNonAirlockSchematic).not.toContain('SEAL &amp; UV SAFE');

    const incompatEditorHtml = renderToStaticMarkup(
      createElement(InterlockRuleEditor, {
        model: booleanOnlyModel,
        diagnostics: indexModelDiagnostics([]),
        onChangeModel: () => {},
        onImportModel: () => {},
      }),
    );
    expect(incompatEditorHtml).not.toContain('Guided Repair Available');

    // Unreachable goal with goal.reached = false reports general goal unreachability (not open_inner_door)
    const impossibleGoalModel: TransitionSystemModel = {
      ...bsl3AirlockFixedModel,
      goal: { id: 'goal_impossible', label: 'Never holds', reached: { op: 'lit', value: false } },
    };
    const impossibleGoalVerdict = verifyModel(impossibleGoalModel, DEFAULT_VERIFY_OPTIONS);
    const impossibleGoalHtml = renderToStaticMarkup(
      createElement(VerificationWorkbenchPane, {
        model: impossibleGoalModel,
        isRunning: false,
        runningExecutionMode: 'main-thread',
        isStale: false,
        workerError: null,
        cancelledNotice: null,
        optionErrors: [],
        editorDraftErrors: [],
        modelErrors: [],
        verifiedSnapshot: {
          model: impossibleGoalModel,
          modelLabel: 'Impossible Goal',
          options: DEFAULT_VERIFY_OPTIONS,
          result: impossibleGoalVerdict,
          executionMode: 'main-thread',
        },
        replaySession: null,
        onCancelRun: () => {},
        onVerifyNow: () => {},
        onJumpToStep: () => {},
      }),
    );
    expect(impossibleGoalHtml).toContain('Vacuous Goal Reachability Warning');
    expect(impossibleGoalHtml).toContain('goal_impossible');
    expect(impossibleGoalHtml).not.toContain('open_inner_door');

    // Fixed & vacuous variants render honest disclaimers & verdicts
    const fixedHtml = renderToStaticMarkup(createElement(App, { initialVariant: 'fixed' }));
    expect(fixedHtml).toContain('VERIFIED');
    expect(fixedHtml).toContain('Goal reachable: Yes');

    const vacuousHtml = renderToStaticMarkup(createElement(App, { initialVariant: 'vacuous' }));
    expect(vacuousHtml).toContain('VERIFIED (GOAL UNREACHABLE)');
    expect(vacuousHtml).toContain('Guard is permanently disabled (false)');

    const compareHtml = renderToStaticMarkup(
      createElement(App, { initialVariant: 'broken', initialShowComparison: true }),
    );
    expect(compareHtml).toContain('Preset Comparison Matrix');
    assertBidirectionalLabels(compareHtml);

    // Bidirectional label check on Guard Inspector + ExprEditor + ComparisonPanel + Workbench
    const editedModel: TransitionSystemModel = {
      ...bsl3AirlockFixedModel,
      assumptions: [
        {
          id: 'edited_scope',
          category: 'scope',
          statement: 'Pending edited assumption statement.',
          notModeled: 'Pending omitted failure mode.',
        },
      ],
    };
    const fixedResult = verifyModel(bsl3AirlockFixedModel, DEFAULT_VERIFY_OPTIONS);
    const snapshot: VerifiedSnapshot = {
      model: bsl3AirlockFixedModel,
      modelLabel: 'Principled Fix',
      options: DEFAULT_VERIFY_OPTIONS,
      result: fixedResult,
      executionMode: 'main-thread',
    };
    const stalePaneHtml = renderToStaticMarkup(
      createElement(VerificationWorkbenchPane, {
        model: editedModel,
        isRunning: false,
        runningExecutionMode: 'main-thread',
        isStale: true,
        workerError: null,
        cancelledNotice: null,
        optionErrors: [],
        editorDraftErrors: [],
        modelErrors: [],
        verifiedSnapshot: snapshot,
        replaySession: null,
        onCancelRun: () => {},
        onVerifyNow: () => {},
        onJumpToStep: () => {},
      }),
    );
    expect(stalePaneHtml).toContain('OUTDATED: VERIFIED');
    expect(stalePaneHtml).toContain('Pending Edited Assumptions (Unverified)');

    const editorHtml = renderToStaticMarkup(
      createElement(InterlockRuleEditor, {
        model: editedModel,
        diagnostics: indexModelDiagnostics([]),
        onChangeModel: () => {},
        onImportModel: () => {},
      }),
    );
    expect((editorHtml.match(/role="tabpanel"/g) ?? []).length).toBe(3);
    assertBidirectionalLabels(editorHtml);

    const draftStore: LiftedIntDraftStore = {
      draftValues: {},
      draftErrors: {},
      onDraftChange: () => {},
      onPruneDrafts: () => {},
    };
    const exprHtml = renderToStaticMarkup(
      createElement(BoolExprEditor, {
        value: {
          op: 'and',
          args: [
            { op: 'gte', left: { op: 'var', name: 'purgeCycles' }, right: { op: 'lit', value: 1 } },
            {
              op: 'in',
              expr: { op: 'var', name: 'pressure' },
              values: ['negative', 'equalized'],
            },
          ],
        },
        schema: bsl3AirlockFixedModel.schema,
        fieldPath: 'test.guard',
        intDraftStore: draftStore,
        onChange: () => {},
      }),
    );
    assertBidirectionalLabels(exprHtml);

    const comparisonPanelHtml = renderToStaticMarkup(
      createElement(ComparisonPanel, {
        rows: runInterlockPresetComparison(DEFAULT_VERIFY_OPTIONS),
        bounds: DEFAULT_VERIFY_OPTIONS,
        boundsHasErrors: true,
        activeVariant: 'broken',
        onLoadPreset: () => {},
        onClose: () => {},
      }),
    );
    expect(comparisonPanelHtml).toContain('Current Bounds Inputs Are Invalid');
  });

  it('prevents misleading preset labels, budget skew, non-enumerable elements, deep scan confusion, and poisoned descriptor escapes (Round 2 fixes)', () => {
    // R2-1: Custom Boolean model borrowing canonical invariant & goal IDs with literal-true predicates
    const spoofedIdsModel: TransitionSystemModel = {
      id: 'spoofed-ids',
      name: 'Spoofed IDs Boolean Model',
      schema: { ready: { kind: 'boolean' } },
      initialState: { ready: true },
      rules: [
        {
          id: 'open_inner_door',
          label: 'Close instead of open',
          guard: { op: 'lit', value: true },
          updates: [{ var: 'ready', value: { op: 'lit', value: false } }],
        },
      ],
      invariants: [
        { id: 'inv_containment_seal', label: 'Fake seal', holds: { op: 'lit', value: true } },
        { id: 'inv_uv_exposure_lock', label: 'Fake uv', holds: { op: 'lit', value: true } },
      ],
      goal: { id: 'goal_safe_lab_entry', label: 'Fake entry', reached: { op: 'lit', value: true } },
      assumptions: [
        { id: 'asm_custom', category: 'scope', statement: 'Bool test', notModeled: 'Hardware' },
      ],
    };
    const spoofedSchematicHtml = renderToStaticMarkup(
      createElement(AirlockSchematic, {
        schema: spoofedIdsModel.schema,
        state: spoofedIdsModel.initialState,
        changedVars: [],
        violatedInvariantIds: [],
        evaluatedInvariantIds: spoofedIdsModel.invariants.map((i) => i.id),
        invariants: spoofedIdsModel.invariants,
        goal: spoofedIdsModel.goal,
        isEvaluated: true,
        goalReached: true,
        stepNumber: 0,
        modeLabel: 'Trace Replay',
      }),
    );
    expect(spoofedSchematicHtml).toContain('INVARIANTS HOLD AT STEP 0 (2)');
    expect(spoofedSchematicHtml).not.toContain('SEAL &amp; UV SAFE');
    expect(spoofedSchematicHtml).toContain('GOAL AT STEP 0: REACHED (goal_safe_lab_entry)');
    expect(spoofedSchematicHtml).not.toContain('GOAL REACHED: LAB ENTRY');
    expect(spoofedSchematicHtml).toContain('UNAVAILABLE');

    // R2-2a: Export and import share identical value-occurrence visit budget accounting (56 rules x 60 clauses > 10,000 visits)
    const manyClauses: BoolExpr[] = Array.from({ length: 60 }, () => ({ op: 'lit' as const, value: true }));
    const highBudgetModel: TransitionSystemModel = {
      id: 'high-budget',
      name: 'High Budget Model',
      schema: { flag: { kind: 'boolean' } },
      initialState: { flag: true },
      rules: Array.from({ length: 56 }, (_, i) => ({
        id: `r_${i}`,
        label: `Rule ${i}`,
        guard: { op: 'and', args: manyClauses },
        updates: [{ var: 'flag', value: { op: 'lit', value: true } }],
      })),
      invariants: [
        { id: 'inv_flag', label: 'Flag true', holds: { op: 'var', name: 'flag' } },
      ],
      assumptions: [
        { id: 'asm_1', category: 'scope', statement: 'Budget check', notModeled: 'None' },
      ],
    };
    expect(validateModel(highBudgetModel)).toEqual([]);
    const highBudgetExport = tryExportModelJson(highBudgetModel);
    expect(highBudgetExport.ok).toBe(false);
    if (!highBudgetExport.ok) {
      expect(highBudgetExport.error.code).toBe('JSON_EXPORT_ERROR');
    }

    // 65-invariant model must NOT qualify for the zero-invariant draft export exception
    const tooManyInvariantsModel: TransitionSystemModel = {
      ...bsl3AirlockFixedModel,
      invariants: Array.from({ length: 65 }, (_, i) => ({
        id: `inv_${i}`,
        label: `Invariant ${i}`,
        holds: { op: 'lit', value: true },
      })),
    };
    const tooManyInvExport = tryExportModelJson(tooManyInvariantsModel);
    expect(tooManyInvExport.ok).toBe(false);
    if (!tooManyInvExport.ok) {
      expect(tooManyInvExport.error.code).toBe('JSON_EXPORT_ERROR');
    }

    // ~502 KB zero-invariant draft (exceeds 512 KB pretty, fits compact) must export cleanly via compact fallback
    const compactZeroInvDraft: TransitionSystemModel = {
      ...bsl3AirlockFixedModel,
      invariants: [],
      assumptions: [
        {
          id: 'asm_zero_compact',
          category: 'scope',
          statement: 'Z'.repeat(501_500),
          notModeled: 'Timing',
        },
      ],
    };
    expect(JSON.stringify(compactZeroInvDraft, null, 2).length).toBeGreaterThan(512_000);
    const zeroCompactExport = tryExportModelJson(compactZeroInvDraft);
    expect(zeroCompactExport.ok).toBe(true);
    if (zeroCompactExport.ok) {
      expect(zeroCompactExport.text.length).toBeLessThanOrEqual(512_000);
    }

    // Strict shared codec rejects duplicate keys instead of preserving last-value semantics
    const baselineJson = exportModelToJson(bsl3AirlockFixedModel);
    const dupNamePayload = baselineJson.replace(
      `"name": ${JSON.stringify(bsl3AirlockFixedModel.name)},`,
      `"name": "First Name",\n  "name": "Second Name",`,
    );
    const strictDupImport = importModelFromJson(dupNamePayload);
    expect(strictDupImport.ok).toBe(false);
    if (!strictDupImport.ok) {
      expect(strictDupImport.errors[0]?.code).toBe('DUPLICATE_JSON_KEY');
      expect(strictDupImport.errors[0]?.path).toBe('$');
    }

    // Any model whose export succeeds (near-budget 28 rules x 60 clauses) must re-import cleanly
    const reimportableModel: TransitionSystemModel = {
      ...highBudgetModel,
      rules: highBudgetModel.rules.slice(0, 28),
    };
    const okExport = tryExportModelJson(reimportableModel);
    expect(okExport.ok).toBe(true);
    if (okExport.ok) {
      expect(importModelFromJson(okExport.text).ok).toBe(true);
    }

    // R2-2b: Both import and export reject non-enumerable numeric array elements
    const nonEnumRules = bsl3AirlockFixedModel.rules.map((r) => ({ ...r }));
    const firstRule = nonEnumRules[0]!;
    Object.defineProperty(nonEnumRules, 0, {
      value: firstRule,
      enumerable: false,
      configurable: true,
      writable: true,
    });
    const modelWithNonEnumRule = {
      ...bsl3AirlockFixedModel,
      rules: nonEnumRules,
    } as TransitionSystemModel;
    expect(importModelFromJson(modelWithNonEnumRule).ok).toBe(false);
    expect(tryExportModelJson(modelWithNonEnumRule).ok).toBe(false);

    // R2-4: Closing or multi-variable open_inner_door rules are not eligible for guided repair
    const closingDoorModel: TransitionSystemModel = {
      ...bsl3AirlockBrokenModel,
      rules: bsl3AirlockBrokenModel.rules.map((rule) =>
        rule.id === 'open_inner_door'
          ? {
              ...rule,
              updates: [{ var: 'innerDoor', value: { op: 'lit', value: 'closed' } }],
            }
          : rule,
      ),
    };
    expect(validateModel(closingDoorModel)).toEqual([]);
    expect(isRepairableInterlockModel(closingDoorModel)).toBe(false);
    expect(applyPrincipledInterlockRepair(closingDoorModel)).toBe(closingDoorModel);

    // R2-5: Disabled open_inner_door + unrelated literal-false goal renders generic vacuity warning
    const customVacuousModel: TransitionSystemModel = {
      id: 'custom-vacuous',
      name: 'Custom Vacuous Model',
      schema: { ready: { kind: 'boolean' } },
      initialState: { ready: false },
      rules: [
        {
          id: 'open_inner_door',
          label: 'Disabled unrelated rule',
          guard: { op: 'lit', value: false },
          updates: [{ var: 'ready', value: { op: 'lit', value: true } }],
        },
      ],
      invariants: [
        { id: 'inv_ready', label: 'Not ready', holds: { op: 'not', arg: { op: 'var', name: 'ready' } } },
      ],
      goal: { id: 'goal_unrelated', label: 'Never reachable', reached: { op: 'lit', value: false } },
      assumptions: [
        { id: 'asm_1', category: 'scope', statement: 'Vacuous test', notModeled: 'Hardware' },
      ],
    };
    const customVacuousResult = verifyModel(customVacuousModel, DEFAULT_VERIFY_OPTIONS);
    expect(customVacuousResult.status).toBe('VERIFIED');
    const customVacuousHtml = renderToStaticMarkup(
      createElement(VerificationWorkbenchPane, {
        model: customVacuousModel,
        isRunning: false,
        runningExecutionMode: 'main-thread',
        isStale: false,
        workerError: null,
        cancelledNotice: null,
        optionErrors: [],
        editorDraftErrors: [],
        modelErrors: [],
        verifiedSnapshot: {
          model: customVacuousModel,
          modelLabel: 'Custom Vacuous Model',
          options: DEFAULT_VERIFY_OPTIONS,
          result: customVacuousResult,
          executionMode: 'main-thread',
        },
        replaySession: null,
        onCancelRun: () => {},
        onVerifyNow: () => {},
        onJumpToStep: () => {},
      }),
    );
    expect(customVacuousHtml).toContain('goal_unrelated');
    expect(customVacuousHtml).not.toContain('goal_safe_lab_entry');
    expect(customVacuousHtml).not.toContain('open_inner_door');

    // R2-5 (Round 3): Canonical vacuous lockout matches isCanonicalVacuousLockoutModel; custom alternate opener renders non-causal generic warning
    expect(isCanonicalVacuousLockoutModel(bsl3AirlockVacuousModel)).toBe(true);
    const brokenWithFalseOpen: TransitionSystemModel = {
      ...bsl3AirlockBrokenModel,
      rules: bsl3AirlockBrokenModel.rules.map((r) =>
        r.id === 'open_inner_door' ? { ...r, guard: { op: 'lit', value: false } } : r,
      ),
    };
    expect(isCanonicalVacuousLockoutModel(brokenWithFalseOpen)).toBe(true);

    const alternateOpenerVacuousModel: TransitionSystemModel = {
      ...bsl3AirlockVacuousModel,
      rules: bsl3AirlockVacuousModel.rules.map((r) => {
        if (r.id === 'enter_corridor_to_airlock') {
          return {
            ...r,
            id: 'alt_open_inner',
            label: 'Alternate inner door opener',
            guard: { op: 'lit', value: true },
            updates: [{ var: 'innerDoor', value: { op: 'lit', value: 'open' } }],
          };
        }
        if (r.id === 'run_air_purge') {
          return { ...r, guard: { op: 'lit', value: false } };
        }
        return r;
      }),
    };
    const altResult = verifyModel(alternateOpenerVacuousModel, DEFAULT_VERIFY_OPTIONS);
    expect(altResult.status).toBe('VERIFIED');
    if (altResult.status === 'VERIFIED') {
      expect(altResult.goalReachable).toBe(false);
    }
    expect(isCanonicalVacuousLockoutModel(alternateOpenerVacuousModel)).toBe(false);
    const altVacuousHtml = renderToStaticMarkup(
      createElement(VerificationWorkbenchPane, {
        model: alternateOpenerVacuousModel,
        isRunning: false,
        runningExecutionMode: 'main-thread',
        isStale: false,
        workerError: null,
        cancelledNotice: null,
        optionErrors: [],
        editorDraftErrors: [],
        modelErrors: [],
        verifiedSnapshot: {
          model: alternateOpenerVacuousModel,
          modelLabel: 'Alternate Opener Model',
          options: DEFAULT_VERIFY_OPTIONS,
          result: altResult,
          executionMode: 'main-thread',
        },
        replaySession: null,
        onCancelRun: () => {},
        onVerifyNow: () => {},
        onJumpToStep: () => {},
      }),
    );
    expect(altVacuousHtml).toContain('goal_safe_lab_entry');
    expect(altVacuousHtml).not.toContain('open_inner_door');

    // R2-7a: Valid JSON nested 257 levels returns IMPORT_COMPLEXITY_EXCEEDED (not JSON_PARSE_ERROR)
    expect(DEFAULT_MODEL_JSON_LIMITS.maxChars).toBe(512_000);
    expect(DEFAULT_MODEL_JSON_LIMITS.maxRawNesting).toBe(256);
    const nested257 = `${'['.repeat(257)}${']'.repeat(257)}`;
    const deepJsonResult = importModelFromJson(nested257);
    expect(deepJsonResult.ok).toBe(false);
    if (!deepJsonResult.ok) {
      expect(deepJsonResult.errors[0]?.code).toBe('IMPORT_COMPLEXITY_EXCEEDED');
    }

    // R2-7b: Throwing descriptor lookup on model.rules inside explainRuleGuards degrades safely
    let descriptorReads = 0;
    const baseRules = bsl3AirlockFixedModel.rules;
    const poisonedRules = new Proxy(baseRules, {
      getOwnPropertyDescriptor(target, prop) {
        if (prop === '0') {
          descriptorReads += 1;
          if (descriptorReads > 1) {
            throw new Error('poisoned rule index lookup');
          }
        }
        return Reflect.getOwnPropertyDescriptor(target, prop);
      },
    });
    const poisonedExplainModel = {
      ...bsl3AirlockFixedModel,
      rules: poisonedRules,
    } as TransitionSystemModel;
    const explained = explainRuleGuards(poisonedExplainModel, bsl3AirlockFixedModel.initialState);
    expect(explained.ok).toBe(true);
    if (explained.ok) {
      expect(explained.rules[0]?.guardText).toBe('<unavailable>');
    }

    // R1 #12: Deep expression rendering caps cumulative indentation beyond depth 6
    let deepNot: BoolExpr = { op: 'var', name: 'occupied' };
    for (let i = 0; i < 9; i += 1) {
      deepNot = { op: 'not', arg: deepNot };
    }
    const deepExprHtml = renderToStaticMarkup(
      createElement(BoolExprEditor, {
        value: deepNot,
        schema: bsl3AirlockFixedModel.schema,
        fieldPath: 'test.deep',
        intDraftStore: {
          draftValues: {},
          draftErrors: {},
          onDraftChange: () => {},
          onPruneDrafts: () => {},
        },
        onChange: () => {},
      }),
    );
    expect(deepExprHtml).toContain('data-depth-capped="true"');
  });

  it('enforces Option A isolation boundaries (zero imports from agent-gate) and styling hygiene', () => {
    const appDir = path.resolve(import.meta.dirname, '..');
    const tokensCss = readFileSync(path.join(appDir, 'src/styles/tokens.css'), 'utf8');
    expect(tokensCss).toContain('color-scheme: dark;');
    expect(tokensCss).toContain('--color-paper:');
    expect(tokensCss).toContain('--color-accent:');
    expect(tokensCss).toContain('--color-control-border:');
    expect(tokensCss).not.toMatch(/#fff\b|#ffffff\b|oklch\(100%\s+0\s+0\)|seed\s+[a-z0-9-]+|agent-gate/i);

    const filesToCheck = [
      'src/App.tsx',
      'src/comparison.ts',
      'src/guard-explainer.ts',
      'src/index.ts',
      'src/model-inspector.ts',
      'src/presets.ts',
      'src/verify-client.ts',
      'src/verify.worker.ts',
      'src/components/AirlockSchematic.tsx',
      'src/components/ComparisonPanel.tsx',
      'src/components/ExprEditor.tsx',
      'src/components/InterlockRuleEditor.tsx',
      'src/components/OperatorConsole.tsx',
      'src/components/StrictIntegerInput.tsx',
      'src/components/VerificationWorkbenchPane.tsx',
    ];
    for (const rel of filesToCheck) {
      const content = readFileSync(path.join(appDir, rel), 'utf8');
      expect(content).not.toMatch(/@rulecanvas\/agent-gate|apps\/agent-gate/);
    }
  });

  it('surfaces snapshot freshness on AirlockSchematic, removes ASCII/boolean leaks, and ships Light/Dark WOFF2 tokens', () => {
    const staleSchematicHtml = renderToStaticMarkup(
      createElement(AirlockSchematic, {
        schema: bsl3AirlockFixedModel.schema,
        state: bsl3AirlockFixedModel.initialState,
        changedVars: [],
        violatedInvariantIds: [],
        evaluatedInvariantIds: bsl3AirlockFixedModel.invariants.map((i) => i.id),
        invariants: bsl3AirlockFixedModel.invariants,
        goal: bsl3AirlockFixedModel.goal,
        isEvaluated: true,
        isStale: true,
        snapshotLabel: 'Principled Fix',
        goalReached: false,
        stepNumber: 0,
        modeLabel: 'Trace Replay',
      }),
    );
    expect(staleSchematicHtml).toContain('OUTDATED SNAPSHOT');
    expect(staleSchematicHtml).toContain('Outdated snapshot &quot;Principled Fix&quot; at Step 0');
    expect(staleSchematicHtml).not.toContain('Live vessel state');
    expect(staleSchematicHtml).toContain('INVARIANTS HOLD AT STEP 0');
    expect(staleSchematicHtml).toContain('GOAL AT STEP 0: NOT REACHED');
    expect(staleSchematicHtml).not.toContain('OCCUPIED (true)');
    expect(staleSchematicHtml).not.toContain('EMPTY (false)');
    expect(staleSchematicHtml).not.toContain('[||]');
    expect(staleSchematicHtml).toContain('is-schematic-compact');

    const appHtml = renderToStaticMarkup(createElement(App, { initialVariant: 'broken' }));
    expect(appHtml).toContain('Inspect guard clauses for');
    expect(appHtml).toContain('Candidate Guard Repair Available for open_inner_door');
    expect(appHtml).toContain('aria-label="Color theme"');

    const appDir = path.resolve(import.meta.dirname, '..');
    const tokensCss = readFileSync(path.join(appDir, 'src/styles/tokens.css'), 'utf8');
    expect(tokensCss).toContain("font-family: 'IBM Plex Sans'");
    expect(tokensCss).toContain("font-family: 'IBM Plex Mono'");
    expect(tokensCss).toContain('.woff2');
    expect(tokensCss).not.toMatch(/https?:\/\//i);
    expect(tokensCss).toContain('color-scheme: light;');
    expect(tokensCss).toContain('color-scheme: dark;');

    // Custom schematic badges preserve explicit step qualifier on non-canonical models
    const customSchematicHtml = renderToStaticMarkup(
      createElement(AirlockSchematic, {
        schema: { flag: { kind: 'boolean' } },
        state: { flag: false },
        changedVars: [],
        violatedInvariantIds: [],
        evaluatedInvariantIds: ['inv_custom'],
        invariants: [
          {
            id: 'inv_custom',
            label: 'Custom invariant',
            holds: { op: 'not', arg: { op: 'var', name: 'flag' } },
          },
        ],
        goal: {
          id: 'custom_goal',
          label: 'Custom goal',
          reached: { op: 'lit', value: true },
        },
        isEvaluated: true,
        isStale: false,
        goalReached: true,
        stepNumber: 2,
        modeLabel: 'Manual Simulation',
      }),
    );
    expect(customSchematicHtml).toContain('INVARIANTS HOLD AT STEP 2 (1)');
    expect(customSchematicHtml).toContain('GOAL AT STEP 2: REACHED (custom_goal)');
  });
});
