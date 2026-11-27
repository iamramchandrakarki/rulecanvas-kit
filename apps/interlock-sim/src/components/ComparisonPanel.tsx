import type { VerifyOptions } from '@rulecanvas/core';
import type { InterlockPresetComparisonRow } from '../comparison.js';
import type { InterlockPresetVariant } from '../presets.js';

export interface ComparisonPanelProps {
  readonly rows: readonly InterlockPresetComparisonRow[];
  readonly bounds: VerifyOptions;
  readonly boundsHasErrors?: boolean | undefined;
  readonly activeVariant: InterlockPresetVariant | null;
  readonly onLoadPreset: (variant: InterlockPresetVariant) => void;
  readonly onClose: () => void;
}

export function ComparisonPanel({
  rows,
  bounds,
  boundsHasErrors = false,
  activeVariant,
  onLoadPreset,
  onClose,
}: ComparisonPanelProps) {
  return (
    <section
      className="is-comparison-section"
      aria-label="BSL-3 interlock preset comparison matrix"
    >
      <div className="is-section-header">
        <div>
          <h2 className="is-pane-title">Preset Comparison Matrix (3 Interlock Variants)</h2>
          <p className="is-pane-subtitle">
            Verified under <span className="is-mono">maxStates={bounds.maxStates}</span>,{' '}
            <span className="is-mono">maxDepth={bounds.maxDepth}</span> across the 192-state BSL-3 airlock state space.
          </p>
        </div>
        <button type="button" className="is-btn is-btn-sm" onClick={onClose}>
          Close Matrix
        </button>
      </div>

      {boundsHasErrors && (
        <div className="is-alert is-alert-warning" role="alert">
          <strong>Current Bounds Inputs Are Invalid</strong>
          <p>
            Showing last valid comparison matrix computed under <code className="is-mono">maxStates={bounds.maxStates}</code>, <code className="is-mono">maxDepth={bounds.maxDepth}</code>. Fix the bounds inputs in the top bar to recompute under new bounds.
          </p>
        </div>
      )}

      <div
        className="is-table-wrap"
        tabIndex={0}
        role="region"
        aria-label="Interlock preset comparison matrix table"
      >
        <table className="is-table">
          <thead>
            <tr>
              <th scope="col">Preset</th>
              <th scope="col">Verdict</th>
              <th scope="col">States Explored</th>
              <th scope="col">Transitions</th>
              <th scope="col">Trace</th>
              <th scope="col">Goal Reachable</th>
              <th scope="col">Verification Summary</th>
              <th scope="col">Action</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const isSelected = activeVariant === row.preset.variant;
              const goalLabel =
                row.goalReachable === true
                  ? 'Yes'
                  : row.goalReachable === false
                    ? 'No (Vacuous)'
                    : 'Not decided';

              return (
                <tr key={row.preset.variant} data-changed={isSelected ? 'true' : 'false'}>
                  <td>
                    <strong>{row.preset.shortLabel}</strong>
                    <div style={{ color: 'var(--color-ink-muted)', marginTop: 2 }}>
                      {row.preset.summary}
                    </div>
                  </td>
                  <td>
                    <span
                      className="is-badge"
                      data-status={row.summary.status}
                      data-tone={row.summary.tone}
                    >
                      <span aria-hidden="true">{row.summary.symbol}</span> {row.summary.badge}
                    </span>
                  </td>
                  <td className="is-tabular">
                    {row.statesExplored !== null ? `${row.statesExplored} states` : 'N/A'}
                  </td>
                  <td className="is-tabular">
                    {row.transitionsEvaluated !== null
                      ? `${row.transitionsEvaluated}`
                      : 'N/A'}
                  </td>
                  <td className="is-tabular">
                    {row.traceLength !== null ? `${row.traceLength} steps` : 'None'}
                  </td>
                  <td className="is-mono">{goalLabel}</td>
                  <td>{row.outcomeSummary}</td>
                  <td>
                    <button
                      type="button"
                      className={
                        isSelected ? 'is-btn is-btn-sm is-btn-active' : 'is-btn is-btn-sm'
                      }
                      onClick={() => onLoadPreset(row.preset.variant)}
                    >
                      {isSelected ? 'Loaded' : 'Load preset'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
