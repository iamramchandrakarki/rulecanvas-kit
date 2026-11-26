import {
  validateModel,
  type TransitionSystemModel,
  type ValidationError,
} from '@rulecanvas/core';

export interface ModelJsonLimits {
  readonly maxChars: number;
  readonly maxVisits: number;
  readonly maxDepth: number;
  readonly maxRawNesting: number;
}

export const DEFAULT_MODEL_JSON_LIMITS: ModelJsonLimits = Object.freeze({
  maxChars: 512_000,
  maxVisits: 10_000,
  maxDepth: 64,
  maxRawNesting: 256,
});

export const HARD_CEILING_MODEL_JSON_LIMITS: ModelJsonLimits = Object.freeze({
  maxChars: 2_000_000,
  maxVisits: 50_000,
  maxDepth: 64,
  maxRawNesting: 256,
});

export type ModelJsonDecodeResult =
  | { readonly ok: true; readonly model: TransitionSystemModel }
  | { readonly ok: false; readonly errors: readonly ValidationError[] };

export type ModelJsonEncodeResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly error: ValidationError };

export interface ModelJsonCodecOptions {
  readonly duplicateKeys?: 'reject' | 'last-value' | undefined;
}

export interface ModelJsonCodec {
  readonly limits: ModelJsonLimits;
  decode(text: unknown): ModelJsonDecodeResult;
  validateValue(candidate: unknown): ModelJsonDecodeResult;
  encode(model: unknown): ModelJsonEncodeResult;
}

const MAX_COLLECTED_ERRORS = 64;
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

function resolveLimits(overrides?: Partial<ModelJsonLimits>): ModelJsonLimits {
  if (overrides === undefined) {
    return DEFAULT_MODEL_JSON_LIMITS;
  }
  const merged = {
    maxChars: overrides.maxChars ?? DEFAULT_MODEL_JSON_LIMITS.maxChars,
    maxVisits: overrides.maxVisits ?? DEFAULT_MODEL_JSON_LIMITS.maxVisits,
    maxDepth: overrides.maxDepth ?? DEFAULT_MODEL_JSON_LIMITS.maxDepth,
    maxRawNesting: overrides.maxRawNesting ?? DEFAULT_MODEL_JSON_LIMITS.maxRawNesting,
  };
  for (const key of ['maxChars', 'maxVisits', 'maxDepth', 'maxRawNesting'] as const) {
    const val = merged[key];
    const ceiling = HARD_CEILING_MODEL_JSON_LIMITS[key];
    if (typeof val !== 'number' || !Number.isSafeInteger(val) || val < 1 || val > ceiling) {
      throw new RangeError(
        `Invalid ModelJsonLimits.${key}: must be a safe integer in [1, ${ceiling}].`,
      );
    }
  }
  return Object.freeze(merged);
}

function isAccessorDescriptor(desc: PropertyDescriptor): boolean {
  return (
    Object.hasOwn(desc, 'get') ||
    Object.hasOwn(desc, 'set') ||
    desc.get !== undefined ||
    desc.set !== undefined
  );
}

