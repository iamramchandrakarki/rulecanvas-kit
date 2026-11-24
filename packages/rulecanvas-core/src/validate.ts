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
  ValidationError,
  ValueExpr,
  VarDef,
  VerifyOptions,
} from './types.js';

const MAX_SCHEMA_VARS = 64;
const MAX_ENUM_VALUES = 256;
const MAX_ENUM_LENGTH = 128;
const MAX_INT_SPAN = 1_000_000n;
const MAX_RULES = 256;
const MAX_UPDATES_PER_RULE = 64;
const MAX_INVARIANTS = 64;
const MAX_ASSUMPTIONS = 64;
const MAX_AST_DEPTH = 32;
const MAX_AST_VISITS = 256;
const MAX_BOOL_ARGS = 64;
const MAX_IN_VALUES = 256;
const MAX_STATES_LIMIT = 100_000;
const MAX_DEPTH_LIMIT = 10_000;

const RESERVED_VAR_NAMES = new Set<string>();
RESERVED_VAR_NAMES.add('__proto__');
RESERVED_VAR_NAMES.add('constructor');
RESERVED_VAR_NAMES.add('prototype');

export function createUnexpectedInputError(path = ''): ValidationError {
  return Object.freeze({
    code: 'UNEXPECTED_INPUT_ERROR',
    path,
    message: 'Failed to inspect input due to an unexpected object trap or exotic runtime error.',
  });
}

type ScalarKind = 'boolean' | 'enum' | 'int';

type SchemaVarInfo =
  | { readonly kind: 'boolean' }
  | { readonly kind: 'enum'; readonly valueSet: ReadonlySet<string> }
  | { readonly kind: 'int'; readonly min: number; readonly max: number };

interface ParsedSchemaResult {
  readonly schema: StateSchema;
  readonly varNames: readonly string[];
  readonly schemaMap: ReadonlyMap<string, SchemaVarInfo>;
}

interface AstBudget {
  visits: number;
  exceeded: boolean;
}

interface ValueExprParseResult {
  readonly kind: ScalarKind | null;
  readonly expr: ValueExpr | null;
  readonly enumVarName?: string;
  readonly litString?: string;
}

type ReadPropertyResult =
  | { readonly ok: true; readonly present: boolean; readonly value: unknown }
  | { readonly ok: false };

interface PlainArrayInfo {
  readonly arr: readonly unknown[];
  readonly length: number;
}

export type ParseModelResult =
  | { readonly ok: true; readonly model: TransitionSystemModel }
  | { readonly ok: false; readonly errors: readonly ValidationError[] };

export type ParseOptionsResult =
  | { readonly ok: true; readonly options: VerifyOptions }
  | { readonly ok: false; readonly errors: readonly ValidationError[] };

export type ParseStateSnapshotResult =
  | { readonly ok: true; readonly state: StateSnapshot }
  | { readonly ok: false; readonly errors: readonly ValidationError[] };

export interface MalformedRuleIdEntry {
  readonly stepIndex: number;
  readonly error: ValidationError;
  readonly errors: readonly ValidationError[];
}

export type ParseRuleIdsResult =
  | {
      readonly ok: true;
      readonly ruleIds: readonly string[];
      readonly malformedEntry?: MalformedRuleIdEntry;
    }
  | { readonly ok: false; readonly stepIndex: number; readonly errors: readonly ValidationError[] };

function isAccessorDescriptor(desc: PropertyDescriptor): boolean {
  return Object.hasOwn(desc, 'get') || Object.hasOwn(desc, 'set');
}

function defineDataProperty<T extends object>(obj: T, key: string, value: unknown): void {
  const desc = Object.create(null) as PropertyDescriptor;
  desc.value = value;
  desc.enumerable = true;
  desc.writable = true;
  desc.configurable = true;
  Object.defineProperty(obj, key, desc);
}

function inspectOwnKeysSnapshot(
  target: object,
  path: string,
  kindLabel: 'Plain object' | 'Array',
  errors: ValidationError[],
  outOwnNames: string[],
): boolean {
  const ownKeys = Reflect.ownKeys(target);
  let hasSymbol = false;
  for (let i = 0; i < ownKeys.length; i += 1) {
    const key = ownKeys[i]!;
    if (typeof key === 'symbol') {
      if (!hasSymbol) {
        addError(errors, 'INVALID_SYMBOL_PROPERTY', path, `${kindLabel} must not define own symbol properties.`);
        hasSymbol = true;
      }
      const symDesc = Object.getOwnPropertyDescriptor(target, key);
      if (symDesc !== undefined && isAccessorDescriptor(symDesc)) {
        const symLabel = Symbol.prototype.toString.call(key);
        addError(
          errors,
          'INVALID_ACCESSOR_PROPERTY',
          path ? `${path}.${symLabel}` : symLabel,
          `Property "${symLabel}" must be a plain data property, not an accessor.`,
        );
      }
    } else {
      outOwnNames.push(key);
    }
  }
  return !hasSymbol;
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeInt(n: number): number {
  return Object.is(n, -0) ? 0 : n;
}

function addError(errors: ValidationError[], code: string, path: string, message: string): void {
  errors.push(Object.freeze({ code, path, message }));
}

function formatUnknownForMessage(val: unknown): string {
  if (val === null) return 'null';
  if (val === undefined) return 'undefined';
  if (typeof val === 'string') return val;
  if (typeof val === 'boolean') return val ? 'true' : 'false';
  if (typeof val === 'number') return Object.is(val, -0) ? '0' : Number.prototype.toString.call(val);
  if (typeof val === 'bigint') return BigInt.prototype.toString.call(val);
  if (typeof val === 'symbol') return '[symbol]';
  if (typeof val === 'function') return '[function]';
  return Array.isArray(val) ? '[array]' : '[object]';
}

function expectPlainObject(
  value: unknown,
  path: string,
  invalidCode: string,
  invalidMessage: string,
  errors: ValidationError[],
  outOwnNames: string[],
): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    addError(errors, invalidCode, path, invalidMessage);
    return null;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    addError(errors, invalidCode, path, invalidMessage);
    return null;
  }
  if (!inspectOwnKeysSnapshot(value, path, 'Plain object', errors, outOwnNames)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readOwnDataProperty(
  obj: object,
  key: string,
  path: string,
  errors: ValidationError[],
  readKeys?: Set<string>,
): ReadPropertyResult {
  readKeys?.add(key);
  const desc = Object.getOwnPropertyDescriptor(obj, key);
  if (desc === undefined) {
    return { ok: true, present: false, value: undefined };
  }
  if (isAccessorDescriptor(desc)) {
    addError(
      errors,
      'INVALID_ACCESSOR_PROPERTY',
      path,
      `Property "${key}" must be a plain data property, not an accessor.`,
    );
    return { ok: false };
  }
  return { ok: true, present: true, value: desc.value };
}

function checkExtraOwnAccessors(
  obj: object,
  ownNames: readonly string[],
  basePath: string,
  readKeys: ReadonlySet<string>,
  errors: ValidationError[],
): boolean {
  let ok = true;
  for (let i = 0; i < ownNames.length; i += 1) {
    const key = ownNames[i]!;
    if (readKeys.has(key)) continue;
    const desc = Object.getOwnPropertyDescriptor(obj, key);
    if (desc !== undefined && isAccessorDescriptor(desc)) {
      addError(
        errors,
        'INVALID_ACCESSOR_PROPERTY',
        basePath ? `${basePath}.${key}` : key,
        `Property "${key}" must be a plain data property, not an accessor.`,
      );
      ok = false;
    }
  }
  return ok;
}

function isCanonicalArrayIndexInRange(key: string, length: number): boolean {
  if (key.length === 0) return false;
  if (key.length > 1 && key.charCodeAt(0) === 48) return false;
  let n = 0;
  for (let i = 0; i < key.length; i += 1) {
    const code = key.charCodeAt(i);
    if (code < 48 || code > 57) return false;
    n = n * 10 + (code - 48);
    if (n >= length) return false;
  }
  return n >= 0 && n < length;
}

function expectPlainArray(
  value: unknown,
  path: string,
  invalidCode: string,
  invalidMessage: string,
  errors: ValidationError[],
): PlainArrayInfo | null {
  if (!Array.isArray(value)) {
    addError(errors, invalidCode, path, invalidMessage);
    return null;
  }
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    addError(errors, invalidCode, path, invalidMessage);
    return null;
  }
  const ownNames: string[] = [];
  if (!inspectOwnKeysSnapshot(value, path, 'Array', errors, ownNames)) {
    return null;
  }
  const lenProp = readOwnDataProperty(value, 'length', `${path}.length`, errors);
  if (!lenProp.ok) return null;
  const length = lenProp.value;
  if (!lenProp.present || typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) {
    addError(errors, invalidCode, path, invalidMessage);
    return null;
  }
  let hasExtraAccessor = false;
  for (let i = 0; i < ownNames.length; i += 1) {
    const key = ownNames[i]!;
    if (key === 'length' || isCanonicalArrayIndexInRange(key, length)) continue;
    const desc = Object.getOwnPropertyDescriptor(value, key);
    if (desc !== undefined && isAccessorDescriptor(desc)) {
      addError(
        errors,
        'INVALID_ACCESSOR_PROPERTY',
        `${path}.${key}`,
        `Property "${key}" must be a plain data property, not an accessor.`,
      );
      hasExtraAccessor = true;
    }
  }
  if (hasExtraAccessor) return null;
  return { arr: value, length };
}

