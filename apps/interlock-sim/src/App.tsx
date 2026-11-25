import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  validateModel,
  validateOptions,
  type TransitionSystemModel,
  type ValidationError,
  type VerifyOptions,
  type VerifyResult,
} from '@rulecanvas/core';
import {
  applyManualStep,
  buildVerdictSummaryView,
  createVerdictReplaySession,
  jumpReplayToStep,
  resetReplaySession,
  stepReplayBackward,
  stepReplayForward,
  type ReplaySession,
} from '@rulecanvas/ui';
import {
  WorkbenchNavigation,
  readPresetFromSearch,
  useVerificationSnapshot,
  useWorkbenchRoute,
  type WorkbenchNavLink,
} from '@rulecanvas/workbench-react';
import { DEFAULT_VERIFY_OPTIONS, runInterlockPresetComparison } from './comparison.js';
import { AirlockSchematic } from './components/AirlockSchematic.js';
import { ComparisonPanel } from './components/ComparisonPanel.js';
import { InterlockRuleEditor } from './components/InterlockRuleEditor.js';
import { OperatorConsole } from './components/OperatorConsole.js';
import {
  VerificationWorkbenchPane,
} from './components/VerificationWorkbenchPane.js';
import { indexModelDiagnostics, parseStrictIntegerDraft } from './model-inspector.js';
import {
  INTERLOCK_SIM_PRESETS,
  getInterlockPresetDescriptor,
  loadInterlockPresetModel,
  type InterlockPresetVariant,
} from './presets.js';
import { createAppVerifyClient, type WorkerFactory } from './verify-client.js';

export interface AppProps {
  readonly initialVariant?: InterlockPresetVariant;
  readonly initialShowComparison?: boolean;
  readonly workerFactory?: WorkerFactory;
}

function buildVerdictSession(
  model: TransitionSystemModel,
  result: VerifyResult,
):
  | { readonly ok: true; readonly session: ReplaySession | null }
  | { readonly ok: false; readonly message: string } {
  if (result.status === 'INVALID') {
    return { ok: true, session: null };
  }
  const fromVerdict = createVerdictReplaySession(model, result, { startAt: 'terminal' });
  if (!fromVerdict.ok) {
    return {
      ok: false,
      message:
        fromVerdict.errors[0]?.message ??
        'Verification verdict failed replay consistency check against the captured model.',
    };
  }
  return { ok: true, session: fromVerdict.session };
}

function resolveAllowedNavPrefix(baseUrl: string): string | undefined {
  const normalized = baseUrl.replace(/\/+$/, '');
  const lastSlash = normalized.lastIndexOf('/');
  if (lastSlash <= 0) return undefined;
  return normalized.slice(0, lastSlash);
}

const ALLOWED_NAV_PREFIX = resolveAllowedNavPrefix(
  (typeof import.meta !== 'undefined' &&
    (import.meta as { readonly env?: { readonly BASE_URL?: string } }).env?.BASE_URL) ||
    '/',
);

function resolveModelLabel(
  model: TransitionSystemModel,
  preset: InterlockPresetVariant | null,
): string {
  if (preset !== null) {
    return getInterlockPresetDescriptor(preset).shortLabel;
  }
  const trimmedName = model.name.trim();
  if (trimmedName.length > 0) return trimmedName;
  const trimmedId = model.id.trim();
  return trimmedId.length > 0 ? trimmedId : 'Custom Interlock Model';
}

const ALLOWED_INTERLOCK_PRESETS: readonly InterlockPresetVariant[] = ['broken', 'fixed', 'vacuous'];

const WORKBENCH_NAV_LINKS: readonly WorkbenchNavLink[] = [
  {
    id: 'agent-gate',
    label: 'AgentGate',
    href:
      typeof import.meta !== 'undefined' &&
      typeof (import.meta as { env?: Record<string, string | undefined> }).env?.['VITE_AGENT_GATE_URL'] ===
        'string'
        ? (import.meta as { env: Record<string, string> }).env['VITE_AGENT_GATE_URL']!
        : '../agent-gate/',
    description: 'Open AgentGate policy verification workbench',
  },
  {
    id: 'interlock-sim',
    label: 'InterlockSim',
    href: './',
    description: 'Current BSL-3 airlock interlock simulation workbench',
  },
];

