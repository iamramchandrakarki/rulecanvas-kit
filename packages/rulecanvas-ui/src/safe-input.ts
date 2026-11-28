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
  UpdateAssignment,
  ValueExpr,
  VarDef,
} from '@rulecanvas/core';

export type OwnPropRead =
  | { readonly kind: 'missing' }
  | { readonly kind: 'accessor' }
  | { readonly kind: 'value'; readonly value: unknown };

export type SafeArrayRead =
  | { readonly ok: true; readonly items: readonly unknown[] }
  | { readonly ok: false };

export type SafeStringArrayRead =
  | { readonly ok: true; readonly items: readonly string[] }
  | { readonly ok: false };

export const MAX_REPLAY_STEPS = 10_000;
export const MAX_SAFE_ARRAY_LENGTH = 100_000;
const MAX_AST_CLONE_DEPTH = 64;
const MAX_STRICT_VALUE_DEPTH = 128;
const MAX_STRICT_VALUE_NODES = 2_500_000;
export const RESERVED_OBJECT_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function isAccessorDescriptor(desc: PropertyDescriptor): boolean {
  return (
    Object.hasOwn(desc, 'get') ||
    Object.hasOwn(desc, 'set') ||
    desc.get !== undefined ||
    desc.set !== undefined
  );
}

export function isCanonicalArrayIndex(key: string, length: number): boolean {
  if (key.length === 0) return false;
  if (key.length > 1 && key[0] === '0') return false;
  let value = 0;
  for (let i = 0; i < key.length; i += 1) {
    const code = key.charCodeAt(i);
    if (code < 48 || code > 57) return false;
    value = value * 10 + (code - 48);
    if (value >= length) return false;
  }
  return value >= 0 && value < length;
}

export function readOwnDataProp(obj: Record<string, unknown>, key: string): OwnPropRead {
  const desc = Object.getOwnPropertyDescriptor(obj, key);
  if (desc === undefined) {
    return { kind: 'missing' };
  }
  if ('get' in desc || 'set' in desc) {
    return { kind: 'accessor' };
  }
  return { kind: 'value', value: desc.value };
}

export function readSafeArray(value: unknown, maxLength = MAX_SAFE_ARRAY_LENGTH): SafeArrayRead {
  if (!Array.isArray(value)) {
    return { ok: false };
  }
  const lenDesc = Object.getOwnPropertyDescriptor(value, 'length');
  if (
    lenDesc === undefined ||
    'get' in lenDesc ||
    'set' in lenDesc ||
    typeof lenDesc.value !== 'number' ||
    !Number.isSafeInteger(lenDesc.value) ||
    lenDesc.value < 0 ||
    lenDesc.value > maxLength
  ) {
    return { ok: false };
  }

  const len = lenDesc.value;
  const items: unknown[] = [];
  for (let i = 0; i < len; i += 1) {
    const elemDesc = Object.getOwnPropertyDescriptor(value, i);
    if (elemDesc === undefined || 'get' in elemDesc || 'set' in elemDesc) {
      return { ok: false };
    }
    items.push(elemDesc.value);
  }
  return { ok: true, items };
}

export function readOwnStringArray(
  value: unknown,
  maxLength = MAX_SAFE_ARRAY_LENGTH,
): SafeStringArrayRead {
  const arr = readSafeArray(value, maxLength);
  if (!arr.ok) {
    return { ok: false };
  }
  const items: string[] = [];
  for (const entry of arr.items) {
    if (typeof entry !== 'string') {
      return { ok: false };
    }
    items.push(entry);
  }
  return { ok: true, items };
}

export function readStrictArray(value: unknown, maxLength = MAX_SAFE_ARRAY_LENGTH): SafeArrayRead {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    return { ok: false };
  }
  const lenDesc = Object.getOwnPropertyDescriptor(value, 'length');
  if (
    lenDesc === undefined ||
    isAccessorDescriptor(lenDesc) ||
    typeof lenDesc.value !== 'number' ||
    !Number.isSafeInteger(lenDesc.value) ||
    lenDesc.value < 0 ||
    lenDesc.value > maxLength
  ) {
    return { ok: false };
  }

  const len = lenDesc.value;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'symbol') {
      return { ok: false };
    }
    if (key === 'length') {
      continue;
    }
    if (RESERVED_OBJECT_KEYS.has(key) || !isCanonicalArrayIndex(key, len)) {
      return { ok: false };
    }
  }

  const items: unknown[] = [];
  for (let i = 0; i < len; i += 1) {
    const elemDesc = Object.getOwnPropertyDescriptor(value, i);
    if (elemDesc === undefined || isAccessorDescriptor(elemDesc) || !elemDesc.enumerable) {
      return { ok: false };
    }
    items.push(elemDesc.value);
  }
  return { ok: true, items };
}

