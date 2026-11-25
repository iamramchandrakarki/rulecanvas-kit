import {
  validateModel,
  type BoolExpr,
  type ModelAssumption,
  type StateSchema,
  type StateValue,
  type TransitionRule,
  type TransitionSystemModel,
  type ValidationError,
  type ValueExpr,
  type VarDef,
} from '@rulecanvas/core';
import {
  bsl3AirlockFixedModel,
  bsl3AirlockVacuousModel,
} from './scenarios/bsl3-airlock.js';

export type DiagnosticSection =
  | 'general'
  | 'schema'
  | 'rules'
  | 'invariants'
  | 'goal'
  | 'assumptions';

export interface ModelDiagnosticsIndex {
  readonly all: readonly ValidationError[];
  readonly byPath: Readonly<Record<string, readonly ValidationError[]>>;
  readonly sections: Readonly<Record<DiagnosticSection, readonly ValidationError[]>>;
}

export type JsonImportResult =
  | { readonly ok: true; readonly model: TransitionSystemModel }
  | { readonly ok: false; readonly errors: readonly ValidationError[] };

export type JsonExportResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly error: ValidationError };

export type StrictIntegerParseResult =
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false; readonly message: string };

const MAX_IMPORT_JSON_CHARS = 512_000;
const MAX_IMPORT_DEPTH = 64;
const MAX_IMPORT_NODES = 10_000;

const MIN_SAFE_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const RFC8259_JSON_NUMBER_RE = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/;

const RESERVED_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
const ROOT_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  'id',
  'name',
  'schema',
  'initialState',
  'rules',
  'invariants',
  'assumptions',
  'goal',
]);
const VAR_DEF_BOOL_KEYS: ReadonlySet<string> = new Set(['kind']);
const VAR_DEF_ENUM_KEYS: ReadonlySet<string> = new Set(['kind', 'values']);
const VAR_DEF_INT_KEYS: ReadonlySet<string> = new Set(['kind', 'min', 'max']);
const RULE_ALLOWED_KEYS: ReadonlySet<string> = new Set(['id', 'label', 'guard', 'updates']);
const UPDATE_ALLOWED_KEYS: ReadonlySet<string> = new Set(['var', 'value']);
const INVARIANT_ALLOWED_KEYS: ReadonlySet<string> = new Set(['id', 'label', 'holds']);
const GOAL_ALLOWED_KEYS: ReadonlySet<string> = new Set(['id', 'label', 'reached']);
const ASSUMPTION_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  'id',
  'category',
  'statement',
  'notModeled',
]);

const VALUE_EXPR_KEYS_BY_OP: Readonly<Record<string, ReadonlySet<string>>> = {
  lit: new Set(['op', 'value']),
  var: new Set(['op', 'name']),
  add: new Set(['op', 'left', 'right']),
  sub: new Set(['op', 'left', 'right']),
};

const BOOL_EXPR_KEYS_BY_OP: Readonly<Record<string, ReadonlySet<string>>> = {
  lit: new Set(['op', 'value']),
  var: new Set(['op', 'name']),
  not: new Set(['op', 'arg']),
  and: new Set(['op', 'args']),
  or: new Set(['op', 'args']),
  eq: new Set(['op', 'left', 'right']),
  neq: new Set(['op', 'left', 'right']),
  lt: new Set(['op', 'left', 'right']),
  lte: new Set(['op', 'left', 'right']),
  gt: new Set(['op', 'left', 'right']),
  gte: new Set(['op', 'left', 'right']),
  in: new Set(['op', 'expr', 'values']),
};

export function parseStrictIntegerDraft(raw: string): StrictIntegerParseResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, message: 'Integer value is required.' };
  }
  if (!/^-?\d+$/.test(trimmed)) {
    return {
      ok: false,
      message: `Invalid integer "${raw}": enter a whole base-10 integer without decimals or extra characters.`,
    };
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) {
    return {
      ok: false,
      message: `Integer "${trimmed}" exceeds safe integer bounds.`,
    };
  }
  return { ok: true, value: Object.is(parsed, -0) ? 0 : parsed };
}

export function defaultValueForVarDef(def: VarDef): StateValue {
  switch (def.kind) {
    case 'boolean':
      return false;
    case 'enum':
      return def.values[0] ?? '';
    case 'int':
      return def.min;
  }
}

export function firstVariableOfKind(
  schema: StateSchema,
  preferredKind?: VarDef['kind'],
): string {
  const keys = Object.keys(schema);
  if (preferredKind !== undefined) {
    const match = keys.find((key) => schema[key]?.kind === preferredKind);
    if (match !== undefined) return match;
  }
  return keys[0] ?? 'flag';
}

export function createDefaultValueExpr(op: ValueExpr['op'], schema: StateSchema): ValueExpr {
  switch (op) {
    case 'lit':
      return { op: 'lit', value: 0 };
    case 'var':
      return { op: 'var', name: firstVariableOfKind(schema) };
    case 'add':
    case 'sub': {
      const intVar = firstVariableOfKind(schema, 'int');
      return {
        op,
        left: { op: 'var', name: intVar },
        right: { op: 'lit', value: 1 },
      };
    }
  }
}

export function createDefaultBoolExpr(op: BoolExpr['op'], schema: StateSchema): BoolExpr {
  switch (op) {
    case 'lit':
      return { op: 'lit', value: true };
    case 'var':
      return { op: 'var', name: firstVariableOfKind(schema, 'boolean') };
    case 'not':
      return {
        op: 'not',
        arg: { op: 'var', name: firstVariableOfKind(schema, 'boolean') },
      };
    case 'and':
    case 'or':
      return {
        op,
        args: [{ op: 'var', name: firstVariableOfKind(schema, 'boolean') }],
      };
    case 'eq':
    case 'neq': {
      const varName = firstVariableOfKind(schema);
      const def = schema[varName];
      const literal = def !== undefined ? defaultValueForVarDef(def) : false;
      return {
        op,
        left: { op: 'var', name: varName },
        right: { op: 'lit', value: literal },
      };
    }
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte': {
      const intVar = firstVariableOfKind(schema, 'int');
      const def = schema[intVar];
      const literal = def?.kind === 'int' ? def.max : 1;
      return {
        op,
        left: { op: 'var', name: intVar },
        right: { op: 'lit', value: literal },
      };
    }
    case 'in': {
      const enumVar = firstVariableOfKind(schema, 'enum');
      const def = schema[enumVar];
      const vals: readonly StateValue[] =
        def?.kind === 'enum'
          ? def.values.slice(0, 1)
          : def !== undefined
            ? [defaultValueForVarDef(def)]
            : [];
      return {
        op: 'in',
        expr: { op: 'var', name: enumVar },
        values: vals,
      };
    }
  }
}

export function appendGuardClause(guard: BoolExpr, clause: BoolExpr): BoolExpr {
  if (guard.op === 'lit' && guard.value === true) {
    return clause;
  }
  if (guard.op === 'and') {
    return {
      op: 'and',
      args: [...guard.args, clause],
    };
  }
  return {
    op: 'and',
    args: [guard, clause],
  };
}

export function updateRule(
  model: TransitionSystemModel,
  ruleIndex: number,
  rule: TransitionRule,
): TransitionSystemModel {
  if (ruleIndex < 0 || ruleIndex >= model.rules.length) {
    return model;
  }
  return {
    ...model,
    rules: model.rules.map((existing, i) => (i === ruleIndex ? rule : existing)),
  };
}

export function updateRuleGuard(
  model: TransitionSystemModel,
  ruleId: string,
  guard: BoolExpr,
): TransitionSystemModel {
  const index = model.rules.findIndex((rule) => rule.id === ruleId);
  if (index < 0) return model;
  const target = model.rules[index]!;
  return updateRule(model, index, {
    ...target,
    guard,
  });
}

function getPrincipledOpenInnerDoorRule(): TransitionRule {
  return bsl3AirlockFixedModel.rules.find((r) => r.id === 'open_inner_door')!;
}

export function isRepairableInterlockModel(model: TransitionSystemModel): boolean {
  const schema = model.schema;
  const outer = Object.hasOwn(schema, 'outerDoor') ? schema['outerDoor'] : undefined;
  const inner = Object.hasOwn(schema, 'innerDoor') ? schema['innerDoor'] : undefined;
  const pressure = Object.hasOwn(schema, 'pressure') ? schema['pressure'] : undefined;
  const uv = Object.hasOwn(schema, 'uvSterilizer') ? schema['uvSterilizer'] : undefined;
  const occupied = Object.hasOwn(schema, 'occupied') ? schema['occupied'] : undefined;
  const purge = Object.hasOwn(schema, 'purgeCycles') ? schema['purgeCycles'] : undefined;
  const override = Object.hasOwn(schema, 'maintenanceOverride')
    ? schema['maintenanceOverride']
    : undefined;

  if (
    outer?.kind !== 'enum' ||
    !outer.values.includes('closed') ||
    !outer.values.includes('open') ||
    inner?.kind !== 'enum' ||
    !inner.values.includes('closed') ||
    !inner.values.includes('open') ||
    pressure?.kind !== 'enum' ||
    !pressure.values.includes('negative') ||
    uv?.kind !== 'enum' ||
    !uv.values.includes('off') ||
    occupied?.kind !== 'boolean' ||
    purge?.kind !== 'int' ||
    purge.min > 1 ||
    purge.max < 1 ||
    override?.kind !== 'boolean'
  ) {
    return false;
  }

  const rule = model.rules.find((r) => r.id === 'open_inner_door');
  if (rule === undefined) return false;
  return (
    rule.updates.length === 1 &&
    rule.updates[0]!.var === 'innerDoor' &&
    rule.updates[0]!.value.op === 'lit' &&
    rule.updates[0]!.value.value === 'open'
  );
}

