import type {
  BoolExpr,
  ModelAssumption,
  StateSnapshot,
  TransitionSystemModel,
  ValidationError,
  ValueExpr,
} from './types.js';

export type CompiledTuple = readonly number[];

type CompiledVar =
  | { readonly index: number; readonly name: string; readonly kind: 'boolean' }
  | {
      readonly index: number;
      readonly name: string;
      readonly kind: 'enum';
      readonly values: readonly string[];
      readonly valueToIndex: ReadonlyMap<string, number>;
    }
  | {
      readonly index: number;
      readonly name: string;
      readonly kind: 'int';
      readonly minBig: bigint;
      readonly maxBig: bigint;
    };

type CompiledIntExpr =
  | { readonly tag: 'lit'; readonly value: bigint }
  | { readonly tag: 'var'; readonly varIndex: number }
  | { readonly tag: 'add' | 'sub'; readonly left: CompiledIntExpr; readonly right: CompiledIntExpr };

type CompiledBoolValExpr =
  | { readonly tag: 'lit'; readonly value: boolean }
  | { readonly tag: 'var'; readonly varIndex: number };

type CompiledEnumExpr =
  | { readonly tag: 'lit'; readonly value: string }
  | { readonly tag: 'var'; readonly varIndex: number; readonly values: readonly string[] };

export type CompiledBoolExpr =
  | { readonly tag: 'lit'; readonly value: boolean }
  | { readonly tag: 'var'; readonly varIndex: number }
  | { readonly tag: 'cmp_bool'; readonly negate: boolean; readonly left: CompiledBoolValExpr; readonly right: CompiledBoolValExpr }
  | { readonly tag: 'cmp_enum'; readonly negate: boolean; readonly left: CompiledEnumExpr; readonly right: CompiledEnumExpr }
  | { readonly tag: 'eq_int' | 'neq_int' | 'lt' | 'lte' | 'gt' | 'gte'; readonly left: CompiledIntExpr; readonly right: CompiledIntExpr }
  | { readonly tag: 'in_bool'; readonly expr: CompiledBoolValExpr; readonly values: ReadonlySet<boolean> }
  | { readonly tag: 'in_enum'; readonly expr: CompiledEnumExpr; readonly values: ReadonlySet<string> }
  | { readonly tag: 'in_int'; readonly expr: CompiledIntExpr; readonly values: ReadonlySet<bigint> }
  | { readonly tag: 'and' | 'or'; readonly args: readonly CompiledBoolExpr[] }
  | { readonly tag: 'not'; readonly arg: CompiledBoolExpr };

type CompiledUpdate =
  | { readonly kind: 'boolean'; readonly varIndex: number; readonly varName: string; readonly expr: CompiledBoolValExpr }
  | {
      readonly kind: 'enum';
      readonly varIndex: number;
      readonly varName: string;
      readonly expr: CompiledEnumExpr;
      readonly valueToIndex: ReadonlyMap<string, number>;
    }
  | {
      readonly kind: 'int';
      readonly varIndex: number;
      readonly varName: string;
      readonly expr: CompiledIntExpr;
      readonly minBig: bigint;
      readonly maxBig: bigint;
    };

export interface CompiledRule {
  readonly id: string;
  readonly label: string;
  readonly guard: CompiledBoolExpr;
  readonly updates: readonly CompiledUpdate[];
}

export interface CompiledModel {
  readonly vars: readonly CompiledVar[];
  readonly initialTuple: CompiledTuple;
  readonly rules: readonly CompiledRule[];
  readonly ruleById: ReadonlyMap<string, CompiledRule>;
  readonly invariants: readonly { readonly id: string; readonly holds: CompiledBoolExpr }[];
  readonly goal: { readonly id: string; readonly reached: CompiledBoolExpr } | null;
  readonly assumptions: readonly ModelAssumption[];
  readonly theoreticalStates: string;
}

export type ApplyRuleResult =
  | { readonly ok: true; readonly nextTuple: CompiledTuple }
  | { readonly ok: false; readonly error: ValidationError };

function normalizeInt(n: number): number {
  return Object.is(n, -0) ? 0 : n;
}

function inferValueKind(expr: ValueExpr, varByName: ReadonlyMap<string, CompiledVar>): 'boolean' | 'enum' | 'int' {
  if (expr.op === 'lit') {
    if (typeof expr.value === 'boolean') return 'boolean';
    return typeof expr.value === 'string' ? 'enum' : 'int';
  }
  return expr.op === 'var' ? varByName.get(expr.name)!.kind : 'int';
}

