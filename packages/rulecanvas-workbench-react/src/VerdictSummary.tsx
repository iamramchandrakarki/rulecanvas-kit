import type { ReactNode } from 'react';
import type { ModelAssumption } from '@rulecanvas/core';
import type { VerdictSummaryView } from '@rulecanvas/ui';

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
