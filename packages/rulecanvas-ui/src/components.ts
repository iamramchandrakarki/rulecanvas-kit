import type {
  ModelAssumption,
  StateSnapshot,
  StateValue,
  TransitionSystemModel,
  ValidationError,
  VerifyResult,
} from '@rulecanvas/core';
import { formatStateValue, tryFormatBoolExpr, tryFormatVarDef } from './format.js';
import type { ReplaySession } from './replay-controller.js';
import {
  isPlainObject,
  isPrimitiveStateValue,
  MAX_REPLAY_STEPS,
  MAX_SAFE_ARRAY_LENGTH,
  readOwnDataProp,
  readOwnStringArray,
  readSafeArray,
} from './safe-input.js';

export type VerdictTone = 'success' | 'warning' | 'danger' | 'error';

export interface VerdictStatItem {
  readonly id: string;
  readonly label: string;
  readonly value: string;
}

export interface VerdictSummaryView {
  readonly status: VerifyResult['status'];
  readonly badge: string;
  readonly symbol: string;
  readonly tone: VerdictTone;
  readonly role: 'status' | 'alert';
  readonly headline: string;
  readonly detail: string;
  readonly vacuousGoalWarning: boolean;
  readonly goalReachable?: boolean;
  readonly stats: readonly VerdictStatItem[];
  readonly violatedInvariantIds: readonly string[];
  readonly errorCount: number;
  readonly traceLength?: number;
  readonly inconclusiveReason?: 'MAX_STATES' | 'MAX_DEPTH';
  readonly completedDepth?: number;
  readonly frontierRemaining?: number;
}

export interface StateTableRowView {
  readonly name: string;
  readonly domainText: string;
  readonly valueText: string;
  readonly changed: boolean;
  readonly changeLabel: 'Modified' | 'Unchanged';
}

export interface StateTableView {
  readonly modelId: string;
  readonly modelName: string;
  readonly rows: readonly StateTableRowView[];
  readonly changedCount: number;
}

export interface InvariantRowView {
  readonly id: string;
  readonly label: string;
  readonly expressionText: string;
  readonly violated: boolean;
  readonly status: 'PASS' | 'VIOLATED';
}

export interface GoalPanelView {
  readonly id: string;
  readonly label: string;
  readonly expressionText: string;
  readonly reached: boolean | null;
  readonly status: 'REACHED' | 'NOT REACHED' | 'NOT EVALUATED';
}

export interface InvariantsPanelView {
  readonly status: 'VALID' | 'INVALID';
  readonly invariants: readonly InvariantRowView[];
  readonly goal?: GoalPanelView;
  readonly error?: string;
}

