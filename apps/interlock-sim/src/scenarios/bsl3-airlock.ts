import type {
  BoolExpr,
  Goal,
  Invariant,
  ModelAssumption,
  StateSchema,
  StateSnapshot,
  StateValue,
  TransitionRule,
  TransitionSystemModel,
  ValueExpr,
  VerifyOptions,
} from '@rulecanvas/core';

const valLit = (value: StateValue): ValueExpr => ({ op: 'lit', value });
const valVar = (name: string): ValueExpr => ({ op: 'var', name });
const add = (left: ValueExpr, right: ValueExpr): ValueExpr => ({ op: 'add', left, right });

const boolLit = (value: boolean): BoolExpr => ({ op: 'lit', value });
const boolVar = (name: string): BoolExpr => ({ op: 'var', name });
const eq = (left: ValueExpr, right: ValueExpr): BoolExpr => ({ op: 'eq', left, right });
const neq = (left: ValueExpr, right: ValueExpr): BoolExpr => ({ op: 'neq', left, right });
const lt = (left: ValueExpr, right: ValueExpr): BoolExpr => ({ op: 'lt', left, right });
const gte = (left: ValueExpr, right: ValueExpr): BoolExpr => ({ op: 'gte', left, right });
const and = (...args: readonly BoolExpr[]): BoolExpr => ({ op: 'and', args });
const or = (...args: readonly BoolExpr[]): BoolExpr => ({ op: 'or', args });
const not = (arg: BoolExpr): BoolExpr => ({ op: 'not', arg });

export const bsl3AirlockSchema: StateSchema = {
  outerDoor: { kind: 'enum', values: ['closed', 'open'] },
  innerDoor: { kind: 'enum', values: ['closed', 'open'] },
  pressure: { kind: 'enum', values: ['negative', 'equalized'] },
  uvSterilizer: { kind: 'enum', values: ['off', 'active'] },
  occupied: { kind: 'boolean' },
  purgeCycles: { kind: 'int', min: 0, max: 2 },
  maintenanceOverride: { kind: 'boolean' },
};

export const bsl3AirlockInitialState: StateSnapshot = {
  outerDoor: 'closed',
  innerDoor: 'closed',
  pressure: 'negative',
  uvSterilizer: 'off',
  occupied: false,
  purgeCycles: 0,
  maintenanceOverride: false,
};

export const bsl3AirlockAssumptions: readonly ModelAssumption[] = [
  {
    id: 'assumption_educational_scope',
    category: 'scope',
    statement:
      'Educational discrete-state simulation only; not certified for IEC 61508 / SIL or physical safety-critical engineering.',
    notModeled:
      'Regulatory safety qualification, hardware safety integrity levels (SIL), redundant PLC voting, and physical interlock certification.',
  },
  {
    id: 'assumption_discrete_dynamics',
    category: 'physics',
    statement:
      'Door position, pressure differential, air purge cycles, and UV sterilizer states transition atomically between discrete values.',
    notModeled:
      'Continuous pressure decay curves, HVAC airflow turbulence, differential manometer lag, HEPA filter loading, and UV-C dose attenuation.',
  },
  {
    id: 'assumption_hardware_fidelity',
    category: 'hardware',
    statement:
      'Sensors report true airlock state and actuators execute guarded transitions without physical degradation.',
    notModeled:
      'Sensor faults, stuck door limit switches, mechanical seal failure, pneumatic gasket leaks, and electrical power loss.',
  },
];

export const bsl3AirlockInvariants: readonly Invariant[] = [
  {
    id: 'inv_containment_seal',
    label: 'Both doors are never simultaneously open, and the inner BSL-3 door only opens under negative pressure',
    holds: and(
      not(and(eq(valVar('outerDoor'), valLit('open')), eq(valVar('innerDoor'), valLit('open')))),
      not(and(eq(valVar('innerDoor'), valLit('open')), neq(valVar('pressure'), valLit('negative')))),
    ),
  },
  {
    id: 'inv_uv_exposure_lock',
    label: 'UV decontamination lamp is never active while occupied or while either airlock door is open',
    holds: not(
      and(
        eq(valVar('uvSterilizer'), valLit('active')),
        or(
          boolVar('occupied'),
          eq(valVar('outerDoor'), valLit('open')),
          eq(valVar('innerDoor'), valLit('open')),
        ),
      ),
    ),
  },
];

