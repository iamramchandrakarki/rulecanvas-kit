import { useEffect, useId, useRef, useState } from 'react';
import type { BoolExpr, StateSchema, StateValue, ValueExpr } from '@rulecanvas/core';
import { formatBoolExpr, formatValueExpr } from '@rulecanvas/ui';
import {
  createDefaultBoolExpr,
  createDefaultValueExpr,
  defaultValueForVarDef,
} from '../model-editor.js';
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

export interface LiftedIntDraftStore {
  readonly draftValues: Readonly<Record<string, string>>;
  readonly draftErrors: Readonly<Record<string, string>>;
  readonly onDraftChange: (fieldKey: string, rawDraft: string, errorMessage: string | null) => void;
  readonly onPruneDrafts: (prefix: string) => void;
}

function alignLocalRowIds(
  current: readonly string[],
  targetLength: number,
  prefix: string,
): readonly string[] {
  if (current.length === targetLength) return current;
  if (current.length > targetLength) return current.slice(0, targetLength);
  const next = [...current];
  for (let i = current.length; i < targetLength; i += 1) {
    next.push(`${prefix}-sync-${i}`);
  }
  return next;
}

export function defaultInItemValue(targetExpr: ValueExpr, schema: StateSchema): StateValue {
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

export function updateInListItem(
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
    <div className={depth === 0 ? 'ag-expr-node ag-expr-node-root' : 'ag-expr-node'}>
      <div className="ag-expr-row">
        <span className="ag-inline-field">
          <label htmlFor={opId} className="ag-inline-label">
            Op
          </label>
          <select
            id={opId}
            className="ag-select ag-input-mono"
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

        {value.op === 'lit' && (() => {
          const litKind: 'boolean' | 'number' | 'string' =
            typeof value.value === 'boolean'
              ? 'boolean'
              : typeof value.value === 'number'
                ? 'number'
                : 'string';

          return (
            <>
              <span className="ag-inline-field">
                <label htmlFor={litKindId} className="ag-inline-label">
                  Type
                </label>
                <select
                  id={litKindId}
                  className="ag-select"
                  aria-label={`${ariaLabelPrefix} literal type`}
                  value={litKind}
                  onChange={(e) => {
                    const nextKind = e.target.value as 'boolean' | 'number' | 'string';
                    if (litKind === 'number' && nextKind !== 'number' && litIntFieldKey !== undefined) {
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

              <span className="ag-inline-field">
                <label htmlFor={litValId} className="ag-inline-label">
                  Value
                </label>
                {litKind === 'boolean' ? (
                  <select
                    id={litValId}
                    className="ag-select ag-input-mono"
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
                    className="ag-input ag-input-num"
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
                    className="ag-input ag-input-mono"
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
          <span className="ag-inline-field">
            <label htmlFor={varId} className="ag-inline-label">
              Var
            </label>
            <select
              id={varId}
              className="ag-select ag-input-mono"
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
          <span className="ag-mono" style={{ fontSize: 12, color: 'var(--color-ink-muted)' }}>
            {formatValueExpr(value)}
          </span>
        )}
      </div>

      {(value.op === 'add' || value.op === 'sub') && (
        <div className="ag-expr-children">
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
  readonly intDraftStore?: LiftedIntDraftStore | undefined;
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
  const localRowCounterRef = useRef<number>(0);
  const prevResetKeyRef = useRef<string | number | undefined>(resetKey);

  const allocLocalId = (prefix: string): string => {
    localRowCounterRef.current += 1;
    return `${prefix}-${localRowCounterRef.current}`;
  };

  const [clauseRowIds, setClauseRowIds] = useState<readonly string[]>(() =>
    value.op === 'and' || value.op === 'or'
      ? value.args.map(() => allocLocalId('clause'))
      : [],
  );
  const [inItemRowIds, setInItemRowIds] = useState<readonly string[]>(() =>
    value.op === 'in' ? value.values.map(() => allocLocalId('in-item')) : [],
  );

  useEffect(() => {
    if (prevResetKeyRef.current !== resetKey) {
      prevResetKeyRef.current = resetKey;
      setClauseRowIds(
        value.op === 'and' || value.op === 'or'
          ? value.args.map(() => allocLocalId('clause'))
          : [],
      );
      setInItemRowIds(value.op === 'in' ? value.values.map(() => allocLocalId('in-item')) : []);
    }
  }, [resetKey, value]);

  const schemaKeys = schemaKeysOrder ?? Object.keys(schema);
  const booleanKeys = schemaKeys.filter((k) => schema[k]?.kind === 'boolean');

  const resolvedClauseRowIds =
    value.op === 'and' || value.op === 'or'
      ? alignLocalRowIds(clauseRowIds, value.args.length, 'clause')
      : [];
  const resolvedInItemRowIds =
    value.op === 'in' ? alignLocalRowIds(inItemRowIds, value.values.length, 'in-item') : [];

  const handleOpChange = (nextOp: BoolExpr['op']) => {
    if (nextOp === value.op) return;
    if (fieldPath !== undefined) {
      intDraftStore?.onPruneDrafts(fieldPath);
    }
    const nextExpr = createDefaultBoolExpr(nextOp, schema);
    if (nextExpr.op === 'and' || nextExpr.op === 'or') {
      setClauseRowIds(nextExpr.args.map(() => allocLocalId('clause')));
    } else {
      setClauseRowIds([]);
    }
    if (nextExpr.op === 'in') {
      setInItemRowIds(nextExpr.values.map(() => allocLocalId('in-item')));
    } else {
      setInItemRowIds([]);
    }
    onChange(nextExpr);
  };

  const opId = `${baseId}-op`;
  const litId = `${baseId}-lit`;
  const varId = `${baseId}-var`;

  return (
    <div className={depth === 0 ? 'ag-expr-node ag-expr-node-root' : 'ag-expr-node'}>
      <div className="ag-expr-row">
        <span className="ag-inline-field">
          <label htmlFor={opId} className="ag-inline-label">
            Op
          </label>
          <select
            id={opId}
            className="ag-select ag-input-mono"
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
          <span className="ag-inline-field">
            <label htmlFor={litId} className="ag-inline-label">
              Value
            </label>
            <select
              id={litId}
              className="ag-select ag-input-mono"
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
          <span className="ag-inline-field">
            <label htmlFor={varId} className="ag-inline-label">
              Var
            </label>
            <select
              id={varId}
              className="ag-select ag-input-mono"
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
            className="ag-btn ag-btn-sm"
            onClick={() => {
              setClauseRowIds([...resolvedClauseRowIds, allocLocalId('clause')]);
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
          <span className="ag-mono" style={{ fontSize: 11.5, color: 'var(--color-ink-muted)' }}>
            {formatBoolExpr(value)}
          </span>
        )}
      </div>

      {value.op === 'not' && (
        <div className="ag-expr-children">
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
        <div className="ag-expr-children">
          {value.args.map((child, idx) => {
            const clauseId = resolvedClauseRowIds[idx]!;
            const clauseFieldPath =
              fieldPath !== undefined ? `${fieldPath}.args.${clauseId}` : undefined;
            return (
              <div key={clauseId} className="ag-expr-row" style={{ alignItems: 'flex-start' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <BoolExprEditor
                    value={child}
                    schema={schema}
                    schemaKeysOrder={schemaKeys}
                    depth={depth + 1}
                    ariaLabelPrefix={`${ariaLabelPrefix} clause ${idx + 1}`}
                    resetKey={resetKey}
                    fieldPath={clauseFieldPath}
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
                    className="ag-btn ag-btn-sm ag-btn-danger"
                    aria-label={`Remove clause ${idx + 1}`}
                    onClick={() => {
                      if (clauseFieldPath !== undefined) {
                        intDraftStore?.onPruneDrafts(clauseFieldPath);
                      }
                      setClauseRowIds(resolvedClauseRowIds.filter((_, i) => i !== idx));
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
        <div className="ag-expr-children">
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
                  if (fieldPath !== undefined) {
                    intDraftStore?.onPruneDrafts(`${fieldPath}.right`);
                  }
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
        <div className="ag-expr-children">
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
          <div className="ag-in-values-list">
            <div className="ag-section-header">
              <span className="ag-field-label">
                Set values ({value.values.length})
              </span>
              <button
                type="button"
                className="ag-btn ag-btn-sm"
                onClick={() => {
                  const nextId = allocLocalId('in-item');
                  setInItemRowIds([...resolvedInItemRowIds, nextId]);
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
              const itemFieldKey =
                fieldPath !== undefined ? `${fieldPath}.values.${itemRowId}` : undefined;

              const updateInItem = (nextItem: StateValue) => {
                onChange({
                  ...value,
                  values: updateInListItem(value.values, itemIdx, nextItem),
                });
              };

              return (
                <div key={itemRowId} className="ag-expr-row">
                  <span className="ag-inline-field">
                    <label htmlFor={itemTypeId} className="ag-inline-label">
                      Type
                    </label>
                    <select
                      id={itemTypeId}
                      className="ag-select"
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

                  <span className="ag-inline-field">
                    <label htmlFor={itemValId} className="ag-inline-label">
                      Value
                    </label>
                    {itemKind === 'boolean' ? (
                      <select
                        id={itemValId}
                        className="ag-select ag-input-mono"
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
                        className="ag-input ag-input-num"
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
                        className="ag-input ag-input-mono"
                        aria-label={`${ariaLabelPrefix} value ${itemIdx + 1}`}
                        value={String(item)}
                        onChange={(e) => updateInItem(e.target.value)}
                      />
                    )}
                  </span>

                  <button
                    type="button"
                    className="ag-btn ag-btn-sm ag-btn-danger"
                    aria-label={`Remove set value ${itemIdx + 1}`}
                    onClick={() => {
                      if (itemFieldKey !== undefined) {
                        intDraftStore?.onPruneDrafts(itemFieldKey);
                      }
                      setInItemRowIds(resolvedInItemRowIds.filter((_, i) => i !== itemIdx));
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
