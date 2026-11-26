import { useEffect, useId, useState } from 'react';
import type { BoolExpr, StateSchema, StateValue, ValueExpr } from '@rulecanvas/core';
import { formatBoolExpr, formatValueExpr } from '@rulecanvas/ui';
import {
  matchesDraftPrefix,
  useIntegerDraftStore,
  type LiftedIntDraftStore,
  type UseIntegerDraftStoreOptions,
} from '@rulecanvas/workbench-react';
import {
  createDefaultBoolExpr,
  createDefaultValueExpr,
  defaultValueForVarDef,
} from '../model-inspector.js';
import { StrictIntegerInput } from './StrictIntegerInput.js';

const BOOL_OPS: readonly BoolExpr['op'][] = [
  'lit',
  'var',
  'not',
  'and',
  'or',
  'eq',
  'neq',
  'lt',
  'lte',
  'gt',
  'gte',
  'in',
];

const VALUE_OPS: readonly ValueExpr['op'][] = ['lit', 'var', 'add', 'sub'];

export type { LiftedIntDraftStore } from '@rulecanvas/workbench-react';

function useExpressionRows(resetKey: string | number | undefined) {
  const [idsByPath, setIdsByPath] = useState(() => new Map<string, readonly string[]>());

  useEffect(() => {
    setIdsByPath((previous) => (previous.size === 0 ? previous : new Map()));
  }, [resetKey]);

  return {
    idsByPath,
    remember: (path: string, rowIds: readonly string[]) =>
      setIdsByPath((previous) => new Map(previous).set(path, rowIds)),
    prune: (prefix: string) =>
      setIdsByPath((previous) => {
        const remaining = new Map([...previous].filter(([path]) => !matchesDraftPrefix(path, prefix)));
        return remaining.size === previous.size ? previous : remaining;
      }),
  };
}

export interface ExpressionDraftStore extends LiftedIntDraftStore {
  readonly expressionRows: ReturnType<typeof useExpressionRows>;
}

