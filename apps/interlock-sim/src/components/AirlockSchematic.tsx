import type { StateSnapshot } from '@rulecanvas/core';

export interface AirlockSchematicProps {
  readonly state: StateSnapshot;
  readonly changedVars: readonly string[];
  readonly violatedInvariantIds: readonly string[];
  readonly goalReached: boolean | undefined;
  readonly stepNumber: number;
  readonly modeLabel: string;
}

interface TelemetryReadout {
  readonly varName: string;
  readonly label: string;
  readonly symbol: string;
  readonly displayValue: string;
}

export function AirlockSchematic({
  state,
  changedVars,
  violatedInvariantIds,
  goalReached,
  stepNumber,
  modeLabel,
}: AirlockSchematicProps) {
  const outerDoor = state['outerDoor'] === 'open' ? 'open' : 'closed';
  const innerDoor = state['innerDoor'] === 'open' ? 'open' : 'closed';
  const pressure = state['pressure'] === 'equalized' ? 'equalized' : 'negative';
  const uvActive = state['uvSterilizer'] === 'active';
  const occupied = state['occupied'] === true;
  const purgeCycles =
    typeof state['purgeCycles'] === 'number' && Number.isFinite(state['purgeCycles'])
      ? state['purgeCycles']
      : 0;
  const overrideEngaged = state['maintenanceOverride'] === true;

  const containmentBreach = violatedInvariantIds.includes('inv_containment_seal');
  const uvHazard = violatedInvariantIds.includes('inv_uv_exposure_lock');
  const hasViolation = violatedInvariantIds.length > 0;
  const changedSet = new Set(changedVars);

  const ariaSummary = [
    `BSL-3 Airlock Schematic at Step ${stepNumber} (${modeLabel}).`,
    `Outer corridor door: ${outerDoor}.`,
    `Inner BSL-3 lab door: ${innerDoor}.`,
    `Chamber pressure: ${pressure}.`,
    `UV sterilizer: ${uvActive ? 'active' : 'off'}.`,
    `Occupied: ${occupied ? 'true' : 'false'}.`,
    `HEPA purge cycles: ${purgeCycles} of 2.`,
    `Maintenance override key switch: ${overrideEngaged ? 'engaged' : 'off'}.`,
    hasViolation
      ? `Alert: Violated invariants ${violatedInvariantIds.join(', ')}.`
      : goalReached
        ? 'Safe lab entry goal reached.'
        : 'All safety invariants currently satisfied.',
  ].join(' ');

  const telemetries: readonly TelemetryReadout[] = [
    {
      varName: 'outerDoor',
      label: 'Outer Corridor Door',
      symbol: outerDoor === 'open' ? '[  ]' : '[||]',
      displayValue: outerDoor === 'open' ? 'OPEN' : 'CLOSED (SEALED)',
    },
    {
      varName: 'innerDoor',
      label: 'Inner BSL-3 Lab Door',
      symbol: innerDoor === 'open' ? '[  ]' : '[||]',
      displayValue: innerDoor === 'open' ? 'OPEN' : 'CLOSED (SEALED)',
    },
    {
      varName: 'pressure',
      label: 'Chamber Pressure',
      symbol: pressure === 'negative' ? '<<-' : '===',
      displayValue: pressure === 'negative' ? 'NEGATIVE (-Pa)' : 'EQUALIZED (0 Pa)',
    },
    {
      varName: 'uvSterilizer',
      label: 'UV-C Decontamination',
      symbol: uvActive ? '***' : '---',
      displayValue: uvActive ? 'ACTIVE' : 'OFF',
    },
    {
      varName: 'occupied',
      label: 'Personnel Occupancy',
      symbol: occupied ? '[P]' : '[0]',
      displayValue: occupied ? 'OCCUPIED (true)' : 'EMPTY (false)',
    },
    {
      varName: 'purgeCycles',
      label: 'HEPA Purge Counter',
      symbol: `${purgeCycles}/2`,
      displayValue: `${purgeCycles} of 2 cycles`,
    },
    {
      varName: 'maintenanceOverride',
      label: 'Maintenance Override Key',
      symbol: overrideEngaged ? '[!]' : '[ ]',
      displayValue: overrideEngaged ? 'ENGAGED (true)' : 'OFF (false)',
    },
  ];

  const outerStroke = outerDoor === 'open' ? 'var(--color-accent)' : 'var(--color-ink)';
  const innerStroke = containmentBreach
    ? 'var(--color-error)'
    : innerDoor === 'open'
      ? 'var(--color-accent)'
      : 'var(--color-ink)';
  const chamberStroke = hasViolation
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
          <span
            className="is-badge"
            data-tone={hasViolation ? 'danger' : 'success'}
            role="status"
          >
            <span aria-hidden="true">{hasViolation ? '!' : '✓'}</span>{' '}
            {hasViolation ? `INVARIANT BREACH (${violatedInvariantIds.join(', ')})` : 'SEAL & UV SAFE'}
          </span>
          {goalReached !== undefined && (
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
          viewBox="0 0 720 220"
          role="img"
          aria-label={ariaSummary}
        >
          <title>BSL-3 Bio-Containment Airlock Discrete State Diagram</title>

          {/* Corridor / Exterior Zone */}
          <rect
            x="10"
            y="24"
            width="136"
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
          <rect x="146" y="24" width="38" height="38" fill="var(--color-paper-2)" stroke="var(--color-rule)" />
          <rect x="146" y="158" width="38" height="38" fill="var(--color-paper-2)" stroke="var(--color-rule)" />
          {outerDoor === 'closed' ? (
            <>
              <rect
                x="160"
                y="62"
                width="10"
                height="96"
                fill="var(--color-ink)"
                stroke="var(--color-paper)"
                strokeWidth="1"
              />
              <text
                x="165"
                y="18"
                textAnchor="middle"
                fill="var(--color-ink-2)"
                fontSize="11"
                fontFamily="var(--font-outlier)"
              >
                OUTER: CLOSED
              </text>
            </>
          ) : (
            <>
              <line
                x1="165"
                y1="64"
                x2="165"
                y2="156"
                stroke={outerStroke}
                strokeWidth="2"
                strokeDasharray="4 4"
              />
              <rect x="150" y="64" width="30" height="8" fill={outerStroke} />
              <rect x="150" y="148" width="30" height="8" fill={outerStroke} />
              <text
                x="165"
                y="18"
                textAnchor="middle"
                fill={outerStroke}
                fontSize="11"
                fontFamily="var(--font-outlier)"
              >
                OUTER: OPEN
              </text>
            </>
          )}

          {/* Central Airlock Chamber */}
          <rect
            x="184"
            y="24"
            width="352"
            height="172"
            fill={
              hasViolation
                ? 'oklch(14% 0.045 25)'
                : uvActive
                  ? 'oklch(15% 0.035 280)'
                  : pressure === 'negative'
                    ? 'oklch(11% 0.02 250)'
                    : 'oklch(12% 0.015 70)'
            }
            stroke={chamberStroke}
            strokeWidth="2"
          />
          <text
            x="198"
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
            x="198"
            y="56"
            width="156"
            height="28"
            fill="var(--color-paper-3)"
            stroke={pressure === 'negative' ? 'var(--color-accent-2)' : 'var(--color-warning)'}
          />
          <text
            x="208"
            y="74"
            fill={pressure === 'negative' ? 'var(--color-accent-2)' : 'var(--color-warning)'}
            fontSize="11.5"
            fontFamily="var(--font-outlier)"
          >
            {pressure === 'negative' ? '<< NEGATIVE (-Pa)' : '== EQUALIZED (0 Pa)'}
          </text>

          {/* UV-C Lamp Fixture */}
          <rect
            x="372"
            y="30"
            width="148"
            height="28"
            fill={uvActive ? 'var(--color-accent)' : 'var(--color-paper-2)'}
            stroke={uvHazard ? 'var(--color-error)' : 'var(--color-rule)'}
          />
          <text
            x="446"
            y="48"
            textAnchor="middle"
            fill={uvActive ? 'var(--color-accent-ink)' : 'var(--color-muted)'}
            fontSize="11"
            fontFamily="var(--font-outlier)"
          >
            {uvActive ? 'UV-C: ACTIVE ***' : 'UV-C: OFF'}
          </text>
          {uvActive && (
            <g stroke="var(--color-accent)" strokeWidth="1" strokeDasharray="3 3" opacity="0.85">
              <line x1="395" y1="58" x2="380" y2="122" />
              <line x1="446" y1="58" x2="446" y2="122" />
              <line x1="497" y1="58" x2="512" y2="122" />
            </g>
          )}

          {/* Personnel Occupancy Icon */}
          <rect
            x="198"
            y="102"
            width="110"
            height="76"
            fill="var(--color-paper-2)"
            stroke={occupied ? 'var(--color-ink)' : 'var(--color-rule)'}
          />
          <text
            x="253"
            y="120"
            textAnchor="middle"
            fill="var(--color-muted)"
            fontSize="10.5"
            fontFamily="var(--font-body)"
          >
            Occupancy
          </text>
          {occupied ? (
            <g>
              <rect x="247" y="128" width="12" height="12" fill="var(--color-ink)" />
              <rect x="242" y="142" width="22" height="18" fill="var(--color-accent-2)" />
              <text
                x="253"
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
              x="253"
              y="156"
              textAnchor="middle"
              fill="var(--color-muted)"
              fontSize="11.5"
              fontFamily="var(--font-outlier)"
            >
              EMPTY
            </text>
          )}

          {/* HEPA Purge Cycle Bar [0..2] */}
          <rect
            x="322"
            y="102"
            width="98"
            height="76"
            fill="var(--color-paper-2)"
            stroke="var(--color-rule)"
          />
          <text
            x="371"
            y="120"
            textAnchor="middle"
            fill="var(--color-muted)"
            fontSize="10.5"
            fontFamily="var(--font-body)"
          >
            HEPA Purge
          </text>
          <rect
            x="336"
            y="130"
            width="30"
            height="18"
            fill={purgeCycles >= 1 ? 'var(--color-success)' : 'var(--color-paper-3)'}
            stroke="var(--color-control-border)"
          />
          <rect
            x="376"
            y="130"
            width="30"
            height="18"
            fill={purgeCycles >= 2 ? 'var(--color-success)' : 'var(--color-paper-3)'}
            stroke="var(--color-control-border)"
          />
          <text
            x="371"
            y="168"
            textAnchor="middle"
            fill="var(--color-ink)"
            fontSize="11.5"
            fontFamily="var(--font-outlier)"
          >
            {purgeCycles} / 2 cycles
          </text>

          {/* Maintenance Override Key Switch */}
          <rect
            x="432"
            y="102"
            width="92"
            height="76"
            fill={overrideEngaged ? 'var(--color-accent-soft)' : 'var(--color-paper-2)'}
            stroke={overrideEngaged ? 'var(--color-accent)' : 'var(--color-rule)'}
          />
          <text
            x="478"
            y="120"
            textAnchor="middle"
            fill="var(--color-muted)"
            fontSize="10.5"
            fontFamily="var(--font-body)"
          >
            Override Key
          </text>
          <rect
            x="466"
            y="130"
            width="24"
            height="18"
            fill={overrideEngaged ? 'var(--color-accent)' : 'var(--color-paper-3)'}
            stroke={overrideEngaged ? 'var(--color-accent)' : 'var(--color-control-border)'}
          />
          <text
            x="478"
            y="168"
            textAnchor="middle"
            fill={overrideEngaged ? 'var(--color-accent)' : 'var(--color-ink-2)'}
            fontSize="11.5"
            fontFamily="var(--font-outlier)"
          >
            {overrideEngaged ? 'ENGAGED' : 'OFF'}
          </text>

          {/* Inner Door Bulkhead */}
          <rect x="536" y="24" width="38" height="38" fill="var(--color-paper-2)" stroke="var(--color-rule)" />
          <rect x="536" y="158" width="38" height="38" fill="var(--color-paper-2)" stroke="var(--color-rule)" />
          {innerDoor === 'closed' ? (
            <>
              <rect
                x="550"
                y="62"
                width="10"
                height="96"
                fill="var(--color-ink)"
                stroke="var(--color-paper)"
                strokeWidth="1"
              />
              <text
                x="555"
                y="18"
                textAnchor="middle"
                fill="var(--color-ink-2)"
                fontSize="11"
                fontFamily="var(--font-outlier)"
              >
                INNER: CLOSED
              </text>
            </>
          ) : (
            <>
              <line
                x1="555"
                y1="64"
                x2="555"
                y2="156"
                stroke={innerStroke}
                strokeWidth="2"
                strokeDasharray="4 4"
              />
              <rect x="540" y="64" width="30" height="8" fill={innerStroke} />
              <rect x="540" y="148" width="30" height="8" fill={innerStroke} />
              <text
                x="555"
                y="18"
                textAnchor="middle"
                fill={innerStroke}
                fontSize="11"
                fontFamily="var(--font-outlier)"
              >
                INNER: OPEN
              </text>
            </>
          )}

          {/* Inner BSL-3 Lab Zone */}
          <rect
            x="574"
            y="24"
            width="136"
            height="172"
            fill={containmentBreach ? 'oklch(16% 0.06 25)' : 'oklch(10% 0.025 250)'}
            stroke={containmentBreach ? 'var(--color-error)' : 'var(--color-accent-2)'}
            strokeWidth="1"
          />
          <text
            x="586"
            y="46"
            fill="var(--color-accent-2)"
            fontSize="11"
            fontFamily="var(--font-body)"
            fontWeight="500"
          >
            BSL-3 Containment Lab
          </text>
          <text
            x="586"
            y="66"
            fill="var(--color-ink-2)"
            fontSize="11.5"
            fontFamily="var(--font-outlier)"
          >
            Negative seal zone
          </text>
          {containmentBreach && (
            <g>
              <rect
                x="584"
                y="124"
                width="116"
                height="42"
                fill="var(--color-error-bg)"
                stroke="var(--color-error)"
              />
              <text
                x="642"
                y="142"
                textAnchor="middle"
                fill="var(--color-error)"
                fontSize="11"
                fontFamily="var(--font-outlier)"
              >
                ! BREACH
              </text>
              <text
                x="642"
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
