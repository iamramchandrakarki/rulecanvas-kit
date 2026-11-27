import type { StateSchema, StateSnapshot, TransitionSystemModel } from '@rulecanvas/core';
import {
  hasCanonicalContainmentInvariantSpec,
  hasCanonicalLabEntryGoalSpec,
  hasCanonicalSealAndUvInvariantSpecs,
  hasCanonicalUvInvariantSpec,
} from '../model-inspector.js';

export interface AirlockSchematicProps {
  readonly schema?: StateSchema | undefined;
  readonly state: StateSnapshot;
  readonly changedVars: readonly string[];
  readonly highlightedVars?: readonly string[] | undefined;
  readonly violatedInvariantIds: readonly string[];
  readonly evaluatedInvariantIds?: readonly string[] | undefined;
  readonly invariants?: TransitionSystemModel['invariants'] | undefined;
  readonly goal?: TransitionSystemModel['goal'] | undefined;
  readonly isEvaluated?: boolean | undefined;
  readonly isStale?: boolean | undefined;
  readonly isRunning?: boolean | undefined;
  readonly snapshotLabel?: string | undefined;
  readonly goalReached: boolean | undefined;
  readonly stepNumber: number;
  readonly modeLabel: string;
}

interface TelemetryReadout {
  readonly varName: string;
  readonly label: string;
  readonly iconKind:
    | 'door-open'
    | 'door-closed'
    | 'pressure'
    | 'uv'
    | 'occupancy'
    | 'purge'
    | 'override'
    | 'na';
  readonly displayValue: string;
  readonly available: boolean;
}