export function escapeHtml(value: string): string {
  if (typeof value !== 'string') {
    return '';
  }
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function invalidFallbackVerdict(detail: string): VerdictSummaryView {
  return Object.freeze({
    status: 'INVALID',
    badge: 'INVALID',
    symbol: '!',
    tone: 'error',
    role: 'alert',
    headline: 'Model or verification input is invalid (1 error).',
    detail,
    vacuousGoalWarning: false,
    stats: Object.freeze([]),
    violatedInvariantIds: Object.freeze([]),
    errorCount: 1,
  });
}

function parseSafeStats(
  raw: Record<string, unknown>,
  required: boolean,
): { readonly ok: true; readonly items: readonly VerdictStatItem[] } | { readonly ok: false } {
  const statsProp = readOwnDataProp(raw, 'stats');
  if (statsProp.kind === 'accessor') {
    return { ok: false };
  }
  if (statsProp.kind === 'missing' || statsProp.value === undefined) {
    return required ? { ok: false } : { ok: true, items: Object.freeze([]) };
  }
  if (!isPlainObject(statsProp.value)) {
    return { ok: false };
  }

  const theoreticalProp = readOwnDataProp(statsProp.value, 'theoreticalStates');
  const exploredProp = readOwnDataProp(statsProp.value, 'statesExplored');
  const transitionsProp = readOwnDataProp(statsProp.value, 'transitionsEvaluated');
  const maxDepthProp = readOwnDataProp(statsProp.value, 'maxDepthReached');
  const deadlocksProp = readOwnDataProp(statsProp.value, 'deadlockStatesFound');

  if (
    theoreticalProp.kind !== 'value' ||
    typeof theoreticalProp.value !== 'string' ||
    exploredProp.kind !== 'value' ||
    typeof exploredProp.value !== 'number' ||
    !Number.isSafeInteger(exploredProp.value) ||
    exploredProp.value < 0 ||
    transitionsProp.kind !== 'value' ||
    typeof transitionsProp.value !== 'number' ||
    !Number.isSafeInteger(transitionsProp.value) ||
    transitionsProp.value < 0 ||
    maxDepthProp.kind !== 'value' ||
    typeof maxDepthProp.value !== 'number' ||
    !Number.isSafeInteger(maxDepthProp.value) ||
    maxDepthProp.value < 0 ||
    deadlocksProp.kind !== 'value' ||
    typeof deadlocksProp.value !== 'number' ||
    !Number.isSafeInteger(deadlocksProp.value) ||
    deadlocksProp.value < 0
  ) {
    return { ok: false };
  }

  return {
    ok: true,
    items: Object.freeze([
      Object.freeze({
        id: 'theoreticalStates',
        label: 'Theoretical states',
        value: theoreticalProp.value,
      }),
      Object.freeze({
        id: 'statesExplored',
        label: 'States explored',
        value: String(exploredProp.value),
      }),
      Object.freeze({
        id: 'transitionsEvaluated',
        label: 'Transitions evaluated',
        value: String(transitionsProp.value),
      }),
      Object.freeze({
        id: 'maxDepthReached',
        label: 'Max depth reached',
        value: String(maxDepthProp.value),
      }),
      Object.freeze({
        id: 'deadlockStatesFound',
        label: 'Deadlock states',
        value: String(deadlocksProp.value),
      }),
    ]),
  };
}

function readOptionalGoalReachable(
  raw: Record<string, unknown>,
  allowFalse: boolean,
):
  | { readonly ok: true; readonly present: false }
  | { readonly ok: true; readonly present: true; readonly value: boolean }
  | { readonly ok: false } {
  const prop = readOwnDataProp(raw, 'goalReachable');
  if (prop.kind === 'accessor') {
    return { ok: false };
  }
  if (prop.kind === 'missing' || prop.value === undefined) {
    return { ok: true, present: false };
  }
  if (typeof prop.value !== 'boolean') {
    return { ok: false };
  }
  if (!allowFalse && prop.value === false) {
    return { ok: false };
  }
  return { ok: true, present: true, value: prop.value };
}

export function buildVerdictSummaryView(result: VerifyResult): VerdictSummaryView {
  try {
    const raw: unknown = result;
    if (!isPlainObject(raw)) {
      return invalidFallbackVerdict('Verification result must be a plain object.');
    }

    const statusProp = readOwnDataProp(raw, 'status');
    if (statusProp.kind !== 'value' || typeof statusProp.value !== 'string') {
      return invalidFallbackVerdict('Verification result status must be a string.');
    }

    switch (statusProp.value) {
      case 'VERIFIED': {
        const statsRead = parseSafeStats(raw, true);
        const goalRead = readOptionalGoalReachable(raw, true);
        if (!statsRead.ok || !goalRead.ok) {
          return invalidFallbackVerdict('VERIFIED result contains invalid stats or goalReachable.');
        }

        const vacuous = goalRead.present && goalRead.value === false;
        const badge = vacuous ? 'VERIFIED (GOAL UNREACHABLE)' : 'VERIFIED';
        const symbol = vacuous ? '!' : '✓';
        const tone: VerdictTone = vacuous ? 'warning' : 'success';
        const headline = vacuous
          ? 'All declared invariants hold, but the declared goal is unreachable.'
          : goalRead.present && goalRead.value === true
            ? 'All declared invariants hold and the declared goal is reachable.'
            : 'All declared invariants hold across all reachable states.';
        const detail = vacuous
          ? 'Every reachable state within the declared model satisfies all invariants, yet no reachable state satisfies the goal predicate.'
          : 'Exhaustive breadth-first exploration checked every reachable state in the declared model under its stated assumptions.';

        return Object.freeze({
          status: 'VERIFIED',
          badge,
          symbol,
          tone,
          role: 'status',
          headline,
          detail,
          vacuousGoalWarning: vacuous,
          ...(goalRead.present ? { goalReachable: goalRead.value } : {}),
          stats: statsRead.items,
          violatedInvariantIds: Object.freeze([]),
          errorCount: 0,
        });
      }

      case 'VIOLATED': {
        const statsRead = parseSafeStats(raw, true);
        const goalRead = readOptionalGoalReachable(raw, false);
        const traceProp = readOwnDataProp(raw, 'trace');
        const violatedProp = readOwnDataProp(raw, 'violatedInvariantIds');
        if (
          !statsRead.ok ||
          !goalRead.ok ||
          traceProp.kind !== 'value' ||
          violatedProp.kind !== 'value'
        ) {
          return invalidFallbackVerdict('VIOLATED result contains invalid fields.');
        }
        const traceRead = readSafeArray(traceProp.value, MAX_SAFE_ARRAY_LENGTH);
        const violatedRead = readOwnStringArray(violatedProp.value, 256);
        if (!traceRead.ok || !violatedRead.ok || violatedRead.items.length === 0) {
          return invalidFallbackVerdict('VIOLATED result must include valid trace and violatedInvariantIds.');
        }

        const traceLength = traceRead.items.length;
        const headline =
          traceLength === 0
            ? 'Initial state violates one or more declared invariants.'
            : `Counterexample found in ${traceLength} ${traceLength === 1 ? 'step' : 'steps'}.`;
        const frozenViolated = Object.freeze([...violatedRead.items]);
        const detail = `Violated invariants: ${frozenViolated.join(', ')}.`;

        return Object.freeze({
          status: 'VIOLATED',
          badge: 'VIOLATED',
          symbol: '✗',
          tone: 'danger',
          role: 'alert',
          headline,
          detail,
          vacuousGoalWarning: false,
          ...(goalRead.present ? { goalReachable: goalRead.value } : {}),
          stats: statsRead.items,
          violatedInvariantIds: frozenViolated,
          errorCount: 0,
          traceLength,
        });
      }

      case 'INCONCLUSIVE': {
        const statsRead = parseSafeStats(raw, true);
        const goalRead = readOptionalGoalReachable(raw, false);
        const reasonProp = readOwnDataProp(raw, 'reason');
        const depthProp = readOwnDataProp(raw, 'completedDepth');
        const frontierProp = readOwnDataProp(raw, 'frontierRemaining');
        if (
          !statsRead.ok ||
          !goalRead.ok ||
          reasonProp.kind !== 'value' ||
          (reasonProp.value !== 'MAX_STATES' && reasonProp.value !== 'MAX_DEPTH') ||
          depthProp.kind !== 'value' ||
          typeof depthProp.value !== 'number' ||
          !Number.isSafeInteger(depthProp.value) ||
          frontierProp.kind !== 'value' ||
          typeof frontierProp.value !== 'number' ||
          !Number.isSafeInteger(frontierProp.value) ||
          frontierProp.value < 0
        ) {
          return invalidFallbackVerdict('INCONCLUSIVE result contains invalid limit metadata.');
        }

        const frontierLabel = frontierProp.value === 1 ? 'state' : 'states';
        return Object.freeze({
          status: 'INCONCLUSIVE',
          badge: 'INCONCLUSIVE',
          symbol: '…',
          tone: 'warning',
          role: 'status',
          headline: `Exploration stopped at ${reasonProp.value} limit.`,
          detail: `Completed depth ${depthProp.value} with ${frontierProp.value} frontier ${frontierLabel} remaining.`,
          vacuousGoalWarning: false,
          ...(goalRead.present ? { goalReachable: goalRead.value } : {}),
          stats: statsRead.items,
          violatedInvariantIds: Object.freeze([]),
          errorCount: 0,
          inconclusiveReason: reasonProp.value,
          completedDepth: depthProp.value,
          frontierRemaining: frontierProp.value,
        });
      }

      case 'INVALID': {
        const statsRead = parseSafeStats(raw, false);
        const errorsProp = readOwnDataProp(raw, 'errors');
        if (!statsRead.ok || errorsProp.kind !== 'value') {
          return invalidFallbackVerdict('Model validation failed.');
        }
        const errorsRead = readSafeArray(errorsProp.value, MAX_SAFE_ARRAY_LENGTH);
        if (!errorsRead.ok || errorsRead.items.length === 0) {
          return invalidFallbackVerdict('Model validation failed.');
        }

        let firstMessage = 'Model validation failed.';
        const firstEntry = errorsRead.items[0];
        if (isPlainObject(firstEntry)) {
          const msgProp = readOwnDataProp(firstEntry, 'message');
          if (msgProp.kind === 'value' && typeof msgProp.value === 'string') {
            firstMessage = msgProp.value;
          }
        }

        let traceLength: number | undefined;
        try {
          const traceProp = readOwnDataProp(raw, 'trace');
          if (traceProp.kind === 'value' && traceProp.value !== undefined) {
            const traceRead = readSafeArray(traceProp.value, MAX_SAFE_ARRAY_LENGTH);
            if (traceRead.ok) {
              traceLength = traceRead.items.length;
            }
          }
        } catch {
          traceLength = undefined;
        }

        const errorCount = errorsRead.items.length;
        const errorWord = errorCount === 1 ? 'error' : 'errors';

        return Object.freeze({
          status: 'INVALID',
          badge: 'INVALID',
          symbol: '!',
          tone: 'error',
          role: 'alert',
          headline: `Model or verification input is invalid (${errorCount} ${errorWord}).`,
          detail: firstMessage,
          vacuousGoalWarning: false,
          stats: statsRead.items,
          violatedInvariantIds: Object.freeze([]),
          errorCount,
          ...(traceLength !== undefined ? { traceLength } : {}),
        });
      }

      default:
        return invalidFallbackVerdict('Unrecognized verification verdict status.');
    }
  } catch {
    return invalidFallbackVerdict('Unexpected error while inspecting verification result.');
  }
}

export function renderVerdictSummaryHtml(result: VerifyResult): string {
  try {
    const view = buildVerdictSummaryView(result);
    const parts: string[] = [];

    const vacuousAttr = view.vacuousGoalWarning ? ' data-vacuous-goal="true"' : '';
    parts.push(
      `<section class="rc-verdict" role="${escapeHtml(view.role)}" aria-live="polite" data-status="${escapeHtml(view.status)}" data-tone="${escapeHtml(view.tone)}"${vacuousAttr}>`,
    );
    parts.push(
      `<header class="rc-verdict-header"><span class="rc-badge" data-status="${escapeHtml(view.status)}" data-tone="${escapeHtml(view.tone)}"><span aria-hidden="true">${escapeHtml(view.symbol)}</span> ${escapeHtml(view.badge)}</span><p class="rc-verdict-headline">${escapeHtml(view.headline)}</p></header>`,
    );
    parts.push(`<p class="rc-verdict-detail">${escapeHtml(view.detail)}</p>`);

    if (Object.hasOwn(view, 'goalReachable') && view.goalReachable !== undefined) {
      const goalStatus = view.goalReachable ? 'reachable' : 'unreachable';
      const goalText = view.goalReachable ? 'Goal reachable: Yes' : 'Goal reachable: No';
      parts.push(`<p class="rc-verdict-goal" data-goal-status="${goalStatus}">${escapeHtml(goalText)}</p>`);
    }

    if (Object.hasOwn(view, 'inconclusiveReason') && view.inconclusiveReason !== undefined) {
      parts.push(
        `<dl class="rc-inconclusive-meta"><dt>Limit reason</dt><dd><code>${escapeHtml(view.inconclusiveReason)}</code></dd><dt>Completed depth</dt><dd>${escapeHtml(String(view.completedDepth ?? 0))}</dd><dt>Frontier remaining</dt><dd>${escapeHtml(String(view.frontierRemaining ?? 0))}</dd></dl>`,
      );
    }

    if (view.violatedInvariantIds.length > 0) {
      const invItems = view.violatedInvariantIds
        .map((id) => `<li><code>${escapeHtml(id)}</code></li>`)
        .join('');
      parts.push(
        `<div class="rc-verdict-violations"><p>Violated invariants</p><ul>${invItems}</ul></div>`,
      );
    }

    if (view.stats.length > 0) {
      const statEntries = view.stats
        .map(
          (item) =>
            `<div class="rc-stat" data-stat-id="${escapeHtml(item.id)}"><dt>${escapeHtml(item.label)}</dt><dd>${escapeHtml(item.value)}</dd></div>`,
        )
        .join('');
      parts.push(`<dl class="rc-stats">${statEntries}</dl>`);
    }

    parts.push('</section>');
    return parts.join('');
  } catch {
    return renderVerdictSummaryHtml({
      status: 'INVALID',
      errors: [{ code: 'UNEXPECTED_INPUT_ERROR', path: '$', message: 'Invalid verification result.' }],
    });
  }
}

export function buildStateTableView(
  model: TransitionSystemModel,
  state: StateSnapshot,
  changedVars?: readonly string[],
): StateTableView {
  const emptyFallback: StateTableView = Object.freeze({
    modelId: '<invalid>',
    modelName: '<invalid>',
    rows: Object.freeze([]),
    changedCount: 0,
  });

  try {
    const rawModel: unknown = model;
    const rawState: unknown = state;
    if (!isPlainObject(rawModel)) {
      return emptyFallback;
    }

    const idProp = readOwnDataProp(rawModel, 'id');
    const nameProp = readOwnDataProp(rawModel, 'name');
    const schemaProp = readOwnDataProp(rawModel, 'schema');
    if (
      idProp.kind !== 'value' ||
      typeof idProp.value !== 'string' ||
      nameProp.kind !== 'value' ||
      typeof nameProp.value !== 'string' ||
      schemaProp.kind !== 'value' ||
      !isPlainObject(schemaProp.value)
    ) {
      return emptyFallback;
    }

    const changedSet = new Set<string>();
    if (changedVars !== undefined) {
      const safeChanged = readOwnStringArray(changedVars, 256);
      if (!safeChanged.ok) {
        return emptyFallback;
      }
      for (const name of safeChanged.items) {
        changedSet.add(name);
      }
    }

    const stateObj = isPlainObject(rawState) ? rawState : null;
    const schemaObj = schemaProp.value;
    const schemaKeys = Reflect.ownKeys(schemaObj);
    const rows: StateTableRowView[] = [];
    let changedCount = 0;

    for (const key of schemaKeys) {
      if (typeof key === 'symbol') {
        return emptyFallback;
      }
      const defDesc = Object.getOwnPropertyDescriptor(schemaObj, key);
      if (defDesc === undefined || 'get' in defDesc || 'set' in defDesc) {
        return emptyFallback;
      }
      if (!defDesc.enumerable) {
        continue;
      }
      const domainText = tryFormatVarDef(defDesc.value);
      if (domainText === null) {
        return emptyFallback;
      }

      let valueText = '<missing>';
      if (stateObj !== null) {
        const valProp = readOwnDataProp(stateObj, key);
        if (valProp.kind === 'accessor') {
          valueText = '<invalid>';
        } else if (valProp.kind === 'value') {
          valueText = isPrimitiveStateValue(valProp.value)
            ? formatStateValue(valProp.value)
            : '<invalid>';
        }
      }

      const changed = changedSet.has(key);
      if (changed) changedCount += 1;
      rows.push(
        Object.freeze({
          name: key,
          domainText,
          valueText,
          changed,
          changeLabel: changed ? 'Modified' : 'Unchanged',
        }),
      );
    }

    return Object.freeze({
      modelId: idProp.value,
      modelName: nameProp.value,
      rows: Object.freeze(rows),
      changedCount,
    });
  } catch {
    return emptyFallback;
  }
}

export function renderStateTableHtml(
  model: TransitionSystemModel,
  state: StateSnapshot,
  changedVars?: readonly string[],
): string {
  try {
    const view = buildStateTableView(model, state, changedVars);
    const bodyRows = view.rows
      .map((row) => {
        const status = row.changed ? 'modified' : 'unchanged';
        const symbol = row.changed ? '*' : '·';
        return `<tr data-var="${escapeHtml(row.name)}" data-changed="${row.changed ? 'true' : 'false'}"><td><code>${escapeHtml(row.name)}</code></td><td>${escapeHtml(row.domainText)}</td><td><code>${escapeHtml(row.valueText)}</code></td><td><span class="rc-badge" data-status="${status}"><span aria-hidden="true">${symbol}</span> ${escapeHtml(row.changeLabel)}</span></td></tr>`;
      })
      .join('');

    return `<table class="rc-state-table" aria-label="State variables for ${escapeHtml(view.modelName)}"><thead><tr><th scope="col">Variable</th><th scope="col">Domain</th><th scope="col">Value</th><th scope="col">Change</th></tr></thead><tbody>${bodyRows}</tbody></table>`;
  } catch {
    return '<table class="rc-state-table" aria-label="State variables for &lt;invalid&gt;"><thead><tr><th scope="col">Variable</th><th scope="col">Domain</th><th scope="col">Value</th><th scope="col">Change</th></tr></thead><tbody></tbody></table>';
  }
}

function invalidInvariantsPanel(error: string): InvariantsPanelView {
  return Object.freeze({
    status: 'INVALID',
    invariants: Object.freeze([]),
    error,
  });
}

export function buildInvariantsPanelView(
  model: TransitionSystemModel,
  violatedInvariantIds: readonly string[],
  goalReached?: boolean,
): InvariantsPanelView {
  try {
    const rawModel: unknown = model;
    if (!isPlainObject(rawModel)) {
      return invalidInvariantsPanel('Model must be a plain object.');
    }

    const invProp = readOwnDataProp(rawModel, 'invariants');
    if (invProp.kind !== 'value') {
      return invalidInvariantsPanel('Model invariants must be a valid array.');
    }
    const invArr = readSafeArray(invProp.value, 256);
    if (!invArr.ok) {
      return invalidInvariantsPanel('Model invariants must be a valid array.');
    }

    const safeViolated = readOwnStringArray(violatedInvariantIds, 256);
    if (!safeViolated.ok) {
      return invalidInvariantsPanel('Invalid violatedInvariantIds payload.');
    }
    const violatedSet = new Set<string>(safeViolated.items);

    const rawGoalReached: unknown = goalReached;
    if (rawGoalReached !== undefined && typeof rawGoalReached !== 'boolean') {
      return invalidInvariantsPanel('Invalid goalReached flag.');
    }

    const rows: InvariantRowView[] = [];
    for (const rawInv of invArr.items) {
      if (!isPlainObject(rawInv)) {
        return invalidInvariantsPanel('Model invariant entry must be a plain object.');
      }
      const idProp = readOwnDataProp(rawInv, 'id');
      const labelProp = readOwnDataProp(rawInv, 'label');
      const holdsProp = readOwnDataProp(rawInv, 'holds');
      if (
        idProp.kind !== 'value' ||
        typeof idProp.value !== 'string' ||
        labelProp.kind !== 'value' ||
        typeof labelProp.value !== 'string' ||
        holdsProp.kind !== 'value'
      ) {
        return invalidInvariantsPanel('Model invariant entry is missing required fields.');
      }
      const expressionText = tryFormatBoolExpr(holdsProp.value);
      if (expressionText === null) {
        return invalidInvariantsPanel('Model invariant holds expression is invalid.');
      }
      const violated = violatedSet.has(idProp.value);
      rows.push(
        Object.freeze({
          id: idProp.value,
          label: labelProp.value,
          expressionText,
          violated,
          status: violated ? ('VIOLATED' as const) : ('PASS' as const),
        }),
      );
    }

    const invariants = Object.freeze(rows);
    const goalProp = readOwnDataProp(rawModel, 'goal');
    if (goalProp.kind === 'accessor') {
      return invalidInvariantsPanel('Model goal must be a plain data property.');
    }
    if (goalProp.kind === 'value' && goalProp.value !== undefined) {
      if (!isPlainObject(goalProp.value)) {
        return invalidInvariantsPanel('Model goal must be a plain object.');
      }
      const goalIdProp = readOwnDataProp(goalProp.value, 'id');
      const goalLabelProp = readOwnDataProp(goalProp.value, 'label');
      const goalReachedExprProp = readOwnDataProp(goalProp.value, 'reached');
      if (
        goalIdProp.kind !== 'value' ||
        typeof goalIdProp.value !== 'string' ||
        goalLabelProp.kind !== 'value' ||
        typeof goalLabelProp.value !== 'string' ||
        goalReachedExprProp.kind !== 'value'
      ) {
        return invalidInvariantsPanel('Model goal is missing required fields.');
      }

      const goalExpressionText = tryFormatBoolExpr(goalReachedExprProp.value);
      if (goalExpressionText === null) {
        return invalidInvariantsPanel('Model goal reached expression is invalid.');
      }

      const reached: boolean | null =
        rawGoalReached === true ? true : rawGoalReached === false ? false : null;
      const status: GoalPanelView['status'] =
        reached === true ? 'REACHED' : reached === false ? 'NOT REACHED' : 'NOT EVALUATED';

      const goal: GoalPanelView = Object.freeze({
        id: goalIdProp.value,
        label: goalLabelProp.value,
        expressionText: goalExpressionText,
        reached,
        status,
      });
      return Object.freeze({ status: 'VALID', invariants, goal });
    }

    return Object.freeze({ status: 'VALID', invariants });
  } catch {
    return invalidInvariantsPanel('Unexpected error while inspecting invariants input.');
  }
}

export function renderInvariantsPanelHtml(
  model: TransitionSystemModel,
  violatedInvariantIds: readonly string[],
  goalReached?: boolean,
): string {
  try {
    const view = buildInvariantsPanelView(model, violatedInvariantIds, goalReached);
    if (view.status === 'INVALID') {
      return `<section class="rc-invariants" role="alert" aria-live="assertive" data-status="invalid" aria-label="Invariants and goal"><p class="rc-error-message">${escapeHtml(view.error ?? 'Invalid invariants input.')}</p></section>`;
    }

    const items = view.invariants
      .map((inv) => {
        const dataStatus = inv.violated ? 'violated' : 'pass';
        const symbol = inv.violated ? '✗' : '✓';
        return `<li class="rc-invariant-item" data-invariant-id="${escapeHtml(inv.id)}" data-status="${dataStatus}"><span class="rc-badge" data-status="${dataStatus}"><span aria-hidden="true">${symbol}</span> ${escapeHtml(inv.status)}</span> <strong class="rc-invariant-label">${escapeHtml(inv.label)}</strong> <code class="rc-invariant-id">${escapeHtml(inv.id)}</code> <code class="rc-expr">${escapeHtml(inv.expressionText)}</code></li>`;
      })
      .join('');

    let goalHtml = '';
    if (Object.hasOwn(view, 'goal') && view.goal !== undefined) {
      const goalDataStatus =
        view.goal.status === 'REACHED'
          ? 'reached'
          : view.goal.status === 'NOT REACHED'
            ? 'not-reached'
            : 'not-evaluated';
      const goalSymbol =
        view.goal.status === 'REACHED' ? '✓' : view.goal.status === 'NOT REACHED' ? '○' : '?';
      goalHtml = `<div class="rc-goal" data-goal-id="${escapeHtml(view.goal.id)}" data-status="${goalDataStatus}"><span class="rc-badge" data-status="${goalDataStatus}"><span aria-hidden="true">${goalSymbol}</span> ${escapeHtml(view.goal.status)}</span> <strong class="rc-goal-label">${escapeHtml(view.goal.label)}</strong> <code class="rc-goal-id">${escapeHtml(view.goal.id)}</code> <code class="rc-expr">${escapeHtml(view.goal.expressionText)}</code></div>`;
    }

    return `<section class="rc-invariants" aria-label="Invariants and goal"><ul class="rc-invariant-list">${items}</ul>${goalHtml}</section>`;
  } catch {
    return '<section class="rc-invariants" role="alert" aria-live="assertive" data-status="invalid" aria-label="Invariants and goal"><p class="rc-error-message">Invalid invariants input.</p></section>';
  }
}

const INVALID_TIMELINE_HTML =
  '<section class="rc-replay-timeline" role="alert" aria-live="assertive" data-status="invalid" aria-label="Replay timeline and transitions"><p class="rc-error-message">Invalid replay session.</p></section>';

export function renderReplayTimelineHtml(session: ReplaySession): string {
  try {
    const rawSession: unknown = session;
    if (!isPlainObject(rawSession)) {
      return INVALID_TIMELINE_HTML;
    }

    const modeProp = readOwnDataProp(rawSession, 'mode');
    const modelProp = readOwnDataProp(rawSession, 'model');
    const cursorProp = readOwnDataProp(rawSession, 'cursor');
    const totalStepsProp = readOwnDataProp(rawSession, 'totalSteps');
    const canBackProp = readOwnDataProp(rawSession, 'canStepBack');
    const canForwardProp = readOwnDataProp(rawSession, 'canStepForward');
    const stepsProp = readOwnDataProp(rawSession, 'steps');
    const transitionsProp = readOwnDataProp(rawSession, 'enabledTransitions');

    if (
      modeProp.kind !== 'value' ||
      (modeProp.value !== 'trace' && modeProp.value !== 'manual') ||
      modelProp.kind !== 'value' ||
      !isPlainObject(modelProp.value) ||
      cursorProp.kind !== 'value' ||
      typeof cursorProp.value !== 'number' ||
      !Number.isSafeInteger(cursorProp.value) ||
      totalStepsProp.kind !== 'value' ||
      typeof totalStepsProp.value !== 'number' ||
      !Number.isSafeInteger(totalStepsProp.value) ||
      canBackProp.kind !== 'value' ||
      typeof canBackProp.value !== 'boolean' ||
      canForwardProp.kind !== 'value' ||
      typeof canForwardProp.value !== 'boolean' ||
      stepsProp.kind !== 'value' ||
      transitionsProp.kind !== 'value'
    ) {
      return INVALID_TIMELINE_HTML;
    }

    const rulesProp = readOwnDataProp(modelProp.value, 'rules');
    if (rulesProp.kind !== 'value') {
      return INVALID_TIMELINE_HTML;
    }
    const rulesArr = readSafeArray(rulesProp.value, 512);
    const stepsArr = readSafeArray(stepsProp.value, MAX_REPLAY_STEPS);
    const transitionsArr = readSafeArray(transitionsProp.value, 512);
    if (!rulesArr.ok || !stepsArr.ok || !transitionsArr.ok) {
      return INVALID_TIMELINE_HTML;
    }

    const mode = modeProp.value;
    const cursor = cursorProp.value;
    const totalSteps = totalStepsProp.value;
    const canStepBack = canBackProp.value;
    const canStepForward = canForwardProp.value;

    if (
      cursor < 0 ||
      cursor > stepsArr.items.length ||
      totalSteps !== stepsArr.items.length ||
      canStepBack !== (cursor > 0) ||
      canStepForward !== (cursor < stepsArr.items.length)
    ) {
      return INVALID_TIMELINE_HTML;
    }

    const ruleInfoMap = new Map<string, { readonly label: string; readonly guardText: string }>();
    for (const rawRule of rulesArr.items) {
      if (!isPlainObject(rawRule)) {
        return INVALID_TIMELINE_HTML;
      }
      const rId = readOwnDataProp(rawRule, 'id');
      const rLabel = readOwnDataProp(rawRule, 'label');
      const rGuard = readOwnDataProp(rawRule, 'guard');
      if (
        rId.kind !== 'value' ||
        typeof rId.value !== 'string' ||
        rLabel.kind !== 'value' ||
        typeof rLabel.value !== 'string' ||
        rGuard.kind !== 'value'
      ) {
        return INVALID_TIMELINE_HTML;
      }
      const guardText = tryFormatBoolExpr(rGuard.value);
      if (guardText === null) {
        return INVALID_TIMELINE_HTML;
      }
      ruleInfoMap.set(rId.value, {
        label: rLabel.value,
        guardText,
      });
    }

    const resetDisabled =
      (mode === 'trace' && cursor === 0) ||
      (mode === 'manual' && totalSteps === 0 && cursor === 0);

    const controlsHtml =
      `<nav class="rc-replay-controls" aria-label="Trace replay controls">` +
      `<button type="button" data-action="reset"${resetDisabled ? ' disabled' : ''}>Reset</button>` +
      `<button type="button" data-action="step-back"${!canStepBack ? ' disabled' : ''}>Previous step</button>` +
      `<span class="rc-step-counter" role="status" aria-live="polite">Step ${escapeHtml(String(cursor))} of ${escapeHtml(String(totalSteps))}</span>` +
      `<button type="button" data-action="step-forward"${!canStepForward ? ' disabled' : ''}>Next step</button>` +
      `</nav>`;

    const traceItems: string[] = [];
    traceItems.push(
      `<li class="rc-trace-item" data-step-index="0"${cursor === 0 ? ' aria-current="step"' : ''}><span class="rc-trace-step-label">Step 0: Initial state</span></li>`,
    );

    for (let i = 0; i < stepsArr.items.length; i += 1) {
      const rawStep = stepsArr.items[i];
      if (!isPlainObject(rawStep)) {
        return INVALID_TIMELINE_HTML;
      }
      const ruleIdProp = readOwnDataProp(rawStep, 'ruleId');
      const beforeProp = readOwnDataProp(rawStep, 'stateBefore');
      const afterProp = readOwnDataProp(rawStep, 'stateAfter');
      const changedProp = readOwnDataProp(rawStep, 'changedVars');
      if (
        ruleIdProp.kind !== 'value' ||
        typeof ruleIdProp.value !== 'string' ||
        beforeProp.kind !== 'value' ||
        !isPlainObject(beforeProp.value) ||
        afterProp.kind !== 'value' ||
        !isPlainObject(afterProp.value) ||
        changedProp.kind !== 'value'
      ) {
        return INVALID_TIMELINE_HTML;
      }
      const changedArr = readOwnStringArray(changedProp.value, 256);
      if (!changedArr.ok) {
        return INVALID_TIMELINE_HTML;
      }

      const stepNumber = i + 1;
      const isCurrent = cursor === stepNumber;
      const ruleId = ruleIdProp.value;
      const ruleInfo = ruleInfoMap.get(ruleId);
      const ruleLabel = ruleInfo !== undefined ? ruleInfo.label : ruleId;

      let diffsHtml: string;
      if (changedArr.items.length === 0) {
        diffsHtml = '<span class="rc-no-diff">No state changes</span>';
      } else {
        const stateBeforeObj = beforeProp.value;
        const stateAfterObj = afterProp.value;
        const diffParts = changedArr.items.map((varName) => {
          const beforeVal = readOwnDataProp(stateBeforeObj, varName);
          const afterVal = readOwnDataProp(stateAfterObj, varName);
          const beforeText =
            beforeVal.kind === 'missing'
              ? '<missing>'
              : beforeVal.kind === 'value' && isPrimitiveStateValue(beforeVal.value)
                ? formatStateValue(beforeVal.value as StateValue)
                : '<invalid>';
          const afterText =
            afterVal.kind === 'missing'
              ? '<missing>'
              : afterVal.kind === 'value' && isPrimitiveStateValue(afterVal.value)
                ? formatStateValue(afterVal.value as StateValue)
                : '<invalid>';
          return `<span class="rc-var-diff" data-var="${escapeHtml(varName)}"><code>${escapeHtml(varName)}</code>: <code>${escapeHtml(beforeText)}</code> -&gt; <code>${escapeHtml(afterText)}</code></span>`;
        });
        diffsHtml = `<div class="rc-step-diffs">${diffParts.join(' ')}</div>`;
      }

      traceItems.push(
        `<li class="rc-trace-item" data-step-index="${stepNumber}" data-rule-id="${escapeHtml(ruleId)}"${isCurrent ? ' aria-current="step"' : ''}>` +
          `<span class="rc-trace-step-label">Step ${stepNumber}: ${escapeHtml(ruleLabel)}</span> ` +
          `<code class="rc-rule-id">${escapeHtml(ruleId)}</code>` +
          diffsHtml +
          `</li>`,
      );
    }

    const transitionItems: string[] = [];
    for (const rawTrans of transitionsArr.items) {
      if (!isPlainObject(rawTrans)) {
        return INVALID_TIMELINE_HTML;
      }
      const ruleIdProp = readOwnDataProp(rawTrans, 'ruleId');
      const labelProp = readOwnDataProp(rawTrans, 'label');
      const enabledProp = readOwnDataProp(rawTrans, 'enabled');
      if (
        ruleIdProp.kind !== 'value' ||
        typeof ruleIdProp.value !== 'string' ||
        labelProp.kind !== 'value' ||
        typeof labelProp.value !== 'string' ||
        enabledProp.kind !== 'value' ||
        typeof enabledProp.value !== 'boolean'
      ) {
        return INVALID_TIMELINE_HTML;
      }
      const ruleInfo = ruleInfoMap.get(ruleIdProp.value);
      const guardText = ruleInfo !== undefined ? ruleInfo.guardText : '<unknown>';
      const status = enabledProp.value ? 'enabled' : 'disabled';
      const badgeText = enabledProp.value ? 'ENABLED' : 'DISABLED';
      const symbol = enabledProp.value ? '✓' : '×';
      transitionItems.push(
        `<li class="rc-transition-item" data-rule-id="${escapeHtml(ruleIdProp.value)}" data-status="${status}">` +
          `<span class="rc-badge" data-status="${status}"><span aria-hidden="true">${symbol}</span> ${badgeText}</span> ` +
          `<button type="button" data-action="apply-rule" data-rule-id="${escapeHtml(ruleIdProp.value)}"${!enabledProp.value ? ' disabled' : ''}>${escapeHtml(labelProp.value)}</button> ` +
          `<code class="rc-rule-id">${escapeHtml(ruleIdProp.value)}</code> ` +
          `<code class="rc-guard">${escapeHtml(guardText)}</code>` +
          `</li>`,
      );
    }

    return (
      `<section class="rc-replay-timeline" data-mode="${escapeHtml(mode)}" aria-label="Replay timeline and transitions">` +
      controlsHtml +
      `<ol class="rc-trace-list" aria-label="Execution trace">${traceItems.join('')}</ol>` +
      `<section class="rc-transitions" aria-label="Transitions at current state"><ul class="rc-transition-list">${transitionItems.join('')}</ul></section>` +
      `</section>`
    );
  } catch {
    return INVALID_TIMELINE_HTML;
  }
}

export function renderAssumptionsPanelHtml(assumptions: readonly ModelAssumption[]): string {
  const notice =
    '<p class="rc-scope-notice">Verification scope: results apply strictly to the declared discrete model under the listed assumptions and do not cover behaviors marked as not modeled.</p>';

  try {
    const arr = readSafeArray(assumptions, 256);
    if (!arr.ok) {
      return `<section class="rc-assumptions" aria-label="Modeling assumptions and scope">${notice}<p class="rc-error-message" role="alert">Invalid modeling assumptions payload.</p></section>`;
    }

    if (arr.items.length === 0) {
      return `<section class="rc-assumptions" aria-label="Modeling assumptions and scope">${notice}<p class="rc-empty">No assumptions declared.</p></section>`;
    }

    const items: string[] = [];
    for (const rawItem of arr.items) {
      if (!isPlainObject(rawItem)) {
        return `<section class="rc-assumptions" aria-label="Modeling assumptions and scope">${notice}<p class="rc-error-message" role="alert">Invalid modeling assumptions payload.</p></section>`;
      }
      const idProp = readOwnDataProp(rawItem, 'id');
      const catProp = readOwnDataProp(rawItem, 'category');
      const stmtProp = readOwnDataProp(rawItem, 'statement');
      const notModeledProp = readOwnDataProp(rawItem, 'notModeled');
      if (
        idProp.kind !== 'value' ||
        typeof idProp.value !== 'string' ||
        catProp.kind !== 'value' ||
        typeof catProp.value !== 'string' ||
        stmtProp.kind !== 'value' ||
        typeof stmtProp.value !== 'string' ||
        notModeledProp.kind !== 'value' ||
        typeof notModeledProp.value !== 'string'
      ) {
        return `<section class="rc-assumptions" aria-label="Modeling assumptions and scope">${notice}<p class="rc-error-message" role="alert">Invalid modeling assumptions payload.</p></section>`;
      }

      items.push(
        `<li class="rc-assumption-item" data-assumption-id="${escapeHtml(idProp.value)}" data-category="${escapeHtml(catProp.value)}">` +
          `<span class="rc-badge" data-status="assumption">${escapeHtml(catProp.value)}</span> ` +
          `<code class="rc-assumption-id">${escapeHtml(idProp.value)}</code>` +
          `<p class="rc-assumption-statement">${escapeHtml(stmtProp.value)}</p>` +
          `<p class="rc-assumption-not-modeled"><strong>Not modeled:</strong> ${escapeHtml(notModeledProp.value)}</p>` +
          `</li>`,
      );
    }

    return `<section class="rc-assumptions" aria-label="Modeling assumptions and scope">${notice}<ul class="rc-assumption-list">${items.join('')}</ul></section>`;
  } catch {
    return `<section class="rc-assumptions" aria-label="Modeling assumptions and scope">${notice}<p class="rc-error-message" role="alert">Invalid modeling assumptions payload.</p></section>`;
  }
}

export function renderValidationErrorsHtml(errors: readonly ValidationError[]): string {
  try {
    const arr = readSafeArray(errors, MAX_SAFE_ARRAY_LENGTH);
    if (!arr.ok) {
      return '<section class="rc-validation-errors" role="alert" aria-live="assertive" aria-label="Validation errors"><p>Invalid validation error list.</p></section>';
    }

    if (arr.items.length === 0) {
      return '<section class="rc-validation-errors" role="alert" aria-live="assertive" aria-label="Validation errors"><p>No validation errors.</p></section>';
    }

    const items: string[] = [];
    for (const rawErr of arr.items) {
      if (!isPlainObject(rawErr)) {
        return '<section class="rc-validation-errors" role="alert" aria-live="assertive" aria-label="Validation errors"><p>Invalid validation error list.</p></section>';
      }
      const codeProp = readOwnDataProp(rawErr, 'code');
      const pathProp = readOwnDataProp(rawErr, 'path');
      const msgProp = readOwnDataProp(rawErr, 'message');
      if (
        codeProp.kind !== 'value' ||
        typeof codeProp.value !== 'string' ||
        pathProp.kind !== 'value' ||
        typeof pathProp.value !== 'string' ||
        msgProp.kind !== 'value' ||
        typeof msgProp.value !== 'string'
      ) {
        return '<section class="rc-validation-errors" role="alert" aria-live="assertive" aria-label="Validation errors"><p>Invalid validation error list.</p></section>';
      }

      items.push(
        `<li class="rc-error-item" data-error-code="${escapeHtml(codeProp.value)}">` +
          `<code class="rc-error-code">${escapeHtml(codeProp.value)}</code> ` +
          `<code class="rc-error-path">${escapeHtml(pathProp.value)}</code> ` +
          `<span class="rc-error-message">${escapeHtml(msgProp.value)}</span>` +
          `</li>`,
      );
    }

    return `<section class="rc-validation-errors" role="alert" aria-live="assertive" aria-label="Validation errors"><ul class="rc-error-list">${items.join('')}</ul></section>`;
  } catch {
    return '<section class="rc-validation-errors" role="alert" aria-live="assertive" aria-label="Validation errors"><p>Invalid validation error list.</p></section>';
  }
}