function compileIntExpr(expr: ValueExpr, varByName: ReadonlyMap<string, CompiledVar>): CompiledIntExpr {
  if (expr.op === 'lit') return { tag: 'lit', value: BigInt(normalizeInt(expr.value as number)) };
  if (expr.op === 'var') return { tag: 'var', varIndex: varByName.get(expr.name)!.index };
  return { tag: expr.op, left: compileIntExpr(expr.left, varByName), right: compileIntExpr(expr.right, varByName) };
}

function compileBoolValExpr(expr: ValueExpr, varByName: ReadonlyMap<string, CompiledVar>): CompiledBoolValExpr {
  if (expr.op === 'lit') return { tag: 'lit', value: expr.value as boolean };
  return { tag: 'var', varIndex: varByName.get((expr as { readonly name: string }).name)!.index };
}

function compileEnumExpr(expr: ValueExpr, varByName: ReadonlyMap<string, CompiledVar>): CompiledEnumExpr {
  if (expr.op === 'lit') return { tag: 'lit', value: expr.value as string };
  const v = varByName.get((expr as { readonly name: string }).name)!;
  return { tag: 'var', varIndex: v.index, values: (v as Extract<CompiledVar, { readonly kind: 'enum' }>).values };
}

function compileBoolExpr(expr: BoolExpr, varByName: ReadonlyMap<string, CompiledVar>): CompiledBoolExpr {
  switch (expr.op) {
    case 'lit':
      return { tag: 'lit', value: expr.value };
    case 'var':
      return { tag: 'var', varIndex: varByName.get(expr.name)!.index };
    case 'eq':
    case 'neq': {
      const negate = expr.op === 'neq';
      const kind = inferValueKind(expr.left, varByName);
      if (kind === 'boolean') {
        return { tag: 'cmp_bool', negate, left: compileBoolValExpr(expr.left, varByName), right: compileBoolValExpr(expr.right, varByName) };
      }
      if (kind === 'enum') {
        return { tag: 'cmp_enum', negate, left: compileEnumExpr(expr.left, varByName), right: compileEnumExpr(expr.right, varByName) };
      }
      return { tag: negate ? 'neq_int' : 'eq_int', left: compileIntExpr(expr.left, varByName), right: compileIntExpr(expr.right, varByName) };
    }
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte':
      return { tag: expr.op, left: compileIntExpr(expr.left, varByName), right: compileIntExpr(expr.right, varByName) };
    case 'in': {
      const kind = inferValueKind(expr.expr, varByName);
      if (kind === 'boolean') {
        const values = new Set<boolean>();
        for (let i = 0; i < expr.values.length; i += 1) {
          values.add(expr.values[i] as boolean);
        }
        return { tag: 'in_bool', expr: compileBoolValExpr(expr.expr, varByName), values };
      }
      if (kind === 'enum') {
        const values = new Set<string>();
        for (let i = 0; i < expr.values.length; i += 1) {
          values.add(expr.values[i] as string);
        }
        return { tag: 'in_enum', expr: compileEnumExpr(expr.expr, varByName), values };
      }
      const values = new Set<bigint>();
      for (let i = 0; i < expr.values.length; i += 1) {
        values.add(BigInt(normalizeInt(expr.values[i] as number)));
      }
      return {
        tag: 'in_int',
        expr: compileIntExpr(expr.expr, varByName),
        values,
      };
    }
    case 'and':
    case 'or': {
      const compiledArgs: CompiledBoolExpr[] = new Array<CompiledBoolExpr>(expr.args.length);
      for (let i = 0; i < expr.args.length; i += 1) {
        compiledArgs[i] = compileBoolExpr(expr.args[i]!, varByName);
      }
      return { tag: expr.op, args: compiledArgs };
    }
    case 'not':
      return { tag: 'not', arg: compileBoolExpr(expr.arg, varByName) };
  }
}

export function encodeState(vars: readonly CompiledVar[], snapshot: StateSnapshot): CompiledTuple {
  const tuple = new Array<number>(vars.length);
  for (let i = 0; i < vars.length; i += 1) {
    const v = vars[i]!;
    const rawVal = snapshot[v.name];
    if (v.kind === 'boolean') tuple[i] = rawVal === true ? 1 : 0;
    else if (v.kind === 'enum') tuple[i] = v.valueToIndex.get(rawVal as string)!;
    else tuple[i] = normalizeInt(rawVal as number);
  }
  return tuple;
}