function readOwnArrayElement(
  arr: readonly unknown[],
  index: number,
  path: string,
  errors: ValidationError[],
): ReadPropertyResult {
  const desc = Object.getOwnPropertyDescriptor(arr, index);
  if (desc === undefined) {
    addError(
      errors,
      'INVALID_SPARSE_ARRAY',
      path,
      `Array must be dense; missing element at index ${index}.`,
    );
    return { ok: false };
  }
  if (isAccessorDescriptor(desc)) {
    addError(
      errors,
      'INVALID_ACCESSOR_PROPERTY',
      path,
      `Array element at index ${index} must be a plain data property, not an accessor.`,
    );
    return { ok: false };
  }
  return { ok: true, present: true, value: desc.value };
}

function parseUniqueId(
  rawId: unknown,
  seen: Set<string>,
  entity: string,
  codeSuffix: string,
  path: string,
  errors: ValidationError[],
): string | null {
  if (!isNonBlankString(rawId)) {
    addError(errors, `INVALID_${codeSuffix}_ID`, path, `${entity} id must be a non-blank string.`);
    return null;
  }
  if (seen.has(rawId)) {
    addError(errors, `DUPLICATE_${codeSuffix}_ID`, path, `Duplicate ${entity.toLowerCase()} id "${rawId}".`);
    return null;
  }
  seen.add(rawId);
  return rawId;
}

function enterAstNode(depth: number, budget: AstBudget, path: string, errors: ValidationError[]): boolean {
  if (budget.exceeded) return false;
  budget.visits += 1;
  if (depth > MAX_AST_DEPTH || budget.visits > MAX_AST_VISITS) {
    budget.exceeded = true;
    addError(
      errors,
      'AST_COMPLEXITY_EXCEEDED',
      path,
      `Expression exceeds max AST depth (${MAX_AST_DEPTH}) or visit budget (${MAX_AST_VISITS}).`,
    );
    return false;
  }
  return true;
}

function parseSchema(rawSchema: unknown, errors: ValidationError[]): ParsedSchemaResult | null {
  const ownNames: string[] = [];
  const obj = expectPlainObject(rawSchema, 'schema', 'INVALID_SCHEMA', 'Schema must be a plain object.', errors, ownNames);
  if (obj === null) return null;

  const ownEntries: Array<{ readonly key: string; readonly desc: PropertyDescriptor }> = [];
  for (let i = 0; i < ownNames.length; i += 1) {
    const key = ownNames[i]!;
    const desc = Object.getOwnPropertyDescriptor(obj, key);
    if (desc !== undefined) {
      ownEntries.push({ key, desc });
    }
  }

  if (ownEntries.length < 1) {
    addError(errors, 'SCHEMA_EMPTY', 'schema', 'Schema must declare at least 1 variable.');
    return null;
  }
  if (ownEntries.length > MAX_SCHEMA_VARS) {
    addError(
      errors,
      'SCHEMA_TOO_LARGE',
      'schema',
      `Schema declares ${ownEntries.length} variables; maximum is ${MAX_SCHEMA_VARS}.`,
    );
    return null;
  }

  const parsedSchema: Record<string, VarDef> = {};
  const varNames: string[] = [];
  const schemaMap = new Map<string, SchemaVarInfo>();

  for (let k = 0; k < ownEntries.length; k += 1) {
    const { key: varName, desc } = ownEntries[k]!;
    const varPath = `schema.${varName}`;
    if (isAccessorDescriptor(desc)) {
      addError(
        errors,
        'INVALID_ACCESSOR_PROPERTY',
        varPath,
        `Property "${varName}" must be a plain data property, not an accessor.`,
      );
      continue;
    }
    if (!desc.enumerable) {
      addError(errors, 'INVALID_SCHEMA', varPath, `Schema property "${varName}" must be enumerable.`);
      continue;
    }
    if (!isNonBlankString(varName)) {
      addError(errors, 'INVALID_VAR_NAME', varPath, 'Variable name must be a non-blank string.');
      continue;
    }
    if (RESERVED_VAR_NAMES.has(varName)) {
      addError(errors, 'RESERVED_VAR_NAME', varPath, `Variable name "${varName}" is reserved.`);
      continue;
    }

    const defOwnNames: string[] = [];
    const rawDef = expectPlainObject(
      desc.value,
      varPath,
      'INVALID_VAR_DEF',
      'Variable definition must be a plain object.',
      errors,
      defOwnNames,
    );
    if (rawDef === null) continue;

    const defReadKeys = new Set<string>();
    const kindProp = readOwnDataProperty(rawDef, 'kind', `${varPath}.kind`, errors, defReadKeys);
    if (!kindProp.ok) {
      checkExtraOwnAccessors(rawDef, defOwnNames, varPath, defReadKeys, errors);
      continue;
    }
    const kind = kindProp.value;
    if (kind === 'boolean') {
      if (!checkExtraOwnAccessors(rawDef, defOwnNames, varPath, defReadKeys, errors)) continue;
      const def: VarDef = { kind: 'boolean' };
      defineDataProperty(parsedSchema, varName, def);
      varNames.push(varName);
      schemaMap.set(varName, { kind: 'boolean' });
    } else if (kind === 'enum') {
      const rawValuesProp = readOwnDataProperty(rawDef, 'values', `${varPath}.values`, errors, defReadKeys);
      const extraDefOk = checkExtraOwnAccessors(rawDef, defOwnNames, varPath, defReadKeys, errors);
      if (!rawValuesProp.ok) continue;
      const valuesArr = expectPlainArray(
        rawValuesProp.value,
        `${varPath}.values`,
        'INVALID_ENUM_VALUES',
        `Enum must declare 1..${MAX_ENUM_VALUES} values.`,
        errors,
      );
      if (valuesArr === null) continue;
      if (valuesArr.length < 1 || valuesArr.length > MAX_ENUM_VALUES) {
        addError(
          errors,
          'INVALID_ENUM_VALUES',
          `${varPath}.values`,
          `Enum must declare 1..${MAX_ENUM_VALUES} values.`,
        );
        continue;
      }
      const valueSet = new Set<string>();
      const parsedValues: string[] = [];
      let validEnum = true;
      for (let i = 0; i < valuesArr.length; i += 1) {
        const entryProp = readOwnArrayElement(valuesArr.arr, i, `${varPath}.values[${i}]`, errors);
        if (!entryProp.ok) {
          validEnum = false;
          continue;
        }
        const entry = entryProp.value;
        if (typeof entry !== 'string' || entry.length === 0 || entry.length > MAX_ENUM_LENGTH) {
          addError(
            errors,
            'INVALID_ENUM_VALUE',
            `${varPath}.values[${i}]`,
            `Enum value must be 1..${MAX_ENUM_LENGTH} chars.`,
          );
          validEnum = false;
        } else if (valueSet.has(entry)) {
          addError(errors, 'DUPLICATE_ENUM_VALUE', `${varPath}.values[${i}]`, `Duplicate enum value "${entry}".`);
          validEnum = false;
        } else {
          valueSet.add(entry);
          parsedValues.push(entry);
        }
      }
      if (validEnum && extraDefOk) {
        const def: VarDef = { kind: 'enum', values: parsedValues };
        defineDataProperty(parsedSchema, varName, def);
        varNames.push(varName);
        schemaMap.set(varName, { kind: 'enum', valueSet });
      }
    } else if (kind === 'int') {
      const minProp = readOwnDataProperty(rawDef, 'min', `${varPath}.min`, errors, defReadKeys);
      const maxProp = readOwnDataProperty(rawDef, 'max', `${varPath}.max`, errors, defReadKeys);
      const extraDefOk = checkExtraOwnAccessors(rawDef, defOwnNames, varPath, defReadKeys, errors);
      if (!minProp.ok || !maxProp.ok) continue;
      const min = minProp.value;
      const max = maxProp.value;
      if (
        typeof min !== 'number' ||
        typeof max !== 'number' ||
        !Number.isSafeInteger(min) ||
        !Number.isSafeInteger(max)
      ) {
        addError(errors, 'INVALID_INT_BOUNDS', varPath, 'Integer bounds min and max must be safe integers.');
      } else if (min > max) {
        addError(errors, 'INVALID_INT_BOUNDS', varPath, `Integer min (${min}) must be <= max (${max}).`);
      } else if (BigInt(normalizeInt(max)) - BigInt(normalizeInt(min)) > MAX_INT_SPAN) {
        addError(errors, 'INT_SPAN_TOO_LARGE', varPath, `Integer span exceeds ${MAX_INT_SPAN.toString()}.`);
      } else if (extraDefOk) {
        const normMin = normalizeInt(min);
        const normMax = normalizeInt(max);
        const def: VarDef = { kind: 'int', min: normMin, max: normMax };
        defineDataProperty(parsedSchema, varName, def);
        varNames.push(varName);
        schemaMap.set(varName, { kind: 'int', min: normMin, max: normMax });
      }
    } else {
      checkExtraOwnAccessors(rawDef, defOwnNames, varPath, defReadKeys, errors);
      addError(errors, 'INVALID_VAR_DEF', `${varPath}.kind`, 'Variable kind must be "boolean", "enum", or "int".');
    }
  }
  return { schema: parsedSchema, varNames, schemaMap };
}

