import type { VerifyOptions } from '@rulecanvas/core';
import type { PresetComparisonRow } from '../comparison.js';
import type { ApprovalLaunderingVariant } from '../scenarios/approval-laundering.js';

export interface ComparisonPanelProps {
  readonly rows: readonly PresetComparisonRow[];
  readonly bounds: VerifyOptions;
  readonly boundsHasErrors?: boolean;
  readonly activeVariant: ApprovalLaunderingVariant | null;
  readonly onLoadPreset: (variant: ApprovalLaunderingVariant) => void;
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
      className="ag-comparison-section"
      aria-label="Preset policy comparison matrix"
    >
      <div className="ag-section-header">
        <div>
          <h2 className="ag-pane-title">Preset Comparison Matrix (All 5 Approval-Laundering Variants)</h2>
          <p className="ag-pane-subtitle">
            Verified under maxStates={bounds.maxStates}, maxDepth={bounds.maxDepth} by the deterministic breadth-first search engine.
          </p>
        </div>
        <button type="button" className="ag-btn ag-btn-sm" onClick={onClose}>
          Close Comparison
        </button>
      </div>

      {boundsHasErrors && (
        <div className="ag-alert ag-alert-warning" role="alert">
          <strong>Current Bounds Inputs Are Invalid</strong>
          <p>
            Showing last valid comparison matrix computed under maxStates={bounds.maxStates}, maxDepth={bounds.maxDepth}. Fix the exploration bounds inputs in the top bar to recompute under new bounds.
          </p>
        </div>
      )}

      <div className="ag-table-wrap">
        <table className="ag-table">
          <thead>
            <tr>
              <th scope="col">Preset</th>
              <th scope="col">Verdict</th>
              <th scope="col">States Explored</th>
              <th scope="col">Counterexample Trace</th>
              <th scope="col">Goal Reachable</th>
              <th scope="col">Outcome &amp; Bypass Summary</th>
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
                    <div style={{ fontSize: 12, color: 'var(--color-ink-muted)' }}>
                      {row.preset.summary}
                    </div>
                  </td>
                  <td>
                    <span
                      className="ag-badge"
                      data-status={row.summary.status}
                      data-tone={row.summary.tone}
                    >
                      <span aria-hidden="true">{row.summary.symbol}</span> {row.summary.badge}
                    </span>
                  </td>
                  <td className="ag-mono ag-tabular">
                    {row.statesExplored !== null ? `${row.statesExplored} states` : 'N/A'}
                  </td>
                  <td className="ag-mono ag-tabular">
                    {row.traceLength !== null ? `${row.traceLength} steps` : 'None'}
                  </td>
                  <td className="ag-mono">{goalLabel}</td>
                  <td>{row.bypassSummary}</td>
                  <td>
                    <button
                      type="button"
                      className={isSelected ? 'ag-btn ag-btn-sm ag-btn-active' : 'ag-btn ag-btn-sm'}
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
