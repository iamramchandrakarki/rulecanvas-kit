import type { BoolExpr, TransitionRule, ValueExpr } from '@rulecanvas/core';
import { describe, expect, it } from 'vitest';
import {
  formatBoolExpr,
  formatRuleSummary,
  formatStateValue,
  formatUpdateAssignment,
  formatValueExpr,
  formatVarDef,
} from '../src/index.js';

describe('@rulecanvas/ui formatters', () => {
  describe('formatStateValue', () => {
    it('formats booleans, normalized safe integers, and escaped strings', () => {
      expect(formatStateValue(true)).toBe('true');
      expect(formatStateValue(false)).toBe('false');
      expect(formatStateValue(0)).toBe('0');
      expect(formatStateValue(-0)).toBe('0');
      expect(formatStateValue(42)).toBe('42');
      expect(formatStateValue(-7)).toBe('-7');
      expect(formatStateValue('draft')).toBe('"draft"');
      expect(formatStateValue('line1\n"quoted"\\slash')).toBe('"line1\\n\\"quoted\\"\\\\slash"');
    });
  });

  describe('formatVarDef', () => {
    it('formats boolean, enum, and int variable definitions', () => {
      expect(formatVarDef({ kind: 'boolean' })).toBe('boolean');
      expect(formatVarDef({ kind: 'enum', values: ['a', 'b', 'c'] })).toBe('enum ("a" | "b" | "c")');
      expect(formatVarDef({ kind: 'int', min: 0, max: 3 })).toBe('int [0..3]');
      expect(formatVarDef({ kind: 'int', min: -5, max: -0 })).toBe('int [-5..0]');
    });

    it('quotes enum members unambiguously so pipes and quotes never collide', () => {
      const singlePipe = formatVarDef({ kind: 'enum', values: ['a | b'] });
      const twoMembers = formatVarDef({ kind: 'enum', values: ['a', 'b'] });
      const quotePipe = formatVarDef({ kind: 'enum', values: ['a" | "b'] });

      expect(singlePipe).toBe('enum ("a | b")');
      expect(twoMembers).toBe('enum ("a" | "b")');
      expect(quotePipe).toBe('enum ("a\\" | \\"b")');
      expect(new Set([singlePipe, twoMembers, quotePipe]).size).toBe(3);
    });
  });

  describe('formatValueExpr', () => {
    const v = (name: string): ValueExpr => ({ op: 'var', name });
    const lit = (value: boolean | number | string): ValueExpr => ({ op: 'lit', value });

    it('formats literals and variable references', () => {
      expect(formatValueExpr(lit(-0))).toBe('0');
      expect(formatValueExpr(lit('ready'))).toBe('"ready"');
      expect(formatValueExpr(v('count'))).toBe('count');
    });

    it('applies exact minimal parentheses for add and sub', () => {
      // a - (b + c)
      const subRightAdd: ValueExpr = {
        op: 'sub',
        left: v('a'),
        right: { op: 'add', left: v('b'), right: v('c') },
      };
      expect(formatValueExpr(subRightAdd)).toBe('a - (b + c)');

      // a - (b - c)
      const subRightSub: ValueExpr = {
        op: 'sub',
        left: v('a'),
        right: { op: 'sub', left: v('b'), right: v('c') },
      };
      expect(formatValueExpr(subRightSub)).toBe('a - (b - c)');

      // (a - b) + c -> a - b + c
      const addLeftSub: ValueExpr = {
        op: 'add',
        left: { op: 'sub', left: v('a'), right: v('b') },
        right: v('c'),
      };
      expect(formatValueExpr(addLeftSub)).toBe('a - b + c');

      // (a - b) - c -> a - b - c
      const subLeftSub: ValueExpr = {
        op: 'sub',
        left: { op: 'sub', left: v('a'), right: v('b') },
        right: v('c'),
      };
      expect(formatValueExpr(subLeftSub)).toBe('a - b - c');

      // a + (b - c) -> a + b - c
      const addRightSub: ValueExpr = {
        op: 'add',
        left: v('a'),
        right: { op: 'sub', left: v('b'), right: v('c') },
      };
      expect(formatValueExpr(addRightSub)).toBe('a + b - c');

      // Deep nested right subtraction: a - (b - (c + 1))
      const deepSub: ValueExpr = {
        op: 'sub',
        left: v('a'),
        right: {
          op: 'sub',
          left: v('b'),
          right: { op: 'add', left: v('c'), right: lit(1) },
        },
      };
      expect(formatValueExpr(deepSub)).toBe('a - (b - (c + 1))');
    });
  });

  describe('formatBoolExpr', () => {
    const bv = (name: string): BoolExpr => ({ op: 'var', name });
    const vv = (name: string): ValueExpr => ({ op: 'var', name });
    const vlit = (value: boolean | number | string): ValueExpr => ({ op: 'lit', value });

    it('formats literals, variables, comparisons, and in-membership expressions', () => {
      expect(formatBoolExpr({ op: 'lit', value: true })).toBe('true');
      expect(formatBoolExpr({ op: 'lit', value: false })).toBe('false');
      expect(formatBoolExpr(bv('active'))).toBe('active');
      expect(formatBoolExpr({ op: 'eq', left: vv('x'), right: vlit(1) })).toBe('x == 1');
      expect(formatBoolExpr({ op: 'neq', left: vv('s'), right: vlit('done') })).toBe('s != "done"');
      expect(formatBoolExpr({ op: 'lt', left: vv('x'), right: vv('y') })).toBe('x < y');
      expect(formatBoolExpr({ op: 'lte', left: vv('x'), right: vlit(5) })).toBe('x <= 5');
      expect(formatBoolExpr({ op: 'gt', left: vv('x'), right: vlit(0) })).toBe('x > 0');
      expect(formatBoolExpr({ op: 'gte', left: vv('x'), right: vlit(2) })).toBe('x >= 2');
      expect(
        formatBoolExpr({
          op: 'in',
          expr: vv('stage'),
          values: ['a', 'b'],
        }),
      ).toBe('stage in ["a", "b"]');
      expect(
        formatBoolExpr({
          op: 'in',
          expr: vv('code'),
          values: [-0, 1, 2],
        }),
      ).toBe('code in [0, 1, 2]');
    });

    it('enforces operator precedence: not > comparisons/in > and > or', () => {
      // not over atoms vs compound expressions
      expect(formatBoolExpr({ op: 'not', arg: bv('x') })).toBe('!x');
      expect(formatBoolExpr({ op: 'not', arg: { op: 'lit', value: false } })).toBe('!false');
      expect(formatBoolExpr({ op: 'not', arg: { op: 'not', arg: bv('x') } })).toBe('!!x');
      expect(
        formatBoolExpr({
          op: 'not',
          arg: { op: 'eq', left: vv('a'), right: vv('b') },
        }),
      ).toBe('!(a == b)');
      expect(
        formatBoolExpr({
          op: 'not',
          arg: { op: 'in', expr: vv('x'), values: ['a', 'b'] },
        }),
      ).toBe('!(x in ["a", "b"])');
      expect(
        formatBoolExpr({
          op: 'not',
          arg: { op: 'and', args: [bv('a'), bv('b')] },
        }),
      ).toBe('!(a && b)');
      expect(
        formatBoolExpr({
          op: 'not',
          arg: { op: 'or', args: [bv('a'), bv('b')] },
        }),
      ).toBe('!(a || b)');

      // or inside and requires parentheses
      expect(
        formatBoolExpr({
          op: 'and',
          args: [
            { op: 'or', args: [bv('a'), bv('b')] },
            bv('c'),
          ],
        }),
      ).toBe('(a || b) && c');

      // and inside or does not require parentheses
      expect(
        formatBoolExpr({
          op: 'or',
          args: [
            { op: 'and', args: [bv('a'), bv('b')] },
            bv('c'),
          ],
        }),
      ).toBe('a && b || c');

      // comparisons and not inside and do not require parentheses
      expect(
        formatBoolExpr({
          op: 'and',
          args: [
            { op: 'not', arg: bv('locked') },
            { op: 'eq', left: vv('mode'), right: vlit('ready') },
            { op: 'lt', left: vv('count'), right: vlit(3) },
          ],
        }),
      ).toBe('!locked && mode == "ready" && count < 3');

      // single-argument and/or unwraps cleanly including under not
      expect(
        formatBoolExpr({
          op: 'not',
          arg: { op: 'and', args: [bv('flag')] },
        }),
      ).toBe('!flag');
      expect(formatBoolExpr({ op: 'or', args: [bv('solo')] })).toBe('solo');
    });
  });

  describe('formatUpdateAssignment and formatRuleSummary', () => {
    it('formats update assignments and returns a frozen rule summary', () => {
      const rule: TransitionRule = {
        id: 'advance_step',
        label: 'Advance counter step',
        guard: {
          op: 'and',
          args: [
            { op: 'not', arg: { op: 'var', name: 'halted' } },
            { op: 'lt', left: { op: 'var', name: 'count' }, right: { op: 'lit', value: 3 } },
          ],
        },
        updates: [
          {
            var: 'count',
            value: { op: 'add', left: { op: 'var', name: 'count' }, right: { op: 'lit', value: 1 } },
          },
          {
            var: 'phase',
            value: { op: 'lit', value: 'active' },
          },
        ],
      };

      expect(formatUpdateAssignment(rule.updates[0]!)).toBe('count := count + 1');
      expect(formatUpdateAssignment(rule.updates[1]!)).toBe('phase := "active"');

      const summary = formatRuleSummary(rule);
      expect(summary).toEqual({
        id: 'advance_step',
        label: 'Advance counter step',
        guardText: '!halted && count < 3',
        updatesText: ['count := count + 1', 'phase := "active"'],
      });
      expect(Object.isFrozen(summary)).toBe(true);
      expect(Object.isFrozen(summary.updatesText)).toBe(true);
    });

    it('never throws on malformed, cyclic, or Proxy-trapped inputs', () => {
      let getterCalled = false;
      const accessorExpr = Object.defineProperty({}, 'op', {
        enumerable: true,
        get() {
          getterCalled = true;
          return 'var';
        },
      });
      const throwingProxy = new Proxy(
        {},
        {
          getOwnPropertyDescriptor() {
            throw new Error('trap exploded');
          },
          getPrototypeOf() {
            throw new Error('proto trap exploded');
          },
        },
      );

      expect(formatStateValue({} as never)).toBe('<invalid>');
      expect(formatStateValue(1.5 as never)).toBe('<invalid>');
      expect(formatStateValue(Number.NaN as never)).toBe('<invalid>');
      expect(formatVarDef({ kind: 'int', min: 5, max: 1 })).toBe('<invalid>');
      expect(formatVarDef(null as never)).toBe('<invalid>');
      expect(formatVarDef(throwingProxy as never)).toBe('<invalid>');
      expect(formatBoolExpr({ op: 'not', arg: { op: 'and', args: [] } })).toBe('!true');
      expect(formatBoolExpr({ op: 'not', arg: { op: 'or', args: [] } })).toBe('!false');
      expect(formatValueExpr(accessorExpr as never)).toBe('<invalid>');
      expect(formatValueExpr(throwingProxy as never)).toBe('<invalid>');
      expect(formatBoolExpr(accessorExpr as never)).toBe('<invalid>');
      expect(formatBoolExpr(throwingProxy as never)).toBe('<invalid>');
      expect(formatUpdateAssignment(throwingProxy as never)).toBe('<invalid>');
      expect(
        formatRuleSummary({
          id: 'r1',
          label: 'Rule 1',
          guard: { op: 'lit', value: true },
          updates: null as never,
        }),
      ).toEqual({
        id: '<invalid>',
        label: '<invalid>',
        guardText: '<invalid>',
        updatesText: [],
      });
      const badSummary = formatRuleSummary(throwingProxy as never);
      expect(badSummary).toEqual({
        id: '<invalid>',
        label: '<invalid>',
        guardText: '<invalid>',
        updatesText: [],
      });
      expect(Object.isFrozen(badSummary)).toBe(true);
      expect(getterCalled).toBe(false);
    });

    it('quotes reserved keyword and non-identifier variable names unambiguously across expressions and updates', () => {
      // Variable named "true" must not collide with boolean literal true
      expect(formatBoolExpr({ op: 'var', name: 'true' })).toBe('`true`');
      expect(formatBoolExpr({ op: 'lit', value: true })).toBe('true');
      expect(formatValueExpr({ op: 'var', name: 'true' })).toBe('`true`');
      expect(formatValueExpr({ op: 'lit', value: true })).toBe('true');

      const trickyNames = [
        'true',
        'false',
        'in',
        'and',
        'or',
        'not',
        '0',
        'a + b',
        'x == 1',
        'a`b',
        'a\\`b',
        '',
      ];

      const valueOutputs = trickyNames.map((name) => formatValueExpr({ op: 'var', name }));
      const boolOutputs = trickyNames.map((name) => formatBoolExpr({ op: 'var', name }));
      const updateOutputs = trickyNames.map((name) =>
        formatUpdateAssignment({ var: name, value: { op: 'lit', value: 1 } }),
      );

      for (const out of valueOutputs) {
        expect(out.startsWith('`') && out.endsWith('`')).toBe(true);
      }
      expect(boolOutputs).toEqual(valueOutputs);
      expect(new Set(valueOutputs).size).toBe(trickyNames.length);
      expect(new Set(boolOutputs).size).toBe(trickyNames.length);
      expect(new Set(updateOutputs).size).toBe(trickyNames.length);
      expect(formatUpdateAssignment({ var: 'a + b', value: { op: 'var', name: 'true' } })).toBe(
        '`a + b` := `true`',
      );
    });
  });
});
