import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
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
import { BoolExprEditor, ValueExprEditor } from './ExprEditor.js';
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

export interface PolicyEditorPaneProps {
  readonly model: TransitionSystemModel;
  readonly diagnostics: ModelDiagnosticsIndex;
  readonly resetKey?: string | number | undefined;
  readonly onChangeModel: (next: TransitionSystemModel) => void;
  readonly onImportModel: (imported: TransitionSystemModel) => void;
  readonly onDraftErrorChange?: ((fieldKey: string, errorMessage: string | null) => void) | undefined;
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

function buildInitialRowIds(prefix: string, count: number, counterRef: { current: number }): string[] {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    counterRef.current += 1;
    ids.push(`${prefix}-${counterRef.current}`);
  }
  return ids;
}

function alignRowIds(current: readonly string[], targetLength: number, prefix: string): readonly string[] {
  if (current.length === targetLength) return current;
  if (current.length > targetLength) return current.slice(0, targetLength);
  const next = [...current];
  for (let i = current.length; i < targetLength; i += 1) {
    next.push(`${prefix}-sync-${i}`);
  }
  return next;
}

export function PolicyEditorPane({
  model,
  diagnostics,
  resetKey = 0,
  onChangeModel,
  onImportModel,
  onDraftErrorChange,
}: PolicyEditorPaneProps) {
  const nextRowIdRef = useRef<number>(0);
  const prevResetKeyRef = useRef<string | number>(resetKey);

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
  const [newVarName, setNewVarName] = useState('');
  const [newVarKind, setNewVarKind] = useState<VarDef['kind']>('boolean');
  const [newVarEnumValues, setNewVarEnumValues] = useState('alpha, beta');
  const [newVarMin, setNewVarMin] = useState('0');
  const [newVarMax, setNewVarMax] = useState('3');

  const [quickClauseVar, setQuickClauseVar] = useState<string>('modifiedSinceApproval');
  const [quickClauseNegated, setQuickClauseNegated] = useState<boolean>(true);

  const [jsonDraft, setJsonDraft] = useState<string>(() => exportModelToJson(model));
  const [jsonErrors, setJsonErrors] = useState<readonly ValidationError[]>([]);
  const [jsonNotice, setJsonNotice] = useState<string | null>(null);

  const [schemaRowIds, setSchemaRowIds] = useState<readonly string[]>(() =>
    buildInitialRowIds('schema-row', Object.keys(model.schema).length, nextRowIdRef),
  );
  const [ruleRowIds, setRuleRowIds] = useState<readonly string[]>(() =>
    buildInitialRowIds('rule-row', model.rules.length, nextRowIdRef),
  );
  const [invRowIds, setInvRowIds] = useState<readonly string[]>(() =>
    buildInitialRowIds('inv-row', model.invariants.length, nextRowIdRef),
  );
  const [asmRowIds, setAsmRowIds] = useState<readonly string[]>(() =>
    buildInitialRowIds('asm-row', model.assumptions.length, nextRowIdRef),
  );

  const [expandedRuleIds, setExpandedRuleIds] = useState<ReadonlySet<string>>(() => {
    const initial = new Set<string>();
    model.rules.forEach((rule, idx) => {
      if (rule.id === 'publish_release_notes') {
        const rowId = ruleRowIds[idx];
        if (rowId !== undefined) initial.add(rowId);
      }
    });
    return initial;
  });

  const [varNameDrafts, setVarNameDrafts] = useState<Readonly<Record<string, string>>>({});
  const [varNameErrors, setVarNameErrors] = useState<Readonly<Record<string, string>>>({});

  useEffect(() => {
    setJsonDraft(exportModelToJson(model));
    setJsonErrors([]);
    setJsonNotice(null);
  }, [model]);

  useEffect(() => {
    if (prevResetKeyRef.current !== resetKey) {
      prevResetKeyRef.current = resetKey;
      const nextSchemaIds = buildInitialRowIds(
        'schema-row',
        Object.keys(model.schema).length,
        nextRowIdRef,
      );
      const nextRuleIds = buildInitialRowIds('rule-row', model.rules.length, nextRowIdRef);
      const nextInvIds = buildInitialRowIds('inv-row', model.invariants.length, nextRowIdRef);
      const nextAsmIds = buildInitialRowIds('asm-row', model.assumptions.length, nextRowIdRef);

      setSchemaRowIds(nextSchemaIds);
      setRuleRowIds(nextRuleIds);
      setInvRowIds(nextInvIds);
      setAsmRowIds(nextAsmIds);

      const nextExpanded = new Set<string>();
      model.rules.forEach((rule, idx) => {
        if (rule.id === 'publish_release_notes') {
          const rowId = nextRuleIds[idx];
          if (rowId !== undefined) nextExpanded.add(rowId);
        }
      });
      setExpandedRuleIds(nextExpanded);
      setVarNameDrafts({});
      setVarNameErrors({});
    }
  }, [resetKey, model]);

  const schemaKeys = Object.keys(model.schema);
  const resolvedSchemaRowIds = alignRowIds(schemaRowIds, schemaKeys.length, 'schema-row');
  const resolvedRuleRowIds = alignRowIds(ruleRowIds, model.rules.length, 'rule-row');
  const resolvedInvRowIds = alignRowIds(invRowIds, model.invariants.length, 'inv-row');
  const resolvedAsmRowIds = alignRowIds(asmRowIds, model.assumptions.length, 'asm-row');

  const booleanKeys = schemaKeys.filter((k) => model.schema[k]?.kind === 'boolean');
  const selectedQuickVar = booleanKeys.includes(quickClauseVar)
    ? quickClauseVar
    : (booleanKeys[0] ?? schemaKeys[0] ?? '');

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

  const tabErrorCount = (tab: EditorTabId): number => {
    switch (tab) {
      case 'schema':
        return diagnostics.sections.schema.length + diagnostics.sections.general.length;
      case 'rules':
        return diagnostics.sections.rules.length;
      case 'invariants':
        return diagnostics.sections.invariants.length + diagnostics.sections.goal.length;
      case 'assumptions':
        return diagnostics.sections.assumptions.length;
      case 'json':
        return jsonErrors.length;
    }
  };

  const toggleRuleExpanded = (rowId: string) => {
    setExpandedRuleIds((prev) => {
      const next = new Set(prev);
      if (next.has(rowId)) {
        next.delete(rowId);
      } else {
        next.add(rowId);
      }
      return next;
    });
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

    setSchemaRowIds([...resolvedSchemaRowIds, allocRowId('schema-row')]);
    onChangeModel(addSchemaVariable(model, trimmedNewVarName, def));
    setNewVarName('');
  };

  const handleRemoveSchemaVar = (idx: number, key: string, rowId: string) => {
    setSchemaRowIds(resolvedSchemaRowIds.filter((_, i) => i !== idx));
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
    onDraftErrorChange?.(`schema.${rowId}.name`, null);
    onChangeModel(removeSchemaVariable(model, key));
  };

  const handleRenameSchemaVar = (rowId: string, oldKey: string, def: VarDef, rawNext: string) => {
    setVarNameDrafts((prev) => ({ ...prev, [rowId]: rawNext }));
    const trimmed = rawNext.trim();

    if (trimmed.length === 0) {
      const msg = 'Variable name must not be empty.';
      setVarNameErrors((prev) => ({ ...prev, [rowId]: msg }));
      onDraftErrorChange?.(`schema.${rowId}.name`, msg);
      return;
    }
    if (RESERVED_SCHEMA_NAMES.has(trimmed)) {
      const msg = `Variable name "${trimmed}" is reserved.`;
      setVarNameErrors((prev) => ({ ...prev, [rowId]: msg }));
      onDraftErrorChange?.(`schema.${rowId}.name`, msg);
      return;
    }
    if (trimmed !== oldKey && Object.hasOwn(model.schema, trimmed)) {
      const msg = `Variable name "${trimmed}" is already declared.`;
      setVarNameErrors((prev) => ({ ...prev, [rowId]: msg }));
      onDraftErrorChange?.(`schema.${rowId}.name`, msg);
      return;
    }

    setVarNameErrors((prev) => {
      if (!(rowId in prev)) return prev;
      const next = { ...prev };
      delete next[rowId];
      return next;
    });
    onDraftErrorChange?.(`schema.${rowId}.name`, null);

    if (trimmed !== oldKey) {
      onChangeModel(updateSchemaVariable(model, oldKey, trimmed, def));
    }
  };

  const handleAddRule = () => {
    const newRowId = allocRowId('rule-row');
    setRuleRowIds([...resolvedRuleRowIds, newRowId]);
    setExpandedRuleIds((prev) => {
      const next = new Set(prev);
      next.add(newRowId);
      return next;
    });
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
    setRuleRowIds(resolvedRuleRowIds.filter((_, i) => i !== idx));
    setExpandedRuleIds((prev) => {
      if (!prev.has(rowId)) return prev;
      const next = new Set(prev);
      next.delete(rowId);
      return next;
    });
    onChangeModel(removeRule(model, idx));
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

  const handleRemoveInvariant = (idx: number) => {
    setInvRowIds(resolvedInvRowIds.filter((_, i) => i !== idx));
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
    setJsonNotice('Model JSON validated and loaded into editor.');
    onImportModel(result.model);
  };

  const handleCopyJson = async () => {
    const text = exportModelToJson(model);
    if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined) {
      try {
        await navigator.clipboard.writeText(text);
        setJsonNotice('Exported JSON copied to clipboard.');
        return;
      } catch {
        // Fallback below
      }
    }
    setJsonDraft(text);
    setJsonNotice('Synchronized current model JSON in the text area.');
  };

  const handleDownloadJson = () => {
    if (typeof document === 'undefined' || typeof URL === 'undefined') return;
    const blob = new Blob([exportModelToJson(model)], { type: 'application/json' });
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
    return (
      <StrictIntegerInput
        id={controlId}
        value={numVal}
        className="ag-input ag-input-num"
        ariaLabel={`Initial value for ${varName}`}
        resetKey={resetKey}
        fieldKey={`initialState.${varName}`}
        onValidityChange={onDraftErrorChange}
        onCommit={(parsed) => onChangeModel(setInitialStateValue(model, varName, parsed))}
      />
    );
  };

  return (
    <section className="ag-pane ag-pane-editor" aria-label="Policy and schema editor">
      <div className="ag-pane-header">
        <div>
          <h2 className="ag-pane-title">Policy &amp; Schema Editor</h2>
          <p className="ag-pane-subtitle">
            Edit finite-state variables, transition guards, atomic updates, invariants, goal, and assumptions.
          </p>
        </div>
        <span className="ag-mono ag-tabular" style={{ fontSize: 12, color: 'var(--color-ink-muted)' }}>
          {schemaKeys.length} vars, {model.rules.length} rules, {model.invariants.length} invariants
        </span>
      </div>

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

      {activeTab === 'schema' && (
        <div
          id="panel-schema"
          role="tabpanel"
          aria-labelledby="tab-schema"
          className="ag-tabpanel"
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
              {schemaKeys.map((key, idx) => {
                const rowId = resolvedSchemaRowIds[idx]!;
                const def = model.schema[key]!;
                const varErrors = [
                  ...getErrorsForPathPrefix(diagnostics, `schema.${key}`),
                  ...getErrorsForPathPrefix(diagnostics, `initialState.${key}`),
                ];
                const nameDraft = Object.hasOwn(varNameDrafts, rowId) ? varNameDrafts[rowId]! : key;
                const nameError = Object.hasOwn(varNameErrors, rowId) ? varNameErrors[rowId]! : null;

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
                              fieldKey={`schema.${key}.min`}
                              onValidityChange={onDraftErrorChange}
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
                              fieldKey={`schema.${key}.max`}
                              onValidityChange={onDraftErrorChange}
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
                          onClick={() => handleRemoveSchemaVar(idx, key, rowId)}
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
      )}

      {activeTab === 'rules' && (
        <div
          id="panel-rules"
          role="tabpanel"
          aria-labelledby="tab-rules"
          className="ag-tabpanel"
        >
          <div className="ag-section">
            <div className="ag-section-header">
              <h3 className="ag-section-title">Transition Rules ({model.rules.length})</h3>
              <button
                type="button"
                className="ag-btn ag-btn-primary ag-btn-sm"
                onClick={handleAddRule}
              >
                + Add Rule
              </button>
            </div>

            {selectedQuickVar.length > 0 && (
              <div className="ag-helper-bar">
                <strong>Quick guard clause:</strong>
                <select
                  className="ag-select ag-input-mono"
                  aria-label="Quick clause polarity"
                  value={quickClauseNegated ? 'not' : 'var'}
                  onChange={(e) => setQuickClauseNegated(e.target.value === 'not')}
                >
                  <option value="not">! (negated)</option>
                  <option value="var">true (positive)</option>
                </select>
                <select
                  className="ag-select ag-input-mono"
                  aria-label="Quick clause boolean variable"
                  value={selectedQuickVar}
                  onChange={(e) => setQuickClauseVar(e.target.value)}
                >
                  {(booleanKeys.length > 0 ? booleanKeys : schemaKeys).map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </select>
                <span style={{ color: 'var(--color-ink-muted)' }}>
                  Use “+ Append Clause” on any rule below.
                </span>
              </div>
            )}

            <div className="ag-item-list">
              {model.rules.map((rule: TransitionRule, idx: number) => {
                const rowId = resolvedRuleRowIds[idx]!;
                const isExpanded = expandedRuleIds.has(rowId);
                const summary = formatRuleSummary(rule);
                const ruleErrors = getErrorsForPathPrefix(diagnostics, `rules[${idx}]`);
                const showPrincipledShortcut =
                  rule.id === 'publish_release_notes' &&
                  Object.hasOwn(model.schema, 'modifiedSinceApproval') &&
                  !guardContainsNegatedVar(rule.guard, 'modifiedSinceApproval');

                return (
                  <div key={rowId} className="ag-item-row">
                    <div className="ag-section-header">
                      <div>
                        <span className="ag-mono" style={{ fontWeight: 600 }}>
                          {summary.id}
                        </span>{' '}
                        <span style={{ color: 'var(--color-ink-secondary)', fontSize: 13 }}>
                          : {summary.label}
                        </span>
                      </div>
                      <div className="ag-inline-actions">
                        {showPrincipledShortcut && (
                          <button
                            type="button"
                            className="ag-btn ag-btn-sm ag-btn-active"
                            onClick={() =>
                              onChangeModel(
                                appendRuleGuardClause(model, idx, {
                                  op: 'not',
                                  arg: { op: 'var', name: 'modifiedSinceApproval' },
                                }),
                              )
                            }
                          >
                            + Add !modifiedSinceApproval
                          </button>
                        )}
                        {selectedQuickVar.length > 0 && (
                          <button
                            type="button"
                            className="ag-btn ag-btn-sm"
                            onClick={() => {
                              const clause: BoolExpr = quickClauseNegated
                                ? { op: 'not', arg: { op: 'var', name: selectedQuickVar } }
                                : { op: 'var', name: selectedQuickVar };
                              onChangeModel(appendRuleGuardClause(model, idx, clause));
                            }}
                          >
                            + Append {quickClauseNegated ? `!${selectedQuickVar}` : selectedQuickVar}
                          </button>
                        )}
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

                    <div className="ag-code-strip">
                      <div>
                        <span className="ag-code-muted">when </span>
                        {summary.guardText}
                      </div>
                      <div>
                        <span className="ag-code-muted">then </span>
                        {summary.updatesText.length > 0 ? summary.updatesText.join('; ') : 'no-op'}
                      </div>
                    </div>

                    <InlineErrorList errors={ruleErrors} />

                    <div>
                      <button
                        type="button"
                        className="ag-disclosure-btn"
                        aria-expanded={isExpanded}
                        aria-controls={`rule-details-${rowId}`}
                        onClick={() => toggleRuleExpanded(rowId)}
                      >
                        <span aria-hidden="true">{isExpanded ? 'v' : '>'}</span>
                        <span>Edit rule definition, guard AST, and atomic updates</span>
                      </button>

                      <div
                        id={`rule-details-${rowId}`}
                        className="ag-disclosure-body"
                        hidden={!isExpanded}
                      >
                        {isExpanded && (
                          <>
                            <div className="ag-row-grid">
                              <div className="ag-field">
                                <label htmlFor={`rule-id-${rowId}`}>Rule ID</label>
                                <input
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

                            <div className="ag-field">
                              <span className="ag-field-label">Guard Expression</span>
                              <BoolExprEditor
                                value={rule.guard}
                                schema={model.schema}
                                ariaLabelPrefix={`Rule ${rule.id} guard`}
                                resetKey={resetKey}
                                fieldPath={`rules[${idx}].guard`}
                                onDraftErrorChange={onDraftErrorChange}
                                onChange={(nextGuard) =>
                                  onChangeModel(
                                    updateRule(model, idx, { ...rule, guard: nextGuard }),
                                  )
                                }
                              />
                            </div>

                            <div className="ag-field">
                              <div className="ag-section-header">
                                <span className="ag-field-label">
                                  Atomic Updates ({rule.updates.length})
                                </span>
                                <button
                                  type="button"
                                  className="ag-btn ag-btn-sm"
                                  onClick={() => {
                                    const targetVar = firstVariableOfKind(model.schema);
                                    const targetDef = model.schema[targetVar];
                                    const valExpr =
                                      targetDef !== undefined
                                        ? {
                                            op: 'lit' as const,
                                            value: defaultValueForVarDef(targetDef),
                                          }
                                        : createDefaultValueExpr('lit', model.schema);
                                    onChangeModel(
                                      updateRule(
                                        model,
                                        idx,
                                        addRuleUpdate(rule, { var: targetVar, value: valExpr }),
                                      ),
                                    );
                                  }}
                                >
                                  + Add Update
                                </button>
                              </div>

                              {rule.updates.map((upd, updIdx) => (
                                <div
                                  key={`upd-${rowId}-${updIdx}`}
                                  className="ag-expr-row"
                                  style={{ alignItems: 'flex-start', paddingTop: 4 }}
                                >
                                  <select
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
                                  <span className="ag-mono" style={{ paddingTop: 5 }}>
                                    :=
                                  </span>
                                  <div style={{ flex: 1, minWidth: 0 }}>
                                    <ValueExprEditor
                                      value={upd.value}
                                      schema={model.schema}
                                      ariaLabelPrefix={`Update ${updIdx + 1} value for ${rule.id}`}
                                      resetKey={resetKey}
                                      fieldPath={`rules[${idx}].updates[${updIdx}].value`}
                                      onDraftErrorChange={onDraftErrorChange}
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
                                  <button
                                    type="button"
                                    className="ag-btn ag-btn-sm ag-btn-danger"
                                    onClick={() =>
                                      onChangeModel(
                                        updateRule(model, idx, removeRuleUpdate(rule, updIdx)),
                                      )
                                    }
                                  >
                                    Remove
                                  </button>
                                </div>
                              ))}
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {activeTab === 'invariants' && (
        <div
          id="panel-invariants"
          role="tabpanel"
          aria-labelledby="tab-invariants"
          className="ag-tabpanel"
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
                          onClick={() => handleRemoveInvariant(idx)}
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
                      ariaLabelPrefix={`Invariant ${inv.id} expression`}
                      resetKey={resetKey}
                      fieldPath={`invariants[${idx}].holds`}
                      onDraftErrorChange={onDraftErrorChange}
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
                  onChange={(e) => onChangeModel(setGoalEnabled(model, e.target.checked))}
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
                  ariaLabelPrefix="Goal reached predicate"
                  resetKey={resetKey}
                  fieldPath="goal.reached"
                  onDraftErrorChange={onDraftErrorChange}
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
      )}

      {activeTab === 'assumptions' && (
        <div
          id="panel-assumptions"
          role="tabpanel"
          aria-labelledby="tab-assumptions"
          className="ag-tabpanel"
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
      )}

      {activeTab === 'json' && (
        <div id="panel-json" role="tabpanel" aria-labelledby="tab-json" className="ag-tabpanel">
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
                <strong>JSON Import Validation Failed ({jsonErrors.length})</strong>
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
                onChange={(e) => setJsonDraft(e.target.value)}
              />
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
