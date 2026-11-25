import type {
  BoolExpr,
  StateValue,
  TransitionRule,
  UpdateAssignment,
  ValueExpr,
  VarDef,
} from '@rulecanvas/core';
import { isPlainObject, readOwnDataProp, readOwnStringArray, readSafeArray } from './safe-input.js';

export interface FormattedRuleSummary {
  readonly id: string;
  readonly label: string;
  readonly guardText: string;
  readonly updatesText: readonly string[];
}

const PREC_OR = 0;
const PREC_AND = 1;
const PREC_CMP = 2;
const PREC_NOT = 3;
const PREC_ATOM = 4;

const MAX_FORMAT_DEPTH = 64;
const MAX_FORMAT_VISITS = 512;

const SAFE_BARE_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED_EXPR_KEYWORDS = new Set(['true', 'false', 'in', 'and', 'or', 'not']);

function formatVarName(name: string): string {
  if (SAFE_BARE_IDENT_RE.test(name) && !RESERVED_EXPR_KEYWORDS.has(name)) {
    return name;
  }
  const inner = JSON.stringify(name).slice(1, -1).replace(/`/g, '\\`');
  return `\`${inner}\``;
}

interface WalkBudget {
  visits: number;
}

function consumeVisit(budget: WalkBudget, depth: number): boolean {
  if (depth > MAX_FORMAT_DEPTH || budget.visits >= MAX_FORMAT_VISITS) {
    return false;
  }
  budget.visits += 1;
  return true;
}

export function formatStateValue(value: StateValue): string {
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      return '<invalid>';
    }
    return Object.is(value, -0) ? '0' : String(value);
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  return '<invalid>';
}

export function tryFormatVarDef(def: unknown): string | null {
  try {
    if (!isPlainObject(def)) {
      return null;
    }
    const kindProp = readOwnDataProp(def, 'kind');
    if (kindProp.kind !== 'value' || typeof kindProp.value !== 'string') {
      return null;
    }
    if (kindProp.value === 'boolean') {
      return 'boolean';
    }
    if (kindProp.value === 'enum') {
      const valuesProp = readOwnDataProp(def, 'values');
      if (valuesProp.kind !== 'value') {
        return null;
      }
      const values = readOwnStringArray(valuesProp.value, 256);
      if (!values.ok || values.items.length === 0) {
        return null;
      }
      return `enum (${values.items.map((v) => JSON.stringify(v)).join(' | ')})`;
    }
    if (kindProp.value === 'int') {
      const minProp = readOwnDataProp(def, 'min');
      const maxProp = readOwnDataProp(def, 'max');
      if (
        minProp.kind !== 'value' ||
        typeof minProp.value !== 'number' ||
        !Number.isSafeInteger(minProp.value) ||
        maxProp.kind !== 'value' ||
        typeof maxProp.value !== 'number' ||
        !Number.isSafeInteger(maxProp.value) ||
        minProp.value > maxProp.value
      ) {
        return null;
      }
      return `int [${formatStateValue(minProp.value)}..${formatStateValue(maxProp.value)}]`;
    }
    return null;
  } catch {
    return null;
  }
}

export function formatVarDef(def: VarDef): string {
  return tryFormatVarDef(def) ?? '<invalid>';
}

function formatValueExprInner(expr: unknown, depth: number, budget: WalkBudget): string | null {
  if (!consumeVisit(budget, depth) || !isPlainObject(expr)) {
    return null;
  }
  const opProp = readOwnDataProp(expr, 'op');
  if (opProp.kind !== 'value' || typeof opProp.value !== 'string') {
    return null;
  }

  switch (opProp.value) {
    case 'lit': {
      const valProp = readOwnDataProp(expr, 'value');
      if (valProp.kind !== 'value') return null;
      const formatted = formatStateValue(valProp.value as StateValue);
      return formatted === '<invalid>' ? null : formatted;
    }
    case 'var': {
      const nameProp = readOwnDataProp(expr, 'name');
      if (nameProp.kind !== 'value' || typeof nameProp.value !== 'string') return null;
      return formatVarName(nameProp.value);
    }
    case 'add': {
      const leftProp = readOwnDataProp(expr, 'left');
      const rightProp = readOwnDataProp(expr, 'right');
      if (leftProp.kind !== 'value' || rightProp.kind !== 'value') return null;
      const left = formatValueExprInner(leftProp.value, depth + 1, budget);
      const right = formatValueExprInner(rightProp.value, depth + 1, budget);
      if (left === null || right === null) return null;
      return `${left} + ${right}`;
    }
    case 'sub': {
      const leftProp = readOwnDataProp(expr, 'left');
      const rightProp = readOwnDataProp(expr, 'right');
      if (leftProp.kind !== 'value' || rightProp.kind !== 'value') return null;
      const left = formatValueExprInner(leftProp.value, depth + 1, budget);
      const right = formatValueExprInner(rightProp.value, depth + 1, budget);
      if (left === null || right === null) return null;
      let needsParens = false;
      if (isPlainObject(rightProp.value)) {
        const rightOp = readOwnDataProp(rightProp.value, 'op');
        if (rightOp.kind === 'value' && (rightOp.value === 'add' || rightOp.value === 'sub')) {
          needsParens = true;
        }
      }
      return `${left} - ${needsParens ? `(${right})` : right}`;
    }
    default:
      return null;
  }
}

