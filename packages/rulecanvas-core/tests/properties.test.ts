import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  replayTrace,
  validateModel,
  validateOptions,
  verifyModel,
  type BoolExpr,
  type Goal,
  type Invariant,
  type ModelAssumption,
  type StateSchema,
  type StateSnapshot,
  type StateValue,
  type TransitionRule,
  type TransitionSystemModel,
  type UpdateAssignment,
  type ValueExpr,
  type VarDef,
  type VerifyOptions,
} from '@rulecanvas/core';

// ============================================================================
// Seed configuration (CI-deterministic by default; overridable via FC_SEED)
// ============================================================================
function resolveSeed(): number {
  const raw = process.env['FC_SEED'];
  if (raw !== undefined && raw.trim().length > 0) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return 424242;
}

const BASE_SEED = resolveSeed();

// ============================================================================
// 100% Independent Reference AST Evaluator & BFS Oracle
// (Imports ZERO internal helpers from src/eval.ts or src/verify.ts)
// ============================================================================
type OracleStats = {
  theoreticalStates: string;
  statesExplored: number;
  transitionsEvaluated: number;
  maxDepthReached: number;
  deadlockStatesFound: number;
};

type OracleResult =
  | { status: 'VERIFIED'; stats: OracleStats; goalReachable?: boolean }
  | {
      status: 'VIOLATED';
      traceLength: number;
      terminalState: StateSnapshot;
      violatedInvariantIds: string[];
      stats: OracleStats;
      goalReachable?: true;
    }
  | {
      status: 'INCONCLUSIVE';
      reason: 'MAX_STATES' | 'MAX_DEPTH';
      completedDepth: number;
      frontierRemaining: number;
      stats: OracleStats;
      goalReachable?: true;
    }
  | { status: 'INVALID'; code: 'OUT_OF_DOMAIN_TRANSITION'; stats: OracleStats };

function normNum(n: number): number {
  return Object.is(n, -0) ? 0 : n;
}

function oracleStateKey(sortedVarNames: readonly string[], state: StateSnapshot): string {
  const values: StateValue[] = [];
  for (const name of sortedVarNames) {
    const v = state[name]!;
    values.push(typeof v === 'number' ? normNum(v) : v);
  }
  return JSON.stringify(values);
}

function oracleCloneSnapshot(varNames: readonly string[], state: StateSnapshot): StateSnapshot {
  const copy: StateSnapshot = {};
  for (const name of varNames) {
    const raw = state[name]!;
    const val = typeof raw === 'number' ? normNum(raw) : raw;
    Object.defineProperty(copy, name, { value: val, enumerable: true, writable: true, configurable: true });
  }
  return copy;
}

function oracleEvalValue(expr: ValueExpr, state: StateSnapshot): boolean | string | bigint {
  switch (expr.op) {
    case 'lit':
      return typeof expr.value === 'number' ? BigInt(normNum(expr.value)) : expr.value;
    case 'var': {
      const v = state[expr.name]!;
      return typeof v === 'number' ? BigInt(normNum(v)) : v;
    }
    case 'add': {
      const l = oracleEvalValue(expr.left, state) as bigint;
      const r = oracleEvalValue(expr.right, state) as bigint;
      return l + r;
    }
    case 'sub': {
      const l = oracleEvalValue(expr.left, state) as bigint;
      const r = oracleEvalValue(expr.right, state) as bigint;
      return l - r;
    }
  }
}

function oracleEvalBool(expr: BoolExpr, state: StateSnapshot): boolean {
  switch (expr.op) {
    case 'lit':
      return expr.value;
    case 'var':
      return state[expr.name] === true;
    case 'eq':
      return oracleEvalValue(expr.left, state) === oracleEvalValue(expr.right, state);
    case 'neq':
      return oracleEvalValue(expr.left, state) !== oracleEvalValue(expr.right, state);
    case 'lt':
      return (oracleEvalValue(expr.left, state) as bigint) < (oracleEvalValue(expr.right, state) as bigint);
    case 'lte':
      return (oracleEvalValue(expr.left, state) as bigint) <= (oracleEvalValue(expr.right, state) as bigint);
    case 'gt':
      return (oracleEvalValue(expr.left, state) as bigint) > (oracleEvalValue(expr.right, state) as bigint);
    case 'gte':
      return (oracleEvalValue(expr.left, state) as bigint) >= (oracleEvalValue(expr.right, state) as bigint);
    case 'in': {
      const val = oracleEvalValue(expr.expr, state);
      for (const item of expr.values) {
        const normalized = typeof item === 'number' ? BigInt(normNum(item)) : item;
        if (val === normalized) return true;
      }
      return false;
    }
    case 'and':
      return expr.args.every((arg) => oracleEvalBool(arg, state));
    case 'or':
      return expr.args.some((arg) => oracleEvalBool(arg, state));
    case 'not':
      return !oracleEvalBool(expr.arg, state);
  }
}

