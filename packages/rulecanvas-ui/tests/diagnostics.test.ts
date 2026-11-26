import type { ValidationError } from '@rulecanvas/core';
import { describe, expect, it } from 'vitest';
import {
  getErrorsForPathPrefix,
  indexModelDiagnostics,
  parseStrictIntegerDraft,
} from '../src/index.js';

describe('@rulecanvas/ui diagnostics and strict integer parsing', () => {
  it('parses valid base-10 whole integers and rejects malformed, fractional, exponent, non-ASCII, and unsafe values', () => {
    expect(parseStrictIntegerDraft('0')).toEqual({ ok: true, value: 0 });
    expect(parseStrictIntegerDraft('  -0  ')).toEqual({ ok: true, value: 0 });
    expect(parseStrictIntegerDraft('0042')).toEqual({ ok: true, value: 42 });
    expect(parseStrictIntegerDraft('-0042')).toEqual({ ok: true, value: -42 });
    expect(parseStrictIntegerDraft(String(Number.MAX_SAFE_INTEGER))).toEqual({
      ok: true,
      value: Number.MAX_SAFE_INTEGER,
    });
    expect(parseStrictIntegerDraft(String(Number.MIN_SAFE_INTEGER))).toEqual({
      ok: true,
      value: Number.MIN_SAFE_INTEGER,
    });

    const invalidInputs = [
      '',
      '   ',
      '+5',
      '2.0',
      '2.9',
      '1e3',
      '1E3',
      '0x10',
      '1_000',
      '9007199254740992',
      '-9007199254740992',
      '9'.repeat(1000),
      '١٢٣',
      '１２３',
      'NaN',
      'Infinity',
      '12abc',
    ];
    for (const raw of invalidInputs) {
      expect(parseStrictIntegerDraft(raw).ok, `expected "${raw}" to fail`).toBe(false);
    }
  });

  it('indexes diagnostics into null-prototype byPath without prototype pollution and queries strict path boundaries', () => {
    const errors: ValidationError[] = [
      { code: 'E_PROTO', path: '__proto__', message: 'proto path' },
      { code: 'E_TOSTR', path: 'toString', message: 'toString path' },
      { code: 'E_CTOR', path: 'constructor', message: 'constructor path' },
      { code: 'E_R1_A', path: 'rules[1].guard', message: 'first guard error' },
      { code: 'E_R1_B', path: 'rules[1].guard', message: 'duplicate path error' },
      { code: 'E_R10', path: 'rules[10].guard', message: 'rule 10 error' },
      { code: 'E_SCHEMA', path: 'schema.flag', message: 'schema error' },
      { code: 'E_INIT', path: 'initialState.flag', message: 'init error' },
      { code: 'E_INV', path: 'invariants[0].holds', message: 'inv error' },
      { code: 'E_GOAL', path: 'goal.reached', message: 'goal error' },
      { code: 'E_ASM', path: 'assumptions[0].statement', message: 'asm error' },
      { code: 'E_ROOT', path: '$', message: 'root error' },
    ];

    const index = indexModelDiagnostics(errors);

    expect(Object.getPrototypeOf(index.byPath)).toBeNull();
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(index.byPath['__proto__']).toHaveLength(1);
    expect(index.byPath['toString']).toHaveLength(1);
    expect(index.byPath['constructor']).toHaveLength(1);
    expect(index.byPath['rules[1].guard']).toHaveLength(2);
    expect(index.all.map((e) => e.code)).toEqual(errors.map((e) => e.code));

    expect(index.sections.schema.map((e) => e.code)).toEqual(['E_SCHEMA', 'E_INIT']);
    expect(index.sections.rules.map((e) => e.code)).toEqual(['E_R1_A', 'E_R1_B', 'E_R10']);
    expect(index.sections.invariants.map((e) => e.code)).toEqual(['E_INV']);
    expect(index.sections.goal.map((e) => e.code)).toEqual(['E_GOAL']);
    expect(index.sections.assumptions.map((e) => e.code)).toEqual(['E_ASM']);
    expect(index.sections.general.map((e) => e.code)).toEqual([
      'E_PROTO',
      'E_TOSTR',
      'E_CTOR',
      'E_ROOT',
    ]);

    // Strict dot/bracket boundary prevents rules[1] matching rules[10]
    expect(getErrorsForPathPrefix(index, 'rules[1]').map((e) => e.code)).toEqual([
      'E_R1_A',
      'E_R1_B',
    ]);
    expect(getErrorsForPathPrefix(index, 'rules[10]').map((e) => e.code)).toEqual(['E_R10']);
    expect(getErrorsForPathPrefix(index, 'rules').map((e) => e.code)).toEqual([
      'E_R1_A',
      'E_R1_B',
      'E_R10',
    ]);
  });
});