export function useExpressionDraftStore(options: UseIntegerDraftStoreOptions): ExpressionDraftStore {
  const intDraftStore = useIntegerDraftStore(options);
  // Keep row identity and numeric drafts in the same editor lifetime.
  const expressionRows = useExpressionRows(options.resetKey);
  return {
    ...intDraftStore,
    expressionRows,
    onPruneDrafts: (prefix) => {
      intDraftStore.onPruneDrafts(prefix);
      expressionRows.prune(prefix);
    },
  };
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

function defaultInItemValue(targetExpr: ValueExpr, schema: StateSchema): StateValue {
  if (targetExpr.op === 'var') {
    const def = schema[targetExpr.name];
    if (def !== undefined) {
      if (def.kind === 'boolean') return false;
      if (def.kind === 'int') {
        return def.min <= 0 && def.max >= 0 ? 0 : def.min;
      }
      if (def.kind === 'enum') {
        return def.values[0] ?? '';
      }
    }
  }
  return '';
}

function updateInListItem(
  values: readonly StateValue[],
  itemIndex: number,
  nextItem: StateValue,
): readonly StateValue[] {
  return values.map((existing, i) => (i === itemIndex ? nextItem : existing));
}

export interface ValueExprEditorProps {
  readonly value: ValueExpr;
  readonly schema: StateSchema;
  readonly schemaKeysOrder?: readonly string[] | undefined;
  readonly onChange: (next: ValueExpr) => void;
  readonly depth?: number | undefined;
  readonly ariaLabelPrefix?: string | undefined;
  readonly resetKey?: string | number | undefined;
  readonly fieldPath?: string | undefined;
  readonly intDraftStore?: LiftedIntDraftStore | undefined;
  readonly onDraftErrorChange?: ((fieldKey: string, errorMessage: string | null) => void) | undefined;
}

export function ValueExprEditor({
  value,
  schema,
  schemaKeysOrder,
  onChange,
  depth = 0,
  ariaLabelPrefix = 'Value expression',
  resetKey,
  fieldPath,
  intDraftStore,
  onDraftErrorChange,
}: ValueExprEditorProps) {
  const baseId = useId();
  const schemaKeys = schemaKeysOrder ?? Object.keys(schema);

  const handleOpChange = (nextOp: ValueExpr['op']) => {
    if (nextOp === value.op) return;
    if (fieldPath !== undefined) {
      intDraftStore?.onPruneDrafts(fieldPath);
    }
    onChange(createDefaultValueExpr(nextOp, schema));
  };

  const opId = `${baseId}-op`;
  const litKindId = `${baseId}-lit-kind`;
  const litValId = `${baseId}-lit-val`;
  const varId = `${baseId}-var`;

  const litIntFieldKey = fieldPath !== undefined ? `${fieldPath}.value` : undefined;

  return (
    <div
      className={depth === 0 ? 'is-expr-node is-expr-node-root' : 'is-expr-node'}
      data-depth-capped={depth > 6 ? 'true' : undefined}
    >
      <div className="is-expr-row">
        <span className="is-inline-field">
          <label htmlFor={opId} className="is-inline-label">
            Op
          </label>
          <select
            id={opId}
            className="is-select is-mono"
            aria-label={`${ariaLabelPrefix} operator`}
            value={value.op}
            onChange={(e) => handleOpChange(e.target.value as ValueExpr['op'])}
          >
            {VALUE_OPS.map((op) => (
              <option key={op} value={op}>
                {op}
              </option>
            ))}
          </select>
        </span>

        {value.op === 'lit' &&
          (() => {
            const litKind: 'boolean' | 'number' | 'string' =
              typeof value.value === 'boolean'
                ? 'boolean'
                : typeof value.value === 'number'
                  ? 'number'
                  : 'string';

            return (
              <>
                <span className="is-inline-field">
                  <label htmlFor={litKindId} className="is-inline-label">
                    Type
                  </label>
                  <select
                    id={litKindId}
                    className="is-select"
                    aria-label={`${ariaLabelPrefix} literal type`}
                    value={litKind}
                    onChange={(e) => {
                      const nextKind = e.target.value as 'boolean' | 'number' | 'string';
                      if (
                        litKind === 'number' &&
                        nextKind !== 'number' &&
                        litIntFieldKey !== undefined
                      ) {
                        intDraftStore?.onPruneDrafts(litIntFieldKey);
                      }
                      const nextVal: StateValue =
                        nextKind === 'boolean' ? false : nextKind === 'number' ? 0 : '';
                      onChange({ op: 'lit', value: nextVal });
                    }}
                  >
                    <option value="string">string</option>
                    <option value="number">int</option>
                    <option value="boolean">bool</option>
                  </select>
                </span>

                <span className="is-inline-field">
                  <label htmlFor={litValId} className="is-inline-label">
                    Value
                  </label>
                  {litKind === 'boolean' ? (
                    <select
                      id={litValId}
                      className="is-select is-mono"
                      aria-label={`${ariaLabelPrefix} boolean literal`}
                      value={value.value ? 'true' : 'false'}
                      onChange={(e) => onChange({ op: 'lit', value: e.target.value === 'true' })}
                    >
                      <option value="true">true</option>
                      <option value="false">false</option>
                    </select>
                  ) : litKind === 'number' ? (
                    <StrictIntegerInput
                      id={litValId}
                      value={typeof value.value === 'number' ? value.value : 0}
                      className="is-input is-input-num"
                      ariaLabel={`${ariaLabelPrefix} integer literal`}
                      resetKey={resetKey}
                      fieldKey={litIntFieldKey}
                      externalDraft={
                        litIntFieldKey !== undefined
                          ? intDraftStore?.draftValues[litIntFieldKey]
                          : undefined
                      }
                      externalError={
                        litIntFieldKey !== undefined
                          ? intDraftStore?.draftErrors[litIntFieldKey]
                          : undefined
                      }
                      onDraftChange={intDraftStore?.onDraftChange}
                      onValidityChange={intDraftStore === undefined ? onDraftErrorChange : undefined}
                      onCommit={(nextInt) => onChange({ op: 'lit', value: nextInt })}
                    />
                  ) : (
                    <input
                      id={litValId}
                      type="text"
                      className="is-input is-mono"
                      aria-label={`${ariaLabelPrefix} string literal`}
                      value={String(value.value)}
                      onChange={(e) => onChange({ op: 'lit', value: e.target.value })}
                    />
                  )}
                </span>
              </>
            );
          })()}

        {value.op === 'var' && (
          <span className="is-inline-field">
            <label htmlFor={varId} className="is-inline-label">
              Var
            </label>
            <select
              id={varId}
              className="is-select is-mono"
              aria-label={`${ariaLabelPrefix} variable`}
              value={value.name}
              onChange={(e) => onChange({ op: 'var', name: e.target.value })}
            >
              {!schemaKeys.includes(value.name) && (
                <option value={value.name}>{value.name} (undeclared)</option>
              )}
              {schemaKeys.map((key) => (
                <option key={key} value={key}>
                  {key}
                </option>
              ))}
            </select>
          </span>
        )}

        {(value.op === 'add' || value.op === 'sub') && (
          <span className="is-mono" style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted)' }}>
            {formatValueExpr(value)}
          </span>
        )}
      </div>

      {(value.op === 'add' || value.op === 'sub') && (
        <div className="is-expr-children">
          <ValueExprEditor
            value={value.left}
            schema={schema}
            schemaKeysOrder={schemaKeys}
            depth={depth + 1}
            ariaLabelPrefix={`${ariaLabelPrefix} left`}
            resetKey={resetKey}
            fieldPath={fieldPath !== undefined ? `${fieldPath}.left` : undefined}
            intDraftStore={intDraftStore}
            onDraftErrorChange={onDraftErrorChange}
            onChange={(left) => onChange({ ...value, left })}
          />
          <ValueExprEditor
            value={value.right}
            schema={schema}
            schemaKeysOrder={schemaKeys}
            depth={depth + 1}
            ariaLabelPrefix={`${ariaLabelPrefix} right`}
            resetKey={resetKey}
            fieldPath={fieldPath !== undefined ? `${fieldPath}.right` : undefined}
            intDraftStore={intDraftStore}
            onDraftErrorChange={onDraftErrorChange}
            onChange={(right) => onChange({ ...value, right })}
          />
        </div>
      )}
    </div>
  );
}

