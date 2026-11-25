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
import { DEFAULT_VERIFY_OPTIONS, runPresetComparison } from './comparison.js';
import { ComparisonPanel } from './components/ComparisonPanel.js';
import { PolicyEditorPane } from './components/PolicyEditorPane.js';
import {
  VerificationWorkbenchPane,
  type VerifiedSnapshot,
} from './components/VerificationWorkbenchPane.js';
import { indexModelDiagnostics, parseStrictIntegerDraft } from './model-editor.js';
import { AGENT_GATE_PRESETS, getPresetDescriptor, loadPresetModel } from './presets.js';
import type { ApprovalLaunderingVariant } from './scenarios/approval-laundering.js';
import {
  VerifyWorkerClient,
  isWebWorkerSupported,
  type VerifyExecutionMode,
  type WorkerFactory,
} from './verify-client.js';

export interface AppProps {
  readonly initialVariant?: ApprovalLaunderingVariant;
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
  preset: ApprovalLaunderingVariant | null,
): string {
  if (preset !== null) {
    return getPresetDescriptor(preset).shortLabel;
  }
  const trimmedName = model.name.trim();
  if (trimmedName.length > 0) return trimmedName;
  const trimmedId = model.id.trim();
  return trimmedId.length > 0 ? trimmedId : 'Custom Model';
}

const ALLOWED_AGENT_GATE_PRESETS: readonly ApprovalLaunderingVariant[] = [
  'broken',
  'naive-patch-a',
  'naive-patch-b',
  'vacuous-fix',
  'principled-fix',
];

const WORKBENCH_NAV_LINKS: readonly WorkbenchNavLink[] = [
  {
    id: 'agent-gate',
    label: 'AgentGate',
    href: './',
    description: 'Current agent policy verification workbench',
  },
  {
    id: 'interlock-sim',
    label: 'InterlockSim',
    href:
      typeof import.meta !== 'undefined' &&
      typeof (import.meta as { env?: Record<string, string | undefined> }).env?.[
        'VITE_INTERLOCK_SIM_URL'
      ] === 'string'
        ? (import.meta as { env: Record<string, string> }).env['VITE_INTERLOCK_SIM_URL']!
        : '../interlock-sim/',
    description: 'Open InterlockSim BSL-3 airlock simulation workbench',
  },
];

