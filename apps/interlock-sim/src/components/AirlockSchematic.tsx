import type { StateSchema, StateSnapshot } from '@rulecanvas/core';

export interface AirlockSchematicProps {
  readonly schema?: StateSchema | undefined;
  readonly state: StateSnapshot;
  readonly changedVars: readonly string[];
  readonly violatedInvariantIds: readonly string[];
  readonly evaluatedInvariantIds?: readonly string[] | undefined;
  readonly isEvaluated?: boolean | undefined;
  readonly goalReached: boolean | undefined;
  readonly stepNumber: number;
  readonly modeLabel: string;
}

interface TelemetryReadout {
  readonly varName: string;
  readonly label: string;
  readonly symbol: string;
  readonly displayValue: string;
  readonly available: boolean;
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
  violatedInvariantIds,
  evaluatedInvariantIds = [],
  isEvaluated = false,
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

  const containmentBreach = isEvaluated && violatedInvariantIds.includes('inv_containment_seal');
  const uvHazard = isEvaluated && violatedInvariantIds.includes('inv_uv_exposure_lock');
  const hasViolation = isEvaluated && violatedInvariantIds.length > 0;
  const hasAirlockInvariants =
    evaluatedInvariantIds.includes('inv_containment_seal') &&
    evaluatedInvariantIds.includes('inv_uv_exposure_lock');
  const changedSet = new Set(changedVars);

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
        ? 'SEAL & UV SAFE'
        : evaluatedInvariantIds.length > 0
          ? `INVARIANTS SAFE (${evaluatedInvariantIds.length})`
          : 'NO INVARIANTS EVALUATED';

  const ariaSummary = [
    `BSL-3 Airlock Schematic at Step ${stepNumber} (${modeLabel}).`,
    `Outer corridor door: ${outerDoor}.`,
    `Inner BSL-3 lab door: ${innerDoor}.`,
    `Chamber pressure: ${pressure}.`,
    `UV sterilizer: ${uvState}.`,
    `Occupancy: ${occupiedState}.`,
    purgeCycles !== null ? `HEPA purge cycles: ${purgeCycles} of ${purgeMax}.` : 'HEPA purge cycles: unavailable.',
    `Maintenance override key switch: ${overrideState}.`,
    !isEvaluated
      ? 'Verification has not evaluated this state.'
      : hasViolation
        ? `Alert: Violated invariants ${violatedInvariantIds.join(', ')}.`
        : goalReached
          ? 'Declared goal reached.'
          : `${safetyBadgeText}.`,
  ].join(' ');

  const telemetries: readonly TelemetryReadout[] = [
    {
      varName: 'outerDoor',
      label: 'Outer Corridor Door',
      symbol: outerDoor === 'unavailable' ? '[?]' : outerDoor === 'open' ? '[  ]' : '[||]',
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
      symbol: innerDoor === 'unavailable' ? '[?]' : innerDoor === 'open' ? '[  ]' : '[||]',
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
      symbol:
        pressure === 'unavailable' ? '[?]' : pressure === 'negative' ? '<<-' : '===',
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
      symbol: uvState === 'unavailable' ? '[?]' : uvState === 'active' ? '***' : '---',
      displayValue:
        uvState === 'unavailable' ? 'UNAVAILABLE' : uvState === 'active' ? 'ACTIVE' : 'OFF',
      available: uvAvailable,
    },
    {
      varName: 'occupied',
      label: 'Personnel Occupancy',
      symbol:
        occupiedState === 'unavailable'
          ? '[?]'
          : occupiedState === 'occupied'
            ? '[P]'
            : '[0]',
      displayValue:
        occupiedState === 'unavailable'
          ? 'UNAVAILABLE'
          : occupiedState === 'occupied'
            ? 'OCCUPIED (true)'
            : 'EMPTY (false)',
      available: occupiedAvailable,
    },
    {
      varName: 'purgeCycles',
      label: 'HEPA Purge Counter',
      symbol:
        purgeCycles === null
          ? '[?]'
          : `[${purgeCycles >= 1 ? '#' : '.'}${purgeCycles >= 2 ? '#' : '.'}]`,
      displayValue: purgeCycles === null ? 'UNAVAILABLE' : `${purgeCycles} of ${purgeMax} cycles`,
      available: purgeAvailable,
    },
    {
      varName: 'maintenanceOverride',
      label: 'Maintenance Override Key',
      symbol:
        overrideState === 'unavailable'
          ? '[?]'
          : overrideState === 'engaged'
            ? '[!]'
            : '[ ]',
      displayValue:
        overrideState === 'unavailable'
          ? 'UNAVAILABLE'
          : overrideState === 'engaged'
            ? 'ENGAGED (true)'
            : 'OFF (false)',
      available: overrideAvailable,
    },
  ];

