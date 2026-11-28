import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PACKAGES = [
  'packages/rulecanvas-core',
  'packages/rulecanvas-ui',
  'packages/rulecanvas-workbench',
  'packages/rulecanvas-workbench-react',
];

function assert(cond, msg) {
  if (!cond) {
    throw new Error(`verify:exports failed: ${msg}`);
  }
}

// 1. Verify every declared export target exists on disk
const resolvedExports = new Map();
for (const relPkg of PACKAGES) {
  const pkgDir = path.join(REPO_ROOT, relPkg);
  const pkg = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
  assert(typeof pkg.exports === 'object' && pkg.exports !== null, `${pkg.name} missing exports map`);
  for (const [subpath, target] of Object.entries(pkg.exports)) {
    assert(typeof target.import === 'string', `${pkg.name} ${subpath} missing import target`);
    assert(typeof target.types === 'string', `${pkg.name} ${subpath} missing types target`);
    const jsPath = path.resolve(pkgDir, target.import);
    const dtsPath = path.resolve(pkgDir, target.types);
    assert(existsSync(jsPath), `${pkg.name} ${subpath} built JS missing: ${jsPath}`);
    assert(existsSync(dtsPath), `${pkg.name} ${subpath} built d.ts missing: ${dtsPath}`);
    const key = subpath === '.' ? pkg.name : `${pkg.name}/${subpath.replace(/^\.\//, '')}`;
    resolvedExports.set(key, pathToFileURL(jsPath).href);
  }
}

// 2. Verify SSR-safe Node ESM imports without DOM globals
assert(typeof globalThis.window === 'undefined', 'expected pure Node environment without window');

const core = await import(resolvedExports.get('@rulecanvas/core'));
assert(typeof core.verifyModel === 'function', '@rulecanvas/core missing verifyModel');
assert(typeof core.validateModel === 'function', '@rulecanvas/core missing validateModel');

const ui = await import(resolvedExports.get('@rulecanvas/ui'));
assert(typeof ui.parseStrictIntegerDraft === 'function', '@rulecanvas/ui missing parseStrictIntegerDraft');
assert(typeof ui.indexModelDiagnostics === 'function', '@rulecanvas/ui missing indexModelDiagnostics');
assert(typeof ui.createVerdictReplaySession === 'function', '@rulecanvas/ui missing createVerdictReplaySession');
assert(
  typeof ui.buildVerificationReportFromSnapshot === 'function',
  '@rulecanvas/ui missing buildVerificationReportFromSnapshot',
);
assert(typeof ui.verifyAndBuildReport === 'function', '@rulecanvas/ui missing verifyAndBuildReport');
assert(
  typeof ui.formatVerificationReportMarkdown === 'function',
  '@rulecanvas/ui missing formatVerificationReportMarkdown',
);
assert(
  typeof ui.serializeVerificationReportJson === 'function',
  '@rulecanvas/ui missing serializeVerificationReportJson',
);
assert(typeof ui.sanitizeReportFilename === 'function', '@rulecanvas/ui missing sanitizeReportFilename');
assert(typeof ui.computeVerdictDelta === 'function', '@rulecanvas/ui missing computeVerdictDelta');

const wbVerify = await import(resolvedExports.get('@rulecanvas/workbench/verify'));
assert(typeof wbVerify.createVerifyClient === 'function', '@rulecanvas/workbench/verify missing createVerifyClient');

const wbWorker = await import(resolvedExports.get('@rulecanvas/workbench/verify-worker'));
assert(typeof wbWorker.installVerifyWorker === 'function', '@rulecanvas/workbench/verify-worker missing installVerifyWorker');

const wbJson = await import(resolvedExports.get('@rulecanvas/workbench/model-json'));
assert(typeof wbJson.createModelJsonCodec === 'function', '@rulecanvas/workbench/model-json missing createModelJsonCodec');

const wbReact = await import(resolvedExports.get('@rulecanvas/workbench-react'));
assert(typeof wbReact.useVerificationSnapshot === 'function', '@rulecanvas/workbench-react missing useVerificationSnapshot');
assert(typeof wbReact.WorkbenchNavigation === 'function', '@rulecanvas/workbench-react missing WorkbenchNavigation');
assert(typeof wbReact.createWorkbenchHistoryController === 'function', '@rulecanvas/workbench-react missing createWorkbenchHistoryController');

// 3. Verify plain Node/tsx SSR-safe import of both application entry modules (zero Vite globals)
execFileSync(
  'pnpm',
  [
    'exec',
    'tsx',
    '-e',
    "import('./apps/agent-gate/src/App.tsx').then((a) => import('./apps/interlock-sim/src/App.tsx').then((b) => { if (typeof a.App !== 'function' || typeof b.App !== 'function') process.exit(1); }))",
  ],
  { cwd: REPO_ROOT, stdio: 'inherit' },
);

console.log('verify:exports passed across all 4 library packages, 6 public entry points, and SSR app module imports (zero DOM globals).');