export function areValueExprEqual(left: ValueExpr, right: ValueExpr): boolean {
  if (left.op !== right.op) return false;
  if (left.op === 'lit' && right.op === 'lit') {
    const a = typeof left.value === 'number' && Object.is(left.value, -0) ? 0 : left.value;
    const b = typeof right.value === 'number' && Object.is(right.value, -0) ? 0 : right.value;
    return a === b;
  }
  if (left.op === 'var' && right.op === 'var') {
    return left.name === right.name;
  }
  if ((left.op === 'add' || left.op === 'sub') && right.op === left.op) {
    return areValueExprEqual(left.left, right.left) && areValueExprEqual(left.right, right.right);
  }
  return false;
}

export function areBoolExprEqual(left: BoolExpr, right: BoolExpr): boolean {
  if (left.op !== right.op) return false;
  if (left.op === 'lit' && right.op === 'lit') {
    return left.value === right.value;
  }
  if (left.op === 'var' && right.op === 'var') {
    return left.name === right.name;
  }
  if (left.op === 'not' && right.op === 'not') {
    return areBoolExprEqual(left.arg, right.arg);
  }
  if ((left.op === 'and' || left.op === 'or') && right.op === left.op) {
    if (left.args.length !== right.args.length) return false;
    return left.args.every((arg, i) => areBoolExprEqual(arg, right.args[i]!));
  }
  if (
    (left.op === 'eq' ||
      left.op === 'neq' ||
      left.op === 'lt' ||
      left.op === 'lte' ||
      left.op === 'gt' ||
      left.op === 'gte') &&
    right.op === left.op
  ) {
    return areValueExprEqual(left.left, right.left) && areValueExprEqual(left.right, right.right);
  }
  if (left.op === 'in' && right.op === 'in') {
    if (left.values.length !== right.values.length) return false;
    if (!areValueExprEqual(left.expr, right.expr)) return false;
    return left.values.every((val, i) => {
      const other = right.values[i];
      const a = typeof val === 'number' && Object.is(val, -0) ? 0 : val;
      const b = typeof other === 'number' && Object.is(other, -0) ? 0 : other;
      return a === b;
    });
  }
  return false;
}

const CANONICAL_CONTAINMENT_INVARIANT = bsl3AirlockFixedModel.invariants.find(
  (inv) => inv.id === 'inv_containment_seal',
)!;
const CANONICAL_UV_INVARIANT = bsl3AirlockFixedModel.invariants.find(
  (inv) => inv.id === 'inv_uv_exposure_lock',
)!;
const CANONICAL_LAB_ENTRY_GOAL = bsl3AirlockFixedModel.goal!;

export function hasCanonicalContainmentInvariantSpec(
  invariants: TransitionSystemModel['invariants'],
): boolean {
  const found = invariants.find((inv) => inv.id === CANONICAL_CONTAINMENT_INVARIANT.id);
  return found !== undefined && areBoolExprEqual(found.holds, CANONICAL_CONTAINMENT_INVARIANT.holds);
}

export function hasCanonicalUvInvariantSpec(invariants: TransitionSystemModel['invariants']): boolean {
  const found = invariants.find((inv) => inv.id === CANONICAL_UV_INVARIANT.id);
  return found !== undefined && areBoolExprEqual(found.holds, CANONICAL_UV_INVARIANT.holds);
}

export function hasCanonicalSealAndUvInvariantSpecs(
  invariants: TransitionSystemModel['invariants'],
): boolean {
  return (
    invariants.length === 2 &&
    hasCanonicalContainmentInvariantSpec(invariants) &&
    hasCanonicalUvInvariantSpec(invariants)
  );
}

export function hasCanonicalLabEntryGoalSpec(goal: TransitionSystemModel['goal']): boolean {
  return (
    goal !== undefined &&
    goal.id === CANONICAL_LAB_ENTRY_GOAL.id &&
    areBoolExprEqual(goal.reached, CANONICAL_LAB_ENTRY_GOAL.reached)
  );
}

export function hasCanonicalLabEntryGoal(model: TransitionSystemModel): boolean {
  return hasCanonicalLabEntryGoalSpec(model.goal);
}

function areVarDefsEqual(left: VarDef, right: VarDef): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'boolean' && right.kind === 'boolean') return true;
  if (left.kind === 'enum' && right.kind === 'enum') {
    return (
      left.values.length === right.values.length &&
      left.values.every((val, i) => val === right.values[i])
    );
  }
  if (left.kind === 'int' && right.kind === 'int') {
    return left.min === right.min && left.max === right.max;
  }
  return false;
}

export function isCanonicalVacuousLockoutModel(model: TransitionSystemModel): boolean {
  const refSchemaKeys = Object.keys(bsl3AirlockVacuousModel.schema);
  const actualSchemaKeys = Object.keys(model.schema);
  if (actualSchemaKeys.length !== refSchemaKeys.length) return false;
  for (const key of refSchemaKeys) {
    if (!Object.hasOwn(model.schema, key)) return false;
    const refDef = bsl3AirlockVacuousModel.schema[key]!;
    const actualDef = model.schema[key];
    if (actualDef === undefined || !areVarDefsEqual(actualDef, refDef)) return false;
    if (!Object.hasOwn(model.initialState, key)) return false;
    const refVal = bsl3AirlockVacuousModel.initialState[key];
    const actualVal = model.initialState[key];
    const normRef = typeof refVal === 'number' && Object.is(refVal, -0) ? 0 : refVal;
    const normActual = typeof actualVal === 'number' && Object.is(actualVal, -0) ? 0 : actualVal;
    if (normActual !== normRef) return false;
  }

  if (!hasCanonicalSealAndUvInvariantSpecs(model.invariants)) return false;
  if (!hasCanonicalLabEntryGoalSpec(model.goal)) return false;

  if (model.rules.length !== bsl3AirlockVacuousModel.rules.length) return false;
  for (const refRule of bsl3AirlockVacuousModel.rules) {
    const actualRule = model.rules.find((r) => r.id === refRule.id);
    if (actualRule === undefined) return false;
    if (!areBoolExprEqual(actualRule.guard, refRule.guard)) return false;
    if (actualRule.updates.length !== refRule.updates.length) return false;
    for (let i = 0; i < refRule.updates.length; i += 1) {
      const refUpd = refRule.updates[i]!;
      const actualUpd = actualRule.updates[i]!;
      if (actualUpd.var !== refUpd.var || !areValueExprEqual(actualUpd.value, refUpd.value)) {
        return false;
      }
    }
  }
  return true;
}

export function isPrincipledOpenInnerDoorGuard(model: TransitionSystemModel): boolean {
  const current = model.rules.find((r) => r.id === 'open_inner_door');
  if (current === undefined) return false;
  const reference = getPrincipledOpenInnerDoorRule();
  return JSON.stringify(current.guard) === JSON.stringify(reference.guard);
}

export function applyPrincipledInterlockRepair(
  model: TransitionSystemModel,
): TransitionSystemModel {
  if (!isRepairableInterlockModel(model)) {
    return model;
  }
  const reference = getPrincipledOpenInnerDoorRule();
  const index = model.rules.findIndex((r) => r.id === 'open_inner_door');
  if (index < 0) {
    return model;
  }
  const existing = model.rules[index]!;
  return updateRule(model, index, {
    ...existing,
    label: reference.label,
    guard: structuredClone(reference.guard),
  });
}

export function addAssumption(
  model: TransitionSystemModel,
  assumption: ModelAssumption,
): TransitionSystemModel {
  return {
    ...model,
    assumptions: [...model.assumptions, assumption],
  };
}

export function updateAssumption(
  model: TransitionSystemModel,
  index: number,
  assumption: ModelAssumption,
): TransitionSystemModel {
  if (index < 0 || index >= model.assumptions.length) {
    return model;
  }
  return {
    ...model,
    assumptions: model.assumptions.map((existing, i) => (i === index ? assumption : existing)),
  };
}

export function removeAssumption(
  model: TransitionSystemModel,
  index: number,
): TransitionSystemModel {
  if (index < 0 || index >= model.assumptions.length) {
    return model;
  }
  return {
    ...model,
    assumptions: model.assumptions.filter((_, i) => i !== index),
  };
}

interface TraversalBudget {
  visited: number;
  exceeded: boolean;
}

function isAccessorDescriptor(desc: PropertyDescriptor): boolean {
  return (
    Object.hasOwn(desc, 'get') ||
    Object.hasOwn(desc, 'set') ||
    desc.get !== undefined ||
    desc.set !== undefined
  );
}

function defineSafeDataProp<T extends object>(target: T, key: string, value: unknown): void {
  const desc = Object.create(null) as PropertyDescriptor;
  desc.value = value;
  desc.enumerable = true;
  desc.writable = true;
  desc.configurable = true;
  Object.defineProperty(target, key, desc);
}

function joinPath(base: string, key: string): string {
  return base.length === 0 ? key : `${base}.${key}`;
}

function isCanonicalArrayIndex(key: string, length: number): boolean {
  if (key.length === 0) return false;
  if (key.length > 1 && key.charCodeAt(0) === 48) return false;
  let value = 0;
  for (let i = 0; i < key.length; i += 1) {
    const code = key.charCodeAt(i);
    if (code < 48 || code > 57) return false;
    value = value * 10 + (code - 48);
    if (value >= length) return false;
  }
  return value >= 0 && value < length;
}

function consumeBudget(
  budget: TraversalBudget,
  depth: number,
  path: string,
  errors: ValidationError[],
): boolean {
  if (budget.exceeded) return false;
  budget.visited += 1;
  if (depth > MAX_IMPORT_DEPTH || budget.visited > MAX_IMPORT_NODES) {
    budget.exceeded = true;
    errors.push({
      code: 'IMPORT_COMPLEXITY_EXCEEDED',
      path: path.length > 0 ? path : '$',
      message: `Model input exceeds maximum traversal depth (${MAX_IMPORT_DEPTH}) or node budget (${MAX_IMPORT_NODES}).`,
    });
    return false;
  }
  return true;
}

