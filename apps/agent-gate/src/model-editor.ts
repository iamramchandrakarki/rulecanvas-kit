import {
  validateModel,
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
  type ValidationError,
  type ValueExpr,
  type VarDef,
} from '@rulecanvas/core';

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

export type StrictIntegerParseResult =
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false; readonly message: string };

const MAX_IMPORT_JSON_CHARS = 2_000_000;
const MAX_IMPORT_DEPTH = 64;
const MAX_IMPORT_NODES = 50_000;

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

export function isValueCompatibleWithVarDef(value: StateValue | undefined, def: VarDef): boolean {
  if (value === undefined) return false;
  switch (def.kind) {
    case 'boolean':
      return typeof value === 'boolean';
    case 'enum':
      return typeof value === 'string' && def.values.includes(value);
    case 'int':
      return (
        typeof value === 'number' &&
        Number.isSafeInteger(value) &&
        value >= def.min &&
        value <= def.max
      );
  }
}

export function updateModelMetadata(
  model: TransitionSystemModel,
  patch: { readonly id?: string; readonly name?: string },
): TransitionSystemModel {
  return {
    ...model,
    id: patch.id ?? model.id,
    name: patch.name ?? model.name,
  };
}

export function addSchemaVariable(
  model: TransitionSystemModel,
  name: string,
  def: VarDef,
  initialValue?: StateValue,
): TransitionSystemModel {
  const nextSchema: Record<string, VarDef> = { ...model.schema, [name]: def };
  const resolvedValue =
    initialValue !== undefined ? initialValue : defaultValueForVarDef(def);
  const nextInitial: StateSnapshot = { ...model.initialState, [name]: resolvedValue };
  return {
    ...model,
    schema: nextSchema,
    initialState: nextInitial,
  };
}

export function updateSchemaVariable(
  model: TransitionSystemModel,
  oldName: string,
  newName: string,
  def: VarDef,
  initialValue?: StateValue,
): TransitionSystemModel {
  const nextSchema: Record<string, VarDef> = {};
  const nextInitial: StateSnapshot = {};
  const existingValue = Object.hasOwn(model.initialState, oldName)
    ? model.initialState[oldName]
    : undefined;

  const resolvedValue =
    initialValue !== undefined
      ? initialValue
      : isValueCompatibleWithVarDef(existingValue, def)
        ? existingValue!
        : defaultValueForVarDef(def);

  let replaced = false;
  for (const key of Object.keys(model.schema)) {
    if (key === oldName) {
      nextSchema[newName] = def;
      nextInitial[newName] = resolvedValue;
      replaced = true;
    } else if (key !== newName) {
      nextSchema[key] = model.schema[key]!;
      if (Object.hasOwn(model.initialState, key)) {
        nextInitial[key] = model.initialState[key]!;
      }
    }
  }

  if (!replaced) {
    nextSchema[newName] = def;
    nextInitial[newName] = resolvedValue;
  }

  return {
    ...model,
    schema: nextSchema,
    initialState: nextInitial,
  };
}

export function removeSchemaVariable(
  model: TransitionSystemModel,
  name: string,
): TransitionSystemModel {
  const nextSchema: Record<string, VarDef> = {};
  const nextInitial: StateSnapshot = {};
  for (const key of Object.keys(model.schema)) {
    if (key === name) continue;
    nextSchema[key] = model.schema[key]!;
    if (Object.hasOwn(model.initialState, key)) {
      nextInitial[key] = model.initialState[key]!;
    }
  }
  return {
    ...model,
    schema: nextSchema,
    initialState: nextInitial,
  };
}

