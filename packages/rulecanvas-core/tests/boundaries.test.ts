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
const UI_DIR = path.join(REPO_ROOT, 'packages', 'rulecanvas-ui');
const UI_SRC_DIR = path.join(UI_DIR, 'src');

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

function getStaticStringValue(node: AstNode | undefined): string | null {
  if (!node) return null;
  if (node.type === 'Literal' && typeof node.value === 'string') {
    return node.value;
  }
  if (
    node.type === 'TemplateLiteral' &&
    Array.isArray(node.expressions) &&
    node.expressions.length === 0 &&
    Array.isArray(node.quasis) &&
    node.quasis.length === 1
  ) {
    const q = node.quasis[0] as { value?: { cooked?: string; raw?: string } };
    return q.value?.cooked ?? q.value?.raw ?? null;
  }
  return null;
}

function getMemberPropName(node: AstNode): string | null {
  const prop = node.property as AstNode | undefined;
  if (!prop) return null;
  if (!node.computed && prop.type === 'Identifier' && typeof prop.name === 'string') {
    return prop.name;
  }
  if (node.computed) {
    return getStaticStringValue(prop);
  }
  return null;
}

function checkPackageImportsInSource(
  filePath: string,
  source: string,
  pkgSrcDir: string,
  allowedBareSpecifiers: ReadonlySet<string>,
): string[] {
  const rel = path.relative(REPO_ROOT, filePath);
  const pkgSrcRel = path.relative(REPO_ROOT, pkgSrcDir);
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
      if (!allowedBareSpecifiers.has(spec)) {
        violations.push(`${rel}: forbidden bare specifier "${spec}"`);
      }
      return;
    }
    const resolved = path.resolve(path.dirname(filePath), spec);
    const relToPkgSrc = path.relative(pkgSrcDir, resolved);
    if (relToPkgSrc.startsWith('..') || path.isAbsolute(relToPkgSrc)) {
      violations.push(`${rel}: relative specifier "${spec}" escapes ${pkgSrcRel}`);
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

function checkCoreImportsInSource(filePath: string, source: string): string[] {
  return checkPackageImportsInSource(filePath, source, CORE_SRC_DIR, new Set());
}

const UI_ALLOWED_BARE_SPECIFIERS = new Set(['@rulecanvas/core']);

function checkUiImportsInSource(filePath: string, source: string): string[] {
  return checkPackageImportsInSource(filePath, source, UI_SRC_DIR, UI_ALLOWED_BARE_SPECIFIERS);
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
  if (!prop.computed && key.type === 'Literal' && typeof key.value === 'string') {
    return key.value;
  }
  if (prop.computed) {
    return getStaticStringValue(key);
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

function unwrapExpression(node: AstNode | undefined): AstNode | undefined {
  let curr = node;
  while (
    curr &&
    (curr.type === 'ParenthesizedExpression' ||
      curr.type === 'TSAsExpression' ||
      curr.type === 'TSTypeAssertion' ||
      curr.type === 'TSSatisfiesExpression' ||
      curr.type === 'TSNonNullExpression')
  ) {
    curr = curr.expression as AstNode | undefined;
  }
  return curr;
}

interface ScopeFrame {
  readonly kind: 'function' | 'block';
  readonly parent: ScopeFrame | null;
  readonly declared: Set<string>;
  readonly varDeclared: Set<string>;
  readonly fnDeclared: Set<string>;
  readonly mathAlias: Map<string, boolean>;
}

function resolveVarScope(scope: ScopeFrame): ScopeFrame {
  let curr: ScopeFrame = scope;
  while (curr.kind !== 'function' && curr.parent !== null) {
    curr = curr.parent;
  }
  return curr;
}

function findOwnerScope(scope: ScopeFrame, name: string): ScopeFrame | null {
  let curr: ScopeFrame | null = scope;
  while (curr !== null) {
    if (curr.declared.has(name)) {
      return curr;
    }
    curr = curr.parent;
  }
  return null;
}

function isMathAliasExpr(node: AstNode | undefined, scope: ScopeFrame): boolean {
  const expr = unwrapExpression(node);
  if (!expr) return false;
  if (expr.type === 'Identifier' && typeof expr.name === 'string') {
    const owner = findOwnerScope(scope, expr.name);
    return owner !== null && owner.mathAlias.get(expr.name) === true;
  }
  if (expr.type === 'SequenceExpression' && Array.isArray(expr.expressions) && expr.expressions.length > 0) {
    return isMathAliasExpr(expr.expressions[expr.expressions.length - 1] as AstNode | undefined, scope);
  }
  if (expr.type === 'ConditionalExpression') {
    return (
      isMathAliasExpr(expr.consequent as AstNode | undefined, scope) ||
      isMathAliasExpr(expr.alternate as AstNode | undefined, scope)
    );
  }
  if (expr.type === 'LogicalExpression') {
    return (
      isMathAliasExpr(expr.left as AstNode | undefined, scope) ||
      isMathAliasExpr(expr.right as AstNode | undefined, scope)
    );
  }
  return false;
}

function collectPatternBoundNames(pattern: AstNode | undefined, out: string[]): void {
  if (!pattern) return;
  if (pattern.type === 'Identifier' && typeof pattern.name === 'string') {
    out.push(pattern.name);
    return;
  }
  if (pattern.type === 'AssignmentPattern') {
    collectPatternBoundNames(pattern.left as AstNode | undefined, out);
    return;
  }
  if (pattern.type === 'RestElement') {
    collectPatternBoundNames(pattern.argument as AstNode | undefined, out);
    return;
  }
  if (pattern.type === 'TSParameterProperty') {
    collectPatternBoundNames(pattern.parameter as AstNode | undefined, out);
    return;
  }
  if (pattern.type === 'ArrayPattern' && Array.isArray(pattern.elements)) {
    for (const elem of pattern.elements) {
      collectPatternBoundNames(elem as AstNode | undefined, out);
    }
    return;
  }
  if (pattern.type === 'ObjectPattern' && Array.isArray(pattern.properties)) {
    for (const rawProp of pattern.properties) {
      const prop = rawProp as AstNode | undefined;
      if (!prop) continue;
      if (prop.type === 'Property') {
        collectPatternBoundNames(prop.value as AstNode | undefined, out);
      } else if (prop.type === 'RestElement') {
        collectPatternBoundNames(prop.argument as AstNode | undefined, out);
      }
    }
  }
}

function createChildScope(kind: 'function' | 'block', parent: ScopeFrame): ScopeFrame {
  return {
    kind,
    parent,
    declared: new Set(),
    varDeclared: new Set(),
    fnDeclared: new Set(),
    mathAlias: new Map(),
  };
}

interface FunctionBodyLink {
  readonly paramScope: ScopeFrame;
  readonly bodyScope: ScopeFrame;
}

function buildLexicalScopes(program: AstNode): {
  readonly moduleScope: ScopeFrame;
  readonly nodeScopes: WeakMap<AstNode, ScopeFrame>;
  readonly functionBodyLinks: readonly FunctionBodyLink[];
} {
  const globalScope: ScopeFrame = {
    kind: 'function',
    parent: null,
    declared: new Set(['Math']),
    varDeclared: new Set(),
    fnDeclared: new Set(),
    mathAlias: new Map([['Math', true]]),
  };
  const moduleScope = createChildScope('function', globalScope);
  const nodeScopes = new WeakMap<AstNode, ScopeFrame>();
  const functionBodyLinks: FunctionBodyLink[] = [];
  nodeScopes.set(program, moduleScope);

  const visit = (node: unknown, scope: ScopeFrame): void => {
    if (node === null || node === undefined || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) {
        visit(item, scope);
      }
      return;
    }
    const ast = node as AstNode;
    if (typeof ast.type !== 'string') return;

    const existingScope = nodeScopes.get(ast);
    let innerScope = existingScope ?? scope;

    if (ast.type === 'SwitchStatement') {
      if (Array.isArray(ast.cases)) {
        const casesScope = createChildScope('block', innerScope);
        for (const rawCase of ast.cases) {
          const switchCase = rawCase as AstNode | undefined;
          if (switchCase && typeof switchCase.type === 'string') {
            nodeScopes.set(switchCase, casesScope);
          }
        }
      }
    } else if (ast.type === 'TSModuleDeclaration' && ast.declare === true) {
      return;
    } else if (
      ast.type === 'StaticBlock' ||
      (ast.type === 'TSModuleDeclaration' && ast.declare !== true)
    ) {
      innerScope = createChildScope('function', scope);
      nodeScopes.set(ast, innerScope);
    } else if (
      existingScope === undefined &&
      (ast.type === 'BlockStatement' ||
        ast.type === 'ForStatement' ||
        ast.type === 'ForInStatement' ||
        ast.type === 'ForOfStatement')
    ) {
      innerScope = createChildScope('block', scope);
      nodeScopes.set(ast, innerScope);
    } else if (ast.type === 'CatchClause') {
      innerScope = createChildScope('block', scope);
      nodeScopes.set(ast, innerScope);
      const paramNames: string[] = [];
      collectPatternBoundNames(ast.param as AstNode | undefined, paramNames);
      for (const name of paramNames) {
        innerScope.declared.add(name);
      }
    } else if (
      ast.type === 'FunctionDeclaration' ||
      ast.type === 'FunctionExpression' ||
      ast.type === 'ArrowFunctionExpression'
    ) {
      if (ast.type === 'FunctionDeclaration' && ast.declare === true) {
        return;
      }
      const fnId = ast.id as AstNode | undefined;
      if (ast.type === 'FunctionDeclaration' && fnId?.type === 'Identifier' && typeof fnId.name === 'string') {
        scope.declared.add(fnId.name);
        scope.fnDeclared.add(fnId.name);
      }
      innerScope = createChildScope('function', scope);
      nodeScopes.set(ast, innerScope);
      if (ast.type === 'FunctionExpression' && fnId?.type === 'Identifier' && typeof fnId.name === 'string') {
        innerScope.declared.add(fnId.name);
      }
      if (Array.isArray(ast.params)) {
        const paramNames: string[] = [];
        for (const param of ast.params) {
          collectPatternBoundNames(param as AstNode | undefined, paramNames);
        }
        for (const name of paramNames) {
          innerScope.declared.add(name);
        }
      }
      const fnBody = ast.body as AstNode | undefined;
      if (fnBody && fnBody.type === 'BlockStatement') {
        const bodyScope = createChildScope('function', innerScope);
        nodeScopes.set(fnBody, bodyScope);
        functionBodyLinks.push({ paramScope: innerScope, bodyScope });
      }
    } else if (
      (ast.type === 'ClassDeclaration' || ast.type === 'TSEnumDeclaration') &&
      ast.declare !== true
    ) {
      const declId = ast.id as AstNode | undefined;
      if (declId?.type === 'Identifier' && typeof declId.name === 'string') {
        scope.declared.add(declId.name);
      }
    } else if (ast.type === 'ClassExpression') {
      const classId = ast.id as AstNode | undefined;
      if (classId?.type === 'Identifier' && typeof classId.name === 'string') {
        innerScope = createChildScope('block', scope);
        innerScope.declared.add(classId.name);
        nodeScopes.set(ast, innerScope);
      }
    } else if (ast.type === 'ImportDeclaration' && ast.importKind !== 'type' && Array.isArray(ast.specifiers)) {
      for (const rawSpec of ast.specifiers) {
        const spec = rawSpec as AstNode | undefined;
        if (!spec || spec.importKind === 'type') continue;
        const local = spec.local as AstNode | undefined;
        if (local?.type === 'Identifier' && typeof local.name === 'string') {
          moduleScope.declared.add(local.name);
        }
      }
    } else if (ast.type === 'VariableDeclaration' && ast.declare !== true && Array.isArray(ast.declarations)) {
      const isVar = ast.kind === 'var';
      const targetScope = isVar ? resolveVarScope(innerScope) : innerScope;
      for (const rawDecl of ast.declarations) {
        const decl = rawDecl as AstNode | undefined;
        if (!decl) continue;
        const names: string[] = [];
        collectPatternBoundNames(decl.id as AstNode | undefined, names);
        for (const name of names) {
          targetScope.declared.add(name);
          if (isVar) {
            targetScope.varDeclared.add(name);
          }
        }
      }
    }

    for (const key of Object.keys(ast)) {
      if (key === 'type' || key === 'start' || key === 'end') continue;
      visit(ast[key], innerScope);
    }
  };

  visit(program, moduleScope);
  return { moduleScope, nodeScopes, functionBodyLinks };
}

function walkProgramWithScopes(
  program: AstNode,
  nodeScopes: WeakMap<AstNode, ScopeFrame>,
  moduleScope: ScopeFrame,
  visitor: (ast: AstNode, scope: ScopeFrame, parent: AstNode | null, parentKey: string | null) => void,
): void {
  const visit = (
    node: unknown,
    scope: ScopeFrame,
    parent: AstNode | null,
    parentKey: string | null,
  ): void => {
    if (node === null || node === undefined || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) {
        visit(item, scope, parent, parentKey);
      }
      return;
    }
    const ast = node as AstNode;
    if (typeof ast.type !== 'string') return;
    const activeScope = nodeScopes.get(ast) ?? scope;
    visitor(ast, activeScope, parent, parentKey);
    for (const key of Object.keys(ast)) {
      if (key === 'type' || key === 'start' || key === 'end') continue;
      visit(ast[key], activeScope, ast, key);
    }
  };

  visit(program, moduleScope, null, null);
}

function checkForbiddenApisInSource(filePath: string, source: string): string[] {
  const rel = path.relative(REPO_ROOT, filePath);
  const parsed = parseSync(filePath, source);
  const found = new Set<string>();

  if (parsed.errors.length > 0) {
    return [`${rel}: TypeScript parse error (${parsed.errors[0]!.message})`];
  }

  const programAst = parsed.program as unknown as AstNode;
  const { moduleScope, nodeScopes, functionBodyLinks } = buildLexicalScopes(programAst);

  // Pass 2: fixed-point propagation of Math aliases across resolved lexical scopes
  let changed = true;
  while (changed) {
    changed = false;
    walkProgramWithScopes(programAst, nodeScopes, moduleScope, (ast, scope) => {
      if (ast.type === 'VariableDeclarator') {
        const id = ast.id as AstNode | undefined;
        const init = ast.init as AstNode | undefined;
        if (id?.type === 'Identifier' && typeof id.name === 'string' && isMathAliasExpr(init, scope)) {
          const owner = findOwnerScope(scope, id.name);
          if (owner !== null && owner.mathAlias.get(id.name) !== true) {
            owner.mathAlias.set(id.name, true);
            changed = true;
          }
        }
      } else if (ast.type === 'AssignmentExpression') {
        const left = ast.left as AstNode | undefined;
        const right = ast.right as AstNode | undefined;
        if (left?.type === 'Identifier' && typeof left.name === 'string' && isMathAliasExpr(right, scope)) {
          const owner = findOwnerScope(scope, left.name);
          if (owner !== null && owner.mathAlias.get(left.name) !== true) {
            owner.mathAlias.set(left.name, true);
            changed = true;
          }
        }
      } else if (ast.type === 'AssignmentPattern') {
        const left = ast.left as AstNode | undefined;
        const right = ast.right as AstNode | undefined;
        if (left?.type === 'Identifier' && typeof left.name === 'string' && isMathAliasExpr(right, scope)) {
          const owner = findOwnerScope(scope, left.name);
          if (owner !== null && owner.mathAlias.get(left.name) !== true) {
            owner.mathAlias.set(left.name, true);
            changed = true;
          }
        }
      }
    });

    // Carry parameter alias marker into function body `var` declarations of the same name
    for (const { paramScope, bodyScope } of functionBodyLinks) {
      for (const name of bodyScope.varDeclared) {
        if (
          paramScope.declared.has(name) &&
          !bodyScope.fnDeclared.has(name) &&
          paramScope.mathAlias.get(name) === true &&
          bodyScope.mathAlias.get(name) !== true
        ) {
          bodyScope.mathAlias.set(name, true);
          changed = true;
        }
      }
    }
  }

  // Pass 3: check forbidden uses using resolved alias scopes
  walkProgramWithScopes(programAst, nodeScopes, moduleScope, (ast, scope, parent, parentKey) => {
    if (ast.type === 'MemberExpression') {
      const propName = getMemberPropName(ast);
      if (isMathAliasExpr(ast.object as AstNode | undefined, scope) && propName === 'random') {
        found.add('Math.random');
      }
      return;
    }
    if (ast.type === 'CallExpression') {
      const callee = unwrapExpression(ast.callee as AstNode | undefined);
      if (callee?.type === 'MemberExpression') {
        const calleeObj = unwrapExpression(callee.object as AstNode | undefined);
        const calleeProp = getMemberPropName(callee);
        if (calleeObj?.type === 'Identifier' && calleeObj.name === 'Reflect' && calleeProp === 'get') {
          const args = ast.arguments as AstNode[] | undefined;
          const target = args?.[0];
          const keyArg = unwrapExpression(args?.[1]);
          if (isMathAliasExpr(target, scope) && getStaticStringValue(keyArg) === 'random') {
            found.add('Math.random');
          }
        }
      }
    }
    if (ast.type === 'VariableDeclarator') {
      if (
        isMathAliasExpr(ast.init as AstNode | undefined, scope) &&
        objectPatternDestructuresRandom(ast.id as AstNode | undefined)
      ) {
        found.add('Math.random');
      }
    }
    if (ast.type === 'AssignmentExpression') {
      if (
        isMathAliasExpr(ast.right as AstNode | undefined, scope) &&
        objectPatternDestructuresRandom(ast.left as AstNode | undefined)
      ) {
        found.add('Math.random');
      }
    }
    if (ast.type === 'AssignmentPattern') {
      if (
        isMathAliasExpr(ast.right as AstNode | undefined, scope) &&
        objectPatternDestructuresRandom(ast.left as AstNode | undefined)
      ) {
        found.add('Math.random');
      }
    }
    if (ast.type === 'Identifier' && typeof ast.name === 'string') {
      if (FORBIDDEN_GLOBALS.has(ast.name) && !isNonReferenceIdentifier(parent, parentKey)) {
        found.add(ast.name);
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

    // Self-check: AST API checker catches spaced, computed, multiline, destructured, and aliased spellings
    expect(checkForbiddenApisInSource(path.join(CORE_SRC_DIR, '__probe__.ts'), 'const r = Math . random();')).toHaveLength(1);
    expect(checkForbiddenApisInSource(path.join(CORE_SRC_DIR, '__probe__.ts'), "const r = Math['random']();")).toHaveLength(1);
    expect(checkForbiddenApisInSource(path.join(CORE_SRC_DIR, '__probe__.ts'), 'const { random: r } = Math;')).toHaveLength(1);
    expect(checkForbiddenApisInSource(path.join(CORE_SRC_DIR, '__probe__.ts'), 'const { "random": r } = Math;')).toHaveLength(1);
    expect(checkForbiddenApisInSource(path.join(CORE_SRC_DIR, '__probe__.ts'), 'const m = Math; m.random();')).toHaveLength(1);
    expect(checkForbiddenApisInSource(path.join(CORE_SRC_DIR, '__probe__.ts'), 'const a = Math; const b = a; b["random"]();')).toHaveLength(1);
    expect(checkForbiddenApisInSource(path.join(CORE_SRC_DIR, '__probe__.ts'), 'const m = Math; const { random: r } = m;')).toHaveLength(1);
    expect(checkForbiddenApisInSource(path.join(CORE_SRC_DIR, '__probe__.ts'), "const m = Math; Reflect.get(m, 'random');")).toHaveLength(1);
    expect(checkForbiddenApisInSource(path.join(CORE_SRC_DIR, '__probe__.ts'), 'const m = Math; function f(m: { random(): number }) { return m.random(); }')).toEqual([]);
    expect(checkForbiddenApisInSource(path.join(CORE_SRC_DIR, '__probe__.ts'), 'const m = Math; function f() { return m.random(); }')).toHaveLength(1);
    expect(checkForbiddenApisInSource(path.join(CORE_SRC_DIR, '__probe__.ts'), 'function f() { return m.random(); } const m = Math; f();')).toHaveLength(1);
    expect(checkForbiddenApisInSource(path.join(CORE_SRC_DIR, '__probe__.ts'), 'if (true) { var m = Math; } m.random();')).toHaveLength(1);
    expect(checkForbiddenApisInSource(path.join(CORE_SRC_DIR, '__probe__.ts'), 'if (true) { const m = Math; } const m = { random: () => 0 }; m.random();')).toEqual([]);
    expect(checkForbiddenApisInSource(path.join(CORE_SRC_DIR, '__probe__.ts'), 'const m = Math; switch (m.random()) { case 0: let m = { random: () => 0 }; break; }')).toHaveLength(1);
    expect(checkForbiddenApisInSource(path.join(CORE_SRC_DIR, '__probe__.ts'), 'const m = Math; switch (0) { case 0: let m = { random: () => 0 }; m.random(); break; }')).toEqual([]);
    expect(checkForbiddenApisInSource(path.join(CORE_SRC_DIR, '__probe__.ts'), 'const m = Math; function f(x = m.random()) { var m = { random: () => 0 }; return x; }')).toHaveLength(1);
    expect(checkForbiddenApisInSource(path.join(CORE_SRC_DIR, '__probe__.ts'), 'const m = Math; function f(x = m.random()) { var m = { random: () => 0 }; return m.random(); }')).toHaveLength(1);
    expect(checkForbiddenApisInSource(path.join(CORE_SRC_DIR, '__probe__.ts'), 'function f(m = Math) { return m.random(); }')).toHaveLength(1);
    expect(checkForbiddenApisInSource(path.join(CORE_SRC_DIR, '__probe__.ts'), 'function f(m = Math) { var m = m; return m.random(); } f();')).toHaveLength(1);
    expect(checkForbiddenApisInSource(path.join(CORE_SRC_DIR, '__probe__.ts'), 'function f({ random } = Math) { return random(); } f();')).toHaveLength(1);
    expect(checkForbiddenApisInSource(path.join(CORE_SRC_DIR, '__probe__.ts'), 'export {}; const Math = { random: () => 0 }; Math.random();')).toEqual([]);
    expect(checkForbiddenApisInSource(path.join(CORE_SRC_DIR, '__probe__.ts'), "import type { Math } from './types.js'; Math.random();")).toHaveLength(1);
    expect(checkForbiddenApisInSource(path.join(CORE_SRC_DIR, '__probe__.ts'), "import { type Math } from './types.js'; Math.random();")).toHaveLength(1);
    expect(checkForbiddenApisInSource(path.join(CORE_SRC_DIR, '__probe__.ts'), 'declare const Math: { random(): number }; Math.random();')).toHaveLength(1);
    expect(checkForbiddenApisInSource(path.join(CORE_SRC_DIR, '__probe__.ts'), 'class C { static { var Math = { random: () => 0 }; } } Math.random();')).toHaveLength(1);
    expect(checkForbiddenApisInSource(path.join(CORE_SRC_DIR, '__probe__.ts'), 'function f(m = Math) { var m; function m() {} return m.random; } f();')).toEqual([]);
    expect(checkForbiddenApisInSource(path.join(CORE_SRC_DIR, '__probe__.ts'), '(0, Math).random();')).toHaveLength(1);
    expect(checkForbiddenApisInSource(path.join(CORE_SRC_DIR, '__probe__.ts'), 'const m = Math; Reflect.get(m, `random`);')).toHaveLength(1);
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

  it('verifies packages/rulecanvas-ui/package.json has @rulecanvas/core (workspace:*) as sole runtime dependency and zero peer or optional dependencies', () => {
    const pkgPath = path.join(UI_DIR, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<string, unknown>;

    expect(pkg['dependencies']).toEqual({ '@rulecanvas/core': 'workspace:*' });

    for (const field of ['peerDependencies', 'optionalDependencies'] as const) {
      const value = pkg[field];
      if (value !== undefined) {
        expect(typeof value).toBe('object');
        expect(Object.keys(value as Record<string, unknown>)).toEqual([]);
      }
    }
  });

  it('forbids node:*, apps/*, dynamic import(), and external bare specifiers other than @rulecanvas/core in packages/rulecanvas-ui/src/**/*.ts', () => {
    const tsFiles = walkFiles(UI_SRC_DIR, (p) => p.endsWith('.ts'));
    expect(tsFiles.length).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const filePath of tsFiles) {
      violations.push(...checkUiImportsInSource(filePath, readFileSync(filePath, 'utf8')));
    }
    expect(violations).toEqual([]);

    // Self-check: allows @rulecanvas/core but rejects node:*, apps/*, and external npm packages
    expect(checkUiImportsInSource(path.join(UI_SRC_DIR, '__probe__.ts'), "import { replayTrace } from '@rulecanvas/core';")).toEqual([]);
    expect(checkUiImportsInSource(path.join(UI_SRC_DIR, '__probe__.ts'), "import { readFileSync } from 'node:fs';")).toHaveLength(1);
    expect(checkUiImportsInSource(path.join(UI_SRC_DIR, '__probe__.ts'), "import { x } from '../../../apps/agent-gate/src/index.js';")).toHaveLength(1);
    expect(checkUiImportsInSource(path.join(UI_SRC_DIR, '__probe__.ts'), "import React from 'react';")).toHaveLength(1);
    expect(checkUiImportsInSource(path.join(UI_SRC_DIR, '__probe__.ts'), "const m = import('./format.js');")).toHaveLength(1);
  });

  it('forbids non-deterministic or host-coupled APIs in packages/rulecanvas-ui/src/**/*.ts', () => {
    const tsFiles = walkFiles(UI_SRC_DIR, (p) => p.endsWith('.ts'));
    expect(tsFiles.length).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const filePath of tsFiles) {
      violations.push(...checkForbiddenApisInSource(filePath, readFileSync(filePath, 'utf8')));
    }
    expect(violations).toEqual([]);
  });

  it('contains zero domain leaks in packages/rulecanvas-ui/src/** filenames or contents', () => {
    const allSrcFiles = walkFiles(UI_SRC_DIR);
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
      const rel = path.relative(UI_SRC_DIR, filePath);
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

  it('enforces acyclic workspace package-manifest graph, strict layering, zero cross-app imports, and zero deep internal package imports', () => {
    const allowedRuntimeDeps: Readonly<Record<string, ReadonlySet<string>>> = {
      '@rulecanvas/core': new Set([]),
      '@rulecanvas/ui': new Set(['@rulecanvas/core']),
      '@rulecanvas/workbench': new Set(['@rulecanvas/core']),
      '@rulecanvas/workbench-react': new Set([
        '@rulecanvas/core',
        '@rulecanvas/ui',
        '@rulecanvas/workbench',
      ]),
      '@rulecanvas/agent-gate': new Set([
        '@rulecanvas/core',
        '@rulecanvas/ui',
        '@rulecanvas/workbench',
        '@rulecanvas/workbench-react',
        'react',
        'react-dom',
      ]),
      '@rulecanvas/interlock-sim': new Set([
        '@rulecanvas/core',
        '@rulecanvas/ui',
        '@rulecanvas/workbench',
        '@rulecanvas/workbench-react',
        'react',
        'react-dom',
      ]),
    };

    const allowedPeerDeps: Readonly<Record<string, ReadonlySet<string>>> = {
      '@rulecanvas/core': new Set([]),
      '@rulecanvas/ui': new Set([]),
      '@rulecanvas/workbench': new Set([]),
      '@rulecanvas/workbench-react': new Set(['react']),
      '@rulecanvas/agent-gate': new Set([]),
      '@rulecanvas/interlock-sim': new Set([]),
    };

    const allowedPackageSubpaths = new Set([
      '@rulecanvas/core',
      '@rulecanvas/ui',
      '@rulecanvas/workbench/verify',
      '@rulecanvas/workbench/verify-worker',
      '@rulecanvas/workbench/model-json',
      '@rulecanvas/workbench-react',
    ]);

    const graph = new Map<string, string[]>();
    const violations: string[] = [];

    for (const group of ['packages', 'apps'] as const) {
      const groupDir = path.join(REPO_ROOT, group);
      if (!existsSync(groupDir)) continue;
      for (const dirName of readdirSync(groupDir)) {
        const wsDir = path.join(groupDir, dirName);
        const pkgPath = path.join(wsDir, 'package.json');
        if (!existsSync(pkgPath)) continue;
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
          name?: string;
          dependencies?: Record<string, string>;
          peerDependencies?: Record<string, string>;
        };
        const name = pkg.name ?? dirName;
        const deps = Object.keys(pkg.dependencies ?? {});
        const peers = Object.keys(pkg.peerDependencies ?? {});
        const allowedRuntime = allowedRuntimeDeps[name];
        const allowedPeers = allowedPeerDeps[name];

        if (allowedRuntime !== undefined) {
          for (const dep of deps) {
            if (!allowedRuntime.has(dep)) {
              violations.push(`${name}: disallowed runtime dependency "${dep}"`);
            }
          }
        }
        if (allowedPeers !== undefined) {
          for (const peer of peers) {
            if (!allowedPeers.has(peer)) {
              violations.push(`${name}: disallowed peer dependency "${peer}"`);
            }
          }
        }

        const internalDeps = [...deps, ...peers].filter((d) => d.startsWith('@rulecanvas/'));
        graph.set(name, internalDeps);

        // Source-level checks across src/**/*.{ts,tsx}: no cross-app imports, no relative escapes, no disallowed @rulecanvas/* deep subpaths
        const srcDir = path.join(wsDir, 'src');
        if (!existsSync(srcDir)) continue;
        const srcFiles = walkFiles(srcDir, (p) => p.endsWith('.ts') || p.endsWith('.tsx'));
        for (const filePath of srcFiles) {
          const content = readFileSync(filePath, 'utf8');
          const parsed = parseSync(filePath, content, {
            lang: filePath.endsWith('.tsx') ? 'tsx' : 'ts',
          });
          const specs: string[] = [];
          const collect = (node: unknown): void => {
            if (node === null || typeof node !== 'object') return;
            if (Array.isArray(node)) {
              for (const item of node) collect(item);
              return;
            }
            const rec = node as Record<string, unknown>;
            if (
              (rec['type'] === 'ImportDeclaration' ||
                rec['type'] === 'ExportNamedDeclaration' ||
                rec['type'] === 'ExportAllDeclaration') &&
              rec['source'] &&
              typeof (rec['source'] as { value?: unknown }).value === 'string'
            ) {
              specs.push((rec['source'] as { value: string }).value);
            } else if (
              rec['type'] === 'ImportExpression' &&
              rec['source'] &&
              typeof (rec['source'] as { value?: unknown }).value === 'string'
            ) {
              specs.push((rec['source'] as { value: string }).value);
            }
            for (const val of Object.values(rec)) collect(val);
          };
          collect(parsed.program);

          const relFile = path.relative(REPO_ROOT, filePath);
          for (const spec of specs) {
            if (spec.startsWith('@rulecanvas/')) {
              if (!allowedPackageSubpaths.has(spec)) {
                violations.push(`${relFile}: disallowed @rulecanvas subpath "${spec}"`);
              }
              if (group === 'apps' && (spec.includes('agent-gate') || spec.includes('interlock-sim'))) {
                violations.push(`${relFile}: cross-app bare import "${spec}"`);
              }
            } else if (spec.startsWith('.')) {
              const resolved = path.resolve(path.dirname(filePath), spec);
              if (!resolved.startsWith(`${wsDir}${path.sep}`) && resolved !== wsDir) {
                violations.push(`${relFile}: relative import escapes workspace package ("${spec}")`);
              }
            }
          }
        }
      }
    }

    // Topological cycle detection (DFS 3-color)
    const state = new Map<string, 'visiting' | 'visited'>();
    const visit = (node: string, stack: string[]): void => {
      state.set(node, 'visiting');
      for (const next of graph.get(node) ?? []) {
        if (!graph.has(next)) continue;
        if (state.get(next) === 'visiting') {
          violations.push(`dependency cycle detected: ${[...stack, node, next].join(' -> ')}`);
        } else if (state.get(next) !== 'visited') {
          visit(next, [...stack, node]);
        }
      }
      state.set(node, 'visited');
    };
    for (const node of graph.keys()) {
      if (state.get(node) !== 'visited') visit(node, []);
    }

    expect(violations).toEqual([]);
  });
});
