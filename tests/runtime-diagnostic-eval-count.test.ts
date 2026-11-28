import type {
  TransitionRule,
  TransitionSystemModel,
  UpdateAssignment,
  VerifyOptions,
} from '../packages/rulecanvas-core/src/index.ts';
import { describe, expect, it, vi } from 'vitest';

const { stepModelSpy } = vi.hoisted(() => ({
  stepModelSpy: vi.fn(),
}));

vi.mock('../packages/rulecanvas-core/dist/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../packages/rulecanvas-core/src/index.ts')>();
  stepModelSpy.mockImplementation(actual.stepModel);
  return {
    ...actual,
    stepModel: stepModelSpy,
  };
});

import { verifyModel } from '../packages/rulecanvas-core/src/index.ts';
import { buildVerificationReportFromSnapshot } from '../packages/rulecanvas-ui/src/index.ts';
import { sanitizeAndFreezeVerifyResult } from '../packages/rulecanvas-workbench/src/verify.ts';

const DEFAULT_OPTIONS: VerifyOptions = {
  maxStates: 64,
  maxDepth: 16,
};

function buildMultiRuleOutOfDomainModel(
  ruleCount: number,
  faultRuleIndex: number,
  updatesPerFiller = 8,
): TransitionSystemModel {
  const varNames = Array.from({ length: updatesPerFiller }, (_, index) => `x${index}`);
  const schema = Object.fromEntries(
    varNames.map((name) => [name, { kind: 'int' as const, min: 0, max: 10 }]),
  );
  const initialState = Object.fromEntries(varNames.map((name) => [name, 0]));

  const rules: TransitionRule[] = Array.from({ length: ruleCount }, (_, index) => {
    if (index === faultRuleIndex) {
      return {
        id: `fault_${index}`,
        label: `Fault rule ${index}`,
        guard: { op: 'lit', value: true },
        updates: [
          {
            var: 'x0',
            value: {
              op: 'add',
              left: { op: 'var', name: 'x0' },
              right: { op: 'lit', value: 20 },
            },
          },
        ],
      };
    }

    const fillerUpdates: UpdateAssignment[] = varNames.map((name) => ({
      var: name,
      value: {
        op: 'add',
        left: { op: 'var', name },
        right: { op: 'lit', value: 1 },
      },
    }));

    return {
      id: `filler_${index}`,
      label: `Filler rule ${index}`,
      guard: { op: 'lit', value: false },
      updates: fillerUpdates,
    };
  });

  return {
    id: `runtime_eval_count_${ruleCount}_${faultRuleIndex}`,
    name: `Runtime Eval Count (${ruleCount} rules, fault at ${faultRuleIndex})`,
    schema,
    initialState,
    rules,
    invariants: [
      {
        id: 'inv_non_negative',
        label: 'x0 stays within domain',
        holds: { op: 'gte', left: { op: 'var', name: 'x0' }, right: { op: 'lit', value: 0 } },
      },
    ],
    assumptions: [
      {
        id: 'asm_bounded',
        category: 'domain',
        statement: 'Variables stay within declared bounds unless a rule faults.',
        notModeled: 'External overrides outside declared rules.',
      },
    ],
  };
}

describe('runtime diagnostic validator evaluation count', () => {
  it('stops on rule 0 when validating a 256-rule early-match model', () => {
    const model = buildMultiRuleOutOfDomainModel(256, 0, 8);
    const verified = verifyModel(model, DEFAULT_OPTIONS);
    expect(verified.status).toBe('INVALID');

    stepModelSpy.mockClear();
    const reportOutcome = buildVerificationReportFromSnapshot({
      model,
      options: DEFAULT_OPTIONS,
      result: verified,
    });
    expect(reportOutcome.ok).toBe(true);
    expect(stepModelSpy).toHaveBeenCalledTimes(1);

    stepModelSpy.mockClear();
    const workerOutcome = sanitizeAndFreezeVerifyResult(verified, model, DEFAULT_OPTIONS);
    expect(workerOutcome.ok).toBe(true);
    expect(stepModelSpy).toHaveBeenCalledTimes(1);
  });

  it('stops on rule 0 across 100 duplicate genuine diagnostics in a 32-rule model', () => {
    const model = buildMultiRuleOutOfDomainModel(32, 0, 8);
    const verified = verifyModel(model, DEFAULT_OPTIONS);
    expect(verified.status).toBe('INVALID');
    if (verified.status !== 'INVALID') {
      return;
    }

    const duplicated = {
      ...verified,
      errors: Array.from({ length: 100 }, () => ({ ...verified.errors[0]! })),
    };

    stepModelSpy.mockClear();
    const reportOutcome = buildVerificationReportFromSnapshot({
      model,
      options: DEFAULT_OPTIONS,
      result: duplicated,
    });
    expect(reportOutcome.ok).toBe(true);
    expect(stepModelSpy).toHaveBeenCalledTimes(1);

    stepModelSpy.mockClear();
    const workerOutcome = sanitizeAndFreezeVerifyResult(duplicated, model, DEFAULT_OPTIONS);
    expect(workerOutcome.ok).toBe(true);
    expect(stepModelSpy).toHaveBeenCalledTimes(1);
  });

  it('evaluates each rule at most once across 100 duplicate genuine diagnostics when fault is last', () => {
    const model = buildMultiRuleOutOfDomainModel(32, 31, 8);
    const verified = verifyModel(model, DEFAULT_OPTIONS);
    expect(verified.status).toBe('INVALID');
    if (verified.status !== 'INVALID') {
      return;
    }

    const duplicated = {
      ...verified,
      errors: Array.from({ length: 100 }, () => ({ ...verified.errors[0]! })),
    };

    stepModelSpy.mockClear();
    const reportOutcome = buildVerificationReportFromSnapshot({
      model,
      options: DEFAULT_OPTIONS,
      result: duplicated,
    });
    expect(reportOutcome.ok).toBe(true);
    expect(stepModelSpy).toHaveBeenCalledTimes(32);

    stepModelSpy.mockClear();
    const workerOutcome = sanitizeAndFreezeVerifyResult(duplicated, model, DEFAULT_OPTIONS);
    expect(workerOutcome.ok).toBe(true);
    expect(stepModelSpy).toHaveBeenCalledTimes(32);
  });

  it('evaluates each rule once and rejects a forged trailing runtime diagnostic', () => {
    const model = buildMultiRuleOutOfDomainModel(32, 0, 8);
    const verified = verifyModel(model, DEFAULT_OPTIONS);
    expect(verified.status).toBe('INVALID');
    if (verified.status !== 'INVALID') {
      return;
    }

    const firstError = verified.errors[0]!;
    const tampered = {
      ...verified,
      errors: [
        ...Array.from({ length: 100 }, () => ({ ...firstError })),
        {
          code: 'OUT_OF_DOMAIN_TRANSITION',
          path: firstError.path,
          message: 'Forged runtime diagnostic not reproduced by any rule',
        },
      ],
    };

    stepModelSpy.mockClear();
    const reportOutcome = buildVerificationReportFromSnapshot({
      model,
      options: DEFAULT_OPTIONS,
      result: tampered,
    });
    expect(reportOutcome.ok).toBe(false);
    expect(stepModelSpy).toHaveBeenCalledTimes(32);

    stepModelSpy.mockClear();
    const workerOutcome = sanitizeAndFreezeVerifyResult(tampered, model, DEFAULT_OPTIONS);
    expect(workerOutcome.ok).toBe(false);
    expect(stepModelSpy).toHaveBeenCalledTimes(32);
  });
});
