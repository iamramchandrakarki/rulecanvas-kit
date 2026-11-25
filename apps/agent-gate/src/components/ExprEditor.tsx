import { useId } from 'react';
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

function parseInValuesInput(raw: string): readonly StateValue[] {
  if (raw.trim().length === 0) return [];
  return raw.split(',').map((part) => {
    const trimmed = part.trim();
    if (trimmed === 'true') return true;
    if (trimmed === 'false') return false;
    if (/^-?\d+$/.test(trimmed)) {
      const n = Number(trimmed);
      if (Number.isSafeInteger(n)) return n;
    }
    return trimmed;
  });
}

export interface ValueExprEditorProps {
  readonly value: ValueExpr;
  readonly schema: StateSchema;
  readonly onChange: (next: ValueExpr) => void;
  readonly depth?: number | undefined;
  readonly ariaLabelPrefix?: string | undefined;
  readonly resetKey?: string | number | undefined;
  readonly fieldPath?: string | undefined;
  readonly onDraftErrorChange?: ((fieldKey: string, errorMessage: string | null) => void) | undefined;
}

export function ValueExprEditor({
  value,
  schema,
  onChange,
  depth = 0,
  ariaLabelPrefix = 'Value expression',
  resetKey,
  fieldPath,
  onDraftErrorChange,
}: ValueExprEditorProps) {
  const schemaKeys = Object.keys(schema);

  const handleOpChange = (nextOp: ValueExpr['op']) => {
    if (nextOp === value.op) return;
    onChange(createDefaultValueExpr(nextOp, schema));
  };

  return (
    <div className={depth === 0 ? 'ag-expr-node ag-expr-node-root' : 'ag-expr-node'}>
      <div className="ag-expr-row">
        <select
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

        {value.op === 'lit' && (() => {
          const litKind: 'boolean' | 'number' | 'string' =
            typeof value.value === 'boolean'
              ? 'boolean'
              : typeof value.value === 'number'
                ? 'number'
                : 'string';

          return (
            <>
              <select
                className="ag-select"
                aria-label={`${ariaLabelPrefix} literal type`}
                value={litKind}
                onChange={(e) => {
                  const nextKind = e.target.value as 'boolean' | 'number' | 'string';
                  const nextVal: StateValue =
                    nextKind === 'boolean' ? false : nextKind === 'number' ? 0 : '';
                  onChange({ op: 'lit', value: nextVal });
                }}
              >
                <option value="string">string</option>
                <option value="number">int</option>
                <option value="boolean">bool</option>
              </select>

              {litKind === 'boolean' ? (
                <select
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
                  value={typeof value.value === 'number' ? value.value : 0}
                  className="ag-input ag-input-num"
                  ariaLabel={`${ariaLabelPrefix} integer literal`}
                  resetKey={resetKey}
                  fieldKey={fieldPath !== undefined ? `${fieldPath}.value` : undefined}
                  onValidityChange={onDraftErrorChange}
                  onCommit={(nextInt) => onChange({ op: 'lit', value: nextInt })}
                />
              ) : (
                <input
                  type="text"
                  className="ag-input ag-input-mono"
                  aria-label={`${ariaLabelPrefix} string literal`}
                  value={String(value.value)}
                  onChange={(e) => onChange({ op: 'lit', value: e.target.value })}
                />
              )}
            </>
          );
        })()}

        {value.op === 'var' && (
          <select
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
            depth={depth + 1}
            ariaLabelPrefix={`${ariaLabelPrefix} left`}
            resetKey={resetKey}
            fieldPath={fieldPath !== undefined ? `${fieldPath}.left` : undefined}
            onDraftErrorChange={onDraftErrorChange}
            onChange={(left) => onChange({ ...value, left })}
          />
          <ValueExprEditor
            value={value.right}
            schema={schema}
            depth={depth + 1}
            ariaLabelPrefix={`${ariaLabelPrefix} right`}
            resetKey={resetKey}
            fieldPath={fieldPath !== undefined ? `${fieldPath}.right` : undefined}
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
  readonly onChange: (next: BoolExpr) => void;
  readonly depth?: number | undefined;
  readonly ariaLabelPrefix?: string | undefined;
  readonly resetKey?: string | number | undefined;
  readonly fieldPath?: string | undefined;
  readonly onDraftErrorChange?: ((fieldKey: string, errorMessage: string | null) => void) | undefined;
}

export function BoolExprEditor({
  value,
  schema,
  onChange,
  depth = 0,
  ariaLabelPrefix = 'Boolean expression',
  resetKey,
  fieldPath,
  onDraftErrorChange,
}: BoolExprEditorProps) {
  const inValuesId = useId();
  const schemaKeys = Object.keys(schema);
  const booleanKeys = schemaKeys.filter((k) => schema[k]?.kind === 'boolean');

  const handleOpChange = (nextOp: BoolExpr['op']) => {
    if (nextOp === value.op) return;
    onChange(createDefaultBoolExpr(nextOp, schema));
  };

  return (
    <div className={depth === 0 ? 'ag-expr-node ag-expr-node-root' : 'ag-expr-node'}>
      <div className="ag-expr-row">
        <select
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

        {value.op === 'lit' && (
          <select
            className="ag-select ag-input-mono"
            aria-label={`${ariaLabelPrefix} literal`}
            value={value.value ? 'true' : 'false'}
            onChange={(e) => onChange({ op: 'lit', value: e.target.value === 'true' })}
          >
            <option value="true">true</option>
            <option value="false">false</option>
          </select>
        )}

        {value.op === 'var' && (
          <select
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
        )}

        {(value.op === 'and' || value.op === 'or') && (
          <button
            type="button"
            className="ag-btn ag-btn-sm"
            onClick={() =>
              onChange({
                op: value.op,
                args: [...value.args, createDefaultBoolExpr('var', schema)],
              })
            }
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
            depth={depth + 1}
            ariaLabelPrefix={`${ariaLabelPrefix} negated`}
            resetKey={resetKey}
            fieldPath={fieldPath !== undefined ? `${fieldPath}.arg` : undefined}
            onDraftErrorChange={onDraftErrorChange}
            onChange={(arg) => onChange({ op: 'not', arg })}
          />
        </div>
      )}

      {(value.op === 'and' || value.op === 'or') && (
        <div className="ag-expr-children">
          {value.args.map((child, idx) => (
            <div key={idx} className="ag-expr-row" style={{ alignItems: 'flex-start' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <BoolExprEditor
                  value={child}
                  schema={schema}
                  depth={depth + 1}
                  ariaLabelPrefix={`${ariaLabelPrefix} clause ${idx + 1}`}
                  resetKey={resetKey}
                  fieldPath={fieldPath !== undefined ? `${fieldPath}.args[${idx}]` : undefined}
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
                  onClick={() =>
                    onChange({
                      op: value.op,
                      args: value.args.filter((_, i) => i !== idx),
                    })
                  }
                >
                  Remove
                </button>
              )}
            </div>
          ))}
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
            depth={depth + 1}
            ariaLabelPrefix={`${ariaLabelPrefix} left`}
            resetKey={resetKey}
            fieldPath={fieldPath !== undefined ? `${fieldPath}.left` : undefined}
            onDraftErrorChange={onDraftErrorChange}
            onChange={(left) => {
              let nextRight = value.right;
              if (left.op === 'var' && value.right.op === 'lit') {
                const def = schema[left.name];
                if (def !== undefined) {
                  nextRight = { op: 'lit', value: defaultValueForVarDef(def) };
                }
              }
              onChange({ ...value, left, right: nextRight });
            }}
          />
          <ValueExprEditor
            value={value.right}
            schema={schema}
            depth={depth + 1}
            ariaLabelPrefix={`${ariaLabelPrefix} right`}
            resetKey={resetKey}
            fieldPath={fieldPath !== undefined ? `${fieldPath}.right` : undefined}
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
            depth={depth + 1}
            ariaLabelPrefix={`${ariaLabelPrefix} target`}
            resetKey={resetKey}
            fieldPath={fieldPath !== undefined ? `${fieldPath}.expr` : undefined}
            onDraftErrorChange={onDraftErrorChange}
            onChange={(expr) => onChange({ ...value, expr })}
          />
          <div className="ag-field" style={{ paddingLeft: 12 }}>
            <label htmlFor={inValuesId}>Comma-separated set values</label>
            <input
              id={inValuesId}
              type="text"
              className="ag-input ag-input-mono"
              aria-label={`${ariaLabelPrefix} set values`}
              value={value.values.map((v) => String(v)).join(', ')}
              onChange={(e) =>
                onChange({
                  ...value,
                  values: parseInValuesInput(e.target.value),
                })
              }
            />
          </div>
        </div>
      )}
    </div>
  );
}