export function App({
  initialVariant,
  initialShowComparison = false,
  workerFactory,
}: AppProps) {
  const resolvedInitialVariant: ApprovalLaunderingVariant =
    initialVariant ??
    (typeof window !== 'undefined'
      ? readPresetFromSearch(window.location.search, ALLOWED_AGENT_GATE_PRESETS, 'broken').preset
      : 'broken');

  const initialModelRef = useRef<TransitionSystemModel | null>(null);
  if (initialModelRef.current === null) {
    initialModelRef.current = loadPresetModel(resolvedInitialVariant);
  }
  const initialResultRef = useRef<VerifyResult | null>(null);
  if (initialResultRef.current === null) {
    initialResultRef.current = verifyModel(initialModelRef.current, DEFAULT_VERIFY_OPTIONS);
  }

  const [activePreset, setActivePreset] = useState<ApprovalLaunderingVariant | null>(
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
    modelLabel: getPresetDescriptor(resolvedInitialVariant).shortLabel,
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
    () => (showComparison ? runPresetComparison(comparisonBounds) : []),
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

  const handleLoadPreset = (variant: ApprovalLaunderingVariant) => {
    const nextModel = loadPresetModel(variant);
    const presetInfo = getPresetDescriptor(variant);

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
      setCancelledNotice('In-flight verification cancelled because the policy model was edited.');
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
      setCancelledNotice('In-flight verification cancelled because exploration bounds were edited.');
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

  const handleToggleComparison = () => {
    setShowComparison((prev) => !prev);
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
    const restored = buildInitialSession(verifiedSnapshot.model, verifiedSnapshot.result);
    setReplaySession(restored);
    setReplayError(null);
  };

  const activePresetInfo = activePreset !== null ? getPresetDescriptor(activePreset) : null;
  const hasAnyValidationErrors =
    optionErrors.length > 0 || editorDraftErrors.length > 0 || modelErrors.length > 0;
  const isDirtyEditor = activePreset === null || editorDraftErrors.length > 0;

  const { pendingPrompt, selectPreset, requestLinkNavigation, acceptPrompt, declinePrompt } =
    useWorkbenchRoute<ApprovalLaunderingVariant>({
      allowedPresets: ALLOWED_AGENT_GATE_PRESETS,
      defaultPreset: 'broken',
      isDirty: isDirtyEditor,
      onCommitPreset: handleLoadPreset,
      formatPresetLabel: (preset) => getPresetDescriptor(preset).shortLabel,
    });

  return (
    <div className="ag-shell">
      <header className="ag-topbar">
        <div className="ag-brand">
          <h1 className="ag-brand-mark">
            <span className="ag-brand-glyph" aria-hidden="true" />
            AgentGate
          </h1>
          <span className="ag-brand-subtitle">
            Discrete finite-state policy verification workbench
          </span>
          <WorkbenchNavigation
            current="agent-gate"
            links={WORKBENCH_NAV_LINKS}
            ariaLabel="RuleCanvasKit workbenches"
            className="ag-wb-nav"
            listClassName="ag-wb-nav-list"
            linkClassName="ag-wb-nav-link"
            activeLinkClassName="ag-wb-nav-link-active"
            onNavigate={(link, event) => {
              if (isDirtyEditor) {
                event.preventDefault();
                requestLinkNavigation(link.href, link.label);
              }
            }}
          />
        </div>

        <div className="ag-topbar-controls">
          <div className="ag-control-field">
            <label htmlFor="preset-select">Preset</label>
            <select
              id="preset-select"
              className="ag-select"
              value={activePreset ?? 'custom'}
              onChange={(e) => {
                const value = e.target.value;
                if (value !== 'custom') {
                  selectPreset(value as ApprovalLaunderingVariant);
                }
              }}
            >
              {activePreset === null && <option value="custom">Custom / Edited Model</option>}
              {AGENT_GATE_PRESETS.map((preset) => (
                <option key={preset.variant} value={preset.variant}>
                  {preset.shortLabel}
                </option>
              ))}
            </select>
          </div>

          <div className="ag-control-field">
            <label htmlFor="max-states-input">maxStates</label>
            <input
              id="max-states-input"
              type="text"
              inputMode="numeric"
              className="ag-input ag-input-num"
              aria-invalid={maxStatesInvalid ? 'true' : undefined}
              value={maxStatesText}
              onChange={(e) => handleBoundsEdit('maxStates', e.target.value)}
            />
          </div>

          <div className="ag-control-field">
            <label htmlFor="max-depth-input">maxDepth</label>
            <input
              id="max-depth-input"
              type="text"
              inputMode="numeric"
              className="ag-input ag-input-num"
              aria-invalid={maxDepthInvalid ? 'true' : undefined}
              value={maxDepthText}
              onChange={(e) => handleBoundsEdit('maxDepth', e.target.value)}
            />
          </div>

          {isRunning ? (
            <span className="ag-badge" data-tone="running" role="status">
              <span aria-hidden="true">…</span> RUNNING
            </span>
          ) : verifiedSnapshot !== null && topVerdictSummary !== null ? (
            <span
              className="ag-badge"
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
            <span className="ag-badge" data-status="INVALID" data-tone="error" role="status">
              INVALID
            </span>
          ) : cancelledNotice !== null ? (
            <span className="ag-badge" data-tone="warning" role="status">
              CANCELLED
            </span>
          ) : workerError !== null ? (
            <span className="ag-badge" data-tone="error" role="status">
              ERROR
            </span>
          ) : (
            <span className="ag-badge" data-tone="warning" role="status">
              NOT VERIFIED
            </span>
          )}

          <button
            type="button"
            className="ag-btn ag-btn-primary"
            onClick={handleVerifyCurrent}
          >
            Verify Policy
          </button>

          <button
            type="button"
            className={showComparison ? 'ag-btn ag-btn-active' : 'ag-btn ag-btn-secondary'}
            aria-expanded={showComparison}
            onClick={handleToggleComparison}
          >
            Compare All 5 Presets
          </button>
        </div>
      </header>

      {pendingPrompt !== null && (
        <div
          className="ag-discard-banner"
          role="alertdialog"
          aria-labelledby="ag-discard-title"
          aria-describedby="ag-discard-desc"
        >
          <div>
            <strong id="ag-discard-title">Unsaved Custom Edits</strong>
            <p id="ag-discard-desc">
              {pendingPrompt.label} will discard your current unsaved custom edits.
            </p>
          </div>
          <div className="ag-inline-actions">
            <button type="button" className="ag-btn ag-btn-sm ag-btn-secondary" onClick={declinePrompt}>
              Stay Here
            </button>
            <button type="button" className="ag-btn ag-btn-sm ag-btn-primary" onClick={acceptPrompt}>
              Discard &amp; Continue
            </button>
          </div>
        </div>
      )}

      <div className="ag-context-strip">
        <span>
          <strong>{activePresetInfo !== null ? activePresetInfo.title : model.name}</strong>
          {activePresetInfo !== null
            ? `: ${activePresetInfo.summary}`
            : ': Edited custom policy model'}
        </span>
        {activePresetInfo !== null && (
          <span className="ag-context-note">{activePresetInfo.policyNote}</span>
        )}
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

      <main className="ag-workspace">
        <PolicyEditorPane
          model={model}
          diagnostics={diagnostics}
          resetKey={editorResetKey}
          onChangeModel={handleChangeModel}
          onImportModel={handleImportModel}
          onDraftErrorChange={handleEditorDraftErrorChange}
        />

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
          replayError={replayError}
          onCancelRun={handleCancelRun}
          onVerifyNow={handleVerifyCurrent}
          onResetReplay={handleResetReplay}
          onStepBack={handleStepBack}
          onStepForward={handleStepForward}
          onJumpToStep={handleJumpToStep}
          onApplyManualStep={handleApplyManualStep}
          onRestoreVerdictTrace={handleRestoreVerdictTrace}
        />
      </main>
    </div>
  );
}