function parseStateMap(
  varNames: readonly string[],
  schemaMap: ReadonlyMap<string, SchemaVarInfo>,
  rawState: unknown,
  basePath: string,
  errors: ValidationError[],
): StateSnapshot | null {
  const ownNames: string[] = [];
  const obj = expectPlainObject(rawState, basePath, 'INVALID_STATE', 'State snapshot must be a plain object.', errors, ownNames);
  if (obj === null) return null;

  const descByKey = new Map<string, PropertyDescriptor>();
  let valid = true;

  for (let i = 0; i < ownNames.length; i += 1) {
    const key = ownNames[i]!;
    const desc = Object.getOwnPropertyDescriptor(obj, key);
    if (desc === undefined) continue;
    descByKey.set(key, desc);
    if (!schemaMap.has(key)) {
      if (isAccessorDescriptor(desc)) {
        addError(
          errors,
          'INVALID_ACCESSOR_PROPERTY',
          `${basePath}.${key}`,
          `Property "${key}" must be a plain data property, not an accessor.`,
        );
      }
      addError(errors, 'UNKNOWN_STATE_VAR', `${basePath}.${key}`, `State contains undeclared variable "${key}".`);
      valid = false;
    }
  }

  const parsedState: StateSnapshot = {};
  for (let i = 0; i < varNames.length; i += 1) {
    const varName = varNames[i]!;
    const info = schemaMap.get(varName)!;
    const valuePath = `${basePath}.${varName}`;
    const desc = descByKey.get(varName);
    if (desc === undefined) {
      addError(errors, 'MISSING_STATE_VAR', valuePath, `State is missing required variable "${varName}".`);
      valid = false;
      continue;
    }
    if (isAccessorDescriptor(desc)) {
      addError(
        errors,
        'INVALID_ACCESSOR_PROPERTY',
        valuePath,
        `Property "${varName}" must be a plain data property, not an accessor.`,
      );
      valid = false;
      continue;
    }
    if (!desc.enumerable) {
      addError(
        errors,
        'INVALID_STATE_VALUE',
        valuePath,
        `State variable "${varName}" must be an enumerable own data property.`,
      );
      valid = false;
      continue;
    }
    const val = desc.value;
    if (info.kind === 'boolean') {
      if (typeof val !== 'boolean') {
        addError(errors, 'INVALID_STATE_VALUE', valuePath, `Expected boolean for "${varName}".`);
        valid = false;
      } else {
        defineDataProperty(parsedState, varName, val);
      }
    } else if (info.kind === 'enum') {
      if (typeof val !== 'string' || !info.valueSet.has(val)) {
        addError(errors, 'INVALID_STATE_VALUE', valuePath, `Value for enum "${varName}" is outside its domain.`);
        valid = false;
      } else {
        defineDataProperty(parsedState, varName, val);
      }
    } else if (typeof val !== 'number' || !Number.isSafeInteger(val) || val < info.min || val > info.max) {
      addError(
        errors,
        'INVALID_STATE_VALUE',
        valuePath,
        `Expected safe integer in [${info.min}, ${info.max}] for "${varName}".`,
      );
      valid = false;
    } else {
      defineDataProperty(parsedState, varName, normalizeInt(val));
    }
  }

  return valid ? parsedState : null;
}

export function parseStateSnapshot(
  schema: StateSchema,
  raw: unknown,
  basePath = 'state',
): ParseStateSnapshotResult {
  try {
    const errors: ValidationError[] = [];
    const varNames: string[] = [];
    const schemaMap = new Map<string, SchemaVarInfo>();
    const ownNames = Object.getOwnPropertyNames(schema);
    for (let i = 0; i < ownNames.length; i += 1) {
      const varName = ownNames[i]!;
      const desc = Object.getOwnPropertyDescriptor(schema, varName);
      if (desc === undefined || !desc.enumerable || !('value' in desc)) continue;
      const def = desc.value as VarDef | undefined;
      if (def === undefined) continue;
      varNames.push(varName);
      if (def.kind === 'boolean') {
        schemaMap.set(varName, { kind: 'boolean' });
      } else if (def.kind === 'enum') {
        const valueSet = new Set<string>();
        for (let j = 0; j < def.values.length; j += 1) {
          valueSet.add(def.values[j]!);
        }
        schemaMap.set(varName, { kind: 'enum', valueSet });
      } else {
        schemaMap.set(varName, { kind: 'int', min: def.min, max: def.max });
      }
    }
    const parsedState = parseStateMap(varNames, schemaMap, raw, basePath, errors);
    if (errors.length > 0 || parsedState === null) {
      return { ok: false, errors: Object.freeze(errors) };
    }
    return { ok: true, state: parsedState };
  } catch {
    return { ok: false, errors: Object.freeze([createUnexpectedInputError()]) };
  }
}