function defineSafeDataProp(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function joinPath(base: string, key: string): string {
  return base.length === 0 ? key : `${base}.${key}`;
}

function isCanonicalArrayIndex(key: string, length: number): boolean {
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

function normalizePrimitive(value: unknown): unknown {
  if (typeof value === 'number') {
    return Object.is(value, -0) ? 0 : value;
  }
  return value;
}

function isJsonWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

function skipJsonWhitespace(raw: string, start: number): number {
  let i = start;
  while (i < raw.length && isJsonWhitespace(raw[i]!)) {
    i += 1;
  }
  return i;
}

function scanAndDecodeJsonString(
  raw: string,
  start: number,
  decodeValue: boolean,
): { readonly nextIndex: number; readonly decoded: string } | { readonly error: string } {
  let i = start + 1;
  let decoded = '';
  let chunkStart = i;
  while (i < raw.length) {
    const ch = raw[i]!;
    const code = raw.charCodeAt(i);
    if (code < 0x20) {
      return { error: `Unescaped control character in string at index ${i}.` };
    }
    if (ch === '"') {
      if (decodeValue) {
        decoded += raw.slice(chunkStart, i);
      }
      return { nextIndex: i + 1, decoded };
    }
    if (ch === '\\') {
      if (decodeValue) {
        decoded += raw.slice(chunkStart, i);
      }
      i += 1;
      if (i >= raw.length) {
        return { error: 'Unterminated escape sequence in JSON string.' };
      }
      const esc = raw[i]!;
      if (esc === '"' || esc === '\\' || esc === '/') {
        if (decodeValue) decoded += esc;
        i += 1;
        chunkStart = i;
        continue;
      }
      if (esc === 'b') {
        if (decodeValue) decoded += '\b';
        i += 1;
        chunkStart = i;
        continue;
      }
      if (esc === 'f') {
        if (decodeValue) decoded += '\f';
        i += 1;
        chunkStart = i;
        continue;
      }
      if (esc === 'n') {
        if (decodeValue) decoded += '\n';
        i += 1;
        chunkStart = i;
        continue;
      }
      if (esc === 'r') {
        if (decodeValue) decoded += '\r';
        i += 1;
        chunkStart = i;
        continue;
      }
      if (esc === 't') {
        if (decodeValue) decoded += '\t';
        i += 1;
        chunkStart = i;
        continue;
      }
      if (esc === 'u') {
        if (i + 4 >= raw.length) {
          return { error: 'Incomplete unicode escape in JSON string.' };
        }
        let hexCode = 0;
        for (let h = 1; h <= 4; h += 1) {
          const c = raw.charCodeAt(i + h);
          let digit = -1;
          if (c >= 48 && c <= 57) digit = c - 48;
          else if (c >= 65 && c <= 70) digit = c - 55;
          else if (c >= 97 && c <= 102) digit = c - 87;
          if (digit < 0) {
            return { error: `Invalid hex digit "${raw[i + h]!}" in unicode escape.` };
          }
          hexCode = (hexCode << 4) | digit;
        }
        if (decodeValue) decoded += String.fromCharCode(hexCode);
        i += 5;
        chunkStart = i;
        continue;
      }
      return { error: `Invalid escape "\\${esc}" in JSON string.` };
    }
    i += 1;
  }
  return { error: 'Unterminated JSON string literal.' };
}

type RawJsonScanResult =
  | {
      readonly ok: true;
      readonly duplicateKeyErrors: readonly ValidationError[];
      readonly numberErrors: readonly ValidationError[];
    }
  | {
      readonly ok: false;
      readonly code: 'JSON_PARSE_ERROR' | 'IMPORT_COMPLEXITY_EXCEEDED';
      readonly message: string;
    };

type ScanFrame = { readonly kind: 'object'; readonly seenKeys: Set<string> } | { readonly kind: 'array' };

function scanRawJson(raw: string, limits: ModelJsonLimits): RawJsonScanResult {
  const stack: ScanFrame[] = [];
  const duplicateKeyErrors: ValidationError[] = [];
  const numberErrors: ValidationError[] = [];
  let i = skipJsonWhitespace(raw, 0);
  if (i >= raw.length) {
    return { ok: false, code: 'JSON_PARSE_ERROR', message: 'JSON input is empty.' };
  }

  type ExpectMode = 'value' | 'key-or-end' | 'key' | 'colon' | 'comma-or-end';
  let expectMode: ExpectMode = 'value';
  let rootDone = false;

  while (true) {
    i = skipJsonWhitespace(raw, i);

    if (rootDone && stack.length === 0) {
      return i < raw.length
        ? {
            ok: false,
            code: 'JSON_PARSE_ERROR',
            message: `Unexpected trailing token at index ${i}.`,
          }
        : { ok: true, duplicateKeyErrors, numberErrors };
    }

    if (i >= raw.length) {
      return { ok: false, code: 'JSON_PARSE_ERROR', message: 'Unexpected end of JSON input.' };
    }

    const ch = raw[i]!;

    if (expectMode === 'colon') {
      if (ch !== ':') {
        return { ok: false, code: 'JSON_PARSE_ERROR', message: `Expected ":" at index ${i}.` };
      }
      i += 1;
      expectMode = 'value';
      continue;
    }

    if (expectMode === 'key-or-end') {
      if (ch === '}') {
        const frame = stack.pop();
        if (frame?.kind !== 'object') {
          return { ok: false, code: 'JSON_PARSE_ERROR', message: `Mismatched "}" at index ${i}.` };
        }
        i += 1;
        if (stack.length === 0) rootDone = true;
        else expectMode = 'comma-or-end';
        continue;
      }
      if (ch !== '"') {
        return {
          ok: false,
          code: 'JSON_PARSE_ERROR',
          message: `Expected string key or "}" at index ${i}.`,
        };
      }
      const strRes = scanAndDecodeJsonString(raw, i, true);
      if ('error' in strRes) {
        return { ok: false, code: 'JSON_PARSE_ERROR', message: strRes.error };
      }
      const frame = stack[stack.length - 1];
      if (frame?.kind === 'object') {
        if (frame.seenKeys.has(strRes.decoded)) {
          if (duplicateKeyErrors.length < MAX_COLLECTED_ERRORS) {
            duplicateKeyErrors.push({
              code: 'DUPLICATE_JSON_KEY',
              path: '$',
              message: `Duplicate JSON object key "${strRes.decoded}".`,
            });
          }
        } else {
          frame.seenKeys.add(strRes.decoded);
        }
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
          message: `Expected property key string at index ${i}.`,
        };
      }
      const strRes = scanAndDecodeJsonString(raw, i, true);
      if ('error' in strRes) {
        return { ok: false, code: 'JSON_PARSE_ERROR', message: strRes.error };
      }
      const frame = stack[stack.length - 1];
      if (frame?.kind === 'object') {
        if (frame.seenKeys.has(strRes.decoded)) {
          if (duplicateKeyErrors.length < MAX_COLLECTED_ERRORS) {
            duplicateKeyErrors.push({
              code: 'DUPLICATE_JSON_KEY',
              path: '$',
              message: `Duplicate JSON object key "${strRes.decoded}".`,
            });
          }
        } else {
          frame.seenKeys.add(strRes.decoded);
        }
      }
      i = strRes.nextIndex;
      expectMode = 'colon';
      continue;
    }

    if (expectMode === 'comma-or-end') {
      const parent = stack[stack.length - 1];
      if (ch === ',') {
        i += 1;
        expectMode = parent?.kind === 'object' ? 'key' : 'value';
        continue;
      }
      if (ch === '}' && parent?.kind === 'object') {
        stack.pop();
        i += 1;
        if (stack.length === 0) rootDone = true;
        else expectMode = 'comma-or-end';
        continue;
      }
      if (ch === ']' && parent?.kind === 'array') {
        stack.pop();
        i += 1;
        if (stack.length === 0) rootDone = true;
        else expectMode = 'comma-or-end';
        continue;
      }
      return {
        ok: false,
        code: 'JSON_PARSE_ERROR',
        message: `Expected "," or closing delimiter at index ${i}.`,
      };
    }

    // expectMode === 'value'
    if (ch === '{') {
      if (stack.length >= limits.maxRawNesting) {
        return {
          ok: false,
          code: 'IMPORT_COMPLEXITY_EXCEEDED',
          message: `JSON nesting exceeds maximum raw container depth (${limits.maxRawNesting}).`,
        };
      }
      stack.push({ kind: 'object', seenKeys: new Set<string>() });
      i += 1;
      expectMode = 'key-or-end';
      continue;
    }

    if (ch === '[') {
      if (stack.length >= limits.maxRawNesting) {
        return {
          ok: false,
          code: 'IMPORT_COMPLEXITY_EXCEEDED',
          message: `JSON nesting exceeds maximum raw container depth (${limits.maxRawNesting}).`,
        };
      }
      stack.push({ kind: 'array' });
      i += 1;
      const nextNonWs = skipJsonWhitespace(raw, i);
      if (nextNonWs < raw.length && raw[nextNonWs] === ']') {
        stack.pop();
        i = nextNonWs + 1;
        if (stack.length === 0) rootDone = true;
        else expectMode = 'comma-or-end';
      } else {
        expectMode = 'value';
      }
      continue;
    }

    if (ch === '"') {
      const strRes = scanAndDecodeJsonString(raw, i, false);
      if ('error' in strRes) {
        return { ok: false, code: 'JSON_PARSE_ERROR', message: strRes.error };
      }
      i = strRes.nextIndex;
      if (stack.length === 0) rootDone = true;
      else expectMode = 'comma-or-end';
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
          message: `Invalid number token at index ${start}.`,
        };
      }
      if (raw[i] === '0') {
        i += 1;
        if (i < raw.length && raw[i]! >= '0' && raw[i]! <= '9') {
          return {
            ok: false,
            code: 'JSON_PARSE_ERROR',
            message: `Leading zero in JSON number at index ${start}.`,
          };
        }
      } else {
        while (i < raw.length && raw[i]! >= '0' && raw[i]! <= '9') i += 1;
      }
      if (i < raw.length && raw[i] === '.') {
        i += 1;
        if (i >= raw.length || raw[i]! < '0' || raw[i]! > '9') {
          return {
            ok: false,
            code: 'JSON_PARSE_ERROR',
            message: `Invalid fractional number at index ${start}.`,
          };
        }
        while (i < raw.length && raw[i]! >= '0' && raw[i]! <= '9') i += 1;
      }
      if (i < raw.length && (raw[i] === 'e' || raw[i] === 'E')) {
        i += 1;
        if (i < raw.length && (raw[i] === '+' || raw[i] === '-')) i += 1;
        if (i >= raw.length || raw[i]! < '0' || raw[i]! > '9') {
          return {
            ok: false,
            code: 'JSON_PARSE_ERROR',
            message: `Invalid exponent in JSON number at index ${start}.`,
          };
        }
        while (i < raw.length && raw[i]! >= '0' && raw[i]! <= '9') i += 1;
      }

      const token = raw.slice(start, i);
      if (!RFC8259_JSON_NUMBER_RE.test(token)) {
        return {
          ok: false,
          code: 'JSON_PARSE_ERROR',
          message: `Invalid JSON number token "${token}".`,
        };
      }

      if (numberErrors.length < MAX_COLLECTED_ERRORS) {
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
      message: `Unexpected token "${ch}" at index ${i}.`,
    };
  }
}