export function readStrictStringArray(
  value: unknown,
  maxLength = MAX_SAFE_ARRAY_LENGTH,
): SafeStringArrayRead {
  const arr = readStrictArray(value, maxLength);
  if (!arr.ok) {
    return { ok: false };
  }
  const items: string[] = [];
  for (const entry of arr.items) {
    if (typeof entry !== 'string') {
      return { ok: false };
    }
    items.push(entry);
  }
  return { ok: true, items };
}

export function isStrictPlainResultValue(value: unknown): boolean {
  const budget = { visited: 0, maxNodes: MAX_STRICT_VALUE_NODES };
  const ancestors = new Set<object>();

  const check = (val: unknown, depth: number): boolean => {
    budget.visited += 1;
    if (depth > MAX_STRICT_VALUE_DEPTH || budget.visited > budget.maxNodes) {
      return false;
    }
    if (val === null || val === undefined || typeof val === 'boolean' || typeof val === 'string') {
      return true;
    }
    if (typeof val === 'number') {
      return Number.isFinite(val);
    }
    if (typeof val !== 'object') {
      return false;
    }
    if (ancestors.has(val)) {
      return false;
    }
    ancestors.add(val);
    try {
      if (Array.isArray(val)) {
        const arr = readStrictArray(val, MAX_STRICT_VALUE_NODES);
        if (!arr.ok) {
          return false;
        }
        for (const item of arr.items) {
          if (!check(item, depth + 1)) {
            return false;
          }
        }
        return true;
      }
      if (!isPlainObject(val)) {
        return false;
      }
      for (const key of Reflect.ownKeys(val)) {
        if (typeof key === 'symbol' || RESERVED_OBJECT_KEYS.has(key)) {
          return false;
        }
        const desc = Object.getOwnPropertyDescriptor(val, key);
        if (desc === undefined || isAccessorDescriptor(desc) || !desc.enumerable) {
          return false;
        }
        if (!check(desc.value, depth + 1)) {
          return false;
        }
      }
      return true;
    } finally {
      ancestors.delete(val);
    }
  };

  return check(value, 0);
}

export function isPrimitiveStateValue(value: unknown): value is StateValue {
  return (
    typeof value === 'boolean' ||
    typeof value === 'string' ||
    (typeof value === 'number' && Number.isSafeInteger(value))
  );
}

export function normalizeStateValue(value: StateValue): StateValue {
  if (typeof value === 'number' && Object.is(value, -0)) {
    return 0;
  }
  return value;
}

