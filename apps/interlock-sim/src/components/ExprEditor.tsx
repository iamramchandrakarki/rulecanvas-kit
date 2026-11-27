import { useEffect, useId, useState, type ReactNode } from 'react';
import type { BoolExpr, StateSchema, StateValue, ValidationError, ValueExpr } from '@rulecanvas/core';
import { formatBoolExpr } from '@rulecanvas/ui';
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

/*
 * Compact recursive AST editor.
 *
 * Layout only: every node still edits the exact core BoolExpr / ValueExpr shape.
 * Comparisons render infix (`left op right`), groups render as collapsible
 * indented clause lists, and `not` over a leaf renders on one row.
 */

const CX = {
  select: 'is-select is-mono',
  input: 'is-input is-mono',
  inputNum: 'is-input is-input-num',
  button: 'is-btn is-btn-sm',
  hidden: 'is-visually-hidden',
  intWrap: 'is-strict-int-wrap',
} as const;

const DEPTH_CAP = 6;

const BOOL_OP_GROUPS: readonly {
  readonly label: string;
  readonly ops: readonly { readonly op: BoolExpr['op']; readonly text: string }[];
}[] = [
  {
    label: 'Logic',
    ops: [
      { op: 'and', text: 'and' },
      { op: 'or', text: 'or' },
      { op: 'not', text: 'not' },
    ],
  },
  {
    label: 'Compare',
    ops: [
      { op: 'eq', text: '==' },
      { op: 'neq', text: '!=' },
      { op: 'lt', text: '<' },
      { op: 'lte', text: '<=' },
      { op: 'gt', text: '>' },
      { op: 'gte', text: '>=' },
      { op: 'in', text: 'in' },
    ],
  },
  {
    label: 'Atom',
    ops: [
      { op: 'var', text: 'var' },
      { op: 'lit', text: 'const' },
    ],
  },
];

/**
 * One picker selects both the ValueExpr operator and, for literals, the literal
 * type: `lit` is split into str / int / bool so a literal needs one control, not two.
 */
type OperandKind = 'var' | 'lit:string' | 'lit:number' | 'lit:boolean' | 'add' | 'sub';

const OPERAND_KIND_OPTIONS: readonly { readonly kind: OperandKind; readonly text: string }[] = [
  { kind: 'var', text: 'var' },
  { kind: 'lit:string', text: 'str' },
  { kind: 'lit:number', text: 'int' },
  { kind: 'lit:boolean', text: 'bool' },
  { kind: 'add', text: '+' },
  { kind: 'sub', text: '-' },
];

export function operandKindOf(value: ValueExpr): OperandKind {
  if (value.op === 'lit') return `lit:${literalKindOf(value.value)}`;
  return value.op;
}

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

/** True for nodes that render on a single editor row (no nested clause list). */
export function isSingleRowBoolExpr(expr: BoolExpr): boolean {
  return expr.op !== 'and' && expr.op !== 'or' && expr.op !== 'not';
}

/** Diagnostics that belong to `path` or any of its descendants. */
export function selectDiagnosticsUnder(
  diagnostics: readonly ValidationError[] | undefined,
  path: string | undefined,
): readonly ValidationError[] {
  if (diagnostics === undefined || path === undefined) return [];
  return diagnostics.filter(
    (err) =>
      err.path === path || err.path.startsWith(`${path}.`) || err.path.startsWith(`${path}[`),
  );
}

/** Diagnostics attached to `path` itself rather than to a nested clause. */
function selectDiagnosticsAt(
  diagnostics: readonly ValidationError[] | undefined,
  path: string | undefined,
): readonly ValidationError[] {
  const isNestedClause = (errPath: string) =>
    errPath.startsWith(`${path}.args[`) ||
    errPath === `${path}.arg` ||
    errPath.startsWith(`${path}.arg.`) ||
    errPath.startsWith(`${path}.arg[`);
  return selectDiagnosticsUnder(diagnostics, path).filter((err) => !isNestedClause(err.path));
}

