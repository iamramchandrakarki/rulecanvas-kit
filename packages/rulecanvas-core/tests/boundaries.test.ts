import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSync } from 'oxc-parser';
import { describe, expect, it } from 'vitest';
import { findTestHygieneViolations } from '../../../scripts/check-test-hygiene.mjs';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const CORE_DIR = path.resolve(THIS_DIR, '..');
const CORE_SRC_DIR = path.join(CORE_DIR, 'src');
const REPO_ROOT = path.resolve(CORE_DIR, '..', '..');

function walkFiles(dir: string, filter?: (filePath: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;
      results.push(...walkFiles(full, filter));
    } else if (!filter || filter(full)) {
      results.push(full);
    }
  }
  return results;
}

interface AstNode {
  type: string;
  [key: string]: unknown;
}

function walkAst(node: unknown, visitor: (n: AstNode, parent: AstNode | null, parentKey: string | null) => void, parent: AstNode | null = null, parentKey: string | null = null): void {
  if (node === null || node === undefined || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) {
      walkAst(item, visitor, parent, parentKey);
    }
    return;
  }
  const ast = node as AstNode;
  if (typeof ast.type !== 'string') return;
  visitor(ast, parent, parentKey);
  for (const key of Object.keys(ast)) {
    if (key === 'type' || key === 'start' || key === 'end') continue;
    walkAst(ast[key], visitor, ast, key);
  }
}

function getMemberPropName(node: AstNode): string | null {
  const prop = node.property as AstNode | undefined;
  if (!prop) return null;
  if (!node.computed && prop.type === 'Identifier' && typeof prop.name === 'string') {
    return prop.name;
  }
  if (node.computed && prop.type === 'Literal' && typeof prop.value === 'string') {
    return prop.value;
  }
  if (
    node.computed &&
    prop.type === 'TemplateLiteral' &&
    Array.isArray(prop.expressions) &&
    prop.expressions.length === 0 &&
    Array.isArray(prop.quasis) &&
    prop.quasis.length === 1
  ) {
    const q = prop.quasis[0] as { value?: { cooked?: string; raw?: string } };
    return q.value?.cooked ?? q.value?.raw ?? null;
  }
  return null;
}

function checkCoreImportsInSource(filePath: string, source: string): string[] {
  const rel = path.relative(REPO_ROOT, filePath);
  const parsed = parseSync(filePath, source);
  const violations: string[] = [];

  if (parsed.errors.length > 0) {
    violations.push(`${rel}: TypeScript parse error (${parsed.errors[0]!.message})`);
    return violations;
  }

  const checkSpecifier = (spec: string): void => {
    if (spec.startsWith('node:')) {
      violations.push(`${rel}: forbidden node:* specifier "${spec}"`);
      return;
    }
    if (spec.includes('apps/') || spec.startsWith('apps')) {
      violations.push(`${rel}: forbidden apps/* specifier "${spec}"`);
      return;
    }
    if (!spec.startsWith('./') && !spec.startsWith('../')) {
      violations.push(`${rel}: forbidden bare specifier "${spec}"`);
      return;
    }
    const resolved = path.resolve(path.dirname(filePath), spec);
    const relToCoreSrc = path.relative(CORE_SRC_DIR, resolved);
    if (relToCoreSrc.startsWith('..') || path.isAbsolute(relToCoreSrc)) {
      violations.push(`${rel}: relative specifier "${spec}" escapes packages/rulecanvas-core/src`);
    }
  };

  walkAst(parsed.program, (node) => {
    if (node.type === 'ImportExpression') {
      violations.push(`${rel}: contains forbidden dynamic import()`);
      return;
    }
    if (
      node.type === 'ImportDeclaration' ||
      node.type === 'ExportNamedDeclaration' ||
      node.type === 'ExportAllDeclaration'
    ) {
      const src = node.source as AstNode | null | undefined;
      if (src && src.type === 'Literal' && typeof src.value === 'string') {
        checkSpecifier(src.value);
      }
    }
    if (node.type === 'TSImportType') {
      const src = node.source as AstNode | undefined;
      if (src && src.type === 'Literal' && typeof src.value === 'string') {
        checkSpecifier(src.value);
      }
      const arg = node.argument as AstNode | undefined;
      if (arg && arg.type === 'TSLiteralType') {
        const lit = arg.literal as AstNode | undefined;
        if (lit && lit.type === 'Literal' && typeof lit.value === 'string') {
          checkSpecifier(lit.value);
        }
      }
    }
    if (node.type === 'TSExternalModuleReference') {
      const expr = node.expression as AstNode | undefined;
      if (expr && expr.type === 'Literal' && typeof expr.value === 'string') {
        checkSpecifier(expr.value);
      }
    }
  });

  return violations;
}