export function formatValueExpr(expr: ValueExpr): string {
  try {
    return formatValueExprInner(expr, 0, { visits: 0 }) ?? '<invalid>';
  } catch {
    return '<invalid>';
  }
}

function getBoolPrecedenceInner(expr: unknown, depth: number, budget: WalkBudget): number | null {
  if (!consumeVisit(budget, depth) || !isPlainObject(expr)) {
    return null;
  }
  const opProp = readOwnDataProp(expr, 'op');
  if (opProp.kind !== 'value' || typeof opProp.value !== 'string') {
    return null;
  }
  switch (opProp.value) {
    case 'lit':
    case 'var':
      return PREC_ATOM;
    case 'not':
      return PREC_NOT;
    case 'eq':
    case 'neq':
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte':
    case 'in':
      return PREC_CMP;
    case 'and':
    case 'or': {
      const argsProp = readOwnDataProp(expr, 'args');
      if (argsProp.kind !== 'value') return null;
      const args = readSafeArray(argsProp.value, 256);
      if (!args.ok) return null;
      if (args.items.length === 0) {
        return PREC_ATOM;
      }
      if (args.items.length === 1) {
        return getBoolPrecedenceInner(args.items[0], depth + 1, budget);
      }
      return opProp.value === 'and' ? PREC_AND : PREC_OR;
    }
    default:
      return null;
  }
}

function formatBoolChild(
  child: unknown,
  minPrecedence: number,
  depth: number,
  budget: WalkBudget,
): string | null {
  const rendered = formatBoolExprInner(child, depth, budget);
  if (rendered === null) return null;
  const prec = getBoolPrecedenceInner(child, depth, budget);
  if (prec === null) return null;
  return prec < minPrecedence ? `(${rendered})` : rendered;
}

function formatBoolExprInner(expr: unknown, depth: number, budget: WalkBudget): string | null {
  if (!consumeVisit(budget, depth) || !isPlainObject(expr)) {
    return null;
  }
  const opProp = readOwnDataProp(expr, 'op');
  if (opProp.kind !== 'value' || typeof opProp.value !== 'string') {
    return null;
  }

  switch (opProp.value) {
    case 'lit': {
      const valProp = readOwnDataProp(expr, 'value');
      if (valProp.kind !== 'value' || typeof valProp.value !== 'boolean') return null;
      return valProp.value ? 'true' : 'false';
    }
    case 'var': {
      const nameProp = readOwnDataProp(expr, 'name');
      if (nameProp.kind !== 'value' || typeof nameProp.value !== 'string') return null;
      return formatVarName(nameProp.value);
    }
    case 'eq':
    case 'neq':
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte': {
      const leftProp = readOwnDataProp(expr, 'left');
      const rightProp = readOwnDataProp(expr, 'right');
      if (leftProp.kind !== 'value' || rightProp.kind !== 'value') return null;
      const left = formatValueExprInner(leftProp.value, depth + 1, budget);
      const right = formatValueExprInner(rightProp.value, depth + 1, budget);
      if (left === null || right === null) return null;
      const sym =
        opProp.value === 'eq'
          ? '=='
          : opProp.value === 'neq'
            ? '!='
            : opProp.value === 'lt'
              ? '<'
              : opProp.value === 'lte'
                ? '<='
                : opProp.value === 'gt'
                  ? '>'
                  : '>=';
      return `${left} ${sym} ${right}`;
    }
    case 'in': {
      const targetProp = readOwnDataProp(expr, 'expr');
      const valuesProp = readOwnDataProp(expr, 'values');
      if (targetProp.kind !== 'value' || valuesProp.kind !== 'value') return null;
      const target = formatValueExprInner(targetProp.value, depth + 1, budget);
      const values = readSafeArray(valuesProp.value, 256);
      if (target === null || !values.ok) return null;
      const formattedItems: string[] = [];
      for (const item of values.items) {
        const formatted = formatStateValue(item as StateValue);
        if (formatted === '<invalid>') return null;
        formattedItems.push(formatted);
      }
      return `${target} in [${formattedItems.join(', ')}]`;
    }
    case 'not': {
      const argProp = readOwnDataProp(expr, 'arg');
      if (argProp.kind !== 'value') return null;
      const child = formatBoolChild(argProp.value, PREC_NOT, depth + 1, budget);
      return child === null ? null : `!${child}`;
    }
    case 'and':
    case 'or': {
      const argsProp = readOwnDataProp(expr, 'args');
      if (argsProp.kind !== 'value') return null;
      const args = readSafeArray(argsProp.value, 256);
      if (!args.ok) return null;
      if (args.items.length === 0) {
        return opProp.value === 'and' ? 'true' : 'false';
      }
      if (args.items.length === 1) {
        return formatBoolExprInner(args.items[0], depth + 1, budget);
      }
      const minPrec = opProp.value === 'and' ? PREC_AND : PREC_OR;
      const sep = opProp.value === 'and' ? ' && ' : ' || ';
      const parts: string[] = [];
      for (const item of args.items) {
        const rendered = formatBoolChild(item, minPrec, depth + 1, budget);
        if (rendered === null) return null;
        parts.push(rendered);
      }
      return parts.join(sep);
    }
    default:
      return null;
  }
}

