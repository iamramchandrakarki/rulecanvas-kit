import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '..');
const readTokens = (app: string) =>
  readFileSync(path.join(repoRoot, 'apps', app, 'src/styles/tokens.css'), 'utf8');

describe('shared design tokens', () => {
  it('keeps one token vocabulary across both workbench apps', () => {
    expect(readTokens('interlock-sim')).toBe(readTokens('agent-gate'));
  });

  it('defines every token in light, explicit dark, and system-dark scopes', () => {
    const css = readTokens('agent-gate');
    const light = css.slice(css.indexOf(":root[data-theme='light']"), css.indexOf(":root[data-theme='dark']"));
    const dark = css.slice(css.indexOf(":root[data-theme='dark']"), css.indexOf('@media (prefers-color-scheme: dark)'));
    const systemDark = css.slice(css.indexOf('@media (prefers-color-scheme: dark)'));
    const colorNames = (block: string) =>
      [...block.matchAll(/(--(?:color|shadow)-[a-z0-9-]+):/g)].map((m) => m[1]).sort();

    expect(colorNames(dark)).toEqual(colorNames(light));
    expect(colorNames(systemDark)).toEqual(colorNames(light));
  });
});

describe('shared compact AST editor', () => {
  const read = (app: string, rel: string) =>
    readFileSync(path.join(repoRoot, 'apps', app, rel), 'utf8');

  it('ships one stylesheet for both workbench apps', () => {
    const rel = 'src/styles/expr-editor.css';
    expect(read('interlock-sim', rel)).toBe(read('agent-gate', rel));
  });

  it('ships one shared controls, focus and motion stylesheet', () => {
    const rel = 'src/styles/controls.css';
    expect(read('interlock-sim', rel)).toBe(read('agent-gate', rel));
  });

  it('keeps both ExprEditor copies identical apart from app class names and helper import', () => {
    const rel = 'src/components/ExprEditor.tsx';
    const normalize = (src: string) =>
      src
        .replace(/'\.\.\/(model-editor|model-inspector)\.js'/g, "'../model-helpers.js'")
        .replace(/'(ag|is)-([a-z-]+)/g, "'app-$2")
        .replace(/ (ag|is)-([a-z-]+)/g, ' app-$2')
        .replace(/app-input-mono/g, 'app-mono');
    expect(normalize(read('interlock-sim', rel))).toBe(normalize(read('agent-gate', rel)));
  });
});
