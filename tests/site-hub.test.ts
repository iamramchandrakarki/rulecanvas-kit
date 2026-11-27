import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
// The repository root has no @rulecanvas/core dependency, so import the engine source directly.
import { verifyModel } from '../packages/rulecanvas-core/src/index.ts';
import { describe, expect, it } from 'vitest';
import { loadPresetModel } from '../apps/agent-gate/src/presets.ts';
import { loadInterlockPresetModel } from '../apps/interlock-sim/src/presets.ts';

const repoRoot = path.resolve(import.meta.dirname, '..');
const siteDir = path.join(repoRoot, 'site');
const html = readFileSync(path.join(siteDir, 'index.html'), 'utf8');
const OPTIONS = { maxStates: 100_000, maxDepth: 64 } as const;

type AppId = 'agent-gate' | 'interlock-sim';

const loaders: Record<AppId, (preset: string) => ReturnType<typeof loadPresetModel>> = {
  'agent-gate': (preset) => loadPresetModel(preset as Parameters<typeof loadPresetModel>[0]),
  'interlock-sim': (preset) =>
    loadInterlockPresetModel(preset as Parameters<typeof loadInterlockPresetModel>[0]),
};

function panel(app: AppId): string {
  const start = html.indexOf(`<article class="panel" data-app="${app}"`);
  expect(start, `panel for ${app}`).toBeGreaterThan(-1);
  const end = html.indexOf('</article>', start);
  return html.slice(start, end);
}

function attr(tag: string, name: string): string | null {
  const match = new RegExp(`${name}="([^"]*)"`).exec(tag);
  return match === null ? null : match[1]!;
}

describe('site hub', () => {
  it('uses only relative preset links for both workbenches', () => {
    const hrefs = [...html.matchAll(/href="(\.\/(?:agent-gate|interlock-sim)\/[^"]*)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual([
      './agent-gate/?preset=broken',
      './agent-gate/?preset=vacuous-fix',
      './agent-gate/?preset=principled-fix',
      './interlock-sim/?preset=broken',
      './interlock-sim/?preset=vacuous',
      './interlock-sim/?preset=fixed',
    ]);
  });

  for (const app of ['agent-gate', 'interlock-sim'] as const) {
    it(`states verdicts for ${app} that match verifyModel`, () => {
      const block = panel(app);
      const links = [...block.matchAll(/<a\s[^>]*data-preset="[^"]*"[^>]*>/g)].map((m) => m[0]);
      expect(links).toHaveLength(3);
      for (const tag of links) {
        const preset = attr(tag, 'data-preset')!;
        const result = verifyModel(loaders[app](preset), OPTIONS);
        expect(result.status, `${app} ${preset}`).toBe(attr(tag, 'data-expected-status'));
        const expectedGoal = attr(tag, 'data-expected-goal');
        if (expectedGoal !== null) {
          expect(result.goalReachable === true, `${app} ${preset} goal`).toBe(expectedGoal === 'true');
        }
      }

      const broken = verifyModel(loaders[app]('broken'), OPTIONS);
      expect(broken.status).toBe('VIOLATED');
      if (broken.status !== 'VIOLATED') return;
      const railRules = [...block.matchAll(/<code class="rail-rule">([^<]+)<\/code>/g)].map((m) => m[1]);
      expect(railRules).toEqual(broken.trace.map((step) => step.ruleId));
      expect(block).toContain(`${broken.trace.length} steps`);
      expect(attr(block, 'data-violated')).toBe(broken.violatedInvariantIds.join(' '));
      expect(block).toContain(`<code class="rail-invariant">${broken.violatedInvariantIds[0]}</code>`);
    });
  }

  it('applies the stored theme through a strict allowlist without DOM interpolation', () => {
    const head = html.slice(0, html.indexOf('</head>'));
    const inline = /<script>([\s\S]*?)<\/script>/.exec(head);
    expect(inline).not.toBeNull();
    const script = inline![1]!;
    expect(script).toContain("localStorage.getItem('rulecanvas-theme')");
    expect(script).toContain("raw === 'light' || raw === 'dark' || raw === 'system' ? raw : 'system'");
    expect(script).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|setAttribute\([^,]+,\s*raw\)/);
    // The blocking script must come before any stylesheet so the first paint uses the right theme.
    expect(head.indexOf('<script>')).toBeLessThan(head.indexOf('rel="stylesheet"'));
  });

  it('keeps tokens and fonts identical to the workbench apps', () => {
    const appStyles = path.join(repoRoot, 'apps/agent-gate/src/styles');
    expect(readFileSync(path.join(siteDir, 'tokens.css'), 'utf8')).toBe(
      readFileSync(path.join(appStyles, 'tokens.css'), 'utf8'),
    );
    const appFonts = readdirSync(path.join(appStyles, 'fonts')).sort();
    expect(readdirSync(path.join(siteDir, 'fonts')).sort()).toEqual(appFonts);
    for (const font of appFonts) {
      expect(readFileSync(path.join(siteDir, 'fonts', font)).equals(readFileSync(path.join(appStyles, 'fonts', font))), font).toBe(true);
    }
  });

  it('does not advertise Spec 2 features before they ship', () => {
    for (const file of ['index.html', 'styles.css', 'hub.js']) {
      const text = readFileSync(path.join(siteDir, file), 'utf8').toLowerCase();
      for (const term of ['check:model', 'check-model', 'report export', 'export report', 'delta.ts', 'report.ts']) {
        expect(text, `${file} mentions ${term}`).not.toContain(term);
      }
    }
  });

  it('links GitHub with rel="noopener noreferrer" and discloses scope and non-certification', () => {
    const externals = [...html.matchAll(/<a\s[^>]*href="https:[^"]*"[^>]*>/g)].map((m) => m[0]);
    expect(externals.length).toBeGreaterThan(0);
    for (const tag of externals) {
      expect(attr(tag, 'href')).toMatch(/^https:\/\/github\.com\/iamramchandrakarki\/rulecanvas-kit(\/|$)/);
      expect(attr(tag, 'rel')).toBe('noopener noreferrer');
    }
    expect(html).toContain('not a runtime firewall');
    expect(html).toContain('no IEC 61508 or SIL certification');
    expect(html).toContain('A result describes the model you wrote');
  });
});