export function validateStateSnapshot(
  schema: StateSchema,
  state: unknown,
  basePath = 'state',
): readonly ValidationError[] {
  const parsed = parseStateSnapshot(schema, state, basePath);
  return parsed.ok ? Object.freeze([]) : parsed.errors;
}

function parseBinaryIntOperands(
  expr: Record<string, unknown>,
  op: string,
  schemaMap: ReadonlyMap<string, SchemaVarInfo>,
  depth: number,
  budget: AstBudget,
  path: string,
  errors: ValidationError[],
  readKeys: Set<string>,
): { readonly left: ValueExpr; readonly right: ValueExpr } | null {
  const leftProp = readOwnDataProperty(expr, 'left', `${path}.left`, errors, readKeys);
  const rightProp = readOwnDataProperty(expr, 'right', `${path}.right`, errors, readKeys);
  const left: ValueExprParseResult = leftProp.ok
    ? parseValueExpr(leftProp.value, schemaMap, depth + 1, budget, `${path}.left`, errors)
    : { kind: null, expr: null };
  const right: ValueExprParseResult = rightProp.ok
    ? parseValueExpr(rightProp.value, schemaMap, depth + 1, budget, `${path}.right`, errors)
    : { kind: null, expr: null };
  if (left.kind !== null && left.kind !== 'int') {
    addError(errors, 'TYPE_MISMATCH', `${path}.left`, `Operator "${op}" requires integer operands; got "${left.kind}".`);
  }
  if (right.kind !== null && right.kind !== 'int') {
    addError(errors, 'TYPE_MISMATCH', `${path}.right`, `Operator "${op}" requires integer operands; got "${right.kind}".`);
  }
  if (left.kind === 'int' && right.kind === 'int' && left.expr !== null && right.expr !== null) {
    return { left: left.expr, right: right.expr };
  }
  return null;
}

function parseValueExpr(
  expr: unknown,
  schemaMap: ReadonlyMap<string, SchemaVarInfo>,
  depth: number,
  budget: AstBudget,
  path: string,
  errors: ValidationError[],
): ValueExprParseResult {
  if (!enterAstNode(depth, budget, path, errors)) return { kind: null, expr: null };
  const ownNames: string[] = [];
  const obj = expectPlainObject(expr, path, 'INVALID_VALUE_EXPR', 'Value expression must be a plain object.', errors, ownNames);
  if (obj === null) return { kind: null, expr: null };

  const readKeys = new Set<string>();
  const opProp = readOwnDataProperty(obj, 'op', `${path}.op`, errors, readKeys);
  if (!opProp.ok) {
    checkExtraOwnAccessors(obj, ownNames, path, readKeys, errors);
    return { kind: null, expr: null };
  }
  const op = opProp.value;
  if (op === 'lit') {
    const valProp = readOwnDataProperty(obj, 'value', `${path}.value`, errors, readKeys);
    const extraOk = checkExtraOwnAccessors(obj, ownNames, path, readKeys, errors);
    if (!valProp.ok) return { kind: null, expr: null };
    const val = valProp.value;
    if (typeof val === 'boolean') return extraOk ? { kind: 'boolean', expr: { op: 'lit', value: val } } : { kind: null, expr: null };
    if (typeof val === 'string') return extraOk ? { kind: 'enum', litString: val, expr: { op: 'lit', value: val } } : { kind: null, expr: null };
    if (typeof val === 'number' && Number.isSafeInteger(val)) {
      return extraOk ? { kind: 'int', expr: { op: 'lit', value: normalizeInt(val) } } : { kind: null, expr: null };
    }
    addError(errors, 'INVALID_LITERAL', `${path}.value`, 'Literal must be a boolean, string, or safe integer.');
    return { kind: null, expr: null };
  }
  if (op === 'var') {
    const nameProp = readOwnDataProperty(obj, 'name', `${path}.name`, errors, readKeys);
    const extraOk = checkExtraOwnAccessors(obj, ownNames, path, readKeys, errors);
    if (!nameProp.ok) return { kind: null, expr: null };
    const name = nameProp.value;
    if (typeof name !== 'string' || !schemaMap.has(name)) {
      addError(errors, 'UNKNOWN_VAR', `${path}.name`, `Unknown variable "${formatUnknownForMessage(name)}".`);
      return { kind: null, expr: null };
    }
    if (!extraOk) return { kind: null, expr: null };
    const info = schemaMap.get(name)!;
    const parsed: ValueExpr = { op: 'var', name };
    return info.kind === 'enum'
      ? { kind: 'enum', enumVarName: name, expr: parsed }
      : { kind: info.kind, expr: parsed };
  }
  if (op === 'add' || op === 'sub') {
    const operands = parseBinaryIntOperands(obj, op, schemaMap, depth, budget, path, errors, readKeys);
    const extraOk = checkExtraOwnAccessors(obj, ownNames, path, readKeys, errors);
    if (operands === null || !extraOk) return { kind: null, expr: null };
    return { kind: 'int', expr: { op, left: operands.left, right: operands.right } };
  }

  checkExtraOwnAccessors(obj, ownNames, path, readKeys, errors);
  addError(errors, 'INVALID_EXPR_OP', `${path}.op`, `Unsupported value operator "${formatUnknownForMessage(op)}".`);
  return { kind: null, expr: null };
}

function checkEnumLiteralMatch(
  varName: string | undefined,
  litString: string | undefined,
  schemaMap: ReadonlyMap<string, SchemaVarInfo>,
  path: string,
  errors: ValidationError[],
): boolean {
  if (varName === undefined || litString === undefined) return true;
  const info = schemaMap.get(varName);
  if (info?.kind === 'enum' && !info.valueSet.has(litString)) {
    addError(errors, 'INVALID_ENUM_LITERAL', path, `Literal "${litString}" is not in enum "${varName}".`);
    return false;
  }
  return true;
}

