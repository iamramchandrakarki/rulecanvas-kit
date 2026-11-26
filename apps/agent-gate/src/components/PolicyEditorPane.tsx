import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type {
  BoolExpr,
  TransitionRule,
  TransitionSystemModel,
  ValidationError,
  VarDef,
} from '@rulecanvas/core';
import {
  formatBoolExpr,
  formatRuleSummary,
  formatStateValue,
  formatVarDef,
} from '@rulecanvas/ui';
import { useIntegerDraftStore } from '@rulecanvas/workbench-react';
import {
  addAssumption,
  addInvariant,
  addRule,
  addRuleUpdate,
  addSchemaVariable,
  appendRuleGuardClause,
  createDefaultBoolExpr,
  createDefaultRule,
  createDefaultValueExpr,
  defaultValueForVarDef,
  exportModelToJson,
  firstVariableOfKind,
  getErrorsForPathPrefix,
  importModelFromJson,
  moveRule,
  parseStrictIntegerDraft,
  removeAssumption,
  removeInvariant,
  removeRule,
  removeRuleUpdate,
  removeSchemaVariable,
  setGoalEnabled,
  setInitialStateValue,
  updateAssumption,
  updateGoal,
  updateInvariant,
  updateModelMetadata,
  updateRule,
  updateRuleUpdate,
  updateSchemaVariable,
  type ModelDiagnosticsIndex,
} from '../model-editor.js';
import { BoolExprEditor, ValueExprEditor, type LiftedIntDraftStore } from './ExprEditor.js';
import { StrictIntegerInput } from './StrictIntegerInput.js';

export type EditorTabId = 'schema' | 'rules' | 'invariants' | 'assumptions' | 'json';

const EDITOR_TABS: readonly { readonly id: EditorTabId; readonly label: string }[] = [
  { id: 'schema', label: 'Schema & State' },
  { id: 'rules', label: 'Rules' },
  { id: 'invariants', label: 'Invariants & Goal' },
  { id: 'assumptions', label: 'Assumptions' },
  { id: 'json', label: 'JSON' },
];

const RESERVED_SCHEMA_NAMES: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

export interface FocusedRuleRequest {
  readonly ruleId: string;
  readonly seq: number;
}

export interface PolicyEditorPaneProps {
  readonly model: TransitionSystemModel;
  readonly diagnostics: ModelDiagnosticsIndex;
  readonly resetKey?: string | number | undefined;
  readonly activeTraceStepsByRuleId?: ReadonlyMap<string, readonly number[]> | undefined;
  readonly focusedRuleRequest?: FocusedRuleRequest | null | undefined;
  readonly onChangeModel: (next: TransitionSystemModel) => void;
  readonly onImportModel: (imported: TransitionSystemModel) => void;
  readonly onDraftErrorChange?: ((fieldKey: string, errorMessage: string | null) => void) | undefined;
  readonly onJsonDraftDirtyChange?: ((dirty: boolean) => void) | undefined;
}

export function resolveQuickBooleanVariable(
  schemaKeys: readonly string[],
  schema: TransitionSystemModel['schema'],
  preferredVar: string,
): string {
  const booleanKeys = schemaKeys.filter((k) => schema[k]?.kind === 'boolean');
  if (booleanKeys.length === 0) return '';
  return booleanKeys.includes(preferredVar) ? preferredVar : booleanKeys[0]!;
}

function InlineErrorList({ errors }: { readonly errors: readonly ValidationError[] }) {
  if (errors.length === 0) return null;
  return (
    <ul className="ag-inline-errors" role="alert">
      {errors.map((err, idx) => (
        <li key={`${err.code}-${err.path}-${idx}`}>
          <code>{err.path}</code>: {err.message} (<code>{err.code}</code>)
        </li>
      ))}
    </ul>
  );
}

function guardContainsNegatedVar(expr: BoolExpr, varName: string): boolean {
  if (expr.op === 'not' && expr.arg.op === 'var' && expr.arg.name === varName) {
    return true;
  }
  if (expr.op === 'and') {
    return expr.args.some((child) => guardContainsNegatedVar(child, varName));
  }
  return false;
}

function buildInitialRowIds(
  prefix: string,
  count: number,
  counterRef: { current: number },
): string[] {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    counterRef.current += 1;
    ids.push(`${prefix}-${counterRef.current}`);
  }
  return ids;
}

function buildInitialSchemaRowMap(
  keys: readonly string[],
  counterRef: { current: number },
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const key of keys) {
    counterRef.current += 1;
    map[key] = `schema-row-${counterRef.current}`;
  }
  return map;
}

function buildInitialUpdateRowIdsByRule(
  rules: readonly TransitionRule[],
  ruleIds: readonly string[],
  counterRef: { current: number },
): Record<string, readonly string[]> {
  const map: Record<string, readonly string[]> = {};
  for (let i = 0; i < rules.length; i += 1) {
    const rule = rules[i]!;
    const ruleRowId = ruleIds[i]!;
    map[ruleRowId] = buildInitialRowIds('upd-row', rule.updates.length, counterRef);
  }
  return map;
}

function alignRowIds(
  current: readonly string[],
  targetLength: number,
  prefix: string,
): readonly string[] {
  if (current.length === targetLength) return current;
  if (current.length > targetLength) return current.slice(0, targetLength);
  const next = [...current];
  const used = new Set(current);
  let seq = current.length;
  while (next.length < targetLength) {
    let candidate = `${prefix}-sync-${seq}`;
    seq += 1;
    while (used.has(candidate)) {
      candidate = `${prefix}-sync-${seq}`;
      seq += 1;
    }
    used.add(candidate);
    next.push(candidate);
  }
  return next;
}

export function shouldPruneGuardDraftsOnAppend(guard: BoolExpr): boolean {
  return guard.op !== 'and';
}