function scanUnknownValueForReservedAndAccessors(
  value: unknown,
  path: string,
  depth: number,
  budget: TraversalBudget,
  errors: ValidationError[],
): void {
  if (value === null || typeof value !== 'object') return;
  if (!consumeBudget(budget, depth, path, errors)) return;

  const ownKeys = Reflect.ownKeys(value);
  for (let i = 0; i < ownKeys.length; i += 1) {
    if (!consumeBudget(budget, depth + 1, path, errors)) return;
    const key = ownKeys[i]!;
    if (typeof key === 'symbol') {
      errors.push({
        code: 'UNSUPPORTED_PROPERTY',
        path: path.length > 0 ? path : '$',
        message: 'Portable JSON models must not contain symbol properties.',
      });
      continue;
    }
    const childPath = joinPath(path, key);
    if (RESERVED_KEYS.has(key)) {
      errors.push({
        code: 'RESERVED_KEY',
        path: childPath,
        message: `Property "${key}" uses a reserved key name.`,
      });
    }
    const desc = Object.getOwnPropertyDescriptor(value, key);
    if (desc === undefined) continue;
    if (isAccessorDescriptor(desc)) {
      errors.push({
        code: 'UNSUPPORTED_PROPERTY',
        path: childPath,
        message: `Property "${key}" must be a plain data property, not an accessor.`,
      });
      continue;
    }
    if (desc.value !== null && typeof desc.value === 'object') {
      scanUnknownValueForReservedAndAccessors(desc.value, childPath, depth + 1, budget, errors);
    }
  }
}

function inspectAllowlistedPlainObject(
  value: unknown,
  path: string,
  allowedKeys: ReadonlySet<string> | null,
  depth: number,
  budget: TraversalBudget,
  errors: ValidationError[],
): Map<string, unknown> | null {
  if (!consumeBudget(budget, depth, path, errors)) return null;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    errors.push({
      code: 'UNSUPPORTED_PROPERTY',
      path: path.length > 0 ? path : '$',
      message: 'Portable model objects must be plain objects without custom prototypes.',
    });
    return null;
  }

  const ownKeys = Reflect.ownKeys(value);
  const entries = new Map<string, unknown>();
  let ok = true;

  for (let i = 0; i < ownKeys.length; i += 1) {
    if (!consumeBudget(budget, depth + 1, path, errors)) return null;
    const key = ownKeys[i]!;
    if (typeof key === 'symbol') {
      errors.push({
        code: 'UNSUPPORTED_PROPERTY',
        path: path.length > 0 ? path : '$',
        message: 'Portable JSON models must not define symbol properties.',
      });
      ok = false;
      continue;
    }

    const childPath = joinPath(path, key);
    const desc = Object.getOwnPropertyDescriptor(value, key);
    if (desc === undefined) continue;

    if (isAccessorDescriptor(desc)) {
      errors.push({
        code: 'UNSUPPORTED_PROPERTY',
        path: childPath,
        message: `Property "${key}" must be a plain data property, not an accessor.`,
      });
      ok = false;
      continue;
    }

    if (!desc.enumerable) {
      errors.push({
        code: 'UNSUPPORTED_PROPERTY',
        path: childPath,
        message: `Property "${key}" must be an enumerable own data property.`,
      });
      ok = false;
      continue;
    }

    if (RESERVED_KEYS.has(key)) {
      errors.push({
        code: 'RESERVED_KEY',
        path: childPath,
        message: `Property "${key}" uses a reserved key name.`,
      });
      ok = false;
      continue;
    }

    if (allowedKeys !== null && !allowedKeys.has(key)) {
      errors.push({
        code: 'UNSUPPORTED_FIELD',
        path: childPath,
        message: `Unsupported field "${key}" in portable model JSON.`,
      });
      if (desc.value !== null && typeof desc.value === 'object') {
        scanUnknownValueForReservedAndAccessors(desc.value, childPath, depth + 1, budget, errors);
      }
      ok = false;
      continue;
    }

    entries.set(key, desc.value);
  }

  return ok ? entries : null;
}

function inspectStrictPlainArray(
  value: unknown,
  path: string,
  depth: number,
  budget: TraversalBudget,
  errors: ValidationError[],
): unknown[] | null {
  if (!consumeBudget(budget, depth, path, errors)) return null;
  if (!Array.isArray(value)) {
    return null;
  }
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    errors.push({
      code: 'UNSUPPORTED_PROPERTY',
      path,
      message: 'Portable model arrays must use the standard Array prototype.',
    });
    return null;
  }

  const ownKeys = Reflect.ownKeys(value);
  const lengthDesc = Object.getOwnPropertyDescriptor(value, 'length');
  if (
    lengthDesc === undefined ||
    isAccessorDescriptor(lengthDesc) ||
    typeof lengthDesc.value !== 'number' ||
    !Number.isSafeInteger(lengthDesc.value) ||
    lengthDesc.value < 0
  ) {
    errors.push({
      code: 'UNSUPPORTED_PROPERTY',
      path,
      message: 'Array has an invalid length descriptor.',
    });
    return null;
  }

  const length = lengthDesc.value;
  let ok = true;

  for (let i = 0; i < ownKeys.length; i += 1) {
    if (!consumeBudget(budget, depth, path, errors)) return null;
    const key = ownKeys[i]!;
    if (typeof key === 'symbol') {
      errors.push({
        code: 'UNSUPPORTED_PROPERTY',
        path,
        message: 'Portable model arrays must not define symbol properties.',
      });
      ok = false;
      continue;
    }
    if (key === 'length') continue;
    if (RESERVED_KEYS.has(key)) {
      errors.push({
        code: 'RESERVED_KEY',
        path: joinPath(path, key),
        message: `Array property "${key}" uses a reserved key name.`,
      });
      ok = false;
      continue;
    }
    if (!isCanonicalArrayIndex(key, length)) {
      errors.push({
        code: 'UNSUPPORTED_PROPERTY',
        path: joinPath(path, key),
        message: `Array must not define extra property "${key}".`,
      });
      ok = false;
    }
  }

  const elements: unknown[] = [];
  for (let i = 0; i < length; i += 1) {
    if (!consumeBudget(budget, depth, `${path}[${i}]`, errors)) return null;
    const desc = Object.getOwnPropertyDescriptor(value, i);
    if (desc === undefined) {
      errors.push({
        code: 'INVALID_SPARSE_ARRAY',
        path: `${path}[${i}]`,
        message: `Array must be dense; missing element at index ${i}.`,
      });
      ok = false;
      continue;
    }
    if (isAccessorDescriptor(desc)) {
      errors.push({
        code: 'UNSUPPORTED_PROPERTY',
        path: `${path}[${i}]`,
        message: `Array element at index ${i} must be a plain data property, not an accessor.`,
      });
      ok = false;
      continue;
    }
    if (!desc.enumerable) {
      errors.push({
        code: 'UNSUPPORTED_PROPERTY',
        path: `${path}[${i}]`,
        message: `Array element at index ${i} must be an enumerable own data property.`,
      });
      ok = false;
      continue;
    }
    elements.push(desc.value);
  }

  return ok ? elements : null;
}

function detachPrimitive(value: unknown): unknown {
  if (typeof value === 'number') {
    return Object.is(value, -0) ? 0 : value;
  }
  return value;
}

function buildDetachedValueExpr(
  raw: unknown,
  path: string,
  depth: number,
  budget: TraversalBudget,
  errors: ValidationError[],
): unknown {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return raw;
  }
  const initialMap = inspectAllowlistedPlainObject(raw, path, null, depth, budget, errors);
  if (initialMap === null) return null;

  const op = initialMap.get('op');
  const allowed = typeof op === 'string' ? VALUE_EXPR_KEYS_BY_OP[op] : undefined;
  const fallbackAllowed = new Set(['op', 'value', 'name', 'left', 'right']);
  const checkSet = allowed ?? fallbackAllowed;

  for (const [key, val] of initialMap.entries()) {
    if (!checkSet.has(key)) {
      const childPath = joinPath(path, key);
      errors.push({
        code: 'UNSUPPORTED_FIELD',
        path: childPath,
        message:
          allowed !== undefined
            ? `Unsupported field "${key}" on value expression "${op}".`
            : `Unsupported field "${key}" on value expression.`,
      });
      if (val !== null && typeof val === 'object') {
        scanUnknownValueForReservedAndAccessors(val, childPath, depth + 1, budget, errors);
      }
    }
  }

  const out: Record<string, unknown> = {};
  if (initialMap.has('op')) defineSafeDataProp(out, 'op', detachPrimitive(op));
  if (op === 'lit') {
    if (initialMap.has('value')) {
      defineSafeDataProp(out, 'value', detachPrimitive(initialMap.get('value')));
    }
  } else if (op === 'var') {
    if (initialMap.has('name')) {
      defineSafeDataProp(out, 'name', detachPrimitive(initialMap.get('name')));
    }
  } else if (op === 'add' || op === 'sub') {
    if (initialMap.has('left')) {
      defineSafeDataProp(
        out,
        'left',
        buildDetachedValueExpr(initialMap.get('left'), `${path}.left`, depth + 1, budget, errors),
      );
    }
    if (initialMap.has('right')) {
      defineSafeDataProp(
        out,
        'right',
        buildDetachedValueExpr(initialMap.get('right'), `${path}.right`, depth + 1, budget, errors),
      );
    }
  }
  return out;
}

