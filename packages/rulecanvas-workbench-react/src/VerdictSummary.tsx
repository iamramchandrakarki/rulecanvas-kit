import type { ReactNode } from 'react';
import type {
  ModelAssumption,
  TransitionSystemModel,
  VerifyOptions,
  VerifyResult,
} from '@rulecanvas/core';
import {
  computeVerdictDelta,
  type VerdictDeltaEndpoint,
  type VerdictSummaryView,
} from '@rulecanvas/ui';

export interface VerdictSummaryProps {
  readonly view: VerdictSummaryView;
  readonly stale: boolean;
  readonly className?: string | undefined;
  readonly headerClassName?: string | undefined;
  readonly badgeClassName?: string | undefined;
  readonly headlineClassName?: string | undefined;
  readonly detailClassName?: string | undefined;
  readonly children?: ReactNode;
}

export function VerdictSummary({
  view,
  stale,
  className,
  headerClassName,
  badgeClassName,
  headlineClassName,
  detailClassName,
  children,
}: VerdictSummaryProps) {
  return (
    <div
      className={className}
      data-tone={stale ? 'warning' : view.tone}
      data-stale={stale ? 'true' : 'false'}
      data-vacuous-goal={view.vacuousGoalWarning ? 'true' : 'false'}
    >
      <div className={headerClassName}>
        <span
          className={badgeClassName}
          data-status={view.status}
          data-tone={stale ? 'warning' : view.tone}
        >
          {stale ? (
            <>
              <span aria-hidden="true">!</span> OUTDATED: {view.badge}
            </>
          ) : (
            <>
              <span aria-hidden="true">{view.symbol}</span> {view.badge}
            </>
          )}
        </span>
      </div>
      <p className={headlineClassName}>{view.headline}</p>
      <p className={detailClassName}>{view.detail}</p>
      {children}
    </div>
  );
}

export type AssumptionsScope = 'verification-snapshot' | 'unverified-draft';

export interface AssumptionsListProps {
  readonly items: readonly ModelAssumption[];
  readonly scope: AssumptionsScope;
  readonly listClassName?: string | undefined;
  readonly itemClassName?: string | undefined;
  readonly emptyMessage?: string | undefined;
}

export function AssumptionsList({
  items,
  scope,
  listClassName,
  itemClassName,
  emptyMessage = 'No modeling assumptions declared.',
}: AssumptionsListProps) {
  if (items.length === 0) {
    return (
      <p data-assumption-scope={scope} className={itemClassName}>
        {emptyMessage}
      </p>
    );
  }
  return (
    <ul className={listClassName} data-assumption-scope={scope}>
      {items.map((asm, idx) => (
        <li key={`${scope}-${asm.id}-${idx}`} className={itemClassName}>
          <strong>
            {asm.id} ({asm.category})
          </strong>
          : {asm.statement} <em>Not modeled: {asm.notModeled}</em>
        </li>
      ))}
    </ul>
  );
}

export interface VerdictDeltaSnapshot {
  readonly model: TransitionSystemModel;
  readonly options: VerifyOptions;
  readonly result: VerifyResult;
}

export interface VerdictDeltaRowProps {
  readonly previous: VerdictDeltaSnapshot | null;
  readonly current: VerdictDeltaSnapshot | null;
  readonly isRunning: boolean;
  readonly isStale: boolean;
  readonly className?: string | undefined;
}

function formatEndpoint(endpoint: VerdictDeltaEndpoint): string {
  if (endpoint.status === 'VIOLATED') {
    if (endpoint.traceLength === 0) {
      return 'VIOLATED (initial state)';
    }
    if (endpoint.traceLength !== undefined) {
      return `VIOLATED (${endpoint.traceLength} ${endpoint.traceLength === 1 ? 'step' : 'steps'})`;
    }
    return 'VIOLATED';
  }
  if (endpoint.status === 'VERIFIED' && endpoint.goalStatus === 'UNREACHABLE') {
    return 'VERIFIED (GOAL UNREACHABLE)';
  }
  return endpoint.status;
}

function formatCurrentQualification(
  endpoint: VerdictDeltaEndpoint,
  classification: string,
  changedSections: readonly string[],
): string {
  const parts: string[] = [];
  if (endpoint.status === 'VERIFIED') {
    if (endpoint.goalStatus === 'REACHED') {
      parts.push('Goal reachable: Yes');
    } else if (endpoint.goalStatus === 'UNREACHABLE') {
      parts.push('Goal reachable: No (vacuous)');
    } else if (endpoint.goalStatus === 'NO_GOAL_DECLARED') {
      parts.push('No goal declared');
    }
  }
  if (classification === 'verified-with-spec-change') {
    const specChanges = changedSections.filter((s) => s !== 'rules');
    parts.push(
      specChanges.length > 0
        ? `Spec/bounds changed (${specChanges.join(', ')})`
        : 'Spec or bounds changed',
    );
  } else if (classification === 'inconclusive-after-violation') {
    parts.push('Bound reached before proving fix');
  } else if (classification === 'regression') {
    parts.push('Regression');
  } else if (classification === 'unchanged') {
    parts.push('Unchanged');
  }
  return parts.join(' · ');
}

/**
 * Compact, visually neutral before-vs-after verdict delta row rendered inside
 * the verdict card below the primary verdict. Hidden while running or stale.
 */
export function VerdictDeltaRow({
  previous,
  current,
  isRunning,
  isStale,
  className,
}: VerdictDeltaRowProps) {
  if (isRunning || isStale || previous === null || current === null) {
    return null;
  }
  const computed = computeVerdictDelta(previous, current);
  if (!computed.ok) {
    return null;
  }
  const { delta } = computed;
  const beforeLabel = formatEndpoint(delta.before);
  const afterLabel =
    delta.after.status === 'VERIFIED' ? 'VERIFIED' : formatEndpoint(delta.after);
  const qualification = formatCurrentQualification(
    delta.after,
    delta.classification,
    delta.changedSections,
  );
  const rootClass = ['rc-verdict-delta', className].filter(Boolean).join(' ');

  return (
    <p
      className={rootClass}
      data-classification={delta.classification}
      data-spec-changed={delta.specOrBoundsChanged ? 'true' : 'false'}
    >
      <span className="rc-verdict-delta-label">Previous run:</span>{' '}
      <span className="rc-verdict-delta-before">{beforeLabel}</span>{' '}
      <span className="rc-verdict-delta-arrow" aria-hidden="true">
        →
      </span>{' '}
      <span className="rc-verdict-delta-now">Now: {afterLabel}</span>
      {qualification.length > 0 && (
        <>
          {' '}
          <span aria-hidden="true">·</span>{' '}
          <span className="rc-verdict-delta-detail">{qualification}</span>
        </>
      )}
    </p>
  );
}