export function tryFormatBoolExpr(expr: unknown): string | null {
  try {
    return formatBoolExprInner(expr, 0, { visits: 0 });
  } catch {
    return null;
  }
}

export function formatBoolExpr(expr: BoolExpr): string {
  return tryFormatBoolExpr(expr) ?? '<invalid>';
}

export function formatUpdateAssignment(update: UpdateAssignment): string {
  try {
    if (!isPlainObject(update)) {
      return '<invalid>';
    }
    const varProp = readOwnDataProp(update, 'var');
    const valProp = readOwnDataProp(update, 'value');
    if (varProp.kind !== 'value' || typeof varProp.value !== 'string' || valProp.kind !== 'value') {
      return '<invalid>';
    }
    const valueText = formatValueExprInner(valProp.value, 0, { visits: 0 });
    if (valueText === null) {
      return '<invalid>';
    }
    return `${formatVarName(varProp.value)} := ${valueText}`;
  } catch {
    return '<invalid>';
  }
}

export function formatRuleSummary(rule: TransitionRule): FormattedRuleSummary {
  try {
    if (!isPlainObject(rule)) {
      return Object.freeze({
        id: '<invalid>',
        label: '<invalid>',
        guardText: '<invalid>',
        updatesText: Object.freeze([]),
      });
    }
    const idProp = readOwnDataProp(rule, 'id');
    const labelProp = readOwnDataProp(rule, 'label');
    const guardProp = readOwnDataProp(rule, 'guard');
    const updatesProp = readOwnDataProp(rule, 'updates');
    if (
      idProp.kind !== 'value' ||
      typeof idProp.value !== 'string' ||
      labelProp.kind !== 'value' ||
      typeof labelProp.value !== 'string' ||
      guardProp.kind !== 'value' ||
      updatesProp.kind !== 'value'
    ) {
      return Object.freeze({
        id: '<invalid>',
        label: '<invalid>',
        guardText: '<invalid>',
        updatesText: Object.freeze([]),
      });
    }
    const updatesArr = readSafeArray(updatesProp.value, 256);
    if (!updatesArr.ok) {
      return Object.freeze({
        id: '<invalid>',
        label: '<invalid>',
        guardText: '<invalid>',
        updatesText: Object.freeze([]),
      });
    }
    const updatesText = updatesArr.items.map((u) => formatUpdateAssignment(u as UpdateAssignment));
    return Object.freeze({
      id: idProp.value,
      label: labelProp.value,
      guardText: formatBoolExpr(guardProp.value as BoolExpr),
      updatesText: Object.freeze(updatesText),
    });
  } catch {
    return Object.freeze({
      id: '<invalid>',
      label: '<invalid>',
      guardText: '<invalid>',
      updatesText: Object.freeze([]),
    });
  }
}