interface TraversalContext {
  readonly limits: ModelJsonLimits;
  visited: number;
  exceeded: boolean;
  readonly ancestors: Set<object>;
  readonly errors: ValidationError[];
}

function pushError(ctx: TraversalContext, err: ValidationError): void {
  if (ctx.errors.length < MAX_COLLECTED_ERRORS) {
    ctx.errors.push(err);
  }
}

function visitValueOccurrence(ctx: TraversalContext, depth: number, path: string): boolean {
  if (ctx.exceeded) return false;
  ctx.visited += 1;
  if (depth > ctx.limits.maxDepth || ctx.visited > ctx.limits.maxVisits) {
    ctx.exceeded = true;
    pushError(ctx, {
      code: 'IMPORT_COMPLEXITY_EXCEEDED',
      path: path.length > 0 ? path : '$',
      message: `Model input exceeds maximum traversal depth (${ctx.limits.maxDepth}) or visit budget (${ctx.limits.maxVisits}).`,
    });
    return false;
  }
  return true;
}

function scanUnknownValueForReservedAndAccessors(
  value: unknown,
  path: string,
  depth: number,
  ctx: TraversalContext,
): void {
  if (value === null || typeof value !== 'object') return;
  if (!visitValueOccurrence(ctx, depth, path)) return;
  if (ctx.ancestors.has(value)) return;
  ctx.ancestors.add(value);
  try {
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === 'symbol') {
        pushError(ctx, {
          code: 'UNSUPPORTED_PROPERTY',
          path: path.length > 0 ? path : '$',
          message: 'Portable model objects must not define symbol properties.',
        });
        continue;
      }
      const childPath = joinPath(path, key);
      if (RESERVED_KEYS.has(key)) {
        pushError(ctx, {
          code: 'RESERVED_KEY',
          path: childPath,
          message: `Property "${key}" uses a reserved key name.`,
        });
      }
      const desc = Object.getOwnPropertyDescriptor(value, key);
      if (desc === undefined) continue;
      if (isAccessorDescriptor(desc)) {
        pushError(ctx, {
          code: 'UNSUPPORTED_PROPERTY',
          path: childPath,
          message: `Property "${key}" must be a plain data property, not an accessor.`,
        });
        continue;
      }
      if (desc.value !== null && typeof desc.value === 'object') {
        scanUnknownValueForReservedAndAccessors(desc.value, childPath, depth + 1, ctx);
      }
    }
  } finally {
    ctx.ancestors.delete(value);
  }
}