export function cloneAndFreezeSnapshot(raw: unknown): StateSnapshot | null {
  if (!isPlainObject(raw)) {
    return null;
  }

  const keys = Reflect.ownKeys(raw);
  const copy: StateSnapshot = {};
  for (const key of keys) {
    if (typeof key === 'symbol') {
      return null;
    }
    const desc = Object.getOwnPropertyDescriptor(raw, key);
    if (desc === undefined || 'get' in desc || 'set' in desc || !desc.enumerable) {
      return null;
    }
    if (!isPrimitiveStateValue(desc.value)) {
      return null;
    }
    Object.defineProperty(copy, key, {
      value: normalizeStateValue(desc.value),
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }

  return Object.freeze(copy);
}

export function snapshotsEqual(a: StateSnapshot, b: StateSnapshot): boolean {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) {
    return false;
  }
  for (const key of keysA) {
    if (!Object.hasOwn(b, key)) {
      return false;
    }
    const va = a[key];
    const vb = b[key];
    if (va === undefined || vb === undefined) {
      return false;
    }
    if (!Object.is(normalizeStateValue(va), normalizeStateValue(vb))) {
      return false;
    }
  }
  return true;
}

export function stringArraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

function readRequiredString(obj: Record<string, unknown>, key: string): string {
  const prop = readOwnDataProp(obj, key);
  if (prop.kind !== 'value' || typeof prop.value !== 'string') {
    throw new Error(`Expected string property "${key}" while cloning model.`);
  }
  return prop.value;
}

function cloneFreezeValueExpr(raw: unknown, astDepth: number): ValueExpr {
  if (astDepth > MAX_AST_CLONE_DEPTH || !isPlainObject(raw)) {
    throw new Error('Invalid ValueExpr encountered while cloning model.');
  }
  const op = readRequiredString(raw, 'op');
  switch (op) {
    case 'lit': {
      const valProp = readOwnDataProp(raw, 'value');
      if (valProp.kind !== 'value' || !isPrimitiveStateValue(valProp.value)) {
        throw new Error('Invalid ValueExpr literal while cloning model.');
      }
      return Object.freeze({ op: 'lit', value: normalizeStateValue(valProp.value) });
    }
    case 'var': {
      const name = readRequiredString(raw, 'name');
      return Object.freeze({ op: 'var', name });
    }
    case 'add':
    case 'sub': {
      const leftProp = readOwnDataProp(raw, 'left');
      const rightProp = readOwnDataProp(raw, 'right');
      if (leftProp.kind !== 'value' || rightProp.kind !== 'value') {
        throw new Error('Invalid ValueExpr binary operands while cloning model.');
      }
      return Object.freeze({
        op,
        left: cloneFreezeValueExpr(leftProp.value, astDepth + 1),
        right: cloneFreezeValueExpr(rightProp.value, astDepth + 1),
      });
    }
    default:
      throw new Error(`Unsupported ValueExpr op "${op}" while cloning model.`);
  }
}

function cloneFreezeBoolExpr(raw: unknown, astDepth: number): BoolExpr {
  if (astDepth > MAX_AST_CLONE_DEPTH || !isPlainObject(raw)) {
    throw new Error('Invalid BoolExpr encountered while cloning model.');
  }
  const op = readRequiredString(raw, 'op');
  switch (op) {
    case 'lit': {
      const valProp = readOwnDataProp(raw, 'value');
      if (valProp.kind !== 'value' || typeof valProp.value !== 'boolean') {
        throw new Error('Invalid BoolExpr literal while cloning model.');
      }
      return Object.freeze({ op: 'lit', value: valProp.value });
    }
    case 'var': {
      const name = readRequiredString(raw, 'name');
      return Object.freeze({ op: 'var', name });
    }
    case 'eq':
    case 'neq':
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte': {
      const leftProp = readOwnDataProp(raw, 'left');
      const rightProp = readOwnDataProp(raw, 'right');
      if (leftProp.kind !== 'value' || rightProp.kind !== 'value') {
        throw new Error('Invalid BoolExpr comparison operands while cloning model.');
      }
      return Object.freeze({
        op,
        left: cloneFreezeValueExpr(leftProp.value, astDepth + 1),
        right: cloneFreezeValueExpr(rightProp.value, astDepth + 1),
      });
    }
    case 'in': {
      const exprProp = readOwnDataProp(raw, 'expr');
      const valuesProp = readOwnDataProp(raw, 'values');
      if (exprProp.kind !== 'value' || valuesProp.kind !== 'value') {
        throw new Error('Invalid BoolExpr in-membership fields while cloning model.');
      }
      const valuesArr = readSafeArray(valuesProp.value, 256);
      if (!valuesArr.ok) {
        throw new Error('Invalid BoolExpr in-membership values array while cloning model.');
      }
      const frozenValues: StateValue[] = [];
      for (const item of valuesArr.items) {
        if (!isPrimitiveStateValue(item)) {
          throw new Error('Invalid BoolExpr in-membership element while cloning model.');
        }
        frozenValues.push(normalizeStateValue(item));
      }
      return Object.freeze({
        op: 'in',
        expr: cloneFreezeValueExpr(exprProp.value, astDepth + 1),
        values: Object.freeze(frozenValues),
      });
    }
    case 'not': {
      const argProp = readOwnDataProp(raw, 'arg');
      if (argProp.kind !== 'value') {
        throw new Error('Invalid BoolExpr not operand while cloning model.');
      }
      return Object.freeze({
        op: 'not',
        arg: cloneFreezeBoolExpr(argProp.value, astDepth + 1),
      });
    }
    case 'and':
    case 'or': {
      const argsProp = readOwnDataProp(raw, 'args');
      if (argsProp.kind !== 'value') {
        throw new Error('Invalid BoolExpr args property while cloning model.');
      }
      const argsArr = readSafeArray(argsProp.value, 256);
      if (!argsArr.ok) {
        throw new Error('Invalid BoolExpr args array while cloning model.');
      }
      const frozenArgs = Object.freeze(
        argsArr.items.map((item) => cloneFreezeBoolExpr(item, astDepth + 1)),
      );
      return Object.freeze({ op, args: frozenArgs });
    }
    default:
      throw new Error(`Unsupported BoolExpr op "${op}" while cloning model.`);
  }
}

