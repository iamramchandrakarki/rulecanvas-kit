import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSync } from 'oxc-parser';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(THIS_DIR, '..');

const TEST_ROOT_NAMES = new Set(['it', 'test', 'describe', 'suite', 'bench']);
const PENDING_BODY_ROOT_NAMES = new Set(['it', 'test', 'bench']);
const TEST_BODY_MODIFIERS = new Set(['concurrent', 'sequential', 'fails']);
const FORBIDDEN_DIRECT_CALLS = new Set(['xit', 'fit', 'xdescribe', 'fdescribe', 'xtest', 'ftest']);
const FORBIDDEN_MODIFIERS = new Set(['skip', 'only', 'todo', 'skipIf', 'runIf']);
const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

function walkTestFiles(dir, out) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walkTestFiles(full, out);
    } else if (TEST_FILE_RE.test(entry)) {
      out.push(full);
    }
  }
}

function getPropertyName(memberNode) {
  if (!memberNode.computed && memberNode.property?.type === 'Identifier') {
    return memberNode.property.name;
  }
  if (memberNode.computed && memberNode.property?.type === 'Literal' && typeof memberNode.property.value === 'string') {
    return memberNode.property.value;
  }
  if (
    memberNode.computed &&
    memberNode.property?.type === 'TemplateLiteral' &&
    memberNode.property.expressions.length === 0 &&
    memberNode.property.quasis.length === 1
  ) {
    return memberNode.property.quasis[0].value.cooked ?? memberNode.property.quasis[0].value.raw;
  }
  return null;
}

function extractCalleeChain(node) {
  if (!node) return null;
  if (node.type === 'ChainExpression') {
    return extractCalleeChain(node.expression);
  }
  if (node.type === 'Identifier') {
    return [node.name];
  }
  if (node.type === 'MemberExpression') {
    const base = extractCalleeChain(node.object);
    const prop = getPropertyName(node);
    if (!base || prop === null) return null;
    return [...base, prop];
  }
  return null;
}

function lineNumberAt(source, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i += 1) {
    if (source.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

export function findTestHygieneViolations(filePath, source) {
  const parsed = parseSync(filePath, source);
  const violations = [];

  if (parsed.errors.length > 0) {
    violations.push(`${filePath}: parse error (${parsed.errors[0].message})`);
    return violations;
  }

  const testRoots = new Set(TEST_ROOT_NAMES);
  const pendingBodyRoots = new Set(PENDING_BODY_ROOT_NAMES);
  const directForbidden = new Set(FORBIDDEN_DIRECT_CALLS);
  const testNamespaces = new Set();

  // Collect aliased and namespace imports from test runners (vitest / node:test / @jest/globals)
  const TEST_RUNNERS = new Set(['vitest', 'node:test', '@jest/globals']);
  for (const stmt of parsed.program.body ?? []) {
    if (stmt?.type !== 'ImportDeclaration' || !TEST_RUNNERS.has(stmt.source?.value)) continue;
    for (const spec of stmt.specifiers ?? []) {
      if (spec.type === 'ImportNamespaceSpecifier' && spec.local?.name) {
        testNamespaces.add(spec.local.name);
      } else if (spec.type === 'ImportSpecifier' && spec.local?.name) {
        const imported = spec.imported?.name ?? spec.imported?.value;
        if (TEST_ROOT_NAMES.has(imported)) testRoots.add(spec.local.name);
        if (PENDING_BODY_ROOT_NAMES.has(imported)) pendingBodyRoots.add(spec.local.name);
        if (FORBIDDEN_DIRECT_CALLS.has(imported)) directForbidden.add(spec.local.name);
      }
    }
  }

  function isDefinitelyNonFunctionArg(arg) {
    if (!arg) return true;
    if (arg.type === 'Identifier' && arg.name === 'undefined') return true;
    if (arg.type === 'UnaryExpression' && arg.operator === 'void') return true;
    if (arg.type === 'Literal') return true;
    if (arg.type === 'ObjectExpression' || arg.type === 'ArrayExpression' || arg.type === 'TemplateLiteral') return true;
    return false;
  }

  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }

    if (node.type === 'CallExpression') {
      const chain = extractCalleeChain(node.callee);
      if (chain && chain.length > 0) {
        let effective = chain;
        if (testNamespaces.has(chain[0]) && chain.length >= 2) {
          effective = chain.slice(1);
        }
        const root = effective[0];
        if (directForbidden.has(root)) {
          violations.push(`${filePath}:${lineNumberAt(source, node.start)}: forbidden call ${chain.join('.')}`);
        } else if (testRoots.has(root)) {
          let hasForbiddenModifier = false;
          for (let i = 1; i < effective.length; i += 1) {
            if (FORBIDDEN_MODIFIERS.has(effective[i])) {
              violations.push(`${filePath}:${lineNumberAt(source, node.start)}: forbidden modifier ${chain.join('.')}`);
              hasForbiddenModifier = true;
              break;
            }
          }
          if (
            !hasForbiddenModifier &&
            pendingBodyRoots.has(root) &&
            effective.slice(1).every((mod) => TEST_BODY_MODIFIERS.has(mod))
          ) {
            const args = node.arguments ?? [];
            const missingBody =
              args.length < 2 ||
              (isDefinitelyNonFunctionArg(args[1]) &&
                (args.length < 3 || isDefinitelyNonFunctionArg(args[2])));
            if (missingBody) {
              violations.push(`${filePath}:${lineNumberAt(source, node.start)}: pending test without body ${chain.join('.')}`);
            }
          }
        }
      }
    }

    for (const key of Object.keys(node)) {
      if (key === 'type' || key === 'start' || key === 'end') continue;
      visit(node[key]);
    }
  }

  visit(parsed.program);
  return violations;
}

function main() {
  const files = [];
  for (const dir of ['packages', 'apps']) {
    walkTestFiles(path.join(REPO_ROOT, dir), files);
  }

  if (files.length === 0) {
    console.error('ERROR: No test files found under packages/ or apps/.');
    process.exit(1);
  }

  const allViolations = [];
  for (const file of files) {
    const rel = path.relative(REPO_ROOT, file);
    const source = readFileSync(file, 'utf8');
    allViolations.push(...findTestHygieneViolations(rel, source));
  }

  if (allViolations.length > 0) {
    console.error('Anti-skip test hygiene check failed:');
    for (const v of allViolations) console.error(`  - ${v}`);
    process.exit(1);
  }

  console.log(`Test hygiene verified across ${files.length} test files (0 skipped/focused/pending tests).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
