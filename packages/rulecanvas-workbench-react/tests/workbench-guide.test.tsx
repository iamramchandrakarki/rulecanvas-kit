import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { WorkbenchGuideControl, type WorkbenchGuideControlProps } from '../src/index.js';

const render = (overrides: Partial<WorkbenchGuideControlProps> = {}) =>
  renderToStaticMarkup(
    createElement(WorkbenchGuideControl, {
      appTitle: 'AgentGate',
      appSummary: 'Verify agent policy transitions against safety invariants.',
      visuallyHiddenClassName: 'sr-only',
      ...overrides,
    }),
  );

describe('WorkbenchGuideControl', () => {
  it('renders a collapsed guide trigger with full accessible name and hidden region by default', () => {
    const html = render();
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('Guide');
    expect(html).toContain('<span class="sr-only"> and glossary</span>');
    expect(html).toMatch(/role="region"[^>]*hidden=""/);
  });

  it('includes the 4-step workflow and all 7 core formal verification terms', () => {
    const html = render();
    for (const term of [
      'Invariant',
      'Guard',
      'Counterexample',
      'Reachable state',
      'Transition',
      'Verification bounds',
      'Vacuous verification',
    ]) {
      expect(html).toContain(`<dt>${term}</dt>`);
    }
    expect(html).toContain('Choose a scenario');
    expect(html).toContain('Run Verify');
    expect(html).toContain('Inspect evidence');
    expect(html).toContain('Stage &amp; re-verify');
  });
});
