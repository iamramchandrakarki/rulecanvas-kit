import type {
  BoolExpr,
  ModelAssumption,
  StateSchema,
  StateValue,
  TransitionRule,
  TransitionSystemModel,
  ValidationError,
  ValueExpr,
  VarDef,
} from '@rulecanvas/core';
import {
  getErrorsForPathPrefix,
  indexModelDiagnostics,
  parseStrictIntegerDraft,
  type DiagnosticSection,
  type ModelDiagnosticsIndex,
  type StrictIntegerParseResult,
} from '@rulecanvas/ui';
import {
  DEFAULT_MODEL_JSON_LIMITS,
  createModelJsonCodec,
  type ModelJsonDecodeResult,
  type ModelJsonEncodeResult,
} from '@rulecanvas/workbench/model-json';
import {
  bsl3AirlockFixedModel,
  bsl3AirlockVacuousModel,
} from './scenarios/bsl3-airlock.js';

export {
  getErrorsForPathPrefix,
  indexModelDiagnostics,
  parseStrictIntegerDraft,
  type DiagnosticSection,
  type ModelDiagnosticsIndex,
  type StrictIntegerParseResult,
};

export type JsonImportResult = ModelJsonDecodeResult;
export type JsonExportResult = ModelJsonEncodeResult;

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

const interlockStrictCodec = createModelJsonCodec(DEFAULT_MODEL_JSON_LIMITS);
const interlockLegacyImportCodec = createModelJsonCodec(DEFAULT_MODEL_JSON_LIMITS, {
  duplicateKeys: 'last-value',
});

const DRAFT_RESERVED_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

function isCanonicalArrayIndex(key: string, length: number): boolean {
  if (!/^(?:0|[1-9][0-9]*)$/.test(key)) return false;
  const idx = Number(key);
  return Number.isSafeInteger(idx) && idx >= 0 && idx < length;
}

function detachZeroInvariantDraftValue(
  raw: unknown,
  depth: number,
  budget: { visited: number },
  ancestors: Set<object>,
): unknown {
  budget.visited += 1;
  if (depth > DEFAULT_MODEL_JSON_LIMITS.maxDepth || budget.visited > DEFAULT_MODEL_JSON_LIMITS.maxVisits) {
    throw new TypeError('Draft exceeded structural export budget.');
  }
  if (raw === null || typeof raw === 'boolean' || typeof raw === 'string' || typeof raw === 'number') {
    return Object.is(raw, -0) ? 0 : raw;
  }
  if (typeof raw !== 'object') {
    throw new TypeError('Draft contains unsupported non-JSON value.');
  }
  if (ancestors.has(raw)) {
    throw new TypeError('Draft contains cyclic reference.');
  }
  ancestors.add(raw);
  try {
    if (Array.isArray(raw)) {
      for (const key of Reflect.ownKeys(raw)) {
        if (typeof key === 'symbol') {
          throw new TypeError('Draft array contains symbol property.');
        }
        if (key !== 'length' && !isCanonicalArrayIndex(key, raw.length)) {
          throw new TypeError('Draft array contains unsupported extra property.');
        }
      }
      const out: unknown[] = [];
      for (let i = 0; i < raw.length; i += 1) {
        const desc = Object.getOwnPropertyDescriptor(raw, i);
        if (desc === undefined || 'get' in desc || 'set' in desc || !desc.enumerable) {
          throw new TypeError('Draft array contains sparse, accessor, or non-enumerable slot.');
        }
        out.push(detachZeroInvariantDraftValue(desc.value, depth + 1, budget, ancestors));
      }
      return out;
    }
    const proto: unknown = Object.getPrototypeOf(raw);
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError('Draft contains non-plain object.');
    }
    const out: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(raw)) {
      if (typeof key === 'symbol') {
        throw new TypeError('Draft object contains symbol property.');
      }
      if (DRAFT_RESERVED_KEYS.has(key)) {
        throw new TypeError('Draft object contains reserved property key.');
      }
      const desc = Object.getOwnPropertyDescriptor(raw, key);
      if (desc === undefined || 'get' in desc || 'set' in desc || !desc.enumerable) {
        throw new TypeError('Draft object contains accessor or non-enumerable property.');
      }
      Object.defineProperty(out, key, {
        value: detachZeroInvariantDraftValue(desc.value, depth + 1, budget, ancestors),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  } finally {
    ancestors.delete(raw);
  }
}

export function exportModelToJson(model: TransitionSystemModel): string {
  const res = interlockStrictCodec.encode(model);
  if (res.ok) {
    return res.text;
  }
  // Preserve baseline draft-export capability ONLY for clean 0-invariant drafts
  if (model !== null && typeof model === 'object' && !Array.isArray(model)) {
    const invDesc = Object.getOwnPropertyDescriptor(model, 'invariants');
    if (
      invDesc !== undefined &&
      !('get' in invDesc) &&
      !('set' in invDesc) &&
      invDesc.enumerable === true &&
      Array.isArray(invDesc.value) &&
      invDesc.value.length === 0
    ) {
      const detached = detachZeroInvariantDraftValue(
        model,
        0,
        { visited: 0 },
        new Set<object>(),
      );
      const check = interlockStrictCodec.validateValue(detached);
      if (
        !check.ok &&
        check.errors.length === 1 &&
        check.errors[0]!.code === 'INVALID_INVARIANTS_COUNT' &&
        check.errors[0]!.path === 'invariants'
      ) {
        const pretty = JSON.stringify(detached, null, 2);
        const candidate =
          pretty.length <= DEFAULT_MODEL_JSON_LIMITS.maxChars ? pretty : JSON.stringify(detached);
        if (typeof candidate === 'string' && candidate.length <= DEFAULT_MODEL_JSON_LIMITS.maxChars) {
          const rtCheck = interlockStrictCodec.decode(candidate);
          if (
            !rtCheck.ok &&
            rtCheck.errors.length === 1 &&
            rtCheck.errors[0]!.code === 'INVALID_INVARIANTS_COUNT' &&
            rtCheck.errors[0]!.path === 'invariants'
          ) {
            return candidate;
          }
        }
      }
    }
  }
  throw new TypeError(res.error.message);
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

export function validateImportedModelValue(candidate: unknown): JsonImportResult {
  return interlockLegacyImportCodec.validateValue(candidate);
}

export function importModelFromJson(rawText: unknown): JsonImportResult {
  if (typeof rawText !== 'string' && rawText !== null && typeof rawText === 'object') {
    return interlockLegacyImportCodec.validateValue(rawText);
  }
  return interlockLegacyImportCodec.decode(rawText);
}