export const bsl3AirlockGoal: Goal = {
  id: 'goal_safe_lab_entry',
  label: 'Personnel enters the BSL-3 lab via the inner door under negative pressure after completing at least one purge cycle',
  reached: and(
    boolVar('occupied'),
    eq(valVar('innerDoor'), valLit('open')),
    eq(valVar('outerDoor'), valLit('closed')),
    eq(valVar('pressure'), valLit('negative')),
    eq(valVar('uvSterilizer'), valLit('off')),
    gte(valVar('purgeCycles'), valLit(1)),
  ),
};

const sharedRulesBeforeInnerOpen: readonly TransitionRule[] = [
  {
    id: 'equalize_pressure',
    label: 'Equalize airlock pressure to ambient corridor level',
    guard: and(
      eq(valVar('outerDoor'), valLit('closed')),
      eq(valVar('innerDoor'), valLit('closed')),
      eq(valVar('pressure'), valLit('negative')),
      eq(valVar('uvSterilizer'), valLit('off')),
    ),
    updates: [{ var: 'pressure', value: valLit('equalized') }],
  },
  {
    id: 'establish_negative_pressure',
    label: 'Restore negative containment pressure inside sealed airlock',
    guard: and(
      eq(valVar('outerDoor'), valLit('closed')),
      eq(valVar('innerDoor'), valLit('closed')),
      eq(valVar('pressure'), valLit('equalized')),
      eq(valVar('uvSterilizer'), valLit('off')),
    ),
    updates: [{ var: 'pressure', value: valLit('negative') }],
  },
  {
    id: 'open_outer_door',
    label: 'Open outer corridor door after pressure equalization',
    guard: and(
      eq(valVar('outerDoor'), valLit('closed')),
      eq(valVar('innerDoor'), valLit('closed')),
      eq(valVar('pressure'), valLit('equalized')),
      eq(valVar('uvSterilizer'), valLit('off')),
    ),
    updates: [{ var: 'outerDoor', value: valLit('open') }],
  },
  {
    id: 'close_outer_door',
    label: 'Close outer corridor door',
    guard: eq(valVar('outerDoor'), valLit('open')),
    updates: [{ var: 'outerDoor', value: valLit('closed') }],
  },
  {
    id: 'enter_airlock',
    label: 'Personnel enters airlock from outer corridor',
    guard: and(
      eq(valVar('outerDoor'), valLit('open')),
      not(boolVar('occupied')),
      eq(valVar('uvSterilizer'), valLit('off')),
    ),
    updates: [{ var: 'occupied', value: valLit(true) }],
  },
  {
    id: 'exit_to_corridor',
    label: 'Personnel exits airlock back to outer corridor',
    guard: and(
      eq(valVar('outerDoor'), valLit('open')),
      boolVar('occupied'),
      eq(valVar('uvSterilizer'), valLit('off')),
    ),
    updates: [
      { var: 'occupied', value: valLit(false) },
      { var: 'purgeCycles', value: valLit(0) },
      { var: 'maintenanceOverride', value: valLit(false) },
    ],
  },
  {
    id: 'run_air_purge',
    label: 'Run one negative-pressure HEPA air purge cycle',
    guard: and(
      eq(valVar('outerDoor'), valLit('closed')),
      eq(valVar('innerDoor'), valLit('closed')),
      eq(valVar('pressure'), valLit('negative')),
      eq(valVar('uvSterilizer'), valLit('off')),
      boolVar('occupied'),
      lt(valVar('purgeCycles'), valLit(2)),
    ),
    updates: [{ var: 'purgeCycles', value: add(valVar('purgeCycles'), valLit(1)) }],
  },
  {
    id: 'engage_maintenance_override',
    label: 'Engage internal maintenance override key switch',
    guard: and(
      boolVar('occupied'),
      eq(valVar('outerDoor'), valLit('closed')),
      eq(valVar('innerDoor'), valLit('closed')),
      eq(valVar('uvSterilizer'), valLit('off')),
      not(boolVar('maintenanceOverride')),
    ),
    updates: [{ var: 'maintenanceOverride', value: valLit(true) }],
  },
  {
    id: 'release_maintenance_override',
    label: 'Release maintenance override key switch',
    guard: boolVar('maintenanceOverride'),
    updates: [{ var: 'maintenanceOverride', value: valLit(false) }],
  },
];

