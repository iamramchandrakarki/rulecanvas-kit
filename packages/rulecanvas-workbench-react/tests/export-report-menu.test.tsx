import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { verifyModel, type TransitionSystemModel } from '@rulecanvas/core';
import { describe, expect, it } from 'vitest';
import { ExportReportMenu, type ExportReportSnapshot } from '../src/index.js';

const SAMPLE_MODEL: TransitionSystemModel = {
  id: 'sample-gate',
  name: 'Sample Gate',
  schema: { ok: { kind: 'boolean' } },
  initialState: { ok: true },
  rules: [
    {
      id: 'stay_ok',
      label: 'Keep ok true',
      guard: { op: 'var', name: 'ok' },
      updates: [{ var: 'ok', value: { op: 'lit', value: true } }],
    },
  ],
  invariants: [{ id: 'inv_ok', label: 'Must stay ok', holds: { op: 'var', name: 'ok' } }],
  goal: { id: 'goal_ok', label: 'Stay ok', reached: { op: 'var', name: 'ok' } },
  assumptions: [
    {
      id: 'asm_finite',
      category: 'scope',
      statement: 'Discrete state model.',
      notModeled: 'External runtime behavior.',
    },
  ],
};

function createFreshSnapshot(): ExportReportSnapshot {
  const options = { maxStates: 100, maxDepth: 10 };
  return {
    model: SAMPLE_MODEL,
    options,
    result: verifyModel(SAMPLE_MODEL, options),
    executionMode: 'worker',
  };
}

describe('ExportReportMenu', () => {
  it('renders an enabled APG menu button when a fresh committed snapshot exists', () => {
    const html = renderToStaticMarkup(
      createElement(ExportReportMenu, {
        snapshot: createFreshSnapshot(),
        isRunning: false,
        isStale: false,
      }),
    );
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('Export report');
    expect(html).not.toContain('disabled=""');
    expect(html).not.toContain('Run Verify to export current edits.');
  });

  it('disables export with accessible explanation when stale, running, or missing snapshot', () => {
    const fresh = createFreshSnapshot();
    for (const props of [
      { snapshot: null, isRunning: false, isStale: false },
      { snapshot: fresh, isRunning: true, isStale: false },
      { snapshot: fresh, isRunning: false, isStale: true },
    ]) {
      const html = renderToStaticMarkup(createElement(ExportReportMenu, props));
      expect(html).toContain('disabled=""');
      expect(html).toContain('aria-describedby=');
      expect(html).toContain('Run Verify to export current edits.');
      expect(html).not.toContain('role="menu"');
    }
  });
});
