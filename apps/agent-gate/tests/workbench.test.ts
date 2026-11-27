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
import { describe, expect, it, vi } from 'vitest';
import { installVerifyWorker, type VerifyWorkerPort } from '@rulecanvas/workbench/verify-worker';
import { DEFAULT_MODEL_JSON_LIMITS } from '@rulecanvas/workbench/model-json';
import { App } from '../src/App.js';
import { ComparisonPanel } from '../src/components/ComparisonPanel.js';
import {
  BoolExprEditor,
  defaultInItemValue,
  updateInListItem,
  type LiftedIntDraftStore,
} from '../src/components/ExprEditor.js';
import {
  PolicyEditorPane,
  applySchemaVarRenameState,
  matchesDraftPrefix,
  resolveOrderedSchemaKeys,
  resolveQuickBooleanVariable,
  shouldPruneGuardDraftsOnAppend,
  tryExportModelJson,
} from '../src/components/PolicyEditorPane.js';
import { StrictIntegerInput } from '../src/components/StrictIntegerInput.js';
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
  createBrowserVerifyWorker,
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
  it('applies the export size limit to invalid drafts', () => {
    const broken = approvalLaunderingBrokenModel;
    const smallDraft = { ...broken, invariants: [] };
    expect(JSON.parse(exportModelToJson(smallDraft)).invariants).toEqual([]);
    const oversizedDraft = { ...smallDraft, name: 'x'.repeat(512_000) };
    expect(() => exportModelToJson(oversizedDraft)).toThrow(/512000/);
  });

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

  it('round-trips the legacy browser worker through the shared protocol', () => {
    class LoopbackWorker {
      onmessage: ((event: { data: unknown }) => void) | null = null;
      readonly port: VerifyWorkerPort = {
        onmessage: null,
        postMessage: (data) => this.onmessage?.({ data }),
      };

      constructor() {
        installVerifyWorker(this.port);
      }

      postMessage(data: unknown) {
        this.port.onmessage?.({ data });
      }

      terminate() {
        this.port.onmessage = null;
      }
    }

    vi.stubGlobal('Worker', LoopbackWorker);
    try {
      const worker = createBrowserVerifyWorker();
      const onmessage = vi.fn();
      worker.onmessage = onmessage;
      worker.postMessage({
        type: 'verify',
        requestId: 0,
        model: approvalLaunderingBrokenModel,
        options: DEFAULT_VERIFY_OPTIONS,
      });
      expect(onmessage).toHaveBeenCalledExactlyOnceWith({
        data: {
          type: 'result',
          requestId: 0,
          result: verifyModel(approvalLaunderingBrokenModel, DEFAULT_VERIFY_OPTIONS),
        },
      });
      worker.terminate();
    } finally {
      vi.unstubAllGlobals();
    }
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

  it('associates every visible label with an explicit matching control id, renders persistent rule navigator selection, and ships an inline SVG favicon', () => {
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

    // Persistent rule navigator marks publish_release_notes selected and mounts only that detail row
    expect(html).toContain('data-rule-id="publish_release_notes" data-selected="true" aria-pressed="true"');
    expect(html).toContain('aria-pressed="false"');
    expect((html.match(/class="ag-item-row ag-rule-detail"/g) ?? []).length).toBe(1);

    // index.html includes inline SVG favicon and clean copy without em-dash or middle dot
    const indexHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    expect(indexHtml).toContain('rel="icon"');
    expect(indexHtml).toContain('data:image/svg+xml');
    expect(indexHtml).not.toContain('—');
    expect(indexHtml).not.toContain('·');
  });

  it('binds displayed assumptions strictly to verified snapshot and separates pending edited or draft assumptions (Finding 1)', () => {
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

    const editedModel = updateAssumption(broken, 0, {
      ...broken.assumptions[0]!,
      id: 'asm_edited_unverified_scope',
      statement: 'Edited unverified assumption statement.',
    });

    const staleWithEditedAssumptionsHtml = renderToStaticMarkup(
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

    // Primary section strictly renders verified snapshot assumptions with snapshot label
    expect(staleWithEditedAssumptionsHtml).toContain(
      'Scope of verified snapshot: <strong>Broken Policy</strong>',
    );
    expect(staleWithEditedAssumptionsHtml).toContain('asm_synthetic_capability_abstraction');
    // Separate clearly labeled secondary block renders pending edited assumptions
    expect(staleWithEditedAssumptionsHtml).toContain('Pending Edited Assumptions (Unverified)');
    expect(staleWithEditedAssumptionsHtml).toContain('asm_edited_unverified_scope');
    expect(staleWithEditedAssumptionsHtml).toContain('Edited unverified assumption statement.');

    // When stale because of non-assumption edits, do NOT duplicate assumptions into pending block
    const staleSameAssumptionsHtml = renderToStaticMarkup(
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
    expect(staleSameAssumptionsHtml).toContain(
      'Scope of verified snapshot: <strong>Broken Policy</strong>',
    );
    expect(staleSameAssumptionsHtml).not.toContain('Pending Edited Assumptions (Unverified)');

    // When verifiedSnapshot is null or INVALID, render Draft Model Assumptions (Unverified)
    const nullSnapHtml = renderToStaticMarkup(
      createElement(VerificationWorkbenchPane, {
        model: editedModel,
        isRunning: false,
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
    expect(nullSnapHtml).toContain('Draft Model Assumptions (Unverified)');
    expect(nullSnapHtml).toContain('asm_edited_unverified_scope');

    const invalidSnapHtml = renderToStaticMarkup(
      createElement(VerificationWorkbenchPane, {
        model: editedModel,
        isRunning: false,
        runningExecutionMode: 'main-thread',
        isStale: false,
        workerError: null,
        cancelledNotice: null,
        optionErrors: [],
        editorDraftErrors: [],
        modelErrors: [],
        verifiedSnapshot: {
          ...snapshot,
          result: {
            status: 'INVALID',
            errors: [{ code: 'EMPTY_ID', path: 'id', message: 'id required' }],
          },
        },
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
    expect(invalidSnapHtml).toContain('Draft Model Assumptions (Unverified)');
  });

  it('preserves lifted raw integer drafts and error state by stable logical identity across moves, collapses, and tab switches (Finding 2)', () => {
    const fieldKey = 'rule:rule-row-2.update:upd-row-5.value.right.value';
    const errorMsg =
      'Invalid integer "2.9": enter a whole base-10 integer without decimals or extra characters.';
    const liftedStore: LiftedIntDraftStore = {
      draftValues: { [fieldKey]: '2.9' },
      draftErrors: { [fieldKey]: errorMsg },
      onDraftChange: () => {},
      onPruneDrafts: () => {},
    };

    // Controlled StrictIntegerInput renders raw invalid draft, aria-invalid, and alert directly from lifted store
    const strictHtml = renderToStaticMarkup(
      createElement(StrictIntegerInput, {
        id: 'test-strict-int',
        value: 1,
        fieldKey,
        externalDraft: liftedStore.draftValues[fieldKey],
        externalError: liftedStore.draftErrors[fieldKey],
        onDraftChange: liftedStore.onDraftChange,
        onCommit: () => {},
      }),
    );
    expect(strictHtml).toContain('value="2.9"');
    expect(strictHtml).toContain('aria-invalid="true"');
    expect(strictHtml).toContain('role="alert"');
    expect(strictHtml).toContain('Invalid integer &quot;2.9&quot;');

    // Prefix matching prunes only removed subtrees and never collides with sibling logical IDs
    expect(matchesDraftPrefix(fieldKey, 'rule:rule-row-2')).toBe(true);
    expect(matchesDraftPrefix(fieldKey, 'rule:rule-row-2.update:upd-row-5')).toBe(true);
    expect(matchesDraftPrefix(fieldKey, 'rule:rule-row-2.update:upd-row-6')).toBe(false);
    expect(matchesDraftPrefix(fieldKey, 'rule:rule-row-20')).toBe(false);

    // Single selected rule detail mounts alongside persistent rule nav and hidden inactive tabs
    const broken = loadPresetModel('broken');
    const editorHtml = renderToStaticMarkup(
      createElement(PolicyEditorPane, {
        model: broken,
        diagnostics: indexModelDiagnostics([]),
        onChangeModel: () => {},
        onImportModel: () => {},
      }),
    );
    expect(editorHtml).toContain('data-rule-id="draft_public_notes" data-selected="false" aria-pressed="false"');
    expect(editorHtml).not.toContain('value="draft_public_notes"');
    expect(editorHtml).toContain('value="publish_release_notes"');
    expect(editorHtml).toContain('id="panel-schema" role="tabpanel"');
    expect(editorHtml).toContain('id="panel-json" role="tabpanel"');
  });

  it('preserves visual variable order and logical row identity on numeric-key rename while atomically rewriting all references (Finding 3)', () => {
    const broken = loadPresetModel('broken');
    const initialOrder = Object.keys(broken.schema);
    const secretIndex = initialOrder.indexOf('secretInContext');
    expect(secretIndex).toBeGreaterThan(0);

    const initialRowMap: Record<string, string> = {};
    initialOrder.forEach((k, idx) => {
      initialRowMap[k] = `schema-row-${idx + 1}`;
    });
    const secretRowId = initialRowMap['secretInContext']!;

    // Rename secretInContext -> "1" (numeric key that JS Object.keys hoists to index 0)
    const renamedModel = updateSchemaVariable(
      broken,
      'secretInContext',
      '1',
      broken.schema['secretInContext']!,
    );

    // JS Object.keys moves "1" to index 0, but resolveOrderedSchemaKeys keeps "1" at its original visual slot
    expect(Object.keys(renamedModel.schema)[0]).toBe('1');
    const renamedState = applySchemaVarRenameState(
      initialOrder,
      initialRowMap,
      'secretInContext',
      '1',
      secretRowId,
    );
    const visualKeys = resolveOrderedSchemaKeys(renamedState.schemaVarOrder, renamedModel.schema);
    expect(visualKeys[secretIndex]).toBe('1');
    expect(renamedState.varNameToRowId['1']).toBe(secretRowId);
    expect(renamedState.varNameToRowId['secretInContext']).toBeUndefined();

    // Atomic rewrite eliminates all UNKNOWN_VAR diagnostics across rules, invariants, and goal
    expect(validateModel(renamedModel)).toEqual([]);
    const renamedResult = verifyModel(renamedModel, DEFAULT_VERIFY_OPTIONS);
    expect(renamedResult.status).toBe('VIOLATED');
    // Original model remains immutably intact
    expect(Object.hasOwn(broken.schema, 'secretInContext')).toBe(true);
    expect(validateModel(broken)).toEqual([]);
  });

  it('preserves strict value types for in-expression set items without coercing string "true" to boolean (Finding 4)', () => {
    const schema = {
      mode: { kind: 'enum' as const, values: ['true', 'beta', 'gamma'] },
      count: { kind: 'int' as const, min: 0, max: 5 },
      flag: { kind: 'boolean' as const },
    };
    const initialValues = ['true', 'beta'] as const;
    const editedValues = updateInListItem(initialValues, 1, 'gamma');

    expect(editedValues).toEqual(['true', 'gamma']);
    expect(typeof editedValues[0]).toBe('string');
    expect(typeof editedValues[1]).toBe('string');

    // Typed defaults when clicking + Add value
    expect(defaultInItemValue({ op: 'var', name: 'mode' }, schema)).toBe('true');
    expect(typeof defaultInItemValue({ op: 'var', name: 'mode' }, schema)).toBe('string');
    expect(defaultInItemValue({ op: 'var', name: 'count' }, schema)).toBe(0);
    expect(defaultInItemValue({ op: 'var', name: 'flag' }, schema)).toBe(false);

    // Rendered in-expression UI exposes separate Type + Value controls per item and + Add value button
    const inExprHtml = renderToStaticMarkup(
      createElement(BoolExprEditor, {
        value: {
          op: 'in',
          expr: { op: 'var', name: 'mode' },
          values: editedValues,
        },
        schema,
        fieldPath: 'inv:inv-row-1.holds',
        onChange: () => {},
      }),
    );
    expect(inExprHtml).toContain('+ Add value');
    expect(inExprHtml).toContain('value="true"');
    expect(inExprHtml).toContain('value="gamma"');
    expect(inExprHtml).not.toContain('Comma-separated set values');

    // Full model validation reports zero TYPE_MISMATCH errors
    const modelWithIn: TransitionSystemModel = {
      ...loadPresetModel('principled-fix'),
      schema: {
        ...loadPresetModel('principled-fix').schema,
        mode: { kind: 'enum', values: ['true', 'beta', 'gamma'] },
      },
      initialState: {
        ...loadPresetModel('principled-fix').initialState,
        mode: 'true',
      },
      invariants: [
        ...loadPresetModel('principled-fix').invariants,
        {
          id: 'inv_mode_in_set',
          label: 'Mode remains in string set containing "true"',
          holds: {
            op: 'in',
            expr: { op: 'var', name: 'mode' },
            values: editedValues,
          },
        },
      ],
    };
    expect(validateModel(modelWithIn)).toEqual([]);
  });

  it('rejects non-integer and unsafe integer raw JSON number tokens before rounding loss (Finding 5)', () => {
    const broken = loadPresetModel('broken');
    const validJson = exportModelToJson(broken);

    // 1.00000000000000001 rounds to 1 in IEEE-754 JSON.parse, must be rejected losslessly
    const precisionLossJson = validJson.replace('"max": 3', '"max": 1.00000000000000001');
    const precisionRes = importModelFromJson(precisionLossJson);
    expect(precisionRes.ok).toBe(false);
    if (!precisionRes.ok) {
      expect(precisionRes.errors.some((e) => e.code === 'NON_INTEGER_JSON_NUMBER')).toBe(true);
    }

    // 1.0 and 1e2 must also be rejected
    const decimalZeroRes = importModelFromJson(validJson.replace('"min": 0', '"min": 0.0'));
    expect(decimalZeroRes.ok).toBe(false);
    if (!decimalZeroRes.ok) {
      expect(decimalZeroRes.errors.some((e) => e.code === 'NON_INTEGER_JSON_NUMBER')).toBe(true);
    }

    const scientificRes = importModelFromJson(validJson.replace('"max": 3', '"max": 1e2'));
    expect(scientificRes.ok).toBe(false);
    if (!scientificRes.ok) {
      expect(scientificRes.errors.some((e) => e.code === 'NON_INTEGER_JSON_NUMBER')).toBe(true);
    }

    // Unsafe integer exceeding MAX_SAFE_INTEGER must be rejected
    const unsafeIntRes = importModelFromJson(
      validJson.replace('"max": 3', '"max": 9007199254740993'),
    );
    expect(unsafeIntRes.ok).toBe(false);
    if (!unsafeIntRes.ok) {
      expect(unsafeIntRes.errors.some((e) => e.code === 'UNSAFE_INTEGER_JSON_NUMBER')).toBe(true);
    }

    // Numbers inside string literals (including escaped quotes) must NOT trigger false positives
    const withDecimalText = updateAssumption(broken, 0, {
      ...broken.assumptions[0]!,
      statement: 'Version 1.0 with "1e2" and 9007199254740993 inside string text.',
    });
    const stringNumberRes = importModelFromJson(exportModelToJson(withDecimalText));
    expect(stringNumberRes.ok).toBe(true);
  });

  it('enforces strict primitive checks in exportModelToJson with zero getter invocations (Finding 6)', () => {
    const broken = loadPresetModel('broken');

    let getterInvocations = 0;
    const objWithGetter = {};
    Object.defineProperty(objWithGetter, 'secret', {
      enumerable: true,
      get() {
        getterInvocations += 1;
        return 'leaked';
      },
    });
    Object.defineProperty(objWithGetter, 'toJSON', {
      enumerable: true,
      get() {
        getterInvocations += 1;
        return () => 'leaked';
      },
    });

    const malformedNameModel = {
      ...broken,
      name: objWithGetter,
    } as unknown as TransitionSystemModel;

    expect(() => exportModelToJson(malformedNameModel)).toThrow(TypeError);
    expect(getterInvocations).toBe(0);

    // Accessor directly on a canonical property must also throw TypeError with 0 invocations
    const accessorModel = { ...broken } as unknown as Record<string, unknown>;
    Object.defineProperty(accessorModel, 'id', {
      enumerable: true,
      get() {
        getterInvocations += 1;
        return 'sneaky';
      },
    });
    expect(() => exportModelToJson(accessorModel as unknown as TransitionSystemModel)).toThrow(
      TypeError,
    );
    expect(getterInvocations).toBe(0);
  });

  it('pairs every rendered form control bidirectionally with a visible label and renders all editor + inspector tabpanels with WCAG control borders (Findings 7 & 8)', () => {
    const richModel: TransitionSystemModel = {
      ...loadPresetModel('broken'),
      invariants: [
        ...loadPresetModel('broken').invariants,
        {
          id: 'inv_rich_coverage',
          label: 'Covers in, add, sub, lit string/int/bool',
          holds: {
            op: 'and',
            args: [
              {
                op: 'in',
                expr: { op: 'var', name: 'stage' },
                values: ['idle', 1, true],
              },
              {
                op: 'lte',
                left: {
                  op: 'add',
                  left: { op: 'var', name: 'revision' },
                  right: { op: 'lit', value: 1 },
                },
                right: {
                  op: 'sub',
                  left: { op: 'lit', value: 3 },
                  right: { op: 'lit', value: 0 },
                },
              },
              {
                op: 'eq',
                left: { op: 'lit', value: 'clean' },
                right: { op: 'lit', value: false },
              },
            ],
          },
        },
      ],
    };

    const appHtml = renderToStaticMarkup(
      createElement(App, { initialVariant: 'broken', initialShowComparison: true }),
    );
    const richEditorHtml = renderToStaticMarkup(
      createElement(PolicyEditorPane, {
        model: richModel,
        diagnostics: indexModelDiagnostics([]),
        onChangeModel: () => {},
        onImportModel: () => {},
      }),
    );

    const assertBidirectionalLabelsAndTabs = (html: string, expectedTabCount: number) => {
      const labelTargets = new Set<string>();
      for (const match of html.matchAll(/<label\b([^>]*)>/g)) {
        const attrs = match[1] ?? '';
        const forMatch = attrs.match(/\bfor="([^"]+)"/);
        expect(forMatch).not.toBeNull();
        labelTargets.add(forMatch![1]!);
      }

      const controlIds = new Set<string>();
      // Form controls plus select-only combobox triggers (WorkbenchSelect renders a button)
      for (const match of html.matchAll(
        /<(input|select|textarea)\b([^>]*)>|<button\b([^>]*\brole="combobox"[^>]*)>/g,
      )) {
        const attrs = match[2] ?? match[3] ?? '';
        const idMatch = attrs.match(/\bid="([^"]+)"/);
        expect(idMatch).not.toBeNull();
        const id = idMatch![1]!;
        expect(id.length).toBeGreaterThan(0);
        // Every control ID is unique and paired with a visible <label for="...">
        expect(controlIds.has(id)).toBe(false);
        controlIds.add(id);
        expect(labelTargets.has(id)).toBe(true);
      }

      // Every <label for="..."> targets an actual rendered control
      for (const targetId of labelTargets) {
        expect(controlIds.has(targetId)).toBe(true);
      }

      // Every role="tab" aria-controls matches an existing role="tabpanel" id in DOM
      const panelIds = new Set<string>();
      for (const match of html.matchAll(/<div\b([^>]*\brole="tabpanel"[^>]*)>/g)) {
        const attrs = match[1] ?? '';
        const idMatch = attrs.match(/\bid="([^"]+)"/);
        expect(idMatch).not.toBeNull();
        panelIds.add(idMatch![1]!);
      }
      expect(panelIds.size).toBe(expectedTabCount);

      const tabMatches = [...html.matchAll(/<button\b([^>]*\brole="tab"[^>]*)>/g)];
      expect(tabMatches).toHaveLength(expectedTabCount);
      for (const match of tabMatches) {
        const attrs = match[1] ?? '';
        const controlsMatch = attrs.match(/\baria-controls="([^"]+)"/);
        expect(controlsMatch).not.toBeNull();
        expect(panelIds.has(controlsMatch![1]!)).toBe(true);
      }
    };

    assertBidirectionalLabelsAndTabs(appHtml, 9);
    assertBidirectionalLabelsAndTabs(richEditorHtml, 5);
    expect(appHtml).toContain('id="ag-inspector-tab-trace" aria-controls="ag-inspector-panel-trace" aria-selected="true"');
    expect(appHtml).toContain('id="ag-inspector-panel-state" role="tabpanel" aria-labelledby="ag-inspector-tab-state" hidden=""');
    expect(appHtml).toContain('id="ag-inspector-panel-checks" role="tabpanel" aria-labelledby="ag-inspector-tab-checks" hidden=""');
    expect(appHtml).toContain('id="ag-inspector-panel-assumptions" role="tabpanel" aria-labelledby="ag-inspector-tab-assumptions" hidden=""');

    // Finding 8: WCAG 2.2 >= 3:1 unfocused control border token
    const tokensCss = readFileSync(new URL('../src/styles/tokens.css', import.meta.url), 'utf8');
    const workbenchCss = readFileSync(
      new URL('../src/styles/workbench.css', import.meta.url),
      'utf8',
    );
    expect(tokensCss).toContain('--color-control-border: oklch(59% 0.025 252);');
    expect(workbenchCss).toContain('border: 1px solid var(--color-control-border);');
    expect(workbenchCss).toContain('.ag-tabpanel[hidden]');
  });

  it('prunes wrapped guard drafts when converting non-and guards while preserving existing and-clause drafts', () => {
    expect(shouldPruneGuardDraftsOnAppend({ op: 'lit', value: true })).toBe(true);
    expect(shouldPruneGuardDraftsOnAppend({ op: 'var', name: 'flag' })).toBe(true);
    expect(
      shouldPruneGuardDraftsOnAppend({ op: 'not', arg: { op: 'var', name: 'flag' } }),
    ).toBe(true);
    expect(
      shouldPruneGuardDraftsOnAppend({
        op: 'or',
        args: [{ op: 'var', name: 'flag' }],
      }),
    ).toBe(true);
    expect(
      shouldPruneGuardDraftsOnAppend({
        op: 'eq',
        left: { op: 'var', name: 'revision' },
        right: { op: 'lit', value: 1 },
      }),
    ).toBe(true);
    expect(
      shouldPruneGuardDraftsOnAppend({
        op: 'gte',
        left: { op: 'var', name: 'revision' },
        right: { op: 'lit', value: 1 },
      }),
    ).toBe(true);
    expect(
      shouldPruneGuardDraftsOnAppend({
        op: 'in',
        expr: { op: 'var', name: 'stage' },
        values: ['idle'],
      }),
    ).toBe(true);
    expect(
      shouldPruneGuardDraftsOnAppend({
        op: 'and',
        args: [{ op: 'var', name: 'flag' }],
      }),
    ).toBe(false);

    expect(
      matchesDraftPrefix('rule:rule-row-1.guard.right.value', 'rule:rule-row-1.guard'),
    ).toBe(true);
    expect(
      matchesDraftPrefix('rule:rule-row-1.update:upd-row-1.value', 'rule:rule-row-1.guard'),
    ).toBe(false);

    const broken = loadPresetModel('broken');
    const gteRuleModel = updateRule(broken, 0, {
      ...broken.rules[0]!,
      guard: {
        op: 'gte',
        left: { op: 'var', name: 'revision' },
        right: { op: 'lit', value: 1 },
      },
    });
    const wrappedModel = appendRuleGuardClause(gteRuleModel, 0, {
      op: 'not',
      arg: { op: 'var', name: 'modifiedSinceApproval' },
    });
    expect(wrappedModel.rules[0]?.guard).toEqual({
      op: 'and',
      args: [
        {
          op: 'gte',
          left: { op: 'var', name: 'revision' },
          right: { op: 'lit', value: 1 },
        },
        {
          op: 'not',
          arg: { op: 'var', name: 'modifiedSinceApproval' },
        },
      ],
    });

    const extendedAndModel = appendRuleGuardClause(wrappedModel, 0, {
      op: 'var',
      name: 'approvalValid',
    });
    expect(extendedAndModel.rules[0]?.guard).toEqual({
      op: 'and',
      args: [
        {
          op: 'gte',
          left: { op: 'var', name: 'revision' },
          right: { op: 'lit', value: 1 },
        },
        {
          op: 'not',
          arg: { op: 'var', name: 'modifiedSinceApproval' },
        },
        {
          op: 'var',
          name: 'approvalValid',
        },
      ],
    });
  });

  it('exports and imports deep core-valid AST guards cleanly and handles over-budget export errors without blanking UI', () => {
    const buildNestedAndModel = (depthCount: number): TransitionSystemModel => {
      const broken = loadPresetModel('broken');
      let guard: TransitionSystemModel['rules'][number]['guard'] = { op: 'lit', value: true };
      for (let i = 0; i < depthCount; i += 1) {
        guard = { op: 'and', args: [guard] };
      }
      return updateRule(broken, 0, { ...broken.rules[0]!, guard });
    };

    const depth30Model = buildNestedAndModel(30);
    const depth31Model = buildNestedAndModel(31);
    const depth32Model = buildNestedAndModel(32);

    expect(validateModel(depth30Model)).toEqual([]);
    expect(validateModel(depth31Model)).toEqual([]);
    expect(validateModel(depth32Model)).toEqual([]);

    const exported31 = exportModelToJson(depth31Model);
    expect(importModelFromJson(exported31).ok).toBe(true);
    const exported32 = exportModelToJson(depth32Model);
    expect(importModelFromJson(exported32).ok).toBe(true);

    const depth31Html = renderToStaticMarkup(
      createElement(PolicyEditorPane, {
        model: depth31Model,
        diagnostics: indexModelDiagnostics([]),
        onChangeModel: () => {},
        onImportModel: () => {},
      }),
    );
    expect(depth31Html).not.toContain('JSON Export Failed');
    expect(depth31Html).toContain('Guard Expression');

    // Over-budget AST (> 64 nested levels) returns structured export failure and leaves editor mounted
    const overBudgetModel = buildNestedAndModel(66);
    const failedExport = tryExportModelJson(overBudgetModel);
    expect(failedExport.ok).toBe(false);
    if (!failedExport.ok) {
      expect(failedExport.error.code).toBe('JSON_EXPORT_ERROR');
      expect(failedExport.error.path).toBe('$');
    }

    const overBudgetHtml = renderToStaticMarkup(
      createElement(PolicyEditorPane, {
        model: overBudgetModel,
        diagnostics: indexModelDiagnostics(validateModel(overBudgetModel)),
        onChangeModel: () => {},
        onImportModel: () => {},
      }),
    );
    expect(overBudgetHtml).toContain('JSON Export Failed (1)');
    expect(overBudgetHtml).toContain('JSON_EXPORT_ERROR');
    expect(overBudgetHtml).toContain('Guard Expression');
  });

  it('pre-validates raw JSON number tokens before JSON.parse and rejects malformed syntax via JSON_PARSE_ERROR', () => {
    const broken = loadPresetModel('broken');
    const validJson = exportModelToJson(broken);
    const parseSpy = vi.spyOn(JSON, 'parse');

    try {
      const disallowedPayloads: readonly { readonly json: string; readonly code: string }[] = [
        {
          json: validJson.replace('"max": 3', '"max": 1.00000000000000001'),
          code: 'NON_INTEGER_JSON_NUMBER',
        },
        {
          json: validJson.replace('"max": 3', '"max": 1.0'),
          code: 'NON_INTEGER_JSON_NUMBER',
        },
        {
          json: validJson.replace('"max": 3', '"max": 1e2'),
          code: 'NON_INTEGER_JSON_NUMBER',
        },
        {
          json: validJson.replace('"max": 3', '"max": 9007199254740993'),
          code: 'UNSAFE_INTEGER_JSON_NUMBER',
        },
        {
          json: validJson.replace('"max": 3', '"max": -9007199254740993'),
          code: 'UNSAFE_INTEGER_JSON_NUMBER',
        },
      ];

      for (const sample of disallowedPayloads) {
        const res = importModelFromJson(sample.json);
        expect(res.ok).toBe(false);
        if (!res.ok) {
          expect(res.errors.some((e) => e.code === sample.code)).toBe(true);
        }
      }
      expect(parseSpy).toHaveBeenCalledTimes(0);

      const malformedSamples = [
        '{"a": -}',
        '{"a": 01}',
        '{"a": 1.}',
        '{"a": 1e}',
        '{"a": --1}',
        '{"a": 1.2.3}',
        '{"a": 123abc}',
        '{"a": "unterminated 1.5',
      ];
      for (const raw of malformedSamples) {
        const res = importModelFromJson(raw);
        expect(res.ok).toBe(false);
        if (!res.ok) {
          expect(res.errors[0]?.code).toBe('JSON_PARSE_ERROR');
        }
      }
    } finally {
      parseSpy.mockRestore();
    }

    // Strict duplicate-key rejection replaces the legacy last-value import quirk
    const dupNameJson = validJson.replace(
      `"name": ${JSON.stringify(broken.name)},`,
      `"name": "Legacy First",\n  "name": "Legacy Second",`,
    );
    const dupImport = importModelFromJson(dupNameJson);
    expect(dupImport.ok).toBe(false);
    if (!dupImport.ok) {
      expect(dupImport.errors[0]?.code).toBe('DUPLICATE_JSON_KEY');
      expect(dupImport.errors[0]?.path).toBe('$');
    }

    const oversizedCommonValidModel: TransitionSystemModel = {
      ...broken,
      assumptions: [
        {
          id: 'asm_oversized',
          category: 'scope',
          statement: 'X'.repeat(540_000),
          notModeled: 'Timing',
        },
      ],
    };
    expect(validateModel(oversizedCommonValidModel)).toEqual([]);
    const commonExportFail = tryExportModelJson(oversizedCommonValidModel);
    expect(commonExportFail.ok).toBe(false);
    if (!commonExportFail.ok) {
      expect(commonExportFail.error.code).toBe('JSON_EXPORT_ERROR');
    }

    // Shared codec semantics replace the v0.4.0 legacy compatibility quirks:
    // 1. Non-enumerable dense rule slots on an object candidate are rejected
    const rulesWithNonEnumSlot = [...broken.rules];
    Object.defineProperty(rulesWithNonEnumSlot, 0, {
      value: structuredClone(broken.rules[0]!),
      enumerable: false,
      writable: true,
      configurable: true,
    });
    const nonEnumSlotCandidate: TransitionSystemModel = {
      ...broken,
      rules: rulesWithNonEnumSlot,
    };
    const nonEnumValueRes = validateImportedModelValue(nonEnumSlotCandidate);
    expect(nonEnumValueRes.ok).toBe(false);
    if (!nonEnumValueRes.ok) {
      expect(nonEnumValueRes.errors.some((e) => e.code === 'UNSUPPORTED_PROPERTY')).toBe(true);
    }
    expect(importModelFromJson(nonEnumSlotCandidate).ok).toBe(false);

    // 2. Malformed trailing comma reports JSON_PARSE_ERROR before number diagnostics
    const nonIntWithTrailingComma = importModelFromJson('{"x": 1.5,}');
    expect(nonIntWithTrailingComma.ok).toBe(false);
    if (!nonIntWithTrailingComma.ok) {
      expect(nonIntWithTrailingComma.errors[0]?.code).toBe('JSON_PARSE_ERROR');
    }

    // 3. Strict shared limits: 512_000 characters and maxRawNesting 256
    expect(DEFAULT_MODEL_JSON_LIMITS.maxChars).toBe(512_000);
    expect(DEFAULT_MODEL_JSON_LIMITS.maxRawNesting).toBe(256);
    const nested257 = `${'['.repeat(257)}${']'.repeat(257)}`;
    const deepJsonResult = importModelFromJson(nested257);
    expect(deepJsonResult.ok).toBe(false);
    if (!deepJsonResult.ok) {
      expect(deepJsonResult.errors[0]?.code).toBe('IMPORT_COMPLEXITY_EXCEEDED');
    }
  });

  it('prevents non-Boolean quick-clause corruption, deduplicates violation/shortcut UI, and ships self-hosted Light/Dark tokens', () => {
    const intEnumModel: TransitionSystemModel = {
      id: 'int-enum-policy',
      name: 'Integer and Enum Only Policy',
      schema: {
        revision: { kind: 'int', min: 0, max: 3 },
        stage: { kind: 'enum', values: ['draft', 'published'] },
      },
      initialState: {
        revision: 0,
        stage: 'draft',
      },
      rules: [
        {
          id: 'publish_step',
          label: 'Publish revision',
          guard: {
            op: 'gte',
            left: { op: 'var', name: 'revision' },
            right: { op: 'lit', value: 1 },
          },
          updates: [{ var: 'stage', value: { op: 'lit', value: 'published' } }],
        },
      ],
      invariants: [
        {
          id: 'inv_stage_revision',
          label: 'Published requires revision >= 1',
          holds: {
            op: 'or',
            args: [
              { op: 'neq', left: { op: 'var', name: 'stage' }, right: { op: 'lit', value: 'published' } },
              { op: 'gte', left: { op: 'var', name: 'revision' }, right: { op: 'lit', value: 1 } },
            ],
          },
        },
      ],
      assumptions: [
        {
          id: 'asm_int_enum',
          category: 'scope',
          statement: 'Non-boolean schema test.',
          notModeled: 'External state.',
        },
      ],
    };

    expect(validateModel(intEnumModel)).toEqual([]);
    expect(
      resolveQuickBooleanVariable(['revision', 'stage'], intEnumModel.schema, 'revision'),
    ).toBe('');

    const intEnumEditorHtml = renderToStaticMarkup(
      createElement(PolicyEditorPane, {
        model: intEnumModel,
        diagnostics: indexModelDiagnostics([]),
        onChangeModel: () => {},
        onImportModel: () => {},
      }),
    );
    expect(intEnumEditorHtml).not.toContain('quick-clause-var');
    expect(intEnumEditorHtml).not.toContain('+ Append');

    // Broken preset: VIOLATED verdict shows non-competing witness note, no duplicate Violated Invariants line,
    // candidate repair action, persistent rule navigator selection, trace-to-rule jump action, and no duplicate !modifiedSinceApproval button
    const brokenAppHtml = renderToStaticMarkup(createElement(App, { initialVariant: 'broken' }));
    expect(brokenAppHtml).toContain('Goal witnessed on valid prefix');
    expect(brokenAppHtml).not.toContain('Violated Invariants:</strong>');
    expect(brokenAppHtml).toContain('Violated invariants: inv_no_confidential_publish.');
    expect(brokenAppHtml).toContain('Inspect candidate repair');
    const publishRowStart = brokenAppHtml.indexOf(
      'class="ag-item-row ag-rule-detail" data-rule-id="publish_release_notes"',
    );
    expect(publishRowStart).toBeGreaterThan(-1);
    const publishRowSlice = brokenAppHtml.slice(publishRowStart);
    expect(publishRowSlice).toContain('+ Add !modifiedSinceApproval');
    expect(publishRowSlice).not.toContain('+ Append !modifiedSinceApproval');
    expect(brokenAppHtml).toContain(
      'data-rule-id="publish_release_notes" data-selected="true" aria-pressed="true"',
    );
    expect(brokenAppHtml).toContain('aria-label="Inspect rule publish_release_notes in editor"');
    expect(brokenAppHtml).toContain('aria-label="Color theme"');

    // Tokens CSS self-hosts WOFF2 subsets for IBM Plex Sans & Mono and defines Light + Dark themes
    const tokensCss = readFileSync(new URL('../src/styles/tokens.css', import.meta.url), 'utf8');
    expect(tokensCss).toContain("font-family: 'IBM Plex Sans'");
    expect(tokensCss).toContain("font-family: 'IBM Plex Mono'");
    expect(tokensCss).toContain('.woff2');
    expect(tokensCss).not.toMatch(/https?:\/\//i);
    expect(tokensCss).toContain("color-scheme: light;");
    expect(tokensCss).toContain("color-scheme: dark;");

    // Regression: rule named `constructor` (or `toString`) never reads Object.prototype in PolicyEditorPane
    const protoNamedRuleModel: TransitionSystemModel = {
      ...loadPresetModel('broken'),
      rules: [
        ...loadPresetModel('broken').rules,
        {
          id: 'constructor',
          label: 'Object prototype collision probe',
          guard: { op: 'lit', value: false },
          updates: [],
        },
      ],
    };
    expect(validateModel(protoNamedRuleModel)).toEqual([]);
    const traceMap = new Map<string, readonly number[]>([['publish_release_notes', [5]]]);
    const protoEditorHtml = renderToStaticMarkup(
      createElement(PolicyEditorPane, {
        model: protoNamedRuleModel,
        diagnostics: indexModelDiagnostics([]),
        activeTraceStepsByRuleId: traceMap,
        onChangeModel: () => {},
        onImportModel: () => {},
      }),
    );
    expect(protoEditorHtml).toContain('data-rule-id="constructor"');
    expect(protoEditorHtml).toContain('s5');
  });
});