const sharedRulesAfterInnerOpen: readonly TransitionRule[] = [
  {
    id: 'close_inner_door',
    label: 'Close inner BSL-3 containment door',
    guard: eq(valVar('innerDoor'), valLit('open')),
    updates: [{ var: 'innerDoor', value: valLit('closed') }],
  },
  {
    id: 'start_uv_sterilization',
    label: 'Activate UV decontamination lamp in empty sealed airlock',
    guard: and(
      eq(valVar('outerDoor'), valLit('closed')),
      eq(valVar('innerDoor'), valLit('closed')),
      not(boolVar('occupied')),
      eq(valVar('uvSterilizer'), valLit('off')),
    ),
    updates: [{ var: 'uvSterilizer', value: valLit('active') }],
  },
  {
    id: 'stop_uv_sterilization',
    label: 'Deactivate UV decontamination lamp',
    guard: eq(valVar('uvSterilizer'), valLit('active')),
    updates: [{ var: 'uvSterilizer', value: valLit('off') }],
  },
];

function buildModel(
  id: string,
  name: string,
  openInnerDoorRule: TransitionRule,
): TransitionSystemModel {
  return {
    id,
    name,
    schema: bsl3AirlockSchema,
    initialState: bsl3AirlockInitialState,
    rules: [...sharedRulesBeforeInnerOpen, openInnerDoorRule, ...sharedRulesAfterInnerOpen],
    invariants: bsl3AirlockInvariants,
    goal: bsl3AirlockGoal,
    assumptions: bsl3AirlockAssumptions,
  };
}

/**
 * Broken policy: maintenance override bypasses BOTH the purge requirement AND the
 * negative-pressure containment interlock on `open_inner_door`, permitting a 6-step
 * containment breach where the inner BSL-3 door opens under equalized pressure.
 */
export const bsl3AirlockBrokenModel: TransitionSystemModel = buildModel(
  'bsl3-airlock-broken',
  'BSL-3 Bio-Containment Airlock & UV Decontamination (Broken Override Interlock)',
  {
    id: 'open_inner_door',
    label: 'Open inner BSL-3 door (buggy maintenance override skips negative-pressure check)',
    guard: and(
      eq(valVar('innerDoor'), valLit('closed')),
      eq(valVar('outerDoor'), valLit('closed')),
      eq(valVar('uvSterilizer'), valLit('off')),
      boolVar('occupied'),
      or(
        and(eq(valVar('pressure'), valLit('negative')), gte(valVar('purgeCycles'), valLit(1))),
        boolVar('maintenanceOverride'),
      ),
    ),
    updates: [{ var: 'innerDoor', value: valLit('open') }],
  },
);

/**
 * Principled fix: negative pressure, closed outer door, and inactive UV lamp remain
 * unconditional mechanical interlocks; maintenance override may bypass only the purge count.
 */
export const bsl3AirlockFixedModel: TransitionSystemModel = buildModel(
  'bsl3-airlock-fixed',
  'BSL-3 Bio-Containment Airlock & UV Decontamination (Principled Interlock Fix)',
  {
    id: 'open_inner_door',
    label: 'Open inner BSL-3 door under negative pressure after purge or authorized override',
    guard: and(
      eq(valVar('innerDoor'), valLit('closed')),
      eq(valVar('outerDoor'), valLit('closed')),
      eq(valVar('pressure'), valLit('negative')),
      eq(valVar('uvSterilizer'), valLit('off')),
      boolVar('occupied'),
      or(gte(valVar('purgeCycles'), valLit(1)), boolVar('maintenanceOverride')),
    ),
    updates: [{ var: 'innerDoor', value: valLit('open') }],
  },
);

/**
 * Vacuous fix: permanently disables `open_inner_door` (`lit(false)`).
 * Safety invariants hold trivially, but the safe lab entry goal becomes unreachable.
 */
export const bsl3AirlockVacuousModel: TransitionSystemModel = buildModel(
  'bsl3-airlock-vacuous',
  'BSL-3 Bio-Containment Airlock & UV Decontamination (Vacuous Lockout Fix)',
  {
    id: 'open_inner_door',
    label: 'Open inner BSL-3 door (permanently locked out)',
    guard: boolLit(false),
    updates: [{ var: 'innerDoor', value: valLit('open') }],
  },
);

export const bsl3AirlockDefaultOptions: VerifyOptions = {
  maxStates: 10_000,
  maxDepth: 100,
};