function buildDetachedBoolExpr(
  raw: unknown,
  path: string,
  depth: number,
  budget: TraversalBudget,
  errors: ValidationError[],
): unknown {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return raw;
  }
  const initialMap = inspectAllowlistedPlainObject(raw, path, null, depth, budget, errors);
  if (initialMap === null) return null;

  const op = initialMap.get('op');
  const allowed = typeof op === 'string' ? BOOL_EXPR_KEYS_BY_OP[op] : undefined;
  const fallbackAllowed = new Set(['op', 'value', 'name', 'arg', 'args', 'left', 'right', 'expr', 'values']);
  const checkSet = allowed ?? fallbackAllowed;

  for (const [key, val] of initialMap.entries()) {
    if (!checkSet.has(key)) {
      const childPath = joinPath(path, key);
      errors.push({
        code: 'UNSUPPORTED_FIELD',
        path: childPath,
        message:
          allowed !== undefined
            ? `Unsupported field "${key}" on boolean expression "${op}".`
            : `Unsupported field "${key}" on boolean expression.`,
      });
      if (val !== null && typeof val === 'object') {
        scanUnknownValueForReservedAndAccessors(val, childPath, depth + 1, budget, errors);
      }
    }
  }

  const out: Record<string, unknown> = {};
  if (initialMap.has('op')) defineSafeDataProp(out, 'op', detachPrimitive(op));
  if (op === 'lit') {
    if (initialMap.has('value')) {
      defineSafeDataProp(out, 'value', detachPrimitive(initialMap.get('value')));
    }
  } else if (op === 'var') {
    if (initialMap.has('name')) {
      defineSafeDataProp(out, 'name', detachPrimitive(initialMap.get('name')));
    }
  } else if (op === 'not') {
    if (initialMap.has('arg')) {
      defineSafeDataProp(
        out,
        'arg',
        buildDetachedBoolExpr(initialMap.get('arg'), `${path}.arg`, depth + 1, budget, errors),
      );
    }
  } else if (op === 'and' || op === 'or') {
    if (initialMap.has('args')) {
      const rawArgs = initialMap.get('args');
      const arr = inspectStrictPlainArray(rawArgs, `${path}.args`, depth, budget, errors);
      if (arr !== null) {
        defineSafeDataProp(
          out,
          'args',
          arr.map((item, idx) =>
            buildDetachedBoolExpr(item, `${path}.args[${idx}]`, depth + 1, budget, errors),
          ),
        );
      } else {
        defineSafeDataProp(out, 'args', rawArgs);
      }
    }
  } else if (
    op === 'eq' ||
    op === 'neq' ||
    op === 'lt' ||
    op === 'lte' ||
    op === 'gt' ||
    op === 'gte'
  ) {
    if (initialMap.has('left')) {
      defineSafeDataProp(
        out,
        'left',
        buildDetachedValueExpr(initialMap.get('left'), `${path}.left`, depth + 1, budget, errors),
      );
    }
    if (initialMap.has('right')) {
      defineSafeDataProp(
        out,
        'right',
        buildDetachedValueExpr(initialMap.get('right'), `${path}.right`, depth + 1, budget, errors),
      );
    }
  } else if (op === 'in') {
    if (initialMap.has('expr')) {
      defineSafeDataProp(
        out,
        'expr',
        buildDetachedValueExpr(initialMap.get('expr'), `${path}.expr`, depth + 1, budget, errors),
      );
    }
    if (initialMap.has('values')) {
      const rawVals = initialMap.get('values');
      const arr = inspectStrictPlainArray(rawVals, `${path}.values`, depth, budget, errors);
      if (arr !== null) {
        defineSafeDataProp(
          out,
          'values',
          arr.map((item) => detachPrimitive(item)),
        );
      } else {
        defineSafeDataProp(out, 'values', rawVals);
      }
    }
  }
  return out;
}

function buildDetachedModelSnapshot(candidate: unknown, errors: ValidationError[]): unknown {
  const budget: TraversalBudget = { visited: 0, exceeded: false };
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    return candidate;
  }

  const rootMap = inspectAllowlistedPlainObject(
    candidate,
    '',
    ROOT_ALLOWED_KEYS,
    0,
    budget,
    errors,
  );
  if (rootMap === null) return null;

  const detachedRoot: Record<string, unknown> = {};
  if (rootMap.has('id')) defineSafeDataProp(detachedRoot, 'id', detachPrimitive(rootMap.get('id')));
  if (rootMap.has('name')) {
    defineSafeDataProp(detachedRoot, 'name', detachPrimitive(rootMap.get('name')));
  }

  const declaredVars = new Set<string>();
  if (rootMap.has('schema')) {
    const rawSchema = rootMap.get('schema');
    const schemaMap = inspectAllowlistedPlainObject(rawSchema, 'schema', null, 1, budget, errors);
    if (schemaMap !== null) {
      const detachedSchema: Record<string, unknown> = {};
      for (const [varName, rawDef] of schemaMap.entries()) {
        const varPath = `schema.${varName}`;
        if (varName.trim().length === 0) {
          errors.push({
            code: 'INVALID_VAR_NAME',
            path: varPath,
            message: 'Variable name must be a non-empty string.',
          });
          continue;
        }
        declaredVars.add(varName);
        if (typeof rawDef !== 'object' || rawDef === null || Array.isArray(rawDef)) {
          defineSafeDataProp(detachedSchema, varName, rawDef);
          continue;
        }
        const defMap = inspectAllowlistedPlainObject(rawDef, varPath, null, 2, budget, errors);
        if (defMap === null) continue;
        const kind = defMap.get('kind');
        const allowedDefKeys =
          kind === 'boolean'
            ? VAR_DEF_BOOL_KEYS
            : kind === 'enum'
              ? VAR_DEF_ENUM_KEYS
              : kind === 'int'
                ? VAR_DEF_INT_KEYS
                : null;
        if (allowedDefKeys !== null) {
          for (const [k, v] of defMap.entries()) {
            if (!allowedDefKeys.has(k)) {
              const extraPath = joinPath(varPath, k);
              errors.push({
                code: 'UNSUPPORTED_FIELD',
                path: extraPath,
                message: `Unsupported field "${k}" on schema variable definition "${varName}".`,
              });
              if (v !== null && typeof v === 'object') {
                scanUnknownValueForReservedAndAccessors(v, extraPath, 3, budget, errors);
              }
            }
          }
        }
        const detachedDef: Record<string, unknown> = {};
        if (defMap.has('kind')) defineSafeDataProp(detachedDef, 'kind', detachPrimitive(kind));
        if (kind === 'enum' && defMap.has('values')) {
          const rawVals = defMap.get('values');
          const arr = inspectStrictPlainArray(rawVals, `${varPath}.values`, 3, budget, errors);
          if (arr !== null) {
            defineSafeDataProp(
              detachedDef,
              'values',
              arr.map((item) => detachPrimitive(item)),
            );
          } else {
            defineSafeDataProp(detachedDef, 'values', rawVals);
          }
        } else if (kind === 'int') {
          if (defMap.has('min')) {
            defineSafeDataProp(detachedDef, 'min', detachPrimitive(defMap.get('min')));
          }
          if (defMap.has('max')) {
            defineSafeDataProp(detachedDef, 'max', detachPrimitive(defMap.get('max')));
          }
        }
        defineSafeDataProp(detachedSchema, varName, detachedDef);
      }
      defineSafeDataProp(detachedRoot, 'schema', detachedSchema);
    } else {
      defineSafeDataProp(detachedRoot, 'schema', rawSchema);
    }
  }

  if (rootMap.has('initialState')) {
    const rawInit = rootMap.get('initialState');
    const initMap = inspectAllowlistedPlainObject(
      rawInit,
      'initialState',
      declaredVars.size > 0 ? declaredVars : null,
      1,
      budget,
      errors,
    );
    if (initMap !== null) {
      const detachedInit: Record<string, unknown> = {};
      for (const [key, val] of initMap.entries()) {
        defineSafeDataProp(detachedInit, key, detachPrimitive(val));
      }
      defineSafeDataProp(detachedRoot, 'initialState', detachedInit);
    } else {
      defineSafeDataProp(detachedRoot, 'initialState', rawInit);
    }
  }

  if (rootMap.has('rules')) {
    const rawRules = rootMap.get('rules');
    const rulesArr = inspectStrictPlainArray(rawRules, 'rules', 1, budget, errors);
    if (rulesArr !== null) {
      const detachedRules: unknown[] = [];
      for (let i = 0; i < rulesArr.length; i += 1) {
        const rulePath = `rules[${i}]`;
        const rawRule = rulesArr[i];
        const ruleMap = inspectAllowlistedPlainObject(
          rawRule,
          rulePath,
          RULE_ALLOWED_KEYS,
          2,
          budget,
          errors,
        );
        if (ruleMap === null) {
          detachedRules.push(rawRule);
          continue;
        }
        const detachedRule: Record<string, unknown> = {};
        if (ruleMap.has('id')) {
          defineSafeDataProp(detachedRule, 'id', detachPrimitive(ruleMap.get('id')));
        }
        if (ruleMap.has('label')) {
          defineSafeDataProp(detachedRule, 'label', detachPrimitive(ruleMap.get('label')));
        }
        if (ruleMap.has('guard')) {
          defineSafeDataProp(
            detachedRule,
            'guard',
            buildDetachedBoolExpr(ruleMap.get('guard'), `${rulePath}.guard`, 3, budget, errors),
          );
        }
        if (ruleMap.has('updates')) {
          const rawUpdates = ruleMap.get('updates');
          const updArr = inspectStrictPlainArray(
            rawUpdates,
            `${rulePath}.updates`,
            3,
            budget,
            errors,
          );
          if (updArr !== null) {
            const detachedUpdates: unknown[] = [];
            for (let j = 0; j < updArr.length; j += 1) {
              const updPath = `${rulePath}.updates[${j}]`;
              const rawUpd = updArr[j];
              const updMap = inspectAllowlistedPlainObject(
                rawUpd,
                updPath,
                UPDATE_ALLOWED_KEYS,
                4,
                budget,
                errors,
              );
              if (updMap === null) {
                detachedUpdates.push(rawUpd);
                continue;
              }
              const detachedUpd: Record<string, unknown> = {};
              if (updMap.has('var')) {
                defineSafeDataProp(detachedUpd, 'var', detachPrimitive(updMap.get('var')));
              }
              if (updMap.has('value')) {
                defineSafeDataProp(
                  detachedUpd,
                  'value',
                  buildDetachedValueExpr(updMap.get('value'), `${updPath}.value`, 5, budget, errors),
                );
              }
              detachedUpdates.push(detachedUpd);
            }
            defineSafeDataProp(detachedRule, 'updates', detachedUpdates);
          } else {
            defineSafeDataProp(detachedRule, 'updates', rawUpdates);
          }
        }
        detachedRules.push(detachedRule);
      }
      defineSafeDataProp(detachedRoot, 'rules', detachedRules);
    } else {
      defineSafeDataProp(detachedRoot, 'rules', rawRules);
    }
  }

  if (rootMap.has('invariants')) {
    const rawInvs = rootMap.get('invariants');
    const invsArr = inspectStrictPlainArray(rawInvs, 'invariants', 1, budget, errors);
    if (invsArr !== null) {
      const detachedInvs: unknown[] = [];
      for (let i = 0; i < invsArr.length; i += 1) {
        const invPath = `invariants[${i}]`;
        const rawInv = invsArr[i];
        const invMap = inspectAllowlistedPlainObject(
          rawInv,
          invPath,
          INVARIANT_ALLOWED_KEYS,
          2,
          budget,
          errors,
        );
        if (invMap === null) {
          detachedInvs.push(rawInv);
          continue;
        }
        const detachedInv: Record<string, unknown> = {};
        if (invMap.has('id')) defineSafeDataProp(detachedInv, 'id', detachPrimitive(invMap.get('id')));
        if (invMap.has('label')) {
          defineSafeDataProp(detachedInv, 'label', detachPrimitive(invMap.get('label')));
        }
        if (invMap.has('holds')) {
          defineSafeDataProp(
            detachedInv,
            'holds',
            buildDetachedBoolExpr(invMap.get('holds'), `${invPath}.holds`, 3, budget, errors),
          );
        }
        detachedInvs.push(detachedInv);
      }
      defineSafeDataProp(detachedRoot, 'invariants', detachedInvs);
    } else {
      defineSafeDataProp(detachedRoot, 'invariants', rawInvs);
    }
  }

  if (rootMap.has('goal') && rootMap.get('goal') !== undefined) {
    const rawGoal = rootMap.get('goal');
    const goalMap = inspectAllowlistedPlainObject(
      rawGoal,
      'goal',
      GOAL_ALLOWED_KEYS,
      1,
      budget,
      errors,
    );
    if (goalMap !== null) {
      const detachedGoal: Record<string, unknown> = {};
      if (goalMap.has('id')) {
        defineSafeDataProp(detachedGoal, 'id', detachPrimitive(goalMap.get('id')));
      }
      if (goalMap.has('label')) {
        defineSafeDataProp(detachedGoal, 'label', detachPrimitive(goalMap.get('label')));
      }
      if (goalMap.has('reached')) {
        defineSafeDataProp(
          detachedGoal,
          'reached',
          buildDetachedBoolExpr(goalMap.get('reached'), 'goal.reached', 2, budget, errors),
        );
      }
      defineSafeDataProp(detachedRoot, 'goal', detachedGoal);
    } else {
      defineSafeDataProp(detachedRoot, 'goal', rawGoal);
    }
  }

  if (rootMap.has('assumptions')) {
    const rawAssumptions = rootMap.get('assumptions');
    const asmArr = inspectStrictPlainArray(rawAssumptions, 'assumptions', 1, budget, errors);
    if (asmArr !== null) {
      const detachedAssumptions: unknown[] = [];
      for (let i = 0; i < asmArr.length; i += 1) {
        const asmPath = `assumptions[${i}]`;
        const rawAsm = asmArr[i];
        const asmMap = inspectAllowlistedPlainObject(
          rawAsm,
          asmPath,
          ASSUMPTION_ALLOWED_KEYS,
          2,
          budget,
          errors,
        );
        if (asmMap === null) {
          detachedAssumptions.push(rawAsm);
          continue;
        }
        const detachedAsm: Record<string, unknown> = {};
        if (asmMap.has('id')) {
          defineSafeDataProp(detachedAsm, 'id', detachPrimitive(asmMap.get('id')));
        }
        if (asmMap.has('category')) {
          defineSafeDataProp(detachedAsm, 'category', detachPrimitive(asmMap.get('category')));
        }
        if (asmMap.has('statement')) {
          defineSafeDataProp(detachedAsm, 'statement', detachPrimitive(asmMap.get('statement')));
        }
        if (asmMap.has('notModeled')) {
          defineSafeDataProp(detachedAsm, 'notModeled', detachPrimitive(asmMap.get('notModeled')));
        }
        detachedAssumptions.push(detachedAsm);
      }
      defineSafeDataProp(detachedRoot, 'assumptions', detachedAssumptions);
    } else {
      defineSafeDataProp(detachedRoot, 'assumptions', rawAssumptions);
    }
  }

  return detachedRoot;
}

