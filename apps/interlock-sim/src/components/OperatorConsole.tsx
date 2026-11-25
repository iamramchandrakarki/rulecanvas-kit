import type { TransitionSystemModel } from '@rulecanvas/core';
import { formatUpdateAssignment, type ReplaySession } from '@rulecanvas/ui';
import { explainRuleGuards } from '../guard-explainer.js';

export interface OperatorConsoleProps {
  readonly replaySession: ReplaySession;
  readonly snapshotModel: TransitionSystemModel;
  readonly modelLabel: string;
  readonly isStale: boolean;
  readonly canRestoreCounterexample: boolean;
  readonly replayError: string | null;
  readonly onResetReplay: () => void;
  readonly onStepBack: () => void;
  readonly onStepForward: () => void;
  readonly onApplyManualStep: (ruleId: string) => void;
  readonly onRestoreVerdictTrace: () => void;
}

function renderClauseNodes(clause: {
  readonly op: string;
  readonly expressionText: string;
  readonly actualValue: boolean;
  readonly expectedValue: boolean;
  readonly satisfied: boolean;
  readonly summary: string;
  readonly children: readonly {
    readonly op: string;
    readonly expressionText: string;
    readonly actualValue: boolean;
    readonly expectedValue: boolean;
    readonly satisfied: boolean;
    readonly summary: string;
    readonly children: readonly unknown[];
  }[];
}, keyPrefix: string) {
  return (
    <li key={keyPrefix}>
      <span>
        [{clause.satisfied ? 'PASS' : 'BLOCK'}] <code>{clause.expressionText}</code>:{' '}
        {clause.summary}
      </span>
      {clause.children.length > 0 && (
        <ul className="is-clause-tree">
          {clause.children.map((child, idx) =>
            renderClauseNodes(
              child as typeof clause,
              `${keyPrefix}-${idx}`,
            ),
          )}
        </ul>
      )}
    </li>
  );
}