function NodeDiagnostics({ errors }: { readonly errors: readonly ValidationError[] }) {
  if (errors.length === 0) return null;
  return (
    <ul className="rc-expr-diagnostics" role="alert">
      {errors.map((err, idx) => (
        <li key={`${err.code}-${err.path}-${idx}`}>
          {err.message} <code>{err.code}</code>
        </li>
      ))}
    </ul>
  );
}

function IconButton({
  label,
  onClick,
  children,
  className = '',
  expanded,
  controls,
}: {
  readonly label: string;
  readonly onClick: () => void;
  readonly children: ReactNode;
  readonly className?: string;
  readonly expanded?: boolean;
  readonly controls?: string;
}) {
  return (
    <button
      type="button"
      className={`rc-expr-icon-btn ${className}`.trim()}
      aria-label={label}
      title={label}
      aria-expanded={expanded}
      aria-controls={controls}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function RemoveGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
      <path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function ChevronGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
      <path d="M3 2l4 3-4 3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

interface LiteralKindPickerProps {
  readonly id: string;
  readonly ariaLabel: string;
  readonly value: 'boolean' | 'number' | 'string';
  readonly onChange: (next: 'boolean' | 'number' | 'string') => void;
}

function LiteralKindPicker({ id, ariaLabel, value, onChange }: LiteralKindPickerProps) {
  return (
    <>
      <label htmlFor={id} className={CX.hidden}>
        Literal type
      </label>
      <select
        id={id}
        className={`${CX.select} rc-expr-kind`}
        aria-label={ariaLabel}
        value={value}
        onChange={(e) => onChange(e.target.value as 'boolean' | 'number' | 'string')}
      >
        <option value="string">str</option>
        <option value="number">int</option>
        <option value="boolean">bool</option>
      </select>
    </>
  );
}

function literalKindOf(value: StateValue): 'boolean' | 'number' | 'string' {
  return typeof value === 'boolean' ? 'boolean' : typeof value === 'number' ? 'number' : 'string';
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

/** Inline operand editor: `var name`, `lit value`, or `( left +/- right )`. */
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

  const currentKind = operandKindOf(value);
  const handleKindChange = (nextKind: OperandKind) => {
    if (nextKind === currentKind) return;
    if (fieldPath !== undefined) {
      intDraftStore?.onPruneDrafts(fieldPath);
    }
    if (nextKind === 'lit:string') {
      onChange({ op: 'lit', value: '' });
    } else if (nextKind === 'lit:number') {
      onChange({ op: 'lit', value: 0 });
    } else if (nextKind === 'lit:boolean') {
      onChange({ op: 'lit', value: false });
    } else {
      onChange(createDefaultValueExpr(nextKind, schema));
    }
  };

  const opId = `${baseId}-op`;
  const litValId = `${baseId}-lit-val`;
  const varId = `${baseId}-var`;
  const litIntFieldKey = fieldPath !== undefined ? `${fieldPath}.value` : undefined;

  const opSelect = (
    <>
      <label htmlFor={opId} className={CX.hidden}>
        Operand kind
      </label>
      <select
        id={opId}
        className={`${CX.select} rc-expr-kind`}
        aria-label={`${ariaLabelPrefix} kind`}
        title="Operand kind: variable, literal (str / int / bool), or arithmetic"
        value={currentKind}
        onChange={(e) => handleKindChange(e.target.value as OperandKind)}
      >
        {OPERAND_KIND_OPTIONS.map((option) => (
          <option key={option.kind} value={option.kind}>
            {option.text}
          </option>
        ))}
      </select>
    </>
  );

  const renderChild = (side: 'left' | 'right') => {
    if (value.op !== 'add' && value.op !== 'sub') return null;
    return (
      <ValueExprEditor
        value={value[side]}
        schema={schema}
        schemaKeysOrder={schemaKeys}
        depth={depth + 1}
        ariaLabelPrefix={`${ariaLabelPrefix} ${side}`}
        resetKey={resetKey}
        fieldPath={fieldPath !== undefined ? `${fieldPath}.${side}` : undefined}
        intDraftStore={intDraftStore}
        onDraftErrorChange={onDraftErrorChange}
        onChange={(next) => onChange({ ...value, [side]: next })}
      />
    );
  };

  return (
    <span
      className="rc-expr-operand"
      data-op={value.op}
      data-depth-capped={depth > DEPTH_CAP ? 'true' : undefined}
    >
      {value.op === 'add' || value.op === 'sub' ? (
        <>
          <span className="rc-expr-punct" aria-hidden="true">
            (
          </span>
          {renderChild('left')}
          {opSelect}
          {renderChild('right')}
          <span className="rc-expr-punct" aria-hidden="true">
            )
          </span>
        </>
      ) : (
        opSelect
      )}

      {value.op === 'var' && (
        <>
          <label htmlFor={varId} className={CX.hidden}>
            Variable
          </label>
          <select
            id={varId}
            className={`${CX.select} rc-expr-var`}
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
        </>
      )}

      {value.op === 'lit' &&
        (() => {
          const litKind = literalKindOf(value.value);
          return (
            <>
              <label htmlFor={litValId} className={CX.hidden}>
                Literal value
              </label>
              {litKind === 'boolean' ? (
                <select
                  id={litValId}
                  className={`${CX.select} rc-expr-value`}
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
                  className={`${CX.inputNum} rc-expr-value rc-expr-int`}
                  ariaLabel={`${ariaLabelPrefix} integer literal`}
                  resetKey={resetKey}
                  fieldKey={litIntFieldKey}
                  externalDraft={
                    litIntFieldKey !== undefined ? intDraftStore?.draftValues[litIntFieldKey] : undefined
                  }
                  externalError={
                    litIntFieldKey !== undefined ? intDraftStore?.draftErrors[litIntFieldKey] : undefined
                  }
                  onDraftChange={intDraftStore?.onDraftChange}
                  onValidityChange={intDraftStore === undefined ? onDraftErrorChange : undefined}
                  onCommit={(nextInt) => onChange({ op: 'lit', value: nextInt })}
                />
              ) : (
                <input
                  id={litValId}
                  type="text"
                  className={`${CX.input} rc-expr-value rc-expr-str`}
                  aria-label={`${ariaLabelPrefix} string literal`}
                  spellCheck={false}
                  value={String(value.value)}
                  onChange={(e) => onChange({ op: 'lit', value: e.target.value })}
                />
              )}
            </>
          );
        })()}
    </span>
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
  /** Model validation errors; nodes surface the ones under `diagnosticPath`. */
  readonly diagnostics?: readonly ValidationError[] | undefined;
  /** Core model path of this node, e.g. `rules[3].guard`. */
  readonly diagnosticPath?: string | undefined;
  /** Show the formatted expression above the root node (default true). */
  readonly showPreview?: boolean | undefined;
  /** Render only this node's row content, for embedding inside a parent row. */
  readonly inline?: boolean | undefined;
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
  diagnostics,
  diagnosticPath,
  showPreview = true,
  inline = false,
}: BoolExprEditorProps) {
  const baseId = useId();
  const schemaKeys = schemaKeysOrder ?? Object.keys(schema);
  const booleanKeys = schemaKeys.filter((k) => schema[k]?.kind === 'boolean');
  const localRows = useExpressionRows(resetKey);
  const rows = intDraftStore?.expressionRows ?? localRows;
  const [collapsed, setCollapsed] = useState(false);
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
  const childrenId = `${baseId}-children`;
  const childPath = (suffix: string) => (fieldPath !== undefined ? `${fieldPath}${suffix}` : undefined);
  const childDiagPath = (suffix: string) =>
    diagnosticPath !== undefined ? `${diagnosticPath}${suffix}` : undefined;

  const isGroup = value.op === 'and' || value.op === 'or';
  const inlineNotChild = value.op === 'not' && isSingleRowBoolExpr(value.arg);
  const nodeErrors =
    isSingleRowBoolExpr(value) || inlineNotChild
      ? selectDiagnosticsUnder(diagnostics, diagnosticPath)
      : selectDiagnosticsAt(diagnostics, diagnosticPath);

  const opSelect = (
    <>
      <label htmlFor={opId} className={CX.hidden}>
        Operator
      </label>
      <select
        id={opId}
        className={`${CX.select} rc-expr-op`}
        aria-label={`${ariaLabelPrefix} operator`}
        data-op={value.op}
        value={value.op}
        onChange={(e) => handleOpChange(e.target.value as BoolExpr['op'])}
      >
        {BOOL_OP_GROUPS.map((group) => (
          <optgroup key={group.label} label={group.label}>
            {group.ops.map((option) => (
              <option key={option.op} value={option.op}>
                {option.text}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </>
  );

  const valueChild = (
    side: 'left' | 'right' | 'expr',
    child: ValueExpr,
    labelSuffix: string,
    onChildChange: (next: ValueExpr) => void,
  ) => (
    <ValueExprEditor
      value={child}
      schema={schema}
      schemaKeysOrder={schemaKeys}
      depth={depth + 1}
      ariaLabelPrefix={`${ariaLabelPrefix} ${labelSuffix}`}
      resetKey={resetKey}
      fieldPath={childPath(`.${side}`)}
      intDraftStore={intDraftStore}
      onDraftErrorChange={onDraftErrorChange}
      onChange={onChildChange}
    />
  );

  const renderRowContent = (): ReactNode => {
    switch (value.op) {
      case 'lit':
        return (
          <>
            {opSelect}
            <label htmlFor={litId} className={CX.hidden}>
              Constant value
            </label>
            <select
              id={litId}
              className={`${CX.select} rc-expr-value`}
              aria-label={`${ariaLabelPrefix} literal`}
              value={value.value ? 'true' : 'false'}
              onChange={(e) => onChange({ op: 'lit', value: e.target.value === 'true' })}
            >
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
          </>
        );
      case 'var':
        return (
          <>
            {opSelect}
            <label htmlFor={varId} className={CX.hidden}>
              Boolean variable
            </label>
            <select
              id={varId}
              className={`${CX.select} rc-expr-var`}
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
          </>
        );
      case 'eq':
      case 'neq':
      case 'lt':
      case 'lte':
      case 'gt':
      case 'gte':
        return (
          <>
            {valueChild('left', value.left, 'left', (left) => {
              let nextRight = value.right;
              if (left.op === 'var' && value.right.op === 'lit') {
                const def = schema[left.name];
                if (def !== undefined) {
                  if (fieldPath !== undefined) intDraftStore?.onPruneDrafts(`${fieldPath}.right`);
                  nextRight = { op: 'lit', value: defaultValueForVarDef(def) };
                }
              }
              onChange({ ...value, left, right: nextRight });
            })}
            {opSelect}
            {valueChild('right', value.right, 'right', (right) => onChange({ ...value, right }))}
          </>
        );
      case 'in':
        return (
          <>
            {valueChild('expr', value.expr, 'target', (expr) => onChange({ ...value, expr }))}
            {opSelect}
            <span className="rc-expr-set" role="group" aria-label={`${ariaLabelPrefix} set values`}>
              <span className="rc-expr-punct" aria-hidden="true">
                {'{'}
              </span>
              {value.values.map((item, itemIdx) => {
                const itemRowId = resolvedInItemRowIds[itemIdx]!;
                const itemKind = literalKindOf(item);
                const itemTypeId = `${baseId}-in-type-${itemRowId}`;
                const itemValId = `${baseId}-in-val-${itemRowId}`;
                const itemFieldKey = fieldPath !== undefined ? `${inListPath}.${itemRowId}` : undefined;
                const updateInItem = (nextItem: StateValue) => {
                  onChange({ ...value, values: updateInListItem(value.values, itemIdx, nextItem) });
                };

                return (
                  <span key={itemRowId} className="rc-expr-set-item">
                    <LiteralKindPicker
                      id={itemTypeId}
                      ariaLabel={`${ariaLabelPrefix} value ${itemIdx + 1} type`}
                      value={itemKind}
                      onChange={(nextKind) => {
                        if (itemKind === 'number' && nextKind !== 'number' && itemFieldKey !== undefined) {
                          intDraftStore?.onPruneDrafts(itemFieldKey);
                        }
                        updateInItem(nextKind === 'boolean' ? false : nextKind === 'number' ? 0 : '');
                      }}
                    />
                    <label htmlFor={itemValId} className={CX.hidden}>
                      Set value {itemIdx + 1}
                    </label>
                    {itemKind === 'boolean' ? (
                      <select
                        id={itemValId}
                        className={`${CX.select} rc-expr-value`}
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
                        className={`${CX.inputNum} rc-expr-value rc-expr-int`}
                        ariaLabel={`${ariaLabelPrefix} value ${itemIdx + 1}`}
                        resetKey={resetKey}
                        fieldKey={itemFieldKey}
                        externalDraft={
                          itemFieldKey !== undefined ? intDraftStore?.draftValues[itemFieldKey] : undefined
                        }
                        externalError={
                          itemFieldKey !== undefined ? intDraftStore?.draftErrors[itemFieldKey] : undefined
                        }
                        onDraftChange={intDraftStore?.onDraftChange}
                        onValidityChange={intDraftStore === undefined ? onDraftErrorChange : undefined}
                        onCommit={(nextInt) => updateInItem(nextInt)}
                      />
                    ) : (
                      <input
                        id={itemValId}
                        type="text"
                        className={`${CX.input} rc-expr-value rc-expr-str`}
                        aria-label={`${ariaLabelPrefix} value ${itemIdx + 1}`}
                        spellCheck={false}
                        value={String(item)}
                        onChange={(e) => updateInItem(e.target.value)}
                      />
                    )}
                    <IconButton
                      label={`Remove set value ${itemIdx + 1}`}
                      className="rc-expr-remove"
                      onClick={() => {
                        if (itemFieldKey !== undefined) intDraftStore?.onPruneDrafts(itemFieldKey);
                        rows.remember(
                          inListPath,
                          resolvedInItemRowIds.filter((_, i) => i !== itemIdx),
                        );
                        onChange({ ...value, values: value.values.filter((_, i) => i !== itemIdx) });
                      }}
                    >
                      <RemoveGlyph />
                    </IconButton>
                  </span>
                );
              })}
              <button
                type="button"
                className={`${CX.button} rc-expr-add`}
                onClick={() => {
                  onChange({ ...value, values: [...value.values, defaultInItemValue(value.expr, schema)] });
                }}
              >
                + Add value
              </button>
              <span className="rc-expr-punct" aria-hidden="true">
                {'}'}
              </span>
            </span>
          </>
        );
      case 'not':
        return (
          <>
            {opSelect}
            {inlineNotChild && (
              <BoolExprEditor
                value={value.arg}
                schema={schema}
                schemaKeysOrder={schemaKeys}
                depth={depth + 1}
                ariaLabelPrefix={`${ariaLabelPrefix} negated`}
                resetKey={resetKey}
                fieldPath={childPath('.arg')}
                intDraftStore={intDraftStore}
                onDraftErrorChange={onDraftErrorChange}
                inline
                onChange={(arg) => onChange({ op: 'not', arg })}
              />
            )}
          </>
        );
      case 'and':
      case 'or':
        return null;
    }
  };

  if (inline) {
    return (
      <span
        className="rc-expr-node rc-expr-node-inline"
        data-op={value.op}
        data-depth-capped={depth > DEPTH_CAP ? 'true' : undefined}
      >
        {renderRowContent()}
      </span>
    );
  }

  const nodeClass = [
    'rc-expr-node',
    depth === 0 ? 'rc-expr-node-root' : '',
    isGroup ? 'rc-expr-group' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={nodeClass}
      data-op={value.op}
      data-depth={depth}
      data-invalid={nodeErrors.length > 0 ? 'true' : undefined}
      data-depth-capped={depth > DEPTH_CAP ? 'true' : undefined}
    >
      {depth === 0 && showPreview && (
        <code className="rc-expr-preview" aria-label={`${ariaLabelPrefix} preview`}>
          {formatBoolExpr(value)}
        </code>
      )}

      {isGroup ? (
        <div className="rc-expr-row rc-expr-group-head">
          <IconButton
            label={`${collapsed ? 'Expand' : 'Collapse'} ${value.op} group of ${value.args.length}`}
            className="rc-expr-toggle"
            expanded={!collapsed}
            controls={childrenId}
            onClick={() => setCollapsed((prev) => !prev)}
          >
            <ChevronGlyph />
          </IconButton>
          {opSelect}
          {collapsed ? (
            <code className="rc-expr-collapsed-preview">{formatBoolExpr(value)}</code>
          ) : (
            <span className="rc-expr-group-hint">
              {value.op === 'and' ? 'all of' : 'any of'} {value.args.length}
            </span>
          )}
          <button
            type="button"
            className={`${CX.button} rc-expr-add`}
            onClick={() => {
              setCollapsed(false);
              onChange({ op: value.op, args: [...value.args, createDefaultBoolExpr('var', schema)] });
            }}
          >
            + Add clause
          </button>
        </div>
      ) : (
        <div className="rc-expr-row">{renderRowContent()}</div>
      )}

      <NodeDiagnostics errors={nodeErrors} />

      {value.op === 'not' && !inlineNotChild && (
        <div className="rc-expr-children">
          <BoolExprEditor
            value={value.arg}
            schema={schema}
            schemaKeysOrder={schemaKeys}
            depth={depth + 1}
            ariaLabelPrefix={`${ariaLabelPrefix} negated`}
            resetKey={resetKey}
            fieldPath={childPath('.arg')}
            intDraftStore={intDraftStore}
            onDraftErrorChange={onDraftErrorChange}
            diagnostics={diagnostics}
            diagnosticPath={childDiagPath('.arg')}
            onChange={(arg) => onChange({ op: 'not', arg })}
          />
        </div>
      )}

      {isGroup && (
        <ol className="rc-expr-children rc-expr-clauses" id={childrenId} hidden={collapsed}>
          {value.args.map((child, idx) => {
            const clauseId = resolvedClauseRowIds[idx]!;
            const clauseFieldPath = `${clauseListPath}.${clauseId}`;
            return (
              <li key={clauseId} className="rc-expr-clause" data-joiner={value.op}>
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
                  diagnostics={diagnostics}
                  diagnosticPath={childDiagPath(`.args[${idx}]`)}
                  onChange={(nextChild) =>
                    onChange({
                      op: value.op,
                      args: value.args.map((existing, i) => (i === idx ? nextChild : existing)),
                    })
                  }
                />
                {value.args.length > 1 && (
                  <IconButton
                    label={`Remove clause ${idx + 1}`}
                    className="rc-expr-remove rc-expr-clause-remove"
                    onClick={() => {
                      if (fieldPath !== undefined) intDraftStore?.onPruneDrafts(clauseFieldPath);
                      rows.remember(
                        clauseListPath,
                        resolvedClauseRowIds.filter((_, i) => i !== idx),
                      );
                      onChange({ op: value.op, args: value.args.filter((_, i) => i !== idx) });
                    }}
                  >
                    <RemoveGlyph />
                  </IconButton>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