function parseBoolExpr(
  expr: unknown,
  schemaMap: ReadonlyMap<string, SchemaVarInfo>,
  depth: number,
  budget: AstBudget,
  path: string,
  errors: ValidationError[],
): BoolExpr | null {
  if (!enterAstNode(depth, budget, path, errors)) return null;
  const ownNames: string[] = [];
  const obj = expectPlainObject(expr, path, 'INVALID_BOOL_EXPR', 'Boolean expression must be a plain object.', errors, ownNames);
  if (obj === null) return null;

  const readKeys = new Set<string>();
  const opProp = readOwnDataProperty(obj, 'op', `${path}.op`, errors, readKeys);
  if (!opProp.ok) {
    checkExtraOwnAccessors(obj, ownNames, path, readKeys, errors);
    return null;
  }
  const op = opProp.value;
  if (op === 'lit') {
    const valProp = readOwnDataProperty(obj, 'value', `${path}.value`, errors, readKeys);
    const extraOk = checkExtraOwnAccessors(obj, ownNames, path, readKeys, errors);
    if (!valProp.ok) return null;
    if (typeof valProp.value !== 'boolean') {
      addError(errors, 'INVALID_LITERAL', `${path}.value`, 'Boolean literal must be a boolean.');
      return null;
    }
    return extraOk ? { op: 'lit', value: valProp.value } : null;
  }
  if (op === 'var') {
    const nameProp = readOwnDataProperty(obj, 'name', `${path}.name`, errors, readKeys);
    const extraOk = checkExtraOwnAccessors(obj, ownNames, path, readKeys, errors);
    if (!nameProp.ok) return null;
    const name = nameProp.value;
    if (typeof name !== 'string' || !schemaMap.has(name)) {
      addError(errors, 'UNKNOWN_VAR', `${path}.name`, `Unknown variable "${formatUnknownForMessage(name)}".`);
      return null;
    }
    const info = schemaMap.get(name)!;
    if (info.kind !== 'boolean') {
      addError(errors, 'TYPE_MISMATCH', `${path}.name`, `Boolean var "${name}" has kind "${info.kind}".`);
      return null;
    }
    return extraOk ? { op: 'var', name } : null;
  }
  if (op === 'eq' || op === 'neq') {
    const leftProp = readOwnDataProperty(obj, 'left', `${path}.left`, errors, readKeys);
    const rightProp = readOwnDataProperty(obj, 'right', `${path}.right`, errors, readKeys);
    const extraOk = checkExtraOwnAccessors(obj, ownNames, path, readKeys, errors);
    const left: ValueExprParseResult = leftProp.ok
      ? parseValueExpr(leftProp.value, schemaMap, depth + 1, budget, `${path}.left`, errors)
      : { kind: null, expr: null };
    const right: ValueExprParseResult = rightProp.ok
      ? parseValueExpr(rightProp.value, schemaMap, depth + 1, budget, `${path}.right`, errors)
      : { kind: null, expr: null };
    if (left.kind === null || right.kind === null || left.expr === null || right.expr === null) return null;
    if (left.kind !== right.kind) {
      addError(errors, 'TYPE_MISMATCH', path, `Operator "${op}" operand kind mismatch: "${left.kind}" vs "${right.kind}".`);
      return null;
    }
    if (left.kind === 'enum') {
      const okL = checkEnumLiteralMatch(left.enumVarName, right.litString, schemaMap, `${path}.right.value`, errors);
      const okR = checkEnumLiteralMatch(right.enumVarName, left.litString, schemaMap, `${path}.left.value`, errors);
      if (!okL || !okR) return null;
    }
    return extraOk ? { op, left: left.expr, right: right.expr } : null;
  }
  if (op === 'lt' || op === 'lte' || op === 'gt' || op === 'gte') {
    const operands = parseBinaryIntOperands(obj, op, schemaMap, depth, budget, path, errors, readKeys);
    const extraOk = checkExtraOwnAccessors(obj, ownNames, path, readKeys, errors);
    if (operands === null || !extraOk) return null;
    return { op, left: operands.left, right: operands.right };
  }
  if (op === 'in') {
    const targetProp = readOwnDataProperty(obj, 'expr', `${path}.expr`, errors, readKeys);
    const rawValuesProp = readOwnDataProperty(obj, 'values', `${path}.values`, errors, readKeys);
    const extraOk = checkExtraOwnAccessors(obj, ownNames, path, readKeys, errors);
    const target: ValueExprParseResult = targetProp.ok
      ? parseValueExpr(targetProp.value, schemaMap, depth + 1, budget, `${path}.expr`, errors)
      : { kind: null, expr: null };
    if (!rawValuesProp.ok) return null;
    const valuesArr = expectPlainArray(
      rawValuesProp.value,
      `${path}.values`,
      'INVALID_IN_VALUES',
      `Operator "in" requires 0..${MAX_IN_VALUES} literals.`,
      errors,
    );
    if (valuesArr === null) return null;
    if (valuesArr.length > MAX_IN_VALUES) {
      addError(errors, 'INVALID_IN_VALUES', `${path}.values`, `Operator "in" requires 0..${MAX_IN_VALUES} literals.`);
      return null;
    }
    if (target.kind === null || target.expr === null) return null;

    const parsedValues: StateValue[] = [];
    let valid = true;
    for (let i = 0; i < valuesArr.length; i += 1) {
      const itemPath = `${path}.values[${i}]`;
      const itemProp = readOwnArrayElement(valuesArr.arr, i, itemPath, errors);
      if (!itemProp.ok) {
        valid = false;
        continue;
      }
      const item = itemProp.value;
      if (target.kind === 'boolean') {
        if (typeof item !== 'boolean') {
          addError(errors, 'TYPE_MISMATCH', itemPath, 'Expected boolean literal in "in" list.');
          valid = false;
        } else {
          parsedValues.push(item);
        }
      } else if (target.kind === 'int') {
        if (typeof item !== 'number' || !Number.isSafeInteger(item)) {
          addError(errors, 'TYPE_MISMATCH', itemPath, 'Expected safe integer literal in "in" list.');
          valid = false;
        } else {
          parsedValues.push(normalizeInt(item));
        }
      } else if (typeof item !== 'string') {
        addError(errors, 'TYPE_MISMATCH', itemPath, 'Expected string literal in "in" list.');
        valid = false;
      } else if (!checkEnumLiteralMatch(target.enumVarName, item, schemaMap, itemPath, errors)) {
        valid = false;
      } else {
        parsedValues.push(item);
      }
    }
    return valid && extraOk ? { op: 'in', expr: target.expr, values: parsedValues } : null;
  }
  if (op === 'and' || op === 'or') {
    const rawArgsProp = readOwnDataProperty(obj, 'args', `${path}.args`, errors, readKeys);
    const extraOk = checkExtraOwnAccessors(obj, ownNames, path, readKeys, errors);
    if (!rawArgsProp.ok) return null;
    const argsArr = expectPlainArray(
      rawArgsProp.value,
      `${path}.args`,
      'INVALID_EXPR_ARGS',
      `Operator "${op}" requires 1..${MAX_BOOL_ARGS} boolean arguments.`,
      errors,
    );
    if (argsArr === null) return null;
    if (argsArr.length < 1 || argsArr.length > MAX_BOOL_ARGS) {
      addError(
        errors,
        'INVALID_EXPR_ARGS',
        `${path}.args`,
        `Operator "${op}" requires 1..${MAX_BOOL_ARGS} boolean arguments.`,
      );
      return null;
    }
    const parsedArgs: BoolExpr[] = [];
    let valid = true;
    for (let i = 0; i < argsArr.length; i += 1) {
      if (budget.exceeded) return null;
      const argPath = `${path}.args[${i}]`;
      const argProp = readOwnArrayElement(argsArr.arr, i, argPath, errors);
      if (!argProp.ok) {
        valid = false;
        continue;
      }
      const parsedArg = parseBoolExpr(argProp.value, schemaMap, depth + 1, budget, argPath, errors);
      if (parsedArg === null) valid = false;
      else parsedArgs.push(parsedArg);
    }
    return valid && extraOk ? { op, args: parsedArgs } : null;
  }
  if (op === 'not') {
    const argProp = readOwnDataProperty(obj, 'arg', `${path}.arg`, errors, readKeys);
    const extraOk = checkExtraOwnAccessors(obj, ownNames, path, readKeys, errors);
    if (!argProp.ok) return null;
    const parsedArg = parseBoolExpr(argProp.value, schemaMap, depth + 1, budget, `${path}.arg`, errors);
    return parsedArg !== null && extraOk ? { op: 'not', arg: parsedArg } : null;
  }
  checkExtraOwnAccessors(obj, ownNames, path, readKeys, errors);
  addError(errors, 'INVALID_EXPR_OP', `${path}.op`, `Unsupported boolean operator "${formatUnknownForMessage(op)}".`);
  return null;
}