interface ExportBudget {
  visited: number;
}

function consumeExportBudget(budget: ExportBudget, depth: number, path: string): void {
  budget.visited += 1;
  if (depth > MAX_IMPORT_DEPTH || budget.visited > MAX_IMPORT_NODES) {
    throw new TypeError(
      `Cannot export model: traversal exceeded maximum depth or node budget at "${path}".`,
    );
  }
}

function isPlainObjectLike(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function requireExportPlainObject(
  value: unknown,
  path: string,
  budget: ExportBudget,
  depth: number,
  allowedKeys?: ReadonlySet<string>,
): Record<string, unknown> {
  consumeExportBudget(budget, depth, path);
  if (!isPlainObjectLike(value)) {
    throw new TypeError(`Cannot export model: expected plain object at "${path}".`);
  }
  for (const key of Reflect.ownKeys(value)) {
    consumeExportBudget(budget, depth + 1, path);
    if (typeof key === 'symbol') {
      throw new TypeError(`Cannot export model: symbol property is not allowed at "${path}".`);
    }
    const childPath = path === '$' ? key : `${path}.${key}`;
    const desc = Object.getOwnPropertyDescriptor(value, key);
    if (desc === undefined) continue;
    if (isAccessorDescriptor(desc)) {
      throw new TypeError(
        `Cannot export model: accessor property is not allowed at "${childPath}".`,
      );
    }
    if (!desc.enumerable) {
      throw new TypeError(
        `Cannot export model: non-enumerable property is not allowed at "${childPath}".`,
      );
    }
    if (RESERVED_KEYS.has(key)) {
      throw new TypeError(
        `Cannot export model: reserved key "${key}" is not allowed at "${childPath}".`,
      );
    }
    if (allowedKeys !== undefined && !allowedKeys.has(key)) {
      throw new TypeError(
        `Cannot export model: unsupported field "${key}" at "${childPath}".`,
      );
    }
  }
  return value;
}

function checkExportAllowedKeys(
  obj: Record<string, unknown>,
  path: string,
  allowedKeys: ReadonlySet<string>,
): void {
  for (const key of Reflect.ownKeys(obj)) {
    if (typeof key !== 'string') continue;
    if (!allowedKeys.has(key)) {
      const childPath = path === '$' ? key : `${path}.${key}`;
      throw new TypeError(
        `Cannot export model: unsupported field "${key}" at "${childPath}".`,
      );
    }
  }
}

function readRequiredOwnData(obj: Record<string, unknown>, key: string, path: string): unknown {
  const desc = Object.getOwnPropertyDescriptor(obj, key);
  if (desc === undefined) {
    throw new TypeError(`Cannot export model: missing required own property at "${path}".`);
  }
  if (isAccessorDescriptor(desc)) {
    throw new TypeError(`Cannot export model: accessor property is not allowed at "${path}".`);
  }
  return desc.value;
}

function readOptionalOwnData(
  obj: Record<string, unknown>,
  key: string,
  path: string,
): { readonly present: boolean; readonly value: unknown } {
  const desc = Object.getOwnPropertyDescriptor(obj, key);
  if (desc === undefined) {
    return { present: false, value: undefined };
  }
  if (isAccessorDescriptor(desc)) {
    throw new TypeError(`Cannot export model: accessor property is not allowed at "${path}".`);
  }
  return { present: true, value: desc.value };
}

function readExportArrayElements(
  raw: unknown,
  path: string,
  budget: ExportBudget,
  depth: number,
): unknown[] {
  consumeExportBudget(budget, depth, path);
  if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype) {
    throw new TypeError(`Cannot export model: expected plain array at "${path}".`);
  }
  const lenDesc = Object.getOwnPropertyDescriptor(raw, 'length');
  if (
    lenDesc === undefined ||
    isAccessorDescriptor(lenDesc) ||
    typeof lenDesc.value !== 'number' ||
    !Number.isSafeInteger(lenDesc.value) ||
    lenDesc.value < 0
  ) {
    throw new TypeError(`Cannot export model: invalid array length descriptor at "${path}".`);
  }
  const length = lenDesc.value;
  for (const key of Reflect.ownKeys(raw)) {
    consumeExportBudget(budget, depth, path);
    if (typeof key === 'symbol') {
      throw new TypeError(`Cannot export model: array symbol property is not allowed at "${path}".`);
    }
    if (key === 'length') continue;
    if (RESERVED_KEYS.has(key)) {
      throw new TypeError(`Cannot export model: reserved array key "${key}" at "${path}.${key}".`);
    }
    if (!isCanonicalArrayIndex(key, length)) {
      throw new TypeError(`Cannot export model: unsupported array property "${key}" at "${path}.${key}".`);
    }
  }
  const out: unknown[] = [];
  for (let i = 0; i < length; i += 1) {
    consumeExportBudget(budget, depth, `${path}[${i}]`);
    const desc = Object.getOwnPropertyDescriptor(raw, i);
    if (desc === undefined) {
      throw new TypeError(`Cannot export model: sparse array element at "${path}[${i}]".`);
    }
    if (isAccessorDescriptor(desc)) {
      throw new TypeError(
        `Cannot export model: accessor element is not allowed at "${path}[${i}]".`,
      );
    }
    if (!desc.enumerable) {
      throw new TypeError(
        `Cannot export model: non-enumerable element is not allowed at "${path}[${i}]".`,
      );
    }
    out.push(desc.value);
  }
  return out;
}