export function tryExportModelJson(
  model: TransitionSystemModel,
):
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly error: ValidationError } {
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

export function matchesDraftPrefix(fieldKey: string, prefix: string): boolean {
  return (
    fieldKey === prefix ||
    fieldKey.startsWith(`${prefix}.`) ||
    fieldKey.startsWith(`${prefix}:`)
  );
}

export function applySchemaVarRenameState(
  currentOrder: readonly string[],
  varNameToRowId: Readonly<Record<string, string>>,
  oldKey: string,
  newKey: string,
  rowId: string,
): {
  readonly schemaVarOrder: readonly string[];
  readonly varNameToRowId: Readonly<Record<string, string>>;
} {
  const nextOrder = currentOrder.map((k) => (k === oldKey ? newKey : k));
  const nextMap: Record<string, string> = { ...varNameToRowId };
  delete nextMap[oldKey];
  nextMap[newKey] = rowId;
  return {
    schemaVarOrder: nextOrder,
    varNameToRowId: nextMap,
  };
}

export function resolveOrderedSchemaKeys(
  schemaVarOrder: readonly string[],
  schema: TransitionSystemModel['schema'],
): readonly string[] {
  const rawSchemaKeys = Object.keys(schema);
  return [
    ...schemaVarOrder.filter((k) => Object.hasOwn(schema, k)),
    ...rawSchemaKeys.filter((k) => !schemaVarOrder.includes(k)),
  ];
}

export function PolicyEditorPane({
  model,
  diagnostics,
  resetKey = 0,
  activeTraceStepsByRuleId,
  focusedRuleRequest = null,
  onChangeModel,
  onImportModel,
  onDraftErrorChange,
  onJsonDraftDirtyChange,
}: PolicyEditorPaneProps) {
  const nextRowIdRef = useRef<number>(0);
  const prevResetKeyRef = useRef<string | number>(resetKey);
  const prevFocusedSeqRef = useRef<number>(0);
  const preserveNextNoticeRef = useRef<boolean>(false);
  const onDraftErrorChangeRef = useRef(onDraftErrorChange);
  onDraftErrorChangeRef.current = onDraftErrorChange;
  const ruleFocusRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const ruleNavRef = useRef<HTMLDivElement>(null);
  const addRuleButtonRef = useRef<HTMLButtonElement>(null);

  const allocRowId = (prefix: string): string => {
    nextRowIdRef.current += 1;
    return `${prefix}-${nextRowIdRef.current}`;
  };

  const tabRefs = useRef<Record<EditorTabId, HTMLButtonElement | null>>({
    schema: null,
    rules: null,
    invariants: null,
    assumptions: null,
    json: null,
  });

  const [activeTab, setActiveTab] = useState<EditorTabId>('rules');
  const [pendingRuleFocus, setPendingRuleFocus] = useState<{ readonly rowId: string } | null>(null);
  const [newVarName, setNewVarName] = useState('');
  const [newVarKind, setNewVarKind] = useState<VarDef['kind']>('boolean');
  const [newVarEnumValues, setNewVarEnumValues] = useState('alpha, beta');
  const [newVarMin, setNewVarMin] = useState('0');
  const [newVarMax, setNewVarMax] = useState('3');

  const [quickClauseVar, setQuickClauseVar] = useState<string>('modifiedSinceApproval');
  const [quickClauseNegated, setQuickClauseNegated] = useState<boolean>(true);

  const [initialJsonExport] = useState(() => tryExportModelJson(model));
  const committedJsonRef = useRef<string>(initialJsonExport.ok ? initialJsonExport.text : '');
  const onJsonDraftDirtyChangeRef = useRef(onJsonDraftDirtyChange);
  onJsonDraftDirtyChangeRef.current = onJsonDraftDirtyChange;
  const [jsonDraft, setJsonDraft] = useState<string>(() =>
    initialJsonExport.ok ? initialJsonExport.text : '',
  );
  const [jsonErrors, setJsonErrors] = useState<readonly ValidationError[]>(() =>
    initialJsonExport.ok ? [] : [initialJsonExport.error],
  );
  const [jsonNotice, setJsonNotice] = useState<string | null>(null);

  // Logical variable identity & visual order (stable across numeric-key renames)
  const [schemaVarOrder, setSchemaVarOrder] = useState<readonly string[]>(() =>
    Object.keys(model.schema),
  );
  const [varNameToRowId, setVarNameToRowId] = useState<Readonly<Record<string, string>>>(() =>
    buildInitialSchemaRowMap(Object.keys(model.schema), nextRowIdRef),
  );
  const fallbackSchemaRowMapRef = useRef<Record<string, string>>({});

  const [ruleRowIds, setRuleRowIds] = useState<readonly string[]>(() =>
    buildInitialRowIds('rule-row', model.rules.length, nextRowIdRef),
  );
  const [updateRowIdsByRule, setUpdateRowIdsByRule] = useState<
    Readonly<Record<string, readonly string[]>>
  >(() => buildInitialUpdateRowIdsByRule(model.rules, ruleRowIds, nextRowIdRef));

  const [invRowIds, setInvRowIds] = useState<readonly string[]>(() =>
    buildInitialRowIds('inv-row', model.invariants.length, nextRowIdRef),
  );
  const [asmRowIds, setAsmRowIds] = useState<readonly string[]>(() =>
    buildInitialRowIds('asm-row', model.assumptions.length, nextRowIdRef),
  );

  const [selectedRuleRowId, setSelectedRuleRowId] = useState<string | null>(() => {
    const pubIdx = model.rules.findIndex((r) => r.id === 'publish_release_notes');
    return pubIdx >= 0 ? (ruleRowIds[pubIdx] ?? null) : (ruleRowIds[0] ?? null);
  });

  const [varNameDrafts, setVarNameDrafts] = useState<Readonly<Record<string, string>>>({});
  const [varNameErrors, setVarNameErrors] = useState<Readonly<Record<string, string>>>({});

  // Lifted integer drafts & errors keyed by stable logical fieldKey (shared store)
  const intDraftStore: LiftedIntDraftStore = useIntegerDraftStore({
    resetKey,
    onErrorChange: onDraftErrorChange,
  });
  const intDraftValues = intDraftStore.draftValues;
  const intDraftErrors = intDraftStore.draftErrors;
  const handleIntDraftChange = intDraftStore.onDraftChange;
  const pruneDraftsByPrefix = intDraftStore.onPruneDrafts;

  useEffect(() => {
    const exported = tryExportModelJson(model);
    if (exported.ok) {
      committedJsonRef.current = exported.text;
      setJsonDraft(exported.text);
      onJsonDraftDirtyChangeRef.current?.(false);
      setJsonErrors([]);
      if (preserveNextNoticeRef.current) {
        preserveNextNoticeRef.current = false;
      } else {
        setJsonNotice(null);
      }
    } else {
      preserveNextNoticeRef.current = false;
      onJsonDraftDirtyChangeRef.current?.(false);
      setJsonErrors([exported.error]);
      setJsonNotice(null);
    }
  }, [model]);

  useEffect(() => {
    if (prevResetKeyRef.current !== resetKey) {
      prevResetKeyRef.current = resetKey;
      const nextSchemaKeys = Object.keys(model.schema);
      const nextSchemaRowMap = buildInitialSchemaRowMap(nextSchemaKeys, nextRowIdRef);
      const nextRuleIds = buildInitialRowIds('rule-row', model.rules.length, nextRowIdRef);
      const nextUpdateIdsByRule = buildInitialUpdateRowIdsByRule(
        model.rules,
        nextRuleIds,
        nextRowIdRef,
      );
      const nextInvIds = buildInitialRowIds('inv-row', model.invariants.length, nextRowIdRef);
      const nextAsmIds = buildInitialRowIds('asm-row', model.assumptions.length, nextRowIdRef);

      fallbackSchemaRowMapRef.current = {};
      setSchemaVarOrder(nextSchemaKeys);
      setVarNameToRowId(nextSchemaRowMap);
      setRuleRowIds(nextRuleIds);
      setUpdateRowIdsByRule(nextUpdateIdsByRule);
      setInvRowIds(nextInvIds);
      setAsmRowIds(nextAsmIds);

      let nextSelectedRowId: string | null = nextRuleIds[0] ?? null;
      model.rules.forEach((rule, idx) => {
        if (rule.id === 'publish_release_notes') {
          const rowId = nextRuleIds[idx];
          if (rowId !== undefined) {
            nextSelectedRowId = rowId;
          }
        }
      });
      setSelectedRuleRowId(nextSelectedRowId);
      setPendingRuleFocus(null);
      setVarNameDrafts({});
      setVarNameErrors({});
    }
  }, [resetKey, model]);

  const schemaKeys = resolveOrderedSchemaKeys(schemaVarOrder, model.schema);

  const getSchemaRowId = (varName: string): string => {
    if (Object.hasOwn(varNameToRowId, varName)) {
      return varNameToRowId[varName]!;
    }
    if (!Object.hasOwn(fallbackSchemaRowMapRef.current, varName)) {
      fallbackSchemaRowMapRef.current[varName] = allocRowId('schema-row');
    }
    return fallbackSchemaRowMapRef.current[varName]!;
  };

  const resolvedRuleRowIds = alignRowIds(ruleRowIds, model.rules.length, 'rule-row');
  const resolvedInvRowIds = alignRowIds(invRowIds, model.invariants.length, 'inv-row');
  const resolvedAsmRowIds = alignRowIds(asmRowIds, model.assumptions.length, 'asm-row');

  const selectedRuleIndex = (() => {
    if (model.rules.length === 0) return -1;
    if (selectedRuleRowId !== null) {
      const idx = resolvedRuleRowIds.indexOf(selectedRuleRowId);
      if (idx >= 0) return idx;
    }
    return 0;
  })();
  const selectedRule = selectedRuleIndex >= 0 ? model.rules[selectedRuleIndex]! : null;
  const activeSelectedRuleRowId =
    selectedRuleIndex >= 0 ? resolvedRuleRowIds[selectedRuleIndex]! : null;

  useEffect(() => {
    const revealSelectedRule = () => {
      const nav = ruleNavRef.current;
      const active = nav?.querySelector('[aria-pressed="true"]');
      if (nav === null || active == null || nav.scrollWidth <= nav.clientWidth) return;
      const navBounds = nav.getBoundingClientRect();
      const activeBounds = active.getBoundingClientRect();
      if (activeBounds.right > navBounds.right) {
        nav.scrollLeft += activeBounds.right - navBounds.right;
      } else if (activeBounds.left < navBounds.left) {
        nav.scrollLeft += activeBounds.left - navBounds.left;
      }
    };
    revealSelectedRule();
    window.addEventListener('resize', revealSelectedRule);
    return () => window.removeEventListener('resize', revealSelectedRule);
  }, [activeSelectedRuleRowId]);

  const selectRuleRow = (rowId: string, focusDetail: boolean) => {
    setActiveTab('rules');
    setSelectedRuleRowId(rowId);
    if (focusDetail) {
      setPendingRuleFocus({ rowId });
    }
  };

  useEffect(() => {
    if (focusedRuleRequest === null || focusedRuleRequest.seq === prevFocusedSeqRef.current) {
      return;
    }
    prevFocusedSeqRef.current = focusedRuleRequest.seq;
    const targetIdx = model.rules.findIndex((r) => r.id === focusedRuleRequest.ruleId);
    if (targetIdx < 0) return;
    const rowId = resolvedRuleRowIds[targetIdx];
    if (rowId === undefined) return;
    selectRuleRow(rowId, true);
  }, [focusedRuleRequest, model.rules, resolvedRuleRowIds]);

  useEffect(() => {
    if (
      pendingRuleFocus === null ||
      activeTab !== 'rules' ||
      activeSelectedRuleRowId !== pendingRuleFocus.rowId
    ) {
      return;
    }
    const target = ruleFocusRefs.current[pendingRuleFocus.rowId];
    const prefersReducedMotion =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({
      behavior: prefersReducedMotion ? 'auto' : 'smooth',
      block: 'center',
    });
    setPendingRuleFocus(null);
  }, [pendingRuleFocus, activeTab, activeSelectedRuleRowId]);

  const booleanKeys = schemaKeys.filter((k) => model.schema[k]?.kind === 'boolean');
  const selectedQuickVar = resolveQuickBooleanVariable(schemaKeys, model.schema, quickClauseVar);

  const parsedNewVarMin = parseStrictIntegerDraft(newVarMin);
  const parsedNewVarMax = parseStrictIntegerDraft(newVarMax);
  const newVarRangeError =
    newVarKind === 'int' &&
    parsedNewVarMin.ok &&
    parsedNewVarMax.ok &&
    parsedNewVarMin.value > parsedNewVarMax.value
      ? `Minimum (${parsedNewVarMin.value}) must be <= maximum (${parsedNewVarMax.value}).`
      : null;
  const newVarIntInvalid =
    newVarKind === 'int' &&
    (!parsedNewVarMin.ok || !parsedNewVarMax.ok || newVarRangeError !== null);
  const trimmedNewVarName = newVarName.trim();
  const newVarNameError =
    trimmedNewVarName.length > 0 && RESERVED_SCHEMA_NAMES.has(trimmedNewVarName)
      ? `Variable name "${trimmedNewVarName}" is reserved.`
      : trimmedNewVarName.length > 0 && Object.hasOwn(model.schema, trimmedNewVarName)
        ? `Variable "${trimmedNewVarName}" already exists.`
        : null;

  const focusTabByIndex = (nextIndex: number) => {
    const nextTab = EDITOR_TABS[nextIndex];
    if (nextTab === undefined) return;
    setActiveTab(nextTab.id);
    tabRefs.current[nextTab.id]?.focus();
  };

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, currentIndex: number) => {
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      focusTabByIndex((currentIndex + 1) % EDITOR_TABS.length);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      focusTabByIndex((currentIndex - 1 + EDITOR_TABS.length) % EDITOR_TABS.length);
    } else if (event.key === 'Home') {
      event.preventDefault();
      focusTabByIndex(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      focusTabByIndex(EDITOR_TABS.length - 1);
    }
  };

  const countIntDraftErrorsByPrefix = (prefix: string): number => {
    let count = 0;
    for (const key of Object.keys(intDraftErrors)) {
      if (key.startsWith(prefix)) count += 1;
    }
    return count;
  };

  const tabErrorCount = (tab: EditorTabId): number => {
    switch (tab) {
      case 'schema':
        return (
          diagnostics.sections.schema.length +
          diagnostics.sections.general.length +
          countIntDraftErrorsByPrefix('schema:') +
          Object.keys(varNameErrors).length
        );
      case 'rules':
        return diagnostics.sections.rules.length + countIntDraftErrorsByPrefix('rule:');
      case 'invariants':
        return (
          diagnostics.sections.invariants.length +
          diagnostics.sections.goal.length +
          countIntDraftErrorsByPrefix('inv:') +
          countIntDraftErrorsByPrefix('goal.')
        );
      case 'assumptions':
        return diagnostics.sections.assumptions.length;
      case 'json':
        return jsonErrors.length;
    }
  };

  const handleAddSchemaVar = () => {
    if (trimmedNewVarName.length === 0 || newVarNameError !== null || newVarIntInvalid) {
      return;
    }

    let def: VarDef;
    if (newVarKind === 'boolean') {
      def = { kind: 'boolean' };
    } else if (newVarKind === 'enum') {
      const vals = newVarEnumValues
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      def = { kind: 'enum', values: vals.length > 0 ? vals : ['idle'] };
    } else {
      if (!parsedNewVarMin.ok || !parsedNewVarMax.ok) return;
      def = { kind: 'int', min: parsedNewVarMin.value, max: parsedNewVarMax.value };
    }

    const newRowId = allocRowId('schema-row');
    setVarNameToRowId((prev) => ({ ...prev, [trimmedNewVarName]: newRowId }));
    setSchemaVarOrder([...schemaKeys, trimmedNewVarName]);
    onChangeModel(addSchemaVariable(model, trimmedNewVarName, def));
    setNewVarName('');
  };

  const handleRemoveSchemaVar = (key: string, rowId: string) => {
    setSchemaVarOrder(schemaKeys.filter((k) => k !== key));
    setVarNameToRowId((prev) => {
      if (!Object.hasOwn(prev, key)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
    delete fallbackSchemaRowMapRef.current[key];
    setVarNameDrafts((prev) => {
      const next = { ...prev };
      delete next[rowId];
      return next;
    });
    setVarNameErrors((prev) => {
      const next = { ...prev };
      delete next[rowId];
      return next;
    });
    onDraftErrorChangeRef.current?.(`schema:${rowId}.name`, null);
    pruneDraftsByPrefix(`schema:${rowId}`);
    onChangeModel(removeSchemaVariable(model, key));
  };

  const handleRenameSchemaVar = (rowId: string, oldKey: string, def: VarDef, rawNext: string) => {
    setVarNameDrafts((prev) => ({ ...prev, [rowId]: rawNext }));
    const trimmed = rawNext.trim();

    if (trimmed.length === 0) {
      const msg = 'Variable name must not be empty.';
      setVarNameErrors((prev) => ({ ...prev, [rowId]: msg }));
      onDraftErrorChangeRef.current?.(`schema:${rowId}.name`, msg);
      return;
    }
    if (RESERVED_SCHEMA_NAMES.has(trimmed)) {
      const msg = `Variable name "${trimmed}" is reserved.`;
      setVarNameErrors((prev) => ({ ...prev, [rowId]: msg }));
      onDraftErrorChangeRef.current?.(`schema:${rowId}.name`, msg);
      return;
    }
    if (trimmed !== oldKey && Object.hasOwn(model.schema, trimmed)) {
      const msg = `Variable name "${trimmed}" is already declared.`;
      setVarNameErrors((prev) => ({ ...prev, [rowId]: msg }));
      onDraftErrorChangeRef.current?.(`schema:${rowId}.name`, msg);
      return;
    }

    setVarNameErrors((prev) => {
      if (!(rowId in prev)) return prev;
      const next = { ...prev };
      delete next[rowId];
      return next;
    });
    onDraftErrorChangeRef.current?.(`schema:${rowId}.name`, null);

    if (trimmed !== oldKey) {
      const renamedState = applySchemaVarRenameState(
        schemaKeys,
        varNameToRowId,
        oldKey,
        trimmed,
        rowId,
      );
      setSchemaVarOrder(renamedState.schemaVarOrder);
      setVarNameToRowId(renamedState.varNameToRowId);
      delete fallbackSchemaRowMapRef.current[oldKey];
      if (quickClauseVar === oldKey) {
        setQuickClauseVar(trimmed);
      }
      onChangeModel(updateSchemaVariable(model, oldKey, trimmed, def));
    }
  };

  const handleAddRule = () => {
    const newRowId = allocRowId('rule-row');
    setRuleRowIds([...resolvedRuleRowIds, newRowId]);
    setUpdateRowIdsByRule((prev) => ({ ...prev, [newRowId]: [] }));
    setActiveTab('rules');
    setSelectedRuleRowId(newRowId);
    setPendingRuleFocus({ rowId: newRowId });
    onChangeModel(addRule(model, createDefaultRule(model)));
  };

  const handleMoveRule = (fromIndex: number, toIndex: number) => {
    if (toIndex < 0 || toIndex >= resolvedRuleRowIds.length || fromIndex === toIndex) return;
    const nextIds = [...resolvedRuleRowIds];
    const [movedId] = nextIds.splice(fromIndex, 1);
    if (movedId !== undefined) {
      nextIds.splice(toIndex, 0, movedId);
      setRuleRowIds(nextIds);
    }
    onChangeModel(moveRule(model, fromIndex, toIndex));
  };

  const handleRemoveRule = (idx: number, rowId: string) => {
    const nextRuleIds = resolvedRuleRowIds.filter((_, i) => i !== idx);
    setRuleRowIds(nextRuleIds);
    setUpdateRowIdsByRule((prev) => {
      if (!Object.hasOwn(prev, rowId)) return prev;
      const next = { ...prev };
      delete next[rowId];
      return next;
    });
    if (selectedRuleRowId === rowId) {
      const fallbackRowId = nextRuleIds[Math.min(idx, nextRuleIds.length - 1)] ?? null;
      setSelectedRuleRowId(fallbackRowId);
      if (fallbackRowId !== null) {
        setPendingRuleFocus({ rowId: fallbackRowId });
      } else {
        addRuleButtonRef.current?.focus();
      }
    }
    pruneDraftsByPrefix(`rule:${rowId}`);
    onChangeModel(removeRule(model, idx));
  };

  const handleAppendRuleGuardClause = (
    idx: number,
    rule: TransitionRule,
    rowId: string,
    clause: BoolExpr,
  ) => {
    if (shouldPruneGuardDraftsOnAppend(rule.guard)) {
      pruneDraftsByPrefix(`rule:${rowId}.guard`);
    }
    onChangeModel(appendRuleGuardClause(model, idx, clause));
  };

  const handleAddRuleUpdate = (idx: number, rule: TransitionRule, ruleRowId: string) => {
    const currentUpdIds = alignRowIds(
      updateRowIdsByRule[ruleRowId] ?? [],
      rule.updates.length,
      `upd-${ruleRowId}`,
    );
    const nextUpdRowId = allocRowId('upd-row');
    setUpdateRowIdsByRule((prev) => ({
      ...prev,
      [ruleRowId]: [...currentUpdIds, nextUpdRowId],
    }));

    const targetVar = firstVariableOfKind(model.schema);
    const targetDef = model.schema[targetVar];
    const valExpr =
      targetDef !== undefined
        ? {
            op: 'lit' as const,
            value: defaultValueForVarDef(targetDef),
          }
        : createDefaultValueExpr('lit', model.schema);
    onChangeModel(updateRule(model, idx, addRuleUpdate(rule, { var: targetVar, value: valExpr })));
  };

  const handleRemoveRuleUpdate = (
    idx: number,
    rule: TransitionRule,
    ruleRowId: string,
    updIdx: number,
    updRowId: string,
  ) => {
    const currentUpdIds = alignRowIds(
      updateRowIdsByRule[ruleRowId] ?? [],
      rule.updates.length,
      `upd-${ruleRowId}`,
    );
    setUpdateRowIdsByRule((prev) => ({
      ...prev,
      [ruleRowId]: currentUpdIds.filter((_, i) => i !== updIdx),
    }));
    pruneDraftsByPrefix(`rule:${ruleRowId}.update:${updRowId}`);
    onChangeModel(updateRule(model, idx, removeRuleUpdate(rule, updIdx)));
  };

  const handleAddInvariant = () => {
    setInvRowIds([...resolvedInvRowIds, allocRowId('inv-row')]);
    onChangeModel(
      addInvariant(model, {
        id: `inv_${model.invariants.length + 1}`,
        label: `Invariant ${model.invariants.length + 1}`,
        holds: createDefaultBoolExpr('lit', model.schema),
      }),
    );
  };

  const handleRemoveInvariant = (idx: number, invRowId: string) => {
    setInvRowIds(resolvedInvRowIds.filter((_, i) => i !== idx));
    pruneDraftsByPrefix(`inv:${invRowId}`);
    onChangeModel(removeInvariant(model, idx));
  };

  const handleAddAssumption = () => {
    setAsmRowIds([...resolvedAsmRowIds, allocRowId('asm-row')]);
    onChangeModel(
      addAssumption(model, {
        id: `asm_${model.assumptions.length + 1}`,
        category: 'abstraction',
        statement: 'State what this discrete abstraction captures.',
        notModeled: 'State what remains outside the discrete model.',
      }),
    );
  };

  const handleRemoveAssumption = (idx: number) => {
    setAsmRowIds(resolvedAsmRowIds.filter((_, i) => i !== idx));
    onChangeModel(removeAssumption(model, idx));
  };

  const handleApplyJsonImport = () => {
    const result = importModelFromJson(jsonDraft);
    if (!result.ok) {
      setJsonErrors(result.errors);
      setJsonNotice(null);
      return;
    }
    setJsonErrors([]);
    preserveNextNoticeRef.current = true;
    setJsonNotice('Model JSON validated and loaded into editor.');
    onImportModel(result.model);
  };

  const handleCopyJson = async () => {
    const exported = tryExportModelJson(model);
    if (!exported.ok) {
      setJsonErrors([exported.error]);
      setJsonNotice(null);
      return;
    }
    const text = exported.text;
    if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined) {
      try {
        await navigator.clipboard.writeText(text);
        setJsonNotice('Exported JSON copied to clipboard.');
        return;
      } catch {
        // Fallback below
      }
    }
    committedJsonRef.current = text;
    setJsonDraft(text);
    onJsonDraftDirtyChangeRef.current?.(false);
    setJsonNotice('Synchronized current model JSON in the text area.');
  };

  const handleDownloadJson = () => {
    const exported = tryExportModelJson(model);
    if (!exported.ok) {
      setJsonErrors([exported.error]);
      setJsonNotice(null);
      return;
    }
    if (typeof document === 'undefined' || typeof URL === 'undefined') return;
    const blob = new Blob([exported.text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${model.id || 'agentgate-model'}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const renderInitialValueEditor = (varName: string, def: VarDef, rowId: string) => {
    const controlId = `schema-var-init-${rowId}`;
    const current = model.initialState[varName];
    if (def.kind === 'boolean') {
      return (
        <select
          id={controlId}
          className="ag-select ag-input-mono"
          aria-label={`Initial value for ${varName}`}
          value={current === true ? 'true' : 'false'}
          onChange={(e) =>
            onChangeModel(setInitialStateValue(model, varName, e.target.value === 'true'))
          }
        >
          <option value="false">false</option>
          <option value="true">true</option>
        </select>
      );
    }
    if (def.kind === 'enum') {
      const valueStr = typeof current === 'string' ? current : (def.values[0] ?? '');
      return (
        <select
          id={controlId}
          className="ag-select ag-input-mono"
          aria-label={`Initial value for ${varName}`}
          value={valueStr}
          onChange={(e) => onChangeModel(setInitialStateValue(model, varName, e.target.value))}
        >
          {!def.values.includes(valueStr) && <option value={valueStr}>{valueStr}</option>}
          {def.values.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      );
    }
    const numVal = typeof current === 'number' ? current : def.min;
    const initFieldKey = `schema:${rowId}.initial`;
    return (
      <StrictIntegerInput
        id={controlId}
        value={numVal}
        className="ag-input ag-input-num"
        ariaLabel={`Initial value for ${varName}`}
        resetKey={resetKey}
        fieldKey={initFieldKey}
        externalDraft={intDraftValues[initFieldKey]}
        externalError={intDraftErrors[initFieldKey]}
        onDraftChange={handleIntDraftChange}
        onCommit={(parsed) => onChangeModel(setInitialStateValue(model, varName, parsed))}
      />
    );
  };

  return (
    <section
      id="ag-editor-pane"
      tabIndex={-1}
      className="ag-pane ag-pane-editor"
      aria-label="Policy and schema editor"
    >
      <div className="ag-pane-header">
        <h2 className="ag-pane-title">Policy &amp; Schema Editor</h2>
        <span className="ag-meta-inline">
          {schemaKeys.length} vars / {model.rules.length} rules / {model.invariants.length} invariants
        </span>
      </div>

      <div className="ag-editor-shell">
        <aside className="ag-rule-sidebar" aria-label="Transition rules navigator">
          <div className="ag-rule-sidebar-content">
            <div className="ag-rule-sidebar-head">
              <h3 className="ag-rule-sidebar-title">Rules ({model.rules.length})</h3>
              <button
                ref={addRuleButtonRef}
                type="button"
                className="ag-btn ag-btn-primary ag-btn-sm"
                onClick={handleAddRule}
              >
                + Add Rule
              </button>
            </div>

            {model.rules.length > 0 ? (
              <div ref={ruleNavRef} className="ag-rule-nav" role="group" aria-label="Jump to transition rule">
                {model.rules.map((rule, idx) => {
                  const rowId = resolvedRuleRowIds[idx]!;
                  const traceSteps = activeTraceStepsByRuleId?.get(rule.id) ?? [];
                  const ruleErrors = getErrorsForPathPrefix(diagnostics, `rules[${idx}]`);
                  const hasRuleErrors =
                    ruleErrors.length > 0 || countIntDraftErrorsByPrefix(`rule:${rowId}`) > 0;
                  const isSelected = activeSelectedRuleRowId === rowId;
                  return (
                    <button
                      key={rowId}
                      type="button"
                      className="ag-rule-nav-btn"
                      data-rule-id={rule.id}
                      data-selected={isSelected ? 'true' : 'false'}
                      aria-pressed={isSelected}
                      onClick={() => selectRuleRow(rowId, false)}
                    >
                      <span className="ag-rule-nav-row">
                        <span className="ag-rule-nav-id" title={rule.id || '(unnamed rule)'}>
                          {rule.id || '(unnamed rule)'}
                        </span>
                        {(traceSteps.length > 0 || hasRuleErrors) && (
                          <span className="ag-rule-nav-badges">
                            {traceSteps.length > 0 && (
                              <span
                                className="ag-rule-step-tag"
                                title={`Executed at step ${traceSteps.join(', ')}`}
                              >
                                s{traceSteps.join(',')}
                              </span>
                            )}
                            {hasRuleErrors && (
                              <span
                                className="ag-rule-err-dot"
                                title="Rule has validation errors"
                                aria-label="Rule has validation errors"
                              >
                                !
                              </span>
                            )}
                          </span>
                        )}
                      </span>
                      <span className="ag-rule-nav-label">{rule.label || 'Untitled rule'}</span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <p className="ag-rule-sidebar-empty">No transition rules defined.</p>
            )}
          </div>
        </aside>

        <div className="ag-editor-main">
          <div className="ag-tablist" role="tablist" aria-label="Policy editor sections">
            {EDITOR_TABS.map((tab, idx) => {
              const errCount = tabErrorCount(tab.id);
              const isSelected = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  ref={(el) => {
                    tabRefs.current[tab.id] = el;
                  }}
                  id={`tab-${tab.id}`}
                  type="button"
                  role="tab"
                  className="ag-tab"
                  aria-selected={isSelected}
                  aria-controls={`panel-${tab.id}`}
                  tabIndex={isSelected ? 0 : -1}
                  onClick={() => setActiveTab(tab.id)}
                  onKeyDown={(e) => handleTabKeyDown(e, idx)}
                >
                  <span>{tab.label}</span>
                  {errCount > 0 && (
                    <span
                      className="ag-tab-count ag-tab-count-error"
                      aria-label={`${errCount} validation errors`}
                    >
                      {errCount}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

      <div
        id="panel-schema"
        role="tabpanel"
        aria-labelledby="tab-schema"
        className="ag-tabpanel"
        hidden={activeTab !== 'schema'}
      >
        <div className="ag-section">
          <h3 className="ag-section-title">Model Metadata</h3>
          <InlineErrorList errors={diagnostics.sections.general} />
          <div className="ag-row-grid">
            <div className="ag-field">
              <label htmlFor="model-id-input">Model ID</label>
              <input
                id="model-id-input"
                type="text"
                className="ag-input ag-input-mono"
                value={model.id}
                onChange={(e) => onChangeModel(updateModelMetadata(model, { id: e.target.value }))}
              />
            </div>
            <div className="ag-field">
              <label htmlFor="model-name-input">Model Name</label>
              <input
                id="model-name-input"
                type="text"
                className="ag-input"
                value={model.name}
                onChange={(e) =>
                  onChangeModel(updateModelMetadata(model, { name: e.target.value }))
                }
              />
            </div>
          </div>
        </div>

        <div className="ag-section">
          <div className="ag-section-header">
            <h3 className="ag-section-title">State Schema &amp; Initial State</h3>
            <span className="ag-mono ag-tabular" style={{ fontSize: 12, color: 'var(--color-ink-muted)' }}>
              {schemaKeys.length} / 64 variables
            </span>
          </div>

          <div className="ag-item-list">
            {schemaKeys.map((key) => {
              const rowId = getSchemaRowId(key);
              const def = model.schema[key]!;
              const varErrors = [
                ...getErrorsForPathPrefix(diagnostics, `schema.${key}`),
                ...getErrorsForPathPrefix(diagnostics, `initialState.${key}`),
              ];
              const nameDraft = Object.hasOwn(varNameDrafts, rowId) ? varNameDrafts[rowId]! : key;
              const nameError = Object.hasOwn(varNameErrors, rowId) ? varNameErrors[rowId]! : null;
              const minFieldKey = `schema:${rowId}.min`;
              const maxFieldKey = `schema:${rowId}.max`;

              return (
                <div key={rowId} className="ag-item-row">
                  <div className="ag-row-grid">
                    <div className="ag-field">
                      <label htmlFor={`schema-var-name-${rowId}`}>Variable</label>
                      <input
                        id={`schema-var-name-${rowId}`}
                        type="text"
                        className="ag-input ag-input-mono"
                        aria-label={`Variable name ${key}`}
                        aria-invalid={nameError !== null ? 'true' : undefined}
                        value={nameDraft}
                        onChange={(e) => handleRenameSchemaVar(rowId, key, def, e.target.value)}
                        onBlur={() => {
                          if (nameError === null && nameDraft !== key) {
                            setVarNameDrafts((prev) => {
                              const next = { ...prev };
                              delete next[rowId];
                              return next;
                            });
                          }
                        }}
                      />
                      {nameError !== null && (
                        <span className="ag-field-error" role="alert">
                          {nameError}
                        </span>
                      )}
                    </div>

                    <div className="ag-field">
                      <label htmlFor={`schema-var-kind-${rowId}`}>Kind</label>
                      <select
                        id={`schema-var-kind-${rowId}`}
                        className="ag-select ag-input-mono"
                        aria-label={`Type kind for ${key}`}
                        value={def.kind}
                        onChange={(e) => {
                          const kind = e.target.value as VarDef['kind'];
                          pruneDraftsByPrefix(`schema:${rowId}`);
                          const nextDef: VarDef =
                            kind === 'boolean'
                              ? { kind: 'boolean' }
                              : kind === 'enum'
                                ? { kind: 'enum', values: ['idle', 'active'] }
                                : { kind: 'int', min: 0, max: 3 };
                          onChangeModel(
                            updateSchemaVariable(
                              model,
                              key,
                              key,
                              nextDef,
                              defaultValueForVarDef(nextDef),
                            ),
                          );
                        }}
                      >
                        <option value="boolean">boolean</option>
                        <option value="enum">enum</option>
                        <option value="int">int</option>
                      </select>
                    </div>

                    {def.kind === 'enum' && (
                      <div className="ag-field">
                        <label htmlFor={`schema-var-enum-${rowId}`}>
                          Enum values (comma-separated)
                        </label>
                        <input
                          id={`schema-var-enum-${rowId}`}
                          type="text"
                          className="ag-input ag-input-mono"
                          aria-label={`Enum values for ${key}`}
                          value={def.values.join(', ')}
                          onChange={(e) => {
                            const values = e.target.value
                              .split(',')
                              .map((s) => s.trim())
                              .filter((s) => s.length > 0);
                            onChangeModel(
                              updateSchemaVariable(model, key, key, {
                                kind: 'enum',
                                values,
                              }),
                            );
                          }}
                        />
                      </div>
                    )}

                    {def.kind === 'int' && (
                      <>
                        <div className="ag-field">
                          <label htmlFor={`schema-var-min-${rowId}`}>Min</label>
                          <StrictIntegerInput
                            id={`schema-var-min-${rowId}`}
                            value={def.min}
                            className="ag-input ag-input-num"
                            ariaLabel={`Minimum for ${key}`}
                            resetKey={resetKey}
                            fieldKey={minFieldKey}
                            externalDraft={intDraftValues[minFieldKey]}
                            externalError={intDraftErrors[minFieldKey]}
                            onDraftChange={handleIntDraftChange}
                            onCommit={(min) =>
                              onChangeModel(
                                updateSchemaVariable(model, key, key, {
                                  kind: 'int',
                                  min,
                                  max: def.max,
                                }),
                              )
                            }
                          />
                        </div>
                        <div className="ag-field">
                          <label htmlFor={`schema-var-max-${rowId}`}>Max</label>
                          <StrictIntegerInput
                            id={`schema-var-max-${rowId}`}
                            value={def.max}
                            className="ag-input ag-input-num"
                            ariaLabel={`Maximum for ${key}`}
                            resetKey={resetKey}
                            fieldKey={maxFieldKey}
                            externalDraft={intDraftValues[maxFieldKey]}
                            externalError={intDraftErrors[maxFieldKey]}
                            onDraftChange={handleIntDraftChange}
                            onCommit={(max) =>
                              onChangeModel(
                                updateSchemaVariable(model, key, key, {
                                  kind: 'int',
                                  min: def.min,
                                  max,
                                }),
                              )
                            }
                          />
                        </div>
                      </>
                    )}

                    <div className="ag-field">
                      <label htmlFor={`schema-var-init-${rowId}`}>Initial Value</label>
                      {renderInitialValueEditor(key, def, rowId)}
                    </div>

                    <div className="ag-inline-actions">
                      <button
                        type="button"
                        className="ag-btn ag-btn-sm ag-btn-danger"
                        disabled={schemaKeys.length <= 1}
                        onClick={() => handleRemoveSchemaVar(key, rowId)}
                      >
                        Remove
                      </button>
                    </div>
                  </div>

                  <div className="ag-mono" style={{ fontSize: 11.5, color: 'var(--color-ink-muted)' }}>
                    Domain: {formatVarDef(def)} | Initial:{' '}
                    {model.initialState[key] !== undefined
                      ? formatStateValue(model.initialState[key]!)
                      : '<missing>'}
                  </div>
                  <InlineErrorList errors={varErrors} />
                </div>
              );
            })}
          </div>
        </div>

        <div className="ag-section">
          <h3 className="ag-section-title">Add State Variable</h3>
          <div className="ag-row-grid">
            <div className="ag-field">
              <label htmlFor="new-var-name">Variable Name</label>
              <input
                id="new-var-name"
                type="text"
                className="ag-input ag-input-mono"
                placeholder="e.g. reviewTokenValid"
                aria-invalid={newVarNameError !== null ? 'true' : undefined}
                value={newVarName}
                onChange={(e) => setNewVarName(e.target.value)}
              />
              {newVarNameError !== null && (
                <span className="ag-field-error" role="alert">
                  {newVarNameError}
                </span>
              )}
            </div>
            <div className="ag-field">
              <label htmlFor="new-var-kind">Type</label>
              <select
                id="new-var-kind"
                className="ag-select ag-input-mono"
                value={newVarKind}
                onChange={(e) => setNewVarKind(e.target.value as VarDef['kind'])}
              >
                <option value="boolean">boolean</option>
                <option value="enum">enum</option>
                <option value="int">int</option>
              </select>
            </div>
            {newVarKind === 'enum' && (
              <div className="ag-field">
                <label htmlFor="new-var-enum">Enum Values</label>
                <input
                  id="new-var-enum"
                  type="text"
                  className="ag-input ag-input-mono"
                  value={newVarEnumValues}
                  onChange={(e) => setNewVarEnumValues(e.target.value)}
                />
              </div>
            )}
            {newVarKind === 'int' && (
              <>
                <div className="ag-field">
                  <label htmlFor="new-var-min">Min</label>
                  <input
                    id="new-var-min"
                    type="text"
                    inputMode="numeric"
                    className="ag-input ag-input-num"
                    aria-invalid={!parsedNewVarMin.ok ? 'true' : undefined}
                    value={newVarMin}
                    onChange={(e) => setNewVarMin(e.target.value)}
                  />
                  {!parsedNewVarMin.ok && (
                    <span className="ag-field-error" role="alert">
                      {parsedNewVarMin.message}
                    </span>
                  )}
                </div>
                <div className="ag-field">
                  <label htmlFor="new-var-max">Max</label>
                  <input
                    id="new-var-max"
                    type="text"
                    inputMode="numeric"
                    className="ag-input ag-input-num"
                    aria-invalid={!parsedNewVarMax.ok || newVarRangeError !== null ? 'true' : undefined}
                    value={newVarMax}
                    onChange={(e) => setNewVarMax(e.target.value)}
                  />
                  {!parsedNewVarMax.ok && (
                    <span className="ag-field-error" role="alert">
                      {parsedNewVarMax.message}
                    </span>
                  )}
                  {newVarRangeError !== null && (
                    <span className="ag-field-error" role="alert">
                      {newVarRangeError}
                    </span>
                  )}
                </div>
              </>
            )}
            <div>
              <button
                type="button"
                className="ag-btn ag-btn-primary ag-btn-sm"
                disabled={
                  trimmedNewVarName.length === 0 ||
                  newVarNameError !== null ||
                  newVarIntInvalid
                }
                onClick={handleAddSchemaVar}
              >
                + Add Variable
              </button>
            </div>
          </div>
        </div>
      </div>

      <div
        id="panel-rules"
        role="tabpanel"
        aria-labelledby="tab-rules"
        className="ag-tabpanel"
        hidden={activeTab !== 'rules'}
      >
        <div className="ag-section">
          {selectedRule !== null && activeSelectedRuleRowId !== null ? (
            (() => {
              const idx = selectedRuleIndex;
              const rowId = activeSelectedRuleRowId;
              const rule = selectedRule;
              const traceSteps = activeTraceStepsByRuleId?.get(rule.id) ?? [];
              const summary = formatRuleSummary(rule);
              const ruleErrors = getErrorsForPathPrefix(diagnostics, `rules[${idx}]`);
              const resolvedUpdRowIds = alignRowIds(
                updateRowIdsByRule[rowId] ?? [],
                rule.updates.length,
                `upd-${rowId}`,
              );
              const showPrincipledShortcut =
                rule.id === 'publish_release_notes' &&
                Object.hasOwn(model.schema, 'modifiedSinceApproval') &&
                model.schema['modifiedSinceApproval']?.kind === 'boolean' &&
                !guardContainsNegatedVar(rule.guard, 'modifiedSinceApproval');
              const showQuickAppend =
                booleanKeys.length > 0 &&
                selectedQuickVar.length > 0 &&
                !(
                  showPrincipledShortcut &&
                  quickClauseNegated &&
                  selectedQuickVar === 'modifiedSinceApproval'
                );

              return (
                <div
                  key={rowId}
                  className="ag-item-row ag-rule-detail"
                  data-rule-id={rule.id}
                >
                  <div className="ag-rule-detail-head">
                    <div className="ag-rule-detail-title-wrap">
                      <h3 className="ag-section-title ag-rule-detail-title">
                        <span className="ag-mono">{summary.id}</span>
                        <span className="ag-rule-detail-subtitle">: {summary.label}</span>
                      </h3>
                      {traceSteps.length > 0 && (
                        <span className="ag-rule-step-tag">
                          Trace Step {traceSteps.join(', ')}
                        </span>
                      )}
                    </div>

                    <div className="ag-inline-actions">
                      <button
                        type="button"
                        className="ag-btn ag-btn-sm"
                        disabled={idx === 0}
                        aria-label={`Move rule ${rule.id} up`}
                        onClick={() => handleMoveRule(idx, idx - 1)}
                      >
                        Up
                      </button>
                      <button
                        type="button"
                        className="ag-btn ag-btn-sm"
                        disabled={idx === model.rules.length - 1}
                        aria-label={`Move rule ${rule.id} down`}
                        onClick={() => handleMoveRule(idx, idx + 1)}
                      >
                        Down
                      </button>
                      <button
                        type="button"
                        className="ag-btn ag-btn-sm ag-btn-danger"
                        aria-label={`Remove rule ${rule.id}`}
                        onClick={() => handleRemoveRule(idx, rowId)}
                      >
                        Remove
                      </button>
                    </div>
                  </div>

                  <div className="ag-code-strip ag-rule-prop-strip">
                    <span className="ag-code-muted">when</span>
                    <span className="ag-rule-prop-expr">{summary.guardText}</span>
                    <span className="ag-code-muted">then</span>
                    <span className="ag-rule-prop-expr">
                      {summary.updatesText.length > 0 ? summary.updatesText.join('; ') : 'no-op'}
                    </span>
                  </div>

                  {showPrincipledShortcut && (
                    <div className="ag-rule-candidate">
                      <span>Candidate guard</span>
                      <button
                        type="button"
                        className="ag-btn ag-btn-sm ag-btn-active"
                        onClick={() =>
                          handleAppendRuleGuardClause(idx, rule, rowId, {
                            op: 'not',
                            arg: { op: 'var', name: 'modifiedSinceApproval' },
                          })
                        }
                      >
                        + Add !modifiedSinceApproval
                      </button>
                    </div>
                  )}

                  <InlineErrorList errors={ruleErrors} />

                  <div className="ag-rule-detail-body">
                    <div className="ag-row-grid">
                      <div className="ag-field">
                        <label htmlFor={`rule-id-${rowId}`}>Rule ID</label>
                        <input
                          ref={(el) => {
                            ruleFocusRefs.current[rowId] = el;
                          }}
                          id={`rule-id-${rowId}`}
                          type="text"
                          className="ag-input ag-input-mono"
                          value={rule.id}
                          onChange={(e) =>
                            onChangeModel(
                              updateRule(model, idx, { ...rule, id: e.target.value }),
                            )
                          }
                        />
                      </div>
                      <div className="ag-field">
                        <label htmlFor={`rule-label-${rowId}`}>Label</label>
                        <input
                          id={`rule-label-${rowId}`}
                          type="text"
                          className="ag-input"
                          value={rule.label}
                          onChange={(e) =>
                            onChangeModel(
                              updateRule(model, idx, { ...rule, label: e.target.value }),
                            )
                          }
                        />
                      </div>
                    </div>

                    <div className="ag-field ag-rule-subsection">
                      <span className="ag-field-label">Guard Expression</span>
                      {booleanKeys.length > 0 && selectedQuickVar.length > 0 && (
                        <details className="ag-quick-clause">
                          <summary>Quick guard clause</summary>
                          <div className="ag-helper-bar">
                            <span className="ag-inline-field">
                              <label htmlFor="quick-clause-polarity" className="ag-inline-label">
                                Polarity
                              </label>
                              <select
                                id="quick-clause-polarity"
                                className="ag-select ag-input-mono"
                                aria-label="Quick clause polarity"
                                value={quickClauseNegated ? 'not' : 'var'}
                                onChange={(e) => setQuickClauseNegated(e.target.value === 'not')}
                              >
                                <option value="not">! (negated)</option>
                                <option value="var">true (positive)</option>
                              </select>
                            </span>
                            <span className="ag-inline-field">
                              <label htmlFor="quick-clause-var" className="ag-inline-label">
                                Variable
                              </label>
                              <select
                                id="quick-clause-var"
                                className="ag-select ag-input-mono"
                                aria-label="Quick clause boolean variable"
                                value={selectedQuickVar}
                                onChange={(e) => setQuickClauseVar(e.target.value)}
                              >
                                {booleanKeys.map((k) => (
                                  <option key={k} value={k}>
                                    {k}
                                  </option>
                                ))}
                              </select>
                            </span>
                            {showQuickAppend && (
                              <button
                                type="button"
                                className="ag-btn ag-btn-sm"
                                onClick={() => {
                                  const clause: BoolExpr = quickClauseNegated
                                    ? { op: 'not', arg: { op: 'var', name: selectedQuickVar } }
                                    : { op: 'var', name: selectedQuickVar };
                                  handleAppendRuleGuardClause(idx, rule, rowId, clause);
                                }}
                              >
                                + Append {quickClauseNegated ? `!${selectedQuickVar}` : selectedQuickVar}
                              </button>
                            )}
                          </div>
                        </details>
                      )}
                      <BoolExprEditor
                        value={rule.guard}
                        schema={model.schema}
                        schemaKeysOrder={schemaKeys}
                        ariaLabelPrefix={`Rule ${rule.id} guard`}
                        resetKey={resetKey}
                        fieldPath={`rule:${rowId}.guard`}
                        intDraftStore={intDraftStore}
                        onChange={(nextGuard) =>
                          onChangeModel(
                            updateRule(model, idx, { ...rule, guard: nextGuard }),
                          )
                        }
                      />
                    </div>

                    <div className="ag-field ag-rule-subsection">
                      <div className="ag-section-header">
                        <span className="ag-field-label">
                          Atomic Updates ({rule.updates.length})
                        </span>
                        <button
                          type="button"
                          className="ag-btn ag-btn-sm"
                          onClick={() => handleAddRuleUpdate(idx, rule, rowId)}
                        >
                          + Add Update
                        </button>
                      </div>

                      {rule.updates.length > 0 ? (
                        <div className="ag-update-list">
                          {rule.updates.map((upd, updIdx) => {
                            const updRowId = resolvedUpdRowIds[updIdx]!;
                            const updVarSelectId = `rule-upd-var-${rowId}-${updRowId}`;
                            return (
                              <div key={updRowId} className="ag-expr-row ag-update-row">
                                <span className="ag-inline-field">
                                  <label htmlFor={updVarSelectId} className="ag-inline-label">
                                    Target variable
                                  </label>
                                  <select
                                    id={updVarSelectId}
                                    className="ag-select ag-input-mono"
                                    aria-label={`Update ${updIdx + 1} target variable for ${rule.id}`}
                                    value={upd.var}
                                    onChange={(e) =>
                                      onChangeModel(
                                        updateRule(
                                          model,
                                          idx,
                                          updateRuleUpdate(rule, updIdx, {
                                            ...upd,
                                            var: e.target.value,
                                          }),
                                        ),
                                      )
                                    }
                                  >
                                    {!schemaKeys.includes(upd.var) && (
                                      <option value={upd.var}>{upd.var} (undeclared)</option>
                                    )}
                                    {schemaKeys.map((k) => (
                                      <option key={k} value={k}>
                                        {k}
                                      </option>
                                    ))}
                                  </select>
                                </span>
                                <span className="ag-mono ag-update-assign" aria-hidden="true">
                                  :=
                                </span>
                                <button
                                  type="button"
                                  className="ag-btn ag-btn-sm ag-btn-danger"
                                  onClick={() =>
                                    handleRemoveRuleUpdate(idx, rule, rowId, updIdx, updRowId)
                                  }
                                >
                                  Remove
                                </button>
                                <div className="ag-update-value">
                                  <ValueExprEditor
                                    value={upd.value}
                                    schema={model.schema}
                                    schemaKeysOrder={schemaKeys}
                                    ariaLabelPrefix={`Update ${updIdx + 1} value for ${rule.id}`}
                                    resetKey={resetKey}
                                    fieldPath={`rule:${rowId}.update:${updRowId}.value`}
                                    intDraftStore={intDraftStore}
                                    onChange={(nextVal) =>
                                      onChangeModel(
                                        updateRule(
                                          model,
                                          idx,
                                          updateRuleUpdate(rule, updIdx, {
                                            ...upd,
                                            value: nextVal,
                                          }),
                                        ),
                                      )
                                    }
                                  />
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        <p className="ag-pane-subtitle">
                          No atomic state updates (rule acts as a no-op transition when guard holds).
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              );
            })()
          ) : (
            <p className="ag-pane-subtitle">
              Add a rule from the navigator to edit its guard and updates.
            </p>
          )}
        </div>
      </div>

      <div
        id="panel-invariants"
        role="tabpanel"
        aria-labelledby="tab-invariants"
        className="ag-tabpanel"
        hidden={activeTab !== 'invariants'}
      >
        <div className="ag-section">
          <div className="ag-section-header">
            <h3 className="ag-section-title">Safety Invariants ({model.invariants.length})</h3>
            <button
              type="button"
              className="ag-btn ag-btn-primary ag-btn-sm"
              onClick={handleAddInvariant}
            >
              + Add Invariant
            </button>
          </div>

          <div className="ag-item-list">
            {model.invariants.map((inv, idx) => {
              const rowId = resolvedInvRowIds[idx]!;
              const invErrors = getErrorsForPathPrefix(diagnostics, `invariants[${idx}]`);
              return (
                <div key={rowId} className="ag-item-row">
                  <div className="ag-row-grid">
                    <div className="ag-field">
                      <label htmlFor={`inv-id-${rowId}`}>Invariant ID</label>
                      <input
                        id={`inv-id-${rowId}`}
                        type="text"
                        className="ag-input ag-input-mono"
                        value={inv.id}
                        onChange={(e) =>
                          onChangeModel(updateInvariant(model, idx, { ...inv, id: e.target.value }))
                        }
                      />
                    </div>
                    <div className="ag-field">
                      <label htmlFor={`inv-label-${rowId}`}>Description</label>
                      <input
                        id={`inv-label-${rowId}`}
                        type="text"
                        className="ag-input"
                        value={inv.label}
                        onChange={(e) =>
                          onChangeModel(
                            updateInvariant(model, idx, { ...inv, label: e.target.value }),
                          )
                        }
                      />
                    </div>
                    <div>
                      <button
                        type="button"
                        className="ag-btn ag-btn-sm ag-btn-danger"
                        disabled={model.invariants.length <= 1}
                        onClick={() => handleRemoveInvariant(idx, rowId)}
                      >
                        Remove
                      </button>
                    </div>
                  </div>

                  <div className="ag-code-strip">
                    <span className="ag-code-muted">holds </span>
                    {formatBoolExpr(inv.holds)}
                  </div>

                  <BoolExprEditor
                    value={inv.holds}
                    schema={model.schema}
                    schemaKeysOrder={schemaKeys}
                    ariaLabelPrefix={`Invariant ${inv.id} expression`}
                    resetKey={resetKey}
                    fieldPath={`inv:${rowId}.holds`}
                    intDraftStore={intDraftStore}
                    onChange={(holds) => onChangeModel(updateInvariant(model, idx, { ...inv, holds }))}
                  />
                  <InlineErrorList errors={invErrors} />
                </div>
              );
            })}
          </div>
        </div>

        <div className="ag-section">
          <div className="ag-section-header">
            <h3 className="ag-section-title">Declared Reachability Goal (Vacuous-Fix Check)</h3>
            <label
              htmlFor="goal-enabled-checkbox"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13 }}
            >
              <input
                id="goal-enabled-checkbox"
                type="checkbox"
                checked={model.goal !== undefined}
                onChange={(e) => {
                  if (!e.target.checked) {
                    pruneDraftsByPrefix('goal.reached');
                  }
                  onChangeModel(setGoalEnabled(model, e.target.checked));
                }}
              />
              Enable declared goal
            </label>
          </div>

          {model.goal !== undefined ? (
            <div className="ag-item-row" style={{ borderTop: '1px solid var(--color-rule)' }}>
              <div className="ag-row-grid">
                <div className="ag-field">
                  <label htmlFor="goal-id-input">Goal ID</label>
                  <input
                    id="goal-id-input"
                    type="text"
                    className="ag-input ag-input-mono"
                    value={model.goal.id}
                    onChange={(e) =>
                      onChangeModel(updateGoal(model, { ...model.goal!, id: e.target.value }))
                    }
                  />
                </div>
                <div className="ag-field">
                  <label htmlFor="goal-label-input">Goal Label</label>
                  <input
                    id="goal-label-input"
                    type="text"
                    className="ag-input"
                    value={model.goal.label}
                    onChange={(e) =>
                      onChangeModel(updateGoal(model, { ...model.goal!, label: e.target.value }))
                    }
                  />
                </div>
              </div>

              <div className="ag-code-strip">
                <span className="ag-code-muted">reached </span>
                {formatBoolExpr(model.goal.reached)}
              </div>

              <BoolExprEditor
                value={model.goal.reached}
                schema={model.schema}
                schemaKeysOrder={schemaKeys}
                ariaLabelPrefix="Goal reached predicate"
                resetKey={resetKey}
                fieldPath="goal.reached"
                intDraftStore={intDraftStore}
                onChange={(reached) => onChangeModel(updateGoal(model, { ...model.goal!, reached }))}
              />
              <InlineErrorList errors={diagnostics.sections.goal} />
            </div>
          ) : (
            <p className="ag-pane-subtitle">
              No reachability goal declared. Enabling a goal detects vacuous policies that satisfy invariants solely by disabling useful transitions.
            </p>
          )}
        </div>
      </div>

      <div
        id="panel-assumptions"
        role="tabpanel"
        aria-labelledby="tab-assumptions"
        className="ag-tabpanel"
        hidden={activeTab !== 'assumptions'}
      >
        <div className="ag-section">
          <div className="ag-section-header">
            <h3 className="ag-section-title">Explicit Modeling Assumptions ({model.assumptions.length})</h3>
            <button
              type="button"
              className="ag-btn ag-btn-primary ag-btn-sm"
              onClick={handleAddAssumption}
            >
              + Add Assumption
            </button>
          </div>

          <div className="ag-item-list">
            {model.assumptions.map((asm, idx) => {
              const rowId = resolvedAsmRowIds[idx]!;
              const asmErrors = getErrorsForPathPrefix(diagnostics, `assumptions[${idx}]`);
              return (
                <div key={rowId} className="ag-item-row">
                  <div className="ag-row-grid">
                    <div className="ag-field">
                      <label htmlFor={`asm-id-${rowId}`}>Assumption ID</label>
                      <input
                        id={`asm-id-${rowId}`}
                        type="text"
                        className="ag-input ag-input-mono"
                        value={asm.id}
                        onChange={(e) =>
                          onChangeModel(
                            updateAssumption(model, idx, { ...asm, id: e.target.value }),
                          )
                        }
                      />
                    </div>
                    <div className="ag-field">
                      <label htmlFor={`asm-category-${rowId}`}>Category</label>
                      <input
                        id={`asm-category-${rowId}`}
                        type="text"
                        className="ag-input ag-input-mono"
                        value={asm.category}
                        onChange={(e) =>
                          onChangeModel(
                            updateAssumption(model, idx, { ...asm, category: e.target.value }),
                          )
                        }
                      />
                    </div>
                    <div>
                      <button
                        type="button"
                        className="ag-btn ag-btn-sm ag-btn-danger"
                        disabled={model.assumptions.length <= 1}
                        onClick={() => handleRemoveAssumption(idx)}
                      >
                        Remove
                      </button>
                    </div>
                  </div>

                  <div className="ag-field">
                    <label htmlFor={`asm-statement-${rowId}`}>Captured Statement</label>
                    <textarea
                      id={`asm-statement-${rowId}`}
                      rows={2}
                      className="ag-textarea"
                      value={asm.statement}
                      onChange={(e) =>
                        onChangeModel(
                          updateAssumption(model, idx, { ...asm, statement: e.target.value }),
                        )
                      }
                    />
                  </div>
                  <div className="ag-field">
                    <label htmlFor={`asm-not-modeled-${rowId}`}>Explicitly Not Modeled</label>
                    <textarea
                      id={`asm-not-modeled-${rowId}`}
                      rows={2}
                      className="ag-textarea"
                      value={asm.notModeled}
                      onChange={(e) =>
                        onChangeModel(
                          updateAssumption(model, idx, { ...asm, notModeled: e.target.value }),
                        )
                      }
                    />
                  </div>
                  <InlineErrorList errors={asmErrors} />
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div
        id="panel-json"
        role="tabpanel"
        aria-labelledby="tab-json"
        className="ag-tabpanel"
        hidden={activeTab !== 'json'}
      >
        <div className="ag-section">
          <div className="ag-section-header">
            <h3 className="ag-section-title">Portable Model JSON Import &amp; Export</h3>
            <div className="ag-inline-actions">
              <button type="button" className="ag-btn ag-btn-sm" onClick={handleCopyJson}>
                Copy JSON
              </button>
              <button type="button" className="ag-btn ag-btn-sm" onClick={handleDownloadJson}>
                Download JSON
              </button>
              <button
                type="button"
                className="ag-btn ag-btn-primary ag-btn-sm"
                onClick={handleApplyJsonImport}
              >
                Import JSON
              </button>
            </div>
          </div>

          {jsonNotice !== null && (
            <p className="ag-scope-note" role="status">
              {jsonNotice}
            </p>
          )}

          {jsonErrors.length > 0 && (
            <div className="ag-alert" role="alert">
              <strong>
                {jsonErrors.every((err) => err.code === 'JSON_EXPORT_ERROR')
                  ? `JSON Export Failed (${jsonErrors.length})`
                  : `JSON Import Validation Failed (${jsonErrors.length})`}
              </strong>
              <ul>
                {jsonErrors.map((err, idx) => (
                  <li key={`${err.code}-${err.path}-${idx}`}>
                    <code>{err.path}</code>: {err.message} (<code>{err.code}</code>)
                  </li>
                ))}
              </ul>
            </div>
          )}

            <div className="ag-field">
              <label htmlFor="model-json-textarea">TransitionSystemModel JSON</label>
              <textarea
                id="model-json-textarea"
                rows={20}
                className="ag-textarea ag-textarea-mono"
                spellCheck={false}
                value={jsonDraft}
                onChange={(e) => {
                  const nextVal = e.target.value;
                  setJsonDraft(nextVal);
                  onJsonDraftDirtyChangeRef.current?.(nextVal !== committedJsonRef.current);
                }}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
    </section>
  );
}