export interface BoolExprEditorProps {
  readonly value: BoolExpr;
  readonly schema: StateSchema;
  readonly schemaKeysOrder?: readonly string[] | undefined;
  readonly onChange: (next: BoolExpr) => void;
  readonly depth?: number | undefined;
  readonly ariaLabelPrefix?: string | undefined;
  readonly resetKey?: string | number | undefined;
  readonly fieldPath?: string | undefined;
  readonly intDraftStore?: (LiftedIntDraftStore & Partial<Pick<ExpressionDraftStore, 'expressionRows'>>) | undefined;
  readonly onDraftErrorChange?: ((fieldKey: string, errorMessage: string | null) => void) | undefined;
}

export function BoolExprEditor({
  value,
  schema,
  schemaKeysOrder,
  onChange,
  depth = 0,
  ariaLabelPrefix = 'Boolean expression',
  resetKey,
  fieldPath,
  intDraftStore,
  onDraftErrorChange,
}: BoolExprEditorProps) {
  const baseId = useId();
  const schemaKeys = schemaKeysOrder ?? Object.keys(schema);
  const booleanKeys = schemaKeys.filter((k) => schema[k]?.kind === 'boolean');
  const localRows = useExpressionRows(resetKey);
  const rows = intDraftStore?.expressionRows ?? localRows;
  const clauseListPath = `${fieldPath ?? baseId}.args`;
  const inListPath = `${fieldPath ?? baseId}.values`;
  const resolvedClauseRowIds =
    value.op === 'and' || value.op === 'or'
      ? alignRowIds(rows.idsByPath.get(clauseListPath) ?? [], value.args.length, 'clause')
      : [];
  const resolvedInItemRowIds =
    value.op === 'in'
      ? alignRowIds(rows.idsByPath.get(inListPath) ?? [], value.values.length, 'in-item')
      : [];

  const handleOpChange = (nextOp: BoolExpr['op']) => {
    if (nextOp === value.op) return;
    if (fieldPath !== undefined) intDraftStore?.onPruneDrafts(fieldPath);
    if (rows === localRows) localRows.prune(fieldPath ?? baseId);
    onChange(createDefaultBoolExpr(nextOp, schema));
  };

  const opId = `${baseId}-op`;
  const litId = `${baseId}-lit`;
  const varId = `${baseId}-var`;

  return (
    <div
      className={depth === 0 ? 'is-expr-node is-expr-node-root' : 'is-expr-node'}
      data-depth-capped={depth > 6 ? 'true' : undefined}
    >
      <div className="is-expr-row">
        <span className="is-inline-field">
          <label htmlFor={opId} className="is-inline-label">
            Op
          </label>
          <select
            id={opId}
            className="is-select is-mono"
            aria-label={`${ariaLabelPrefix} operator`}
            value={value.op}
            onChange={(e) => handleOpChange(e.target.value as BoolExpr['op'])}
          >
            {BOOL_OPS.map((op) => (
              <option key={op} value={op}>
                {op}
              </option>
            ))}
          </select>
        </span>

        {value.op === 'lit' && (
          <span className="is-inline-field">
            <label htmlFor={litId} className="is-inline-label">
              Value
            </label>
            <select
              id={litId}
              className="is-select is-mono"
              aria-label={`${ariaLabelPrefix} literal`}
              value={value.value ? 'true' : 'false'}
              onChange={(e) => onChange({ op: 'lit', value: e.target.value === 'true' })}
            >
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
          </span>
        )}

        {value.op === 'var' && (
          <span className="is-inline-field">
            <label htmlFor={varId} className="is-inline-label">
              Var
            </label>
            <select
              id={varId}
              className="is-select is-mono"
              aria-label={`${ariaLabelPrefix} boolean variable`}
              value={value.name}
              onChange={(e) => onChange({ op: 'var', name: e.target.value })}
            >
              {!schemaKeys.includes(value.name) && (
                <option value={value.name}>{value.name} (undeclared)</option>
              )}
              {(booleanKeys.length > 0 ? booleanKeys : schemaKeys).map((key) => (
                <option key={key} value={key}>
                  {key}
                </option>
              ))}
            </select>
          </span>
        )}

        {(value.op === 'and' || value.op === 'or') && (
          <button
            type="button"
            className="is-btn is-btn-sm"
            onClick={() => {
              onChange({
                op: value.op,
                args: [...value.args, createDefaultBoolExpr('var', schema)],
              });
            }}
          >
            + Add clause
          </button>
        )}

        {depth === 0 && (
          <span className="is-mono" style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted)' }}>
            {formatBoolExpr(value)}
          </span>
        )}
      </div>

      {value.op === 'not' && (
        <div className="is-expr-children">
          <BoolExprEditor
            value={value.arg}
            schema={schema}
            schemaKeysOrder={schemaKeys}
            depth={depth + 1}
            ariaLabelPrefix={`${ariaLabelPrefix} negated`}
            resetKey={resetKey}
            fieldPath={fieldPath !== undefined ? `${fieldPath}.arg` : undefined}
            intDraftStore={intDraftStore}
            onDraftErrorChange={onDraftErrorChange}
            onChange={(arg) => onChange({ op: 'not', arg })}
          />
        </div>
      )}

      {(value.op === 'and' || value.op === 'or') && (
        <div className="is-expr-children">
          {value.args.map((child, idx) => {
            const clauseId = resolvedClauseRowIds[idx]!;
            const clauseFieldPath = `${clauseListPath}.${clauseId}`;
            return (
              <div key={clauseId} className="is-expr-row" style={{ alignItems: 'flex-start' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <BoolExprEditor
                    value={child}
                    schema={schema}
                    schemaKeysOrder={schemaKeys}
                    depth={depth + 1}
                    ariaLabelPrefix={`${ariaLabelPrefix} clause ${idx + 1}`}
                    resetKey={resetKey}
                    fieldPath={fieldPath !== undefined ? clauseFieldPath : undefined}
                    intDraftStore={intDraftStore}
                    onDraftErrorChange={onDraftErrorChange}
                    onChange={(nextChild) =>
                      onChange({
                        op: value.op,
                        args: value.args.map((existing, i) => (i === idx ? nextChild : existing)),
                      })
                    }
                  />
                </div>
                {value.args.length > 1 && (
                  <button
                    type="button"
                    className="is-btn is-btn-sm is-btn-danger"
                    aria-label={`Remove clause ${idx + 1}`}
                    onClick={() => {
                      if (fieldPath !== undefined) intDraftStore?.onPruneDrafts(clauseFieldPath);
                      rows.remember(
                        clauseListPath,
                        resolvedClauseRowIds.filter((_, i) => i !== idx),
                      );
                      onChange({
                        op: value.op,
                        args: value.args.filter((_, i) => i !== idx),
                      });
                    }}
                  >
                    Remove
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {(value.op === 'eq' ||
        value.op === 'neq' ||
        value.op === 'lt' ||
        value.op === 'lte' ||
        value.op === 'gt' ||
        value.op === 'gte') && (
        <div className="is-expr-children">
          <ValueExprEditor
            value={value.left}
            schema={schema}
            schemaKeysOrder={schemaKeys}
            depth={depth + 1}
            ariaLabelPrefix={`${ariaLabelPrefix} left`}
            resetKey={resetKey}
            fieldPath={fieldPath !== undefined ? `${fieldPath}.left` : undefined}
            intDraftStore={intDraftStore}
            onDraftErrorChange={onDraftErrorChange}
            onChange={(left) => {
              let nextRight = value.right;
              if (left.op === 'var' && value.right.op === 'lit') {
                const def = schema[left.name];
                if (def !== undefined) {
                  if (fieldPath !== undefined) intDraftStore?.onPruneDrafts(`${fieldPath}.right`);
                  nextRight = { op: 'lit', value: defaultValueForVarDef(def) };
                }
              }
              onChange({ ...value, left, right: nextRight });
            }}
          />
          <ValueExprEditor
            value={value.right}
            schema={schema}
            schemaKeysOrder={schemaKeys}
            depth={depth + 1}
            ariaLabelPrefix={`${ariaLabelPrefix} right`}
            resetKey={resetKey}
            fieldPath={fieldPath !== undefined ? `${fieldPath}.right` : undefined}
            intDraftStore={intDraftStore}
            onDraftErrorChange={onDraftErrorChange}
            onChange={(right) => onChange({ ...value, right })}
          />
        </div>
      )}

      {value.op === 'in' && (
        <div className="is-expr-children">
          <ValueExprEditor
            value={value.expr}
            schema={schema}
            schemaKeysOrder={schemaKeys}
            depth={depth + 1}
            ariaLabelPrefix={`${ariaLabelPrefix} target`}
            resetKey={resetKey}
            fieldPath={fieldPath !== undefined ? `${fieldPath}.expr` : undefined}
            intDraftStore={intDraftStore}
            onDraftErrorChange={onDraftErrorChange}
            onChange={(expr) => onChange({ ...value, expr })}
          />
          <div className="is-in-values-list">
            <div className="is-section-header">
              <span className="is-inline-label">Set values ({value.values.length})</span>
              <button
                type="button"
                className="is-btn is-btn-sm"
                onClick={() => {
                  const nextVal = defaultInItemValue(value.expr, schema);
                  onChange({
                    ...value,
                    values: [...value.values, nextVal],
                  });
                }}
              >
                + Add value
              </button>
            </div>

            {value.values.map((item, itemIdx) => {
              const itemRowId = resolvedInItemRowIds[itemIdx]!;
              const itemKind: 'boolean' | 'number' | 'string' =
                typeof item === 'boolean'
                  ? 'boolean'
                  : typeof item === 'number'
                    ? 'number'
                    : 'string';
              const itemTypeId = `${baseId}-in-type-${itemRowId}`;
              const itemValId = `${baseId}-in-val-${itemRowId}`;
              const itemFieldKey = fieldPath !== undefined ? `${inListPath}.${itemRowId}` : undefined;

              const updateInItem = (nextItem: StateValue) => {
                onChange({
                  ...value,
                  values: updateInListItem(value.values, itemIdx, nextItem),
                });
              };

              return (
                <div key={itemRowId} className="is-expr-row">
                  <span className="is-inline-field">
                    <label htmlFor={itemTypeId} className="is-inline-label">
                      Type
                    </label>
                    <select
                      id={itemTypeId}
                      className="is-select"
                      aria-label={`${ariaLabelPrefix} value ${itemIdx + 1} type`}
                      value={itemKind}
                      onChange={(e) => {
                        const nextKind = e.target.value as 'boolean' | 'number' | 'string';
                        if (
                          itemKind === 'number' &&
                          nextKind !== 'number' &&
                          itemFieldKey !== undefined
                        ) {
                          intDraftStore?.onPruneDrafts(itemFieldKey);
                        }
                        const converted: StateValue =
                          nextKind === 'boolean' ? false : nextKind === 'number' ? 0 : '';
                        updateInItem(converted);
                      }}
                    >
                      <option value="string">string</option>
                      <option value="number">int</option>
                      <option value="boolean">bool</option>
                    </select>
                  </span>

                  <span className="is-inline-field">
                    <label htmlFor={itemValId} className="is-inline-label">
                      Value
                    </label>
                    {itemKind === 'boolean' ? (
                      <select
                        id={itemValId}
                        className="is-select is-mono"
                        aria-label={`${ariaLabelPrefix} value ${itemIdx + 1}`}
                        value={item === true ? 'true' : 'false'}
                        onChange={(e) => updateInItem(e.target.value === 'true')}
                      >
                        <option value="true">true</option>
                        <option value="false">false</option>
                      </select>
                    ) : itemKind === 'number' ? (
                      <StrictIntegerInput
                        id={itemValId}
                        value={typeof item === 'number' ? item : 0}
                        className="is-input is-input-num"
                        ariaLabel={`${ariaLabelPrefix} value ${itemIdx + 1}`}
                        resetKey={resetKey}
                        fieldKey={itemFieldKey}
                        externalDraft={
                          itemFieldKey !== undefined
                            ? intDraftStore?.draftValues[itemFieldKey]
                            : undefined
                        }
                        externalError={
                          itemFieldKey !== undefined
                            ? intDraftStore?.draftErrors[itemFieldKey]
                            : undefined
                        }
                        onDraftChange={intDraftStore?.onDraftChange}
                        onValidityChange={
                          intDraftStore === undefined ? onDraftErrorChange : undefined
                        }
                        onCommit={(nextInt) => updateInItem(nextInt)}
                      />
                    ) : (
                      <input
                        id={itemValId}
                        type="text"
                        className="is-input is-mono"
                        aria-label={`${ariaLabelPrefix} value ${itemIdx + 1}`}
                        value={String(item)}
                        onChange={(e) => updateInItem(e.target.value)}
                      />
                    )}
                  </span>

                  <button
                    type="button"
                    className="is-btn is-btn-sm is-btn-danger"
                    aria-label={`Remove set value ${itemIdx + 1}`}
                    onClick={() => {
                      if (itemFieldKey !== undefined) intDraftStore?.onPruneDrafts(itemFieldKey);
                      rows.remember(
                        inListPath,
                        resolvedInItemRowIds.filter((_, i) => i !== itemIdx),
                      );
                      onChange({
                        ...value,
                        values: value.values.filter((_, i) => i !== itemIdx),
                      });
                    }}
                  >
                    Remove
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