function parseRules(
  rawRules: unknown,
  schemaMap: ReadonlyMap<string, SchemaVarInfo>,
  errors: ValidationError[],
): TransitionRule[] | null {
  const rulesArr = expectPlainArray(rawRules, 'rules', 'INVALID_RULES', 'Rules must be an array.', errors);
  if (rulesArr === null) return null;
  if (rulesArr.length > MAX_RULES) {
    addError(errors, 'TOO_MANY_RULES', 'rules', `Model declares ${rulesArr.length} rules; maximum is ${MAX_RULES}.`);
    return null;
  }

  const ruleIds = new Set<string>();
  const parsedRules: TransitionRule[] = [];
  let valid = true;

  for (let i = 0; i < rulesArr.length; i += 1) {
    const rulePath = `rules[${i}]`;
    const rawRuleProp = readOwnArrayElement(rulesArr.arr, i, rulePath, errors);
    if (!rawRuleProp.ok) {
      valid = false;
      continue;
    }
    const ruleOwnNames: string[] = [];
    const rawRule = expectPlainObject(
      rawRuleProp.value,
      rulePath,
      'INVALID_RULE',
      'Rule must be a plain object.',
      errors,
      ruleOwnNames,
    );
    if (rawRule === null) {
      valid = false;
      continue;
    }

    const ruleReadKeys = new Set<string>();
    const idProp = readOwnDataProperty(rawRule, 'id', `${rulePath}.id`, errors, ruleReadKeys);
    const parsedId = idProp.ok ? parseUniqueId(idProp.value, ruleIds, 'Rule', 'RULE', `${rulePath}.id`, errors) : null;

    const labelProp = readOwnDataProperty(rawRule, 'label', `${rulePath}.label`, errors, ruleReadKeys);
    let parsedLabel: string | null = null;
    if (labelProp.ok) {
      if (!isNonBlankString(labelProp.value)) {
        addError(errors, 'INVALID_RULE_LABEL', `${rulePath}.label`, 'Rule label must be a non-blank string.');
      } else {
        parsedLabel = labelProp.value;
      }
    }

    const guardProp = readOwnDataProperty(rawRule, 'guard', `${rulePath}.guard`, errors, ruleReadKeys);
    const parsedGuard = guardProp.ok
      ? parseBoolExpr(guardProp.value, schemaMap, 0, { visits: 0, exceeded: false }, `${rulePath}.guard`, errors)
      : null;

    const rawUpdatesProp = readOwnDataProperty(rawRule, 'updates', `${rulePath}.updates`, errors, ruleReadKeys);
    const extraRuleOk = checkExtraOwnAccessors(rawRule, ruleOwnNames, rulePath, ruleReadKeys, errors);
    if (!rawUpdatesProp.ok) {
      valid = false;
      continue;
    }
    const updatesArr = expectPlainArray(
      rawUpdatesProp.value,
      `${rulePath}.updates`,
      'INVALID_UPDATES',
      'Rule updates must be an array.',
      errors,
    );
    if (updatesArr === null) {
      valid = false;
      continue;
    }
    if (updatesArr.length > MAX_UPDATES_PER_RULE) {
      addError(
        errors,
        'TOO_MANY_UPDATES',
        `${rulePath}.updates`,
        `Rule has ${updatesArr.length} updates; maximum is ${MAX_UPDATES_PER_RULE}.`,
      );
      valid = false;
      continue;
    }

    const seenTargets = new Set<string>();
    const parsedUpdates: UpdateAssignment[] = [];
    let updatesValid = true;
    for (let j = 0; j < updatesArr.length; j += 1) {
      const updPath = `${rulePath}.updates[${j}]`;
      const rawUpdProp = readOwnArrayElement(updatesArr.arr, j, updPath, errors);
      if (!rawUpdProp.ok) {
        updatesValid = false;
        continue;
      }
      const updOwnNames: string[] = [];
      const rawUpd = expectPlainObject(
        rawUpdProp.value,
        updPath,
        'INVALID_UPDATE',
        'Update assignment must be a plain object.',
        errors,
        updOwnNames,
      );
      if (rawUpd === null) {
        updatesValid = false;
        continue;
      }
      const updReadKeys = new Set<string>();
      const targetVarProp = readOwnDataProperty(rawUpd, 'var', `${updPath}.var`, errors, updReadKeys);
      if (!targetVarProp.ok) {
        checkExtraOwnAccessors(rawUpd, updOwnNames, updPath, updReadKeys, errors);
        updatesValid = false;
        continue;
      }
      const targetVar = targetVarProp.value;
      if (typeof targetVar !== 'string' || !schemaMap.has(targetVar)) {
        checkExtraOwnAccessors(rawUpd, updOwnNames, updPath, updReadKeys, errors);
        addError(
          errors,
          'UNKNOWN_VAR',
          `${updPath}.var`,
          `Unknown update target variable "${formatUnknownForMessage(targetVar)}".`,
        );
        updatesValid = false;
        continue;
      }
      if (seenTargets.has(targetVar)) {
        checkExtraOwnAccessors(rawUpd, updOwnNames, updPath, updReadKeys, errors);
        addError(errors, 'DUPLICATE_UPDATE_VAR', `${updPath}.var`, `Duplicate update target "${targetVar}" in rule.`);
        updatesValid = false;
        continue;
      }
      seenTargets.add(targetVar);

      const valueProp = readOwnDataProperty(rawUpd, 'value', `${updPath}.value`, errors, updReadKeys);
      const extraUpdOk = checkExtraOwnAccessors(rawUpd, updOwnNames, updPath, updReadKeys, errors);
      if (!valueProp.ok) {
        updatesValid = false;
        continue;
      }
      const valueCheck = parseValueExpr(
        valueProp.value,
        schemaMap,
        0,
        { visits: 0, exceeded: false },
        `${updPath}.value`,
        errors,
      );
      const targetInfo = schemaMap.get(targetVar)!;
      if (valueCheck.kind !== null && valueCheck.kind !== targetInfo.kind) {
        addError(
          errors,
          'TYPE_MISMATCH',
          `${updPath}.value`,
          `Update to "${targetVar}" expects "${targetInfo.kind}"; got "${valueCheck.kind}".`,
        );
        updatesValid = false;
      } else if (
        targetInfo.kind === 'enum' &&
        !checkEnumLiteralMatch(targetVar, valueCheck.litString, schemaMap, `${updPath}.value.value`, errors)
      ) {
        updatesValid = false;
      } else if (valueCheck.expr === null || !extraUpdOk) {
        updatesValid = false;
      } else {
        parsedUpdates.push({ var: targetVar, value: valueCheck.expr });
      }
    }

    if (parsedId !== null && parsedLabel !== null && parsedGuard !== null && updatesValid && extraRuleOk) {
      parsedRules.push({
        id: parsedId,
        label: parsedLabel,
        guard: parsedGuard,
        updates: parsedUpdates,
      });
    } else {
      valid = false;
    }
  }

  return valid ? parsedRules : null;
}

