import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { VerificationBoundsControl, type VerificationBoundsControlProps } from '../src/index.js';

const render = (overrides: Partial<VerificationBoundsControlProps> = {}) =>
  renderToStaticMarkup(
    createElement(VerificationBoundsControl, {
      maxStatesText: '10000',
      maxDepthText: '50',
      onEdit: () => {},
      visuallyHiddenClassName: 'sr-only',
      ...overrides,
    }),
  );

describe('VerificationBoundsControl', () => {
  it('keeps current bound values visible on the closed trigger and in its accessible name', () => {
    const html = render();
    expect(html).toContain('aria-expanded="false"');
    expect(html).toMatch(/<span data-bounds-summary="true">10000 \/ 50<\/span>/);
    expect(html).toContain('<span class="sr-only"> (maxStates / maxDepth)</span>');
    // No aria-label override, so the visible text stays part of the accessible name.
    expect(html).not.toMatch(/<button[^>]*aria-label=/);
  });

  it('renders labelled inputs with the stable ids hosts and tests rely on, hidden while closed', () => {
    const html = render();
    expect(html).toMatch(/role="group" aria-label="Verification bounds" hidden=""/);
    expect(html).toContain('<label for="max-states-input">maxStates</label>');
    expect(html).toContain('<label for="max-depth-input">maxDepth</label>');
    expect(html).toContain('id="max-states-input" type="text" inputMode="numeric"');
    expect(html).toContain('id="max-depth-input" type="text" inputMode="numeric"');
  });

  it('forces the panel open and flags the trigger when either draft is invalid', () => {
    const html = render({ maxDepthText: '-1', maxDepthInvalid: true });
    expect(html).toContain('data-invalid="true"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).not.toMatch(/aria-label="Verification bounds" hidden=""/);
    expect(html).toMatch(/id="max-depth-input"[^>]*aria-invalid="true"/);
    expect(html).toContain('(maxStates / maxDepth, invalid)');
  });

  it('honours custom input ids', () => {
    const html = render({ maxStatesInputId: 'states', maxDepthInputId: 'depth' });
    expect(html).toContain('<label for="states">maxStates</label>');
    expect(html).toContain('id="depth" type="text"');
  });
});
