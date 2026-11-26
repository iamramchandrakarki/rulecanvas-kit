import type { BoolExpr, TransitionSystemModel } from '@rulecanvas/core';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MODEL_JSON_LIMITS,
  HARD_CEILING_MODEL_JSON_LIMITS,
  createModelJsonCodec,
} from '../src/model-json.js';

const sampleModel: TransitionSystemModel = {
  id: 'booking-demo',
  name: 'Booking Demo',
  schema: {
    seats: { kind: 'int', min: 0, max: 3 },
    held: { kind: 'boolean' },
    status: { kind: 'enum', values: ['open', 'closed'] },
  },
  initialState: { seats: 0, held: false, status: 'open' },
  rules: [
    {
      id: 'reserve',
      label: 'Reserve seat',
      guard: { op: 'lt', left: { op: 'var', name: 'seats' }, right: { op: 'lit', value: 3 } },
      updates: [
        {
          var: 'seats',
          value: { op: 'add', left: { op: 'var', name: 'seats' }, right: { op: 'lit', value: 1 } },
        },
        { var: 'held', value: { op: 'lit', value: true } },
      ],
    },
  ],
  invariants: [
    {
      id: 'inv_cap',
      label: 'Within seat cap',
      holds: { op: 'lte', left: { op: 'var', name: 'seats' }, right: { op: 'lit', value: 3 } },
    },
  ],
  goal: {
    id: 'goal_held',
    label: 'Seat held',
    reached: { op: 'var', name: 'held' },
  },
  assumptions: [
    { id: 'asm_1', category: 'scope', statement: 'Single-threaded reservations.', notModeled: 'Network retries.' },
  ],
};

describe('@rulecanvas/workbench strict portable model JSON codec', () => {
  it('enforces limit ceilings and rejects invalid configuration', () => {
    expect(DEFAULT_MODEL_JSON_LIMITS.maxChars).toBe(512_000);
    expect(HARD_CEILING_MODEL_JSON_LIMITS.maxChars).toBe(2_000_000);
    expect(() => createModelJsonCodec({ maxChars: 0 })).toThrow(RangeError);
    expect(() => createModelJsonCodec({ maxChars: 2_000_001 })).toThrow(RangeError);
    expect(() => createModelJsonCodec({ maxVisits: 50_001 })).toThrow(RangeError);
    expect(() => createModelJsonCodec({ maxDepth: 65 })).toThrow(RangeError);
    expect(() => createModelJsonCodec({ maxRawNesting: 257 })).toThrow(RangeError);
  });

  it('rejects duplicate decoded keys and non-integer/unsafe numbers before JSON.parse with exact precedence', () => {
    const codec = createModelJsonCodec();
    const parseSpy = vi.spyOn(JSON, 'parse');

    // Escaped duplicate key + non-integer number -> prioritizes DUPLICATE_JSON_KEY with 0 JSON.parse calls
    const dupAndDecimal = '{"id":"a","\\u0069d":"b","x":1.0}';
    const res1 = codec.decode(dupAndDecimal);
    expect(res1.ok).toBe(false);
    if (!res1.ok) {
      expect(res1.errors[0]?.code).toBe('DUPLICATE_JSON_KEY');
    }
    expect(parseSpy).not.toHaveBeenCalled();

    // Integral decimal/exponent spellings 1.0 and 1e0 rejected before JSON.parse
    for (const raw of ['{"x":1.0}', '{"x":1e0}', '{"x":9007199254740992}']) {
      const res = codec.decode(raw);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(['NON_INTEGER_JSON_NUMBER', 'UNSAFE_INTEGER_JSON_NUMBER']).toContain(
          res.errors[0]?.code,
        );
      }
    }
    expect(parseSpy).not.toHaveBeenCalled();

    // Malformed syntax with decimal reports JSON_PARSE_ERROR
    const broken = '{"x": 1.5, ';
    const resBroken = codec.decode(broken);
    expect(resBroken.ok).toBe(false);
    if (!resBroken.ok) {
      expect(resBroken.errors[0]?.code).toBe('JSON_PARSE_ERROR');
    }

    // Valid JSON nested 257 levels returns IMPORT_COMPLEXITY_EXCEEDED
    const deep257 = `${'['.repeat(257)}${']'.repeat(257)}`;
    const resDeep = codec.decode(deep257);
    expect(resDeep.ok).toBe(false);
    if (!resDeep.ok) {
      expect(resDeep.errors[0]?.code).toBe('IMPORT_COMPLEXITY_EXCEEDED');
    }

    parseSpy.mockRestore();
  });

  it('round-trips valid models, falls back to compact JSON, enforces identical encode/decode budgets, and rejects hostile descriptors', () => {
    const codec = createModelJsonCodec();
    const encoded = codec.encode(sampleModel);
    expect(encoded.ok).toBe(true);
    if (encoded.ok) {
      const decoded = codec.decode(encoded.text);
      expect(decoded.ok).toBe(true);
      if (decoded.ok) {
        expect(decoded.model).toEqual(sampleModel);
        expect(Object.keys(decoded.model.schema)).toEqual(['seats', 'held', 'status']);
      }
    }

    // Non-enumerable array element rejected symmetrically on validateValue and encode
    const rulesWithNonEnum = [...sampleModel.rules];
    Object.defineProperty(rulesWithNonEnum, 0, {
      value: sampleModel.rules[0],
      enumerable: false,
      configurable: true,
      writable: true,
    });
    const nonEnumModel = { ...sampleModel, rules: rulesWithNonEnum };
    expect(codec.validateValue(nonEnumModel).ok).toBe(false);
    expect(codec.encode(nonEnumModel).ok).toBe(false);

    // Cyclic reference rejected without stack overflow
    const cyclic: Record<string, unknown> = { ...sampleModel };
    cyclic['goal'] = cyclic;
    expect(codec.validateValue(cyclic).ok).toBe(false);
    expect(codec.encode(cyclic).ok).toBe(false);

    // Budget parity: high-visit model rejected at encode so no successful encode fails decode
    const sixtyTrue: BoolExpr[] = Array.from({ length: 60 }, () => ({ op: 'lit', value: true }));
    const overVisitModel: TransitionSystemModel = {
      ...sampleModel,
      rules: Array.from({ length: 60 }, (_, idx) => ({
        id: `r_${idx}`,
        label: `Rule ${idx}`,
        guard: { op: 'and', args: sixtyTrue },
        updates: [{ var: 'held', value: { op: 'lit', value: true } }],
      })),
    };
    expect(codec.encode(overVisitModel).ok).toBe(false);
    expect(codec.validateValue(overVisitModel).ok).toBe(false);

    // Pretty-to-compact fallback when pretty > 512_000 and compact <= 512_000
    const compactModel: TransitionSystemModel = {
      ...sampleModel,
      assumptions: [
        {
          id: 'asm_1',
          category: 'scope',
          statement: 'A'.repeat(511_000),
          notModeled: 'Timing.',
        },
      ],
    };
    const compactEnc = codec.encode(compactModel);
    expect(compactEnc.ok).toBe(true);
    if (compactEnc.ok) {
      expect(compactEnc.text.length).toBeLessThanOrEqual(512_000);
      expect(codec.decode(compactEnc.text).ok).toBe(true);
    }
  });
});