function parseInvariants(
  rawInvariants: unknown,
  schemaMap: ReadonlyMap<string, SchemaVarInfo>,
  errors: ValidationError[],
): Invariant[] | null {
  const invArr = expectPlainArray(
    rawInvariants,
    'invariants',
    'INVALID_INVARIANTS',
    'Invariants must be an array.',
    errors,
  );
  if (invArr === null) return null;
  if (invArr.length < 1 || invArr.length > MAX_INVARIANTS) {
    addError(errors, 'INVALID_INVARIANTS_COUNT', 'invariants', `Model must declare 1..${MAX_INVARIANTS} invariants.`);
    return null;
  }

  const invIds = new Set<string>();
  const parsedInvariants: Invariant[] = [];
  let valid = true;

  for (let i = 0; i < invArr.length; i += 1) {
    const invPath = `invariants[${i}]`;
    const rawInvProp = readOwnArrayElement(invArr.arr, i, invPath, errors);
    if (!rawInvProp.ok) {
      valid = false;
      continue;
    }
    const invOwnNames: string[] = [];
    const rawInv = expectPlainObject(
      rawInvProp.value,
      invPath,
      'INVALID_INVARIANT',
      'Invariant must be a plain object.',
      errors,
      invOwnNames,
    );
    if (rawInv === null) {
      valid = false;
      continue;
    }

    const invReadKeys = new Set<string>();
    const idProp = readOwnDataProperty(rawInv, 'id', `${invPath}.id`, errors, invReadKeys);
    const parsedId = idProp.ok
      ? parseUniqueId(idProp.value, invIds, 'Invariant', 'INVARIANT', `${invPath}.id`, errors)
      : null;

    const labelProp = readOwnDataProperty(rawInv, 'label', `${invPath}.label`, errors, invReadKeys);
    let parsedLabel: string | null = null;
    if (labelProp.ok) {
      if (!isNonBlankString(labelProp.value)) {
        addError(errors, 'INVALID_INVARIANT_LABEL', `${invPath}.label`, 'Invariant label must be a non-blank string.');
      } else {
        parsedLabel = labelProp.value;
      }
    }

    const holdsProp = readOwnDataProperty(rawInv, 'holds', `${invPath}.holds`, errors, invReadKeys);
    const extraInvOk = checkExtraOwnAccessors(rawInv, invOwnNames, invPath, invReadKeys, errors);
    const parsedHolds = holdsProp.ok
      ? parseBoolExpr(holdsProp.value, schemaMap, 0, { visits: 0, exceeded: false }, `${invPath}.holds`, errors)
      : null;

    if (parsedId !== null && parsedLabel !== null && parsedHolds !== null && extraInvOk) {
      parsedInvariants.push({ id: parsedId, label: parsedLabel, holds: parsedHolds });
    } else {
      valid = false;
    }
  }

  return valid ? parsedInvariants : null;
}

function parseGoal(
  rawGoal: unknown,
  schemaMap: ReadonlyMap<string, SchemaVarInfo>,
  errors: ValidationError[],
): Goal | null {
  const goalOwnNames: string[] = [];
  const obj = expectPlainObject(rawGoal, 'goal', 'INVALID_GOAL', 'Goal must be a plain object when provided.', errors, goalOwnNames);
  if (obj === null) return null;

  const goalReadKeys = new Set<string>();
  const idProp = readOwnDataProperty(obj, 'id', 'goal.id', errors, goalReadKeys);
  let parsedId: string | null = null;
  if (idProp.ok) {
    if (!isNonBlankString(idProp.value)) {
      addError(errors, 'INVALID_GOAL_ID', 'goal.id', 'Goal id must be a non-blank string.');
    } else {
      parsedId = idProp.value;
    }
  }

  const labelProp = readOwnDataProperty(obj, 'label', 'goal.label', errors, goalReadKeys);
  let parsedLabel: string | null = null;
  if (labelProp.ok) {
    if (!isNonBlankString(labelProp.value)) {
      addError(errors, 'INVALID_GOAL_LABEL', 'goal.label', 'Goal label must be a non-blank string.');
    } else {
      parsedLabel = labelProp.value;
    }
  }

  const reachedProp = readOwnDataProperty(obj, 'reached', 'goal.reached', errors, goalReadKeys);
  const extraGoalOk = checkExtraOwnAccessors(obj, goalOwnNames, 'goal', goalReadKeys, errors);
  const parsedReached = reachedProp.ok
    ? parseBoolExpr(reachedProp.value, schemaMap, 0, { visits: 0, exceeded: false }, 'goal.reached', errors)
    : null;

  if (parsedId === null || parsedLabel === null || parsedReached === null || !extraGoalOk) return null;
  return { id: parsedId, label: parsedLabel, reached: parsedReached };
}

function parseAssumptions(rawAssumptions: unknown, errors: ValidationError[]): ModelAssumption[] | null {
  const arrInfo = expectPlainArray(
    rawAssumptions,
    'assumptions',
    'INVALID_ASSUMPTIONS',
    'Assumptions must be an array.',
    errors,
  );
  if (arrInfo === null) return null;
  if (arrInfo.length < 1 || arrInfo.length > MAX_ASSUMPTIONS) {
    addError(
      errors,
      'INVALID_ASSUMPTIONS_COUNT',
      'assumptions',
      `Model must declare 1..${MAX_ASSUMPTIONS} assumptions.`,
    );
    return null;
  }

  const assumptionIds = new Set<string>();
  const parsedAssumptions: ModelAssumption[] = [];
  let valid = true;

  for (let i = 0; i < arrInfo.length; i += 1) {
    const path = `assumptions[${i}]`;
    const rawAssumptionProp = readOwnArrayElement(arrInfo.arr, i, path, errors);
    if (!rawAssumptionProp.ok) {
      valid = false;
      continue;
    }
    const assumptionOwnNames: string[] = [];
    const rawAssumption = expectPlainObject(
      rawAssumptionProp.value,
      path,
      'INVALID_ASSUMPTION',
      'Assumption must be a plain object.',
      errors,
      assumptionOwnNames,
    );
    if (rawAssumption === null) {
      valid = false;
      continue;
    }

    const assumptionReadKeys = new Set<string>();
    const idProp = readOwnDataProperty(rawAssumption, 'id', `${path}.id`, errors, assumptionReadKeys);
    const parsedId = idProp.ok
      ? parseUniqueId(idProp.value, assumptionIds, 'Assumption', 'ASSUMPTION', `${path}.id`, errors)
      : null;

    const categoryProp = readOwnDataProperty(rawAssumption, 'category', `${path}.category`, errors, assumptionReadKeys);
    let parsedCategory: string | null = null;
    if (categoryProp.ok) {
      if (!isNonBlankString(categoryProp.value)) {
        addError(
          errors,
          'INVALID_ASSUMPTION_CATEGORY',
          `${path}.category`,
          'Assumption category must be a non-blank string.',
        );
      } else {
        parsedCategory = categoryProp.value;
      }
    }

    const statementProp = readOwnDataProperty(rawAssumption, 'statement', `${path}.statement`, errors, assumptionReadKeys);
    let parsedStatement: string | null = null;
    if (statementProp.ok) {
      if (!isNonBlankString(statementProp.value)) {
        addError(
          errors,
          'INVALID_ASSUMPTION_STATEMENT',
          `${path}.statement`,
          'Assumption statement must be a non-blank string.',
        );
      } else {
        parsedStatement = statementProp.value;
      }
    }

    const notModeledProp = readOwnDataProperty(rawAssumption, 'notModeled', `${path}.notModeled`, errors, assumptionReadKeys);
    let parsedNotModeled: string | null = null;
    if (notModeledProp.ok) {
      if (!isNonBlankString(notModeledProp.value)) {
        addError(
          errors,
          'INVALID_ASSUMPTION_NOT_MODELED',
          `${path}.notModeled`,
          'Assumption notModeled must be a non-blank string.',
        );
      } else {
        parsedNotModeled = notModeledProp.value;
      }
    }

    const extraOk = checkExtraOwnAccessors(rawAssumption, assumptionOwnNames, path, assumptionReadKeys, errors);

    if (
      parsedId !== null &&
      parsedCategory !== null &&
      parsedStatement !== null &&
      parsedNotModeled !== null &&
      extraOk
    ) {
      parsedAssumptions.push({
        id: parsedId,
        category: parsedCategory,
        statement: parsedStatement,
        notModeled: parsedNotModeled,
      });
    } else {
      valid = false;
    }
  }

  return valid ? parsedAssumptions : null;
}

