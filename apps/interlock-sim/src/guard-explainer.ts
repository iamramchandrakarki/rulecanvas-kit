import {
  getEnabledTransitions,
  type BoolExpr,
  type StateSchema,
  type StateSnapshot,
  type StateValue,
  type TransitionSystemModel,
  type ValidationError,
  type ValueExpr,
} from '@rulecanvas/core';
import { formatBoolExpr, formatStateValue, formatValueExpr } from '@rulecanvas/ui';

export interface GuardClauseExplanation {
  readonly op: BoolExpr['op'];
  readonly expressionText: string;
  readonly actualValue: boolean;
  readonly expectedValue: boolean;
  readonly satisfied: boolean;
  readonly summary: string;
  readonly children: readonly GuardClauseExplanation[];
}

export interface RuleGuardExplanation {
  readonly ruleId: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly guardText: string;
  readonly rootClause: GuardClauseExplanation | null;
  readonly blockingReasons: readonly string[];
}

export type GuardExplanationResult =
  | {
      readonly ok: true;
      readonly rules: readonly RuleGuardExplanation[];
      readonly enabledRuleIds: readonly string[];
    }
  | {
      readonly ok: false;
      readonly errors: readonly ValidationError[];
    };

const MAX_EXPLAIN_DEPTH = 64;
const MAX_EXPLAIN_VISITS = 512;

interface EvalBudget {
  visits: number;
}

type EvaluatedScalar =
  | { readonly ok: true; readonly kind: 'boolean'; readonly value: boolean; readonly text: string }
  | { readonly ok: true; readonly kind: 'enum'; readonly value: string; readonly text: string }
  | { readonly ok: true; readonly kind: 'int'; readonly value: bigint; readonly text: string }
  | { readonly ok: false };

function normalizeInt(n: number): number {
  return Object.is(n, -0) ? 0 : n;
}

function consumeBudget(budget: EvalBudget, depth: number): boolean {
  if (depth > MAX_EXPLAIN_DEPTH || budget.visits >= MAX_EXPLAIN_VISITS) {
    return false;
  }
  budget.visits += 1;
  return true;
}

function evaluateValueExpr(
  expr: ValueExpr,
  schema: StateSchema,
  state: StateSnapshot,
  depth: number,
  budget: EvalBudget,
): EvaluatedScalar {
  if (!consumeBudget(budget, depth)) {
    return { ok: false };
  }

  switch (expr.op) {
    case 'lit': {
      if (typeof expr.value === 'boolean') {
        return { ok: true, kind: 'boolean', value: expr.value, text: formatStateValue(expr.value) };
      }
      if (typeof expr.value === 'string') {
        return { ok: true, kind: 'enum', value: expr.value, text: expr.value };
      }
      if (typeof expr.value === 'number' && Number.isSafeInteger(expr.value)) {
        const big = BigInt(normalizeInt(expr.value));
        return { ok: true, kind: 'int', value: big, text: big.toString() };
      }
      return { ok: false };
    }
    case 'var': {
      const def = Object.hasOwn(schema, expr.name) ? schema[expr.name] : undefined;
      if (def === undefined || !Object.hasOwn(state, expr.name)) {
        return { ok: false };
      }
      const raw = state[expr.name];
      if (def.kind === 'boolean' && typeof raw === 'boolean') {
        return { ok: true, kind: 'boolean', value: raw, text: formatStateValue(raw) };
      }
      if (def.kind === 'enum' && typeof raw === 'string') {
        return { ok: true, kind: 'enum', value: raw, text: raw };
      }
      if (def.kind === 'int' && typeof raw === 'number' && Number.isSafeInteger(raw)) {
        const big = BigInt(normalizeInt(raw));
        return { ok: true, kind: 'int', value: big, text: big.toString() };
      }
      return { ok: false };
    }
    case 'add':
    case 'sub': {
      const left = evaluateValueExpr(expr.left, schema, state, depth + 1, budget);
      const right = evaluateValueExpr(expr.right, schema, state, depth + 1, budget);
      if (!left.ok || !right.ok || left.kind !== 'int' || right.kind !== 'int') {
        return { ok: false };
      }
      const combined = expr.op === 'add' ? left.value + right.value : left.value - right.value;
      return { ok: true, kind: 'int', value: combined, text: combined.toString() };
    }
  }
}