function requireSafeString(val: unknown, path: string): string {
  if (typeof val !== 'string') {
    throw new TypeError(
      `Cannot export model: expected string primitive at "${path}", received ${typeof val}.`,
    );
  }
  return val;
}

function requireSafeInt(val: unknown, path: string): number {
  if (typeof val !== 'number' || !Number.isSafeInteger(val)) {
    throw new TypeError(`Cannot export model: expected safe integer at "${path}".`);
  }
  return Object.is(val, -0) ? 0 : val;
}

function requireSafeBoolean(val: unknown, path: string): boolean {
  if (typeof val !== 'boolean') {
    throw new TypeError(
      `Cannot export model: expected boolean primitive at "${path}", received ${typeof val}.`,
    );
  }
  return val;
}

function requireSafeStateValue(val: unknown, path: string): StateValue {
  if (typeof val === 'string' || typeof val === 'boolean') {
    return val;
  }
  if (typeof val === 'number' && Number.isSafeInteger(val)) {
    return Object.is(val, -0) ? 0 : val;
  }
  throw new TypeError(
    `Cannot export model: expected string, boolean, or safe integer at "${path}".`,
  );
}

function cloneValueExprForExport(
  raw: unknown,
  path: string,
  depth: number,
  budget: ExportBudget,
): ValueExpr {
  const obj = requireExportPlainObject(raw, path, budget, depth);
  const op = requireSafeString(readRequiredOwnData(obj, 'op', `${path}.op`), `${path}.op`);
  const allowed = VALUE_EXPR_KEYS_BY_OP[op];
  if (allowed === undefined) {
    throw new TypeError(`Cannot export model: unsupported value expression op "${op}" at "${path}".`);
  }
  checkExportAllowedKeys(obj, path, allowed);
  if (op === 'lit') {
    return {
      op: 'lit',
      value: requireSafeStateValue(
        readRequiredOwnData(obj, 'value', `${path}.value`),
        `${path}.value`,
      ),
    };
  }
  if (op === 'var') {
    return {
      op: 'var',
      name: requireSafeString(readRequiredOwnData(obj, 'name', `${path}.name`), `${path}.name`),
    };
  }
  return {
    op: op as 'add' | 'sub',
    left: cloneValueExprForExport(
      readRequiredOwnData(obj, 'left', `${path}.left`),
      `${path}.left`,
      depth + 1,
      budget,
    ),
    right: cloneValueExprForExport(
      readRequiredOwnData(obj, 'right', `${path}.right`),
      `${path}.right`,
      depth + 1,
      budget,
    ),
  };
}

function cloneBoolExprForExport(
  raw: unknown,
  path: string,
  depth: number,
  budget: ExportBudget,
): BoolExpr {
  const obj = requireExportPlainObject(raw, path, budget, depth);
  const op = requireSafeString(readRequiredOwnData(obj, 'op', `${path}.op`), `${path}.op`);
  const allowed = BOOL_EXPR_KEYS_BY_OP[op];
  if (allowed === undefined) {
    throw new TypeError(
      `Cannot export model: unsupported boolean expression op "${op}" at "${path}".`,
    );
  }
  checkExportAllowedKeys(obj, path, allowed);
  if (op === 'lit') {
    return {
      op: 'lit',
      value: requireSafeBoolean(
        readRequiredOwnData(obj, 'value', `${path}.value`),
        `${path}.value`,
      ),
    };
  }
  if (op === 'var') {
    return {
      op: 'var',
      name: requireSafeString(readRequiredOwnData(obj, 'name', `${path}.name`), `${path}.name`),
    };
  }
  if (op === 'not') {
    return {
      op: 'not',
      arg: cloneBoolExprForExport(
        readRequiredOwnData(obj, 'arg', `${path}.arg`),
        `${path}.arg`,
        depth + 1,
        budget,
      ),
    };
  }
  if (op === 'and' || op === 'or') {
    const rawArgs = readExportArrayElements(
      readRequiredOwnData(obj, 'args', `${path}.args`),
      `${path}.args`,
      budget,
      depth,
    );
    return {
      op,
      args: rawArgs.map((arg, idx) =>
        cloneBoolExprForExport(arg, `${path}.args[${idx}]`, depth + 1, budget),
      ),
    };
  }
  if (
    op === 'eq' ||
    op === 'neq' ||
    op === 'lt' ||
    op === 'lte' ||
    op === 'gt' ||
    op === 'gte'
  ) {
    return {
      op,
      left: cloneValueExprForExport(
        readRequiredOwnData(obj, 'left', `${path}.left`),
        `${path}.left`,
        depth + 1,
        budget,
      ),
      right: cloneValueExprForExport(
        readRequiredOwnData(obj, 'right', `${path}.right`),
        `${path}.right`,
        depth + 1,
        budget,
      ),
    };
  }
  const rawVals = readExportArrayElements(
    readRequiredOwnData(obj, 'values', `${path}.values`),
    `${path}.values`,
    budget,
    depth,
  );
  return {
    op: 'in',
    expr: cloneValueExprForExport(
      readRequiredOwnData(obj, 'expr', `${path}.expr`),
      `${path}.expr`,
      depth + 1,
      budget,
    ),
    values: rawVals.map((v, idx) => requireSafeStateValue(v, `${path}.values[${idx}]`)),
  };
}

function cloneCanonicalModelForExport(model: TransitionSystemModel): Record<string, unknown> {
  const budget: ExportBudget = { visited: 0 };
  const root = requireExportPlainObject(model, '$', budget, 0, ROOT_ALLOWED_KEYS);

  const out: Record<string, unknown> = {};
  defineSafeDataProp(out, 'id', requireSafeString(readRequiredOwnData(root, 'id', 'id'), 'id'));
  defineSafeDataProp(
    out,
    'name',
    requireSafeString(readRequiredOwnData(root, 'name', 'name'), 'name'),
  );

  const rawSchema = requireExportPlainObject(
    readRequiredOwnData(root, 'schema', 'schema'),
    'schema',
    budget,
    1,
  );
  const detachedSchema: Record<string, unknown> = {};
  const schemaVarNames: string[] = [];
  for (const key of Reflect.ownKeys(rawSchema)) {
    if (typeof key !== 'string') {
      throw new TypeError('Cannot export model: symbol property is not allowed on "schema".');
    }
    const varPath = `schema.${key}`;
    const desc = Object.getOwnPropertyDescriptor(rawSchema, key);
    if (desc === undefined) continue;
    const defObj = requireExportPlainObject(desc.value, varPath, budget, 2);
    const kind = requireSafeString(
      readRequiredOwnData(defObj, 'kind', `${varPath}.kind`),
      `${varPath}.kind`,
    );
    const allowedDefKeys =
      kind === 'boolean'
        ? VAR_DEF_BOOL_KEYS
        : kind === 'enum'
          ? VAR_DEF_ENUM_KEYS
          : kind === 'int'
            ? VAR_DEF_INT_KEYS
            : undefined;
    if (allowedDefKeys === undefined) {
      throw new TypeError(`Cannot export model: unsupported variable kind "${kind}" at "${varPath}".`);
    }
    checkExportAllowedKeys(defObj, varPath, allowedDefKeys);
    if (kind === 'boolean') {
      defineSafeDataProp(detachedSchema, key, { kind: 'boolean' });
      schemaVarNames.push(key);
    } else if (kind === 'enum') {
      const enumVals = readExportArrayElements(
        readRequiredOwnData(defObj, 'values', `${varPath}.values`),
        `${varPath}.values`,
        budget,
        3,
      ).map((v, idx) => requireSafeString(v, `${varPath}.values[${idx}]`));
      defineSafeDataProp(detachedSchema, key, { kind: 'enum', values: enumVals });
      schemaVarNames.push(key);
    } else {
      defineSafeDataProp(detachedSchema, key, {
        kind: 'int',
        min: requireSafeInt(readRequiredOwnData(defObj, 'min', `${varPath}.min`), `${varPath}.min`),
        max: requireSafeInt(readRequiredOwnData(defObj, 'max', `${varPath}.max`), `${varPath}.max`),
      });
      schemaVarNames.push(key);
    }
  }
  defineSafeDataProp(out, 'schema', detachedSchema);

  const schemaVarSet = new Set(schemaVarNames);
  const rawInit = requireExportPlainObject(
    readRequiredOwnData(root, 'initialState', 'initialState'),
    'initialState',
    budget,
    1,
    schemaVarSet.size > 0 ? schemaVarSet : undefined,
  );
  const detachedInit: Record<string, unknown> = {};
  for (const key of schemaVarNames) {
    const prop = readOptionalOwnData(rawInit, key, `initialState.${key}`);
    if (prop.present) {
      defineSafeDataProp(detachedInit, key, requireSafeStateValue(prop.value, `initialState.${key}`));
    }
  }
  defineSafeDataProp(out, 'initialState', detachedInit);

  const rawRules = readExportArrayElements(
    readRequiredOwnData(root, 'rules', 'rules'),
    'rules',
    budget,
    1,
  );
  const detachedRules = rawRules.map((rawRule, idx) => {
    const rulePath = `rules[${idx}]`;
    const ruleObj = requireExportPlainObject(rawRule, rulePath, budget, 2, RULE_ALLOWED_KEYS);
    const rawUpdates = readExportArrayElements(
      readRequiredOwnData(ruleObj, 'updates', `${rulePath}.updates`),
      `${rulePath}.updates`,
      budget,
      3,
    );
    return {
      id: requireSafeString(readRequiredOwnData(ruleObj, 'id', `${rulePath}.id`), `${rulePath}.id`),
      label: requireSafeString(
        readRequiredOwnData(ruleObj, 'label', `${rulePath}.label`),
        `${rulePath}.label`,
      ),
      guard: cloneBoolExprForExport(
        readRequiredOwnData(ruleObj, 'guard', `${rulePath}.guard`),
        `${rulePath}.guard`,
        3,
        budget,
      ),
      updates: rawUpdates.map((rawUpd, updIdx) => {
        const updPath = `${rulePath}.updates[${updIdx}]`;
        const updObj = requireExportPlainObject(rawUpd, updPath, budget, 4, UPDATE_ALLOWED_KEYS);
        return {
          var: requireSafeString(
            readRequiredOwnData(updObj, 'var', `${updPath}.var`),
            `${updPath}.var`,
          ),
          value: cloneValueExprForExport(
            readRequiredOwnData(updObj, 'value', `${updPath}.value`),
            `${updPath}.value`,
            5,
            budget,
          ),
        };
      }),
    };
  });
  defineSafeDataProp(out, 'rules', detachedRules);

  const rawInvariants = readExportArrayElements(
    readRequiredOwnData(root, 'invariants', 'invariants'),
    'invariants',
    budget,
    1,
  );
  const detachedInvariants = rawInvariants.map((rawInv, idx) => {
    const invPath = `invariants[${idx}]`;
    const invObj = requireExportPlainObject(rawInv, invPath, budget, 2, INVARIANT_ALLOWED_KEYS);
    return {
      id: requireSafeString(readRequiredOwnData(invObj, 'id', `${invPath}.id`), `${invPath}.id`),
      label: requireSafeString(
        readRequiredOwnData(invObj, 'label', `${invPath}.label`),
        `${invPath}.label`,
      ),
      holds: cloneBoolExprForExport(
        readRequiredOwnData(invObj, 'holds', `${invPath}.holds`),
        `${invPath}.holds`,
        3,
        budget,
      ),
    };
  });
  defineSafeDataProp(out, 'invariants', detachedInvariants);

  const goalProp = readOptionalOwnData(root, 'goal', 'goal');
  if (goalProp.present && goalProp.value !== undefined) {
    const goalObj = requireExportPlainObject(goalProp.value, 'goal', budget, 1, GOAL_ALLOWED_KEYS);
    defineSafeDataProp(out, 'goal', {
      id: requireSafeString(readRequiredOwnData(goalObj, 'id', 'goal.id'), 'goal.id'),
      label: requireSafeString(readRequiredOwnData(goalObj, 'label', 'goal.label'), 'goal.label'),
      reached: cloneBoolExprForExport(
        readRequiredOwnData(goalObj, 'reached', 'goal.reached'),
        'goal.reached',
        2,
        budget,
      ),
    });
  }

  const rawAssumptions = readExportArrayElements(
    readRequiredOwnData(root, 'assumptions', 'assumptions'),
    'assumptions',
    budget,
    1,
  );
  const detachedAssumptions = rawAssumptions.map((rawAsm, idx) => {
    const asmPath = `assumptions[${idx}]`;
    const asmObj = requireExportPlainObject(rawAsm, asmPath, budget, 2, ASSUMPTION_ALLOWED_KEYS);
    return {
      id: requireSafeString(readRequiredOwnData(asmObj, 'id', `${asmPath}.id`), `${asmPath}.id`),
      category: requireSafeString(
        readRequiredOwnData(asmObj, 'category', `${asmPath}.category`),
        `${asmPath}.category`,
      ),
      statement: requireSafeString(
        readRequiredOwnData(asmObj, 'statement', `${asmPath}.statement`),
        `${asmPath}.statement`,
      ),
      notModeled: requireSafeString(
        readRequiredOwnData(asmObj, 'notModeled', `${asmPath}.notModeled`),
        `${asmPath}.notModeled`,
      ),
    };
  });
  defineSafeDataProp(out, 'assumptions', detachedAssumptions);

  return out;
}

