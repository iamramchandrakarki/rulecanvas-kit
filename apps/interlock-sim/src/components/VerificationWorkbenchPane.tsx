import { useRef, useState, type KeyboardEvent } from 'react';
import type {
  ModelAssumption,
  TransitionRule,
  TransitionSystemModel,
  ValidationError,
  VerifyOptions,
  VerifyResult,
} from '@rulecanvas/core';
import {
  buildInvariantsPanelView,
  buildStateTableView,
  buildVerdictSummaryView,
  formatBoolExpr,
  formatStateValue,
  type ReplaySession,
} from '@rulecanvas/ui';
import { isWebWorkerSupported, type VerifyExecutionMode } from '../verify-client.js';
import { isCanonicalVacuousLockoutModel, type ModelDiagnosticsIndex } from '../model-inspector.js';
import {
  AssumptionsEditorContent,
  GuardInspectorContent,
  GuidedRepairCallout,
  JsonModelContent,
  useInterlockEditorState,
  type FocusedInterlockRuleRequest,
} from './InterlockRuleEditor.js';

export interface VerifiedSnapshot {
  readonly model: TransitionSystemModel;
  readonly modelLabel: string;
  readonly options: VerifyOptions;
  readonly result: VerifyResult;
  readonly executionMode: VerifyExecutionMode;
}

export interface IntegratedInterlockEditorProps {
  readonly diagnostics: ModelDiagnosticsIndex;
  readonly resetKey?: string | number | undefined;
  readonly focusedRuleRequest?: FocusedInterlockRuleRequest | null | undefined;
  readonly onChangeModel: (next: TransitionSystemModel) => void;
  readonly onImportModel: (imported: TransitionSystemModel) => void;
  readonly onDraftErrorChange?: ((fieldKey: string, errorMessage: string | null) => void) | undefined;
  readonly onJsonDraftDirtyChange?: ((dirty: boolean) => void) | undefined;
}

export interface VerificationWorkbenchPaneProps {
  readonly model: TransitionSystemModel;
  readonly isRunning: boolean;
  readonly runningExecutionMode: VerifyExecutionMode;
  readonly isStale: boolean;
  readonly workerError: string | null;
  readonly cancelledNotice: string | null;
  readonly optionErrors: readonly ValidationError[];
  readonly editorDraftErrors: readonly ValidationError[];
  readonly modelErrors: readonly ValidationError[];
  readonly verifiedSnapshot: VerifiedSnapshot | null;
  readonly replaySession: ReplaySession | null;
  readonly onCancelRun: () => void;
  readonly onVerifyNow: () => void;
  readonly onJumpToStep: (stepIndex: number) => void;
  readonly onInspectRule?: ((ruleId: string) => void) | undefined;
  readonly editor?: IntegratedInterlockEditorProps | undefined;
}

type UnifiedTabId = 'trace-guard' | 'state-invariants' | 'assumptions' | 'json';

const UNIFIED_TABS: readonly { readonly id: UnifiedTabId; readonly label: string }[] = [
  { id: 'trace-guard', label: 'Counterexample & Guard' },
  { id: 'state-invariants', label: 'State & Invariants' },
  { id: 'assumptions', label: 'Assumptions' },
  { id: 'json', label: 'JSON' },
];

function describeExecutionMode(mode: VerifyExecutionMode): string {
  if (mode === 'worker') {
    return 'Background Web Worker';
  }
  return isWebWorkerSupported()
    ? 'Main thread (synchronous verification)'
    : 'Main thread (Web Workers unavailable)';
}

function areAssumptionsEqual(
  left: readonly ModelAssumption[],
  right: readonly ModelAssumption[],
): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    const a = left[i]!;
    const b = right[i]!;
    if (
      a.id !== b.id ||
      a.category !== b.category ||
      a.statement !== b.statement ||
      a.notModeled !== b.notModeled
    ) {
      return false;
    }
  }
  return true;
}

interface TraceTimelineSectionProps {
  readonly replaySession: ReplaySession;
  readonly isStale: boolean;
  readonly ruleLabels: ReadonlyMap<string, string>;
  readonly snapshotRulesById: ReadonlyMap<string, TransitionRule>;
  readonly draftRuleIds: ReadonlySet<string>;
  readonly onJumpToStep: (stepIndex: number) => void;
  readonly onInspectRule?: ((ruleId: string) => void) | undefined;
}