function inspectPlainObject(
  value: unknown,
  path: string,
  allowedKeys: ReadonlySet<string> | null,
  depth: number,
  ctx: TraversalContext,
): Map<string, unknown> | null {
  if (!visitValueOccurrence(ctx, depth, path)) return null;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    pushError(ctx, {
      code: 'UNSUPPORTED_PROPERTY',
      path: path.length > 0 ? path : '$',
      message: 'Portable model objects must be plain objects without custom prototypes.',
    });
    return null;
  }
  if (ctx.ancestors.has(value)) {
    pushError(ctx, {
      code: 'CYCLIC_MODEL_REFERENCE',
      path: path.length > 0 ? path : '$',
      message: 'Portable model contains a cyclic reference.',
    });
    return null;
  }

  const ownKeys = Reflect.ownKeys(value);
  const entries = new Map<string, unknown>();
  let ok = true;

  for (let i = 0; i < ownKeys.length; i += 1) {
    const key = ownKeys[i]!;
    if (typeof key === 'symbol') {
      pushError(ctx, {
        code: 'UNSUPPORTED_PROPERTY',
        path: path.length > 0 ? path : '$',
        message: 'Portable model objects must not define symbol properties.',
      });
      ok = false;
      continue;
    }
    const childPath = joinPath(path, key);
    const desc = Object.getOwnPropertyDescriptor(value, key);
    if (desc === undefined) continue;
    if (isAccessorDescriptor(desc)) {
      pushError(ctx, {
        code: 'UNSUPPORTED_PROPERTY',
        path: childPath,
        message: `Property "${key}" must be a plain data property, not an accessor.`,
      });
      ok = false;
      continue;
    }
    if (!desc.enumerable) {
      pushError(ctx, {
        code: 'UNSUPPORTED_PROPERTY',
        path: childPath,
        message: `Property "${key}" must be an enumerable own data property.`,
      });
      ok = false;
      continue;
    }
    if (RESERVED_KEYS.has(key)) {
      pushError(ctx, {
        code: 'RESERVED_KEY',
        path: childPath,
        message: `Property "${key}" uses a reserved key name.`,
      });
      ok = false;
      continue;
    }
    if (allowedKeys !== null && !allowedKeys.has(key)) {
      pushError(ctx, {
        code: 'UNSUPPORTED_FIELD',
        path: childPath,
        message: `Unsupported field "${key}" in portable model JSON.`,
      });
      if (desc.value !== null && typeof desc.value === 'object') {
        scanUnknownValueForReservedAndAccessors(desc.value, childPath, depth + 1, ctx);
      }
      ok = false;
      continue;
    }
    entries.set(key, desc.value);
  }
  return ok ? entries : null;
}

