import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  replayTrace,
  validateModel,
  verifyModel,
  type TransitionSystemModel,
} from '@rulecanvas/core';
import {
  applyManualStep,
  buildInvariantsPanelView,
  buildStateTableView,
  buildVerdictSummaryView,
  createVerdictReplaySession,
  jumpReplayToStep,
  resetReplaySession,
  stepReplayBackward,
  stepReplayForward,
} from '@rulecanvas/ui';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App.js';
import { ComparisonPanel } from '../src/components/ComparisonPanel.js';
import { PolicyEditorPane } from '../src/components/PolicyEditorPane.js';
import {
  VerificationWorkbenchPane,
  type VerifiedSnapshot,
} from '../src/components/VerificationWorkbenchPane.js';
import {
  DEFAULT_VERIFY_OPTIONS,
  VerifyWorkerClient,
  addAssumption,
  addInvariant,
  addRule,
  addRuleUpdate,
  addSchemaVariable,
  appendRuleGuardClause,
  approvalLaunderingBrokenModel,
  createDefaultRule,
  createSynchronousWorkerFactory,
  exportModelToJson,
  getErrorsForPathPrefix,
  importModelFromJson,
  indexModelDiagnostics,
  isWebWorkerSupported,
  loadPresetModel,
  moveRule,
  parseStrictIntegerDraft,
  removeAssumption,
  removeInvariant,
  removeRule,
  removeRuleUpdate,
  removeSchemaVariable,
  runPresetComparison,
  setGoalEnabled,
  setInitialStateValue,
  updateAssumption,
  updateGoal,
  updateInvariant,
  updateModelMetadata,
  updateRule,
  updateSchemaVariable,
  validateImportedModelValue,
  type VerifyWorkerRequest,
  type WorkerLike,
} from '../src/index.js';