function TelemetryGlyph({ kind }: { readonly kind: TelemetryReadout['iconKind'] }) {
  switch (kind) {
    case 'door-closed':
      return (
        <svg className="is-telemetry-icon" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <rect x="1.5" y="1.5" width="9" height="9" stroke="currentColor" strokeWidth="1.3" />
          <line x1="6" y1="1.5" x2="6" y2="10.5" stroke="currentColor" strokeWidth="1.8" />
        </svg>
      );
    case 'door-open':
      return (
        <svg className="is-telemetry-icon" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path d="M1.5 2h2.5v8H1.5M10.5 2H8v8h2.5" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      );
    case 'pressure':
      return (
        <svg className="is-telemetry-icon" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.3" />
          <path d="M6 6L8.4 3.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      );
    case 'uv':
      return (
        <svg className="is-telemetry-icon" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <line x1="2" y1="3" x2="10" y2="3" stroke="currentColor" strokeWidth="1.6" />
          <path d="M3.5 5.2L2.8 9.5M6 5.2v4.3M8.5 5.2l.7 4.3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      );
    case 'occupancy':
      return (
        <svg className="is-telemetry-icon" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <circle cx="6" cy="3.6" r="1.8" stroke="currentColor" strokeWidth="1.3" />
          <path d="M2.6 10.2c.4-2 1.7-3 3.4-3s3 1 3.4 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      );
    case 'purge':
      return (
        <svg className="is-telemetry-icon" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <rect x="1.5" y="3" width="3.5" height="6" stroke="currentColor" strokeWidth="1.3" />
          <rect x="7" y="3" width="3.5" height="6" stroke="currentColor" strokeWidth="1.3" />
        </svg>
      );
    case 'override':
      return (
        <svg className="is-telemetry-icon" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <circle cx="4.5" cy="6" r="2.5" stroke="currentColor" strokeWidth="1.3" />
          <path d="M7 6h3.8M9.5 6v2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      );
    case 'na':
      return (
        <svg className="is-telemetry-icon" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <rect x="2" y="2" width="8" height="8" stroke="currentColor" strokeWidth="1.2" strokeDasharray="2 2" />
        </svg>
      );
  }
}

function hasEnumValues(
  schema: StateSchema | undefined,
  name: string,
  requiredValues: readonly string[],
): boolean {
  if (schema === undefined || !Object.hasOwn(schema, name)) return false;
  const def = schema[name];
  if (def?.kind !== 'enum') return false;
  return requiredValues.every((v) => def.values.includes(v));
}

export function AirlockSchematic({
  schema,
  state,
  changedVars,
  highlightedVars = [],
  violatedInvariantIds,
  evaluatedInvariantIds = [],
  invariants,
  goal,
  isEvaluated = false,
  isStale = false,
  isRunning = false,
  snapshotLabel,
  goalReached,
  stepNumber,
  modeLabel,
}: AirlockSchematicProps) {
  const outerAvailable =
    hasEnumValues(schema, 'outerDoor', ['closed', 'open']) &&
    (state['outerDoor'] === 'open' || state['outerDoor'] === 'closed');
  const outerDoor = outerAvailable
    ? state['outerDoor'] === 'open'
      ? 'open'
      : 'closed'
    : 'unavailable';

  const innerAvailable =
    hasEnumValues(schema, 'innerDoor', ['closed', 'open']) &&
    (state['innerDoor'] === 'open' || state['innerDoor'] === 'closed');
  const innerDoor = innerAvailable
    ? state['innerDoor'] === 'open'
      ? 'open'
      : 'closed'
    : 'unavailable';

  const pressureAvailable =
    hasEnumValues(schema, 'pressure', ['negative', 'equalized']) &&
    (state['pressure'] === 'negative' || state['pressure'] === 'equalized');
  const pressure = pressureAvailable
    ? state['pressure'] === 'equalized'
      ? 'equalized'
      : 'negative'
    : 'unavailable';

  const uvAvailable =
    hasEnumValues(schema, 'uvSterilizer', ['off', 'active']) &&
    (state['uvSterilizer'] === 'active' || state['uvSterilizer'] === 'off');
  const uvState = uvAvailable
    ? state['uvSterilizer'] === 'active'
      ? 'active'
      : 'off'
    : 'unavailable';

  const occupiedAvailable =
    schema !== undefined &&
    Object.hasOwn(schema, 'occupied') &&
    schema['occupied']?.kind === 'boolean' &&
    typeof state['occupied'] === 'boolean';
  const occupiedState = occupiedAvailable
    ? state['occupied'] === true
      ? 'occupied'
      : 'empty'
    : 'unavailable';

  const purgeDef =
    schema !== undefined && Object.hasOwn(schema, 'purgeCycles') ? schema['purgeCycles'] : undefined;
  const purgeAvailable =
    purgeDef?.kind === 'int' &&
    typeof state['purgeCycles'] === 'number' &&
    Number.isSafeInteger(state['purgeCycles']);
  const purgeCycles = purgeAvailable ? (state['purgeCycles'] as number) : null;
  const purgeMax = purgeDef?.kind === 'int' ? purgeDef.max : 2;

  const overrideAvailable =
    schema !== undefined &&
    Object.hasOwn(schema, 'maintenanceOverride') &&
    schema['maintenanceOverride']?.kind === 'boolean' &&
    typeof state['maintenanceOverride'] === 'boolean';
  const overrideState = overrideAvailable
    ? state['maintenanceOverride'] === true
      ? 'engaged'
      : 'off'
    : 'unavailable';

  const hasCanonicalContainment =
    invariants !== undefined && hasCanonicalContainmentInvariantSpec(invariants);
  const hasCanonicalUv = invariants !== undefined && hasCanonicalUvInvariantSpec(invariants);
  const containmentBreach =
    isEvaluated && hasCanonicalContainment && violatedInvariantIds.includes('inv_containment_seal');
  const uvHazard =
    isEvaluated && hasCanonicalUv && violatedInvariantIds.includes('inv_uv_exposure_lock');
  const hasViolation = isEvaluated && violatedInvariantIds.length > 0;
  const hasAirlockInvariants =
    invariants !== undefined && hasCanonicalSealAndUvInvariantSpecs(invariants);
  const isCanonicalGoal = hasCanonicalLabEntryGoalSpec(goal);

  const goalBadgeText =
    goalReached === undefined
      ? ''
      : isCanonicalGoal
        ? goalReached
          ? `GOAL AT STEP ${stepNumber}: LAB ENTRY`
          : `GOAL AT STEP ${stepNumber}: NOT REACHED`
        : goal !== undefined
          ? goalReached
            ? `GOAL AT STEP ${stepNumber}: REACHED (${goal.id})`
            : `GOAL AT STEP ${stepNumber}: NOT REACHED (${goal.id})`
          : goalReached
            ? `GOAL AT STEP ${stepNumber}: REACHED`
            : `GOAL AT STEP ${stepNumber}: NOT REACHED`;

  const changedSet = new Set(changedVars);
  const highlightedSet = new Set(highlightedVars);

  const safetyBadgeTone = !isEvaluated
    ? 'warning'
    : hasViolation
      ? 'danger'
      : evaluatedInvariantIds.length > 0
        ? 'success'
        : 'warning';
  const safetyBadgeSymbol = !isEvaluated
    ? '?'
    : hasViolation
      ? '!'
      : evaluatedInvariantIds.length > 0
        ? '✓'
        : '?';
  const safetyBadgeText = !isEvaluated
    ? 'UNEVALUATED PREVIEW'
    : hasViolation
      ? `INVARIANT BREACH (${violatedInvariantIds.join(', ')})`
      : hasAirlockInvariants
        ? `INVARIANTS HOLD AT STEP ${stepNumber}`
        : evaluatedInvariantIds.length > 0
          ? `INVARIANTS HOLD AT STEP ${stepNumber} (${evaluatedInvariantIds.length})`
          : 'NO INVARIANTS EVALUATED';

  const subtitleText = isRunning
    ? 'Verifying interlock state space…'
    : !isEvaluated
      ? `Draft preview at Step ${stepNumber} (${modeLabel})`
      : isStale
        ? `Outdated snapshot${snapshotLabel ? ` "${snapshotLabel}"` : ''} at Step ${stepNumber} (${modeLabel})`
        : `Snapshot${snapshotLabel ? ` "${snapshotLabel}"` : ''} at Step ${stepNumber} (${modeLabel})`;

  const ariaSummary = [
    `BSL-3 Airlock Schematic at Step ${stepNumber} (${modeLabel}).`,
    isStale ? 'Outdated snapshot: unverified edits are pending.' : '',
    `Outer corridor door: ${outerDoor}.`,
    `Inner BSL-3 lab door: ${innerDoor}.`,
    `Chamber pressure: ${pressure}.`,
    `UV sterilizer: ${uvState}.`,
    `Occupancy: ${occupiedState}.`,
    purgeCycles !== null
      ? `HEPA purge cycles: ${purgeCycles} of ${purgeMax}.`
      : 'HEPA purge cycles: unavailable.',
    `Maintenance override key switch: ${overrideState}.`,
    !isEvaluated
      ? 'Verification has not evaluated this state.'
      : hasViolation
        ? `Alert: Violated invariants ${violatedInvariantIds.join(', ')}.`
        : goalReached
          ? 'Declared goal reached at this step.'
          : `${safetyBadgeText}.`,
  ]
    .filter(Boolean)
    .join(' ');

  const telemetries: readonly TelemetryReadout[] = [
    {
      varName: 'outerDoor',
      label: 'Outer Corridor Door',
      iconKind: outerDoor === 'unavailable' ? 'na' : outerDoor === 'open' ? 'door-open' : 'door-closed',
      displayValue:
        outerDoor === 'unavailable'
          ? 'UNAVAILABLE'
          : outerDoor === 'open'
            ? 'OPEN'
            : 'CLOSED (SEALED)',
      available: outerAvailable,
    },
    {
      varName: 'innerDoor',
      label: 'Inner BSL-3 Lab Door',
      iconKind: innerDoor === 'unavailable' ? 'na' : innerDoor === 'open' ? 'door-open' : 'door-closed',
      displayValue:
        innerDoor === 'unavailable'
          ? 'UNAVAILABLE'
          : innerDoor === 'open'
            ? 'OPEN'
            : 'CLOSED (SEALED)',
      available: innerAvailable,
    },
    {
      varName: 'pressure',
      label: 'Chamber Pressure',
      iconKind: pressure === 'unavailable' ? 'na' : 'pressure',
      displayValue:
        pressure === 'unavailable'
          ? 'UNAVAILABLE'
          : pressure === 'negative'
            ? 'NEGATIVE (-Pa)'
            : 'EQUALIZED (0 Pa)',
      available: pressureAvailable,
    },
    {
      varName: 'uvSterilizer',
      label: 'UV-C Decontamination',
      iconKind: uvState === 'unavailable' ? 'na' : 'uv',
      displayValue:
        uvState === 'unavailable' ? 'UNAVAILABLE' : uvState === 'active' ? 'ACTIVE' : 'OFF',
      available: uvAvailable,
    },
    {
      varName: 'occupied',
      label: 'Personnel Occupancy',
      iconKind: occupiedState === 'unavailable' ? 'na' : 'occupancy',
      displayValue:
        occupiedState === 'unavailable'
          ? 'UNAVAILABLE'
          : occupiedState === 'occupied'
            ? 'OCCUPIED'
            : 'UNOCCUPIED',
      available: occupiedAvailable,
    },
    {
      varName: 'purgeCycles',
      label: 'HEPA Purge Counter',
      iconKind: purgeCycles === null ? 'na' : 'purge',
      displayValue: purgeCycles === null ? 'UNAVAILABLE' : `${purgeCycles} of ${purgeMax} cycles`,
      available: purgeAvailable,
    },
    {
      varName: 'maintenanceOverride',
      label: 'Maintenance Override',
      iconKind: overrideState === 'unavailable' ? 'na' : 'override',
      displayValue:
        overrideState === 'unavailable'
          ? 'UNAVAILABLE'
          : overrideState === 'engaged'
            ? 'ENGAGED'
            : 'DISENGAGED',
      available: overrideAvailable,
    },
  ];

  const outerStroke =
    outerDoor === 'open'
      ? 'var(--color-accent)'
      : outerDoor === 'closed'
        ? 'var(--color-ink)'
        : 'var(--color-ink-muted)';
  const innerStroke = containmentBreach
    ? 'var(--color-danger)'
    : innerDoor === 'open'
      ? 'var(--color-accent)'
      : innerDoor === 'closed'
        ? 'var(--color-ink)'
        : 'var(--color-ink-muted)';
  const chamberStroke = !isEvaluated
    ? 'var(--color-control-border)'
    : hasViolation
      ? 'var(--color-danger)'
      : pressure === 'negative'
        ? 'var(--color-info)'
        : 'var(--color-warning)';

  const chamberFill = hasViolation
    ? 'var(--schematic-chamber-breach)'
    : uvState === 'active'
      ? 'var(--schematic-chamber-uv)'
      : pressure === 'negative'
        ? 'var(--schematic-chamber-neg)'
        : 'var(--schematic-chamber-eq)';

  const isHighlighted = (v: string) => highlightedSet.has(v);
  const isChanged = (v: string) => changedSet.has(v);

  return (
    <section className="is-pane is-schematic-pane" aria-label="Discrete BSL-3 airlock schematic">
      <div className="is-pane-header">
        <div className="is-schematic-heading">
          <h2 className="is-pane-title">Discrete BSL-3 Airlock Schematic</h2>
          <p className="is-pane-subtitle">{subtitleText}</p>
        </div>

        <div className="is-schematic-status-strip">
          {isStale && (
            <span className="is-badge" data-tone="warning" role="status">
              <span aria-hidden="true">!</span> OUTDATED SNAPSHOT
            </span>
          )}
          <span className="is-badge" data-tone={safetyBadgeTone} role="status">
            <span aria-hidden="true">{safetyBadgeSymbol}</span> {safetyBadgeText}
          </span>
          {isEvaluated && goalReached !== undefined && (
            <span className="is-badge" data-tone={goalReached ? 'success' : undefined}>
              <span aria-hidden="true">{goalReached ? '✓' : '○'}</span> {goalBadgeText}
            </span>
          )}
        </div>
      </div>

      <div
        className="is-schematic-well"
        data-stale={isStale ? 'true' : 'false'}
        data-breach={hasViolation ? 'true' : 'false'}
      >
        <svg
          className="is-schematic-svg"
          viewBox="0 0 740 212"
          role="img"
          aria-label={ariaSummary}
        >
          <title>BSL-3 Bio-Containment Airlock P&amp;ID State Diagram</title>
          <defs>
            <pattern id="is-cad-grid" width="20" height="20" patternUnits="userSpaceOnUse">
              <path
                d="M 20 0 L 0 0 0 20"
                fill="none"
                stroke="var(--schematic-grid-line)"
                strokeWidth="1"
              />
            </pattern>
            <clipPath id="is-outer-door-slot">
              <rect x="144" y="60" width="34" height="96" />
            </clipPath>
            <clipPath id="is-inner-door-slot">
              <rect x="522" y="60" width="34" height="96" />
            </clipPath>
          </defs>
          <rect x="0" y="0" width="740" height="212" fill="url(#is-cad-grid)" />

          {/* Corridor / Exterior Zone */}
          <rect
            x="10"
            y="22"
            width="132"
            height="172"
            rx="2"
            fill="var(--schematic-corridor-bg)"
            stroke="var(--color-control-border)"
            strokeWidth="1"
          />
          <text
            x="22"
            y="44"
            fill="var(--color-ink-secondary)"
            fontSize="11.5"
            fontFamily="var(--font-body)"
            fontWeight="600"
          >
            Ambient Corridor
          </text>
          <text
            x="22"
            y="64"
            fill="var(--color-ink-muted)"
            fontSize="11"
            fontFamily="var(--font-mono)"
          >
            P = 0 Pa (ref)
          </text>

          {/* Outer Door Bulkhead & Animated Sliding Leaves */}
          <g
            className="is-svg-module is-svg-door-assembly"
            data-var="outerDoor"
            data-door-state={outerDoor}
            data-changed={isChanged('outerDoor') ? 'true' : undefined}
            data-hovered={isHighlighted('outerDoor') ? 'true' : undefined}
          >
            <rect
              className="is-svg-module-ring"
              x="140"
              y="20"
              width="42"
              height="176"
              rx="3"
              fill="none"
            />
            <rect
              x="142"
              y="22"
              width="38"
              height="38"
              fill="var(--schematic-bulkhead)"
              stroke="var(--color-control-border)"
            />
            <rect
              x="142"
              y="156"
              width="38"
              height="38"
              fill="var(--schematic-bulkhead)"
              stroke="var(--color-control-border)"
            />
            <line
              className="is-door-open-axis"
              x1="161"
              y1="62"
              x2="161"
              y2="154"
              stroke={outerStroke}
              strokeWidth="2"
              strokeDasharray="4 4"
            />
            <g clipPath="url(#is-outer-door-slot)">
              <rect
                className="is-door-leaf is-door-leaf-top"
                x="156"
                y="60"
                width="10"
                height="48"
                rx="1"
                fill={outerDoor === 'open' ? outerStroke : 'var(--color-ink)'}
                stroke="var(--color-surface)"
                strokeWidth="1"
              />
              <rect
                className="is-door-leaf is-door-leaf-bot"
                x="156"
                y="108"
                width="10"
                height="48"
                rx="1"
                fill={outerDoor === 'open' ? outerStroke : 'var(--color-ink)'}
                stroke="var(--color-surface)"
                strokeWidth="1"
              />
              <line
                className="is-door-seal-seam"
                x1="154"
                y1="108"
                x2="168"
                y2="108"
                stroke="var(--color-surface)"
                strokeWidth="1.5"
              />
            </g>
            <text
              x="161"
              y="15"
              textAnchor="middle"
              fill={outerDoor === 'open' ? outerStroke : 'var(--color-ink-secondary)'}
              fontSize="10.5"
              fontWeight="600"
              fontFamily="var(--font-mono)"
            >
              {outerDoor === 'closed'
                ? 'OUTER: SEALED'
                : outerDoor === 'open'
                  ? 'OUTER: OPEN'
                  : 'OUTER: N/A'}
            </text>
          </g>

          {/* Central Airlock Chamber */}
          <rect
            className="is-svg-chamber"
            x="180"
            y="22"
            width="340"
            height="172"
            rx="2"
            fill={chamberFill}
            stroke={chamberStroke}
            strokeWidth="2"
          />
          <text
            x="194"
            y="44"
            fill="var(--color-ink)"
            fontSize="12"
            fontFamily="var(--font-body)"
            fontWeight="600"
          >
            Airlock Chamber
          </text>

          {/* Discrete Negative-Pressure Inward Seal Chevrons */}
          <g
            className="is-svg-airflow"
            data-active={pressure === 'negative' && !hasViolation ? 'true' : 'false'}
            aria-hidden="true"
          >
            <path
              d="M189 90l4 4-4 4M196 90l4 4-4 4"
              fill="none"
              stroke="var(--color-info)"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M511 90l-4 4 4 4M504 90l-4 4 4 4"
              fill="none"
              stroke="var(--color-info)"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </g>

          {/* Pressure Readout Instrument */}
          <g
            className="is-svg-module"
            data-var="pressure"
            data-changed={isChanged('pressure') ? 'true' : undefined}
            data-hovered={isHighlighted('pressure') ? 'true' : undefined}
          >
            <rect
              className="is-svg-instrument"
              x="194"
              y="54"
              width="156"
              height="28"
              rx="3"
              fill="var(--color-surface)"
              stroke={
                pressure === 'negative'
                  ? 'var(--color-info)'
                  : pressure === 'equalized'
                    ? 'var(--color-warning-border)'
                    : 'var(--color-rule)'
              }
            />
            <text
              x="204"
              y="72"
              fill={
                pressure === 'negative'
                  ? 'var(--color-info)'
                  : pressure === 'equalized'
                    ? 'var(--color-warning)'
                    : 'var(--color-ink-muted)'
              }
              fontSize="11"
              fontWeight="600"
              fontFamily="var(--font-mono)"
            >
              {pressure === 'negative'
                ? 'ΔP: NEGATIVE (-Pa)'
                : pressure === 'equalized'
                  ? 'ΔP: EQUALIZED (0 Pa)'
                  : 'ΔP: N/A'}
            </text>
          </g>

          {/* UV-C Lamp Fixture & Animated Beam Rays */}
          <g
            className="is-svg-module"
            data-var="uvSterilizer"
            data-changed={isChanged('uvSterilizer') ? 'true' : undefined}
            data-hovered={isHighlighted('uvSterilizer') ? 'true' : undefined}
          >
            <rect
              className="is-svg-instrument"
              x="362"
              y="30"
              width="144"
              height="28"
              rx="3"
              fill={uvState === 'active' ? 'var(--color-accent-fill)' : 'var(--color-surface)'}
              stroke={uvHazard ? 'var(--color-danger)' : 'var(--color-control-border)'}
            />
            <text
              x="434"
              y="48"
              textAnchor="middle"
              fill={uvState === 'active' ? 'var(--color-accent-ink)' : 'var(--color-ink-secondary)'}
              fontSize="11"
              fontWeight="600"
              fontFamily="var(--font-mono)"
            >
              {uvState === 'active' ? 'UV-C: ACTIVE' : uvState === 'off' ? 'UV-C: OFF' : 'UV-C: N/A'}
            </text>
            <g
              className="is-svg-uv-rays"
              data-active={uvState === 'active' ? 'true' : 'false'}
              stroke={uvHazard ? 'var(--color-danger)' : 'var(--color-accent)'}
              strokeWidth="1.4"
              strokeDasharray="3 3"
              aria-hidden="true"
            >
              <line x1="385" y1="58" x2="372" y2="96" />
              <line x1="434" y1="58" x2="434" y2="96" />
              <line x1="483" y1="58" x2="496" y2="96" />
            </g>
          </g>

          {/* Personnel Occupancy Module */}
          <g
            className="is-svg-module"
            data-var="occupied"
            data-changed={isChanged('occupied') ? 'true' : undefined}
            data-hovered={isHighlighted('occupied') ? 'true' : undefined}
          >
            <rect
              className="is-svg-instrument"
              x="194"
              y="100"
              width="102"
              height="78"
              rx="3"
              fill="var(--color-surface)"
              stroke={
                uvHazard
                  ? 'var(--color-danger)'
                  : occupiedState === 'occupied'
                    ? 'var(--color-info)'
                    : 'var(--color-rule)'
              }
            />
            <text
              x="245"
              y="117"
              textAnchor="middle"
              fill="var(--color-ink-muted)"
              fontSize="10.5"
              fontFamily="var(--font-body)"
              fontWeight="500"
            >
              Occupancy
            </text>
            <g
              className="is-svg-person"
              data-occupied={occupiedState === 'occupied' ? 'true' : 'false'}
              aria-hidden={occupiedState !== 'occupied'}
            >
              <circle
                cx="245"
                cy="132"
                r="6"
                fill={uvHazard ? 'var(--color-danger)' : 'var(--color-info)'}
              />
              <path
                d="M233 152c1.5-7 6-10 12-10s10.5 3 12 10"
                fill="none"
                stroke={uvHazard ? 'var(--color-danger)' : 'var(--color-info)'}
                strokeWidth="2"
                strokeLinecap="round"
              />
            </g>
            <text
              x="245"
              y="169"
              textAnchor="middle"
              fill={
                occupiedState === 'occupied'
                  ? uvHazard
                    ? 'var(--color-danger)'
                    : 'var(--color-ink)'
                  : 'var(--color-ink-muted)'
              }
              fontSize="10.5"
              fontWeight={occupiedState === 'occupied' ? '600' : '500'}
              fontFamily="var(--font-mono)"
            >
              {occupiedState === 'occupied'
                ? 'OCCUPIED'
                : occupiedState === 'empty'
                  ? 'UNOCCUPIED'
                  : 'N/A'}
            </text>
          </g>

          {/* HEPA Purge Cycle Bar [0..2] */}
          <g
            className="is-svg-module"
            data-var="purgeCycles"
            data-changed={isChanged('purgeCycles') ? 'true' : undefined}
            data-hovered={isHighlighted('purgeCycles') ? 'true' : undefined}
          >
            <rect
              className="is-svg-instrument"
              x="306"
              y="100"
              width="98"
              height="78"
              rx="3"
              fill="var(--color-surface)"
              stroke="var(--color-rule)"
            />
            <text
              x="355"
              y="117"
              textAnchor="middle"
              fill="var(--color-ink-muted)"
              fontSize="10.5"
              fontFamily="var(--font-body)"
              fontWeight="500"
            >
              HEPA Purge
            </text>
            <rect
              className="is-svg-purge-seg"
              data-filled={purgeCycles !== null && purgeCycles >= 1 ? 'true' : 'false'}
              x="320"
              y="128"
              width="30"
              height="18"
              rx="2"
              fill={
                purgeCycles !== null && purgeCycles >= 1
                  ? 'var(--color-success)'
                  : 'var(--color-surface-subtle)'
              }
              stroke={
                purgeCycles !== null && purgeCycles >= 1
                  ? 'var(--color-success)'
                  : 'var(--color-control-border)'
              }
            />
            <rect
              className="is-svg-purge-seg"
              data-filled={purgeCycles !== null && purgeCycles >= 2 ? 'true' : 'false'}
              x="360"
              y="128"
              width="30"
              height="18"
              rx="2"
              fill={
                purgeCycles !== null && purgeCycles >= 2
                  ? 'var(--color-success)'
                  : 'var(--color-surface-subtle)'
              }
              stroke={
                purgeCycles !== null && purgeCycles >= 2
                  ? 'var(--color-success)'
                  : 'var(--color-control-border)'
              }
            />
            <text
              x="355"
              y="169"
              textAnchor="middle"
              fill={purgeCycles !== null ? 'var(--color-ink)' : 'var(--color-ink-muted)'}
              fontSize="10.5"
              fontWeight="600"
              fontFamily="var(--font-mono)"
            >
              {purgeCycles !== null ? `${purgeCycles} / ${purgeMax} cycles` : 'N/A'}
            </text>
          </g>

          {/* Maintenance Override Key Switch */}
          <g
            className="is-svg-module"
            data-var="maintenanceOverride"
            data-changed={isChanged('maintenanceOverride') ? 'true' : undefined}
            data-hovered={isHighlighted('maintenanceOverride') ? 'true' : undefined}
          >
            <rect
              className="is-svg-instrument"
              x="414"
              y="100"
              width="92"
              height="78"
              rx="3"
              fill={overrideState === 'engaged' ? 'var(--color-warning-soft)' : 'var(--color-surface)'}
              stroke={overrideState === 'engaged' ? 'var(--color-warning-border)' : 'var(--color-rule)'}
            />
            <text
              x="460"
              y="117"
              textAnchor="middle"
              fill="var(--color-ink-muted)"
              fontSize="10.5"
              fontFamily="var(--font-body)"
              fontWeight="500"
            >
              Override Key
            </text>
            <circle
              className="is-svg-key-barrel"
              cx="460"
              cy="137"
              r="9.5"
              fill={overrideState === 'engaged' ? 'var(--color-warning)' : 'var(--color-surface-subtle)'}
              stroke={overrideState === 'engaged' ? 'var(--color-warning)' : 'var(--color-control-border)'}
            />
            <line
              className="is-svg-key-blade"
              data-engaged={overrideState === 'engaged' ? 'true' : 'false'}
              x1="460"
              y1="137"
              x2="460"
              y2="130"
              stroke={overrideState === 'engaged' ? 'var(--color-surface)' : 'var(--color-ink-secondary)'}
              strokeWidth="2.2"
              strokeLinecap="round"
            />
            <text
              x="460"
              y="169"
              textAnchor="middle"
              fill={
                overrideState === 'engaged'
                  ? 'var(--color-warning)'
                  : overrideState === 'off'
                    ? 'var(--color-ink-secondary)'
                    : 'var(--color-ink-muted)'
              }
              fontSize="10.5"
              fontWeight="600"
              fontFamily="var(--font-mono)"
            >
              {overrideState === 'engaged' ? 'ENGAGED' : overrideState === 'off' ? 'OFF' : 'N/A'}
            </text>
          </g>

          {/* Inner Door Bulkhead & Animated Sliding Leaves */}
          <g
            className="is-svg-module is-svg-door-assembly"
            data-var="innerDoor"
            data-door-state={innerDoor}
            data-changed={isChanged('innerDoor') ? 'true' : undefined}
            data-hovered={isHighlighted('innerDoor') ? 'true' : undefined}
          >
            <rect
              className="is-svg-module-ring"
              x="518"
              y="20"
              width="42"
              height="176"
              rx="3"
              fill="none"
            />
            <rect
              x="520"
              y="22"
              width="38"
              height="38"
              fill="var(--schematic-bulkhead)"
              stroke="var(--color-control-border)"
            />
            <rect
              x="520"
              y="156"
              width="38"
              height="38"
              fill="var(--schematic-bulkhead)"
              stroke="var(--color-control-border)"
            />
            <line
              className="is-door-open-axis"
              x1="539"
              y1="62"
              x2="539"
              y2="154"
              stroke={innerStroke}
              strokeWidth="2"
              strokeDasharray="4 4"
            />
            <g clipPath="url(#is-inner-door-slot)">
              <rect
                className="is-door-leaf is-door-leaf-top"
                x="534"
                y="60"
                width="10"
                height="48"
                rx="1"
                fill={innerDoor === 'open' ? innerStroke : 'var(--color-ink)'}
                stroke="var(--color-surface)"
                strokeWidth="1"
              />
              <rect
                className="is-door-leaf is-door-leaf-bot"
                x="534"
                y="108"
                width="10"
                height="48"
                rx="1"
                fill={innerDoor === 'open' ? innerStroke : 'var(--color-ink)'}
                stroke="var(--color-surface)"
                strokeWidth="1"
              />
              <line
                className="is-door-seal-seam"
                x1="532"
                y1="108"
                x2="546"
                y2="108"
                stroke="var(--color-surface)"
                strokeWidth="1.5"
              />
            </g>
            <text
              x="539"
              y="15"
              textAnchor="middle"
              fill={innerDoor === 'open' ? innerStroke : 'var(--color-ink-secondary)'}
              fontSize="10.5"
              fontWeight="600"
              fontFamily="var(--font-mono)"
            >
              {innerDoor === 'closed'
                ? 'INNER: SEALED'
                : innerDoor === 'open'
                  ? 'INNER: OPEN'
                  : 'INNER: N/A'}
            </text>
          </g>

          {/* Inner BSL-3 Containment Lab Zone */}
          <rect
            className="is-svg-lab"
            x="558"
            y="22"
            width="172"
            height="172"
            rx="2"
            fill={containmentBreach ? 'var(--schematic-chamber-breach)' : 'var(--schematic-lab-bg)'}
            stroke={containmentBreach ? 'var(--color-danger)' : 'var(--color-info)'}
            strokeWidth="1.5"
          />
          <text
            x="570"
            y="44"
            fill={containmentBreach ? 'var(--color-danger)' : 'var(--color-info)'}
            fontSize="11.5"
            fontFamily="var(--font-body)"
            fontWeight="600"
          >
            BSL-3 Containment Lab
          </text>
          <text
            x="570"
            y="64"
            fill="var(--color-ink-secondary)"
            fontSize="11"
            fontFamily="var(--font-mono)"
          >
            Negative seal zone
          </text>
          {containmentBreach && (
            <g className="is-svg-breach-callout">
              <rect
                x="568"
                y="122"
                width="152"
                height="46"
                rx="3"
                fill="var(--color-danger-soft)"
                stroke="var(--color-danger)"
                strokeWidth="1.2"
              />
              <text
                x="644"
                y="141"
                textAnchor="middle"
                fill="var(--color-danger)"
                fontSize="11"
                fontWeight="600"
                fontFamily="var(--font-mono)"
              >
                ! CONTAINMENT BREACH
              </text>
              <text
                x="644"
                y="157"
                textAnchor="middle"
                fill="var(--color-ink)"
                fontSize="10"
                fontFamily="var(--font-mono)"
              >
                inv_containment_seal
              </text>
            </g>
          )}
        </svg>

        {/* Readable stacked P&ID flow schematic for narrow viewports (< 640px) */}
        <div className="is-schematic-compact" role="group" aria-label={ariaSummary}>
          <div className="is-compact-zone">
            <strong>Ambient Corridor</strong>
            <span className="is-mono">P = 0 Pa</span>
          </div>

          <div
            className="is-compact-door"
            data-open={outerDoor === 'open' ? 'true' : 'false'}
          >
            <span>Outer Bulkhead (outerDoor)</span>
            <strong>{outerDoor === 'unavailable' ? 'N/A' : outerDoor.toUpperCase()}</strong>
          </div>

          <div
            className="is-compact-zone is-compact-zone-chamber"
            data-breach={hasViolation ? 'true' : 'false'}
          >
            <div className="is-section-header">
              <strong>Airlock Chamber</strong>
              <span className="is-mono">
                {pressure === 'negative'
                  ? 'ΔP: NEGATIVE (-Pa)'
                  : pressure === 'equalized'
                    ? 'ΔP: EQUALIZED (0 Pa)'
                    : 'ΔP: N/A'}
              </span>
            </div>
            <div className="is-compact-subgrid">
              <span>UV-C: {uvState.toUpperCase()}</span>
              <span>
                Occupancy:{' '}
                {occupiedState === 'occupied'
                  ? 'OCCUPIED'
                  : occupiedState === 'empty'
                    ? 'UNOCCUPIED'
                    : 'N/A'}
              </span>
              <span>HEPA: {purgeCycles !== null ? `${purgeCycles}/${purgeMax} cycles` : 'N/A'}</span>
              <span>Override: {overrideState.toUpperCase()}</span>
            </div>
          </div>

          <div
            className="is-compact-door"
            data-open={innerDoor === 'open' ? 'true' : 'false'}
            data-breach={containmentBreach ? 'true' : 'false'}
          >
            <span>Inner Bulkhead (innerDoor)</span>
            <strong>
              {containmentBreach
                ? 'OPEN (BREACH)'
                : innerDoor === 'unavailable'
                  ? 'N/A'
                  : innerDoor.toUpperCase()}
            </strong>
          </div>

          <div className="is-compact-zone">
            <strong>BSL-3 Containment Lab</strong>
            <span className="is-mono">
              {containmentBreach ? '! inv_containment_seal' : 'Negative seal zone'}
            </span>
          </div>
        </div>
      </div>

      {/* Explicit accessible 7-variable telemetry strip */}
      <dl className="is-telemetry-grid" aria-label="Airlock discrete telemetry readouts">
        {telemetries.map((item) => {
          const changed = changedSet.has(item.varName);
          const hovered = highlightedSet.has(item.varName);
          return (
            <div
              key={item.varName}
              className="is-telemetry-cell"
              data-var={item.varName}
              data-changed={changed ? 'true' : 'false'}
              data-hovered={hovered ? 'true' : undefined}
              data-available={item.available ? 'true' : 'false'}
            >
              <dt>
                <span className="is-telemetry-label">{item.label}</span>{' '}
                <code className="is-telemetry-var">{item.varName}</code>
              </dt>
              <dd>
                <TelemetryGlyph kind={item.iconKind} />
                <span
                  key={changed ? `changed-${item.displayValue}` : 'unchanged'}
                  className={changed ? 'rc-value-changed' : undefined}
                >
                  {item.displayValue}
                </span>
                {changed && <span className="is-telemetry-change">MODIFIED</span>}
              </dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}
