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
  WorkbenchBrandMark,
  WorkbenchDiscardDialog,
  WorkbenchNavigation,
  WorkbenchThemeSwitch,
  readPresetFromSearch,
  useVerificationSnapshot,
  useWorkbenchRoute,
  useWorkbenchTheme,
  type WorkbenchNavLink,
} from '@rulecanvas/workbench-react';
import { DEFAULT_VERIFY_OPTIONS, runPresetComparison } from './comparison.js';
import { ComparisonPanel } from './components/ComparisonPanel.js';
import { PolicyEditorPane, type FocusedRuleRequest } from './components/PolicyEditorPane.js';
import { VerificationWorkbenchPane } from './components/VerificationWorkbenchPane.js';
import { indexModelDiagnostics, parseStrictIntegerDraft } from './model-editor.js';
import { AGENT_GATE_PRESETS, getPresetDescriptor, loadPresetModel } from './presets.js';
import type { ApprovalLaunderingVariant } from './scenarios/approval-laundering.js';
import { createAppVerifyClient, type WorkerFactory } from './verify-client.js';

export interface AppProps {
  readonly initialVariant?: ApprovalLaunderingVariant;
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
  const theme = useWorkbenchTheme();

  const resolvedInitialVariant: ApprovalLaunderingVariant =
    initialVariant ??
    (typeof window !== 'undefined'
      ? readPresetFromSearch(window.location.search, ALLOWED_AGENT_GATE_PRESETS, 'broken').preset
      : 'broken');