function oracleApplyRule(
  schema: StateSchema,
  varNames: readonly string[],
  rule: TransitionRule,
  preState: StateSnapshot,
): { ok: true; nextState: StateSnapshot } | { ok: false } {
  const nextState = oracleCloneSnapshot(varNames, preState);
  for (const upd of rule.updates) {
    const def = schema[upd.var]!;
    const computed = oracleEvalValue(upd.value, preState);
    if (def.kind === 'boolean') {
      Object.defineProperty(nextState, upd.var, {
        value: computed as boolean,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    } else if (def.kind === 'enum') {
      const s = computed as string;
      if (!def.values.includes(s)) return { ok: false };
      Object.defineProperty(nextState, upd.var, { value: s, enumerable: true, writable: true, configurable: true });
    } else {
      const b = computed as bigint;
      if (b < BigInt(normNum(def.min)) || b > BigInt(normNum(def.max))) return { ok: false };
      Object.defineProperty(nextState, upd.var, {
        value: normNum(Number(b)),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  return { ok: true, nextState };
}

function oracleViolations(invariants: readonly Invariant[], state: StateSnapshot): string[] {
  const violated: string[] = [];
  for (const inv of invariants) {
    if (!oracleEvalBool(inv.holds, state)) violated.push(inv.id);
  }
  return violated;
}

function oracleVerify(model: TransitionSystemModel, options: VerifyOptions): OracleResult {
  const varNames = Object.keys(model.schema);
  const sortedVarNames = varNames.slice().sort();

  let theoretical = 1n;
  for (const name of varNames) {
    const def = model.schema[name]!;
    if (def.kind === 'boolean') theoretical *= 2n;
    else if (def.kind === 'enum') theoretical *= BigInt(def.values.length);
    else theoretical *= BigInt(normNum(def.max)) - BigInt(normNum(def.min)) + 1n;
  }
  const theoreticalStates = theoretical.toString();

  const s0 = oracleCloneSnapshot(varNames, model.initialState);
  const initViolations = oracleViolations(model.invariants, s0);
  if (initViolations.length > 0) {
    return {
      status: 'VIOLATED',
      traceLength: 0,
      terminalState: s0,
      violatedInvariantIds: initViolations,
      stats: {
        theoreticalStates,
        statesExplored: 1,
        transitionsEvaluated: 0,
        maxDepthReached: 0,
        deadlockStatesFound: 0,
      },
    };
  }

  let goalWitnessed = model.goal !== undefined && oracleEvalBool(model.goal.reached, s0);

  const queue: Array<{ state: StateSnapshot; depth: number }> = [{ state: s0, depth: 0 }];
  const visited = new Set<string>([oracleStateKey(sortedVarNames, s0)]);
  let head = 0;
  let transitionsEvaluated = 0;
  let maxDepthReached = 0;
  let deadlockStatesFound = 0;

  const stats = (): OracleStats => ({
    theoreticalStates,
    statesExplored: queue.length,
    transitionsEvaluated,
    maxDepthReached,
    deadlockStatesFound,
  });

  while (head < queue.length) {
    const current = queue[head]!;
    let enabled = 0;

    for (const rule of model.rules) {
      if (!oracleEvalBool(rule.guard, current.state)) continue;
      enabled += 1;
      transitionsEvaluated += 1;

      const applied = oracleApplyRule(model.schema, varNames, rule, current.state);
      if (!applied.ok) {
        return { status: 'INVALID', code: 'OUT_OF_DOMAIN_TRANSITION', stats: stats() };
      }

      const key = oracleStateKey(sortedVarNames, applied.nextState);
      if (visited.has(key)) continue;

      const nextDepth = current.depth + 1;
      const reason =
        nextDepth > options.maxDepth ? 'MAX_DEPTH' : queue.length >= options.maxStates ? 'MAX_STATES' : null;
      if (reason !== null) {
        return {
          status: 'INCONCLUSIVE',
          reason,
          completedDepth: current.depth - 1,
          frontierRemaining: queue.length - head,
          stats: stats(),
          ...(goalWitnessed ? { goalReachable: true as const } : {}),
        };
      }

      queue.push({ state: applied.nextState, depth: nextDepth });
      visited.add(key);
      if (nextDepth > maxDepthReached) maxDepthReached = nextDepth;

      const viols = oracleViolations(model.invariants, applied.nextState);
      if (viols.length > 0) {
        return {
          status: 'VIOLATED',
          traceLength: nextDepth,
          terminalState: applied.nextState,
          violatedInvariantIds: viols,
          stats: stats(),
          ...(goalWitnessed ? { goalReachable: true as const } : {}),
        };
      }

      if (model.goal !== undefined && !goalWitnessed && oracleEvalBool(model.goal.reached, applied.nextState)) {
        goalWitnessed = true;
      }
    }

    if (enabled === 0) deadlockStatesFound += 1;
    head += 1;
  }

  return {
    status: 'VERIFIED',
    stats: stats(),
    ...(model.goal !== undefined ? { goalReachable: goalWitnessed } : {}),
  };
}

// ============================================================================
// Arbitraries & Model Generators
// ============================================================================
const TEST_ASSUMPTIONS: readonly ModelAssumption[] = [
  {
    id: 'a-1',
    category: 'model',
    statement: 'Generated finite-state transition system.',
    notModeled: 'External physical or network effects.',
  },
];

const VAR_NAME_POOL = ['toString', 'hasOwnProperty', 'alpha', 'beta', 'gamma', 'delta', 'count', 'mode'] as const;

const TRICKY_ENUM_POOL = [
  'a,b',
  'x|y',
  'k:v',
  'plain',
  'a,b|c:d',
  's0',
  's1',
  's2',
] as const;

type VarEntry = { readonly name: string; readonly def: VarDef };

function varDomainSize(def: VarDef): number {
  if (def.kind === 'boolean') return 2;
  if (def.kind === 'enum') return def.values.length;
  return def.max - def.min + 1;
}

function schemaArb(maxTheoretical: number, minVars = 1, maxVars = 4): fc.Arbitrary<VarEntry[]> {
  const varDefArb: fc.Arbitrary<VarDef> = fc.oneof(
    fc.constant<VarDef>({ kind: 'boolean' }),
    fc
      .uniqueArray(fc.constantFrom(...TRICKY_ENUM_POOL), { minLength: 2, maxLength: 4 })
      .map((values): VarDef => ({ kind: 'enum', values })),
    fc
      .integer({ min: -3, max: 3 })
      .chain((min) =>
        fc.integer({ min: 0, max: 4 }).map((span): VarDef => ({ kind: 'int', min, max: min + span })),
      ),
  );

  return fc
    .uniqueArray(fc.constantFrom(...VAR_NAME_POOL), { minLength: minVars, maxLength: maxVars })
    .chain((names) =>
      fc.tuple(...names.map((name) => varDefArb.map((def): VarEntry => ({ name, def })))).map((entries) => {
        const kept: VarEntry[] = [];
        let prod = 1;
        for (const entry of entries) {
          const size = varDomainSize(entry.def);
          if (kept.length === 0 || prod * size <= maxTheoretical) {
            kept.push(entry);
            prod *= size;
          }
        }
        return kept;
      }),
    );
}

function stateForEntriesArb(entries: readonly VarEntry[]): fc.Arbitrary<StateSnapshot> {
  const fieldArbs = entries.map((entry) => {
    let valArb: fc.Arbitrary<StateValue>;
    if (entry.def.kind === 'boolean') valArb = fc.boolean();
    else if (entry.def.kind === 'enum') valArb = fc.constantFrom(...entry.def.values);
    else valArb = fc.integer({ min: entry.def.min, max: entry.def.max });
    return valArb.map((v): readonly [string, StateValue] => [entry.name, v]);
  });

  return fc.tuple(...fieldArbs).map((pairs) => {
    const snap: StateSnapshot = {};
    for (const [k, v] of pairs) {
      Object.defineProperty(snap, k, { value: v, enumerable: true, writable: true, configurable: true });
    }
    return snap;
  });
}

function intValueExprArb(intEntries: readonly VarEntry[], depth: number): fc.Arbitrary<ValueExpr> {
  const leaves: fc.Arbitrary<ValueExpr>[] = [
    fc.integer({ min: -3, max: 5 }).map((value): ValueExpr => ({ op: 'lit', value })),
  ];
  if (intEntries.length > 0) {
    leaves.push(fc.constantFrom(...intEntries).map((e): ValueExpr => ({ op: 'var', name: e.name })));
  }
  if (depth <= 0) return fc.oneof(...leaves);

  const subArb = intValueExprArb(intEntries, depth - 1);
  return fc.oneof(
    ...leaves,
    fc.record({
      op: fc.constantFrom<'add' | 'sub'>('add', 'sub'),
      left: subArb,
      right: subArb,
    }),
  );
}

function valueExprForVarArb(
  target: VarEntry,
  allEntries: readonly VarEntry[],
  strictlyInBounds: boolean,
): fc.Arbitrary<ValueExpr> {
  if (target.def.kind === 'boolean') {
    const boolVars = allEntries.filter((e) => e.def.kind === 'boolean');
    const choices: fc.Arbitrary<ValueExpr>[] = [fc.boolean().map((value): ValueExpr => ({ op: 'lit', value }))];
    if (boolVars.length > 0) {
      choices.push(fc.constantFrom(...boolVars).map((e): ValueExpr => ({ op: 'var', name: e.name })));
    }
    return fc.oneof(...choices);
  }

  if (target.def.kind === 'enum') {
    const compatibleEnumVars = allEntries.filter(
      (e) =>
        e.def.kind === 'enum' &&
        (!strictlyInBounds || e.def.values.every((v) => target.def.kind === 'enum' && target.def.values.includes(v))),
    );
    const choices: fc.Arbitrary<ValueExpr>[] = [
      fc.constantFrom(...target.def.values).map((value): ValueExpr => ({ op: 'lit', value })),
    ];
    if (compatibleEnumVars.length > 0) {
      choices.push(fc.constantFrom(...compatibleEnumVars).map((e): ValueExpr => ({ op: 'var', name: e.name })));
    }
    return fc.oneof(...choices);
  }

  // int
  if (strictlyInBounds) {
    return fc.integer({ min: target.def.min, max: target.def.max }).map((value): ValueExpr => ({ op: 'lit', value }));
  }

  const intVars = allEntries.filter((e) => e.def.kind === 'int');
  return fc.oneof(
    fc.integer({ min: target.def.min, max: target.def.max }).map((value): ValueExpr => ({ op: 'lit', value })),
    intValueExprArb(intVars, 1),
  );
}

function boolExprArb(entries: readonly VarEntry[], depth: number): fc.Arbitrary<BoolExpr> {
  const atoms: fc.Arbitrary<BoolExpr>[] = [fc.boolean().map((value): BoolExpr => ({ op: 'lit', value }))];

  const boolVars = entries.filter((e) => e.def.kind === 'boolean');
  const enumVars = entries.filter((e) => e.def.kind === 'enum');
  const intVars = entries.filter((e) => e.def.kind === 'int');

  if (boolVars.length > 0) {
    atoms.push(fc.constantFrom(...boolVars).map((e): BoolExpr => ({ op: 'var', name: e.name })));
    atoms.push(
      fc
        .tuple(fc.constantFrom<'eq' | 'neq'>('eq', 'neq'), fc.constantFrom(...boolVars), fc.boolean())
        .map(([op, e, v]): BoolExpr => ({ op, left: { op: 'var', name: e.name }, right: { op: 'lit', value: v } })),
    );
  }

  if (enumVars.length > 0) {
    atoms.push(
      fc.constantFrom(...enumVars).chain((e) => {
        const vals = (e.def as Extract<VarDef, { kind: 'enum' }>).values;
        return fc.oneof(
          fc
            .tuple(fc.constantFrom<'eq' | 'neq'>('eq', 'neq'), fc.constantFrom(...vals))
            .map(([op, v]): BoolExpr => ({ op, left: { op: 'var', name: e.name }, right: { op: 'lit', value: v } })),
          fc
            .subarray([...vals], { minLength: 0, maxLength: vals.length })
            .map((subset): BoolExpr => ({ op: 'in', expr: { op: 'var', name: e.name }, values: subset })),
        );
      }),
    );
  }

  if (intVars.length > 0) {
    atoms.push(
      fc.constantFrom(...intVars).chain((e) => {
        const def = e.def as Extract<VarDef, { kind: 'int' }>;
        return fc.oneof(
          fc
            .tuple(
              fc.constantFrom<'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte'>('eq', 'neq', 'lt', 'lte', 'gt', 'gte'),
              intValueExprArb(intVars, 1),
              fc.integer({ min: def.min - 1, max: def.max + 1 }),
            )
            .map(([op, left, rhs]): BoolExpr => ({ op, left, right: { op: 'lit', value: rhs } })),
          fc
            .array(fc.integer({ min: def.min, max: def.max }), { minLength: 0, maxLength: 3 })
            .map((values): BoolExpr => ({ op: 'in', expr: { op: 'var', name: e.name }, values })),
        );
      }),
    );
  }

  if (depth <= 0) return fc.oneof(...atoms);

  const sub = boolExprArb(entries, depth - 1);
  return fc.oneof(
    ...atoms,
    sub.map((arg): BoolExpr => ({ op: 'not', arg })),
    fc
      .tuple(fc.constantFrom<'and' | 'or'>('and', 'or'), fc.array(sub, { minLength: 1, maxLength: 3 }))
      .map(([op, args]): BoolExpr => ({ op, args })),
  );
}

function rulesArb(
  entries: readonly VarEntry[],
  writableEntries: readonly VarEntry[],
  minRules: number,
  maxRules: number,
  strictlyInBounds: boolean,
): fc.Arbitrary<TransitionRule[]> {
  const singleRuleArb = fc
    .tuple(
      boolExprArb(entries, 1),
      writableEntries.length === 0
        ? fc.constant<UpdateAssignment[]>([])
        : fc
            .subarray([...writableEntries], { minLength: 0, maxLength: Math.min(3, writableEntries.length) })
            .chain((targets) =>
              targets.length === 0
                ? fc.constant<UpdateAssignment[]>([])
                : fc.tuple(
                    ...targets.map((t) =>
                      valueExprForVarArb(t, entries, strictlyInBounds).map(
                        (value): UpdateAssignment => ({ var: t.name, value }),
                      ),
                    ),
                  ),
            ),
    )
    .map(([guard, updates]) => ({ guard, updates }));

  return fc.array(singleRuleArb, { minLength: minRules, maxLength: maxRules }).map((raw) =>
    raw.map(
      (r, idx): TransitionRule => ({
        id: `r-${idx}`,
        label: `Rule ${idx}`,
        guard: r.guard,
        updates: r.updates,
      }),
    ),
  );
}

function entriesToSchema(entries: readonly VarEntry[]): StateSchema {
  const schema: Record<string, VarDef> = {};
  for (const e of entries) {
    Object.defineProperty(schema, e.name, { value: e.def, enumerable: true, writable: true, configurable: true });
  }
  return schema;
}

function assertOracleAgreement(model: TransitionSystemModel, options: VerifyOptions): void {
  expect(validateModel(model)).toEqual([]);
  expect(validateOptions(options)).toEqual([]);

  const actual = verifyModel(model, options);
  const expected = oracleVerify(model, options);

  expect(actual.status).toBe(expected.status);
  if (actual.status === 'VERIFIED' && expected.status === 'VERIFIED') {
    expect(actual.stats).toEqual(expected.stats);
    expect('goalReachable' in actual).toBe('goalReachable' in expected);
    expect(actual.goalReachable).toBe(expected.goalReachable);
  } else if (actual.status === 'VIOLATED' && expected.status === 'VIOLATED') {
    expect(actual.stats).toEqual(expected.stats);
    expect(actual.trace.length).toBe(expected.traceLength);
    expect(actual.violatedInvariantIds).toEqual(expected.violatedInvariantIds);
    expect(actual.terminalState).toEqual(expected.terminalState);
    expect('goalReachable' in actual).toBe('goalReachable' in expected);
    expect(actual.goalReachable).toBe(expected.goalReachable);

    const replayed = replayTrace(
      model,
      actual.trace.map((s) => s.ruleId),
    );
    expect(replayed.ok).toBe(true);
    if (replayed.ok) {
      expect(replayed.finalState).toEqual(actual.terminalState);
      expect(replayed.violatedInvariantIds).toEqual(actual.violatedInvariantIds);
    }
  } else if (actual.status === 'INCONCLUSIVE' && expected.status === 'INCONCLUSIVE') {
    expect(actual.stats).toEqual(expected.stats);
    expect(actual.reason).toBe(expected.reason);
    expect(actual.completedDepth).toBe(expected.completedDepth);
    expect(actual.frontierRemaining).toBe(expected.frontierRemaining);
    expect('goalReachable' in actual).toBe('goalReachable' in expected);
    expect(actual.goalReachable).toBe(expected.goalReachable);
  } else if (actual.status === 'INVALID' && expected.status === 'INVALID') {
    expect(actual.errors[0]?.code).toBe(expected.code);
    expect(actual.stats).toEqual(expected.stats);
  }

  // Exact determinism check
  expect(verifyModel(model, options)).toEqual(actual);
}

// ============================================================================
// Stratum 1: generalValidModelArb (150 runs)
// ============================================================================
const generalValidModelArb: fc.Arbitrary<{ model: TransitionSystemModel; options: VerifyOptions }> = schemaArb(512).chain(
  (entries) =>
    fc
      .tuple(
        stateForEntriesArb(entries),
        rulesArb(entries, entries, 0, 6, false),
        fc.array(boolExprArb(entries, 1), { minLength: 1, maxLength: 3 }),
        fc.option(boolExprArb(entries, 1), { nil: undefined }),
        fc.record({
          maxStates: fc.oneof(fc.integer({ min: 1, max: 16 }), fc.constant(600)),
          maxDepth: fc.oneof(fc.integer({ min: 0, max: 6 }), fc.constant(40)),
        }),
      )
      .map(([initialState, rules, invExprs, goalExpr, options]) => {
        const goal: Goal | undefined =
          goalExpr !== undefined ? { id: 'g-0', label: 'Goal', reached: goalExpr } : undefined;
        const model: TransitionSystemModel = {
          id: 'gen-valid',
          name: 'Generated Valid Model',
          schema: entriesToSchema(entries),
          initialState,
          rules,
          invariants: invExprs.map((holds, i) => ({ id: `inv-${i}`, label: `Inv ${i}`, holds })),
          ...(goal !== undefined ? { goal } : {}),
          assumptions: TEST_ASSUMPTIONS,
        };
        return { model, options };
      }),
);

// ============================================================================
// Stratum 2: initialStateViolationArb (50 runs)
// ============================================================================
const initialStateViolationArb: fc.Arbitrary<{ model: TransitionSystemModel; options: VerifyOptions }> = schemaArb(
  128,
).chain((entries) =>
  fc
    .tuple(
      stateForEntriesArb(entries),
      rulesArb(entries, entries, 0, 4, true),
      fc.option(boolExprArb(entries, 1), { nil: undefined }),
      fc.record({
        maxStates: fc.integer({ min: 1, max: 50 }),
        maxDepth: fc.integer({ min: 0, max: 10 }),
      }),
    )
    .map(([initialState, rules, goalExpr, options]) => {
      const first = entries[0]!;
      const initVal = initialState[first.name]!;
      const falsifiedInv0: BoolExpr = {
        op: 'neq',
        left: { op: 'var', name: first.name },
        right: { op: 'lit', value: initVal },
      };
      const goal: Goal | undefined =
        goalExpr !== undefined ? { id: 'g-0', label: 'Goal', reached: goalExpr } : undefined;
      const model: TransitionSystemModel = {
        id: 'gen-s0-viol',
        name: 'Initial State Violation',
        schema: entriesToSchema(entries),
        initialState,
        rules,
        invariants: [
          { id: 'inv-s0-fail', label: 'False on s0', holds: falsifiedInv0 },
          { id: 'inv-true', label: 'Always true', holds: { op: 'lit', value: true } },
        ],
        ...(goal !== undefined ? { goal } : {}),
        assumptions: TEST_ASSUMPTIONS,
      };
      return { model, options };
    }),
);

// ============================================================================
// Stratum 3: plantedMultiStepViolationArb (100 runs)
// ============================================================================
const plantedMultiStepViolationArb: fc.Arbitrary<{ model: TransitionSystemModel; k: number }> = fc
  .integer({ min: 2, max: 5 })
  .chain((k) =>
    schemaArb(Math.floor(256 / (k + 1)), 1, 2).chain((bgEntries) => {
      const pcEntry: VarEntry = { name: 'pc', def: { kind: 'int', min: 0, max: k } };
      const allEntries: VarEntry[] = [pcEntry, ...bgEntries];

      return fc
        .tuple(stateForEntriesArb(bgEntries), rulesArb(allEntries, bgEntries, 0, 4, true))
        .map(([bgInit, bgRules]) => {
          const initialState: StateSnapshot = { pc: 0 };
          for (const e of bgEntries) {
            Object.defineProperty(initialState, e.name, {
              value: bgInit[e.name]!,
              enumerable: true,
              writable: true,
              configurable: true,
            });
          }

          const spineRules: TransitionRule[] = [];
          for (let step = 0; step < k; step += 1) {
            spineRules.push({
              id: `spine-${step}`,
              label: `Advance pc ${step} -> ${step + 1}`,
              guard: { op: 'eq', left: { op: 'var', name: 'pc' }, right: { op: 'lit', value: step } },
              updates: [{ var: 'pc', value: { op: 'lit', value: step + 1 } }],
            });
          }

          const model: TransitionSystemModel = {
            id: `planted-k-${k}`,
            name: `Planted Multi-Step Violation k=${k}`,
            schema: entriesToSchema(allEntries),
            initialState,
            rules: [...bgRules, ...spineRules],
            invariants: [
              {
                id: 'inv-pc',
                label: 'pc must never reach k',
                holds: { op: 'neq', left: { op: 'var', name: 'pc' }, right: { op: 'lit', value: k } },
              },
            ],
            assumptions: TEST_ASSUMPTIONS,
          };
          return { model, k };
        });
    }),
  );

// ============================================================================
// Stratum 4: reachableOutOfDomainArb (75 runs)
// ============================================================================
const reachableOutOfDomainArb: fc.Arbitrary<TransitionSystemModel> = fc
  .tuple(fc.integer({ min: 1, max: 3 }), fc.integer({ min: 0, max: 4 }))
  .chain(([oodDepth, minVal]) => {
    const maxVal = minVal + oodDepth;
    const xEntry: VarEntry = { name: 'x', def: { kind: 'int', min: minVal, max: maxVal } };
    const xSpan = maxVal - minVal + 1;
    const maxBgStates = Math.max(2, Math.floor(128 / xSpan));

    return schemaArb(maxBgStates, 1, 2).chain((bgEntries) => {
      const allEntries: VarEntry[] = [xEntry, ...bgEntries];
      return fc
        .tuple(stateForEntriesArb(bgEntries), rulesArb(allEntries, bgEntries, 0, 3, true))
        .map(([bgInit, bgRules]) => {
          const initialState: StateSnapshot = { x: maxVal - (oodDepth - 1) };
          for (const e of bgEntries) {
            Object.defineProperty(initialState, e.name, {
              value: bgInit[e.name]!,
              enumerable: true,
              writable: true,
              configurable: true,
            });
          }

          const oodRule: TransitionRule = {
            id: 'inc-x-unchecked',
            label: 'Unchecked increment x := x + 1',
            guard: { op: 'lit', value: true },
            updates: [{ var: 'x', value: { op: 'add', left: { op: 'var', name: 'x' }, right: { op: 'lit', value: 1 } } }],
          };

          return {
            id: `ood-depth-${oodDepth}`,
            name: 'Reachable OOD Model',
            schema: entriesToSchema(allEntries),
            initialState,
            rules: [...bgRules, oodRule],
            invariants: [{ id: 'inv-true', label: 'Always true', holds: { op: 'lit', value: true } }],
            assumptions: TEST_ASSUMPTIONS,
          };
        });
    });
  });

// ============================================================================
// Stratum 5: tightTruncationArb (100 runs)
// ============================================================================
const tightTruncationArb: fc.Arbitrary<{
  model: TransitionSystemModel;
  stateFrac: number;
  depthFrac: number;
}> = fc.integer({ min: 3, max: 8 }).chain((k) => {
  const pcEntry: VarEntry = { name: 'pc', def: { kind: 'int', min: 0, max: k } };
  const maxBg = Math.max(2, Math.floor(256 / (k + 1)));

  return schemaArb(maxBg, 1, 2).chain((bgEntries) => {
    const allEntries: VarEntry[] = [pcEntry, ...bgEntries];
    return fc
      .tuple(
        stateForEntriesArb(bgEntries),
        rulesArb(allEntries, bgEntries, 0, 3, true),
        fc.integer({ min: 0, max: 1000 }),
        fc.integer({ min: 0, max: 1000 }),
      )
      .map(([bgInit, bgRules, stateFrac, depthFrac]) => {
        const initialState: StateSnapshot = { pc: 0 };
        for (const e of bgEntries) {
          Object.defineProperty(initialState, e.name, {
            value: bgInit[e.name]!,
            enumerable: true,
            writable: true,
            configurable: true,
          });
        }

        const spineRules: TransitionRule[] = [];
        for (let step = 0; step < k; step += 1) {
          spineRules.push({
            id: `spine-${step}`,
            label: `Advance pc ${step} -> ${step + 1}`,
            guard: { op: 'eq', left: { op: 'var', name: 'pc' }, right: { op: 'lit', value: step } },
            updates: [{ var: 'pc', value: { op: 'lit', value: step + 1 } }],
          });
        }

        const model: TransitionSystemModel = {
          id: `trunc-k-${k}`,
          name: `Truncation Spine k=${k}`,
          schema: entriesToSchema(allEntries),
          initialState,
          rules: [...spineRules, ...bgRules],
          invariants: [{ id: 'inv-true', label: 'Always true', holds: { op: 'lit', value: true } }],
          assumptions: TEST_ASSUMPTIONS,
        };
        return { model, stateFrac, depthFrac };
      });
  });
});

// ============================================================================
// Stratum 6: malformedModelArb (75 runs)
// ============================================================================
type MalformedCase = { readonly model: unknown; readonly options: unknown; readonly label: string };

const malformedModelArb: fc.Arbitrary<MalformedCase> = fc.integer({ min: 0, max: 20 }).map((kind): MalformedCase => {
  const validBase: TransitionSystemModel = {
    id: 'valid-base',
    name: 'Valid Base',
    schema: {
      flag: { kind: 'boolean' },
      mode: { kind: 'enum', values: ['a', 'b'] },
      count: { kind: 'int', min: 0, max: 5 },
    },
    initialState: { flag: false, mode: 'a', count: 0 },
    rules: [
      {
        id: 'r0',
        label: 'Rule 0',
        guard: { op: 'lit', value: true },
        updates: [{ var: 'flag', value: { op: 'lit', value: true } }],
      },
    ],
    invariants: [{ id: 'i0', label: 'Inv 0', holds: { op: 'lit', value: true } }],
    assumptions: TEST_ASSUMPTIONS,
  };
  const validOpts: VerifyOptions = { maxStates: 100, maxDepth: 20 };

  switch (kind) {
    case 0: {
      const schema: Record<string, unknown> = { ...validBase.schema };
      Object.defineProperty(schema, '__proto__', {
        value: { kind: 'boolean' },
        enumerable: true,
        writable: true,
        configurable: true,
      });
      return { model: { ...validBase, schema }, options: validOpts, label: 'reserved __proto__' };
    }
    case 1:
      return {
        model: { ...validBase, schema: { ...validBase.schema, constructor: { kind: 'boolean' } } },
        options: validOpts,
        label: 'reserved constructor',
      };
    case 2:
      return {
        model: { ...validBase, schema: { ...validBase.schema, prototype: { kind: 'boolean' } } },
        options: validOpts,
        label: 'reserved prototype',
      };
    case 3:
      return {
        model: { ...validBase, schema: { ...validBase.schema, count: { kind: 'int', min: 5, max: 2 } } },
        options: validOpts,
        label: 'min > max',
      };
    case 4:
      return {
        model: { ...validBase, schema: { ...validBase.schema, count: { kind: 'int', min: 0, max: 1_000_001 } } },
        options: validOpts,
        label: 'int span > 1_000_000',
      };
    case 5:
      return {
        model: { ...validBase, schema: { ...validBase.schema, mode: { kind: 'enum', values: ['a', 'a'] } } },
        options: validOpts,
        label: 'duplicate enum value',
      };
    case 6:
      return {
        model: {
          ...validBase,
          rules: [
            {
              id: 'r0',
              label: 'Bad enum lit',
              guard: { op: 'eq', left: { op: 'var', name: 'mode' }, right: { op: 'lit', value: 'z' } },
              updates: [],
            },
          ],
        },
        options: validOpts,
        label: 'invalid enum literal',
      };
    case 7:
      return {
        model: {
          ...validBase,
          rules: [
            {
              id: 'r0',
              label: 'Dup update var',
              guard: { op: 'lit', value: true },
              updates: [
                { var: 'flag', value: { op: 'lit', value: true } },
                { var: 'flag', value: { op: 'lit', value: false } },
              ],
            },
          ],
        },
        options: validOpts,
        label: 'duplicate update var',
      };
    case 8: {
      let expr: BoolExpr = { op: 'lit', value: true };
      for (let i = 0; i < 10; i += 1) expr = { op: 'and', args: [expr, expr] };
      return {
        model: { ...validBase, invariants: [{ id: 'i0', label: 'Wide DAG', holds: expr }] },
        options: validOpts,
        label: 'AST > 256 visits',
      };
    }
    case 9: {
      let expr: BoolExpr = { op: 'lit', value: true };
      for (let i = 0; i < 35; i += 1) expr = { op: 'not', arg: expr };
      return {
        model: { ...validBase, invariants: [{ id: 'i0', label: 'Deep AST', holds: expr }] },
        options: validOpts,
        label: 'AST depth > 32',
      };
    }
    case 10:
      return { model: validBase, options: { maxStates: Number.NaN, maxDepth: 10 }, label: 'NaN maxStates' };
    case 11:
      return { model: validBase, options: { maxStates: 10, maxDepth: -1 }, label: 'negative maxDepth' };
    case 12:
      return { model: { ...validBase, invariants: [] }, options: validOpts, label: 'empty invariants' };
    case 13:
      return {
        model: { ...validBase, initialState: { flag: false, mode: 'a', count: 99 } },
        options: validOpts,
        label: 'initialState int out of bounds',
      };
    case 14:
      return {
        model: {
          ...validBase,
          invariants: [{ id: 'i0', label: 'Uncoercible op', holds: { op: { toString: null } } }],
        },
        options: validOpts,
        label: 'uncoercible holds.op',
      };
    case 15:
      return {
        model: {
          ...validBase,
          invariants: [{ id: 'i0', label: 'Uncoercible var', holds: { op: 'var', name: { toString: null } } }],
        },
        options: validOpts,
        label: 'uncoercible holds.name',
      };
    case 16:
      return {
        model: {
          ...validBase,
          rules: [
            {
              id: 'r0',
              label: 'Uncoercible update var and value op',
              guard: { op: 'lit', value: true },
              updates: [
                { var: { toString: null }, value: { op: { toString: null } } },
              ],
            },
          ],
        },
        options: validOpts,
        label: 'uncoercible update var and value op',
      };
    case 17:
      return {
        model: validBase,
        options: {
          get maxStates(): number {
            throw new Error('getter invoked');
          },
          maxDepth: 0,
        },
        label: 'accessor-getter options',
      };
    case 18: {
      const tamperedRules = [...validBase.rules];
      Object.defineProperty(tamperedRules, Symbol.iterator, {
        configurable: true,
        get() {
          return () => [][Symbol.iterator]();
        },
      });
      return {
        model: { ...validBase, rules: tamperedRules },
        options: validOpts,
        label: 'own Symbol.iterator on rules',
      };
    }
    case 19: {
      const sparseRules: unknown[] = [];
      sparseRules.length = 1;
      return {
        model: { ...validBase, rules: sparseRules },
        options: validOpts,
        label: 'sparse rules array',
      };
    }
    default:
      return {
        model: {
          id: 'valid-base',
          name: 'Getter Model',
          get schema(): unknown {
            throw new Error('schema getter invoked');
          },
          initialState: validBase.initialState,
          rules: validBase.rules,
          invariants: validBase.invariants,
          assumptions: TEST_ASSUMPTIONS,
        },
        options: validOpts,
        label: 'accessor-getter model',
      };
  }
});

// ============================================================================
// Stratified Property-Based Test Suite (6 separate fc.assert strata)
// ============================================================================
describe('property-based differential verification against independent reference oracle', () => {
  it('Stratum 1: generalValidModelArb agrees exactly with independent oracle and is deterministic (150 runs)', () => {
    fc.assert(
      fc.property(generalValidModelArb, ({ model, options }) => {
        assertOracleAgreement(model, options);
      }),
      { numRuns: 150, seed: BASE_SEED },
    );
  });

  it('Stratum 2: initialStateViolationArb always yields VIOLATED with trace.length === 0 (50 runs)', () => {
    fc.assert(
      fc.property(initialStateViolationArb, ({ model, options }) => {
        const res = verifyModel(model, options);
        expect(res.status).toBe('VIOLATED');
        if (res.status === 'VIOLATED') {
          expect(res.trace.length).toBe(0);
          expect(res.violatedInvariantIds).toContain('inv-s0-fail');
          expect(res.stats.statesExplored).toBe(1);
          expect(res.stats.transitionsEvaluated).toBe(0);
          expect('goalReachable' in res).toBe(false);
        }
        assertOracleAgreement(model, options);
      }),
      { numRuns: 50, seed: BASE_SEED + 1 },
    );
  });

  it('Stratum 3: plantedMultiStepViolationArb finds exact shortest trace of length k and replay confirms it (100 runs)', () => {
    fc.assert(
      fc.property(plantedMultiStepViolationArb, ({ model, k }) => {
        const options: VerifyOptions = { maxStates: 2000, maxDepth: 20 };
        const res = verifyModel(model, options);
        expect(res.status).toBe('VIOLATED');
        if (res.status === 'VIOLATED') {
          expect(res.trace.length).toBe(k);
          expect(res.violatedInvariantIds).toEqual(['inv-pc']);

          const replayed = replayTrace(
            model,
            res.trace.map((s) => s.ruleId),
          );
          expect(replayed.ok).toBe(true);
          if (replayed.ok) {
            expect(replayed.steps).toEqual(res.trace);
            expect(replayed.finalState).toEqual(res.terminalState);
            expect(replayed.violatedInvariantIds).toEqual(['inv-pc']);
          }
        }
        assertOracleAgreement(model, options);
      }),
      { numRuns: 100, seed: BASE_SEED + 2 },
    );
  });

  it('Stratum 4: reachableOutOfDomainArb always yields INVALID with OUT_OF_DOMAIN_TRANSITION (75 runs)', () => {
    fc.assert(
      fc.property(reachableOutOfDomainArb, (model) => {
        const options: VerifyOptions = { maxStates: 500, maxDepth: 20 };
        const res = verifyModel(model, options);
        expect(res.status).toBe('INVALID');
        if (res.status === 'INVALID') {
          expect(res.errors[0]?.code).toBe('OUT_OF_DOMAIN_TRANSITION');
        }
        assertOracleAgreement(model, options);
      }),
      { numRuns: 75, seed: BASE_SEED + 3 },
    );
  });

  it('Stratum 5: tightTruncationArb hits MAX_STATES and MAX_DEPTH with exact completedDepth and frontierRemaining (100 runs)', () => {
    fc.assert(
      fc.property(tightTruncationArb, ({ model, stateFrac, depthFrac }) => {
        const fullOpts: VerifyOptions = { maxStates: 5000, maxDepth: 100 };
        const fullOracle = oracleVerify(model, fullOpts);
        expect(fullOracle.status).toBe('VERIFIED');
        expect(fullOracle.stats.statesExplored).toBeGreaterThanOrEqual(4);
        expect(fullOracle.stats.maxDepthReached).toBeGreaterThanOrEqual(3);

        const maxStates = 1 + (stateFrac % (fullOracle.stats.statesExplored - 1));
        const maxDepth = depthFrac % fullOracle.stats.maxDepthReached;

        const statesRes = verifyModel(model, { maxStates, maxDepth: 100 });
        expect(statesRes.status).toBe('INCONCLUSIVE');
        if (statesRes.status === 'INCONCLUSIVE') {
          expect(statesRes.reason).toBe('MAX_STATES');
        }
        assertOracleAgreement(model, { maxStates, maxDepth: 100 });

        const depthRes = verifyModel(model, { maxStates: 5000, maxDepth });
        expect(depthRes.status).toBe('INCONCLUSIVE');
        if (depthRes.status === 'INCONCLUSIVE') {
          expect(depthRes.reason).toBe('MAX_DEPTH');
        }
        assertOracleAgreement(model, { maxStates: 5000, maxDepth });
      }),
      { numRuns: 100, seed: BASE_SEED + 4 },
    );
  });

  it('Stratum 6: malformedModelArb always yields static INVALID with no OUT_OF_DOMAIN_TRANSITION (75 runs)', () => {
    fc.assert(
      fc.property(malformedModelArb, ({ model, options }) => {
        const res = verifyModel(model, options);
        expect(res.status).toBe('INVALID');
        if (res.status === 'INVALID') {
          expect(res.errors.length).toBeGreaterThan(0);
          expect(res.errors.every((e) => e.code !== 'OUT_OF_DOMAIN_TRANSITION')).toBe(true);
        }
      }),
      { numRuns: 75, seed: BASE_SEED + 5 },
    );
  });
});
