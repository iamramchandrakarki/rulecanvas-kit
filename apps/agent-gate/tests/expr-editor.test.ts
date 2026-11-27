import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BoolExpr, StateSchema, ValidationError } from '@rulecanvas/core';
import { formatBoolExpr } from '@rulecanvas/ui';
import { describe, expect, it } from 'vitest';
import {
  BoolExprEditor,
  isSingleRowBoolExpr,
  operandKindOf,
  selectDiagnosticsUnder,
} from '../src/components/ExprEditor.js';
import { breakIdentifier } from '../src/components/PolicyEditorPane.js';

const schema: StateSchema = {
  stage: { kind: 'enum', values: ['idle', 'drafting', 'published'] },
  approvalValid: { kind: 'boolean' },
  modifiedSinceApproval: { kind: 'boolean' },
  revision: { kind: 'int', min: 0, max: 3 },
};

const nestedGuard: BoolExpr = {
  op: 'and',
  args: [
    { op: 'eq', left: { op: 'var', name: 'stage' }, right: { op: 'lit', value: 'drafting' } },
    {
      op: 'or',
      args: [
        { op: 'var', name: 'approvalValid' },
        { op: 'gte', left: { op: 'var', name: 'revision' }, right: { op: 'lit', value: 2 } },
      ],
    },
    { op: 'not', arg: { op: 'var', name: 'modifiedSinceApproval' } },
  ],
};

const render = (value: BoolExpr, extra: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    createElement(BoolExprEditor, {
      value,
      schema,
      ariaLabelPrefix: 'Guard',
      fieldPath: 'rule:r1.guard',
      onChange: () => {},
      ...extra,
    }),
  );

describe('compact AST editor', () => {
  it('renders every AST node of a nested guard with stable accessible names', () => {
    const html = render(nestedGuard);
    for (const label of [
      'Guard operator',
      'Guard clause 1 operator',
      'Guard clause 1 left variable',
      'Guard clause 1 right string literal',
      'Guard clause 2 operator',
      'Guard clause 2 clause 1 boolean variable',
      'Guard clause 2 clause 2 left variable',
      'Guard clause 2 clause 2 right integer literal',
      'Guard clause 3 operator',
      'Guard clause 3 negated boolean variable',
    ]) {
      expect(html).toContain(`aria-label="${label}"`);
    }
    expect(html).toContain('aria-label="Remove clause 3"');
    expect(html).toContain('+ Add clause');
  });

  it('renders comparisons infix: left operand, operator, right operand', () => {
    const html = render(nestedGuard.op === 'and' ? nestedGuard.args[0]! : nestedGuard);
    const left = html.indexOf('aria-label="Guard left variable"');
    const op = html.indexOf('aria-label="Guard operator"');
    const right = html.indexOf('aria-label="Guard right string literal"');
    expect(left).toBeGreaterThan(-1);
    expect(left).toBeLessThan(op);
    expect(op).toBeLessThan(right);
  });

  it('offers collapsible and/or groups whose toggle reports expansion state', () => {
    const html = render(nestedGuard);
    expect(html).toMatch(/aria-label="Collapse and group of 3"[^>]*aria-expanded="true"/);
    expect(html).toMatch(/aria-label="Collapse or group of 2"[^>]*aria-expanded="true"/);
    expect(html).toContain('all of 3');
    expect(html).toContain('any of 2');
  });

  it('previews the exact formatted expression at the root unless disabled', () => {
    const previewed = render(nestedGuard);
    const escaped = formatBoolExpr(nestedGuard)
      .replaceAll('&', '&amp;')
      .replaceAll('"', '&quot;')
      .replaceAll('>', '&gt;');
    expect(previewed).toContain(escaped);
    expect(render(nestedGuard, { showPreview: false })).not.toContain('rc-expr-preview');
  });

  it('keeps `not` over a leaf on one row and nests `not` over a group', () => {
    expect(isSingleRowBoolExpr({ op: 'var', name: 'approvalValid' })).toBe(true);
    expect(isSingleRowBoolExpr({ op: 'not', arg: { op: 'var', name: 'approvalValid' } })).toBe(false);
    const leafNot = render({ op: 'not', arg: { op: 'var', name: 'approvalValid' } });
    expect(leafNot).toContain('rc-expr-node-inline');
    const groupNot = render({ op: 'not', arg: { op: 'or', args: [{ op: 'lit', value: true }] } });
    expect(groupNot).not.toContain('rc-expr-node-inline');
    expect(groupNot).toContain('rc-expr-children');
  });

  it('maps operand kinds one-to-one onto the core ValueExpr shape', () => {
    expect(operandKindOf({ op: 'var', name: 'stage' })).toBe('var');
    expect(operandKindOf({ op: 'lit', value: 'x' })).toBe('lit:string');
    expect(operandKindOf({ op: 'lit', value: 3 })).toBe('lit:number');
    expect(operandKindOf({ op: 'lit', value: false })).toBe('lit:boolean');
    expect(
      operandKindOf({ op: 'add', left: { op: 'lit', value: 1 }, right: { op: 'var', name: 'revision' } }),
    ).toBe('add');
    expect(
      operandKindOf({ op: 'sub', left: { op: 'lit', value: 1 }, right: { op: 'lit', value: 1 } }),
    ).toBe('sub');
  });

  it('attaches validation errors to the clause that owns them', () => {
    const errors: ValidationError[] = [
      { code: 'INVALID_ENUM_LITERAL', path: 'rules[0].guard.args[0].right.value', message: 'Unknown stage' },
      { code: 'TYPE_MISMATCH', path: 'rules[1].guard', message: 'Other rule' },
    ];
    expect(selectDiagnosticsUnder(errors, 'rules[0].guard.args[0]')).toHaveLength(1);
    expect(selectDiagnosticsUnder(errors, 'rules[0].guard.args[1]')).toHaveLength(0);
    expect(selectDiagnosticsUnder(errors, 'rules[1].guard')).toHaveLength(1);
    expect(selectDiagnosticsUnder(errors, 'rules[1].guard.args[0]')).toHaveLength(0);

    const html = render(nestedGuard, { diagnostics: errors, diagnosticPath: 'rules[0].guard' });
    expect((html.match(/data-invalid="true"/g) ?? []).length).toBe(1);
    expect(html).toContain('Unknown stage');
    expect(html).not.toContain('Other rule');
  });
});

describe('rule identifier wrapping', () => {
  it('inserts word-break opportunities at snake_case and camelCase boundaries', () => {
    const html = renderToStaticMarkup(createElement('span', null, ...breakIdentifier('publish_release_notes')));
    expect(html).toBe('<span>publish_<wbr/>release_<wbr/>notes</span>');
    const camel = renderToStaticMarkup(createElement('span', null, ...breakIdentifier('modifiedSinceApproval')));
    expect(camel).toBe('<span>modified<wbr/>Since<wbr/>Approval</span>');
    expect(breakIdentifier('plain')).toEqual(['plain']);
  });
});