function inspectStrictArray(
  value: unknown,
  path: string,
  depth: number,
  ctx: TraversalContext,
): unknown[] | null {
  if (!visitValueOccurrence(ctx, depth, path)) return null;
  if (!Array.isArray(value)) {
    return null;
  }
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    pushError(ctx, {
      code: 'UNSUPPORTED_PROPERTY',
      path,
      message: 'Portable model arrays must use the standard Array prototype.',
    });
    return null;
  }
  if (ctx.ancestors.has(value)) {
    pushError(ctx, {
      code: 'CYCLIC_MODEL_REFERENCE',
      path,
      message: 'Portable model contains a cyclic array reference.',
    });
    return null;
  }

  const lenDesc = Object.getOwnPropertyDescriptor(value, 'length');
  if (
    lenDesc === undefined ||
    isAccessorDescriptor(lenDesc) ||
    typeof lenDesc.value !== 'number' ||
    !Number.isSafeInteger(lenDesc.value) ||
    lenDesc.value < 0
  ) {
    pushError(ctx, {
      code: 'UNSUPPORTED_PROPERTY',
      path,
      message: 'Array has an invalid length descriptor.',
    });
    return null;
  }
  const length = lenDesc.value;
  if (ctx.visited + length > ctx.limits.maxVisits) {
    ctx.exceeded = true;
    pushError(ctx, {
      code: 'IMPORT_COMPLEXITY_EXCEEDED',
      path,
      message: `Portable model exceeds maximum visit budget (${ctx.limits.maxVisits}).`,
    });
    return null;
  }
  let ok = true;

  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'symbol') {
      pushError(ctx, {
        code: 'UNSUPPORTED_PROPERTY',
        path,
        message: 'Portable model arrays must not define symbol properties.',
      });
      ok = false;
      continue;
    }
    if (key === 'length') continue;
    if (RESERVED_KEYS.has(key)) {
      pushError(ctx, {
        code: 'RESERVED_KEY',
        path: joinPath(path, key),
        message: `Array property "${key}" uses a reserved key name.`,
      });
      ok = false;
      continue;
    }
    if (!isCanonicalArrayIndex(key, length)) {
      pushError(ctx, {
        code: 'UNSUPPORTED_PROPERTY',
        path: joinPath(path, key),
        message: `Array must not define extra property "${key}".`,
      });
      ok = false;
    }
  }

  const elements: unknown[] = [];
  for (let i = 0; i < length; i += 1) {
    const desc = Object.getOwnPropertyDescriptor(value, i);
    if (desc === undefined) {
      pushError(ctx, {
        code: 'INVALID_SPARSE_ARRAY',
        path: `${path}[${i}]`,
        message: `Array must be dense; missing element at index ${i}.`,
      });
      ok = false;
      continue;
    }
    if (isAccessorDescriptor(desc)) {
      pushError(ctx, {
        code: 'UNSUPPORTED_PROPERTY',
        path: `${path}[${i}]`,
        message: `Array element at index ${i} must be a plain data property, not an accessor.`,
      });
      ok = false;
      continue;
    }
    if (!desc.enumerable) {
      pushError(ctx, {
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

function detachPrimitiveField(
  raw: unknown,
  path: string,
  depth: number,
  ctx: TraversalContext,
): unknown {
  if (!visitValueOccurrence(ctx, depth, path)) return undefined;
  return normalizePrimitive(raw);
}

function detachValueExpr(
  raw: unknown,
  path: string,
  depth: number,
  ctx: TraversalContext,
): unknown {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return detachPrimitiveField(raw, path, depth, ctx);
  }
  const map = inspectPlainObject(raw, path, null, depth, ctx);
  if (map === null) return null;

  ctx.ancestors.add(raw);
  try {
    const op = map.get('op');
    const allowed = typeof op === 'string' ? VALUE_EXPR_KEYS_BY_OP[op] : undefined;
    if (allowed !== undefined) {
      for (const key of map.keys()) {
        if (!allowed.has(key)) {
          pushError(ctx, {
            code: 'UNSUPPORTED_FIELD',
            path: joinPath(path, key),
            message: `Unsupported field "${key}" on value expression "${op}".`,
          });
        }
      }
    }

    const out: Record<string, unknown> = {};
    if (map.has('op')) {
      defineSafeDataProp(out, 'op', detachPrimitiveField(op, `${path}.op`, depth + 1, ctx));
    }
    if (op === 'lit' && map.has('value')) {
      defineSafeDataProp(
        out,
        'value',
        detachPrimitiveField(map.get('value'), `${path}.value`, depth + 1, ctx),
      );
    } else if (op === 'var' && map.has('name')) {
      defineSafeDataProp(
        out,
        'name',
        detachPrimitiveField(map.get('name'), `${path}.name`, depth + 1, ctx),
      );
    } else if (op === 'add' || op === 'sub') {
      if (map.has('left')) {
        defineSafeDataProp(
          out,
          'left',
          detachValueExpr(map.get('left'), `${path}.left`, depth + 1, ctx),
        );
      }
      if (map.has('right')) {
        defineSafeDataProp(
          out,
          'right',
          detachValueExpr(map.get('right'), `${path}.right`, depth + 1, ctx),
        );
      }
    }
    return out;
  } finally {
    ctx.ancestors.delete(raw);
  }
}

function detachBoolExpr(
  raw: unknown,
  path: string,
  depth: number,
  ctx: TraversalContext,
): unknown {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return detachPrimitiveField(raw, path, depth, ctx);
  }
  const map = inspectPlainObject(raw, path, null, depth, ctx);
  if (map === null) return null;

  ctx.ancestors.add(raw);
  try {
    const op = map.get('op');
    const allowed = typeof op === 'string' ? BOOL_EXPR_KEYS_BY_OP[op] : undefined;
    if (allowed !== undefined) {
      for (const key of map.keys()) {
        if (!allowed.has(key)) {
          pushError(ctx, {
            code: 'UNSUPPORTED_FIELD',
            path: joinPath(path, key),
            message: `Unsupported field "${key}" on boolean expression "${op}".`,
          });
        }
      }
    }

    const out: Record<string, unknown> = {};
    if (map.has('op')) {
      defineSafeDataProp(out, 'op', detachPrimitiveField(op, `${path}.op`, depth + 1, ctx));
    }
    if (op === 'lit' && map.has('value')) {
      defineSafeDataProp(
        out,
        'value',
        detachPrimitiveField(map.get('value'), `${path}.value`, depth + 1, ctx),
      );
    } else if (op === 'var' && map.has('name')) {
      defineSafeDataProp(
        out,
        'name',
        detachPrimitiveField(map.get('name'), `${path}.name`, depth + 1, ctx),
      );
    } else if (op === 'not' && map.has('arg')) {
      defineSafeDataProp(out, 'arg', detachBoolExpr(map.get('arg'), `${path}.arg`, depth + 1, ctx));
    } else if ((op === 'and' || op === 'or') && map.has('args')) {
      const rawArgs = map.get('args');
      const arr = inspectStrictArray(rawArgs, `${path}.args`, depth, ctx);
      if (arr !== null) {
        ctx.ancestors.add(rawArgs as object);
        try {
          defineSafeDataProp(
            out,
            'args',
            arr.map((item, idx) => detachBoolExpr(item, `${path}.args[${idx}]`, depth + 1, ctx)),
          );
        } finally {
          ctx.ancestors.delete(rawArgs as object);
        }
      } else {
        defineSafeDataProp(out, 'args', rawArgs);
      }
    } else if (
      op === 'eq' ||
      op === 'neq' ||
      op === 'lt' ||
      op === 'lte' ||
      op === 'gt' ||
      op === 'gte'
    ) {
      if (map.has('left')) {
        defineSafeDataProp(
          out,
          'left',
          detachValueExpr(map.get('left'), `${path}.left`, depth + 1, ctx),
        );
      }
      if (map.has('right')) {
        defineSafeDataProp(
          out,
          'right',
          detachValueExpr(map.get('right'), `${path}.right`, depth + 1, ctx),
        );
      }
    } else if (op === 'in') {
      if (map.has('expr')) {
        defineSafeDataProp(
          out,
          'expr',
          detachValueExpr(map.get('expr'), `${path}.expr`, depth + 1, ctx),
        );
      }
      if (map.has('values')) {
        const rawVals = map.get('values');
        const arr = inspectStrictArray(rawVals, `${path}.values`, depth + 1, ctx);
        if (arr !== null) {
          ctx.ancestors.add(rawVals as object);
          try {
            defineSafeDataProp(
              out,
              'values',
              arr.map((item, idx) =>
                detachPrimitiveField(item, `${path}.values[${idx}]`, depth + 2, ctx),
              ),
            );
          } finally {
            ctx.ancestors.delete(rawVals as object);
          }
        } else {
          defineSafeDataProp(out, 'values', rawVals);
        }
      }
    }
    return out;
  } finally {
    ctx.ancestors.delete(raw);
  }
}

function buildDetachedCanonicalModel(candidate: unknown, ctx: TraversalContext): unknown {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    visitValueOccurrence(ctx, 0, '$');
    return candidate;
  }

  const rootMap = inspectPlainObject(candidate, '', ROOT_ALLOWED_KEYS, 0, ctx);
  if (rootMap === null) return null;

  ctx.ancestors.add(candidate);
  try {
    const out: Record<string, unknown> = {};
    if (rootMap.has('id')) {
      defineSafeDataProp(out, 'id', detachPrimitiveField(rootMap.get('id'), 'id', 1, ctx));
    }
    if (rootMap.has('name')) {
      defineSafeDataProp(out, 'name', detachPrimitiveField(rootMap.get('name'), 'name', 1, ctx));
    }

    const declaredVars = new Set<string>();
    if (rootMap.has('schema')) {
      const rawSchema = rootMap.get('schema');
      const schemaMap = inspectPlainObject(rawSchema, 'schema', null, 1, ctx);
      if (schemaMap !== null) {
        ctx.ancestors.add(rawSchema as object);
        try {
          const detachedSchema: Record<string, unknown> = {};
          for (const [varName, rawDef] of schemaMap.entries()) {
            const varPath = `schema.${varName}`;
            declaredVars.add(varName);
            const defMap = inspectPlainObject(rawDef, varPath, null, 2, ctx);
            if (defMap === null) {
              defineSafeDataProp(detachedSchema, varName, rawDef);
              continue;
            }
            ctx.ancestors.add(rawDef as object);
            try {
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
                for (const key of defMap.keys()) {
                  if (!allowedDefKeys.has(key)) {
                    pushError(ctx, {
                      code: 'UNSUPPORTED_FIELD',
                      path: joinPath(varPath, key),
                      message: `Unsupported field "${key}" on schema variable definition "${varName}".`,
                    });
                  }
                }
              }
              const detachedDef: Record<string, unknown> = {};
              if (defMap.has('kind')) {
                defineSafeDataProp(
                  detachedDef,
                  'kind',
                  detachPrimitiveField(kind, `${varPath}.kind`, 3, ctx),
                );
              }
              if (kind === 'enum' && defMap.has('values')) {
                const rawVals = defMap.get('values');
                const arr = inspectStrictArray(rawVals, `${varPath}.values`, 3, ctx);
                if (arr !== null) {
                  ctx.ancestors.add(rawVals as object);
                  try {
                    defineSafeDataProp(
                      detachedDef,
                      'values',
                      arr.map((v, idx) =>
                        detachPrimitiveField(v, `${varPath}.values[${idx}]`, 4, ctx),
                      ),
                    );
                  } finally {
                    ctx.ancestors.delete(rawVals as object);
                  }
                } else {
                  defineSafeDataProp(detachedDef, 'values', rawVals);
                }
              } else if (kind === 'int') {
                if (defMap.has('min')) {
                  defineSafeDataProp(
                    detachedDef,
                    'min',
                    detachPrimitiveField(defMap.get('min'), `${varPath}.min`, 3, ctx),
                  );
                }
                if (defMap.has('max')) {
                  defineSafeDataProp(
                    detachedDef,
                    'max',
                    detachPrimitiveField(defMap.get('max'), `${varPath}.max`, 3, ctx),
                  );
                }
              }
              defineSafeDataProp(detachedSchema, varName, detachedDef);
            } finally {
              ctx.ancestors.delete(rawDef as object);
            }
          }
          defineSafeDataProp(out, 'schema', detachedSchema);
        } finally {
          ctx.ancestors.delete(rawSchema as object);
        }
      } else {
        defineSafeDataProp(out, 'schema', rawSchema);
      }
    }

    if (rootMap.has('initialState')) {
      const rawInit = rootMap.get('initialState');
      const initMap = inspectPlainObject(
        rawInit,
        'initialState',
        declaredVars.size > 0 ? declaredVars : null,
        1,
        ctx,
      );
      if (initMap !== null) {
        ctx.ancestors.add(rawInit as object);
        try {
          const detachedInit: Record<string, unknown> = {};
          for (const [k, v] of initMap.entries()) {
            defineSafeDataProp(detachedInit, k, detachPrimitiveField(v, `initialState.${k}`, 2, ctx));
          }
          defineSafeDataProp(out, 'initialState', detachedInit);
        } finally {
          ctx.ancestors.delete(rawInit as object);
        }
      } else {
        defineSafeDataProp(out, 'initialState', rawInit);
      }
    }

    if (rootMap.has('rules')) {
      const rawRules = rootMap.get('rules');
      const rulesArr = inspectStrictArray(rawRules, 'rules', 1, ctx);
      if (rulesArr !== null) {
        ctx.ancestors.add(rawRules as object);
        try {
          const detachedRules: unknown[] = [];
          for (let i = 0; i < rulesArr.length; i += 1) {
            const rulePath = `rules[${i}]`;
            const rawRule = rulesArr[i];
            const ruleMap = inspectPlainObject(rawRule, rulePath, RULE_ALLOWED_KEYS, 2, ctx);
            if (ruleMap === null) {
              detachedRules.push(rawRule);
              continue;
            }
            ctx.ancestors.add(rawRule as object);
            try {
              const detachedRule: Record<string, unknown> = {};
              if (ruleMap.has('id')) {
                defineSafeDataProp(
                  detachedRule,
                  'id',
                  detachPrimitiveField(ruleMap.get('id'), `${rulePath}.id`, 3, ctx),
                );
              }
              if (ruleMap.has('label')) {
                defineSafeDataProp(
                  detachedRule,
                  'label',
                  detachPrimitiveField(ruleMap.get('label'), `${rulePath}.label`, 3, ctx),
                );
              }
              if (ruleMap.has('guard')) {
                defineSafeDataProp(
                  detachedRule,
                  'guard',
                  detachBoolExpr(ruleMap.get('guard'), `${rulePath}.guard`, 3, ctx),
                );
              }
              if (ruleMap.has('updates')) {
                const rawUpdates = ruleMap.get('updates');
                const updArr = inspectStrictArray(rawUpdates, `${rulePath}.updates`, 3, ctx);
                if (updArr !== null) {
                  ctx.ancestors.add(rawUpdates as object);
                  try {
                    const detachedUpdates: unknown[] = [];
                    for (let j = 0; j < updArr.length; j += 1) {
                      const updPath = `${rulePath}.updates[${j}]`;
                      const rawUpd = updArr[j];
                      const updMap = inspectPlainObject(rawUpd, updPath, UPDATE_ALLOWED_KEYS, 4, ctx);
                      if (updMap === null) {
                        detachedUpdates.push(rawUpd);
                        continue;
                      }
                      ctx.ancestors.add(rawUpd as object);
                      try {
                        const detachedUpd: Record<string, unknown> = {};
                        if (updMap.has('var')) {
                          defineSafeDataProp(
                            detachedUpd,
                            'var',
                            detachPrimitiveField(updMap.get('var'), `${updPath}.var`, 5, ctx),
                          );
                        }
                        if (updMap.has('value')) {
                          defineSafeDataProp(
                            detachedUpd,
                            'value',
                            detachValueExpr(updMap.get('value'), `${updPath}.value`, 5, ctx),
                          );
                        }
                        detachedUpdates.push(detachedUpd);
                      } finally {
                        ctx.ancestors.delete(rawUpd as object);
                      }
                    }
                    defineSafeDataProp(detachedRule, 'updates', detachedUpdates);
                  } finally {
                    ctx.ancestors.delete(rawUpdates as object);
                  }
                } else {
                  defineSafeDataProp(detachedRule, 'updates', rawUpdates);
                }
              }
              detachedRules.push(detachedRule);
            } finally {
              ctx.ancestors.delete(rawRule as object);
            }
          }
          defineSafeDataProp(out, 'rules', detachedRules);
        } finally {
          ctx.ancestors.delete(rawRules as object);
        }
      } else {
        defineSafeDataProp(out, 'rules', rawRules);
      }
    }

    if (rootMap.has('invariants')) {
      const rawInvs = rootMap.get('invariants');
      const invsArr = inspectStrictArray(rawInvs, 'invariants', 1, ctx);
      if (invsArr !== null) {
        ctx.ancestors.add(rawInvs as object);
        try {
          const detachedInvs: unknown[] = [];
          for (let i = 0; i < invsArr.length; i += 1) {
            const invPath = `invariants[${i}]`;
            const rawInv = invsArr[i];
            const invMap = inspectPlainObject(rawInv, invPath, INVARIANT_ALLOWED_KEYS, 2, ctx);
            if (invMap === null) {
              detachedInvs.push(rawInv);
              continue;
            }
            ctx.ancestors.add(rawInv as object);
            try {
              const detachedInv: Record<string, unknown> = {};
              if (invMap.has('id')) {
                defineSafeDataProp(
                  detachedInv,
                  'id',
                  detachPrimitiveField(invMap.get('id'), `${invPath}.id`, 3, ctx),
                );
              }
              if (invMap.has('label')) {
                defineSafeDataProp(
                  detachedInv,
                  'label',
                  detachPrimitiveField(invMap.get('label'), `${invPath}.label`, 3, ctx),
                );
              }
              if (invMap.has('holds')) {
                defineSafeDataProp(
                  detachedInv,
                  'holds',
                  detachBoolExpr(invMap.get('holds'), `${invPath}.holds`, 3, ctx),
                );
              }
              detachedInvs.push(detachedInv);
            } finally {
              ctx.ancestors.delete(rawInv as object);
            }
          }
          defineSafeDataProp(out, 'invariants', detachedInvs);
        } finally {
          ctx.ancestors.delete(rawInvs as object);
        }
      } else {
        defineSafeDataProp(out, 'invariants', rawInvs);
      }
    }

    if (rootMap.has('goal') && rootMap.get('goal') !== undefined) {
      const rawGoal = rootMap.get('goal');
      const goalMap = inspectPlainObject(rawGoal, 'goal', GOAL_ALLOWED_KEYS, 1, ctx);
      if (goalMap !== null) {
        ctx.ancestors.add(rawGoal as object);
        try {
          const detachedGoal: Record<string, unknown> = {};
          if (goalMap.has('id')) {
            defineSafeDataProp(
              detachedGoal,
              'id',
              detachPrimitiveField(goalMap.get('id'), 'goal.id', 2, ctx),
            );
          }
          if (goalMap.has('label')) {
            defineSafeDataProp(
              detachedGoal,
              'label',
              detachPrimitiveField(goalMap.get('label'), 'goal.label', 2, ctx),
            );
          }
          if (goalMap.has('reached')) {
            defineSafeDataProp(
              detachedGoal,
              'reached',
              detachBoolExpr(goalMap.get('reached'), 'goal.reached', 2, ctx),
            );
          }
          defineSafeDataProp(out, 'goal', detachedGoal);
        } finally {
          ctx.ancestors.delete(rawGoal as object);
        }
      } else {
        defineSafeDataProp(out, 'goal', rawGoal);
      }
    }

    if (rootMap.has('assumptions')) {
      const rawAsms = rootMap.get('assumptions');
      const asmArr = inspectStrictArray(rawAsms, 'assumptions', 1, ctx);
      if (asmArr !== null) {
        ctx.ancestors.add(rawAsms as object);
        try {
          const detachedAsms: unknown[] = [];
          for (let i = 0; i < asmArr.length; i += 1) {
            const asmPath = `assumptions[${i}]`;
            const rawAsm = asmArr[i];
            const asmMap = inspectPlainObject(rawAsm, asmPath, ASSUMPTION_ALLOWED_KEYS, 2, ctx);
            if (asmMap === null) {
              detachedAsms.push(rawAsm);
              continue;
            }
            ctx.ancestors.add(rawAsm as object);
            try {
              const detachedAsm: Record<string, unknown> = {};
              if (asmMap.has('id')) {
                defineSafeDataProp(
                  detachedAsm,
                  'id',
                  detachPrimitiveField(asmMap.get('id'), `${asmPath}.id`, 3, ctx),
                );
              }
              if (asmMap.has('category')) {
                defineSafeDataProp(
                  detachedAsm,
                  'category',
                  detachPrimitiveField(asmMap.get('category'), `${asmPath}.category`, 3, ctx),
                );
              }
              if (asmMap.has('statement')) {
                defineSafeDataProp(
                  detachedAsm,
                  'statement',
                  detachPrimitiveField(asmMap.get('statement'), `${asmPath}.statement`, 3, ctx),
                );
              }
              if (asmMap.has('notModeled')) {
                defineSafeDataProp(
                  detachedAsm,
                  'notModeled',
                  detachPrimitiveField(asmMap.get('notModeled'), `${asmPath}.notModeled`, 3, ctx),
                );
              }
              detachedAsms.push(detachedAsm);
            } finally {
              ctx.ancestors.delete(rawAsm as object);
            }
          }
          defineSafeDataProp(out, 'assumptions', detachedAsms);
        } finally {
          ctx.ancestors.delete(rawAsms as object);
        }
      } else {
        defineSafeDataProp(out, 'assumptions', rawAsms);
      }
    }

    return out;
  } finally {
    ctx.ancestors.delete(candidate);
  }
}