function cloneFreezeVarDef(raw: unknown): VarDef {
  if (!isPlainObject(raw)) {
    throw new Error('Invalid VarDef while cloning model.');
  }
  const kind = readRequiredString(raw, 'kind');
  if (kind === 'boolean') {
    return Object.freeze({ kind: 'boolean' });
  }
  if (kind === 'enum') {
    const valuesProp = readOwnDataProp(raw, 'values');
    if (valuesProp.kind !== 'value') {
      throw new Error('Invalid enum values while cloning model.');
    }
    const valuesArr = readOwnStringArray(valuesProp.value, 256);
    if (!valuesArr.ok) {
      throw new Error('Invalid enum values array while cloning model.');
    }
    return Object.freeze({
      kind: 'enum',
      values: Object.freeze([...valuesArr.items]),
    });
  }
  if (kind === 'int') {
    const minProp = readOwnDataProp(raw, 'min');
    const maxProp = readOwnDataProp(raw, 'max');
    if (
      minProp.kind !== 'value' ||
      typeof minProp.value !== 'number' ||
      !Number.isSafeInteger(minProp.value) ||
      maxProp.kind !== 'value' ||
      typeof maxProp.value !== 'number' ||
      !Number.isSafeInteger(maxProp.value)
    ) {
      throw new Error('Invalid int bounds while cloning model.');
    }
    return Object.freeze({
      kind: 'int',
      min: Object.is(minProp.value, -0) ? 0 : minProp.value,
      max: Object.is(maxProp.value, -0) ? 0 : maxProp.value,
    });
  }
  throw new Error(`Unsupported VarDef kind "${kind}" while cloning model.`);
}

