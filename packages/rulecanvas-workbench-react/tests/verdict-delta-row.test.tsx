import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  verifyModel,
  type BoolExpr,
  type Goal,
  type Invariant,
  type TransitionRule,
  type TransitionSystemModel,
  type VerifyOptions,
} from '@rulecanvas/core';
import { describe, expect, it } from 'vitest';
import { VerdictDeltaRow, type VerdictDeltaSnapshot } from '../src/index.js';

const VAR_X = { op: 'var', name: 'x' } as const;
const OPTIONS: VerifyOptions = { maxStates: 100, maxDepth: 10 };

function boolLit(value: boolean): BoolExpr {
  return { op: 'lit', value };
}

function intLit(value: number): { readonly op: 'lit'; readonly value: number } {
  return { op: 'lit', value };
}

function increment(guard: BoolExpr): TransitionRule {
  return {
    id: 'inc',
    label: 'Increment',
    guard,
    updates: [{ var: 'x', value: { op: 'add', left: VAR_X, right: intLit(1) } }],
  };
}

function atMost(n: number): Invariant {
  return {
    id: 'inv',
    label: `x at most ${n}`,
    holds: { op: 'lte', left: VAR_X, right: intLit(n) },
  };
}

function goalReachable(): Goal {
  return { id: 'goal', label: 'Reach one', reached: { op: 'gte', left: VAR_X, right: intLit(1) } };
}

function goalUnreachable(): Goal {
  return { id: 'goal', label: 'Below zero', reached: { op: 'lt', left: VAR_X, right: intLit(0) } };
}

function model(overrides: {
  readonly rule?: TransitionRule;
  readonly invariant?: Invariant;
  readonly goal?: Goal;
}): TransitionSystemModel {
  return {
    id: 'delta-row-model',
    name: 'Delta row model',
    schema: { x: { kind: 'int', min: 0, max: 2 } },
    initialState: { x: 0 },
    rules: [overrides.rule ?? increment(boolLit(true))],
    invariants: [overrides.invariant ?? atMost(1)],
    ...(overrides.goal !== undefined ? { goal: overrides.goal } : {}),
    assumptions: [
      { id: 'a1', category: 'scope', statement: 'Finite declared model.', notModeled: 'Physical.' },
    ],
  };
}

function snapshot(
  source: TransitionSystemModel,
  options: VerifyOptions = OPTIONS,
): VerdictDeltaSnapshot {
  return { model: source, options, result: verifyModel(source, options) };
}

function render(previous: VerdictDeltaSnapshot | null, current: VerdictDeltaSnapshot | null): string {
  return renderToStaticMarkup(
    createElement(VerdictDeltaRow, {
      previous,
      current,
      isRunning: false,
      isStale: false,
    }),
  );
}

describe('VerdictDeltaRow', () => {
  it('renders contradictory verdicts as an explicit integrity failure', () => {
    const beforeModel = model({
      goal: goalReachable(),
      rule: increment({ op: 'lt', left: VAR_X, right: intLit(2) }),
      invariant: atMost(1),
    });
    const before = snapshot(beforeModel);
    const verifiedModel = model({
      goal: goalReachable(),
      rule: increment({ op: 'lt', left: VAR_X, right: intLit(2) }),
      invariant: atMost(3),
    });
    const verified = verifyModel(verifiedModel, OPTIONS);
    if (verified.status !== 'VERIFIED') throw new Error('Expected a verified fixture.');
    const after: VerdictDeltaSnapshot = {
      model: beforeModel,
      options: OPTIONS,
      result: verified,
    };

    const html = render(before, after);
    expect(html).toContain('data-classification="contradictory"');
    expect(html).toContain('data-tone="error"');
    expect(html).toContain('role="status"');
    expect(html).toContain('Contradictory verdicts for identical semantic inputs');
    expect(html).toContain('integrity failure, not a confirmed repair');
    expect(html).not.toContain('Goal reachable: Yes');
  });

  it('renders a genuine rule-only repair as repaired without an error tone', () => {
    const before = snapshot(
      model({
        rule: increment({ op: 'lt', left: VAR_X, right: intLit(2) }),
        invariant: atMost(1),
      }),
    );
    const after = snapshot(
      model({
        rule: increment({ op: 'lt', left: VAR_X, right: intLit(1) }),
        invariant: atMost(1),
      }),
    );

    const html = render(before, after);
    expect(html).toContain('data-classification="repaired"');
    expect(html).not.toContain('data-tone="error"');
    expect(html).not.toContain('role="status"');
    expect(html).toContain('No goal declared');
  });

  it('renders a vacuous goal lockout without claiming a repair', () => {
    const before = snapshot(
      model({
        goal: goalUnreachable(),
        rule: increment({ op: 'lt', left: VAR_X, right: intLit(2) }),
        invariant: atMost(1),
      }),
    );
    const after = snapshot(
      model({
        goal: goalUnreachable(),
        rule: increment({ op: 'lt', left: VAR_X, right: intLit(1) }),
        invariant: atMost(1),
      }),
    );

    const html = render(before, after);
    expect(html).toContain('data-classification="vacuous-lockout"');
    expect(html).toContain('Goal reachable: No (vacuous)');
    expect(html).not.toContain('data-tone="error"');
  });

  it('renders a spec-change qualification when invariants changed', () => {
    const guarded = increment({ op: 'lt', left: VAR_X, right: intLit(2) });
    const before = snapshot(model({ rule: guarded, invariant: atMost(1) }));
    const after = snapshot(model({ rule: guarded, invariant: atMost(2) }));

    const html = render(before, after);
    expect(html).toContain('data-classification="verified-with-spec-change"');
    expect(html).toContain('data-spec-changed="true"');
    expect(html).toContain('Spec/bounds changed (invariants)');
    expect(html).not.toContain('data-tone="error"');
  });

  it('renders nothing while running, stale, or missing a snapshot', () => {
    const before = snapshot(model({}));
    const after = snapshot(model({ rule: increment({ op: 'lt', left: VAR_X, right: intLit(1) }) }));
    for (const props of [
      { previous: before, current: after, isRunning: true, isStale: false },
      { previous: before, current: after, isRunning: false, isStale: true },
      { previous: null, current: after, isRunning: false, isStale: false },
      { previous: before, current: null, isRunning: false, isStale: false },
    ]) {
      expect(renderToStaticMarkup(createElement(VerdictDeltaRow, props))).toBe('');
    }
  });
});