function cmpOperatorSymbol(op: 'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte'): string {
  switch (op) {
    case 'eq':
      return '==';
    case 'neq':
      return '!=';
    case 'lt':
      return '<';
    case 'lte':
      return '<=';
    case 'gt':
      return '>';
    case 'gte':
      return '>=';
  }
}

function invertCmpOperatorSymbol(op: 'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte'): string {
  switch (op) {
    case 'eq':
      return '!=';
    case 'neq':
      return '==';
    case 'lt':
      return '>=';
    case 'lte':
      return '>';
    case 'gt':
      return '<=';
    case 'gte':
      return '<';
  }
}

function formatComparisonLiteral(expr: ValueExpr): string {
  if (expr.op === 'lit') {
    if (typeof expr.value === 'string') return expr.value;
    if (typeof expr.value === 'boolean') return expr.value ? 'true' : 'false';
    if (typeof expr.value === 'number') return String(normalizeInt(expr.value));
  }
  return formatValueExpr(expr);
}

function formatStateValueList(values: readonly StateValue[]): string {
  return values
    .map((val) => {
      if (typeof val === 'number') return String(normalizeInt(val));
      if (typeof val === 'boolean') return val ? 'true' : 'false';
      return val;
    })
    .join(', ');
}

interface InternalClauseResult {
  readonly ok: boolean;
  readonly clause: GuardClauseExplanation | null;
  readonly reasons: readonly string[];
}

