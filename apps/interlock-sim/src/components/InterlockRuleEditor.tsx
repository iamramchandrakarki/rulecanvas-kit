import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { TransitionRule, TransitionSystemModel, ValidationError } from '@rulecanvas/core';
import { formatBoolExpr, formatUpdateAssignment } from '@rulecanvas/ui';
import {
  matchesDraftPrefix,
  useIntegerDraftStore,
  type LiftedIntDraftStore,
} from '@rulecanvas/workbench-react';
import {
  addAssumption,
  appendGuardClause,
  applyPrincipledInterlockRepair,
  createDefaultBoolExpr,
  getErrorsForPathPrefix,
  importModelFromJson,
  isPrincipledOpenInnerDoorGuard,
  isRepairableInterlockModel,
  removeAssumption,
  tryExportModelJson,
  updateAssumption,
  updateRuleGuard,
  type ModelDiagnosticsIndex,
} from '../model-inspector.js';
import { BoolExprEditor } from './ExprEditor.js';

export { matchesDraftPrefix };

export type InspectorTabId = 'guard' | 'assumptions' | 'json';

const INSPECTOR_TABS: readonly { readonly id: InspectorTabId; readonly label: string }[] = [
  { id: 'guard', label: 'Guard Inspector' },
  { id: 'assumptions', label: 'Assumptions' },
  { id: 'json', label: 'JSON' },
];

export interface InterlockRuleEditorProps {
  readonly model: TransitionSystemModel;
  readonly diagnostics: ModelDiagnosticsIndex;
  readonly resetKey?: string | number | undefined;
  readonly onChangeModel: (next: TransitionSystemModel) => void;
  readonly onImportModel: (imported: TransitionSystemModel) => void;
  readonly onDraftErrorChange?: ((fieldKey: string, errorMessage: string | null) => void) | undefined;
}

