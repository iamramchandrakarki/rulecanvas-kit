import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import type { TransitionRule, TransitionSystemModel, ValidationError } from '@rulecanvas/core';
import { formatBoolExpr, formatUpdateAssignment } from '@rulecanvas/ui';
import { WorkbenchSelect, matchesDraftPrefix } from '@rulecanvas/workbench-react';
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
import { BoolExprEditor, useExpressionDraftStore, type ExpressionDraftStore } from './ExprEditor.js';

export { matchesDraftPrefix };

export type InspectorTabId = 'guard' | 'assumptions' | 'json';

const INSPECTOR_TABS: readonly { readonly id: InspectorTabId; readonly label: string }[] = [
  { id: 'guard', label: 'Guard Inspector' },
  { id: 'assumptions', label: 'Assumptions' },
  { id: 'json', label: 'JSON' },
];

export interface FocusedInterlockRuleRequest {
  readonly ruleId: string;
  readonly seq: number;
}

export interface InterlockRuleEditorProps {
  readonly model: TransitionSystemModel;
  readonly diagnostics: ModelDiagnosticsIndex;
  readonly resetKey?: string | number | undefined;
  readonly focusedRuleRequest?: FocusedInterlockRuleRequest | null | undefined;
  readonly onChangeModel: (next: TransitionSystemModel) => void;
  readonly onImportModel: (imported: TransitionSystemModel) => void;
  readonly onDraftErrorChange?: ((fieldKey: string, errorMessage: string | null) => void) | undefined;
  readonly onJsonDraftDirtyChange?: ((dirty: boolean) => void) | undefined;
}

export interface UseInterlockEditorStateOptions {
  readonly model: TransitionSystemModel;
  readonly diagnostics: ModelDiagnosticsIndex;
  readonly resetKey?: string | number | undefined;
  readonly focusedRuleRequest?: FocusedInterlockRuleRequest | null | undefined;
  readonly isGuardTabActive: boolean;
  readonly onActivateGuardTab: () => void;
  readonly onChangeModel: (next: TransitionSystemModel) => void;
  readonly onImportModel: (imported: TransitionSystemModel) => void;
  readonly onDraftErrorChange?: ((fieldKey: string, errorMessage: string | null) => void) | undefined;
  readonly onJsonDraftDirtyChange?: ((dirty: boolean) => void) | undefined;
}