function explainBoolExpr(
  expr: BoolExpr,
  expectedValue: boolean,
  schema: StateSchema,
  state: StateSnapshot,
  depth: number,
  budget: EvalBudget,
): InternalClauseResult {
  if (!consumeBudget(budget, depth)) {
    return { ok: false, clause: null, reasons: [] };
  }

  const expressionText = formatBoolExpr(expr);

  switch (expr.op) {
    case 'lit': {
      const actualValue = expr.value;
      const satisfied = actualValue === expectedValue;
      const summary = satisfied
        ? `Constant ${actualValue ? 'true' : 'false'} satisfies guard.`
        : depth === 0 && expectedValue
          ? 'Guard is permanently disabled (false).'
          : expectedValue
            ? 'Literal clause is false (requires true).'
            : depth === 0
              ? 'Constant true violates negated guard (requires false).'
              : 'Literal clause is true (requires false).';
      return {
        ok: true,
        clause: Object.freeze({
          op: expr.op,
          expressionText,
          actualValue,
          expectedValue,
          satisfied,
          summary,
          children: Object.freeze([]),
        }),
        reasons: satisfied ? [] : [summary],
      };
    }

    case 'var': {
      const def = Object.hasOwn(schema, expr.name) ? schema[expr.name] : undefined;
      if (def === undefined || def.kind !== 'boolean' || !Object.hasOwn(state, expr.name)) {
        return { ok: false, clause: null, reasons: [] };
      }
      const raw = state[expr.name];
      if (typeof raw !== 'boolean') {
        return { ok: false, clause: null, reasons: [] };
      }
      const actualValue = raw;
      const satisfied = actualValue === expectedValue;
      const summary = satisfied
        ? `${expr.name} is ${actualValue ? 'true' : 'false'} (satisfied).`
        : `${expr.name} is ${actualValue ? 'true' : 'false'} (requires ${expectedValue ? 'true' : 'false'}).`;
      return {
        ok: true,
        clause: Object.freeze({
          op: expr.op,
          expressionText,
          actualValue,
          expectedValue,
          satisfied,
          summary,
          children: Object.freeze([]),
        }),
        reasons: satisfied ? [] : [summary],
      };
    }

    case 'not': {
      const inner = explainBoolExpr(expr.arg, !expectedValue, schema, state, depth + 1, budget);
      if (!inner.ok || inner.clause === null) {
        return { ok: false, clause: null, reasons: [] };
      }
      const actualValue = !inner.clause.actualValue;
      const satisfied = actualValue === expectedValue;
      const summary = satisfied
        ? `${expressionText} holds.`
        : inner.reasons[0] ?? `${expressionText} is false.`;
      return {
        ok: true,
        clause: Object.freeze({
          op: expr.op,
          expressionText,
          actualValue,
          expectedValue,
          satisfied,
          summary,
          children: Object.freeze([inner.clause]),
        }),
        reasons: satisfied ? [] : inner.reasons.length > 0 ? inner.reasons : [summary],
      };
    }

    case 'and': {
      const childResults: InternalClauseResult[] = [];
      for (let i = 0; i < expr.args.length; i += 1) {
        const res = explainBoolExpr(
          expr.args[i]!,
          expectedValue,
          schema,
          state,
          depth + 1,
          budget,
        );
        if (!res.ok || res.clause === null) {
          return { ok: false, clause: null, reasons: [] };
        }
        childResults.push(res);
      }

      const childClauses = childResults.map((r) => r.clause!);
      const actualValue = childClauses.every((c) => c.actualValue);
      const satisfied = actualValue === expectedValue;

      if (satisfied) {
        return {
          ok: true,
          clause: Object.freeze({
            op: 'and',
            expressionText,
            actualValue,
            expectedValue,
            satisfied: true,
            summary: expectedValue
              ? `All ${childClauses.length} conjunction conditions satisfied.`
              : `Negated conjunction holds.`,
            children: Object.freeze(childClauses),
          }),
          reasons: [],
        };
      }

      const collectedReasons: string[] = [];
      if (childResults.length === 0) {
        collectedReasons.push('Empty conjunction evaluates true and violates negated requirement.');
      } else if (expectedValue) {
        for (const res of childResults) {
          if (!res.clause!.satisfied) {
            if (res.reasons.length > 0) {
              collectedReasons.push(...res.reasons);
            } else {
              collectedReasons.push(res.clause!.summary);
            }
          }
        }
      } else {
        const partSummaries = childResults.map((r) => r.reasons[0] ?? r.clause!.summary);
        collectedReasons.push(
          `Forbidden combination active (break at least one): ${partSummaries.join(' AND ')}`,
        );
      }

      return {
        ok: true,
        clause: Object.freeze({
          op: 'and',
          expressionText,
          actualValue,
          expectedValue,
          satisfied: false,
          summary: collectedReasons[0] ?? `${expressionText} failed.`,
          children: Object.freeze(childClauses),
        }),
        reasons: collectedReasons,
      };
    }

    case 'or': {
      const childResults: InternalClauseResult[] = [];
      for (let i = 0; i < expr.args.length; i += 1) {
        const res = explainBoolExpr(
          expr.args[i]!,
          expectedValue,
          schema,
          state,
          depth + 1,
          budget,
        );
        if (!res.ok || res.clause === null) {
          return { ok: false, clause: null, reasons: [] };
        }
        childResults.push(res);
      }

      const childClauses = childResults.map((r) => r.clause!);
      const actualValue = childClauses.some((c) => c.actualValue);
      const satisfied = actualValue === expectedValue;

      if (satisfied) {
        return {
          ok: true,
          clause: Object.freeze({
            op: 'or',
            expressionText,
            actualValue,
            expectedValue,
            satisfied: true,
            summary: expectedValue
              ? 'At least one alternative condition holds.'
              : 'No forbidden alternative holds.',
            children: Object.freeze(childClauses),
          }),
          reasons: [],
        };
      }

      const collectedReasons: string[] = [];
      if (childResults.length === 0) {
        collectedReasons.push('Empty disjunction is always false.');
      } else if (expectedValue) {
        const branchNotes = childResults.map((r) => r.reasons.join(' & ') || r.clause!.summary);
        collectedReasons.push(
          `None of the alternative conditions hold: (${branchNotes.join(') OR (')})`,
        );
      } else {
        for (const res of childResults) {
          if (!res.clause!.satisfied) {
            if (res.reasons.length > 0) {
              collectedReasons.push(...res.reasons);
            } else {
              collectedReasons.push(res.clause!.summary);
            }
          }
        }
      }

      return {
        ok: true,
        clause: Object.freeze({
          op: 'or',
          expressionText,
          actualValue,
          expectedValue,
          satisfied: false,
          summary: collectedReasons[0] ?? `${expressionText} failed.`,
          children: Object.freeze(childClauses),
        }),
        reasons: collectedReasons,
      };
    }

    case 'eq':
    case 'neq':
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte': {
      const left = evaluateValueExpr(expr.left, schema, state, depth + 1, budget);
      const right = evaluateValueExpr(expr.right, schema, state, depth + 1, budget);
      if (!left.ok || !right.ok || left.kind !== right.kind) {
        return { ok: false, clause: null, reasons: [] };
      }

      let actualValue: boolean;
      if (expr.op === 'eq' || expr.op === 'neq') {
        const eq = left.value === right.value;
        actualValue = expr.op === 'neq' ? !eq : eq;
      } else {
        if (left.kind !== 'int' || right.kind !== 'int') {
          return { ok: false, clause: null, reasons: [] };
        }
        actualValue =
          expr.op === 'lt'
            ? left.value < right.value
            : expr.op === 'lte'
              ? left.value <= right.value
              : expr.op === 'gt'
                ? left.value > right.value
                : left.value >= right.value;
      }

      const satisfied = actualValue === expectedValue;
      const leftLabel = formatValueExpr(expr.left);
      const rightLabel =
        expr.right.op === 'lit' ? formatComparisonLiteral(expr.right) : `${formatValueExpr(expr.right)} (${right.text})`;
      const requiredOp = expectedValue
        ? cmpOperatorSymbol(expr.op)
        : invertCmpOperatorSymbol(expr.op);
      const summary = satisfied
        ? `${leftLabel} is ${left.text} (satisfies ${requiredOp} ${rightLabel}).`
        : `${leftLabel} is ${left.text} (requires ${requiredOp} ${rightLabel}).`;

      return {
        ok: true,
        clause: Object.freeze({
          op: expr.op,
          expressionText,
          actualValue,
          expectedValue,
          satisfied,
          summary,
          children: Object.freeze([]),
        }),
        reasons: satisfied ? [] : [summary],
      };
    }

    case 'in': {
      const target = evaluateValueExpr(expr.expr, schema, state, depth + 1, budget);
      if (!target.ok) {
        return { ok: false, clause: null, reasons: [] };
      }

      let actualValue = false;
      for (const item of expr.values) {
        if (target.kind === 'boolean' && typeof item === 'boolean' && item === target.value) {
          actualValue = true;
          break;
        }
        if (target.kind === 'enum' && typeof item === 'string' && item === target.value) {
          actualValue = true;
          break;
        }
        if (
          target.kind === 'int' &&
          typeof item === 'number' &&
          Number.isSafeInteger(item) &&
          BigInt(normalizeInt(item)) === target.value
        ) {
          actualValue = true;
          break;
        }
      }

      const satisfied = actualValue === expectedValue;
      const targetLabel = formatValueExpr(expr.expr);
      const listLabel = formatStateValueList(expr.values);
      const summary = satisfied
        ? `${targetLabel} is ${target.text} (satisfied).`
        : expectedValue
          ? `${targetLabel} is ${target.text} (requires one of [${listLabel}]).`
          : `${targetLabel} is ${target.text} (must not be in [${listLabel}]).`;

      return {
        ok: true,
        clause: Object.freeze({
          op: 'in',
          expressionText,
          actualValue,
          expectedValue,
          satisfied,
          summary,
          children: Object.freeze([]),
        }),
        reasons: satisfied ? [] : [summary],
      };
    }
  }
}