export function compileModel(model: TransitionSystemModel): CompiledModel {
  const varNames = Object.keys(model.schema);
  const vars: CompiledVar[] = [];
  const varByName = new Map<string, CompiledVar>();
  let theoreticalProduct = 1n;

  for (let i = 0; i < varNames.length; i += 1) {
    const name = varNames[i]!;
    const def = model.schema[name]!;
    let compiledVar: CompiledVar;
    if (def.kind === 'boolean') {
      compiledVar = { index: i, name, kind: 'boolean' };
      theoreticalProduct *= 2n;
    } else if (def.kind === 'enum') {
      const values = new Array<string>(def.values.length);
      const valueToIndex = new Map<string, number>();
      for (let j = 0; j < def.values.length; j += 1) {
        const val = def.values[j]!;
        values[j] = val;
        valueToIndex.set(val, j);
      }
      compiledVar = { index: i, name, kind: 'enum', values, valueToIndex };
      theoreticalProduct *= BigInt(values.length);
    } else {
      const minBig = BigInt(normalizeInt(def.min));
      const maxBig = BigInt(normalizeInt(def.max));
      compiledVar = { index: i, name, kind: 'int', minBig, maxBig };
      theoreticalProduct *= maxBig - minBig + 1n;
    }
    vars.push(compiledVar);
    varByName.set(name, compiledVar);
  }

  const rules: CompiledRule[] = [];
  const ruleById = new Map<string, CompiledRule>();
  for (let i = 0; i < model.rules.length; i += 1) {
    const rule = model.rules[i]!;
    const updates: CompiledUpdate[] = new Array<CompiledUpdate>(rule.updates.length);
    for (let j = 0; j < rule.updates.length; j += 1) {
      const upd = rule.updates[j]!;
      const target = varByName.get(upd.var)!;
      if (target.kind === 'boolean') {
        updates[j] = {
          kind: 'boolean',
          varIndex: target.index,
          varName: target.name,
          expr: compileBoolValExpr(upd.value, varByName),
        };
      } else if (target.kind === 'enum') {
        updates[j] = {
          kind: 'enum',
          varIndex: target.index,
          varName: target.name,
          expr: compileEnumExpr(upd.value, varByName),
          valueToIndex: target.valueToIndex,
        };
      } else {
        updates[j] = {
          kind: 'int',
          varIndex: target.index,
          varName: target.name,
          expr: compileIntExpr(upd.value, varByName),
          minBig: target.minBig,
          maxBig: target.maxBig,
        };
      }
    }
    const compiledRule: CompiledRule = {
      id: rule.id,
      label: rule.label,
      guard: compileBoolExpr(rule.guard, varByName),
      updates,
    };
    rules.push(compiledRule);
    ruleById.set(rule.id, compiledRule);
  }

  const invariants: { readonly id: string; readonly holds: CompiledBoolExpr }[] = new Array(model.invariants.length);
  for (let i = 0; i < model.invariants.length; i += 1) {
    const inv = model.invariants[i]!;
    invariants[i] = { id: inv.id, holds: compileBoolExpr(inv.holds, varByName) };
  }

  const assumptions: ModelAssumption[] = new Array<ModelAssumption>(model.assumptions.length);
  for (let i = 0; i < model.assumptions.length; i += 1) {
    const a = model.assumptions[i]!;
    assumptions[i] = {
      id: a.id,
      category: a.category,
      statement: a.statement,
      notModeled: a.notModeled,
    };
  }

  const ownGoal =
    Object.hasOwn(model, 'goal') && model.goal !== undefined
      ? { id: model.goal.id, reached: compileBoolExpr(model.goal.reached, varByName) }
      : null;

  return {
    vars,
    initialTuple: encodeState(vars, model.initialState),
    rules,
    ruleById,
    invariants,
    goal: ownGoal,
    assumptions,
    theoreticalStates: theoreticalProduct.toString(),
  };
}

function evaluateInt(expr: CompiledIntExpr, tuple: CompiledTuple): bigint {
  if (expr.tag === 'lit') return expr.value;
  if (expr.tag === 'var') return BigInt(tuple[expr.varIndex]!);
  return expr.tag === 'add'
    ? evaluateInt(expr.left, tuple) + evaluateInt(expr.right, tuple)
    : evaluateInt(expr.left, tuple) - evaluateInt(expr.right, tuple);
}

function evaluateBoolVal(expr: CompiledBoolValExpr, tuple: CompiledTuple): boolean {
  return expr.tag === 'lit' ? expr.value : tuple[expr.varIndex]! === 1;
}

function evaluateEnum(expr: CompiledEnumExpr, tuple: CompiledTuple): string {
  return expr.tag === 'lit' ? expr.value : expr.values[tuple[expr.varIndex]!]!;
}