  const outerStroke =
    outerDoor === 'open'
      ? 'var(--color-accent)'
      : outerDoor === 'closed'
        ? 'var(--color-ink)'
        : 'var(--color-muted)';
  const innerStroke = containmentBreach
    ? 'var(--color-error)'
    : innerDoor === 'open'
      ? 'var(--color-accent)'
      : innerDoor === 'closed'
        ? 'var(--color-ink)'
        : 'var(--color-muted)';
  const chamberStroke = !isEvaluated
    ? 'var(--color-rule)'
    : hasViolation
      ? 'var(--color-error)'
      : pressure === 'negative'
        ? 'var(--color-accent-2)'
        : 'var(--color-warning)';

  return (
    <section className="is-pane" aria-label="Discrete BSL-3 airlock schematic">
      <div className="is-pane-header">
        <div>
          <h2 className="is-pane-title">Discrete BSL-3 Airlock Schematic</h2>
          <p className="is-pane-subtitle">
            Live vessel state at <span className="is-tabular">Step {stepNumber}</span> ({modeLabel})
          </p>
        </div>

        <div className="is-schematic-status-strip">
          <span className="is-badge" data-tone={safetyBadgeTone} role="status">
            <span aria-hidden="true">{safetyBadgeSymbol}</span> {safetyBadgeText}
          </span>
          {isEvaluated && goalReached !== undefined && (
            <span className="is-badge" data-tone={goalReached ? 'success' : 'info'}>
              <span aria-hidden="true">{goalReached ? '✓' : '○'}</span>{' '}
              {goalReached ? 'GOAL REACHED: LAB ENTRY' : 'GOAL NOT REACHED'}
            </span>
          )}
        </div>
      </div>

      <div className="is-schematic-well is-ticks">
        <svg
          className="is-schematic-svg"
          viewBox="0 0 740 220"
          role="img"
          aria-label={ariaSummary}
        >
          <title>BSL-3 Bio-Containment Airlock Discrete State Diagram</title>

          {/* Corridor / Exterior Zone */}
          <rect
            x="10"
            y="24"
            width="132"
            height="172"
            fill="oklch(11% 0.008 75)"
            stroke="var(--color-rule)"
            strokeWidth="1"
          />
          <text
            x="22"
            y="46"
            fill="var(--color-muted)"
            fontSize="11"
            fontFamily="var(--font-body)"
            fontWeight="500"
          >
            Ambient Corridor
          </text>
          <text
            x="22"
            y="66"
            fill="var(--color-ink-2)"
            fontSize="12"
            fontFamily="var(--font-outlier)"
          >
            P = 0 Pa
          </text>

          {/* Outer Door Bulkhead */}
          <rect x="142" y="24" width="38" height="38" fill="var(--color-paper-2)" stroke="var(--color-rule)" />
          <rect x="142" y="158" width="38" height="38" fill="var(--color-paper-2)" stroke="var(--color-rule)" />
          {outerDoor === 'closed' ? (
            <>
              <rect
                x="156"
                y="62"
                width="10"
                height="96"
                fill="var(--color-ink)"
                stroke="var(--color-paper)"
                strokeWidth="1"
              />
              <text
                x="161"
                y="18"
                textAnchor="middle"
                fill="var(--color-ink-2)"
                fontSize="11"
                fontFamily="var(--font-outlier)"
              >
                OUTER: CLOSED
              </text>
            </>
          ) : outerDoor === 'open' ? (
            <>
              <line
                x1="161"
                y1="64"
                x2="161"
                y2="156"
                stroke={outerStroke}
                strokeWidth="2"
                strokeDasharray="4 4"
              />
              <rect x="146" y="64" width="30" height="8" fill={outerStroke} />
              <rect x="146" y="148" width="30" height="8" fill={outerStroke} />
              <text
                x="161"
                y="18"
                textAnchor="middle"
                fill={outerStroke}
                fontSize="11"
                fontFamily="var(--font-outlier)"
              >
                OUTER: OPEN
              </text>
            </>
          ) : (
            <>
              <line x1="161" y1="64" x2="161" y2="156" stroke={outerStroke} strokeWidth="1" strokeDasharray="2 4" />
              <text
                x="161"
                y="18"
                textAnchor="middle"
                fill="var(--color-muted)"
                fontSize="10.5"
                fontFamily="var(--font-outlier)"
              >
                OUTER: N/A
              </text>
            </>
          )}

          {/* Central Airlock Chamber */}
          <rect
            x="180"
            y="24"
            width="340"
            height="172"
            fill={
              hasViolation
                ? 'oklch(14% 0.045 25)'
                : uvState === 'active'
                  ? 'oklch(15% 0.035 280)'
                  : pressure === 'negative'
                    ? 'oklch(11% 0.02 250)'
                    : 'oklch(12% 0.015 70)'
            }
            stroke={chamberStroke}
            strokeWidth="2"
          />
          <text
            x="194"
            y="46"
            fill="var(--color-ink)"
            fontSize="12"
            fontFamily="var(--font-body)"
            fontWeight="500"
          >
            Airlock Chamber
          </text>

          {/* Pressure Readout Banner */}
          <rect
            x="194"
            y="56"
            width="154"
            height="28"
            fill="var(--color-paper-3)"
            stroke={
              pressure === 'negative'
                ? 'var(--color-accent-2)'
                : pressure === 'equalized'
                  ? 'var(--color-warning)'
                  : 'var(--color-rule)'
            }
          />
          <text
            x="202"
            y="74"
            fill={
              pressure === 'negative'
                ? 'var(--color-accent-2)'
                : pressure === 'equalized'
                  ? 'var(--color-warning)'
                  : 'var(--color-muted)'
            }
            fontSize="11"
            fontFamily="var(--font-outlier)"
          >
            {pressure === 'negative'
              ? '<< NEGATIVE (-Pa)'
              : pressure === 'equalized'
                ? '== EQUALIZED (0 Pa)'
                : 'PRESSURE: N/A'}
          </text>

          {/* UV-C Lamp Fixture */}
          <rect
            x="362"
            y="30"
            width="144"
            height="28"
            fill={uvState === 'active' ? 'var(--color-accent)' : 'var(--color-paper-2)'}
            stroke={uvHazard ? 'var(--color-error)' : 'var(--color-rule)'}
          />
          <text
            x="434"
            y="48"
            textAnchor="middle"
            fill={uvState === 'active' ? 'var(--color-accent-ink)' : 'var(--color-muted)'}
            fontSize="11"
            fontFamily="var(--font-outlier)"
          >
            {uvState === 'active' ? 'UV-C: ACTIVE ***' : uvState === 'off' ? 'UV-C: OFF' : 'UV-C: N/A'}
          </text>
          {uvState === 'active' && (
            <g stroke="var(--color-accent)" strokeWidth="1" strokeDasharray="3 3" opacity="0.85">
              <line x1="385" y1="58" x2="372" y2="122" />
              <line x1="434" y1="58" x2="434" y2="122" />
              <line x1="483" y1="58" x2="496" y2="122" />
            </g>
          )}

          {/* Personnel Occupancy Icon */}
          <rect
            x="194"
            y="102"
            width="102"
            height="76"
            fill="var(--color-paper-2)"
            stroke={occupiedState === 'occupied' ? 'var(--color-ink)' : 'var(--color-rule)'}
          />
          <text
            x="245"
            y="120"
            textAnchor="middle"
            fill="var(--color-muted)"
            fontSize="10.5"
            fontFamily="var(--font-body)"
          >
            Occupancy
          </text>
          {occupiedState === 'occupied' ? (
            <g>
              <rect x="239" y="128" width="12" height="12" fill="var(--color-ink)" />
              <rect x="234" y="142" width="22" height="18" fill="var(--color-accent-2)" />
              <text
                x="245"
                y="172"
                textAnchor="middle"
                fill="var(--color-ink)"
                fontSize="11"
                fontFamily="var(--font-outlier)"
              >
                OCCUPIED
              </text>
            </g>
          ) : (
            <text
              x="245"
              y="156"
              textAnchor="middle"
              fill="var(--color-muted)"
              fontSize="11.5"
              fontFamily="var(--font-outlier)"
            >
              {occupiedState === 'empty' ? 'EMPTY' : 'N/A'}
            </text>
          )}

          {/* HEPA Purge Cycle Bar [0..2] */}
          <rect
            x="306"
            y="102"
            width="98"
            height="76"
            fill="var(--color-paper-2)"
            stroke="var(--color-rule)"
          />
          <text
            x="355"
            y="120"
            textAnchor="middle"
            fill="var(--color-muted)"
            fontSize="10.5"
            fontFamily="var(--font-body)"
          >
            HEPA Purge
          </text>
          <rect
            x="320"
            y="130"
            width="30"
            height="18"
            fill={purgeCycles !== null && purgeCycles >= 1 ? 'var(--color-success)' : 'var(--color-paper-3)'}
            stroke="var(--color-control-border)"
          />
          <rect
            x="360"
            y="130"
            width="30"
            height="18"
            fill={purgeCycles !== null && purgeCycles >= 2 ? 'var(--color-success)' : 'var(--color-paper-3)'}
            stroke="var(--color-control-border)"
          />
          <text
            x="355"
            y="168"
            textAnchor="middle"
            fill={purgeCycles !== null ? 'var(--color-ink)' : 'var(--color-muted)'}
            fontSize="11"
            fontFamily="var(--font-outlier)"
          >
            {purgeCycles !== null ? `${purgeCycles} / ${purgeMax} cycles` : 'N/A'}
          </text>

          {/* Maintenance Override Key Switch */}
          <rect
            x="414"
            y="102"
            width="92"
            height="76"
            fill={overrideState === 'engaged' ? 'var(--color-accent-soft)' : 'var(--color-paper-2)'}
            stroke={overrideState === 'engaged' ? 'var(--color-accent)' : 'var(--color-rule)'}
          />
          <text
            x="460"
            y="120"
            textAnchor="middle"
            fill="var(--color-muted)"
            fontSize="10.5"
            fontFamily="var(--font-body)"
          >
            Override Key
          </text>
          <rect
            x="448"
            y="130"
            width="24"
            height="18"
            fill={overrideState === 'engaged' ? 'var(--color-accent)' : 'var(--color-paper-3)'}
            stroke={overrideState === 'engaged' ? 'var(--color-accent)' : 'var(--color-control-border)'}
          />
          <text
            x="460"
            y="168"
            textAnchor="middle"
            fill={
              overrideState === 'engaged'
                ? 'var(--color-accent)'
                : overrideState === 'off'
                  ? 'var(--color-ink-2)'
                  : 'var(--color-muted)'
            }
            fontSize="11"
            fontFamily="var(--font-outlier)"
          >
            {overrideState === 'engaged' ? 'ENGAGED' : overrideState === 'off' ? 'OFF' : 'N/A'}
          </text>

          {/* Inner Door Bulkhead */}
          <rect x="520" y="24" width="38" height="38" fill="var(--color-paper-2)" stroke="var(--color-rule)" />
          <rect x="520" y="158" width="38" height="38" fill="var(--color-paper-2)" stroke="var(--color-rule)" />
          {innerDoor === 'closed' ? (
            <>
              <rect
                x="534"
                y="62"
                width="10"
                height="96"
                fill="var(--color-ink)"
                stroke="var(--color-paper)"
                strokeWidth="1"
              />
              <text
                x="539"
                y="18"
                textAnchor="middle"
                fill="var(--color-ink-2)"
                fontSize="11"
                fontFamily="var(--font-outlier)"
              >
                INNER: CLOSED
              </text>
            </>
          ) : innerDoor === 'open' ? (
            <>
              <line
                x1="539"
                y1="64"
                x2="539"
                y2="156"
                stroke={innerStroke}
                strokeWidth="2"
                strokeDasharray="4 4"
              />
              <rect x="524" y="64" width="30" height="8" fill={innerStroke} />
              <rect x="524" y="148" width="30" height="8" fill={innerStroke} />
              <text
                x="539"
                y="18"
                textAnchor="middle"
                fill={innerStroke}
                fontSize="11"
                fontFamily="var(--font-outlier)"
              >
                INNER: OPEN
              </text>
            </>
          ) : (
            <>
              <line x1="539" y1="64" x2="539" y2="156" stroke={innerStroke} strokeWidth="1" strokeDasharray="2 4" />
              <text
                x="539"
                y="18"
                textAnchor="middle"
                fill="var(--color-muted)"
                fontSize="10.5"
                fontFamily="var(--font-outlier)"
              >
                INNER: N/A
              </text>
            </>
          )}

          {/* Inner BSL-3 Lab Zone (widened 172px so labels fit cleanly) */}
          <rect
            x="558"
            y="24"
            width="172"
            height="172"
            fill={containmentBreach ? 'oklch(16% 0.06 25)' : 'oklch(10% 0.025 250)'}
            stroke={containmentBreach ? 'var(--color-error)' : 'var(--color-accent-2)'}
            strokeWidth="1"
          />
          <text
            x="570"
            y="46"
            fill="var(--color-accent-2)"
            fontSize="11"
            fontFamily="var(--font-body)"
            fontWeight="500"
          >
            BSL-3 Containment Lab
          </text>
          <text
            x="570"
            y="66"
            fill="var(--color-ink-2)"
            fontSize="11"
            fontFamily="var(--font-outlier)"
          >
            Negative seal zone
          </text>
          {containmentBreach && (
            <g>
              <rect
                x="568"
                y="124"
                width="152"
                height="44"
                fill="var(--color-error-bg)"
                stroke="var(--color-error)"
              />
              <text
                x="644"
                y="142"
                textAnchor="middle"
                fill="var(--color-error)"
                fontSize="11"
                fontFamily="var(--font-outlier)"
              >
                ! BREACH
              </text>
              <text
                x="644"
                y="158"
                textAnchor="middle"
                fill="var(--color-ink)"
                fontSize="10"
                fontFamily="var(--font-outlier)"
              >
                inv_containment_seal
              </text>
            </g>
          )}
        </svg>
      </div>

      {/* Explicit accessible 7-variable telemetry strip */}
      <dl className="is-telemetry-grid" aria-label="Airlock discrete telemetry readouts">
        {telemetries.map((item) => {
          const changed = changedSet.has(item.varName);
          return (
            <div
              key={item.varName}
              className="is-telemetry-cell"
              data-var={item.varName}
              data-changed={changed ? 'true' : 'false'}
              data-available={item.available ? 'true' : 'false'}
            >
              <dt>
                <span>{item.label}</span>
                {changed && <span className="is-telemetry-change">* MODIFIED</span>}
              </dt>
              <dd>
                <span aria-hidden="true">{item.symbol}</span> {item.displayValue}
              </dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}