export function parseModel(raw: unknown): ParseModelResult {
  try {
    const errors: ValidationError[] = [];
    const modelOwnNames: string[] = [];
    const obj = expectPlainObject(raw, '', 'INVALID_MODEL', 'Model must be a plain object.', errors, modelOwnNames);
    if (obj === null) {
      return { ok: false, errors: Object.freeze(errors) };
    }

    const readKeys = new Set<string>();
    const idProp = readOwnDataProperty(obj, 'id', 'id', errors, readKeys);
    let parsedId: string | null = null;
    if (idProp.ok) {
      if (!isNonBlankString(idProp.value)) {
        addError(errors, 'INVALID_ID', 'id', 'Model id must be a non-blank string.');
      } else {
        parsedId = idProp.value;
      }
    }

    const nameProp = readOwnDataProperty(obj, 'name', 'name', errors, readKeys);
    let parsedName: string | null = null;
    if (nameProp.ok) {
      if (!isNonBlankString(nameProp.value)) {
        addError(errors, 'INVALID_NAME', 'name', 'Model name must be a non-blank string.');
      } else {
        parsedName = nameProp.value;
      }
    }

    const schemaProp = readOwnDataProperty(obj, 'schema', 'schema', errors, readKeys);
    const schemaResult = schemaProp.ok ? parseSchema(schemaProp.value, errors) : null;

    let parsedInitialState: StateSnapshot | null = null;
    let parsedRules: TransitionRule[] | null = null;
    let parsedInvariants: Invariant[] | null = null;
    let parsedGoal: Goal | undefined;

    if (schemaResult !== null && schemaResult.schemaMap.size > 0) {
      const initialStateProp = readOwnDataProperty(obj, 'initialState', 'initialState', errors, readKeys);
      if (initialStateProp.ok) {
        parsedInitialState = parseStateMap(
          schemaResult.varNames,
          schemaResult.schemaMap,
          initialStateProp.value,
          'initialState',
          errors,
        );
      }
      const rulesProp = readOwnDataProperty(obj, 'rules', 'rules', errors, readKeys);
      if (rulesProp.ok) {
        parsedRules = parseRules(rulesProp.value, schemaResult.schemaMap, errors);
      }
      const invariantsProp = readOwnDataProperty(obj, 'invariants', 'invariants', errors, readKeys);
      if (invariantsProp.ok) {
        parsedInvariants = parseInvariants(invariantsProp.value, schemaResult.schemaMap, errors);
      }
      const goalProp = readOwnDataProperty(obj, 'goal', 'goal', errors, readKeys);
      if (goalProp.ok && goalProp.present && goalProp.value !== undefined) {
        parsedGoal = parseGoal(goalProp.value, schemaResult.schemaMap, errors) ?? undefined;
      }
    }

    const assumptionsProp = readOwnDataProperty(obj, 'assumptions', 'assumptions', errors, readKeys);
    const parsedAssumptions = assumptionsProp.ok ? parseAssumptions(assumptionsProp.value, errors) : null;

    checkExtraOwnAccessors(obj, modelOwnNames, '', readKeys, errors);

    if (
      errors.length > 0 ||
      parsedId === null ||
      parsedName === null ||
      schemaResult === null ||
      parsedInitialState === null ||
      parsedRules === null ||
      parsedInvariants === null ||
      parsedAssumptions === null
    ) {
      return { ok: false, errors: Object.freeze(errors) };
    }

    const parsedModel: TransitionSystemModel = {
      id: parsedId,
      name: parsedName,
      schema: schemaResult.schema,
      initialState: parsedInitialState,
      rules: parsedRules,
      invariants: parsedInvariants,
      ...(parsedGoal !== undefined ? { goal: parsedGoal } : {}),
      assumptions: parsedAssumptions,
    };

    return { ok: true, model: parsedModel };
  } catch {
    return { ok: false, errors: Object.freeze([createUnexpectedInputError()]) };
  }
}

export function parseOptions(raw: unknown): ParseOptionsResult {
  try {
    const errors: ValidationError[] = [];
    const optOwnNames: string[] = [];
    const obj = expectPlainObject(raw, '', 'INVALID_OPTIONS', 'Verify options must be a plain object.', errors, optOwnNames);
    if (obj === null) {
      return { ok: false, errors: Object.freeze(errors) };
    }

    const readKeys = new Set<string>();
    const maxStatesProp = readOwnDataProperty(obj, 'maxStates', 'maxStates', errors, readKeys);
    let parsedMaxStates: number | null = null;
    if (maxStatesProp.ok) {
      const maxStates = maxStatesProp.value;
      if (
        typeof maxStates !== 'number' ||
        !Number.isSafeInteger(maxStates) ||
        maxStates < 1 ||
        maxStates > MAX_STATES_LIMIT
      ) {
        addError(
          errors,
          'INVALID_OPTIONS',
          'maxStates',
          `maxStates must be a safe integer in [1, ${MAX_STATES_LIMIT}].`,
        );
      } else {
        parsedMaxStates = normalizeInt(maxStates);
      }
    }

    const maxDepthProp = readOwnDataProperty(obj, 'maxDepth', 'maxDepth', errors, readKeys);
    let parsedMaxDepth: number | null = null;
    if (maxDepthProp.ok) {
      const maxDepth = maxDepthProp.value;
      if (
        typeof maxDepth !== 'number' ||
        !Number.isSafeInteger(maxDepth) ||
        maxDepth < 0 ||
        maxDepth > MAX_DEPTH_LIMIT
      ) {
        addError(
          errors,
          'INVALID_OPTIONS',
          'maxDepth',
          `maxDepth must be a safe integer in [0, ${MAX_DEPTH_LIMIT}].`,
        );
      } else {
        parsedMaxDepth = normalizeInt(maxDepth);
      }
    }

    checkExtraOwnAccessors(obj, optOwnNames, '', readKeys, errors);

    if (errors.length > 0 || parsedMaxStates === null || parsedMaxDepth === null) {
      return { ok: false, errors: Object.freeze(errors) };
    }
    return { ok: true, options: { maxStates: parsedMaxStates, maxDepth: parsedMaxDepth } };
  } catch {
    return { ok: false, errors: Object.freeze([createUnexpectedInputError()]) };
  }
}

export function parseRuleIds(raw: unknown): ParseRuleIdsResult {
  try {
    const errors: ValidationError[] = [];
    const arrInfo = expectPlainArray(
      raw,
      'ruleIds',
      'INVALID_TRACE',
      'ruleIds must be an array of rule id strings.',
      errors,
    );
    if (arrInfo === null) {
      return { ok: false, stepIndex: -1, errors: Object.freeze(errors) };
    }

    const parsed: string[] = [];
    for (let i = 0; i < arrInfo.length; i += 1) {
      const itemPath = `ruleIds[${i}]`;
      try {
        const elemProp = readOwnArrayElement(arrInfo.arr, i, itemPath, errors);
        if (!elemProp.ok) {
          return {
            ok: true,
            ruleIds: parsed,
            malformedEntry: {
              stepIndex: i,
              error: errors[0]!,
              errors: Object.freeze(errors),
            },
          };
        }
        if (typeof elemProp.value !== 'string') {
          addError(errors, 'UNKNOWN_RULE', itemPath, 'Rule id must be a string.');
          return {
            ok: true,
            ruleIds: parsed,
            malformedEntry: {
              stepIndex: i,
              error: errors[0]!,
              errors: Object.freeze(errors),
            },
          };
        }
        parsed.push(elemProp.value);
      } catch {
        const err = createUnexpectedInputError(itemPath);
        return {
          ok: true,
          ruleIds: parsed,
          malformedEntry: {
            stepIndex: i,
            error: err,
            errors: Object.freeze([err]),
          },
        };
      }
    }

    return { ok: true, ruleIds: parsed };
  } catch {
    return { ok: false, stepIndex: -1, errors: Object.freeze([createUnexpectedInputError()]) };
  }
}

export function validateModel(model: unknown): readonly ValidationError[] {
  const parsed = parseModel(model);
  return parsed.ok ? Object.freeze([]) : parsed.errors;
}

export function validateOptions(options: unknown): readonly ValidationError[] {
  const parsed = parseOptions(options);
  return parsed.ok ? Object.freeze([]) : parsed.errors;
}
