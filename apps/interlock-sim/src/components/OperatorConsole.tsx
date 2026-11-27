import type { TransitionSystemModel } from '@rulecanvas/core';
import { formatUpdateAssignment, type ReplaySession } from '@rulecanvas/ui';
import { explainRuleGuards, type GuardClauseExplanation } from '../guard-explainer.js';

export interface OperatorConsoleProps {
  readonly replaySession: ReplaySession;
  readonly snapshotModel: TransitionSystemModel;
  readonly modelLabel: string;
  readonly isStale: boolean;
  readonly draftRuleIds?: ReadonlySet<string> | undefined;
  readonly canRestoreCounterexample: boolean;
  readonly replayError: string | null;
  readonly onResetReplay: () => void;
  readonly onStepBack: () => void;
  readonly onStepForward: () => void;
  readonly onApplyManualStep: (ruleId: string) => void;
  readonly onRestoreVerdictTrace: () => void;
  readonly onInspectRule?: ((ruleId: string) => void) | undefined;
}

function ClauseNode({ clause }: { readonly clause: GuardClauseExplanation }) {
  return (
    <li data-satisfied={clause.satisfied ? 'true' : 'false'}>
      <span className="is-clause-status">
        <span aria-hidden="true">{clause.satisfied ? '✓' : '✗'}</span>{' '}
        {clause.satisfied ? 'pass' : 'blocks'}
      </span>{' '}
      <code>{clause.expressionText}</code>
      <span className="is-clause-summary">{clause.summary}</span>
      {clause.children.length > 0 && (
        <ul className="is-clause-tree">
          {clause.children.map((child, idx) => (
            <ClauseNode key={`${child.expressionText}-${idx}`} clause={child} />
          ))}
        </ul>
      )}
    </li>
  );
}

function LockGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true" focusable="false">
      <rect x="2.5" y="5.25" width="7" height="5.25" rx="0.75" stroke="currentColor" strokeWidth="1.3" />
      <path d="M4 5.25V3.75a2 2 0 0 1 4 0v1.5" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

export function OperatorConsole({
  replaySession,
  snapshotModel,
  modelLabel,
  isStale,
  draftRuleIds,
  canRestoreCounterexample,
  replayError,
  onResetReplay,
  onStepBack,
  onStepForward,
  onApplyManualStep,
  onRestoreVerdictTrace,
  onInspectRule,
}: OperatorConsoleProps) {
  const explained = explainRuleGuards(snapshotModel, replaySession.currentState);
  const rulesById = new Map(snapshotModel.rules.map((r) => [r.id, r]));

  const explanations = explained.ok ? explained.rules : [];
  const enabledExplanations = explanations.filter((item) => item.enabled);
  const blockedExplanations = explanations.filter((item) => !item.enabled);

  return (
    <section className="is-pane is-console" aria-label="Operator simulation console">
      <div className="is-pane-header">
        <h2 className="is-pane-title">Operator Console</h2>
        <span className="is-meta-inline">
          {replaySession.mode === 'trace' ? 'Mode: Trace Replay' : 'Mode: Manual Simulation'}
        </span>
      </div>

      {isStale && (
        <div className="is-alert is-alert-warning" role="status">
          <strong>Stepping Snapshot ({modelLabel})</strong>
          <p>Unverified draft edits exist. Verify Interlock Model to simulate updated rules.</p>
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

      <div className="is-operator-actions">
        <div className="is-section is-actions-enabled">
          <div className="is-section-header">
            <h3 className="is-section-title">
              Enabled actions ({enabledExplanations.length} of {explanations.length}){' '}
              <span className="is-hint">executing one advances the simulation by one step</span>
            </h3>
          </div>

          {enabledExplanations.length === 0 ? (
            <div className="is-alert is-alert-warning" role="status">
              <strong>Deadlock State Reached</strong>
              <p>Zero interlock transitions are enabled in the current airlock state.</p>
            </div>
          ) : (
            <ul className="is-transition-grid">
              {enabledExplanations.map((item) => {
                const rule = rulesById.get(item.ruleId);
                const updatesText =
                  rule !== undefined
                    ? rule.updates.map((upd) => formatUpdateAssignment(upd)).join('; ')
                    : '';
                return (
                  <li key={item.ruleId}>
                    <button
                      type="button"
                      className="is-actuator-btn"
                      data-rule-id={item.ruleId}
                      onClick={() => onApplyManualStep(item.ruleId)}
                    >
                      <span className="is-actuator-head">
                        <span className="is-actuator-id">
                          <span className="is-visually-hidden">Execute </span>
                          {item.ruleId}
                        </span>
                        <span className="is-badge" data-tone="success">
                          <span aria-hidden="true">✓</span> READY
                        </span>
                      </span>
                      <span className="is-actuator-label">{item.label}</span>
                      {updatesText.length > 0 && (
                        <span className="is-actuator-effect">
                          <span className="is-hint" aria-hidden="true">
                            sets{' '}
                          </span>
                          {updatesText}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <details className="is-section is-actions-locked" open>
          <summary className="is-section-header">
            <h3 className="is-section-title">
              Locked actions ({blockedExplanations.length}){' '}
              <span className="is-hint">guard not satisfied in this state</span>
            </h3>
          </summary>

          <ul className="is-blocked-list">
            {blockedExplanations.map((item) => (
              <li key={item.ruleId} className="is-blocked-row" data-blocked-rule-id={item.ruleId}>
                <div className="is-blocked-head">
                  <span className="is-blocked-status" title="Locked: guard not satisfied">
                    <LockGlyph />
                    <span className="is-visually-hidden">Locked: </span>
                  </span>
                  <span className="is-blocked-id">{item.ruleId}</span>
                  <span className="is-blocked-label">{item.label}</span>
                  {onInspectRule !== undefined &&
                    (draftRuleIds === undefined || draftRuleIds.has(item.ruleId)) && (
                      <button
                        type="button"
                        className="is-btn is-btn-xs is-guard-jump"
                        aria-label={
                          isStale
                            ? `Edit draft guard for ${item.ruleId} in Guard Inspector`
                            : `Edit guard for ${item.ruleId} in Guard Inspector`
                        }
                        onClick={() => onInspectRule(item.ruleId)}
                      >
                        {isStale ? 'Edit draft guard' : 'Edit guard'}
                      </button>
                    )}
                </div>
                {item.blockingReasons.length > 0 && (
                  <ul className="is-blocked-reasons" aria-label={`Why ${item.ruleId} is locked`}>
                    {item.blockingReasons.map((reason, idx) => (
                      <li key={`${item.ruleId}-reason-${idx}`}>{reason}</li>
                    ))}
                  </ul>
                )}
                {item.rootClause !== null && (
                  <details className="is-clause-details">
                    <summary>Inspect guard clauses for {item.ruleId}</summary>
                    <ul className="is-clause-tree">
                      <ClauseNode clause={item.rootClause} />
                    </ul>
                  </details>
                )}
              </li>
            ))}
          </ul>
        </details>
      </div>
    </section>
  );
}