export function deepCloneAndFreezeModel(model: TransitionSystemModel): TransitionSystemModel {
  const raw: unknown = model;
  if (!isPlainObject(raw)) {
    throw new Error('Model must be a plain object while cloning.');
  }

  const id = readRequiredString(raw, 'id');
  const name = readRequiredString(raw, 'name');

  const schemaProp = readOwnDataProp(raw, 'schema');
  if (schemaProp.kind !== 'value' || !isPlainObject(schemaProp.value)) {
    throw new Error('Invalid schema while cloning model.');
  }
  const schemaOut: Record<string, VarDef> = {};
  for (const key of Reflect.ownKeys(schemaProp.value)) {
    if (typeof key === 'symbol') {
      throw new Error('Symbol key in schema while cloning model.');
    }
    const desc = Object.getOwnPropertyDescriptor(schemaProp.value, key);
    if (desc === undefined || 'get' in desc || 'set' in desc || !desc.enumerable) {
      throw new Error('Invalid schema property descriptor while cloning model.');
    }
    Object.defineProperty(schemaOut, key, {
      value: cloneFreezeVarDef(desc.value),
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  const frozenSchema: StateSchema = Object.freeze(schemaOut);

  const initialStateProp = readOwnDataProp(raw, 'initialState');
  if (initialStateProp.kind !== 'value') {
    throw new Error('Missing initialState while cloning model.');
  }
  const frozenInitialState = cloneAndFreezeSnapshot(initialStateProp.value);
  if (frozenInitialState === null) {
    throw new Error('Invalid initialState while cloning model.');
  }

  const rulesProp = readOwnDataProp(raw, 'rules');
  if (rulesProp.kind !== 'value') {
    throw new Error('Missing rules while cloning model.');
  }
  const rulesArr = readSafeArray(rulesProp.value, 256);
  if (!rulesArr.ok) {
    throw new Error('Invalid rules array while cloning model.');
  }
  const frozenRules: TransitionRule[] = rulesArr.items.map((rawRule) => {
    if (!isPlainObject(rawRule)) {
      throw new Error('Invalid rule object while cloning model.');
    }
    const ruleId = readRequiredString(rawRule, 'id');
    const ruleLabel = readRequiredString(rawRule, 'label');
    const guardProp = readOwnDataProp(rawRule, 'guard');
    const updatesProp = readOwnDataProp(rawRule, 'updates');
    if (guardProp.kind !== 'value' || updatesProp.kind !== 'value') {
      throw new Error('Invalid rule guard or updates while cloning model.');
    }
    const updatesArr = readSafeArray(updatesProp.value, 64);
    if (!updatesArr.ok) {
      throw new Error('Invalid updates array while cloning model.');
    }
    const frozenUpdates: UpdateAssignment[] = updatesArr.items.map((rawUpdate) => {
      if (!isPlainObject(rawUpdate)) {
        throw new Error('Invalid update object while cloning model.');
      }
      const targetVar = readRequiredString(rawUpdate, 'var');
      const valProp = readOwnDataProp(rawUpdate, 'value');
      if (valProp.kind !== 'value') {
        throw new Error('Invalid update value while cloning model.');
      }
      return Object.freeze({
        var: targetVar,
        value: cloneFreezeValueExpr(valProp.value, 0),
      });
    });
    return Object.freeze({
      id: ruleId,
      label: ruleLabel,
      guard: cloneFreezeBoolExpr(guardProp.value, 0),
      updates: Object.freeze(frozenUpdates),
    });
  });

  const invProp = readOwnDataProp(raw, 'invariants');
  if (invProp.kind !== 'value') {
    throw new Error('Missing invariants while cloning model.');
  }
  const invArr = readSafeArray(invProp.value, 64);
  if (!invArr.ok) {
    throw new Error('Invalid invariants array while cloning model.');
  }
  const frozenInvariants: Invariant[] = invArr.items.map((rawInv) => {
    if (!isPlainObject(rawInv)) {
      throw new Error('Invalid invariant object while cloning model.');
    }
    const invId = readRequiredString(rawInv, 'id');
    const invLabel = readRequiredString(rawInv, 'label');
    const holdsProp = readOwnDataProp(rawInv, 'holds');
    if (holdsProp.kind !== 'value') {
      throw new Error('Invalid invariant holds expression while cloning model.');
    }
    return Object.freeze({
      id: invId,
      label: invLabel,
      holds: cloneFreezeBoolExpr(holdsProp.value, 0),
    });
  });

  let frozenGoal: Goal | undefined;
  const goalProp = readOwnDataProp(raw, 'goal');
  if (goalProp.kind === 'accessor') {
    throw new Error('Invalid goal accessor while cloning model.');
  }
  if (goalProp.kind === 'value' && goalProp.value !== undefined) {
    if (!isPlainObject(goalProp.value)) {
      throw new Error('Invalid goal object while cloning model.');
    }
    const goalId = readRequiredString(goalProp.value, 'id');
    const goalLabel = readRequiredString(goalProp.value, 'label');
    const reachedProp = readOwnDataProp(goalProp.value, 'reached');
    if (reachedProp.kind !== 'value') {
      throw new Error('Invalid goal reached expression while cloning model.');
    }
    frozenGoal = Object.freeze({
      id: goalId,
      label: goalLabel,
      reached: cloneFreezeBoolExpr(reachedProp.value, 0),
    });
  }

  const assumpProp = readOwnDataProp(raw, 'assumptions');
  if (assumpProp.kind !== 'value') {
    throw new Error('Missing assumptions while cloning model.');
  }
  const assumpArr = readSafeArray(assumpProp.value, 64);
  if (!assumpArr.ok) {
    throw new Error('Invalid assumptions array while cloning model.');
  }
  const frozenAssumptions: ModelAssumption[] = assumpArr.items.map((rawAssump) => {
    if (!isPlainObject(rawAssump)) {
      throw new Error('Invalid assumption object while cloning model.');
    }
    return Object.freeze({
      id: readRequiredString(rawAssump, 'id'),
      category: readRequiredString(rawAssump, 'category'),
      statement: readRequiredString(rawAssump, 'statement'),
      notModeled: readRequiredString(rawAssump, 'notModeled'),
    });
  });

  return Object.freeze({
    id,
    name,
    schema: frozenSchema,
    initialState: frozenInitialState,
    rules: Object.freeze(frozenRules),
    invariants: Object.freeze(frozenInvariants),
    ...(frozenGoal !== undefined ? { goal: frozenGoal } : {}),
    assumptions: Object.freeze(frozenAssumptions),
  });
}