export interface InterlockEditorState {
  readonly model: TransitionSystemModel;
  readonly diagnostics: ModelDiagnosticsIndex;
  readonly resetKey: string | number;
  readonly ruleSelectRef: RefObject<HTMLButtonElement | null>;
  readonly selectedRule: TransitionRule | null;
  readonly effectiveRuleIndex: number;
  readonly repairableOpenInnerDoor: boolean;
  readonly openInnerDoorRepaired: boolean;
  readonly schemaKeys: readonly string[];
  readonly repairGen: number;
  readonly intDraftStore: ExpressionDraftStore;
  readonly resolvedAsmRowIds: readonly string[];
  readonly jsonDraft: string;
  readonly hasJsonDraft: boolean;
  readonly exportBlocked: boolean;
  readonly exportError: ValidationError | null;
  readonly jsonErrors: readonly ValidationError[];
  readonly jsonNotice: string | null;
  readonly handleApplyPrincipledRepair: () => void;
  readonly handleAppendPressureGuardClause: () => void;
  readonly handleSelectRule: (nextRuleId: string) => void;
  readonly handleJsonDraftChange: (nextVal: string) => void;
  readonly handleCopyJson: () => Promise<void>;
  readonly handleDownloadJson: () => void;
  readonly handleApplyJsonImport: () => void;
  readonly handleAddAssumption: () => void;
  readonly handleRemoveAssumption: (idx: number) => void;
  readonly handleUpdateAssumption: (
    idx: number,
    next: TransitionSystemModel['assumptions'][number],
  ) => void;
  readonly handleGuardChange: (ruleId: string, nextGuard: TransitionRule['guard']) => void;
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

export function useInterlockEditorState({
  model,
  diagnostics,
  resetKey = 0,
  focusedRuleRequest = null,
  isGuardTabActive,
  onActivateGuardTab,
  onChangeModel,
  onImportModel,
  onDraftErrorChange,
  onJsonDraftDirtyChange,
}: UseInterlockEditorStateOptions): InterlockEditorState {
  const nextRowIdRef = useRef<number>(0);
  const prevResetKeyRef = useRef<string | number>(resetKey);
  const prevFocusSeqRef = useRef<number>(0);
  const ruleSelectRef = useRef<HTMLButtonElement | null>(null);
  const preserveNextNoticeRef = useRef<boolean>(false);
  const onActivateGuardTabRef = useRef(onActivateGuardTab);
  onActivateGuardTabRef.current = onActivateGuardTab;
  const onJsonDraftDirtyChangeRef = useRef(onJsonDraftDirtyChange);
  onJsonDraftDirtyChangeRef.current = onJsonDraftDirtyChange;

  const allocRowId = (prefix: string): string => {
    nextRowIdRef.current += 1;
    return `${prefix}-${nextRowIdRef.current}`;
  };

  const [pendingFocusSeq, setPendingFocusSeq] = useState<number | null>(null);
  const [selectedRuleId, setSelectedRuleId] = useState<string>(() =>
    defaultRuleSelection(model.rules),
  );

  const [initialJsonExport] = useState(() => tryExportModelJson(model));
  const committedJsonRef = useRef<string>(initialJsonExport.ok ? initialJsonExport.text : '');
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

  const intDraftStore = useExpressionDraftStore({
    resetKey,
    onErrorChange: onDraftErrorChange,
  });
  const pruneDraftsByPrefix = intDraftStore.onPruneDrafts;

  useEffect(() => {
    const exported = tryExportModelJson(model);
    if (exported.ok) {
      committedJsonRef.current = exported.text;
      setJsonDraft(exported.text);
      onJsonDraftDirtyChangeRef.current?.(false);
      setExportError(null);
      setJsonErrors([]);
      if (preserveNextNoticeRef.current) {
        preserveNextNoticeRef.current = false;
      } else {
        setJsonNotice(null);
      }
    } else {
      preserveNextNoticeRef.current = false;
      committedJsonRef.current = '';
      setJsonDraft('');
      onJsonDraftDirtyChangeRef.current?.(false);
      setExportError(exported.error);
      setJsonErrors([]);
      setJsonNotice(null);
    }
  }, [model]);

  useEffect(() => {
    if (prevResetKeyRef.current !== resetKey) {
      prevResetKeyRef.current = resetKey;
      setSelectedRuleId(defaultRuleSelection(model.rules));
      setPendingFocusSeq(null);
      setAsmRowIds(model.assumptions.map(() => allocRowId('asm')));
    }
  }, [resetKey, model]);

  useEffect(() => {
    if (focusedRuleRequest === null || focusedRuleRequest.seq === prevFocusSeqRef.current) {
      return;
    }
    prevFocusSeqRef.current = focusedRuleRequest.seq;
    if (model.rules.some((r) => r.id === focusedRuleRequest.ruleId)) {
      onActivateGuardTabRef.current();
      setSelectedRuleId(focusedRuleRequest.ruleId);
      setPendingFocusSeq(focusedRuleRequest.seq);
    }
  }, [focusedRuleRequest, model.rules]);

  useEffect(() => {
    if (pendingFocusSeq === null || !isGuardTabActive) {
      return;
    }
    const prefersReducedMotion =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    ruleSelectRef.current?.focus({ preventScroll: true });
    ruleSelectRef.current?.scrollIntoView({
      behavior: prefersReducedMotion ? 'auto' : 'smooth',
      block: 'center',
    });
    setPendingFocusSeq(null);
  }, [pendingFocusSeq, isGuardTabActive]);

  const resolvedAsmRowIds = alignRowIds(asmRowIds, model.assumptions.length, 'asm');

  const selectedRuleIndex = model.rules.findIndex((r) => r.id === selectedRuleId);
  const effectiveRuleIndex = selectedRuleIndex >= 0 ? selectedRuleIndex : 0;
  const selectedRule = model.rules[effectiveRuleIndex] ?? null;

  const repairableOpenInnerDoor = isRepairableInterlockModel(model);
  const openInnerDoorRepaired = isPrincipledOpenInnerDoorGuard(model);
  const schemaKeys = Object.keys(model.schema);
  const exportBlocked = exportError !== null;
  const hasJsonDraft = jsonDraft !== committedJsonRef.current;

  const handleApplyPrincipledRepair = () => {
    if (hasJsonDraft) return;
    pruneDraftsByPrefix('rule');
    setRepairGen((g) => g + 1);
    onChangeModel(applyPrincipledInterlockRepair(model));
    setSelectedRuleId('open_inner_door');
    onActivateGuardTabRef.current();
    setPendingFocusSeq((seq) => (seq ?? 0) + 1);
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

  const handleJsonDraftChange = (nextVal: string) => {
    setJsonDraft(nextVal);
    onJsonDraftDirtyChangeRef.current?.(nextVal !== committedJsonRef.current);
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

  const handleAddAssumption = () => {
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
  };

  const handleRemoveAssumption = (idx: number) => {
    setAsmRowIds(resolvedAsmRowIds.filter((_, i) => i !== idx));
    onChangeModel(removeAssumption(model, idx));
  };

  const handleUpdateAssumption = (
    idx: number,
    next: TransitionSystemModel['assumptions'][number],
  ) => {
    onChangeModel(updateAssumption(model, idx, next));
  };

  const handleGuardChange = (ruleId: string, nextGuard: TransitionRule['guard']) => {
    onChangeModel(updateRuleGuard(model, ruleId, nextGuard));
  };

  return {
    model,
    diagnostics,
    resetKey,
    ruleSelectRef,
    selectedRule,
    effectiveRuleIndex,
    repairableOpenInnerDoor,
    openInnerDoorRepaired,
    schemaKeys,
    repairGen,
    intDraftStore,
    resolvedAsmRowIds,
    jsonDraft,
    hasJsonDraft,
    exportBlocked,
    exportError,
    jsonErrors,
    jsonNotice,
    handleApplyPrincipledRepair,
    handleAppendPressureGuardClause,
    handleSelectRule: setSelectedRuleId,
    handleJsonDraftChange,
    handleCopyJson,
    handleDownloadJson,
    handleApplyJsonImport,
    handleAddAssumption,
    handleRemoveAssumption,
    handleUpdateAssumption,
    handleGuardChange,
  };
}

export function GuidedRepairCallout({
  editor,
  isStale = false,
  onVerifyNow,
}: {
  readonly editor: InterlockEditorState;
  readonly isStale?: boolean | undefined;
  readonly onVerifyNow?: (() => void) | undefined;
}) {
  if (editor.openInnerDoorRepaired && isStale) {
    return (
      <div className="is-repair-staged" role="status">
        <div className="is-repair-staged-copy">
          <strong>Principled repair staged in draft (unverified)</strong>
          <span>
            <code className="is-mono">pressure == &quot;negative&quot;</code> is now enforced
            outside the override branch on <code className="is-mono">open_inner_door</code>. Run
            Verify Interlock Model to confirm the verdict.
          </span>
        </div>
        {onVerifyNow !== undefined && (
          <button
            type="button"
            className="is-btn is-btn-sm is-btn-active"
            onClick={onVerifyNow}
          >
            Run Verification
          </button>
        )}
      </div>
    );
  }
  if (!editor.repairableOpenInnerDoor || editor.openInnerDoorRepaired) {
    return null;
  }
  const currentGuard = editor.model.rules.find((r) => r.id === 'open_inner_door')?.guard;
  const candidateGuard = applyPrincipledInterlockRepair(editor.model).rules.find(
    (r) => r.id === 'open_inner_door',
  )?.guard;
  const candidateText = candidateGuard !== undefined ? formatBoolExpr(candidateGuard) : '';
  const highlightToken = '&& pressure == "negative"';
  const highlightIdx = candidateText.indexOf(highlightToken);
  return (
    <div
      className="is-repair-callout"
      role="group"
      aria-label="Candidate guard repair for open_inner_door (not applied)"
    >
      <div className="is-repair-head">
        <strong>Candidate Guard Repair Available for open_inner_door</strong>
        <span className="is-hint">Not applied</span>
      </div>
      {currentGuard !== undefined && candidateGuard !== undefined && (
        <dl className="is-guard-diff">
          <dt>Current</dt>
          <dd className="is-mono">{formatBoolExpr(currentGuard)}</dd>
          <dt>Candidate</dt>
          <dd className="is-mono" data-candidate="true">
            {highlightIdx >= 0 ? (
              <>
                {candidateText.slice(0, highlightIdx)}
                <mark className="is-diff-add">{highlightToken}</mark>
                {candidateText.slice(highlightIdx + highlightToken.length)}
              </>
            ) : (
              candidateText
            )}
          </dd>
        </dl>
      )}
      <p className="is-repair-note">
        Enforces <code className="is-mono">pressure == negative</code> unconditionally, so{' '}
        <code className="is-mono">maintenanceOverride</code> bypasses only the HEPA purge count.
        Applying stages the edit in the draft; run <strong>Verify Interlock Model</strong> afterward
        to confirm the verdict.
      </p>
      {editor.hasJsonDraft && (
        <p className="is-repair-note">
          Import the JSON or restore its original text before applying the candidate repair.
        </p>
      )}
      <div className="is-repair-actions">
        <button
          type="button"
          className="is-btn is-btn-sm is-btn-primary"
          disabled={editor.hasJsonDraft}
          onClick={editor.handleApplyPrincipledRepair}
        >
          Apply Principled Repair
        </button>
      </div>
    </div>
  );
}

export function GuardInspectorContent({ editor }: { readonly editor: InterlockEditorState }) {
  const { model, diagnostics, resetKey, selectedRule, effectiveRuleIndex } = editor;
  return (
    <>
      <div className="is-field">
        <label htmlFor="inspector-rule-select">Transition rule</label>
        <WorkbenchSelect
          triggerRef={editor.ruleSelectRef}
          id="inspector-rule-select"
          className="is-select is-mono"
          mono
          value={selectedRule?.id ?? ''}
          placeholder="No rule selected"
          options={model.rules.map((rule, idx) => ({
            value: rule.id,
            label: `${idx + 1}. ${rule.id}`,
            description: rule.label || undefined,
          }))}
          onChange={(ruleId) => editor.handleSelectRule(ruleId)}
        />
        {selectedRule !== null && <span className="is-hint">{selectedRule.label}</span>}
      </div>

      {selectedRule !== null && (
        <>
          <div className="is-code-strip is-rule-prop-strip">
            <span className="is-code-muted">when</span>
            <span>{formatBoolExpr(selectedRule.guard)}</span>
            <span className="is-code-muted">then</span>
            <span>
              {selectedRule.updates.length > 0
                ? selectedRule.updates.map((u) => formatUpdateAssignment(u)).join('; ')
                : 'no-op'}
            </span>
          </div>

          <div className="is-section-header">
            <span className="is-section-title">
              Guard <span className="is-hint">the action is enabled only when this holds</span>
            </span>
            <button
              type="button"
              className="is-btn is-btn-xs"
              title="Append a pressure == negative clause to this guard"
              onClick={editor.handleAppendPressureGuardClause}
            >
              + Add Conjunction Clause
            </button>
          </div>

          <div
            className="is-guard-tree-scroll"
            tabIndex={0}
            role="region"
            aria-label="Guard expression AST editor"
          >
            <BoolExprEditor
              key={`${resetKey}:${selectedRule.id}:${editor.repairGen}`}
              value={selectedRule.guard}
              schema={model.schema}
              schemaKeysOrder={editor.schemaKeys}
              ariaLabelPrefix={`Guard for ${selectedRule.id}`}
              resetKey={`${resetKey}:${selectedRule.id}:${editor.repairGen}`}
              fieldPath={`rule:${selectedRule.id}.guard`}
              intDraftStore={editor.intDraftStore}
              diagnostics={diagnostics.all}
              diagnosticPath={`rules[${effectiveRuleIndex}].guard`}
              showPreview={false}
              onChange={(nextGuard) => editor.handleGuardChange(selectedRule.id, nextGuard)}
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
    </>
  );
}

export function AssumptionsEditorContent({
  editor,
  showDraftBadge = false,
}: {
  readonly editor: InterlockEditorState;
  readonly showDraftBadge?: boolean | undefined;
}) {
  const { model, diagnostics, resolvedAsmRowIds } = editor;
  return (
    <>
      <div className="is-section-header">
        <h3 className="is-section-title">
          Declared Model Assumptions ({model.assumptions.length})
        </h3>
        <div className="is-inline-actions">
          {showDraftBadge && (
            <span className="is-badge" data-tone="warning">
              <span aria-hidden="true">!</span> UNVERIFIED DRAFT
            </span>
          )}
          <button
            type="button"
            className="is-btn is-btn-sm"
            onClick={editor.handleAddAssumption}
          >
            + Add Assumption
          </button>
        </div>
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
                      editor.handleUpdateAssumption(idx, { ...asm, id: e.target.value })
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
                      editor.handleUpdateAssumption(idx, { ...asm, category: e.target.value })
                    }
                  />
                </div>
                <div>
                  <button
                    type="button"
                    className="is-btn is-btn-sm is-btn-danger"
                    disabled={model.assumptions.length <= 1}
                    onClick={() => editor.handleRemoveAssumption(idx)}
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
                    editor.handleUpdateAssumption(idx, { ...asm, statement: e.target.value })
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
                    editor.handleUpdateAssumption(idx, { ...asm, notModeled: e.target.value })
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
    </>
  );
}

export function JsonModelContent({ editor }: { readonly editor: InterlockEditorState }) {
  return (
    <>
      <div className="is-section-header">
        <h3 className="is-section-title">Portable Model JSON Import &amp; Export</h3>
        <div className="is-inline-actions">
          <button
            type="button"
            className="is-btn is-btn-sm"
            disabled={editor.exportBlocked}
            onClick={editor.handleCopyJson}
          >
            Copy JSON
          </button>
          <button
            type="button"
            className="is-btn is-btn-sm"
            disabled={editor.exportBlocked}
            onClick={editor.handleDownloadJson}
          >
            Download JSON
          </button>
          <button
            type="button"
            className="is-btn is-btn-primary is-btn-sm"
            onClick={editor.handleApplyJsonImport}
          >
            Import JSON
          </button>
        </div>
      </div>

      {editor.jsonNotice !== null && (
        <div className="is-alert is-alert-info" role="status">
          {editor.jsonNotice}
        </div>
      )}

      {editor.exportError !== null && (
        <div className="is-alert" role="alert">
          <strong>JSON Export Failed</strong>
          <ul>
            <li>
              <code>{editor.exportError.path}</code>: {editor.exportError.message} (
              <code>{editor.exportError.code}</code>)
            </li>
          </ul>
        </div>
      )}

      {editor.jsonErrors.length > 0 && (
        <div className="is-alert" role="alert">
          <strong>JSON Import Validation Failed ({editor.jsonErrors.length})</strong>
          <ul>
            {editor.jsonErrors.map((err, idx) => (
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
          value={editor.jsonDraft}
          onChange={(e) => editor.handleJsonDraftChange(e.target.value)}
        />
      </div>
    </>
  );
}

export function InterlockRuleEditor(props: InterlockRuleEditorProps) {
  const tabRefs = useRef<Record<InspectorTabId, HTMLButtonElement | null>>({
    guard: null,
    assumptions: null,
    json: null,
  });
  const [activeTab, setActiveTab] = useState<InspectorTabId>('guard');

  const editor = useInterlockEditorState({
    ...props,
    isGuardTabActive: activeTab === 'guard',
    onActivateGuardTab: () => setActiveTab('guard'),
  });

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

  return (
    <section
      className="is-pane"
      aria-label="Interlock guard inspector and model editor"
    >
      <div className="is-pane-header">
        <h2 className="is-pane-title">Interlock Guard Inspector &amp; Model</h2>
        <span className="is-meta-inline">{props.model.rules.length} rules</span>
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

      <div
        id="is-panel-guard"
        role="tabpanel"
        aria-labelledby="is-tab-guard"
        className="is-tabpanel"
        tabIndex={0}
        hidden={activeTab !== 'guard'}
      >
        <GuidedRepairCallout editor={editor} />
        <GuardInspectorContent editor={editor} />
      </div>

      <div
        id="is-panel-assumptions"
        role="tabpanel"
        aria-labelledby="is-tab-assumptions"
        className="is-tabpanel"
        tabIndex={0}
        hidden={activeTab !== 'assumptions'}
      >
        <AssumptionsEditorContent editor={editor} />
      </div>

      <div
        id="is-panel-json"
        role="tabpanel"
        aria-labelledby="is-tab-json"
        className="is-tabpanel"
        tabIndex={0}
        hidden={activeTab !== 'json'}
      >
        <JsonModelContent editor={editor} />
      </div>
    </section>
  );
}