function TraceTimelineSection({
  replaySession,
  isStale,
  ruleLabels,
  snapshotRulesById,
  draftRuleIds,
  onJumpToStep,
  onInspectRule,
}: TraceTimelineSectionProps) {
  return (
    <div className="is-trace-block">
      <div className="is-section-header">
        <h3 className="is-section-title">
          {replaySession.mode === 'trace'
            ? `Counterexample Trace (${replaySession.totalSteps} steps)`
            : `Manual Simulation Sequence (${replaySession.totalSteps} steps)`}
        </h3>
        <span className="is-step-counter" aria-live="polite">
          Cursor: Step {replaySession.cursor} / {replaySession.totalSteps}
        </span>
      </div>

      <ol className="is-timeline" aria-label="Execution trace steps">
        <li
          className="is-timeline-item"
          data-active={replaySession.cursor === 0 ? 'true' : 'false'}
        >
          <button
            type="button"
            className="is-timeline-btn"
            aria-current={replaySession.cursor === 0 ? 'step' : undefined}
            onClick={() => onJumpToStep(0)}
          >
            <div className="is-timeline-head">
              <strong className="is-mono">Initial State</strong>
              <span className="is-timeline-step-num">Step 0</span>
            </div>
          </button>
        </li>

        {replaySession.steps.map((step, idx) => {
          const stepNum = idx + 1;
          const isActive = replaySession.cursor === stepNum;
          const label = ruleLabels.get(step.ruleId);

          return (
            <li
              key={`${step.ruleId}-${stepNum}`}
              className="is-timeline-item"
              data-active={isActive ? 'true' : 'false'}
            >
              <button
                type="button"
                className="is-timeline-btn"
                aria-current={isActive ? 'step' : undefined}
                onClick={() => onJumpToStep(stepNum)}
              >
                <div className="is-timeline-head">
                  <span>
                    <strong className="is-mono">{step.ruleId}</strong>
                    {isActive && label !== undefined && (
                      <span style={{ color: 'var(--color-ink-muted)' }}>: {label}</span>
                    )}
                  </span>
                  <span className="is-timeline-step-num">Step {stepNum}</span>
                </div>

                {step.changedVars.length > 0 && (
                  <div className="is-diff-list">
                    {step.changedVars.map((varName) => {
                      const before = step.stateBefore[varName];
                      const after = step.stateAfter[varName];
                      return (
                        <span key={varName} className="is-diff-chip">
                          {varName}:{' '}
                          {before !== undefined ? formatStateValue(before) : '<missing>'} →{' '}
                          {after !== undefined ? formatStateValue(after) : '<missing>'}
                        </span>
                      );
                    })}
                  </div>
                )}

                {isActive && snapshotRulesById.has(step.ruleId) && (
                  <div className="is-code-strip" style={{ marginTop: 4 }}>
                    <strong>{isStale ? 'Snapshot guard:' : 'Guard:'}</strong>{' '}
                    {formatBoolExpr(snapshotRulesById.get(step.ruleId)!.guard)}
                  </div>
                )}
              </button>

              {onInspectRule !== undefined &&
                (draftRuleIds.has(step.ruleId) ? (
                  <button
                    type="button"
                  className="is-btn is-btn-sm is-timeline-jump is-guard-jump"
                    aria-label={
                      isStale
                        ? `Edit draft guard for ${step.ruleId}`
                        : `Inspect guard for ${step.ruleId}`
                    }
                    onClick={() => onInspectRule(step.ruleId)}
                  >
                    {isStale ? 'Edit draft guard' : 'Inspect guard'}
                  </button>
                ) : (
                  <span className="is-meta-inline is-timeline-jump">Removed in draft</span>
                ))}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

interface StateAndInvariantsContentProps {
  readonly replaySession: ReplaySession;
}

function StateAndInvariantsContent({ replaySession }: StateAndInvariantsContentProps) {
  const stateTableView = buildStateTableView(
    replaySession.model,
    replaySession.currentState,
    replaySession.changedVars,
  );
  const invariantsPanelView = buildInvariantsPanelView(
    replaySession.model,
    replaySession.violatedInvariantIds,
    replaySession.goalReached,
  );

  return (
    <>
      <div className="is-trace-block">
        <div className="is-section-header">
          <h4 className="is-section-title">State Table at Step {replaySession.cursor}</h4>
          <span className="is-meta-inline">
            {stateTableView.changedCount} modified on active step
          </span>
        </div>
        <div
          className="is-table-wrap"
          tabIndex={0}
          role="region"
          aria-label={`State variables table for ${stateTableView.modelName}`}
        >
          <table
            className="is-table"
            aria-label={`State variables for ${stateTableView.modelName}`}
          >
            <thead>
              <tr>
                <th scope="col">Variable</th>
                <th scope="col">Domain</th>
                <th scope="col">Value</th>
                <th scope="col">Change</th>
              </tr>
            </thead>
            <tbody>
              {stateTableView.rows.map((row) => (
                <tr
                  key={row.name}
                  data-var={row.name}
                  data-changed={row.changed ? 'true' : 'false'}
                >
                  <td className="is-mono">{row.name}</td>
                  <td className="is-mono" style={{ color: 'var(--color-ink-muted)' }}>
                    {row.domainText}
                  </td>
                  <td className="is-mono" style={{ fontWeight: 600 }}>
                    {row.valueText}
                  </td>
                  <td>
                    <span
                      className="is-badge"
                      data-tone={row.changed ? 'info' : undefined}
                    >
                      <span aria-hidden="true">{row.changed ? '*' : '-'}</span> {row.changeLabel}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {invariantsPanelView.status === 'VALID' && (
        <div className="is-section">
          <h4 className="is-section-title">
            Invariants &amp; Goal at Step {replaySession.cursor}
          </h4>
          <div
            className="is-table-wrap"
            tabIndex={0}
            role="region"
            aria-label="Invariants and goal evaluation table"
          >
            <table className="is-table" aria-label="Invariant and goal evaluation">
              <thead>
                <tr>
                  <th scope="col">Predicate</th>
                  <th scope="col">Expression</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {invariantsPanelView.invariants.map((inv) => (
                  <tr key={inv.id} data-changed={inv.violated ? 'true' : 'false'}>
                    <td>
                      <div className="is-mono" style={{ fontWeight: 600 }}>
                        {inv.id}
                      </div>
                      <div style={{ color: 'var(--color-ink-muted)', fontSize: 11.5 }}>
                        {inv.label}
                      </div>
                    </td>
                    <td className="is-mono" style={{ fontSize: 11.5 }}>
                      {inv.expressionText}
                    </td>
                    <td>
                      <span
                        className="is-badge"
                        data-tone={inv.violated ? 'danger' : 'success'}
                      >
                        <span aria-hidden="true">{inv.violated ? '✗' : '✓'}</span> {inv.status}
                      </span>
                    </td>
                  </tr>
                ))}

                {invariantsPanelView.goal !== undefined && (
                  <tr>
                    <td>
                      <div className="is-mono" style={{ fontWeight: 600 }}>
                        {invariantsPanelView.goal.id}
                      </div>
                      <div style={{ color: 'var(--color-ink-muted)', fontSize: 11.5 }}>
                        {invariantsPanelView.goal.label}
                      </div>
                    </td>
                    <td className="is-mono" style={{ fontSize: 11.5 }}>
                      {invariantsPanelView.goal.expressionText}
                    </td>
                    <td>
                      <span
                        className="is-badge"
                        data-tone={
                          invariantsPanelView.goal.reached === true ? 'success' : undefined
                        }
                      >
                        <span aria-hidden="true">
                          {invariantsPanelView.goal.reached === true ? '✓' : '○'}
                        </span>{' '}
                        {invariantsPanelView.goal.status}
                      </span>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}

interface SnapshotAssumptionsProvenanceProps {
  readonly model: TransitionSystemModel;
  readonly verifiedSnapshot: VerifiedSnapshot;
  readonly verifiedAssumptions: readonly ModelAssumption[];
  readonly hasPendingEditedAssumptions: boolean;
}

function SnapshotAssumptionsProvenance({
  model,
  verifiedSnapshot,
  verifiedAssumptions,
  hasPendingEditedAssumptions,
}: SnapshotAssumptionsProvenanceProps) {
  return (
    <>
      <div className="is-section-header">
        <h3 className="is-section-title">
          Snapshot Assumptions &amp; Scope Exclusions ({verifiedAssumptions.length})
        </h3>
        <span className="is-meta-inline">Snapshot: {verifiedSnapshot.modelLabel}</span>
      </div>

      {verifiedAssumptions.map((asm, idx) => (
        <div key={`${asm.id}-${idx}`} className="is-assumption-row">
          <div className="is-section-header">
            <strong className="is-mono" style={{ fontSize: 'var(--text-xs)' }}>
              {asm.id}
            </strong>
            <span className="is-assumption-category">{asm.category}</span>
          </div>
          <p style={{ fontSize: 12.5 }}>{asm.statement}</p>
          <p style={{ fontSize: 12, color: 'var(--color-ink-muted)' }}>
            <strong>Not modeled:</strong> {asm.notModeled}
          </p>
        </div>
      ))}

      {hasPendingEditedAssumptions && (
        <div
          className="is-pending-assumptions"
          role="region"
          aria-label="Pending edited assumptions"
        >
          <div className="is-section-header">
            <h4 className="is-section-title">
              Pending Edited Assumptions (Unverified) ({model.assumptions.length})
            </h4>
            <span className="is-badge" data-tone="warning">
              <span aria-hidden="true">!</span> UNVERIFIED DRAFT
            </span>
          </div>
          {model.assumptions.map((asm, idx) => (
            <div key={`pending-${asm.id}-${idx}`} className="is-assumption-row">
              <div className="is-section-header">
                <strong className="is-mono" style={{ fontSize: 'var(--text-xs)' }}>
                  {asm.id}
                </strong>
                <span className="is-assumption-category">{asm.category}</span>
              </div>
              <p style={{ fontSize: 12.5 }}>{asm.statement}</p>
              <p style={{ fontSize: 12, color: 'var(--color-ink-muted)' }}>
                <strong>Not modeled:</strong> {asm.notModeled}
              </p>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

interface IntegratedInspectorBodyProps {
  readonly model: TransitionSystemModel;
  readonly isRunning: boolean;
  readonly verifiedSnapshot: VerifiedSnapshot | null;
  readonly replaySession: ReplaySession | null;
  readonly isStale: boolean;
  readonly ruleLabels: ReadonlyMap<string, string>;
  readonly snapshotRulesById: ReadonlyMap<string, TransitionRule>;
  readonly draftRuleIds: ReadonlySet<string>;
  readonly hasVerifiedAssumptions: boolean;
  readonly verifiedAssumptions: readonly ModelAssumption[];
  readonly hasPendingEditedAssumptions: boolean;
  readonly onJumpToStep: (stepIndex: number) => void;
  readonly onInspectRule?: ((ruleId: string) => void) | undefined;
  readonly editorProps: IntegratedInterlockEditorProps;
}

function IntegratedInspectorBody({
  model,
  isRunning,
  verifiedSnapshot,
  replaySession,
  isStale,
  ruleLabels,
  snapshotRulesById,
  draftRuleIds,
  hasVerifiedAssumptions,
  verifiedAssumptions,
  hasPendingEditedAssumptions,
  onJumpToStep,
  onInspectRule,
  editorProps,
}: IntegratedInspectorBodyProps) {
  const [activeTab, setActiveTab] = useState<UnifiedTabId>('trace-guard');
  const tabRefs = useRef<Record<UnifiedTabId, HTMLButtonElement | null>>({
    'trace-guard': null,
    'state-invariants': null,
    assumptions: null,
    json: null,
  });

  const editorState = useInterlockEditorState({
    model,
    diagnostics: editorProps.diagnostics,
    resetKey: editorProps.resetKey,
    focusedRuleRequest: editorProps.focusedRuleRequest,
    isGuardTabActive: activeTab === 'trace-guard',
    onActivateGuardTab: () => setActiveTab('trace-guard'),
    onChangeModel: editorProps.onChangeModel,
    onImportModel: editorProps.onImportModel,
    onDraftErrorChange: editorProps.onDraftErrorChange,
    onJsonDraftDirtyChange: editorProps.onJsonDraftDirtyChange,
  });

  const handleTabKeyDown = (e: KeyboardEvent<HTMLButtonElement>, currentIdx: number) => {
    let targetIdx: number | null = null;
    if (e.key === 'ArrowRight') {
      targetIdx = (currentIdx + 1) % UNIFIED_TABS.length;
    } else if (e.key === 'ArrowLeft') {
      targetIdx = (currentIdx - 1 + UNIFIED_TABS.length) % UNIFIED_TABS.length;
    } else if (e.key === 'Home') {
      targetIdx = 0;
    } else if (e.key === 'End') {
      targetIdx = UNIFIED_TABS.length - 1;
    }
    if (targetIdx !== null) {
      e.preventDefault();
      const targetTab = UNIFIED_TABS[targetIdx]!;
      setActiveTab(targetTab.id);
      tabRefs.current[targetTab.id]?.focus();
    }
  };

  const canInspectReplay = !isRunning && verifiedSnapshot !== null && replaySession !== null;

  return (
    <>
      <GuidedRepairCallout editor={editorState} />

      <div
        className="is-tablist"
        role="tablist"
        aria-label="Verification and interlock inspector sections"
      >
        {UNIFIED_TABS.map((tab, idx) => (
          <button
            key={tab.id}
            ref={(el) => {
              tabRefs.current[tab.id] = el;
            }}
            id={`is-tab-${tab.id}`}
            type="button"
            role="tab"
            className="is-tab"
            aria-selected={activeTab === tab.id}
            aria-controls={`is-panel-${tab.id}`}
            tabIndex={activeTab === tab.id ? 0 : -1}
            onClick={() => setActiveTab(tab.id)}
            onKeyDown={(e) => handleTabKeyDown(e, idx)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab 1: Counterexample & Guard */}
      <div
        id="is-panel-trace-guard"
        role="tabpanel"
        aria-labelledby="is-tab-trace-guard"
        className="is-tabpanel"
        tabIndex={0}
        hidden={activeTab !== 'trace-guard'}
      >
        {canInspectReplay && (
          <TraceTimelineSection
            replaySession={replaySession}
            isStale={isStale}
            ruleLabels={ruleLabels}
            snapshotRulesById={snapshotRulesById}
            draftRuleIds={draftRuleIds}
            onJumpToStep={onJumpToStep}
            onInspectRule={onInspectRule}
          />
        )}

        <div className={canInspectReplay ? 'is-section' : 'is-trace-block'}>
          <div className="is-section-header">
            <h3 className="is-section-title">Guard editor</h3>
            <span className="is-meta-inline">{model.rules.length} rules</span>
          </div>
          <GuardInspectorContent editor={editorState} />
        </div>
      </div>

      {/* Tab 2: State & Invariants */}
      <div
        id="is-panel-state-invariants"
        role="tabpanel"
        aria-labelledby="is-tab-state-invariants"
        className="is-tabpanel"
        tabIndex={0}
        hidden={activeTab !== 'state-invariants'}
      >
        {canInspectReplay ? (
          <StateAndInvariantsContent replaySession={replaySession} />
        ) : (
          <p className="is-pane-subtitle">
            Verify a valid interlock model to inspect state variables, invariants, and goal
            evaluations.
          </p>
        )}
      </div>

      {/* Tab 3: Assumptions */}
      <div
        id="is-panel-assumptions"
        role="tabpanel"
        aria-labelledby="is-tab-assumptions"
        className="is-tabpanel"
        tabIndex={0}
        hidden={activeTab !== 'assumptions'}
      >
        {hasVerifiedAssumptions && verifiedSnapshot !== null && (
          <div className="is-trace-block">
            <SnapshotAssumptionsProvenance
              model={model}
              verifiedSnapshot={verifiedSnapshot}
              verifiedAssumptions={verifiedAssumptions}
              hasPendingEditedAssumptions={hasPendingEditedAssumptions}
            />
          </div>
        )}

        <div className={hasVerifiedAssumptions ? 'is-section' : 'is-trace-block'}>
          <AssumptionsEditorContent
            editor={editorState}
            showDraftBadge={!hasVerifiedAssumptions}
          />
        </div>
      </div>

      {/* Tab 4: JSON */}
      <div
        id="is-panel-json"
        role="tabpanel"
        aria-labelledby="is-tab-json"
        className="is-tabpanel"
        tabIndex={0}
        hidden={activeTab !== 'json'}
      >
        <JsonModelContent editor={editorState} />
      </div>
    </>
  );
}

export function VerificationWorkbenchPane({
  model,
  isRunning,
  runningExecutionMode,
  isStale,
  workerError,
  cancelledNotice,
  optionErrors,
  editorDraftErrors,
  modelErrors,
  verifiedSnapshot,
  replaySession,
  onCancelRun,
  onVerifyNow,
  onJumpToStep,
  onInspectRule,
  editor,
}: VerificationWorkbenchPaneProps) {
  const result = verifiedSnapshot?.result ?? null;
  const verdictView = result !== null ? buildVerdictSummaryView(result) : null;

  const combinedInputErrors: readonly ValidationError[] = [
    ...optionErrors,
    ...editorDraftErrors,
    ...modelErrors,
  ];
  const activeErrors: readonly ValidationError[] =
    combinedInputErrors.length > 0
      ? combinedInputErrors
      : result?.status === 'INVALID'
        ? result.errors
        : [];

  const snapshotRules = (replaySession?.model ?? verifiedSnapshot?.model ?? model).rules;
  const ruleLabels = new Map<string, string>(snapshotRules.map((r) => [r.id, r.label]));
  const snapshotRulesById = new Map(snapshotRules.map((r) => [r.id, r]));
  const draftRuleIds = new Set(model.rules.map((r) => r.id));

  const hasVerifiedAssumptions =
    verifiedSnapshot !== null && verifiedSnapshot.result.status !== 'INVALID';
  const verifiedAssumptions: readonly ModelAssumption[] = hasVerifiedAssumptions
    ? verifiedSnapshot.result.assumptions
    : [];
  const hasPendingEditedAssumptions =
    hasVerifiedAssumptions &&
    isStale &&
    !areAssumptionsEqual(model.assumptions, verifiedAssumptions);

  return (
    <section className="is-pane" aria-label="Bounded model checking verdict and trace">
      <div className="is-pane-header">
        <h2 className="is-pane-title">Verification inspector</h2>
      </div>

      {/* 1. Running */}
      {isRunning && (
        <div className="is-verdict" role="status" aria-live="polite" data-tone="info">
          <div className="is-verdict-top">
            <span className="is-badge" data-tone="running">
              <span aria-hidden="true">…</span> RUNNING
            </span>
            <button type="button" className="is-btn is-btn-sm is-btn-danger" onClick={onCancelRun}>
              Cancel Verification
            </button>
          </div>
          <p className="is-verdict-headline">
            {runningExecutionMode === 'main-thread'
              ? 'Executing deterministic verification on main thread (Web Workers unavailable)'
              : 'Exploring reachable airlock state space in Web Worker…'}
          </p>
        </div>
      )}

      {/* 2. Cancelled (when previous snapshot remains present) */}
      {!isRunning && cancelledNotice !== null && verifiedSnapshot !== null && (
        <div className="is-alert is-alert-warning" role="status">
          <div className="is-section-header">
            <strong>Verification Cancelled</strong>
            <button type="button" className="is-btn is-btn-sm" onClick={onVerifyNow}>
              Verify Interlock Model
            </button>
          </div>
          <p>{cancelledNotice}</p>
        </div>
      )}

      {/* 3. Worker failure */}
      {!isRunning && workerError !== null && (
        <div className="is-alert" role="alert">
          <div className="is-section-header">
            <strong>Verification Worker Error</strong>
            <button type="button" className="is-btn is-btn-sm" onClick={onVerifyNow}>
              Retry Verification
            </button>
          </div>
          <p>{workerError}</p>
        </div>
      )}

      {/* 4. Structured validation errors */}
      {!isRunning && activeErrors.length > 0 && (
        <div className="is-alert" role="alert">
          <strong>Validation Errors ({activeErrors.length})</strong>
          <ul>
            {activeErrors.map((err, idx) => (
              <li key={`${err.code}-${err.path}-${idx}`}>
                <code>{err.path}</code>: {err.message} (<code>{err.code}</code>)
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 5. Unverified */}
      {!isRunning && verifiedSnapshot === null && (
        <section className="is-verdict" role="status" aria-live="polite" data-tone="warning">
          <div className="is-verdict-top">
            <span className="is-badge" data-tone="warning">
              <span aria-hidden="true">
                {cancelledNotice !== null || activeErrors.length > 0 ? '!' : '○'}
              </span>{' '}
              {cancelledNotice !== null
                ? 'VERIFICATION CANCELLED'
                : activeErrors.length > 0
                  ? 'INVALID'
                  : 'NOT YET VERIFIED'}
            </span>
            {activeErrors.length === 0 && (
              <button
                type="button"
                className="is-btn is-btn-sm is-btn-primary"
                onClick={onVerifyNow}
              >
                Verify Interlock Model
              </button>
            )}
          </div>
          <p className="is-verdict-headline">
            {cancelledNotice !== null
              ? 'Verification Cancelled'
              : activeErrors.length > 0
                ? 'Verification blocked until errors are resolved'
                : 'No active verification snapshot'}
          </p>
          {cancelledNotice !== null && <p className="is-verdict-detail">{cancelledNotice}</p>}
        </section>
      )}

      {/* 6. Stale banner */}
      {!isRunning && verifiedSnapshot !== null && isStale && (
        <div className="is-alert is-alert-warning" role="status">
          <div className="is-section-header">
            <strong>Outdated Verification Snapshot</strong>
            <button type="button" className="is-btn is-btn-sm is-btn-active" onClick={onVerifyNow}>
              Verify Now
            </button>
          </div>
          <p>
            Showing snapshot <strong>{verifiedSnapshot.modelLabel}</strong> (
            <code>maxStates={verifiedSnapshot.options.maxStates}</code>,{' '}
            <code>maxDepth={verifiedSnapshot.options.maxDepth}</code>); unverified edits pending.
          </p>
        </div>
      )}

      {/* 7. Verdict Card */}
      {!isRunning && verifiedSnapshot !== null && verdictView !== null && (
        <section
          className="is-verdict"
          role={verdictView.role}
          aria-live="polite"
          data-status={verdictView.status}
          data-tone={isStale ? 'warning' : verdictView.tone}
          data-stale={isStale ? 'true' : 'false'}
          data-vacuous-goal={verdictView.vacuousGoalWarning ? 'true' : 'false'}
        >
          <div className="is-verdict-top">
            <span
              className="is-badge"
              data-status={verdictView.status}
              data-tone={isStale ? 'warning' : verdictView.tone}
            >
              {isStale ? (
                <>
                  <span aria-hidden="true">!</span> OUTDATED: {verdictView.badge}
                </>
              ) : (
                <>
                  <span aria-hidden="true">{verdictView.symbol}</span> {verdictView.badge}
                </>
              )}
            </span>

            {verdictView.goalReachable !== undefined &&
              (verdictView.status === 'VERIFIED' ? (
                <span
                  className="is-badge"
                  data-tone={verdictView.goalReachable ? 'success' : 'warning'}
                >
                  <span aria-hidden="true">{verdictView.goalReachable ? '✓' : '○'}</span>{' '}
                  {verdictView.goalReachable ? 'Goal reachable: Yes' : 'Goal reachable: No'}
                </span>
              ) : verdictView.goalReachable ? (
                <span className="is-verdict-witness">Goal witnessed on valid prefix</span>
              ) : null)}
          </div>

          <p className="is-verdict-headline">{verdictView.headline}</p>
          <p className="is-verdict-detail">{verdictView.detail}</p>

          <div className="is-verdict-meta">
            <span>Snapshot: {verifiedSnapshot.modelLabel}</span>
            <span>
              Bounds: maxStates={verifiedSnapshot.options.maxStates}, maxDepth=
              {verifiedSnapshot.options.maxDepth}
            </span>
            <span>Execution: {describeExecutionMode(verifiedSnapshot.executionMode)}</span>
          </div>

          {verdictView.vacuousGoalWarning && (
            <div className="is-verdict-notice" role="alert">
              <strong>Vacuous Goal Reachability Warning</strong>
              {isCanonicalVacuousLockoutModel(verifiedSnapshot.model) ? (
                <p>
                  Safety invariants hold trivially because lab entry (
                  <code className="is-mono">open_inner_door</code>) has guard{' '}
                  <code className="is-mono">false</code> and is never enabled. A functional BSL-3
                  interlock must preserve containment while letting{' '}
                  <code className="is-mono">goal_safe_lab_entry</code> remain reachable.
                </p>
              ) : (
                <p>
                  Every reachable state satisfies the declared invariants, but the declared goal (
                  <code className="is-mono">{verifiedSnapshot.model.goal?.id ?? 'goal'}</code>) is
                  unreachable within this model. Verify that both transition guards and the goal
                  predicate permit intended progress.
                </p>
              )}
            </div>
          )}

          {verdictView.inconclusiveReason !== undefined && (
            <div className="is-verdict-notice" role="status">
              <strong>Bounded Exploration Incomplete ({verdictView.inconclusiveReason})</strong>
              <p>
                Completed depth:{' '}
                <code className="is-tabular">{verdictView.completedDepth ?? 0}</code> | Frontier
                remaining:{' '}
                <code className="is-tabular">{verdictView.frontierRemaining ?? 0}</code>. Bounded
                search is incomplete and not an exhaustive proof.
              </p>
            </div>
          )}

          {verdictView.stats.length > 0 && (
            <dl className="is-stats-grid">
              {verdictView.stats.map((stat) => (
                <div key={stat.id} className="is-stat-cell" data-stat-id={stat.id}>
                  <dt>{stat.label}</dt>
                  <dd>{stat.value}</dd>
                </div>
              ))}
            </dl>
          )}
        </section>
      )}

      {/* 8. Integrated Direction A Unified Tabs OR Standalone Sections */}
      {editor !== undefined ? (
        <IntegratedInspectorBody
          model={model}
          isRunning={isRunning}
          verifiedSnapshot={verifiedSnapshot}
          replaySession={replaySession}
          isStale={isStale}
          ruleLabels={ruleLabels}
          snapshotRulesById={snapshotRulesById}
          draftRuleIds={draftRuleIds}
          hasVerifiedAssumptions={hasVerifiedAssumptions}
          verifiedAssumptions={verifiedAssumptions}
          hasPendingEditedAssumptions={hasPendingEditedAssumptions}
          onJumpToStep={onJumpToStep}
          onInspectRule={onInspectRule}
          editorProps={editor}
        />
      ) : (
        <>
          {!isRunning && verifiedSnapshot !== null && replaySession !== null && (
            <div className="is-section">
              <TraceTimelineSection
                replaySession={replaySession}
                isStale={isStale}
                ruleLabels={ruleLabels}
                snapshotRulesById={snapshotRulesById}
                draftRuleIds={draftRuleIds}
                onJumpToStep={onJumpToStep}
                onInspectRule={onInspectRule}
              />
              <div className="is-section">
                <StateAndInvariantsContent replaySession={replaySession} />
              </div>
            </div>
          )}

          <div className="is-section">
            {hasVerifiedAssumptions && verifiedSnapshot !== null ? (
              <SnapshotAssumptionsProvenance
                model={model}
                verifiedSnapshot={verifiedSnapshot}
                verifiedAssumptions={verifiedAssumptions}
                hasPendingEditedAssumptions={hasPendingEditedAssumptions}
              />
            ) : (
              <>
                <div className="is-section-header">
                  <h3 className="is-section-title">
                    Draft Model Assumptions (Unverified) ({model.assumptions.length})
                  </h3>
                  <span className="is-badge" data-tone="warning">
                    <span aria-hidden="true">!</span> UNVERIFIED DRAFT
                  </span>
                </div>
                {model.assumptions.map((asm, idx) => (
                  <div key={`draft-${asm.id}-${idx}`} className="is-assumption-row">
                    <div className="is-section-header">
                      <strong className="is-mono" style={{ fontSize: 'var(--text-xs)' }}>
                        {asm.id}
                      </strong>
                      <span className="is-assumption-category">{asm.category}</span>
                    </div>
                    <p style={{ fontSize: 12.5 }}>{asm.statement}</p>
                    <p style={{ fontSize: 12, color: 'var(--color-ink-muted)' }}>
                      <strong>Not modeled:</strong> {asm.notModeled}
                    </p>
                  </div>
                ))}
              </>
            )}
          </div>
        </>
      )}
    </section>
  );
}