const FORBIDDEN_GLOBALS = new Set([
  'Date',
  'performance',
  'setTimeout',
  'setInterval',
  'globalThis',
  'eval',
  'Function',
]);

function isNonReferenceIdentifier(parent: AstNode | null, parentKey: string | null): boolean {
  if (!parent) return false;
  if (parent.type === 'MemberExpression' && parentKey === 'property' && !parent.computed) return true;
  if (parent.type === 'Property' && parentKey === 'key' && !parent.computed) return true;
  if (parent.type === 'MethodDefinition' && parentKey === 'key' && !parent.computed) return true;
  if (parent.type === 'PropertyDefinition' && parentKey === 'key' && !parent.computed) return true;
  if (parent.type === 'TSPropertySignature' && parentKey === 'key' && !parent.computed) return true;
  if (parent.type === 'LabeledStatement' && parentKey === 'label') return true;
  if ((parent.type === 'BreakStatement' || parent.type === 'ContinueStatement') && parentKey === 'label') return true;
  if (parent.type === 'ImportSpecifier' && parentKey === 'imported') return true;
  if (parent.type === 'ExportSpecifier' && parentKey === 'exported') return true;
  return false;
}

function getObjectPatternPropName(prop: AstNode): string | null {
  const key = prop.key as AstNode | undefined;
  if (!key) return null;
  if (!prop.computed && key.type === 'Identifier' && typeof key.name === 'string') {
    return key.name;
  }
  if (key.type === 'Literal' && typeof key.value === 'string') {
    return key.value;
  }
  if (
    prop.computed &&
    key.type === 'TemplateLiteral' &&
    Array.isArray(key.expressions) &&
    key.expressions.length === 0 &&
    Array.isArray(key.quasis) &&
    key.quasis.length === 1
  ) {
    const q = key.quasis[0] as { value?: { cooked?: string; raw?: string } };
    return q.value?.cooked ?? q.value?.raw ?? null;
  }
  return null;
}

function objectPatternDestructuresRandom(pattern: AstNode | undefined): boolean {
  if (!pattern || pattern.type !== 'ObjectPattern' || !Array.isArray(pattern.properties)) return false;
  for (const rawProp of pattern.properties) {
    const prop = rawProp as AstNode;
    if (prop.type === 'Property' && getObjectPatternPropName(prop) === 'random') {
      return true;
    }
  }
  return false;
}

function checkForbiddenApisInSource(filePath: string, source: string): string[] {
  const rel = path.relative(REPO_ROOT, filePath);
  const parsed = parseSync(filePath, source);
  const found = new Set<string>();

  if (parsed.errors.length > 0) {
    return [`${rel}: TypeScript parse error (${parsed.errors[0]!.message})`];
  }

  walkAst(parsed.program, (node, parent, parentKey) => {
    if (node.type === 'MemberExpression') {
      const obj = node.object as AstNode | undefined;
      const propName = getMemberPropName(node);
      if (obj?.type === 'Identifier' && obj.name === 'Math' && propName === 'random') {
        found.add('Math.random');
      }
      return;
    }
    if (node.type === 'VariableDeclarator') {
      const init = node.init as AstNode | undefined;
      const id = node.id as AstNode | undefined;
      if (init?.type === 'Identifier' && init.name === 'Math' && objectPatternDestructuresRandom(id)) {
        found.add('Math.random');
      }
    }
    if (node.type === 'AssignmentExpression') {
      const right = node.right as AstNode | undefined;
      const left = node.left as AstNode | undefined;
      if (right?.type === 'Identifier' && right.name === 'Math' && objectPatternDestructuresRandom(left)) {
        found.add('Math.random');
      }
    }
    if (node.type === 'Identifier' && typeof node.name === 'string') {
      if (FORBIDDEN_GLOBALS.has(node.name) && !isNonReferenceIdentifier(parent, parentKey)) {
        found.add(node.name);
      }
    }
  });

  if (found.size === 0) return [];
  return [`${rel}: forbidden APIs [${[...found].join(', ')}]`];
}