describe('AgentGate workbench domain modules and UI', () => {
  it('fixes the broken approval-laundering model by appending !modifiedSinceApproval to publish_release_notes', () => {
    const broken = loadPresetModel('broken');
    const patched = appendRuleGuardClause(broken, 'publish_release_notes', {
      op: 'not',
      arg: { op: 'var', name: 'modifiedSinceApproval' },
    });

    // Immutability check: original broken model remains untouched
    expect(verifyModel(broken, DEFAULT_VERIFY_OPTIONS).status).toBe('VIOLATED');
    expect(validateModel(patched)).toEqual([]);

    const result = verifyModel(patched, DEFAULT_VERIFY_OPTIONS);
    expect(result.status).toBe('VERIFIED');
    if (result.status !== 'VERIFIED') return;

    expect(result.goalReachable).toBe(true);
    expect(result.stats.statesExplored).toBe(61);
    expect(result.stats.theoreticalStates).toBe('384');
  });

  it('rejects malformed, hostile (accessor/Proxy/non-JSON), and out-of-budget JSON without throwing', () => {
    // Malformed JSON syntax
    const malformed = importModelFromJson('{ "id": "broken", ');
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) {
      expect(malformed.errors.length).toBeGreaterThan(0);
      expect(malformed.errors[0]?.code).toBe('JSON_PARSE_ERROR');
      expect(malformed.errors[0]?.path).toBe('$');
    }

    // Empty string
    const empty = importModelFromJson('   ');
    expect(empty.ok).toBe(false);
    if (!empty.ok) {
      expect(empty.errors[0]?.code).toBe('JSON_PARSE_ERROR');
    }

    // Non-string primitive
    const nonJson = importModelFromJson(42);
    expect(nonJson.ok).toBe(false);
    if (!nonJson.ok) {
      expect(nonJson.errors[0]?.code).toBe('INVALID_JSON_INPUT');
    }

    // Hostile object with throwing getter accessor
    const hostileGetter = {};
    Object.defineProperty(hostileGetter, 'schema', {
      enumerable: true,
      get() {
        throw new Error('getter trap exploded');
      },
    });
    const getterResult = importModelFromJson(hostileGetter);
    expect(getterResult.ok).toBe(false);
    if (!getterResult.ok) {
      expect(getterResult.errors.length).toBeGreaterThan(0);
      const indexed = indexModelDiagnostics(getterResult.errors);
      expect(indexed.all.length).toBeGreaterThan(0);
    }

    // Hostile Proxy throwing on ownKeys / getOwnPropertyDescriptor
    const hostileProxy = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('proxy ownKeys trap');
        },
        getOwnPropertyDescriptor() {
          throw new Error('proxy descriptor trap');
        },
      },
    );
    const proxyResult = importModelFromJson(hostileProxy);
    expect(proxyResult.ok).toBe(false);
    if (!proxyResult.ok) {
      expect(proxyResult.errors.length).toBeGreaterThan(0);
    }

    // Out-of-budget JSON (> 64 schema variables and int span > 1_000_000)
    const oversizedSchema: Record<string, { kind: 'boolean' }> = {};
    const oversizedInit: Record<string, boolean> = {};
    for (let i = 0; i < 65; i += 1) {
      oversizedSchema[`v_${i}`] = { kind: 'boolean' };
      oversizedInit[`v_${i}`] = false;
    }
    const oversizedPayload = JSON.stringify({
      ...approvalLaunderingBrokenModel,
      schema: oversizedSchema,
      initialState: oversizedInit,
    });
    const oversizedResult = importModelFromJson(oversizedPayload);
    expect(oversizedResult.ok).toBe(false);
    if (!oversizedResult.ok) {
      const indexed = indexModelDiagnostics(oversizedResult.errors);
      expect(indexed.sections.schema.length).toBeGreaterThan(0);
      expect(indexed.all.some((e) => e.code === 'SCHEMA_TOO_LARGE' && e.path === 'schema')).toBe(
        true,
      );
    }

    // Out-of-budget int span
    const hugeSpanPayload = JSON.stringify({
      ...approvalLaunderingBrokenModel,
      schema: {
        ...approvalLaunderingBrokenModel.schema,
        revision: { kind: 'int', min: 0, max: 2_000_000 },
      },
    });
    const hugeSpanResult = importModelFromJson(hugeSpanPayload);
    expect(hugeSpanResult.ok).toBe(false);
    if (!hugeSpanResult.ok) {
      const indexed = indexModelDiagnostics(hugeSpanResult.errors);
      const revErrors = getErrorsForPathPrefix(indexed, 'schema.revision');
      expect(revErrors.some((e) => e.code === 'INT_SPAN_TOO_LARGE')).toBe(true);
    }
  });

  it('performs immutable schema, rule, invariant, goal, and assumption edits that round-trip cleanly to JSON', () => {
    let model: TransitionSystemModel = loadPresetModel('principled-fix');

    model = updateModelMetadata(model, {
      id: 'agentgate-custom-release-policy',
      name: 'AgentGate Custom Policy',
    });

    // Schema & initial state CRUD
    model = addSchemaVariable(model, 'auditLogged', { kind: 'boolean' }, false);
    model = updateSchemaVariable(
      model,
      'auditLogged',
      'auditRecorded',
      { kind: 'enum', values: ['none', 'logged'] },
      'none',
    );
    model = setInitialStateValue(model, 'auditRecorded', 'logged');
    model = addSchemaVariable(model, 'tempFlag', { kind: 'boolean' });
    model = removeSchemaVariable(model, 'tempFlag');

    // Rule CRUD + updates + reorder
    let customRule = createDefaultRule(model);
    customRule = addRuleUpdate(customRule, {
      var: 'auditRecorded',
      value: { op: 'lit', value: 'none' },
    });
    customRule = addRuleUpdate(customRule, {
      var: 'secretInContext',
      value: { op: 'lit', value: false },
    });
    customRule = removeRuleUpdate(customRule, 1);

    model = addRule(model, customRule);
    const addedIndex = model.rules.length - 1;
    model = updateRule(model, addedIndex, { ...customRule, label: 'Reset audit marker' });
    model = moveRule(model, addedIndex, addedIndex - 1);
    model = removeRule(model, addedIndex - 1);

    // Invariant CRUD
    model = addInvariant(model, {
      id: 'inv_audit_non_empty',
      label: 'Audit marker stays within declared enum domain',
      holds: {
        op: 'in',
        expr: { op: 'var', name: 'auditRecorded' },
        values: ['none', 'logged'],
      },
    });
    model = updateInvariant(model, 1, {
      ...model.invariants[1]!,
      label: 'Updated audit invariant',
    });
    model = removeInvariant(model, 1);

    // Goal toggle & update
    model = setGoalEnabled(model, false);
    expect(model.goal).toBeUndefined();
    model = setGoalEnabled(model, true, approvalLaunderingBrokenModel.goal);
    expect(model.goal).toBeDefined();
    model = updateGoal(model, {
      ...model.goal!,
      label: 'Clean edited release with audit',
    });

    // Assumption CRUD
    model = addAssumption(model, {
      id: 'asm_custom_audit',
      category: 'logging',
      statement: 'Audit marker tracks discrete log state.',
      notModeled: 'External log sink availability.',
    });
    model = updateAssumption(model, model.assumptions.length - 1, {
      ...model.assumptions[model.assumptions.length - 1]!,
      category: 'audit-trail',
    });
    model = removeAssumption(model, model.assumptions.length - 1);

    expect(validateModel(model)).toEqual([]);

    const serialized = exportModelToJson(model);
    const imported = importModelFromJson(serialized);
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;

    expect(imported.model).toEqual(model);
    expect(validateModel(imported.model)).toEqual([]);
  });

  it('handles VerifyWorkerClient request IDs, stale-response suppression, cancellation, and error recovery', async () => {
    // 1. Stale-response suppression with deferred mock worker
    const postedRequests: VerifyWorkerRequest[] = [];
    const createdWorkers: WorkerLike[] = [];

    const createControlledWorker = (): WorkerLike => {
      const worker: WorkerLike = {
        onmessage: null,
        onerror: null,
        postMessage(msg: VerifyWorkerRequest) {
          postedRequests.push(msg);
        },
        terminate() {
          // no-op in mock
        },
      };
      createdWorkers.push(worker);
      return worker;
    };

    const client = new VerifyWorkerClient({
      workerFactory: createControlledWorker,
      restartOnSupersede: false,
    });

    const broken = loadPresetModel('broken');
    const principled = loadPresetModel('principled-fix');

    const firstPromise = client.verify(broken, DEFAULT_VERIFY_OPTIONS);
    expect(client.isRunning()).toBe(true);
    expect(postedRequests).toHaveLength(1);
    const req1 = postedRequests[0]!;

    // Second request supersedes the first before req1 completes
    const secondPromise = client.verify(principled, DEFAULT_VERIFY_OPTIONS);
    expect(postedRequests).toHaveLength(2);
    const req2 = postedRequests[1]!;
    expect(req2.requestId).toBeGreaterThan(req1.requestId);

    const firstOutcome = await firstPromise;
    expect(firstOutcome).toEqual({ status: 'cancelled', requestId: req1.requestId });

    // Deliver stale response for req1 — must be ignored while req2 stays active
    const worker = createdWorkers[0]!;
    worker.onmessage?.({
      data: {
        type: 'result',
        requestId: req1.requestId,
        result: verifyModel(broken, DEFAULT_VERIFY_OPTIONS),
      },
    });
    expect(client.isRunning()).toBe(true);

    // Deliver response for req2
    const expectedPrincipledResult = verifyModel(principled, DEFAULT_VERIFY_OPTIONS);
    worker.onmessage?.({
      data: {
        type: 'result',
        requestId: req2.requestId,
        result: expectedPrincipledResult,
      },
    });

    const secondOutcome = await secondPromise;
    expect(secondOutcome.status).toBe('completed');
    if (secondOutcome.status === 'completed') {
      expect(secondOutcome.requestId).toBe(req2.requestId);
      expect(secondOutcome.result.status).toBe('VERIFIED');
    }
    expect(client.isRunning()).toBe(false);

    // 2. Worker error recovery: worker crashes on req3, then recovers on req4 with a new worker
    let workerSpawnCount = 0;
    const crashingThenHealthyFactory = (): WorkerLike => {
      workerSpawnCount += 1;
      const attempt = workerSpawnCount;
      const w: WorkerLike = {
        onmessage: null,
        onerror: null,
        postMessage(msg: VerifyWorkerRequest) {
          if (attempt === 1) {
            w.onerror?.({ message: 'Simulated worker crash' });
            return;
          }
          w.onmessage?.({
            data: {
              type: 'result',
              requestId: msg.requestId,
              result: verifyModel(msg.model, msg.options),
            },
          });
        },
        terminate() {
          // no-op
        },
      };
      return w;
    };

    const recoveryClient = new VerifyWorkerClient({
      workerFactory: crashingThenHealthyFactory,
    });

    const errOutcome = await recoveryClient.verify(broken, DEFAULT_VERIFY_OPTIONS);
    expect(errOutcome.status).toBe('error');
    if (errOutcome.status === 'error') {
      expect(errOutcome.message).toBe('Simulated worker crash');
    }

    const recoveredOutcome = await recoveryClient.verify(principled, DEFAULT_VERIFY_OPTIONS);
    expect(recoveredOutcome.status).toBe('completed');
    if (recoveredOutcome.status === 'completed') {
      expect(recoveredOutcome.result.status).toBe('VERIFIED');
    }
    expect(workerSpawnCount).toBe(2);

    // 3. Synchronous worker adapter works end-to-end
    const syncClient = new VerifyWorkerClient({
      workerFactory: createSynchronousWorkerFactory(),
    });
    const syncOutcome = await syncClient.verify(broken, DEFAULT_VERIFY_OPTIONS);
    expect(syncOutcome.status).toBe('completed');
    if (syncOutcome.status === 'completed') {
      expect(syncOutcome.result.status).toBe('VIOLATED');
    }
    syncClient.dispose();
  });

  it('computes exact comparison outcomes across all 5 approval-laundering presets', () => {
    const rows = runPresetComparison(DEFAULT_VERIFY_OPTIONS);
    expect(rows).toHaveLength(5);

    const byVariant = new Map(rows.map((row) => [row.preset.variant, row]));

    const brokenRow = byVariant.get('broken')!;
    expect(brokenRow.result.status).toBe('VIOLATED');
    expect(brokenRow.traceLength).toBe(5);
    expect(brokenRow.summary.badge).toBe('VIOLATED');

    const patchARow = byVariant.get('naive-patch-a')!;
    expect(patchARow.result.status).toBe('VIOLATED');
    expect(patchARow.traceLength).toBe(6);

    const patchBRow = byVariant.get('naive-patch-b')!;
    expect(patchBRow.result.status).toBe('VIOLATED');
    expect(patchBRow.traceLength).toBe(7);

    const vacuousRow = byVariant.get('vacuous-fix')!;
    expect(vacuousRow.result.status).toBe('VERIFIED');
    expect(vacuousRow.goalReachable).toBe(false);
    expect(vacuousRow.summary.badge).toBe('VERIFIED (GOAL UNREACHABLE)');
    expect(vacuousRow.summary.vacuousGoalWarning).toBe(true);

    const principledRow = byVariant.get('principled-fix')!;
    expect(principledRow.result.status).toBe('VERIFIED');
    expect(principledRow.statesExplored).toBe(61);
    expect(principledRow.goalReachable).toBe(true);
    expect(principledRow.summary.badge).toBe('VERIFIED');
    expect(principledRow.summary.vacuousGoalWarning).toBe(false);
  });

  it('integrates replay, manual branching, state diffs, and INCONCLUSIVE truncation with @rulecanvas/ui', () => {
    const broken = loadPresetModel('broken');
    const verdict = verifyModel(broken, DEFAULT_VERIFY_OPTIONS);
    expect(verdict.status).toBe('VIOLATED');
    if (verdict.status !== 'VIOLATED') return;

    const initRes = createVerdictReplaySession(broken, verdict, { startAt: 'terminal' });
    expect(initRes.ok).toBe(true);
    if (!initRes.ok) return;

    let session = initRes.session;
    expect(session.mode).toBe('trace');
    expect(session.cursor).toBe(5);
    expect(session.totalSteps).toBe(5);
    expect(session.violatedInvariantIds).toEqual(['inv_no_confidential_publish']);

    // Verify trace matches core replayTrace
    const coreReplay = replayTrace(
      broken,
      session.steps.map((s) => s.ruleId),
    );
    expect(coreReplay.ok).toBe(true);
    if (coreReplay.ok) {
      expect(coreReplay.steps).toEqual(session.steps);
      expect(coreReplay.finalState).toEqual(session.currentState);
    }

    // Highlight changedVars via buildStateTableView & invariants via buildInvariantsPanelView
    const terminalTable = buildStateTableView(
      session.model,
      session.currentState,
      session.changedVars,
    );
    expect(terminalTable.rows.find((r) => r.name === 'stage')?.changed).toBe(true);
    expect(terminalTable.rows.find((r) => r.name === 'stage')?.changeLabel).toBe('Modified');

    const terminalInvs = buildInvariantsPanelView(
      session.model,
      session.violatedInvariantIds,
      session.goalReached,
    );
    expect(terminalInvs.status).toBe('VALID');
    expect(terminalInvs.invariants[0]?.status).toBe('VIOLATED');

    // Step backward, reset, jump, and step forward
    const back = stepReplayBackward(session);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.session.cursor).toBe(4);

    const reset = resetReplaySession(back.session);
    expect(reset.ok).toBe(true);
    if (!reset.ok) return;
    expect(reset.session.cursor).toBe(0);

    const fwd = stepReplayForward(reset.session);
    expect(fwd.ok).toBe(true);
    if (!fwd.ok) return;
    expect(fwd.session.cursor).toBe(1);

    // Jump to step 2 (after human_approve_clean_draft) and manually branch to publish_release_notes cleanly
    const jumped = jumpReplayToStep(fwd.session, 2);
    expect(jumped.ok).toBe(true);
    if (!jumped.ok) return;
    expect(jumped.session.enabledTransitions.some((t) => t.ruleId === 'publish_release_notes' && t.enabled)).toBe(true);

    const branched = applyManualStep(jumped.session, 'publish_release_notes');
    expect(branched.ok).toBe(true);
    if (!branched.ok) return;
    expect(branched.session.mode).toBe('manual');
    expect(branched.session.cursor).toBe(3);
    expect(branched.session.violatedInvariantIds).toEqual([]);
    expect(branched.session.currentState['stage']).toBe('published');
    expect(branched.session.currentState['draftConfidential']).toBe(false);

    // Verify INCONCLUSIVE truncation with tight bounds (maxStates: 5, maxDepth: 2)
    const principled = loadPresetModel('principled-fix');
    const inconclusive = verifyModel(principled, { maxStates: 5, maxDepth: 2 });
    expect(inconclusive.status).toBe('INCONCLUSIVE');
    const summary = buildVerdictSummaryView(inconclusive);
    expect(summary.badge).toBe('INCONCLUSIVE');
    expect(summary.inconclusiveReason).toBeDefined();
    expect(summary.frontierRemaining).toBeGreaterThan(0);
  });

  it('smoke-renders App cleanly via react-dom/server with presets, verdict, assumptions, replay controls, and comparison matrix', () => {
    const brokenHtml = renderToStaticMarkup(
      createElement(App, {
        initialVariant: 'broken',
        initialShowComparison: true,
      }),
    );

    expect(brokenHtml).toContain('AgentGate');
    expect(brokenHtml).toContain('Verify Policy');
    expect(brokenHtml).toContain('Compare All 5 Presets');
    expect(brokenHtml).toContain('VIOLATED');
    expect(brokenHtml).toContain('Counterexample found in 5 steps.');
    expect(brokenHtml).toContain('Step 5 of 5');
    expect(brokenHtml).toContain('inv_no_confidential_publish');
    expect(brokenHtml).toContain('asm_synthetic_capability_abstraction');
    expect(brokenHtml).toContain('Preset Comparison Matrix');
    expect(brokenHtml).toContain('VERIFIED (GOAL UNREACHABLE)');
    expect(brokenHtml).toContain('61 states');

    // Also verify vacuous-fix renders the explicit vacuous fix warning
    const vacuousHtml = renderToStaticMarkup(
      createElement(App, {
        initialVariant: 'vacuous-fix',
      }),
    );
    expect(vacuousHtml).toContain('VERIFIED (GOAL UNREACHABLE)');
    expect(vacuousHtml).toContain('Vacuous Fix Warning');

    // Also verify principled-fix renders VERIFIED with Goal reachable: Yes
    const principledHtml = renderToStaticMarkup(
      createElement(App, {
        initialVariant: 'principled-fix',
      }),
    );
    expect(principledHtml).toContain('Goal reachable: Yes');
    expect(principledHtml).toContain('61');
    expect(brokenHtml).not.toContain('—');
    expect(brokenHtml).not.toContain('·');
  });

  it('falls back cleanly to main-thread synchronous verification when Web Workers are unavailable or throw on construction', async () => {
    const broken = loadPresetModel('broken');

    // In Node test environment, globalThis.Worker is undefined
    expect(isWebWorkerSupported()).toBe(false);
    const fallbackClient = new VerifyWorkerClient();
    expect(fallbackClient.getExecutionMode()).toBe('main-thread');

    const outcome = await fallbackClient.verify(broken, DEFAULT_VERIFY_OPTIONS);
    expect(outcome.status).toBe('completed');
    if (outcome.status === 'completed') {
      expect(outcome.executionMode).toBe('main-thread');
      expect(outcome.result.status).toBe('VIOLATED');
    }
    fallbackClient.dispose();

    // Simulate environment where globalThis.Worker exists but throws when constructed
    const originalWorker = (globalThis as { Worker?: unknown }).Worker;
    try {
      (globalThis as { Worker?: unknown }).Worker = function ThrowingWorker() {
        throw new TypeError('Worker is not constructable in this environment');
      };
      expect(isWebWorkerSupported()).toBe(true);
      const throwingFallbackClient = new VerifyWorkerClient();
      const dynamicOutcome = await throwingFallbackClient.verify(broken, DEFAULT_VERIFY_OPTIONS);
      expect(dynamicOutcome.status).toBe('completed');
      if (dynamicOutcome.status === 'completed') {
        expect(dynamicOutcome.executionMode).toBe('main-thread');
        expect(dynamicOutcome.result.status).toBe('VIOLATED');
      }
      expect(throwingFallbackClient.getExecutionMode()).toBe('main-thread');
      throwingFallbackClient.dispose();
    } finally {
      if (originalWorker === undefined) {
        delete (globalThis as { Worker?: unknown }).Worker;
      } else {
        (globalThis as { Worker?: unknown }).Worker = originalWorker;
      }
    }

    // Running UI on main-thread truthfully reports main-thread fallback copy
    const runningHtml = renderToStaticMarkup(
      createElement(VerificationWorkbenchPane, {
        model: broken,
        isRunning: true,
        runningExecutionMode: 'main-thread',
        isStale: false,
        workerError: null,
        cancelledNotice: null,
        optionErrors: [],
        editorDraftErrors: [],
        modelErrors: [],
        verifiedSnapshot: null,
        replaySession: null,
        replayError: null,
        onCancelRun: () => {},
        onVerifyNow: () => {},
        onResetReplay: () => {},
        onStepBack: () => {},
        onStepForward: () => {},
        onJumpToStep: () => {},
        onApplyManualStep: () => {},
        onRestoreVerdictTrace: () => {},
      }),
    );
    expect(runningHtml).toContain(
      'Executing deterministic verification on main thread (Web Workers unavailable)',
    );
  });

  it('enforces strict portable JSON allowlists, rejects reserved keys recursively, returns detached clones, and safely exports canonical fields', () => {
    const broken = loadPresetModel('broken');

    // Reject unknown root field with nested reserved key (metadata.constructor)
    const withMetadata = JSON.stringify({
      ...broken,
      metadata: { constructor: 'Example metadata' },
    });
    const metadataRes = importModelFromJson(withMetadata);
    expect(metadataRes.ok).toBe(false);
    if (!metadataRes.ok) {
      expect(metadataRes.errors.some((e) => e.code === 'UNSUPPORTED_FIELD' && e.path === 'metadata')).toBe(true);
      expect(
        metadataRes.errors.some((e) => e.code === 'RESERVED_KEY' && e.path === 'metadata.constructor'),
      ).toBe(true);
    }

    // Reject extra unknown field inside schema VarDef
    const withExtraVarField = JSON.stringify({
      ...broken,
      schema: {
        ...broken.schema,
        secretInContext: { kind: 'boolean', extra: true },
      },
    });
    const extraVarRes = importModelFromJson(withExtraVarField);
    expect(extraVarRes.ok).toBe(false);
    if (!extraVarRes.ok) {
      expect(
        extraVarRes.errors.some(
          (e) => e.code === 'UNSUPPORTED_FIELD' && e.path === 'schema.secretInContext.extra',
        ),
      ).toBe(true);
    }

    // Reject extra unknown field inside BoolExpr
    const withExtraExprField = JSON.stringify({
      ...broken,
      rules: broken.rules.map((r, i) =>
        i === 0 ? { ...r, guard: { ...r.guard, extraFlag: 1 } } : r,
      ),
    });
    const extraExprRes = importModelFromJson(withExtraExprField);
    expect(extraExprRes.ok).toBe(false);
    if (!extraExprRes.ok) {
      expect(
        extraExprRes.errors.some(
          (e) => e.code === 'UNSUPPORTED_FIELD' && e.path === 'rules[0].guard.extraFlag',
        ),
      ).toBe(true);
    }

    // Reject symbol property on candidate object
    const symCandidate: Record<PropertyKey, unknown> = { ...broken };
    symCandidate[Symbol('injected')] = 'nope';
    const symRes = validateImportedModelValue(symCandidate);
    expect(symRes.ok).toBe(false);

    // Detached snapshot: mutating caller object after validation does NOT mutate imported model
    const mutableSource = JSON.parse(exportModelToJson(broken)) as Record<string, unknown>;
    const validated = validateImportedModelValue(mutableSource);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    (mutableSource['initialState'] as Record<string, unknown>)['stage'] = 'published';
    ((mutableSource['rules'] as Array<Record<string, unknown>>)[0] as Record<string, unknown>)['id'] =
      'mutated_rule';
    expect(validated.model.initialState['stage']).toBe('idle');
    expect(validated.model.rules[0]?.id).toBe('draft_public_notes');

    // Safe export: strips unknown fields and never invokes throwing getters
    const decorated = { ...broken } as TransitionSystemModel & Record<string, unknown>;
    decorated['extraSecret'] = 'should-not-export';
    let getterCalled = false;
    Object.defineProperty(decorated, 'poison', {
      enumerable: true,
      get() {
        getterCalled = true;
        throw new Error('getter must not be invoked');
      },
    });
    const exportedJson = exportModelToJson(decorated);
    expect(getterCalled).toBe(false);
    expect(exportedJson).not.toContain('extraSecret');
    expect(exportedJson).not.toContain('poison');
    expect(importModelFromJson(exportedJson).ok).toBe(true);
  });

  it('strictly validates raw integer drafts and rejects blanks, decimals, scientific notation, and unsafe integers', () => {
    expect(parseStrictIntegerDraft('0')).toEqual({ ok: true, value: 0 });
    expect(parseStrictIntegerDraft('-0')).toEqual({ ok: true, value: 0 });
    expect(parseStrictIntegerDraft('42')).toEqual({ ok: true, value: 42 });
    expect(parseStrictIntegerDraft('-15')).toEqual({ ok: true, value: -15 });
    expect(parseStrictIntegerDraft(' 7 ')).toEqual({ ok: true, value: 7 });

    for (const invalid of ['', '   ', '2.9', '-0.5', '1e3', '+5', '2abc', 'NaN', '9007199254740993']) {
      const parsed = parseStrictIntegerDraft(invalid);
      expect(parsed.ok).toBe(false);
    }

    // Bounds inputs in App use type="text" inputMode="numeric" rather than type="number"
    const appHtml = renderToStaticMarkup(createElement(App, { initialVariant: 'broken' }));
    expect(appHtml).toContain('id="max-states-input" type="text" inputMode="numeric"');
    expect(appHtml).toContain('id="max-depth-input" type="text" inputMode="numeric"');
  });

  it('renders OUTDATED snapshot banners, unverified/cancelled states, and dual state+trace comparison columns', () => {
    const broken = loadPresetModel('broken');
    const verdict = verifyModel(broken, DEFAULT_VERIFY_OPTIONS);
    const replayRes = createVerdictReplaySession(broken, verdict, { startAt: 'terminal' });
    expect(replayRes.ok).toBe(true);
    if (!replayRes.ok) return;

    const snapshot: VerifiedSnapshot = {
      model: broken,
      modelLabel: 'Broken Policy',
      options: DEFAULT_VERIFY_OPTIONS,
      result: verdict,
      executionMode: 'main-thread',
    };

    // Outdated snapshot renders OUTDATED badge + explicit banner naming model and bounds
    const staleHtml = renderToStaticMarkup(
      createElement(VerificationWorkbenchPane, {
        model: broken,
        isRunning: false,
        runningExecutionMode: 'main-thread',
        isStale: true,
        workerError: null,
        cancelledNotice: null,
        optionErrors: [],
        editorDraftErrors: [],
        modelErrors: [],
        verifiedSnapshot: snapshot,
        replaySession: replayRes.session,
        replayError: null,
        onCancelRun: () => {},
        onVerifyNow: () => {},
        onResetReplay: () => {},
        onStepBack: () => {},
        onStepForward: () => {},
        onJumpToStep: () => {},
        onApplyManualStep: () => {},
        onRestoreVerdictTrace: () => {},
      }),
    );
    expect(staleHtml).toContain('OUTDATED: VIOLATED');
    expect(staleHtml).toContain('Outdated Verification Snapshot');
    expect(staleHtml).toContain('Broken Policy');
    expect(staleHtml).toContain('maxStates=10000');
    expect(staleHtml).toContain('maxDepth=50');
    expect(staleHtml).toContain('Re-verify Now');

    // Cancelled/unverified state renders explicit notice and never shows old verdict/replay
    const cancelledHtml = renderToStaticMarkup(
      createElement(VerificationWorkbenchPane, {
        model: broken,
        isRunning: false,
        runningExecutionMode: 'main-thread',
        isStale: false,
        workerError: null,
        cancelledNotice: 'Verification run cancelled before completion.',
        optionErrors: [],
        editorDraftErrors: [],
        modelErrors: [],
        verifiedSnapshot: null,
        replaySession: null,
        replayError: null,
        onCancelRun: () => {},
        onVerifyNow: () => {},
        onResetReplay: () => {},
        onStepBack: () => {},
        onStepForward: () => {},
        onJumpToStep: () => {},
        onApplyManualStep: () => {},
        onRestoreVerdictTrace: () => {},
      }),
    );
    expect(cancelledHtml).toContain('Verification Cancelled');
    expect(cancelledHtml).toContain('Verify Policy');
    expect(cancelledHtml).not.toContain('Counterexample Trace Replay');

    // Comparison matrix shows BOTH state counts and trace lengths plus bounds notice
    const rows = runPresetComparison(DEFAULT_VERIFY_OPTIONS);
    const compHtml = renderToStaticMarkup(
      createElement(ComparisonPanel, {
        rows,
        bounds: DEFAULT_VERIFY_OPTIONS,
        boundsHasErrors: true,
        activeVariant: 'broken',
        onLoadPreset: () => {},
        onClose: () => {},
      }),
    );
    expect(compHtml).toContain('States Explored');
    expect(compHtml).toContain('Counterexample Trace');
    expect(compHtml).toContain('44 states');
    expect(compHtml).toContain('5 steps');
    expect(compHtml).toContain('6 steps');
    expect(compHtml).toContain('7 steps');
    expect(compHtml).toContain('61 states');
    expect(compHtml).toContain('None');
    expect(compHtml).toContain('maxStates=10000, maxDepth=50');
    expect(compHtml).toContain('Current Bounds Inputs Are Invalid');
    expect(compHtml).not.toContain('—');
  });

  it('associates every visible label with an explicit matching control id, uses accessible rule disclosures, and ships an inline SVG favicon', () => {
    const broken = loadPresetModel('broken');
    const html = renderToStaticMarkup(
      createElement(PolicyEditorPane, {
        model: broken,
        diagnostics: indexModelDiagnostics([]),
        onChangeModel: () => {},
        onImportModel: () => {},
      }),
    );

    const labelMatches = [...html.matchAll(/<label\b([^>]*)>/g)];
    expect(labelMatches.length).toBeGreaterThan(0);
    for (const match of labelMatches) {
      const attrs = match[1] ?? '';
      const forMatch = attrs.match(/\bfor="([^"]+)"/);
      expect(forMatch).not.toBeNull();
      const targetId = forMatch?.[1] ?? '';
      expect(html).toContain(`id="${targetId}"`);
    }

    // Controlled rule disclosure button starts expanded for publish_release_notes
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('aria-expanded="false"');

    // index.html includes inline SVG favicon and clean copy without em-dash or middle dot
    const indexHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    expect(indexHtml).toContain('rel="icon"');
    expect(indexHtml).toContain('data:image/svg+xml');
    expect(indexHtml).not.toContain('—');
    expect(indexHtml).not.toContain('·');
  });
});
