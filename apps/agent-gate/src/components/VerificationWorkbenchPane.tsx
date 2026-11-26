import type {
  ModelAssumption,
  TransitionSystemModel,
  ValidationError,
  VerifyOptions,
  VerifyResult,
} from '@rulecanvas/core';
import {
  buildInvariantsPanelView,
  buildStateTableView,
  buildVerdictSummaryView,
  formatStateValue,
  type ReplaySession,
} from '@rulecanvas/ui';
import { isWebWorkerSupported, type VerifyExecutionMode } from '../verify-client.js';

export interface VerifiedSnapshot {
  readonly model: TransitionSystemModel;
  readonly modelLabel: string;
  readonly options: VerifyOptions;
  readonly result: VerifyResult;
  readonly executionMode: VerifyExecutionMode;
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
  readonly replayError: string | null;
  readonly onCancelRun: () => void;
  readonly onVerifyNow: () => void;
  readonly onResetReplay: () => void;
  readonly onStepBack: () => void;
  readonly onStepForward: () => void;
  readonly onJumpToStep: (stepIndex: number) => void;
  readonly onApplyManualStep: (ruleId: string) => void;
  readonly onRestoreVerdictTrace: () => void;
  readonly onInspectRule?: ((ruleId: string) => void) | undefined;
}

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
  replayError,
  onCancelRun,
  onVerifyNow,
  onResetReplay,
  onStepBack,
  onStepForward,
  onJumpToStep,
  onApplyManualStep,
  onRestoreVerdictTrace,
  onInspectRule,
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

  const ruleLabels = new Map<string, string>(
    (replaySession?.model ?? verifiedSnapshot?.model ?? model).rules.map((r) => [r.id, r.label]),
  );

  const stateTableView =
    replaySession !== null
      ? buildStateTableView(
          replaySession.model,
          replaySession.currentState,
          replaySession.changedVars,
        )
      : null;

  const invariantsPanelView =
    replaySession !== null
      ? buildInvariantsPanelView(
          replaySession.model,
          replaySession.violatedInvariantIds,
          replaySession.goalReached,
        )
      : null;

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
    <section
      id="ag-verdict-pane"
      className="ag-pane ag-pane-workbench"
      aria-label="Verification results and counterexample workbench"
    >
      <div className="ag-pane-header">
        <h2 className="ag-pane-title">Verification &amp; Counterexample Workbench</h2>
        {isStale && !isRunning ? (
          <button type="button" className="ag-btn ag-btn-sm ag-btn-active" onClick={onVerifyNow}>
            Re-verify Now
          </button>
        ) : (
          <span className="ag-meta-inline">Bounded BFS &amp; shortest trace</span>
        )}
      </div>

      <div className="ag-workbench-body">
        {/* 1. Running state */}
        {isRunning && (
          <div className="ag-verdict" role="status" aria-live="polite" data-tone="running">
            <div className="ag-verdict-top">
              <span className="ag-badge" data-tone="running">
                <span aria-hidden="true">…</span> RUNNING
              </span>
              <button type="button" className="ag-btn ag-btn-sm ag-btn-danger" onClick={onCancelRun}>
                Cancel Verification
              </button>
            </div>
            <p className="ag-verdict-headline">
              {runningExecutionMode === 'main-thread'
                ? 'Executing deterministic verification on main thread (Web Workers unavailable)'
                : 'Exploring reachable state space in background worker…'}
            </p>
            <p className="ag-verdict-detail">
              {runningExecutionMode === 'main-thread'
                ? 'Web Workers are unavailable in this runtime. Verification runs deterministically on the main thread.'
                : 'Verification runs off the main thread so rule inspection and editing stay responsive.'}
            </p>
          </div>
        )}

        {/* 2. Cancellation notice (only when a previous snapshot still exists; when null, section 5 covers it cleanly) */}
        {!isRunning && cancelledNotice !== null && verifiedSnapshot !== null && (
          <div className="ag-alert ag-alert-warning" role="status">
            <div className="ag-section-header">
              <strong>Verification Cancelled</strong>
              <button type="button" className="ag-btn ag-btn-sm" onClick={onVerifyNow}>
                Verify Policy
              </button>
            </div>
            <p>{cancelledNotice}</p>
          </div>
        )}

        {/* 3. Worker failure state */}
        {!isRunning && workerError !== null && (
          <div className="ag-alert" role="alert">
            <div className="ag-section-header">
              <strong>Verification Worker Error</strong>
              <button type="button" className="ag-btn ag-btn-sm" onClick={onVerifyNow}>
                Retry Verification
              </button>
            </div>
            <p>{workerError}</p>
          </div>
        )}

        {/* 4. Structured Invalid Errors */}
        {!isRunning && activeErrors.length > 0 && (
          <div className="ag-alert" role="alert">
            <strong>
              Validation Errors ({activeErrors.length}): Fix errors before verification can complete
            </strong>
            <ul>
              {activeErrors.map((err, idx) => (
                <li key={`${err.code}-${err.path}-${idx}`}>
                  <code>{err.path}</code>: {err.message} (<code>{err.code}</code>)
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* 5. Unverified / Empty snapshot state */}
        {!isRunning && verifiedSnapshot === null && (
          <section className="ag-verdict" role="status" aria-live="polite" data-tone="warning">
            <div className="ag-verdict-top">
              <span className="ag-badge" data-tone="warning">
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
                <button type="button" className="ag-btn ag-btn-sm ag-btn-primary" onClick={onVerifyNow}>
                  Verify Policy
                </button>
              )}
            </div>
            <p className="ag-verdict-headline">
              {cancelledNotice !== null
                ? 'Verification Cancelled'
                : activeErrors.length > 0
                  ? 'Verification blocked by validation errors'
                  : 'Not Yet Verified'}
            </p>
            <p className="ag-verdict-detail">
              {cancelledNotice !== null
                ? cancelledNotice
                : activeErrors.length > 0
                  ? 'Resolve the validation diagnostics above, then run Verify Policy to compute a fresh verdict.'
                  : 'Run Verify Policy to compute a deterministic verdict and counterexample replay for the active model.'}
            </p>
          </section>
        )}

        {/* 6. Explicit Outdated Snapshot Warning Banner */}
        {!isRunning && verifiedSnapshot !== null && isStale && (
          <div className="ag-alert ag-alert-warning" role="status">
            <div className="ag-section-header">
              <strong>Outdated Verification Snapshot</strong>
              <button type="button" className="ag-btn ag-btn-sm ag-btn-active" onClick={onVerifyNow}>
                Re-verify Now
              </button>
            </div>
            <p>
              Results below belong to <strong>{verifiedSnapshot.modelLabel}</strong> under{' '}
              <code>maxStates={verifiedSnapshot.options.maxStates}</code>,{' '}
              <code>maxDepth={verifiedSnapshot.options.maxDepth}</code>. Pending edits have not been
              verified yet.
            </p>
          </div>
        )}

        {/* 7. Verdict Card built strictly via @rulecanvas/ui buildVerdictSummaryView */}
        {!isRunning && verifiedSnapshot !== null && verdictView !== null && (
          <section
            className="ag-verdict"
            role={verdictView.role}
            aria-live="polite"
            data-status={verdictView.status}
            data-tone={isStale ? 'warning' : verdictView.tone}
            data-stale={isStale ? 'true' : 'false'}
            data-vacuous-goal={verdictView.vacuousGoalWarning ? 'true' : 'false'}
          >
            <div className="ag-verdict-top">
              <span
                className="ag-badge"
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
                    className="ag-badge"
                    data-tone={verdictView.goalReachable ? 'success' : 'warning'}
                  >
                    <span aria-hidden="true">{verdictView.goalReachable ? '✓' : '○'}</span>{' '}
                    {verdictView.goalReachable ? 'Goal reachable: Yes' : 'Goal reachable: No'}
                  </span>
                ) : verdictView.goalReachable ? (
                  <span className="ag-verdict-witness">Goal witnessed on valid prefix</span>
                ) : null)}
            </div>

            <p className="ag-verdict-headline">{verdictView.headline}</p>
            <p className="ag-verdict-detail">{verdictView.detail}</p>

            <div className="ag-verdict-meta ag-mono ag-tabular">
              <span>Snapshot: {verifiedSnapshot.modelLabel}</span>
              <span>
                Bounds: maxStates={verifiedSnapshot.options.maxStates}, maxDepth=
                {verifiedSnapshot.options.maxDepth}
              </span>
              <span>Execution: {describeExecutionMode(verifiedSnapshot.executionMode)}</span>
            </div>

            {verdictView.vacuousGoalWarning && (
              <div className="ag-alert ag-alert-warning" role="alert">
                <strong>Vacuous Fix Warning</strong>
                <p>
                  Every reachable state satisfies the declared invariants, but the declared goal
                  predicate is never reached. A policy that blocks all progress is not a functional
                  fix.
                </p>
              </div>
            )}

            {verdictView.inconclusiveReason !== undefined && (
              <div className="ag-alert ag-alert-warning" role="status">
                <strong>Incomplete Exploration ({verdictView.inconclusiveReason})</strong>
                <p>
                  Completed depth:{' '}
                  <code className="ag-tabular">{verdictView.completedDepth ?? 0}</code> | Frontier
                  states remaining:{' '}
                  <code className="ag-tabular">{verdictView.frontierRemaining ?? 0}</code>. Increase
                  bounds to exhaustively verify this model.
                </p>
              </div>
            )}

            {verdictView.stats.length > 0 && (
              <dl className="ag-stats-grid">
                {verdictView.stats.map((stat) => (
                  <div key={stat.id} className="ag-stat-cell" data-stat-id={stat.id}>
                    <dt>{stat.label}</dt>
                    <dd>{stat.value}</dd>
                  </div>
                ))}
              </dl>
            )}
          </section>
        )}

        {/* Interactive Counterexample Replay & Manual Simulation */}
        {!isRunning && verifiedSnapshot !== null && replaySession !== null && (
          <div className="ag-section">
            <div className="ag-section-header">
              <div>
                <h3 className="ag-section-title">
                  {replaySession.mode === 'trace'
                    ? 'Counterexample Trace Replay'
                    : 'Manual Simulation Session'}
                </h3>
                <p className="ag-pane-subtitle">
                  {isStale
                    ? `Outdated snapshot "${verifiedSnapshot.modelLabel}" (maxStates=${verifiedSnapshot.options.maxStates}, maxDepth=${verifiedSnapshot.options.maxDepth}).`
                    : `Verified snapshot "${verifiedSnapshot.modelLabel}" (maxStates=${verifiedSnapshot.options.maxStates}, maxDepth=${verifiedSnapshot.options.maxDepth}).`}
                </p>
              </div>
              <span className="ag-meta-inline">
                {replaySession.mode === 'trace' ? 'Mode: Counterexample' : 'Mode: Manual'}
              </span>
            </div>

            <div className="ag-replay-toolbar">
              <div className="ag-inline-actions">
                <button
                  type="button"
                  className="ag-btn ag-btn-sm"
                  disabled={replaySession.cursor === 0 && replaySession.totalSteps === 0}
                  onClick={onResetReplay}
                >
                  Reset
                </button>
                <button
                  type="button"
                  className="ag-btn ag-btn-sm"
                  disabled={!replaySession.canStepBack}
                  onClick={onStepBack}
                >
                  Previous
                </button>
                <span className="ag-step-counter" aria-live="polite">
                  Step {replaySession.cursor} of {replaySession.totalSteps}
                </span>
                <button
                  type="button"
                  className="ag-btn ag-btn-sm"
                  disabled={!replaySession.canStepForward}
                  onClick={onStepForward}
                >
                  Next
                </button>
              </div>

              {result?.status === 'VIOLATED' && replaySession.mode === 'manual' && (
                <button
                  type="button"
                  className="ag-btn ag-btn-sm ag-btn-active"
                  onClick={onRestoreVerdictTrace}
                >
                  Restore Counterexample Trace
                </button>
              )}
            </div>

            {replayError !== null && (
              <div className="ag-alert" role="alert">
                {replayError}
              </div>
            )}

            {/* Step Timeline List */}
            <ol className="ag-timeline" aria-label="Execution trace steps">
              <li
                className="ag-timeline-item"
                data-active={replaySession.cursor === 0 ? 'true' : 'false'}
              >
                <button
                  type="button"
                  className="ag-timeline-btn"
                  aria-current={replaySession.cursor === 0 ? 'step' : undefined}
                  onClick={() => onJumpToStep(0)}
                >
                  <div className="ag-timeline-head">
                    <strong className="ag-mono">Initial State</strong>
                    <span className="ag-timeline-step-num">Step 0</span>
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
                    className="ag-timeline-item"
                    data-active={isActive ? 'true' : 'false'}
                  >
                    <button
                      type="button"
                      className="ag-timeline-btn"
                      aria-current={isActive ? 'step' : undefined}
                      onClick={() => onJumpToStep(stepNum)}
                    >
                      <div className="ag-timeline-head">
                        <span>
                          <strong className="ag-mono">{step.ruleId}</strong>
                          {label !== undefined && (
                            <span style={{ color: 'var(--color-ink-secondary)' }}>: {label}</span>
                          )}
                        </span>
                        <span className="ag-timeline-step-num">Step {stepNum}</span>
                      </div>

                      {step.changedVars.length > 0 && (
                        <div className="ag-diff-list">
                          {step.changedVars.map((varName) => {
                            const before = step.stateBefore[varName];
                            const after = step.stateAfter[varName];
                            return (
                              <span key={varName} className="ag-diff-chip">
                                {varName}:{' '}
                                {before !== undefined ? formatStateValue(before) : '<missing>'} →{' '}
                                {after !== undefined ? formatStateValue(after) : '<missing>'}
                              </span>
                            );
                          })}
                        </div>
                      )}
                    </button>

                    {onInspectRule !== undefined && (
                      <button
                        type="button"
                        className="ag-btn ag-btn-sm ag-timeline-jump"
                        aria-label={`Inspect rule ${step.ruleId} in editor`}
                        onClick={() => onInspectRule(step.ruleId)}
                      >
                        Inspect rule
                      </button>
                    )}
                  </li>
                );
              })}
            </ol>

            {/* Live State Variable Table built via @rulecanvas/ui buildStateTableView */}
            {stateTableView !== null && (
              <div className="ag-section" style={{ paddingTop: 8, borderTop: 'none' }}>
                <div className="ag-section-header">
                  <h4 className="ag-section-title">State Variables at Step {replaySession.cursor}</h4>
                  <span className="ag-meta-inline">
                    {stateTableView.changedCount} modified on active step
                  </span>
                </div>

                <div
                  className="ag-table-wrap"
                  tabIndex={0}
                  role="region"
                  aria-label={`State variables table for ${stateTableView.modelName}`}
                >
                  <table
                    className="ag-table"
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
                          <td className="ag-mono">{row.name}</td>
                          <td className="ag-mono" style={{ color: 'var(--color-ink-muted)' }}>
                            {row.domainText}
                          </td>
                          <td className="ag-mono" style={{ fontWeight: 600 }}>
                            {row.valueText}
                          </td>
                          <td>
                            <span
                              className="ag-badge"
                              data-tone={row.changed ? 'running' : undefined}
                            >
                              <span aria-hidden="true">{row.changed ? '*' : '-'}</span>{' '}
                              {row.changeLabel}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Invariants & Goal Status Panel built via @rulecanvas/ui buildInvariantsPanelView */}
            {invariantsPanelView !== null && invariantsPanelView.status === 'VALID' && (
              <div className="ag-section">
                <h4 className="ag-section-title">Invariants &amp; Goal at Step {replaySession.cursor}</h4>
                <div
                  className="ag-table-wrap"
                  tabIndex={0}
                  role="region"
                  aria-label="Invariants and goal evaluation table"
                >
                  <table className="ag-table" aria-label="Invariant and goal evaluation">
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
                            <div className="ag-mono" style={{ fontWeight: 600 }}>
                              {inv.id}
                            </div>
                            <div style={{ fontSize: 11.5, color: 'var(--color-ink-muted)' }}>
                              {inv.label}
                            </div>
                          </td>
                          <td className="ag-mono" style={{ fontSize: 11.5 }}>
                            {inv.expressionText}
                          </td>
                          <td>
                            <span
                              className="ag-badge"
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
                            <div className="ag-mono" style={{ fontWeight: 600 }}>
                              {invariantsPanelView.goal.id}
                            </div>
                            <div style={{ fontSize: 11.5, color: 'var(--color-ink-muted)' }}>
                              {invariantsPanelView.goal.label}
                            </div>
                          </td>
                          <td className="ag-mono" style={{ fontSize: 11.5 }}>
                            {invariantsPanelView.goal.expressionText}
                          </td>
                          <td>
                            <span
                              className="ag-badge"
                              data-tone={
                                invariantsPanelView.goal.reached === true ? 'success' : undefined
                              }
                            >
                              <span aria-hidden="true">
                                {invariantsPanelView.goal.reached === true ? '✓' : '-'}
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

            {/* Manual Rule Execution Controls */}
            <div className="ag-section">
              <div className="ag-section-header">
                <h4 className="ag-section-title">Manual Rule Execution</h4>
                <span className="ag-meta-inline">
                  {replaySession.enabledTransitions.filter((t) => t.enabled).length} of{' '}
                  {replaySession.enabledTransitions.length} enabled
                </span>
              </div>

              <div className="ag-transition-grid">
                {replaySession.enabledTransitions.map((transition) => (
                  <button
                    key={transition.ruleId}
                    type="button"
                    className="ag-transition-btn"
                    disabled={!transition.enabled}
                    onClick={() => onApplyManualStep(transition.ruleId)}
                  >
                    <span className="ag-transition-id">{transition.ruleId}</span>
                    <span className="ag-transition-label">{transition.label}</span>
                    <span
                      className="ag-mono"
                      style={{
                        fontSize: 11,
                        color: transition.enabled
                          ? 'var(--color-accent)'
                          : 'var(--color-ink-muted)',
                      }}
                    >
                      {transition.enabled ? 'Enabled: Step' : 'Guard disabled'}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Explicit Modeling Assumptions & Scope Disclosure */}
        <div className="ag-section">
          {hasVerifiedAssumptions ? (
            <>
              <div className="ag-section-header">
                <h3 className="ag-section-title">
                  Modeling Assumptions &amp; Scope Disclosure ({verifiedAssumptions.length})
                </h3>
                <span className="ag-meta-inline">
                  Scope of verified snapshot: {verifiedSnapshot.modelLabel}
                </span>
              </div>
              <p className="ag-scope-note">
                Scope of verified snapshot: <strong>{verifiedSnapshot.modelLabel}</strong>.
                Verdicts hold strictly within the declared discrete finite-state model and its
                explicit assumptions below. AgentGate is a design-time policy verification
                workbench, not a live runtime enforcement proxy or external production security
                audit.
              </p>
              <div className="ag-assumptions-list">
                {verifiedAssumptions.map((asm, idx) => (
                  <div key={`${asm.id}-${idx}`} className="ag-assumption-item">
                    <div className="ag-section-header">
                      <strong className="ag-mono">{asm.id}</strong>
                      <span className="ag-assumption-category">{asm.category}</span>
                    </div>
                    <p>{asm.statement}</p>
                    <p className="ag-assumption-not-modeled">
                      <strong>Not modeled:</strong> {asm.notModeled}
                    </p>
                  </div>
                ))}
              </div>

              {hasPendingEditedAssumptions && (
                <div
                  className="ag-pending-assumptions"
                  role="region"
                  aria-label="Pending edited assumptions"
                >
                  <div className="ag-section-header">
                    <h4 className="ag-section-title">
                      Pending Edited Assumptions (Unverified) ({model.assumptions.length})
                    </h4>
                    <span className="ag-badge" data-tone="warning">
                      <span aria-hidden="true">!</span> UNVERIFIED DRAFT
                    </span>
                  </div>
                  <p className="ag-pane-subtitle">
                    These edited assumptions belong to the unverified policy draft and do not apply
                    to the verified snapshot above until you re-verify.
                  </p>
                  <div className="ag-assumptions-list">
                    {model.assumptions.map((asm, idx) => (
                      <div key={`pending-${asm.id}-${idx}`} className="ag-assumption-item">
                        <div className="ag-section-header">
                          <strong className="ag-mono">{asm.id}</strong>
                          <span className="ag-assumption-category">{asm.category}</span>
                        </div>
                        <p>{asm.statement}</p>
                        <p className="ag-assumption-not-modeled">
                          <strong>Not modeled:</strong> {asm.notModeled}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : (
            <>
              <div className="ag-section-header">
                <h3 className="ag-section-title">
                  Draft Model Assumptions (Unverified) ({model.assumptions.length})
                </h3>
                <span className="ag-badge" data-tone="warning">
                  <span aria-hidden="true">!</span> UNVERIFIED DRAFT
                </span>
              </div>
              <p className="ag-scope-note">
                Modeling Assumptions &amp; Scope Disclosure: no valid verified snapshot is active.
                The assumptions below belong to the current unverified draft model. AgentGate is a
                design-time finite-state verification workbench, not a live runtime enforcement
                proxy or external production security audit.
              </p>
              <div className="ag-assumptions-list">
                {model.assumptions.map((asm, idx) => (
                  <div key={`draft-${asm.id}-${idx}`} className="ag-assumption-item">
                    <div className="ag-section-header">
                      <strong className="ag-mono">{asm.id}</strong>
                      <span className="ag-assumption-category">{asm.category}</span>
                    </div>
                    <p>{asm.statement}</p>
                    <p className="ag-assumption-not-modeled">
                      <strong>Not modeled:</strong> {asm.notModeled}
                    </p>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