function defaultRuleSelection(rules: readonly TransitionRule[]): string {
  const openInner = rules.find((r) => r.id === 'open_inner_door');
  return openInner !== undefined ? openInner.id : (rules[0]?.id ?? '');
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

export function InterlockRuleEditor({
  model,
  diagnostics,
  resetKey = 0,
  onChangeModel,
  onImportModel,
  onDraftErrorChange,
}: InterlockRuleEditorProps) {
  const nextRowIdRef = useRef<number>(0);
  const prevResetKeyRef = useRef<string | number>(resetKey);
  const preserveNextNoticeRef = useRef<boolean>(false);
  const onDraftErrorChangeRef = useRef(onDraftErrorChange);
  onDraftErrorChangeRef.current = onDraftErrorChange;

  const allocRowId = (prefix: string): string => {
    nextRowIdRef.current += 1;
    return `${prefix}-${nextRowIdRef.current}`;
  };

  const tabRefs = useRef<Record<InspectorTabId, HTMLButtonElement | null>>({
    guard: null,
    assumptions: null,
    json: null,
  });

  const [activeTab, setActiveTab] = useState<InspectorTabId>('guard');
  const [selectedRuleId, setSelectedRuleId] = useState<string>(() =>
    defaultRuleSelection(model.rules),
  );

  const [initialJsonExport] = useState(() => tryExportModelJson(model));
  const [jsonDraft, setJsonDraft] = useState<string>(() =>
    initialJsonExport.ok ? initialJsonExport.text : '',
  );
  const [exportError, setExportError] = useState<ValidationError | null>(() =>
    initialJsonExport.ok ? null : initialJsonExport.error,
  );
  const [jsonErrors, setJsonErrors] = useState<readonly ValidationError[]>([]);
  const [jsonNotice, setJsonNotice] = useState<string | null>(null);
  const [repairGen, setRepairGen] = useState<number>(0);

  const [asmRowIds, setAsmRowIds] = useState<readonly string[]>(() =>
    model.assumptions.map(() => allocRowId('asm')),
  );

  const intDraftStore: LiftedIntDraftStore = useIntegerDraftStore({
    resetKey,
    onErrorChange: onDraftErrorChange,
  });
  const pruneDraftsByPrefix = intDraftStore.onPruneDrafts;

  useEffect(() => {
    const exported = tryExportModelJson(model);
    if (exported.ok) {
      setJsonDraft(exported.text);
      setExportError(null);
      setJsonErrors([]);
      if (preserveNextNoticeRef.current) {
        preserveNextNoticeRef.current = false;
      } else {
        setJsonNotice(null);
      }
    } else {
      preserveNextNoticeRef.current = false;
      setJsonDraft('');
      setExportError(exported.error);
      setJsonErrors([]);
      setJsonNotice(null);
    }
  }, [model]);

  useEffect(() => {
    if (prevResetKeyRef.current !== resetKey) {
      prevResetKeyRef.current = resetKey;
      setSelectedRuleId(defaultRuleSelection(model.rules));
      setAsmRowIds(model.assumptions.map(() => allocRowId('asm')));
    }
  }, [resetKey, model]);

  const resolvedAsmRowIds = alignRowIds(asmRowIds, model.assumptions.length, 'asm');

  const selectedRuleIndex = model.rules.findIndex((r) => r.id === selectedRuleId);
  const effectiveRuleIndex = selectedRuleIndex >= 0 ? selectedRuleIndex : 0;
  const selectedRule = model.rules[effectiveRuleIndex] ?? null;

  const repairableOpenInnerDoor = isRepairableInterlockModel(model);
  const openInnerDoorRepaired = isPrincipledOpenInnerDoorGuard(model);
  const schemaKeys = Object.keys(model.schema);
  const exportBlocked = exportError !== null;

  const handleTabKeyDown = (e: KeyboardEvent<HTMLButtonElement>, currentIdx: number) => {
    let targetIdx: number | null = null;
    if (e.key === 'ArrowRight') {
      targetIdx = (currentIdx + 1) % INSPECTOR_TABS.length;
    } else if (e.key === 'ArrowLeft') {
      targetIdx = (currentIdx - 1 + INSPECTOR_TABS.length) % INSPECTOR_TABS.length;
    } else if (e.key === 'Home') {
      targetIdx = 0;
    } else if (e.key === 'End') {
      targetIdx = INSPECTOR_TABS.length - 1;
    }
    if (targetIdx !== null) {
      e.preventDefault();
      const targetTab = INSPECTOR_TABS[targetIdx]!;
      setActiveTab(targetTab.id);
      tabRefs.current[targetTab.id]?.focus();
    }
  };

  const handleApplyPrincipledRepair = () => {
    pruneDraftsByPrefix('rule');
    setRepairGen((g) => g + 1);
    onChangeModel(applyPrincipledInterlockRepair(model));
    setSelectedRuleId('open_inner_door');
  };

  const handleAppendPressureGuardClause = () => {
    if (selectedRule === null) return;
    const fieldPrefix = `rule:${selectedRule.id}.guard`;
    if (selectedRule.guard.op !== 'and') {
      pruneDraftsByPrefix(fieldPrefix);
    }
    const pressureClause = {
      op: 'eq' as const,
      left: { op: 'var' as const, name: 'pressure' },
      right: { op: 'lit' as const, value: 'negative' },
    };
    const nextGuard = Object.hasOwn(model.schema, 'pressure')
      ? pressureClause
      : createDefaultBoolExpr('var', model.schema);
    onChangeModel(
      updateRuleGuard(model, selectedRule.id, appendGuardClause(selectedRule.guard, nextGuard)),
    );
  };

  const handleSelectRule = (nextRuleId: string) => {
    if (nextRuleId === selectedRuleId) return;
    pruneDraftsByPrefix('rule');
    setSelectedRuleId(nextRuleId);
  };

  const handleCopyJson = async () => {
    const exported = tryExportModelJson(model);
    if (!exported.ok) {
      setExportError(exported.error);
      setJsonNotice(null);
      return;
    }
    setExportError(null);
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined) {
        await navigator.clipboard.writeText(exported.text);
        setJsonNotice('Model JSON copied to clipboard.');
      } else {
        setJsonNotice('Clipboard API unavailable in this browser environment.');
      }
    } catch {
      setJsonNotice('Unable to write JSON to clipboard.');
    }
  };

  const handleDownloadJson = () => {
    const exported = tryExportModelJson(model);
    if (!exported.ok) {
      setExportError(exported.error);
      setJsonNotice(null);
      return;
    }
    setExportError(null);
    const blob = new Blob([exported.text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${model.id || 'interlock-model'}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    setJsonNotice(`Downloaded ${link.download}.`);
  };

  const handleApplyJsonImport = () => {
    const imported = importModelFromJson(jsonDraft);
    if (!imported.ok) {
      setJsonErrors(imported.errors);
      setJsonNotice(null);
      return;
    }
    setJsonErrors([]);
    preserveNextNoticeRef.current = true;
    setJsonNotice('Model JSON validated and imported.');
    onImportModel(imported.model);
  };

  return (
    <section className="is-pane" aria-label="Interlock guard inspector and model editor">
      <div className="is-pane-header">
        <div>
          <h2 className="is-pane-title">Interlock Guard Inspector &amp; Model</h2>
          <p className="is-pane-subtitle">
            Inspect transition guards, test repairs to open_inner_door, edit assumptions, or import/export JSON.
          </p>
        </div>
      </div>

      <div className="is-tablist" role="tablist" aria-label="Interlock editor sections">
        {INSPECTOR_TABS.map((tab, idx) => (
          <button
            key={tab.id}
            ref={(el) => {
              tabRefs.current[tab.id] = el;
            }}
            id={`is-tab-${tab.id}`}
            type="button"
            role="tab"
            className="is-tab"
            aria-selected={activeTab === tab.id}
            aria-controls={`is-panel-${tab.id}`}
            tabIndex={activeTab === tab.id ? 0 : -1}
            onClick={() => setActiveTab(tab.id)}
            onKeyDown={(e) => handleTabKeyDown(e, idx)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab 1: Guard Inspector */}
      <div
        id="is-panel-guard"
        role="tabpanel"
        aria-labelledby="is-tab-guard"
        className="is-tabpanel"
        tabIndex={0}
        hidden={activeTab !== 'guard'}
      >
        {repairableOpenInnerDoor && !openInnerDoorRepaired && (
          <div className="is-repair-callout">
            <div className="is-section-header">
              <strong>Guided Repair Available for open_inner_door</strong>
              <button
                type="button"
                className="is-btn is-btn-sm is-btn-primary"
                onClick={handleApplyPrincipledRepair}
              >
                Apply Principled Repair
              </button>
            </div>
            <p style={{ fontSize: 'var(--text-xs)', color: 'var(--color-ink-2)' }}>
              Enforces <code className="is-mono">pressure == negative</code> unconditionally alongside closed outer door, UV-off, and occupancy, letting <code className="is-mono">maintenanceOverride</code> bypass only the purge cycle count.
            </p>
          </div>
        )}

        <div className="is-field">
          <label htmlFor="inspector-rule-select">Inspect / Edit Transition Rule</label>
          <select
            id="inspector-rule-select"
            className="is-select is-mono"
            value={selectedRule?.id ?? ''}
            onChange={(e) => handleSelectRule(e.target.value)}
          >
            {model.rules.map((rule) => (
              <option key={rule.id} value={rule.id}>
                {rule.id}: {rule.label}
              </option>
            ))}
          </select>
        </div>

        {selectedRule !== null && (
          <>
            <div className="is-code-strip">
              <div>
                <strong>guard:</strong> {formatBoolExpr(selectedRule.guard)}
              </div>
              <div style={{ marginTop: 4, color: 'var(--color-muted)' }}>
                <strong>updates:</strong>{' '}
                {selectedRule.updates.map((u) => formatUpdateAssignment(u)).join('; ')}
              </div>
            </div>

            <div className="is-section-header">
              <span className="is-section-title">Guard Expression AST</span>
              <button
                type="button"
                className="is-btn is-btn-sm"
                onClick={handleAppendPressureGuardClause}
              >
                + Add Conjunction Clause
              </button>
            </div>

            <div className="is-guard-tree-scroll">
              <BoolExprEditor
                key={`${resetKey}:${selectedRule.id}:${repairGen}`}
                value={selectedRule.guard}
                schema={model.schema}
                schemaKeysOrder={schemaKeys}
                ariaLabelPrefix={`Guard for ${selectedRule.id}`}
                resetKey={`${resetKey}:${selectedRule.id}:${repairGen}`}
                fieldPath={`rule:${selectedRule.id}.guard`}
                intDraftStore={intDraftStore}
                onChange={(nextGuard) =>
                  onChangeModel(updateRuleGuard(model, selectedRule.id, nextGuard))
                }
              />
            </div>

            {getErrorsForPathPrefix(diagnostics, `rules[${effectiveRuleIndex}]`).length > 0 && (
              <ul className="is-inline-errors" role="alert">
                {getErrorsForPathPrefix(diagnostics, `rules[${effectiveRuleIndex}]`).map(
                  (err, idx) => (
                    <li key={`${err.code}-${err.path}-${idx}`}>
                      <code>{err.path}</code>: {err.message}
                    </li>
                  ),
                )}
              </ul>
            )}
          </>
        )}
      </div>

      {/* Tab 2: Assumptions */}
      <div
        id="is-panel-assumptions"
        role="tabpanel"
        aria-labelledby="is-tab-assumptions"
        className="is-tabpanel"
        tabIndex={0}
        hidden={activeTab !== 'assumptions'}
      >
        <div className="is-section-header">
          <h3 className="is-section-title">
            Declared Model Assumptions ({model.assumptions.length})
          </h3>
          <button
            type="button"
            className="is-btn is-btn-sm"
            onClick={() => {
              const existingIds = new Set(model.assumptions.map((a) => a.id));
              let counter = 1;
              while (existingIds.has(`assumption_custom_${counter}`)) {
                counter += 1;
              }
              setAsmRowIds([...resolvedAsmRowIds, allocRowId('asm')]);
              onChangeModel(
                addAssumption(model, {
                  id: `assumption_custom_${counter}`,
                  category: 'scope',
                  statement: 'Discrete state abstraction assumption.',
                  notModeled: 'Physical hardware degradation and continuous dynamics.',
                }),
              );
            }}
          >
            + Add Assumption
          </button>
        </div>

        <div>
          {model.assumptions.map((asm, idx) => {
            const rowId = resolvedAsmRowIds[idx]!;
            const asmErrors = getErrorsForPathPrefix(diagnostics, `assumptions[${idx}]`);
            return (
              <div key={rowId} className="is-assumption-row">
                <div className="is-row-grid">
                  <div className="is-field">
                    <label htmlFor={`asm-id-${rowId}`}>Assumption ID</label>
                    <input
                      id={`asm-id-${rowId}`}
                      type="text"
                      className="is-input is-mono"
                      value={asm.id}
                      onChange={(e) =>
                        onChangeModel(updateAssumption(model, idx, { ...asm, id: e.target.value }))
                      }
                    />
                  </div>
                  <div className="is-field">
                    <label htmlFor={`asm-category-${rowId}`}>Category</label>
                    <input
                      id={`asm-category-${rowId}`}
                      type="text"
                      className="is-input is-mono"
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
                      className="is-btn is-btn-sm is-btn-danger"
                      disabled={model.assumptions.length <= 1}
                      onClick={() => {
                        setAsmRowIds(resolvedAsmRowIds.filter((_, i) => i !== idx));
                        onChangeModel(removeAssumption(model, idx));
                      }}
                    >
                      Remove
                    </button>
                  </div>
                </div>

                <div className="is-field">
                  <label htmlFor={`asm-statement-${rowId}`}>Captured Statement</label>
                  <textarea
                    id={`asm-statement-${rowId}`}
                    rows={2}
                    className="is-textarea"
                    value={asm.statement}
                    onChange={(e) =>
                      onChangeModel(
                        updateAssumption(model, idx, { ...asm, statement: e.target.value }),
                      )
                    }
                  />
                </div>

                <div className="is-field">
                  <label htmlFor={`asm-not-modeled-${rowId}`}>Explicitly Not Modeled</label>
                  <textarea
                    id={`asm-not-modeled-${rowId}`}
                    rows={2}
                    className="is-textarea"
                    value={asm.notModeled}
                    onChange={(e) =>
                      onChangeModel(
                        updateAssumption(model, idx, { ...asm, notModeled: e.target.value }),
                      )
                    }
                  />
                </div>

                {asmErrors.length > 0 && (
                  <ul className="is-inline-errors" role="alert">
                    {asmErrors.map((err, errIdx) => (
                      <li key={`${err.code}-${errIdx}`}>
                        <code>{err.path}</code>: {err.message}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Tab 3: JSON */}
      <div
        id="is-panel-json"
        role="tabpanel"
        aria-labelledby="is-tab-json"
        className="is-tabpanel"
        tabIndex={0}
        hidden={activeTab !== 'json'}
      >
        <div className="is-section-header">
          <h3 className="is-section-title">Portable Model JSON Import &amp; Export</h3>
          <div className="is-inline-actions">
            <button
              type="button"
              className="is-btn is-btn-sm"
              disabled={exportBlocked}
              onClick={handleCopyJson}
            >
              Copy JSON
            </button>
            <button
              type="button"
              className="is-btn is-btn-sm"
              disabled={exportBlocked}
              onClick={handleDownloadJson}
            >
              Download JSON
            </button>
            <button
              type="button"
              className="is-btn is-btn-primary is-btn-sm"
              onClick={handleApplyJsonImport}
            >
              Import JSON
            </button>
          </div>
        </div>

        {jsonNotice !== null && (
          <div className="is-alert is-alert-info" role="status">
            {jsonNotice}
          </div>
        )}

        {exportError !== null && (
          <div className="is-alert" role="alert">
            <strong>JSON Export Failed</strong>
            <ul>
              <li>
                <code>{exportError.path}</code>: {exportError.message} (
                <code>{exportError.code}</code>)
              </li>
            </ul>
          </div>
        )}

        {jsonErrors.length > 0 && (
          <div className="is-alert" role="alert">
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

        <div className="is-field">
          <label htmlFor="interlock-json-textarea">TransitionSystemModel JSON</label>
          <textarea
            id="interlock-json-textarea"
            rows={18}
            className="is-textarea is-textarea-mono"
            spellCheck={false}
            value={jsonDraft}
            onChange={(e) => setJsonDraft(e.target.value)}
          />
        </div>
      </div>
    </section>
  );
}
