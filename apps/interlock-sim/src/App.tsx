import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  validateModel,
  validateOptions,
  verifyModel,
  type TransitionSystemModel,
  type ValidationError,
  type VerifyOptions,
  type VerifyResult,
} from '@rulecanvas/core';
import {
  applyManualStep,
  buildVerdictSummaryView,
  createManualSimulationSession,
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
  type VerifiedSnapshot,
} from './components/VerificationWorkbenchPane.js';
import { indexModelDiagnostics, parseStrictIntegerDraft } from './model-inspector.js';
import {
  INTERLOCK_SIM_PRESETS,
  getInterlockPresetDescriptor,
  loadInterlockPresetModel,
  type InterlockPresetVariant,
} from './presets.js';
import {
  VerifyWorkerClient,
  isWebWorkerSupported,
  type VerifyExecutionMode,
  type WorkerFactory,
} from './verify-client.js';

export interface AppProps {
  readonly initialVariant?: InterlockPresetVariant;
  readonly initialShowComparison?: boolean;
  readonly workerFactory?: WorkerFactory;
}

function buildInitialSession(
  model: TransitionSystemModel,
  result: VerifyResult,
): ReplaySession | null {
  const fromVerdict = createVerdictReplaySession(model, result, { startAt: 'terminal' });
  if (fromVerdict.ok) {
    return fromVerdict.session;
  }
  const manual = createManualSimulationSession(model);
  return manual.ok ? manual.session : null;
}

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
  const initialResultRef = useRef<VerifyResult | null>(null);
  if (initialResultRef.current === null) {
    initialResultRef.current = verifyModel(initialModelRef.current, DEFAULT_VERIFY_OPTIONS);
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

  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [runningExecutionMode, setRunningExecutionMode] = useState<VerifyExecutionMode>(() =>
    workerFactory !== undefined || isWebWorkerSupported() ? 'worker' : 'main-thread',
  );
  const [workerError, setWorkerError] = useState<string | null>(null);
  const [cancelledNotice, setCancelledNotice] = useState<string | null>(null);

  const [verifiedSnapshot, setVerifiedSnapshot] = useState<VerifiedSnapshot | null>(() => ({
    model: initialModelRef.current!,
    modelLabel: getInterlockPresetDescriptor(resolvedInitialVariant).shortLabel,
    options: DEFAULT_VERIFY_OPTIONS,
    result: initialResultRef.current!,
    executionMode: 'main-thread',
  }));

  const [replaySession, setReplaySession] = useState<ReplaySession | null>(() =>
    buildInitialSession(initialModelRef.current!, initialResultRef.current!),
  );
  const [replayError, setReplayError] = useState<string | null>(null);

  const [showComparison, setShowComparison] = useState<boolean>(initialShowComparison);
  const lastValidBoundsRef = useRef<VerifyOptions>(DEFAULT_VERIFY_OPTIONS);

  const clientRef = useRef<VerifyWorkerClient | null>(null);
  const activeRunIdRef = useRef<number>(0);

  useEffect(() => {
    const client = new VerifyWorkerClient({
      ...(workerFactory !== undefined ? { workerFactory } : {}),
      restartOnSupersede: true,
    });
    clientRef.current = client;
    setRunningExecutionMode(client.getExecutionMode());
    return () => {
      activeRunIdRef.current += 1;
      client.dispose();
      clientRef.current = null;
    };
  }, [workerFactory]);

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
    (verifiedSnapshot.model !== model ||
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
    activeRunIdRef.current += 1;
    const runId = activeRunIdRef.current;

    clientRef.current?.cancel();
    setCancelledNotice(null);
    setWorkerError(null);

    if (targetOptionErrors.length > 0 || targetOptions === null) {
      setIsRunning(false);
      setVerifiedSnapshot(null);
      setReplaySession(null);
      return;
    }

    if (targetDraftErrors.length > 0) {
      setIsRunning(false);
      setVerifiedSnapshot(null);
      setReplaySession(null);
      return;
    }

    const modErrs = validateModel(targetModel);
    if (modErrs.length > 0) {
      setIsRunning(false);
      setVerifiedSnapshot({
        model: targetModel,
        modelLabel: targetLabel,
        options: targetOptions,
        result: { status: 'INVALID', errors: modErrs },
        executionMode: 'main-thread',
      });
      setReplaySession(null);
      return;
    }

    const client = clientRef.current;
    if (client === null) {
      const syncResult = verifyModel(targetModel, targetOptions);
      setIsRunning(false);
      setVerifiedSnapshot({
        model: targetModel,
        modelLabel: targetLabel,
        options: targetOptions,
        result: syncResult,
        executionMode: 'main-thread',
      });
      setReplaySession(buildInitialSession(targetModel, syncResult));
      setReplayError(null);
      return;
    }

    setIsRunning(true);
    setRunningExecutionMode(client.getExecutionMode());
    setReplayError(null);

    void client.verify(targetModel, targetOptions, { restartWorker: true }).then((outcome) => {
      if (activeRunIdRef.current !== runId) {
        return;
      }
      if (outcome.status === 'cancelled') {
        setIsRunning(false);
        return;
      }
      setIsRunning(false);
      if (outcome.status === 'error') {
        setWorkerError(outcome.message);
        return;
      }

      setRunningExecutionMode(outcome.executionMode);
      setVerifiedSnapshot({
        model: targetModel,
        modelLabel: targetLabel,
        options: targetOptions,
        result: outcome.result,
        executionMode: outcome.executionMode,
      });
      setReplaySession(buildInitialSession(targetModel, outcome.result));
      setReplayError(null);
    });
  };

  const handleLoadPreset = (variant: InterlockPresetVariant) => {
    const nextModel = loadInterlockPresetModel(variant);
    const presetInfo = getInterlockPresetDescriptor(variant);

    activeRunIdRef.current += 1;
    clientRef.current?.cancel();
    setIsRunning(false);
    setVerifiedSnapshot(null);
    setReplaySession(null);
    setReplayError(null);
    setWorkerError(null);
    setCancelledNotice(null);
    setEditorDraftErrorMap({});
    setEditorResetKey((prev) => prev + 1);

    setActivePreset(variant);
    setModel(nextModel);
    runVerification(nextModel, presetInfo.shortLabel, parsedOptions, optionErrors, []);
  };

  const handleChangeModel = (nextModel: TransitionSystemModel) => {
    const wasRunning = isRunning || (clientRef.current?.isRunning() ?? false);
    activeRunIdRef.current += 1;
    if (wasRunning) {
      clientRef.current?.cancel();
      setIsRunning(false);
      setCancelledNotice('In-flight verification cancelled because the interlock model was edited.');
    }
    setModel(nextModel);
    setActivePreset(null);
  };

  const handleImportModel = (importedModel: TransitionSystemModel) => {
    const importedLabel = resolveModelLabel(importedModel, null);

    activeRunIdRef.current += 1;
    clientRef.current?.cancel();
    setIsRunning(false);
    setVerifiedSnapshot(null);
    setReplaySession(null);
    setReplayError(null);
    setWorkerError(null);
    setCancelledNotice(null);
    setEditorDraftErrorMap({});
    setEditorResetKey((prev) => prev + 1);

    setActivePreset(null);
    setModel(importedModel);
    runVerification(importedModel, importedLabel, parsedOptions, optionErrors, []);
  };

  const handleBoundsEdit = (kind: 'maxStates' | 'maxDepth', rawValue: string) => {
    const wasRunning = isRunning || (clientRef.current?.isRunning() ?? false);
    activeRunIdRef.current += 1;
    if (wasRunning) {
      clientRef.current?.cancel();
      setIsRunning(false);
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
      setEditorDraftErrorMap((prev) => {
        if (errorMessage === null) {
          if (!(fieldKey in prev)) return prev;
          const next = { ...prev };
          delete next[fieldKey];
          return next;
        }
        if (prev[fieldKey] === errorMessage) return prev;
        return { ...prev, [fieldKey]: errorMessage };
      });
      if (errorMessage !== null && clientRef.current?.isRunning()) {
        activeRunIdRef.current += 1;
        clientRef.current.cancel();
        setIsRunning(false);
        setCancelledNotice(
          'In-flight verification cancelled because an editor numeric draft was modified.',
        );
      }
    },
    [],
  );

  const handleCancelRun = () => {
    activeRunIdRef.current += 1;
    clientRef.current?.cancel();
    setIsRunning(false);
    setCancelledNotice('Verification run cancelled before completion.');
  };

  const handleVerifyCurrent = () => {
    runVerification(
      model,
      resolveModelLabel(model, activePreset),
      parsedOptions,
      optionErrors,
      editorDraftErrors,
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
    setReplaySession(buildInitialSession(verifiedSnapshot.model, verifiedSnapshot.result));
    setReplayError(null);
  };

  const activePresetInfo = activePreset !== null ? getInterlockPresetDescriptor(activePreset) : null;
  const hasAnyValidationErrors =
    optionErrors.length > 0 || editorDraftErrors.length > 0 || modelErrors.length > 0;
  const isDirtyEditor = activePreset === null || editorDraftErrors.length > 0;

  const { pendingPrompt, selectPreset, requestLinkNavigation, acceptPrompt, declinePrompt } =
    useWorkbenchRoute<InterlockPresetVariant>({
      allowedPresets: ALLOWED_INTERLOCK_PRESETS,
      defaultPreset: 'broken',
      isDirty: isDirtyEditor,
      onCommitPreset: handleLoadPreset,
      formatPresetLabel: (preset) => getInterlockPresetDescriptor(preset).shortLabel,
    });

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
                <>OUTDATED: {topVerdictSummary.badge}</>
              ) : (
                <>
                  <span aria-hidden="true">{topVerdictSummary.symbol}</span>{' '}
                  {topVerdictSummary.badge}
                </>
              )}
            </span>
          ) : hasAnyValidationErrors ? (
            <span className="is-badge" data-status="INVALID" data-tone="error" role="status">
              INVALID
            </span>
          ) : cancelledNotice !== null ? (
            <span className="is-badge" data-tone="warning" role="status">
              CANCELLED
            </span>
          ) : workerError !== null ? (
            <span className="is-badge" data-tone="error" role="status">
              ERROR
            </span>
          ) : (
            <span className="is-badge" data-tone="warning" role="status">
              NOT VERIFIED
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
        >
          <div>
            <strong id="is-discard-title">Unsaved Custom Edits</strong>
            <p id="is-discard-desc">
              {pendingPrompt.label} will discard your current unsaved custom edits.
            </p>
          </div>
          <div className="is-inline-actions">
            <button type="button" className="is-btn is-btn-sm" onClick={declinePrompt}>
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
          onLoadPreset={handleLoadPreset}
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
          />
        </div>
      </main>
    </div>
  );
}