export function App({
  initialVariant,
  initialShowComparison = false,
  workerFactory,
}: AppProps) {
  const resolvedInitialVariant: InterlockPresetVariant =
    initialVariant ??
    (typeof window !== 'undefined'
      ? readPresetFromSearch(window.location.search, ALLOWED_INTERLOCK_PRESETS, 'broken').preset
      : 'broken');

  const initialModelRef = useRef<TransitionSystemModel | null>(null);
  if (initialModelRef.current === null) {
    initialModelRef.current = loadInterlockPresetModel(resolvedInitialVariant);
  }
  const [activePreset, setActivePreset] = useState<InterlockPresetVariant | null>(
    resolvedInitialVariant,
  );
  const [model, setModel] = useState<TransitionSystemModel>(() => initialModelRef.current!);
  const [editorResetKey, setEditorResetKey] = useState<number>(0);

  const [maxStatesText, setMaxStatesText] = useState<string>(
    String(DEFAULT_VERIFY_OPTIONS.maxStates),
  );
  const [maxDepthText, setMaxDepthText] = useState<string>(String(DEFAULT_VERIFY_OPTIONS.maxDepth));
  const [editorDraftErrorMap, setEditorDraftErrorMap] = useState<Readonly<Record<string, string>>>(
    {},
  );

  const modelRevisionRef = useRef(0);
  const createClient = useCallback(() => createAppVerifyClient(workerFactory), [workerFactory]);
  const {
    snapshot: verifiedSnapshot,
    replaySession,
    setReplaySession,
    isRunning,
    runningExecutionMode,
    transportError: workerError,
    run: runSnapshot,
    clear: clearVerification,
    invalidatePending,
    cancel,
    isPending,
  } = useVerificationSnapshot({
    initialRequest: {
      model: initialModelRef.current,
      options: DEFAULT_VERIFY_OPTIONS,
      label: getInterlockPresetDescriptor(resolvedInitialVariant).shortLabel,
      revision: 0,
    },
    createClient,
  });
  const [cancelledNotice, setCancelledNotice] = useState<string | null>(null);
  const [replayError, setReplayError] = useState<string | null>(null);
  const [jsonDraftDirty, setJsonDraftDirty] = useState<boolean>(false);

  const latestModelRef = useRef<TransitionSystemModel>(model);
  latestModelRef.current = model;
  const latestActivePresetRef = useRef<InterlockPresetVariant | null>(activePreset);
  latestActivePresetRef.current = activePreset;
  const latestEditorDraftErrorMapRef = useRef<Readonly<Record<string, string>>>(
    editorDraftErrorMap,
  );
  latestEditorDraftErrorMapRef.current = editorDraftErrorMap;
  const stayHereButtonRef = useRef<HTMLButtonElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  const [showComparison, setShowComparison] = useState<boolean>(initialShowComparison);
  const lastValidBoundsRef = useRef<VerifyOptions>(DEFAULT_VERIFY_OPTIONS);

  const maxStatesParsed = useMemo(() => parseStrictIntegerDraft(maxStatesText), [maxStatesText]);
  const maxDepthParsed = useMemo(() => parseStrictIntegerDraft(maxDepthText), [maxDepthText]);

  const parsedOptions = useMemo((): VerifyOptions | null => {
    if (!maxStatesParsed.ok || !maxDepthParsed.ok) {
      return null;
    }
    return {
      maxStates: maxStatesParsed.value,
      maxDepth: maxDepthParsed.value,
    };
  }, [maxStatesParsed, maxDepthParsed]);

  const optionErrors = useMemo((): readonly ValidationError[] => {
    const errs: ValidationError[] = [];
    if (!maxStatesParsed.ok) {
      errs.push({
        code: 'INVALID_INTEGER_DRAFT',
        path: 'options.maxStates',
        message: maxStatesParsed.message,
      });
    }
    if (!maxDepthParsed.ok) {
      errs.push({
        code: 'INVALID_INTEGER_DRAFT',
        path: 'options.maxDepth',
        message: maxDepthParsed.message,
      });
    }

    const coreCheck = validateOptions({
      maxStates: maxStatesParsed.ok ? maxStatesParsed.value : DEFAULT_VERIFY_OPTIONS.maxStates,
      maxDepth: maxDepthParsed.ok ? maxDepthParsed.value : DEFAULT_VERIFY_OPTIONS.maxDepth,
    });
    for (const err of coreCheck) {
      if (err.path === 'options.maxStates' && !maxStatesParsed.ok) continue;
      if (err.path === 'options.maxDepth' && !maxDepthParsed.ok) continue;
      errs.push(err);
    }
    return errs;
  }, [maxStatesParsed, maxDepthParsed]);

  const maxStatesInvalid = optionErrors.some((e) => e.path === 'options.maxStates');
  const maxDepthInvalid = optionErrors.some((e) => e.path === 'options.maxDepth');

  const editorDraftErrors = useMemo((): readonly ValidationError[] => {
    return Object.entries(editorDraftErrorMap).map(([path, message]) => ({
      code: 'INVALID_INTEGER_DRAFT',
      path,
      message,
    }));
  }, [editorDraftErrorMap]);

  const hasEditorDraftErrors = editorDraftErrors.length > 0;
  const modelErrors = useMemo(() => validateModel(model), [model]);
  const diagnostics = useMemo(() => indexModelDiagnostics(modelErrors), [modelErrors]);

  const isStale =
    verifiedSnapshot !== null &&
    (verifiedSnapshot.revision !== modelRevisionRef.current ||
      parsedOptions === null ||
      verifiedSnapshot.options.maxStates !== parsedOptions.maxStates ||
      verifiedSnapshot.options.maxDepth !== parsedOptions.maxDepth ||
      optionErrors.length > 0 ||
      hasEditorDraftErrors);

  if (parsedOptions !== null && optionErrors.length === 0) {
    lastValidBoundsRef.current = parsedOptions;
  }
  const comparisonBounds =
    parsedOptions !== null && optionErrors.length === 0
      ? parsedOptions
      : lastValidBoundsRef.current;
  const comparisonBoundsInvalid = parsedOptions === null || optionErrors.length > 0;

  const comparisonRows = useMemo(
    () => (showComparison ? runInterlockPresetComparison(comparisonBounds) : []),
    [showComparison, comparisonBounds.maxStates, comparisonBounds.maxDepth],
  );

  const topVerdictSummary = useMemo(
    () => (verifiedSnapshot !== null ? buildVerdictSummaryView(verifiedSnapshot.result) : null),
    [verifiedSnapshot],
  );

  const runVerification = (
    targetModel: TransitionSystemModel,
    targetLabel: string,
    targetOptions: VerifyOptions | null,
    targetOptionErrors: readonly ValidationError[],
    targetDraftErrors: readonly ValidationError[],
  ) => {
    setCancelledNotice(null);
    setReplayError(null);

    if (targetOptions === null ||
      targetOptionErrors.length > 0 ||
      targetDraftErrors.length > 0 ||
      validateModel(targetModel).length > 0) {
      clearVerification();
      return;
    }
    runSnapshot({
      model: targetModel,
      options: targetOptions,
      label: targetLabel,
      revision: modelRevisionRef.current,
      restartWorker: true,
    });
  };

  const handleLoadPreset = (variant: InterlockPresetVariant) => {
    const nextModel = loadInterlockPresetModel(variant);
    const presetInfo = getInterlockPresetDescriptor(variant);

    clearVerification();
    modelRevisionRef.current += 1;
    latestEditorDraftErrorMapRef.current = {};
    setEditorDraftErrorMap({});
    setJsonDraftDirty(false);
    setEditorResetKey((prev) => prev + 1);

    latestActivePresetRef.current = variant;
    latestModelRef.current = nextModel;
    setActivePreset(variant);
    setModel(nextModel);
    runVerification(nextModel, presetInfo.shortLabel, parsedOptions, optionErrors, []);
  };

  const handleChangeModel = (nextModel: TransitionSystemModel) => {
    const wasRunning = isPending();
    invalidatePending();
    if (wasRunning) {
      setCancelledNotice('In-flight verification cancelled because the interlock model was edited.');
    }
    modelRevisionRef.current += 1;
    latestModelRef.current = nextModel;
    latestActivePresetRef.current = null;
    setModel(nextModel);
    setActivePreset(null);
  };

  const handleImportModel = (importedModel: TransitionSystemModel) => {
    const importedLabel = resolveModelLabel(importedModel, null);

    clearVerification();
    modelRevisionRef.current += 1;
    latestEditorDraftErrorMapRef.current = {};
    setEditorDraftErrorMap({});
    setJsonDraftDirty(false);
    setEditorResetKey((prev) => prev + 1);

    latestActivePresetRef.current = null;
    latestModelRef.current = importedModel;
    setActivePreset(null);
    setModel(importedModel);
    runVerification(importedModel, importedLabel, parsedOptions, optionErrors, []);
  };

  const handleBoundsEdit = (kind: 'maxStates' | 'maxDepth', rawValue: string) => {
    const wasRunning = isPending();
    invalidatePending();
    if (wasRunning) {
      setCancelledNotice(
        'In-flight verification cancelled because exploration bounds were modified.',
      );
    }
    if (kind === 'maxStates') {
      setMaxStatesText(rawValue);
    } else {
      setMaxDepthText(rawValue);
    }
  };

  const handleEditorDraftErrorChange = useCallback(
    (fieldKey: string, errorMessage: string | null) => {
      if (errorMessage === null) {
        if (fieldKey in latestEditorDraftErrorMapRef.current) {
          const next = { ...latestEditorDraftErrorMapRef.current };
          delete next[fieldKey];
          latestEditorDraftErrorMapRef.current = next;
          setEditorDraftErrorMap(next);
        }
      } else if (latestEditorDraftErrorMapRef.current[fieldKey] !== errorMessage) {
        const next = { ...latestEditorDraftErrorMapRef.current, [fieldKey]: errorMessage };
        latestEditorDraftErrorMapRef.current = next;
        setEditorDraftErrorMap(next);
      }
      if (errorMessage !== null && isPending()) {
        invalidatePending();
        setCancelledNotice(
          'In-flight verification cancelled because an editor numeric draft was modified.',
        );
      }
    },
    [invalidatePending, isPending],
  );

  const handleCancelRun = () => {
    cancel();
    setCancelledNotice('Verification run cancelled before completion.');
  };

  const handleVerifyCurrent = () => {
    const syncModel = latestModelRef.current;
    const syncPreset = latestActivePresetRef.current;
    const syncDraftErrors: ValidationError[] = Object.entries(
      latestEditorDraftErrorMapRef.current,
    ).map(([path, message]) => ({
      code: 'INVALID_INTEGER_DRAFT',
      path,
      message,
    }));
    runVerification(
      syncModel,
      resolveModelLabel(syncModel, syncPreset),
      parsedOptions,
      optionErrors,
      syncDraftErrors,
    );
  };

  const handleResetReplay = () => {
    if (replaySession === null) return;
    const res = resetReplaySession(replaySession);
    if (res.ok) {
      setReplaySession(res.session);
      setReplayError(null);
    } else {
      setReplayError(res.error.message);
    }
  };

  const handleStepBack = () => {
    if (replaySession === null) return;
    const res = stepReplayBackward(replaySession);
    if (res.ok) {
      setReplaySession(res.session);
      setReplayError(null);
    } else {
      setReplayError(res.error.message);
    }
  };

  const handleStepForward = () => {
    if (replaySession === null) return;
    const res = stepReplayForward(replaySession);
    if (res.ok) {
      setReplaySession(res.session);
      setReplayError(null);
    } else {
      setReplayError(res.error.message);
    }
  };

  const handleJumpToStep = (stepIndex: number) => {
    if (replaySession === null) return;
    const res = jumpReplayToStep(replaySession, stepIndex);
    if (res.ok) {
      setReplaySession(res.session);
      setReplayError(null);
    } else {
      setReplayError(res.error.message);
    }
  };

  const handleApplyManualStep = (ruleId: string) => {
    if (replaySession === null) return;
    const res = applyManualStep(replaySession, ruleId);
    if (res.ok) {
      setReplaySession(res.session);
      setReplayError(null);
    } else {
      setReplayError(res.error.message);
    }
  };

  const handleRestoreVerdictTrace = () => {
    if (verifiedSnapshot === null) return;
    const restored = buildVerdictSession(verifiedSnapshot.model, verifiedSnapshot.result);
    if (!restored.ok) {
      setReplayError(restored.message);
      return;
    }
    setReplaySession(restored.session);
    setReplayError(null);
  };

  const activePresetInfo = activePreset !== null ? getInterlockPresetDescriptor(activePreset) : null;
  const hasAnyValidationErrors =
    optionErrors.length > 0 || editorDraftErrors.length > 0 || modelErrors.length > 0;
  const isDirtyEditor = activePreset === null || editorDraftErrors.length > 0 || jsonDraftDirty;

  const { pendingPrompt, selectPreset, requestLinkNavigation, acceptPrompt, declinePrompt } =
    useWorkbenchRoute<InterlockPresetVariant>({
      allowedPresets: ALLOWED_INTERLOCK_PRESETS,
      defaultPreset: 'broken',
      isDirty: isDirtyEditor,
      onCommitPreset: handleLoadPreset,
      formatPresetLabel: (preset) => getInterlockPresetDescriptor(preset).shortLabel,
    });

  useEffect(() => {
    if (pendingPrompt !== null) {
      if (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement) {
        previousFocusRef.current = document.activeElement;
      }
      stayHereButtonRef.current?.focus();
    } else if (previousFocusRef.current !== null) {
      const target = previousFocusRef.current;
      previousFocusRef.current = null;
      if (target.isConnected) {
        target.focus();
      }
    }
  }, [pendingPrompt !== null]);

  return (
    <div className="is-shell">
      <header className="is-topbar">
        <div className="is-brand">
          <h1 className="is-brand-title">
            <span className="is-brand-mark" aria-hidden="true" />
            InterlockSim
          </h1>
          <span className="is-brand-subtitle">
            Discrete BSL-3 airlock interlock simulation &amp; bounded verification workbench
          </span>
          <WorkbenchNavigation
            current="interlock-sim"
            links={WORKBENCH_NAV_LINKS}
            allowedPrefix={ALLOWED_NAV_PREFIX}
            ariaLabel="RuleCanvasKit workbenches"
            className="is-wb-nav"
            listClassName="is-wb-nav-list"
            linkClassName="is-wb-nav-link"
            activeLinkClassName="is-wb-nav-link-active"
            onNavigate={(link, event) => {
              if (isDirtyEditor) {
                event.preventDefault();
                requestLinkNavigation(link.href, link.label);
              }
            }}
          />
        </div>

        <div className="is-topbar-controls">
          <div className="is-control-field">
            <label htmlFor="preset-select">Preset</label>
            <select
              id="preset-select"
              className="is-select"
              value={activePreset ?? 'custom'}
              onChange={(e) => {
                const val = e.target.value;
                if (val !== 'custom') {
                  selectPreset(val as InterlockPresetVariant);
                }
              }}
            >
              {activePreset === null && <option value="custom">Custom / Edited Interlock</option>}
              {INTERLOCK_SIM_PRESETS.map((preset) => (
                <option key={preset.variant} value={preset.variant}>
                  {preset.shortLabel}
                </option>
              ))}
            </select>
          </div>

          <div className="is-control-field">
            <label htmlFor="max-states-input">maxStates</label>
            <input
              id="max-states-input"
              type="text"
              inputMode="numeric"
              className="is-input is-input-num"
              aria-invalid={maxStatesInvalid ? 'true' : undefined}
              value={maxStatesText}
              onChange={(e) => handleBoundsEdit('maxStates', e.target.value)}
            />
          </div>

          <div className="is-control-field">
            <label htmlFor="max-depth-input">maxDepth</label>
            <input
              id="max-depth-input"
              type="text"
              inputMode="numeric"
              className="is-input is-input-num"
              aria-invalid={maxDepthInvalid ? 'true' : undefined}
              value={maxDepthText}
              onChange={(e) => handleBoundsEdit('maxDepth', e.target.value)}
            />
          </div>

          {isRunning ? (
            <span className="is-badge" data-tone="running" role="status">
              <span aria-hidden="true">…</span> RUNNING
            </span>
          ) : verifiedSnapshot !== null && topVerdictSummary !== null ? (
            <span
              className="is-badge"
              data-status={topVerdictSummary.status}
              data-tone={isStale ? 'warning' : topVerdictSummary.tone}
              role="status"
            >
              {isStale ? (
                <>
                  <span aria-hidden="true">!</span> OUTDATED: {topVerdictSummary.badge}
                </>
              ) : (
                <>
                  <span aria-hidden="true">{topVerdictSummary.symbol}</span>{' '}
                  {topVerdictSummary.badge}
                </>
              )}
            </span>
          ) : hasAnyValidationErrors ? (
            <span className="is-badge" data-status="INVALID" data-tone="error" role="status">
              <span aria-hidden="true">!</span> INVALID
            </span>
          ) : cancelledNotice !== null ? (
            <span className="is-badge" data-tone="warning" role="status">
              <span aria-hidden="true">!</span> CANCELLED
            </span>
          ) : workerError !== null ? (
            <span className="is-badge" data-tone="error" role="status">
              <span aria-hidden="true">!</span> ERROR
            </span>
          ) : (
            <span className="is-badge" data-tone="warning" role="status">
              <span aria-hidden="true">○</span> NOT VERIFIED
            </span>
          )}

          <button type="button" className="is-btn is-btn-primary" onClick={handleVerifyCurrent}>
            Verify Interlock Model
          </button>

          <button
            type="button"
            className={showComparison ? 'is-btn is-btn-active' : 'is-btn'}
            aria-expanded={showComparison}
            onClick={() => setShowComparison((prev) => !prev)}
          >
            Compare Presets (3)
          </button>
        </div>
      </header>

      {/* Unsaved-changes discard confirmation dialog */}
      {pendingPrompt !== null && (
        <div
          className="is-discard-banner"
          role="alertdialog"
          aria-labelledby="is-discard-title"
          aria-describedby="is-discard-desc"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              declinePrompt();
            }
          }}
        >
          <div>
            <strong id="is-discard-title">Unsaved Custom Edits</strong>
            <p id="is-discard-desc">
              {pendingPrompt.label} will discard your current unsaved custom edits.
            </p>
          </div>
          <div className="is-inline-actions">
            <button
              ref={stayHereButtonRef}
              type="button"
              className="is-btn is-btn-sm"
              onClick={declinePrompt}
            >
              Stay Here
            </button>
            <button
              type="button"
              className="is-btn is-btn-sm is-btn-primary"
              onClick={acceptPrompt}
            >
              Discard &amp; Continue
            </button>
          </div>
        </div>
      )}

      {/* Permanent Educational & Non-Certification Disclaimer Bar */}
      <div className="is-safety-strip" role="note" aria-label="Simulation scope and non-certification notice">
        <span>
          <strong>{activePresetInfo !== null ? activePresetInfo.title : model.name}</strong>
          {activePresetInfo !== null
            ? `: ${activePresetInfo.summary}`
            : ': Custom edited discrete interlock configuration.'}
        </span>

        <div className="is-disclaimer-callout">
          <strong>Educational Simulation Only (Not IEC 61508 / SIL Certified):</strong> Excludes
          continuous pressure decay, HVAC airflow turbulence, sensor faults, mechanical seal failure,
          and physical containment certification.
        </div>
      </div>

      {showComparison && (
        <ComparisonPanel
          rows={comparisonRows}
          bounds={comparisonBounds}
          boundsHasErrors={comparisonBoundsInvalid}
          activeVariant={activePreset}
          onLoadPreset={selectPreset}
          onClose={() => setShowComparison(false)}
        />
      )}

      <main className="is-workspace">
        <div className="is-column is-column-left">
          <AirlockSchematic
            schema={replaySession?.model.schema ?? model.schema}
            state={replaySession?.currentState ?? model.initialState}
            changedVars={replaySession?.changedVars ?? []}
            violatedInvariantIds={replaySession?.violatedInvariantIds ?? []}
            evaluatedInvariantIds={
              replaySession !== null ? replaySession.model.invariants.map((inv) => inv.id) : []
            }
            invariants={replaySession !== null ? replaySession.model.invariants : model.invariants}
            goal={replaySession !== null ? replaySession.model.goal : model.goal}
            isEvaluated={replaySession !== null}
            goalReached={replaySession?.goalReached}
            stepNumber={replaySession?.cursor ?? 0}
            modeLabel={
              replaySession === null
                ? 'Initial State Preview (Unverified)'
                : replaySession.mode === 'trace'
                  ? 'Trace Replay'
                  : 'Manual Simulation'
            }
          />

          {!isRunning && verifiedSnapshot !== null && replaySession !== null ? (
            <OperatorConsole
              replaySession={replaySession}
              snapshotModel={verifiedSnapshot.model}
              modelLabel={verifiedSnapshot.modelLabel}
              isStale={isStale}
              canRestoreCounterexample={verifiedSnapshot.result.status === 'VIOLATED'}
              replayError={replayError}
              onResetReplay={handleResetReplay}
              onStepBack={handleStepBack}
              onStepForward={handleStepForward}
              onApplyManualStep={handleApplyManualStep}
              onRestoreVerdictTrace={handleRestoreVerdictTrace}
            />
          ) : (
            <section className="is-pane" aria-label="Operator simulation console">
              <div className="is-pane-header">
                <div>
                  <h2 className="is-pane-title">Operator Simulation Console</h2>
                  <p className="is-pane-subtitle">
                    Run Verify Interlock Model to activate engine-authorized transition actuators and blocked-guard explanations.
                  </p>
                </div>
                {!isRunning && (
                  <button
                    type="button"
                    className="is-btn is-btn-sm is-btn-primary"
                    onClick={handleVerifyCurrent}
                  >
                    Verify Interlock Model
                  </button>
                )}
              </div>
            </section>
          )}
        </div>

        <div className="is-column">
          <VerificationWorkbenchPane
            model={model}
            isRunning={isRunning}
            runningExecutionMode={runningExecutionMode}
            isStale={isStale}
            workerError={workerError}
            cancelledNotice={cancelledNotice}
            optionErrors={optionErrors}
            editorDraftErrors={editorDraftErrors}
            modelErrors={modelErrors}
            verifiedSnapshot={verifiedSnapshot}
            replaySession={replaySession}
            onCancelRun={handleCancelRun}
            onVerifyNow={handleVerifyCurrent}
            onJumpToStep={handleJumpToStep}
          />

          <InterlockRuleEditor
            model={model}
            diagnostics={diagnostics}
            resetKey={editorResetKey}
            onChangeModel={handleChangeModel}
            onImportModel={handleImportModel}
            onDraftErrorChange={handleEditorDraftErrorChange}
            onJsonDraftDirtyChange={setJsonDraftDirty}
          />
        </div>
      </main>
    </div>
  );
}