describe('architecture and honesty boundaries', () => {
  it('verifies packages/rulecanvas-core/package.json has zero runtime, peer, or optional dependencies', () => {
    const pkgPath = path.join(CORE_DIR, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<string, unknown>;

    for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies'] as const) {
      const value = pkg[field];
      if (value !== undefined) {
        expect(typeof value).toBe('object');
        expect(Object.keys(value as Record<string, unknown>)).toEqual([]);
      }
    }
  });

  it('forbids bare specifiers, node:*, dynamic import(), and apps/* imports in packages/rulecanvas-core/src/**/*.ts', () => {
    const tsFiles = walkFiles(CORE_SRC_DIR, (p) => p.endsWith('.ts'));
    expect(tsFiles.length).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const filePath of tsFiles) {
      violations.push(...checkCoreImportsInSource(filePath, readFileSync(filePath, 'utf8')));
    }
    expect(violations).toEqual([]);

    // Self-check: AST import checker catches compact/unspaced, TS import types, and import = require()
    expect(checkCoreImportsInSource(path.join(CORE_SRC_DIR, '__probe__.ts'), "import{readFileSync}from'node:fs';")).toHaveLength(1);
    expect(checkCoreImportsInSource(path.join(CORE_SRC_DIR, '__probe__.ts'), "export{x}from'lodash';")).toHaveLength(1);
    expect(checkCoreImportsInSource(path.join(CORE_SRC_DIR, '__probe__.ts'), "const m = import('./eval.js');")).toHaveLength(1);
    expect(checkCoreImportsInSource(path.join(CORE_SRC_DIR, '__probe__.ts'), "type T = import('node:fs').Stats;")).toHaveLength(1);
    expect(checkCoreImportsInSource(path.join(CORE_SRC_DIR, '__probe__.ts'), "import fs = require('node:fs');")).toHaveLength(1);
  });

  it('forbids non-deterministic or host-coupled APIs in packages/rulecanvas-core/src/**/*.ts', () => {
    const tsFiles = walkFiles(CORE_SRC_DIR, (p) => p.endsWith('.ts'));
    expect(tsFiles.length).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const filePath of tsFiles) {
      violations.push(...checkForbiddenApisInSource(filePath, readFileSync(filePath, 'utf8')));
    }
    expect(violations).toEqual([]);

    // Self-check: AST API checker catches spaced, computed, multiline, and destructured spellings
    expect(checkForbiddenApisInSource(path.join(CORE_SRC_DIR, '__probe__.ts'), 'const r = Math . random();')).toHaveLength(1);
    expect(checkForbiddenApisInSource(path.join(CORE_SRC_DIR, '__probe__.ts'), "const r = Math['random']();")).toHaveLength(1);
    expect(checkForbiddenApisInSource(path.join(CORE_SRC_DIR, '__probe__.ts'), 'const { random: r } = Math;')).toHaveLength(1);
    expect(checkForbiddenApisInSource(path.join(CORE_SRC_DIR, '__probe__.ts'), 'const { "random": r } = Math;')).toHaveLength(1);
    expect(checkForbiddenApisInSource(path.join(CORE_SRC_DIR, '__probe__.ts'), 'const t = Date\n  .now();')).toHaveLength(1);

    // Self-check: AST test-hygiene checker catches multiline, aliased, namespace-imported, and bare pending calls
    expect(findTestHygieneViolations('probe.test.ts', "it\n  .skip\n  ('x', () => {});")).toHaveLength(1);
    expect(findTestHygieneViolations('probe.test.ts', "test['only']\n  ('x', () => {});")).toHaveLength(1);
    expect(findTestHygieneViolations('probe.test.ts', "xit\n('x', () => {});")).toHaveLength(1);
    expect(findTestHygieneViolations('probe.test.ts', "import { it as myIt } from 'vitest'; myIt.skip('x', () => {});")).toHaveLength(1);
    expect(findTestHygieneViolations('probe.test.ts', "import * as v from 'vitest'; v.it\n.skip('x', () => {});")).toHaveLength(1);
    expect(findTestHygieneViolations('probe.test.ts', "test('pending');")).toHaveLength(1);
    expect(findTestHygieneViolations('probe.test.ts', "it('pending', undefined);")).toHaveLength(1);
    expect(findTestHygieneViolations('probe.test.ts', "test('pending', null);")).toHaveLength(1);
    expect(findTestHygieneViolations('probe.test.ts', "test('valid', () => {}, undefined);")).toHaveLength(0);
    expect(findTestHygieneViolations('probe.test.ts', "test('valid', { timeout: 500 }, () => {});")).toHaveLength(0);
    expect(findTestHygieneViolations('probe.test.ts', "it.concurrent('pending');")).toHaveLength(1);
    expect(findTestHygieneViolations('probe.test.ts', "import { test as myTest } from 'vitest'; myTest.fails('pending', undefined);")).toHaveLength(1);
    expect(findTestHygieneViolations('probe.test.ts', "import * as v from 'vitest'; v.bench.sequential('pending');")).toHaveLength(1);
  });

  it('contains zero domain leaks in packages/rulecanvas-core/src/** filenames or contents', () => {
    const allSrcFiles = walkFiles(CORE_SRC_DIR);
    expect(allSrcFiles.length).toBeGreaterThan(0);

    const domainLeakPatterns: readonly RegExp[] = [
      /airlock/i,
      /autoclave/i,
      /bsl/i,
      /steril/i,
      /agent/i,
      /trifecta/i,
      /launder/i,
      /approval/i,
      /exfil/i,
      /webhook/i,
      /interlock/i,
      /valve/i,
      /door/i,
      /\bmcp\b/i,
    ];

    const violations: string[] = [];
    for (const filePath of allSrcFiles) {
      const rel = path.relative(CORE_SRC_DIR, filePath);
      const content = readFileSync(filePath, 'utf8');
      for (const pattern of domainLeakPatterns) {
        if (pattern.test(rel)) {
          violations.push(`filename "${rel}" matches forbidden domain pattern ${pattern}`);
        }
        if (pattern.test(content)) {
          violations.push(`${path.relative(REPO_ROOT, filePath)} content matches forbidden domain pattern ${pattern}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('contains zero overclaim phrases across claim-bearing non-test files', () => {
    const forbiddenPhrases = [
      '100% secure',
      'unhackable',
      'proven safe',
      'formally proven by fast-check',
      'certified safety software',
      'audits production mcp.json',
    ] as const;

    const claimFiles: Array<{ label: string; text: string }> = [];

    // 1. packages/*/src/** and apps/*/src/**
    for (const group of ['packages', 'apps'] as const) {
      const groupDir = path.join(REPO_ROOT, group);
      if (!existsSync(groupDir)) continue;
      for (const workspace of readdirSync(groupDir)) {
        const wsDir = path.join(groupDir, workspace);
        if (!statSync(wsDir).isDirectory()) continue;
        const srcDir = path.join(wsDir, 'src');
        for (const file of walkFiles(srcDir)) {
          claimFiles.push({
            label: path.relative(REPO_ROOT, file),
            text: readFileSync(file, 'utf8'),
          });
        }
        const pkgReadme = path.join(wsDir, 'README.md');
        if (existsSync(pkgReadme)) {
          claimFiles.push({
            label: path.relative(REPO_ROOT, pkgReadme),
            text: readFileSync(pkgReadme, 'utf8'),
          });
        }
      }
    }

    // 2. Root README.md
    const rootReadme = path.join(REPO_ROOT, 'README.md');
    if (existsSync(rootReadme)) {
      claimFiles.push({ label: 'README.md', text: readFileSync(rootReadme, 'utf8') });
    }

    // 3. **/package.json description fields (excluding .kiro, docs, tests, node_modules, dist)
    const allPkgJsons = walkFiles(REPO_ROOT, (p) => {
      if (path.basename(p) !== 'package.json') return false;
      const rel = path.relative(REPO_ROOT, p);
      const parts = rel.split(path.sep);
      return !parts.includes('.kiro') && !parts.includes('docs') && !parts.includes('tests');
    });
    for (const pkgPath of allPkgJsons) {
      const parsed = JSON.parse(readFileSync(pkgPath, 'utf8')) as { description?: unknown };
      if (typeof parsed.description === 'string') {
        claimFiles.push({
          label: `${path.relative(REPO_ROOT, pkgPath)}#description`,
          text: parsed.description,
        });
      }
    }

    expect(claimFiles.length).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const item of claimFiles) {
      const normalized = item.text.replace(/\s+/g, ' ').toLowerCase();
      for (const phrase of forbiddenPhrases) {
        if (normalized.includes(phrase)) {
          violations.push(`${item.label}: contains forbidden overclaim phrase "${phrase}"`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