function readOwnRuleAt(
  rawRules: unknown,
  index: number,
): TransitionSystemModel['rules'][number] | null {
  if (!Array.isArray(rawRules)) return null;
  const desc = Object.getOwnPropertyDescriptor(rawRules, index);
  if (
    desc === undefined ||
    Object.hasOwn(desc, 'get') ||
    Object.hasOwn(desc, 'set') ||
    desc.get !== undefined ||
    desc.set !== undefined ||
    typeof desc.value !== 'object' ||
    desc.value === null
  ) {
    return null;
  }
  return desc.value as TransitionSystemModel['rules'][number];
}

export function explainRuleGuards(
  model: TransitionSystemModel,
  state: StateSnapshot,
): GuardExplanationResult {
  const coreResult = getEnabledTransitions(model, state);
  if (!coreResult.ok) {
    return Object.freeze({
      ok: false,
      errors: coreResult.errors,
    });
  }

  let rawRules: unknown = null;
  let schema: StateSchema | null = null;
  try {
    const modelObj = model as unknown as Record<string, unknown>;
    const rulesDesc = Object.getOwnPropertyDescriptor(modelObj, 'rules');
    const schemaDesc = Object.getOwnPropertyDescriptor(modelObj, 'schema');
    if (
      rulesDesc !== undefined &&
      !Object.hasOwn(rulesDesc, 'get') &&
      !Object.hasOwn(rulesDesc, 'set')
    ) {
      rawRules = rulesDesc.value;
    }
    if (
      schemaDesc !== undefined &&
      !Object.hasOwn(schemaDesc, 'get') &&
      !Object.hasOwn(schemaDesc, 'set') &&
      typeof schemaDesc.value === 'object' &&
      schemaDesc.value !== null
    ) {
      schema = schemaDesc.value as StateSchema;
    }
  } catch {
    rawRules = null;
    schema = null;
  }

  const rules: RuleGuardExplanation[] = coreResult.transitions.map((coreTransition, index) => {
    const coreEnabled = coreTransition.enabled;
    const rule = readOwnRuleAt(rawRules, index);
    if (rule === null || schema === null) {
      const fallbackReasons = coreEnabled
        ? []
        : [`Transition guard evaluated false in engine for ${coreTransition.ruleId}.`];
      return Object.freeze({
        ruleId: coreTransition.ruleId,
        label: coreTransition.label,
        enabled: coreEnabled,
        guardText: '<unavailable>',
        rootClause: null,
        blockingReasons: Object.freeze(fallbackReasons),
      });
    }

    let guardText = '<unavailable>';
    let explained: InternalClauseResult = { ok: false, clause: null, reasons: [] };
    try {
      guardText = formatBoolExpr(rule.guard);
      const budget: EvalBudget = { visits: 0 };
      explained = explainBoolExpr(rule.guard, true, schema, state, 0, budget);
    } catch {
      explained = { ok: false, clause: null, reasons: [] };
    }

    if (
      !explained.ok ||
      explained.clause === null ||
      explained.clause.actualValue !== coreEnabled
    ) {
      const fallbackReasons = coreEnabled
        ? []
        : [`Guard evaluated false in engine: ${guardText}.`];
      return Object.freeze({
        ruleId: coreTransition.ruleId,
        label: coreTransition.label,
        enabled: coreEnabled,
        guardText,
        rootClause: null,
        blockingReasons: Object.freeze(fallbackReasons),
      });
    }

    const blockingReasons = coreEnabled
      ? []
      : explained.reasons.length > 0
        ? explained.reasons
        : [`Guard evaluated false: ${guardText}.`];

    return Object.freeze({
      ruleId: coreTransition.ruleId,
      label: coreTransition.label,
      enabled: coreEnabled,
      guardText,
      rootClause: explained.clause,
      blockingReasons: Object.freeze(blockingReasons),
    });
  });

  return Object.freeze({
    ok: true,
    rules: Object.freeze(rules),
    enabledRuleIds: coreResult.enabledRuleIds,
  });
}