export function setInitialStateValue(
  model: TransitionSystemModel,
  name: string,
  value: StateValue,
): TransitionSystemModel {
  return {
    ...model,
    initialState: {
      ...model.initialState,
      [name]: value,
    },
  };
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

export function createDefaultValueExpr(
  op: ValueExpr['op'],
  schema: StateSchema,
): ValueExpr {
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

export function createDefaultBoolExpr(
  op: BoolExpr['op'],
  schema: StateSchema,
): BoolExpr {
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

export function createDefaultRule(
  model: TransitionSystemModel,
  suffix?: number,
): TransitionRule {
  const idx = suffix ?? model.rules.length + 1;
  const existingIds = new Set(model.rules.map((r) => r.id));
  let candidateId = `rule_${idx}`;
  let counter = idx;
  while (existingIds.has(candidateId)) {
    counter += 1;
    candidateId = `rule_${counter}`;
  }
  return {
    id: candidateId,
    label: `Transition rule ${counter}`,
    guard: { op: 'lit', value: true },
    updates: [],
  };
}

export function addRule(
  model: TransitionSystemModel,
  rule: TransitionRule,
): TransitionSystemModel {
  return {
    ...model,
    rules: [...model.rules, rule],
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

export function removeRule(
  model: TransitionSystemModel,
  ruleIndex: number,
): TransitionSystemModel {
  if (ruleIndex < 0 || ruleIndex >= model.rules.length) {
    return model;
  }
  return {
    ...model,
    rules: model.rules.filter((_, i) => i !== ruleIndex),
  };
}

export function moveRule(
  model: TransitionSystemModel,
  fromIndex: number,
  toIndex: number,
): TransitionSystemModel {
  if (
    fromIndex < 0 ||
    fromIndex >= model.rules.length ||
    toIndex < 0 ||
    toIndex >= model.rules.length ||
    fromIndex === toIndex
  ) {
    return model;
  }
  const next = [...model.rules];
  const [moved] = next.splice(fromIndex, 1);
  if (moved === undefined) return model;
  next.splice(toIndex, 0, moved);
  return {
    ...model,
    rules: next,
  };
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

export function appendRuleGuardClause(
  model: TransitionSystemModel,
  ruleIdOrIndex: string | number,
  clause: BoolExpr,
): TransitionSystemModel {
  const index =
    typeof ruleIdOrIndex === 'number'
      ? ruleIdOrIndex
      : model.rules.findIndex((rule) => rule.id === ruleIdOrIndex);
  if (index < 0 || index >= model.rules.length) {
    return model;
  }
  const target = model.rules[index]!;
  return updateRule(model, index, {
    ...target,
    guard: appendGuardClause(target.guard, clause),
  });
}

export function addRuleUpdate(
  rule: TransitionRule,
  update: UpdateAssignment,
): TransitionRule {
  return {
    ...rule,
    updates: [...rule.updates, update],
  };
}

export function updateRuleUpdate(
  rule: TransitionRule,
  updateIndex: number,
  update: UpdateAssignment,
): TransitionRule {
  if (updateIndex < 0 || updateIndex >= rule.updates.length) {
    return rule;
  }
  return {
    ...rule,
    updates: rule.updates.map((existing, i) => (i === updateIndex ? update : existing)),
  };
}

export function removeRuleUpdate(
  rule: TransitionRule,
  updateIndex: number,
): TransitionRule {
  if (updateIndex < 0 || updateIndex >= rule.updates.length) {
    return rule;
  }
  return {
    ...rule,
    updates: rule.updates.filter((_, i) => i !== updateIndex),
  };
}

export function addInvariant(
  model: TransitionSystemModel,
  invariant: Invariant,
): TransitionSystemModel {
  return {
    ...model,
    invariants: [...model.invariants, invariant],
  };
}

export function updateInvariant(
  model: TransitionSystemModel,
  index: number,
  invariant: Invariant,
): TransitionSystemModel {
  if (index < 0 || index >= model.invariants.length) {
    return model;
  }
  return {
    ...model,
    invariants: model.invariants.map((existing, i) => (i === index ? invariant : existing)),
  };
}

export function removeInvariant(
  model: TransitionSystemModel,
  index: number,
): TransitionSystemModel {
  if (index < 0 || index >= model.invariants.length) {
    return model;
  }
  return {
    ...model,
    invariants: model.invariants.filter((_, i) => i !== index),
  };
}

export function setGoalEnabled(
  model: TransitionSystemModel,
  enabled: boolean,
  fallbackGoal?: Goal,
): TransitionSystemModel {
  if (!enabled) {
    const { goal: _omitted, ...rest } = model;
    return rest;
  }
  if (model.goal !== undefined) {
    return model;
  }
  const nextGoal: Goal = fallbackGoal ?? {
    id: 'goal_primary',
    label: 'Reach target policy state',
    reached: createDefaultBoolExpr('lit', model.schema),
  };
  return {
    ...model,
    goal: nextGoal,
  };
}

export function updateGoal(
  model: TransitionSystemModel,
  goal: Goal,
): TransitionSystemModel {
  return {
    ...model,
    goal,
  };
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
    assumptions: model.assumptions.map((existing, i) =>
      i === index ? assumption : existing,
    ),
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
    if (!consumeBudget(budget, depth + 1, path, errors)) return null;
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
    if (!consumeBudget(budget, depth + 1, `${path}[${i}]`, errors)) return null;
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
    elements.push(desc.value);
  }

  return ok ? elements : null;
}

function detachPrimitive(value: unknown): unknown {
  if (typeof value === 'number') {
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    return value;
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
  if (allowed !== undefined) {
    for (const [key, val] of initialMap.entries()) {
      if (!allowed.has(key)) {
        const childPath = joinPath(path, key);
        errors.push({
          code: 'UNSUPPORTED_FIELD',
          path: childPath,
          message: `Unsupported field "${key}" on value expression "${op}".`,
        });
        if (val !== null && typeof val === 'object') {
          scanUnknownValueForReservedAndAccessors(val, childPath, depth + 1, budget, errors);
        }
      }
    }
  } else {
    const fallbackAllowed = new Set(['op', 'value', 'name', 'left', 'right']);
    for (const [key, val] of initialMap.entries()) {
      if (!fallbackAllowed.has(key)) {
        const childPath = joinPath(path, key);
        errors.push({
          code: 'UNSUPPORTED_FIELD',
          path: childPath,
          message: `Unsupported field "${key}" on value expression.`,
        });
        if (val !== null && typeof val === 'object') {
          scanUnknownValueForReservedAndAccessors(val, childPath, depth + 1, budget, errors);
        }
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
  if (allowed !== undefined) {
    for (const [key, val] of initialMap.entries()) {
      if (!allowed.has(key)) {
        const childPath = joinPath(path, key);
        errors.push({
          code: 'UNSUPPORTED_FIELD',
          path: childPath,
          message: `Unsupported field "${key}" on boolean expression "${op}".`,
        });
        if (val !== null && typeof val === 'object') {
          scanUnknownValueForReservedAndAccessors(val, childPath, depth + 1, budget, errors);
        }
      }
    }
  } else {
    const fallbackAllowed = new Set(['op', 'value', 'name', 'arg', 'args', 'left', 'right', 'expr', 'values']);
    for (const [key, val] of initialMap.entries()) {
      if (!fallbackAllowed.has(key)) {
        const childPath = joinPath(path, key);
        errors.push({
          code: 'UNSUPPORTED_FIELD',
          path: childPath,
          message: `Unsupported field "${key}" on boolean expression.`,
        });
        if (val !== null && typeof val === 'object') {
          scanUnknownValueForReservedAndAccessors(val, childPath, depth + 1, budget, errors);
        }
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
      const arr = inspectStrictPlainArray(rawArgs, `${path}.args`, depth + 1, budget, errors);
      if (arr !== null) {
        defineSafeDataProp(
          out,
          'args',
          arr.map((item, idx) =>
            buildDetachedBoolExpr(item, `${path}.args[${idx}]`, depth + 2, budget, errors),
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
      const arr = inspectStrictPlainArray(rawVals, `${path}.values`, depth + 1, budget, errors);
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

function buildDetachedModelSnapshot(
  candidate: unknown,
  errors: ValidationError[],
): unknown {
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

  // Schema
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

  // Initial State
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

  // Rules
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

  // Invariants
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

  // Goal (optional)
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

  // Assumptions
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

function readSafeOwnData(obj: unknown, key: string): { readonly ok: boolean; readonly value: unknown } {
  if (typeof obj !== 'object' || obj === null) return { ok: false, value: undefined };
  const desc = Object.getOwnPropertyDescriptor(obj, key);
  if (desc === undefined || isAccessorDescriptor(desc)) {
    return { ok: false, value: undefined };
  }
  return { ok: true, value: desc.value };
}

function readSafeArrayElements(raw: unknown): unknown[] {
  if (!Array.isArray(raw)) return [];
  const lenDesc = Object.getOwnPropertyDescriptor(raw, 'length');
  if (
    lenDesc === undefined ||
    isAccessorDescriptor(lenDesc) ||
    typeof lenDesc.value !== 'number' ||
    !Number.isSafeInteger(lenDesc.value) ||
    lenDesc.value < 0
  ) {
    return [];
  }
  const out: unknown[] = [];
  for (let i = 0; i < lenDesc.value; i += 1) {
    const desc = Object.getOwnPropertyDescriptor(raw, i);
    if (desc !== undefined && !isAccessorDescriptor(desc)) {
      out.push(desc.value);
    }
  }
  return out;
}

function cloneValueExprForExport(raw: unknown, depth: number): unknown {
  if (depth > MAX_IMPORT_DEPTH || typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const op = readSafeOwnData(raw, 'op').value;
  if (op === 'lit') {
    return { op: 'lit', value: detachPrimitive(readSafeOwnData(raw, 'value').value) };
  }
  if (op === 'var') {
    return { op: 'var', name: detachPrimitive(readSafeOwnData(raw, 'name').value) };
  }
  if (op === 'add' || op === 'sub') {
    return {
      op,
      left: cloneValueExprForExport(readSafeOwnData(raw, 'left').value, depth + 1),
      right: cloneValueExprForExport(readSafeOwnData(raw, 'right').value, depth + 1),
    };
  }
  return { op: detachPrimitive(op) };
}

function cloneBoolExprForExport(raw: unknown, depth: number): unknown {
  if (depth > MAX_IMPORT_DEPTH || typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const op = readSafeOwnData(raw, 'op').value;
  if (op === 'lit') {
    return { op: 'lit', value: detachPrimitive(readSafeOwnData(raw, 'value').value) };
  }
  if (op === 'var') {
    return { op: 'var', name: detachPrimitive(readSafeOwnData(raw, 'name').value) };
  }
  if (op === 'not') {
    return { op: 'not', arg: cloneBoolExprForExport(readSafeOwnData(raw, 'arg').value, depth + 1) };
  }
  if (op === 'and' || op === 'or') {
    return {
      op,
      args: readSafeArrayElements(readSafeOwnData(raw, 'args').value).map((arg) =>
        cloneBoolExprForExport(arg, depth + 1),
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
      left: cloneValueExprForExport(readSafeOwnData(raw, 'left').value, depth + 1),
      right: cloneValueExprForExport(readSafeOwnData(raw, 'right').value, depth + 1),
    };
  }
  if (op === 'in') {
    return {
      op: 'in',
      expr: cloneValueExprForExport(readSafeOwnData(raw, 'expr').value, depth + 1),
      values: readSafeArrayElements(readSafeOwnData(raw, 'values').value).map((v) =>
        detachPrimitive(v),
      ),
    };
  }
  return { op: detachPrimitive(op) };
}

function cloneCanonicalModelForExport(model: TransitionSystemModel): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  defineSafeDataProp(out, 'id', detachPrimitive(readSafeOwnData(model, 'id').value));
  defineSafeDataProp(out, 'name', detachPrimitive(readSafeOwnData(model, 'name').value));

  const rawSchema = readSafeOwnData(model, 'schema').value;
  const detachedSchema: Record<string, unknown> = {};
  const schemaVarNames: string[] = [];
  if (typeof rawSchema === 'object' && rawSchema !== null && !Array.isArray(rawSchema)) {
    for (const key of Reflect.ownKeys(rawSchema)) {
      if (typeof key !== 'string' || RESERVED_KEYS.has(key)) continue;
      const desc = Object.getOwnPropertyDescriptor(rawSchema, key);
      if (desc === undefined || isAccessorDescriptor(desc) || !desc.enumerable) continue;
      const def = desc.value;
      const kind = readSafeOwnData(def, 'kind').value;
      if (kind === 'boolean') {
        defineSafeDataProp(detachedSchema, key, { kind: 'boolean' });
        schemaVarNames.push(key);
      } else if (kind === 'enum') {
        defineSafeDataProp(detachedSchema, key, {
          kind: 'enum',
          values: readSafeArrayElements(readSafeOwnData(def, 'values').value).map((v) =>
            detachPrimitive(v),
          ),
        });
        schemaVarNames.push(key);
      } else if (kind === 'int') {
        defineSafeDataProp(detachedSchema, key, {
          kind: 'int',
          min: detachPrimitive(readSafeOwnData(def, 'min').value),
          max: detachPrimitive(readSafeOwnData(def, 'max').value),
        });
        schemaVarNames.push(key);
      }
    }
  }
  defineSafeDataProp(out, 'schema', detachedSchema);

  const rawInit = readSafeOwnData(model, 'initialState').value;
  const detachedInit: Record<string, unknown> = {};
  if (typeof rawInit === 'object' && rawInit !== null && !Array.isArray(rawInit)) {
    for (const key of schemaVarNames) {
      const prop = readSafeOwnData(rawInit, key);
      if (prop.ok) {
        defineSafeDataProp(detachedInit, key, detachPrimitive(prop.value));
      }
    }
  }
  defineSafeDataProp(out, 'initialState', detachedInit);

  const detachedRules = readSafeArrayElements(readSafeOwnData(model, 'rules').value).map((rule) => ({
    id: detachPrimitive(readSafeOwnData(rule, 'id').value),
    label: detachPrimitive(readSafeOwnData(rule, 'label').value),
    guard: cloneBoolExprForExport(readSafeOwnData(rule, 'guard').value, 0),
    updates: readSafeArrayElements(readSafeOwnData(rule, 'updates').value).map((upd) => ({
      var: detachPrimitive(readSafeOwnData(upd, 'var').value),
      value: cloneValueExprForExport(readSafeOwnData(upd, 'value').value, 0),
    })),
  }));
  defineSafeDataProp(out, 'rules', detachedRules);

  const detachedInvariants = readSafeArrayElements(readSafeOwnData(model, 'invariants').value).map(
    (inv) => ({
      id: detachPrimitive(readSafeOwnData(inv, 'id').value),
      label: detachPrimitive(readSafeOwnData(inv, 'label').value),
      holds: cloneBoolExprForExport(readSafeOwnData(inv, 'holds').value, 0),
    }),
  );
  defineSafeDataProp(out, 'invariants', detachedInvariants);

  const goalProp = readSafeOwnData(model, 'goal');
  if (goalProp.ok && goalProp.value !== undefined) {
    defineSafeDataProp(out, 'goal', {
      id: detachPrimitive(readSafeOwnData(goalProp.value, 'id').value),
      label: detachPrimitive(readSafeOwnData(goalProp.value, 'label').value),
      reached: cloneBoolExprForExport(readSafeOwnData(goalProp.value, 'reached').value, 0),
    });
  }

  const detachedAssumptions = readSafeArrayElements(
    readSafeOwnData(model, 'assumptions').value,
  ).map((asm) => ({
    id: detachPrimitive(readSafeOwnData(asm, 'id').value),
    category: detachPrimitive(readSafeOwnData(asm, 'category').value),
    statement: detachPrimitive(readSafeOwnData(asm, 'statement').value),
    notModeled: detachPrimitive(readSafeOwnData(asm, 'notModeled').value),
  }));
  defineSafeDataProp(out, 'assumptions', detachedAssumptions);

  return out;
}

export function exportModelToJson(model: TransitionSystemModel): string {
  const canonical = cloneCanonicalModelForExport(model);
  return JSON.stringify(canonical, null, 2);
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

export function indexModelDiagnostics(
  errors: readonly ValidationError[],
): ModelDiagnosticsIndex {
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