export function evaluateBool(expr: CompiledBoolExpr, tuple: CompiledTuple): boolean {
  switch (expr.tag) {
    case 'lit':
      return expr.value;
    case 'var':
      return tuple[expr.varIndex]! === 1;
    case 'cmp_bool': {
      const eq = evaluateBoolVal(expr.left, tuple) === evaluateBoolVal(expr.right, tuple);
      return expr.negate ? !eq : eq;
    }
    case 'cmp_enum': {
      const eq = evaluateEnum(expr.left, tuple) === evaluateEnum(expr.right, tuple);
      return expr.negate ? !eq : eq;
    }
    case 'eq_int':
      return evaluateInt(expr.left, tuple) === evaluateInt(expr.right, tuple);
    case 'neq_int':
      return evaluateInt(expr.left, tuple) !== evaluateInt(expr.right, tuple);
    case 'lt':
      return evaluateInt(expr.left, tuple) < evaluateInt(expr.right, tuple);
    case 'lte':
      return evaluateInt(expr.left, tuple) <= evaluateInt(expr.right, tuple);
    case 'gt':
      return evaluateInt(expr.left, tuple) > evaluateInt(expr.right, tuple);
    case 'gte':
      return evaluateInt(expr.left, tuple) >= evaluateInt(expr.right, tuple);
    case 'in_bool':
      return expr.values.has(evaluateBoolVal(expr.expr, tuple));
    case 'in_enum':
      return expr.values.has(evaluateEnum(expr.expr, tuple));
    case 'in_int':
      return expr.values.has(evaluateInt(expr.expr, tuple));
    case 'and':
      for (let i = 0; i < expr.args.length; i += 1) if (!evaluateBool(expr.args[i]!, tuple)) return false;
      return true;
    case 'or':
      for (let i = 0; i < expr.args.length; i += 1) if (evaluateBool(expr.args[i]!, tuple)) return true;
      return false;
    case 'not':
      return !evaluateBool(expr.arg, tuple);
  }
}

export function applyRule(rule: CompiledRule, preTuple: CompiledTuple): ApplyRuleResult {
  const next = new Array<number>(preTuple.length);
  for (let i = 0; i < preTuple.length; i += 1) {
    next[i] = preTuple[i]!;
  }
  for (let i = 0; i < rule.updates.length; i += 1) {
    const upd = rule.updates[i]!;
    if (upd.kind === 'boolean') {
      next[upd.varIndex] = evaluateBoolVal(upd.expr, preTuple) ? 1 : 0;
    } else if (upd.kind === 'enum') {
      const strVal = evaluateEnum(upd.expr, preTuple);
      const encoded = upd.valueToIndex.get(strVal);
      if (encoded === undefined) {
        return {
          ok: false,
          error: Object.freeze({
            code: 'OUT_OF_DOMAIN_TRANSITION',
            path: `rules.${rule.id}.updates.${upd.varName}`,
            message: `Rule "${rule.id}" assigned out-of-domain enum "${strVal}" to "${upd.varName}".`,
          }),
        };
      }
      next[upd.varIndex] = encoded;
    } else {
      const bigVal = evaluateInt(upd.expr, preTuple);
      if (bigVal < upd.minBig || bigVal > upd.maxBig) {
        return {
          ok: false,
          error: Object.freeze({
            code: 'OUT_OF_DOMAIN_TRANSITION',
            path: `rules.${rule.id}.updates.${upd.varName}`,
            message: `Rule "${rule.id}" assigned out-of-domain integer ${bigVal.toString()} to "${upd.varName}" (allowed [${upd.minBig.toString()}, ${upd.maxBig.toString()}]).`,
          }),
        };
      }
      next[upd.varIndex] = normalizeInt(Number(bigVal));
    }
  }
  return { ok: true, nextTuple: next };
}

export function evaluateViolatedInvariants(compiled: CompiledModel, tuple: CompiledTuple): string[] {
  const violated: string[] = [];
  for (let i = 0; i < compiled.invariants.length; i += 1) {
    const inv = compiled.invariants[i]!;
    if (!evaluateBool(inv.holds, tuple)) violated.push(inv.id);
  }
  return violated;
}

export function tupleKey(tuple: CompiledTuple): string {
  return tuple.join(',');
}

export function toSnapshot(compiled: CompiledModel, tuple: CompiledTuple): StateSnapshot {
  const snapshot: StateSnapshot = {};
  for (let i = 0; i < compiled.vars.length; i += 1) {
    const v = compiled.vars[i]!;
    const raw = tuple[i]!;
    const value = v.kind === 'boolean' ? raw === 1 : v.kind === 'enum' ? v.values[raw]! : normalizeInt(raw);
    const desc = Object.create(null) as PropertyDescriptor;
    desc.value = value;
    desc.enumerable = true;
    desc.writable = true;
    desc.configurable = true;
    Object.defineProperty(snapshot, v.name, desc);
  }
  return snapshot;
}

export function computeChangedVars(compiled: CompiledModel, before: CompiledTuple, after: CompiledTuple): string[] {
  const changed: string[] = [];
  for (let i = 0; i < compiled.vars.length; i += 1) {
    if (after[i] !== before[i]) changed.push(compiled.vars[i]!.name);
  }
  return changed;
}