export function exportModelToJson(model: TransitionSystemModel): string {
  const canonical = cloneCanonicalModelForExport(model);
  const pretty = JSON.stringify(canonical, null, 2);
  if (pretty.length <= MAX_IMPORT_JSON_CHARS) {
    return pretty;
  }
  const compact = JSON.stringify(canonical);
  if (compact.length <= MAX_IMPORT_JSON_CHARS) {
    return compact;
  }
  throw new TypeError(
    `Cannot export model: serialized JSON (${compact.length} chars) exceeds maximum portable size of ${MAX_IMPORT_JSON_CHARS} characters.`,
  );
}

export function tryExportModelJson(model: TransitionSystemModel): JsonExportResult {
  try {
    return { ok: true, text: exportModelToJson(model) };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'JSON_EXPORT_ERROR',
        path: '$',
        message: err instanceof Error ? err.message : 'Unable to export current model to JSON.',
      },
    };
  }
}

function isJsonWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

const MAX_JSON_SCAN_DEPTH = 256;

type JsonScanResult =
  | { readonly ok: true; readonly numberErrors: readonly ValidationError[] }
  | {
      readonly ok: false;
      readonly code: 'JSON_PARSE_ERROR' | 'IMPORT_COMPLEXITY_EXCEEDED';
      readonly syntaxError: string;
    };

function skipJsonWhitespace(raw: string, start: number): number {
  let i = start;
  while (i < raw.length && isJsonWhitespace(raw[i]!)) {
    i += 1;
  }
  return i;
}

function scanJsonString(raw: string, start: number): { readonly nextIndex: number } | { readonly error: string } {
  let i = start + 1;
  while (i < raw.length) {
    const ch = raw[i]!;
    const code = raw.charCodeAt(i);
    if (code < 0x20) {
      return { error: `Unescaped control character in string at index ${i}.` };
    }
    if (ch === '"') {
      return { nextIndex: i + 1 };
    }
    if (ch === '\\') {
      i += 1;
      if (i >= raw.length) {
        return { error: 'Unterminated escape sequence in JSON string.' };
      }
      const esc = raw[i]!;
      if (
        esc === '"' ||
        esc === '\\' ||
        esc === '/' ||
        esc === 'b' ||
        esc === 'f' ||
        esc === 'n' ||
        esc === 'r' ||
        esc === 't'
      ) {
        i += 1;
        continue;
      }
      if (esc === 'u') {
        if (i + 4 >= raw.length) {
          return { error: 'Incomplete unicode escape in JSON string.' };
        }
        for (let h = 1; h <= 4; h += 1) {
          const hex = raw[i + h]!;
          if (!/^[0-9a-fA-F]$/.test(hex)) {
            return { error: `Invalid hex digit "${hex}" in unicode escape.` };
          }
        }
        i += 5;
        continue;
      }
      return { error: `Invalid escape "\\${esc}" in JSON string.` };
    }
    i += 1;
  }
  return { error: 'Unterminated JSON string literal.' };
}