  const initialModelRef = useRef<TransitionSystemModel | null>(null);
  if (initialModelRef.current === null) {
    initialModelRef.current = loadPresetModel(resolvedInitialVariant);
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
  const [focusedRuleRequest, setFocusedRuleRequest] = useState<FocusedRuleRequest | null>(null);
  const focusSeqRef = useRef<number>(0);

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
      label: getPresetDescriptor(resolvedInitialVariant).shortLabel,
      revision: 0,
    },
    createClient,
  });
  const [cancelledNotice, setCancelledNotice] = useState<string | null>(null);
  const [replayError, setReplayError] = useState<string | null>(null);
  const [jsonDraftDirty, setJsonDraftDirty] = useState<boolean>(false);

  const latestModelRef = useRef<TransitionSystemModel>(model);
  latestModelRef.current = model;
  const latestActivePresetRef = useRef<ApprovalLaunderingVariant | null>(activePreset);
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
      errs.push({ ...err, path: err.path ? 'options.' + err.path : 'options' });
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
    () => (showComparison ? runPresetComparison(comparisonBounds) : []),
    [showComparison, comparisonBounds.maxStates, comparisonBounds.maxDepth],
  );

  const topVerdictSummary = useMemo(
    () => (verifiedSnapshot !== null ? buildVerdictSummaryView(verifiedSnapshot.result) : null),
    [verifiedSnapshot],
  );

  const activeTraceStepsByRuleId = useMemo((): Readonly<Record<string, readonly number[]>> => {
    if (replaySession === null || replaySession.steps.length === 0) return {};
    const map: Record<string, number[]> = {};
    replaySession.steps.forEach((step, idx) => {
      if (!Object.hasOwn(map, step.ruleId)) {
        map[step.ruleId] = [];
      }
      map[step.ruleId]!.push(idx + 1);
    });
    return map;
  }, [replaySession]);

  const runVerification = (
    targetModel: TransitionSystemModel,
    targetLabel: string,
    targetOptions: VerifyOptions | null,
    targetOptionErrors: readonly ValidationError[],
    targetDraftErrors: readonly ValidationError[],
  ) => {
    setCancelledNotice(null);
    setReplayError(null);

    if (
      targetOptions === null ||
      targetOptionErrors.length > 0 ||
      targetDraftErrors.length > 0 ||
      validateModel(targetModel).length > 0
    ) {
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

  const handleLoadPreset = (variant: ApprovalLaunderingVariant) => {
    const nextModel = loadPresetModel(variant);
    const presetInfo = getPresetDescriptor(variant);

    clearVerification();
    modelRevisionRef.current += 1;
    latestEditorDraftErrorMapRef.current = {};
    setEditorDraftErrorMap({});
    setJsonDraftDirty(false);
    setFocusedRuleRequest(null);
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
      setCancelledNotice('In-flight verification cancelled because the policy model was edited.');
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
    setFocusedRuleRequest(null);
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

  const handleToggleComparison = () => {
    setShowComparison((prev) => !prev);
  };

  const handleVerifyCurrent = useCallback(() => {
    if (isPending()) return;
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
  }, [isPending, optionErrors, parsedOptions]);

  const handleInspectRule = useCallback((ruleId: string) => {
    focusSeqRef.current += 1;
    setFocusedRuleRequest({ ruleId, seq: focusSeqRef.current });
  }, []);

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

  const activePresetInfo = activePreset !== null ? getPresetDescriptor(activePreset) : null;
  const hasAnyValidationErrors =
    optionErrors.length > 0 || editorDraftErrors.length > 0 || modelErrors.length > 0;
  const isDirtyEditor = activePreset === null || editorDraftErrors.length > 0 || jsonDraftDirty;

  const { pendingPrompt, selectPreset, requestLinkNavigation, acceptPrompt, declinePrompt } =
    useWorkbenchRoute<ApprovalLaunderingVariant>({
      allowedPresets: ALLOWED_AGENT_GATE_PRESETS,
      defaultPreset: 'broken',
      isDirty: isDirtyEditor,
      onCommitPreset: handleLoadPreset,
      formatPresetLabel: (preset) => getPresetDescriptor(preset).shortLabel,
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

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleGlobalShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && pendingPrompt === null) {
        event.preventDefault();
        handleVerifyCurrent();
      }
    };
    window.addEventListener('keydown', handleGlobalShortcut);
    return () => window.removeEventListener('keydown', handleGlobalShortcut);
  }, [handleVerifyCurrent, pendingPrompt]);

  const scrollToSection = (elementId: string) => {
    if (typeof document === 'undefined') return;
    document.getElementById(elementId)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className="ag-shell">
      <header className="ag-topbar">
        <div className="ag-brand">
          <span className="ag-brand-suite">
            <WorkbenchBrandMark className="ag-brand-icon" />
            <span>RuleCanvasKit</span>
            <span className="ag-brand-sep" aria-hidden="true">
              /
            </span>
          </span>
          <h1 className="ag-brand-mark">AgentGate</h1>
          <WorkbenchNavigation
            current="agent-gate"
            links={WORKBENCH_NAV_LINKS}
            allowedPrefix={ALLOWED_NAV_PREFIX}
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
            <span className="ag-badge" data-status="INVALID" data-tone="error" role="status">
              <span aria-hidden="true">!</span> INVALID
            </span>
          ) : cancelledNotice !== null ? (
            <span className="ag-badge" data-tone="warning" role="status">
              <span aria-hidden="true">!</span> CANCELLED
            </span>
          ) : workerError !== null ? (
            <span className="ag-badge" data-tone="error" role="status">
              <span aria-hidden="true">!</span> ERROR
            </span>
          ) : (
            <span className="ag-badge" data-tone="warning" role="status">
              <span aria-hidden="true">○</span> NOT VERIFIED
            </span>
          )}

          <button
            type="button"
            className="ag-btn ag-btn-primary"
            disabled={isRunning}
            aria-busy={isRunning ? 'true' : undefined}
            title="Run bounded BFS verification (Ctrl/Cmd+Enter)"
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

          <WorkbenchThemeSwitch
            value={theme.preference}
            onChange={theme.setPreference}
            className="ag-theme-switch"
            buttonClassName="ag-theme-btn"
            activeButtonClassName="ag-theme-btn-active"
          />
        </div>
      </header>

      {pendingPrompt !== null && (
        <WorkbenchDiscardDialog
          ref={stayHereButtonRef}
          idPrefix="ag"
          actionLabel={pendingPrompt.label}
          onDecline={declinePrompt}
          onAccept={acceptPrompt}
          backdropClassName="ag-dialog-backdrop"
          dialogClassName="ag-discard-dialog"
          titleClassName="ag-discard-title"
          descriptionClassName="ag-discard-desc"
          actionsClassName="ag-discard-actions"
          stayButtonClassName="ag-btn ag-btn-sm ag-btn-secondary"
          acceptButtonClassName="ag-btn ag-btn-sm ag-btn-primary"
        />
      )}

      <div className="ag-context-strip">
        <span>
          <strong>{activePresetInfo !== null ? activePresetInfo.title : model.name}</strong>
          {activePresetInfo !== null
            ? `: ${activePresetInfo.summary}`
            : ': Edited custom policy model'}
        </span>

        <div className="ag-inline-actions">
          {activePresetInfo !== null && (
            <span className="ag-context-note">{activePresetInfo.policyNote}</span>
          )}
          <div className="ag-mobile-jump" role="navigation" aria-label="Workspace pane jump">
            <button
              type="button"
              className="ag-btn ag-btn-sm"
              onClick={() => scrollToSection('ag-verdict-pane')}
            >
              Jump to Verdict &amp; Trace
            </button>
            <button
              type="button"
              className="ag-btn ag-btn-sm"
              onClick={() => scrollToSection('ag-editor-pane')}
            >
              Jump to Editor
            </button>
          </div>
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

      <main className="ag-workspace">
        <PolicyEditorPane
          model={model}
          diagnostics={diagnostics}
          resetKey={editorResetKey}
          activeTraceStepsByRuleId={activeTraceStepsByRuleId}
          focusedRuleRequest={focusedRuleRequest}
          onChangeModel={handleChangeModel}
          onImportModel={handleImportModel}
          onDraftErrorChange={handleEditorDraftErrorChange}
          onJsonDraftDirtyChange={setJsonDraftDirty}
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
          onInspectRule={handleInspectRule}
        />
      </main>
    </div>
  );
}