export function OperatorConsole({
  replaySession,
  snapshotModel,
  modelLabel,
  isStale,
  canRestoreCounterexample,
  replayError,
  onResetReplay,
  onStepBack,
  onStepForward,
  onApplyManualStep,
  onRestoreVerdictTrace,
}: OperatorConsoleProps) {
  const explained = explainRuleGuards(snapshotModel, replaySession.currentState);
  const rulesById = new Map(snapshotModel.rules.map((r) => [r.id, r]));

  const explanations = explained.ok ? explained.rules : [];
  const enabledExplanations = explanations.filter((item) => item.enabled);
  const blockedExplanations = explanations.filter((item) => !item.enabled);

  return (
    <section className="is-pane" aria-label="Operator simulation console">
      <div className="is-pane-header">
        <div>
          <h2 className="is-pane-title">Operator Simulation Console</h2>
          <p className="is-pane-subtitle">
            Trigger enabled interlock actions or inspect why locked actions are blocked in the active state.
          </p>
        </div>
        <span className="is-badge">
          {replaySession.mode === 'trace' ? 'Mode: Trace Replay' : 'Mode: Manual Simulation'}
        </span>
      </div>

      {isStale && (
        <div className="is-alert is-alert-warning" role="status">
          <strong>Stepping Against Last Verified Snapshot ({modelLabel})</strong>
          <p>
            You have unverified edits in the Guard Inspector or Bounds. Click Verify Interlock Model to simulate and verify your latest edits.
          </p>
        </div>
      )}

      <div className="is-replay-toolbar">
        <div className="is-inline-actions">
          <button
            type="button"
            className="is-btn is-btn-sm"
            disabled={replaySession.cursor === 0 && replaySession.totalSteps === 0}
            onClick={onResetReplay}
          >
            Reset
          </button>
          <button
            type="button"
            className="is-btn is-btn-sm"
            disabled={!replaySession.canStepBack}
            onClick={onStepBack}
          >
            Step Back
          </button>
          <span className="is-step-counter" aria-live="polite">
            Step {replaySession.cursor} of {replaySession.totalSteps}
          </span>
          <button
            type="button"
            className="is-btn is-btn-sm"
            disabled={!replaySession.canStepForward}
            onClick={onStepForward}
          >
            Step Forward
          </button>
        </div>

        {canRestoreCounterexample && replaySession.mode === 'manual' && (
          <button
            type="button"
            className="is-btn is-btn-sm is-btn-active"
            onClick={onRestoreVerdictTrace}
          >
            Restore Counterexample
          </button>
        )}
      </div>

      {replayError !== null && (
        <div className="is-alert" role="alert">
          {replayError}
        </div>
      )}

      {!explained.ok && (
        <div className="is-alert" role="alert">
          <strong>Unable to Evaluate Guards</strong>
          <ul>
            {explained.errors.map((err, idx) => (
              <li key={`${err.code}-${err.path}-${idx}`}>
                <code>{err.path}</code>: {err.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Enabled transitions */}
      <div className="is-section">
        <div className="is-section-header">
          <h3 className="is-section-title">
            Enabled Actions ({enabledExplanations.length} of {explanations.length})
          </h3>
          <span className="is-badge" data-tone="info">
            Engine-authorized actuators
          </span>
        </div>

        {enabledExplanations.length === 0 ? (
          <div className="is-alert is-alert-warning" role="status">
            <strong>Deadlock State Reached</strong>
            <p>Zero interlock transitions are enabled in the current airlock state.</p>
          </div>
        ) : (
          <div className="is-transition-grid">
            {enabledExplanations.map((item) => {
              const rule = rulesById.get(item.ruleId);
              const updatesText =
                rule !== undefined
                  ? rule.updates.map((upd) => formatUpdateAssignment(upd)).join('; ')
                  : '';
              return (
                <button
                  key={item.ruleId}
                  type="button"
                  className="is-actuator-btn"
                  data-rule-id={item.ruleId}
                  onClick={() => onApplyManualStep(item.ruleId)}
                >
                  <div className="is-actuator-head">
                    <span className="is-actuator-id">{item.ruleId}</span>
                    <span className="is-badge" data-tone="success">
                      READY
                    </span>
                  </div>
                  <span className="is-actuator-label">{item.label}</span>
                  {updatesText.length > 0 && (
                    <span className="is-actuator-effect">{updatesText}</span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Blocked / Locked transitions with exact predicate failure reasons */}
      <div className="is-section">
        <div className="is-section-header">
          <h3 className="is-section-title">
            Locked / Interlocked Actions ({blockedExplanations.length})
          </h3>
          <span className="is-badge" data-tone="warning">
            Guard blocking explanations
          </span>
        </div>

        <div className="is-blocked-list">
          {blockedExplanations.map((item) => (
            <div key={item.ruleId} className="is-blocked-row" data-blocked-rule-id={item.ruleId}>
              <div className="is-actuator-head">
                <span className="is-mono" style={{ fontSize: 'var(--text-xs)', color: 'var(--color-ink)' }}>
                  {item.ruleId}
                </span>
                <span className="is-badge" data-tone="warning">
                  <span aria-hidden="true">×</span> LOCKED
                </span>
              </div>
              <span className="is-actuator-label" style={{ fontSize: 'var(--text-xs)' }}>
                {item.label}
              </span>
              {item.blockingReasons.length > 0 && (
                <ul className="is-blocked-reasons">
                  {item.blockingReasons.map((reason, idx) => (
                    <li key={`${item.ruleId}-reason-${idx}`}>{reason}</li>
                  ))}
                </ul>
              )}
              {item.rootClause !== null && (
                <details className="is-clause-details">
                  <summary>Inspect guard clause tree</summary>
                  <ul className="is-clause-tree">
                    {renderClauseNodes(item.rootClause, item.ruleId)}
                  </ul>
                </details>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