export function createModelJsonCodec(
  overrides?: Partial<ModelJsonLimits>,
  options?: ModelJsonCodecOptions,
): ModelJsonCodec {
  const limits = resolveLimits(overrides);
  const duplicateKeysPolicy = options?.duplicateKeys ?? 'reject';

  const validateValue = (candidate: unknown): ModelJsonDecodeResult => {
    try {
      const ctx: TraversalContext = {
        limits,
        visited: 0,
        exceeded: false,
        ancestors: new Set<object>(),
        errors: [],
      };
      const detached = buildDetachedCanonicalModel(candidate, ctx);
      if (ctx.errors.length > 0) {
        return { ok: false, errors: ctx.errors };
      }
      const coreErrors = validateModel(detached);
      if (coreErrors.length > 0) {
        return { ok: false, errors: coreErrors };
      }
      return { ok: true, model: detached as TransitionSystemModel };
    } catch {
      return {
        ok: false,
        errors: [
          {
            code: 'UNEXPECTED_INPUT_ERROR',
            path: '$',
            message: 'Unexpected error while validating portable model value.',
          },
        ],
      };
    }
  };

  const decode = (text: unknown): ModelJsonDecodeResult => {
    try {
      if (typeof text !== 'string') {
        return {
          ok: false,
          errors: [
            {
              code: 'INVALID_JSON_INPUT',
              path: '$',
              message: `Portable model JSON decode expects a string, received ${typeof text}.`,
            },
          ],
        };
      }
      if (text.length > limits.maxChars) {
        return {
          ok: false,
          errors: [
            {
              code: 'JSON_TOO_LARGE',
              path: '$',
              message: `JSON input exceeds maximum size of ${limits.maxChars} characters.`,
            },
          ],
        };
      }
      if (text.trim().length === 0) {
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

      const scan = scanRawJson(text, limits);
      if (!scan.ok) {
        return {
          ok: false,
          errors: [
            {
              code: scan.code,
              path: '$',
              message:
                scan.code === 'IMPORT_COMPLEXITY_EXCEEDED'
                  ? scan.message
                  : `Invalid JSON: ${scan.message}`,
            },
          ],
        };
      }
      if (duplicateKeysPolicy === 'reject' && scan.duplicateKeyErrors.length > 0) {
        return { ok: false, errors: scan.duplicateKeyErrors };
      }
      if (scan.numberErrors.length > 0) {
        return { ok: false, errors: scan.numberErrors };
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        return {
          ok: false,
          errors: [
            {
              code: 'JSON_PARSE_ERROR',
              path: '$',
              message: `Invalid JSON: ${err instanceof Error ? err.message : 'Malformed JSON syntax.'}`,
            },
          ],
        };
      }

      return validateValue(parsed);
    } catch {
      return {
        ok: false,
        errors: [
          {
            code: 'UNEXPECTED_INPUT_ERROR',
            path: '$',
            message: 'Unexpected error while decoding portable model JSON.',
          },
        ],
      };
    }
  };

  const encode = (model: unknown): ModelJsonEncodeResult => {
    try {
      const validated = validateValue(model);
      if (!validated.ok) {
        const first = validated.errors[0];
        return {
          ok: false,
          error: {
            code: 'JSON_EXPORT_ERROR',
            path: first?.path ?? '$',
            message: first?.message ?? 'Cannot export model: model failed portable validation.',
          },
        };
      }
      const pretty = JSON.stringify(validated.model, null, 2);
      const candidate =
        pretty.length <= limits.maxChars ? pretty : JSON.stringify(validated.model);
      if (candidate.length > limits.maxChars) {
        return {
          ok: false,
          error: {
            code: 'JSON_EXPORT_ERROR',
            path: '$',
            message: `Serialized JSON exceeds maximum size of ${limits.maxChars} characters.`,
          },
        };
      }
      const rawScan = scanRawJson(candidate, limits);
      if (!rawScan.ok) {
        return {
          ok: false,
          error: {
            code: 'JSON_EXPORT_ERROR',
            path: '$',
            message: rawScan.message,
          },
        };
      }
      return { ok: true, text: candidate };
    } catch (err) {
      return {
        ok: false,
        error: {
          code: 'JSON_EXPORT_ERROR',
          path: '$',
          message: err instanceof Error ? err.message : 'Unable to export model to portable JSON.',
        },
      };
    }
  };

  return Object.freeze({
    limits,
    decode,
    validateValue,
    encode,
  });
}