function scanAndValidateRawJson(raw: string): JsonScanResult {
  const stack: ('object' | 'array')[] = [];
  const numberErrors: ValidationError[] = [];
  let i = skipJsonWhitespace(raw, 0);
  if (i >= raw.length) {
    return { ok: false, code: 'JSON_PARSE_ERROR', syntaxError: 'JSON input is empty.' };
  }

  type ExpectMode = 'value' | 'after-value' | 'key-or-end' | 'key' | 'colon' | 'comma-or-end';
  let expectMode: ExpectMode = 'value';
  let rootDone = false;

  while (true) {
    i = skipJsonWhitespace(raw, i);

    if (rootDone && stack.length === 0) {
      return i < raw.length
        ? {
            ok: false,
            code: 'JSON_PARSE_ERROR',
            syntaxError: `Unexpected trailing token at index ${i}.`,
          }
        : { ok: true, numberErrors };
    }

    if (i >= raw.length) {
      return {
        ok: false,
        code: 'JSON_PARSE_ERROR',
        syntaxError: 'Unexpected end of JSON input.',
      };
    }

    const ch = raw[i]!;

    if (expectMode === 'colon') {
      if (ch !== ':') {
        return {
          ok: false,
          code: 'JSON_PARSE_ERROR',
          syntaxError: `Expected ":" at index ${i}.`,
        };
      }
      i += 1;
      expectMode = 'value';
      continue;
    }

    if (expectMode === 'key-or-end') {
      if (ch === '}') {
        if (stack.pop() !== 'object') {
          return {
            ok: false,
            code: 'JSON_PARSE_ERROR',
            syntaxError: `Mismatched "}" at index ${i}.`,
          };
        }
        i += 1;
        if (stack.length === 0) {
          rootDone = true;
        } else {
          expectMode = 'comma-or-end';
        }
        continue;
      }
      if (ch !== '"') {
        return {
          ok: false,
          code: 'JSON_PARSE_ERROR',
          syntaxError: `Expected string key or "}" at index ${i}.`,
        };
      }
      const strRes = scanJsonString(raw, i);
      if ('error' in strRes) {
        return { ok: false, code: 'JSON_PARSE_ERROR', syntaxError: strRes.error };
      }
      i = strRes.nextIndex;
      expectMode = 'colon';
      continue;
    }

    if (expectMode === 'key') {
      if (ch !== '"') {
        return {
          ok: false,
          code: 'JSON_PARSE_ERROR',
          syntaxError: `Expected property key string at index ${i}.`,
        };
      }
      const strRes = scanJsonString(raw, i);
      if ('error' in strRes) {
        return { ok: false, code: 'JSON_PARSE_ERROR', syntaxError: strRes.error };
      }
      i = strRes.nextIndex;
      expectMode = 'colon';
      continue;
    }

    if (expectMode === 'comma-or-end') {
      const parent = stack[stack.length - 1];
      if (ch === ',') {
        i += 1;
        expectMode = parent === 'object' ? 'key' : 'value';
        continue;
      }
      if (ch === '}' && parent === 'object') {
        stack.pop();
        i += 1;
        if (stack.length === 0) {
          rootDone = true;
        } else {
          expectMode = 'comma-or-end';
        }
        continue;
      }
      if (ch === ']' && parent === 'array') {
        stack.pop();
        i += 1;
        if (stack.length === 0) {
          rootDone = true;
        } else {
          expectMode = 'comma-or-end';
        }
        continue;
      }
      return {
        ok: false,
        code: 'JSON_PARSE_ERROR',
        syntaxError: `Expected "," or closing delimiter at index ${i}.`,
      };
    }

    // expectMode === 'value'
    if (ch === '{') {
      if (stack.length >= MAX_JSON_SCAN_DEPTH) {
        return {
          ok: false,
          code: 'IMPORT_COMPLEXITY_EXCEEDED',
          syntaxError: `JSON nesting exceeds maximum depth (${MAX_JSON_SCAN_DEPTH}).`,
        };
      }
      stack.push('object');
      i += 1;
      expectMode = 'key-or-end';
      continue;
    }

    if (ch === '[') {
      if (stack.length >= MAX_JSON_SCAN_DEPTH) {
        return {
          ok: false,
          code: 'IMPORT_COMPLEXITY_EXCEEDED',
          syntaxError: `JSON nesting exceeds maximum depth (${MAX_JSON_SCAN_DEPTH}).`,
        };
      }
      stack.push('array');
      i += 1;
      const nextNonWs = skipJsonWhitespace(raw, i);
      if (nextNonWs < raw.length && raw[nextNonWs] === ']') {
        stack.pop();
        i = nextNonWs + 1;
        if (stack.length === 0) {
          rootDone = true;
        } else {
          expectMode = 'comma-or-end';
        }
      } else {
        expectMode = 'value';
      }
      continue;
    }

    if (ch === '"') {
      const strRes = scanJsonString(raw, i);
      if ('error' in strRes) {
        return { ok: false, code: 'JSON_PARSE_ERROR', syntaxError: strRes.error };
      }
      i = strRes.nextIndex;
      if (stack.length === 0) {
        rootDone = true;
      } else {
        expectMode = 'comma-or-end';
      }
      continue;
    }

    if (raw.startsWith('true', i)) {
      i += 4;
      if (stack.length === 0) rootDone = true;
      else expectMode = 'comma-or-end';
      continue;
    }

    if (raw.startsWith('false', i)) {
      i += 5;
      if (stack.length === 0) rootDone = true;
      else expectMode = 'comma-or-end';
      continue;
    }

    if (raw.startsWith('null', i)) {
      i += 4;
      if (stack.length === 0) rootDone = true;
      else expectMode = 'comma-or-end';
      continue;
    }

    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      const start = i;
      if (raw[i] === '-') i += 1;
      if (i >= raw.length || raw[i]! < '0' || raw[i]! > '9') {
        return {
          ok: false,
          code: 'JSON_PARSE_ERROR',
          syntaxError: `Invalid number token at index ${start}.`,
        };
      }
      if (raw[i] === '0') {
        i += 1;
        if (i < raw.length && raw[i]! >= '0' && raw[i]! <= '9') {
          return {
            ok: false,
            code: 'JSON_PARSE_ERROR',
            syntaxError: `Leading zero in JSON number at index ${start}.`,
          };
        }
      } else {
        while (i < raw.length && raw[i]! >= '0' && raw[i]! <= '9') {
          i += 1;
        }
      }
      if (i < raw.length && raw[i] === '.') {
        i += 1;
        if (i >= raw.length || raw[i]! < '0' || raw[i]! > '9') {
          return {
            ok: false,
            code: 'JSON_PARSE_ERROR',
            syntaxError: `Invalid fractional number at index ${start}.`,
          };
        }
        while (i < raw.length && raw[i]! >= '0' && raw[i]! <= '9') {
          i += 1;
        }
      }
      if (i < raw.length && (raw[i] === 'e' || raw[i] === 'E')) {
        i += 1;
        if (i < raw.length && (raw[i] === '+' || raw[i] === '-')) {
          i += 1;
        }
        if (i >= raw.length || raw[i]! < '0' || raw[i]! > '9') {
          return {
            ok: false,
            code: 'JSON_PARSE_ERROR',
            syntaxError: `Invalid exponent in JSON number at index ${start}.`,
          };
        }
        while (i < raw.length && raw[i]! >= '0' && raw[i]! <= '9') {
          i += 1;
        }
      }

      const token = raw.slice(start, i);
      if (!RFC8259_JSON_NUMBER_RE.test(token)) {
        return {
          ok: false,
          code: 'JSON_PARSE_ERROR',
          syntaxError: `Invalid JSON number token "${token}".`,
        };
      }

      if (numberErrors.length < 64) {
        if (token.includes('.') || token.includes('e') || token.includes('E')) {
          numberErrors.push({
            code: 'NON_INTEGER_JSON_NUMBER',
            path: '$',
            message: `Invalid non-integer JSON number token "${token}".`,
          });
        } else {
          const digitLength = token.startsWith('-') ? token.length - 1 : token.length;
          if (digitLength > 16) {
            numberErrors.push({
              code: 'UNSAFE_INTEGER_JSON_NUMBER',
              path: '$',
              message: `Integer JSON number token "${token}" exceeds safe integer bounds.`,
            });
          } else {
            const big = BigInt(token);
            if (big < MIN_SAFE_BIGINT || big > MAX_SAFE_BIGINT) {
              numberErrors.push({
                code: 'UNSAFE_INTEGER_JSON_NUMBER',
                path: '$',
                message: `Integer JSON number token "${token}" exceeds safe integer bounds.`,
              });
            }
          }
        }
      }

      if (stack.length === 0) rootDone = true;
      else expectMode = 'comma-or-end';
      continue;
    }

    return {
      ok: false,
      code: 'JSON_PARSE_ERROR',
      syntaxError: `Unexpected token "${ch}" at index ${i}.`,
    };
  }
}

export function validateImportedModelValue(candidate: unknown): JsonImportResult {
  try {
    const structuralErrors: ValidationError[] = [];
    const detached = buildDetachedModelSnapshot(candidate, structuralErrors);
    if (structuralErrors.length > 0) {
      return { ok: false, errors: structuralErrors };
    }
    const errors = validateModel(detached);
    if (errors.length > 0) {
      return { ok: false, errors };
    }
    return { ok: true, model: detached as TransitionSystemModel };
  } catch {
    return {
      ok: false,
      errors: [
        {
          code: 'UNEXPECTED_INPUT_ERROR',
          path: '$',
          message: 'Unexpected error while validating imported model value.',
        },
      ],
    };
  }
}

export function importModelFromJson(rawText: unknown): JsonImportResult {
  try {
    if (typeof rawText !== 'string') {
      if (rawText !== null && typeof rawText === 'object') {
        return validateImportedModelValue(rawText);
      }
      return {
        ok: false,
        errors: [
          {
            code: 'INVALID_JSON_INPUT',
            path: '$',
            message: `Model import expects a JSON string, received ${typeof rawText}.`,
          },
        ],
      };
    }

    if (rawText.trim().length === 0) {
      return {
        ok: false,
        errors: [
          {
            code: 'JSON_PARSE_ERROR',
            path: '$',
            message: 'JSON input is empty.',
          },
        ],
      };
    }

    if (rawText.length > MAX_IMPORT_JSON_CHARS) {
      return {
        ok: false,
        errors: [
          {
            code: 'JSON_TOO_LARGE',
            path: '$',
            message: `JSON input exceeds maximum size of ${MAX_IMPORT_JSON_CHARS} characters.`,
          },
        ],
      };
    }

    const scanResult = scanAndValidateRawJson(rawText);
    if (!scanResult.ok) {
      return {
        ok: false,
        errors: [
          {
            code: scanResult.code,
            path: '$',
            message:
              scanResult.code === 'IMPORT_COMPLEXITY_EXCEEDED'
                ? scanResult.syntaxError
                : `Invalid JSON: ${scanResult.syntaxError}`,
          },
        ],
      };
    }

    if (scanResult.numberErrors.length > 0) {
      return { ok: false, errors: scanResult.numberErrors };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'Malformed JSON syntax.';
      return {
        ok: false,
        errors: [
          {
            code: 'JSON_PARSE_ERROR',
            path: '$',
            message: `Invalid JSON: ${detail}`,
          },
        ],
      };
    }

    return validateImportedModelValue(parsed);
  } catch {
    return {
      ok: false,
      errors: [
        {
          code: 'UNEXPECTED_INPUT_ERROR',
          path: '$',
          message: 'Unexpected error while importing JSON model.',
        },
      ],
    };
  }
}

function classifyErrorSection(path: string): DiagnosticSection {
  if (path.startsWith('schema') || path.startsWith('initialState')) {
    return 'schema';
  }
  if (path.startsWith('rules')) {
    return 'rules';
  }
  if (path.startsWith('invariants')) {
    return 'invariants';
  }
  if (path.startsWith('goal')) {
    return 'goal';
  }
  if (path.startsWith('assumptions')) {
    return 'assumptions';
  }
  return 'general';
}

export function indexModelDiagnostics(errors: readonly ValidationError[]): ModelDiagnosticsIndex {
  const byPath: Record<string, ValidationError[]> = {};
  const sections: Record<DiagnosticSection, ValidationError[]> = {
    general: [],
    schema: [],
    rules: [],
    invariants: [],
    goal: [],
    assumptions: [],
  };

  for (const error of errors) {
    const existing = byPath[error.path];
    if (existing !== undefined) {
      existing.push(error);
    } else {
      byPath[error.path] = [error];
    }
    const section = classifyErrorSection(error.path);
    sections[section].push(error);
  }

  return {
    all: [...errors],
    byPath,
    sections,
  };
}

export function getErrorsForPathPrefix(
  index: ModelDiagnosticsIndex,
  prefix: string,
): readonly ValidationError[] {
  return index.all.filter(
    (err) =>
      err.path === prefix ||
      err.path.startsWith(`${prefix}.`) ||
      err.path.startsWith(`${prefix}[`),
  );
}
