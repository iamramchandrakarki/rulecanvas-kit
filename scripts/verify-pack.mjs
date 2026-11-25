import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const LIB_PACKAGES = [
  { name: '@rulecanvas/core', dir: 'packages/rulecanvas-core' },
  { name: '@rulecanvas/ui', dir: 'packages/rulecanvas-ui' },
  { name: '@rulecanvas/workbench', dir: 'packages/rulecanvas-workbench' },
  { name: '@rulecanvas/workbench-react', dir: 'packages/rulecanvas-workbench-react' },
];

function assert(cond, msg) {
  if (!cond) {
    throw new Error(`verify:pack failed: ${msg}`);
  }
}

function walkFiles(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walkFiles(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'rulecanvas-pack-verify-'));
const tarDir = path.join(tmpRoot, 'tarballs');
const consumerDir = path.join(tmpRoot, 'third-app-consumer');
mkdirSync(tarDir, { recursive: true });
mkdirSync(consumerDir, { recursive: true });

try {
  // 1. Build map-free artifacts in dependency order and pack all 4 library tarballs
  const packedTarballs = new Map();
  for (const lib of LIB_PACKAGES) {
    const pkgDir = path.join(REPO_ROOT, lib.dir);
    execFileSync('pnpm', ['run', 'build:pack'], { cwd: pkgDir, stdio: 'inherit' });
    execFileSync('pnpm', ['pack', '--pack-destination', tarDir], { cwd: pkgDir, stdio: 'pipe' });
    const files = readdirSync(tarDir).filter((f) => f.endsWith('.tgz'));
    const expectedPrefix = `${lib.name.replace(/^@/, '').replace('/', '-')}-`;
    const match = files.find((f) => f.startsWith(expectedPrefix));
    assert(match !== undefined, `packed tarball missing for ${lib.name}`);
    const tgzPath = path.join(tarDir, match);
    packedTarballs.set(lib.name, tgzPath);

    // 2. Inspect tarball contents
    const tarEntries = execFileSync('tar', ['-tzf', tgzPath], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter(Boolean);

    assert(tarEntries.includes('package/package.json'), `${lib.name}: missing package.json in tarball`);
    assert(tarEntries.includes('package/README.md'), `${lib.name}: missing README.md in tarball`);
    assert(tarEntries.includes('package/LICENSE'), `${lib.name}: missing LICENSE in tarball`);

    for (const entry of tarEntries) {
      assert(!entry.endsWith('.map'), `${lib.name}: tarball must not include map file ${entry}`);
      assert(!entry.startsWith('package/src/'), `${lib.name}: tarball must not include src/ (${entry})`);
      assert(!entry.startsWith('package/tests/'), `${lib.name}: tarball must not include tests/ (${entry})`);
      assert(!entry.includes('.planning'), `${lib.name}: tarball leaked planning path (${entry})`);
    }

    // Extract into consumer/node_modules/@rulecanvas/<short> (zero workspace symlinks!)
    const extractDir = path.join(consumerDir, 'node_modules', ...lib.name.split('/'));
    mkdirSync(extractDir, { recursive: true });
    execFileSync('tar', ['-xzf', tgzPath, '--strip-components=1', '-C', extractDir]);

    const packedPkg = JSON.parse(readFileSync(path.join(extractDir, 'package.json'), 'utf8'));
    const depJson = JSON.stringify(packedPkg.dependencies ?? {});
    assert(!depJson.includes('workspace:'), `${lib.name}: workspace:* range not rewritten in tarball`);

    if (lib.name === '@rulecanvas/workbench-react') {
      assert(
        typeof packedPkg.peerDependencies?.react === 'string',
        '@rulecanvas/workbench-react must declare react as peerDependency',
      );
      assert(
        packedPkg.dependencies?.['react-dom'] === undefined,
        '@rulecanvas/workbench-react must not declare react-dom runtime dependency',
      );
    }

    for (const [subpath, target] of Object.entries(packedPkg.exports ?? {})) {
      const jsFile = path.resolve(extractDir, target.import);
      const dtsFile = path.resolve(extractDir, target.types);
      assert(existsSync(jsFile), `${lib.name} ${subpath}: missing ${target.import} in tarball`);
      assert(existsSync(dtsFile), `${lib.name} ${subpath}: missing ${target.types} in tarball`);
    }

    for (const builtFile of walkFiles(path.join(extractDir, 'dist'))) {
      const text = readFileSync(builtFile, 'utf8');
      assert(
        !text.includes('sourceMappingURL'),
        `${lib.name}: dangling sourceMappingURL in ${path.relative(extractDir, builtFile)}`,
      );
    }
  }

  // 3. Copy pinned React 19, types, and transitive type/runtime peers from offline pnpm store (zero workspace symlinks)
  const agentGateNodeModules = path.join(REPO_ROOT, 'apps/agent-gate/node_modules');
  const copyPkgTree = (srcPkgDir, dstName) => {
    const dst = path.join(consumerDir, 'node_modules', dstName);
    if (!existsSync(srcPkgDir) || existsSync(dst)) return;
    mkdirSync(path.dirname(dst), { recursive: true });
    cpSync(srcPkgDir, dst, { recursive: true, dereference: true });
    // Copy sibling transitive deps from pnpm virtual store (e.g. csstype for @types/react, scheduler for react-dom)
    const real = realpathSync(srcPkgDir);
    const parentStoreNm = dstName.startsWith('@') ? path.resolve(real, '../..') : path.resolve(real, '..');
    if (path.basename(parentStoreNm) === 'node_modules' && existsSync(parentStoreNm)) {
      for (const sibling of readdirSync(parentStoreNm)) {
        if (sibling.startsWith('.')) continue;
        const sibPath = path.join(parentStoreNm, sibling);
        if (sibling.startsWith('@')) {
          for (const scoped of readdirSync(sibPath)) {
            const scopedName = `${sibling}/${scoped}`;
            const dstSib = path.join(consumerDir, 'node_modules', scopedName);
            if (!existsSync(dstSib)) {
              mkdirSync(path.dirname(dstSib), { recursive: true });
              cpSync(path.join(sibPath, scoped), dstSib, { recursive: true, dereference: true });
            }
          }
        } else {
          const dstSib = path.join(consumerDir, 'node_modules', sibling);
          if (!existsSync(dstSib)) {
            cpSync(sibPath, dstSib, { recursive: true, dereference: true });
          }
        }
      }
    }
  };
  for (const dep of ['react', 'react-dom', '@types/react', '@types/react-dom']) {
    copyPkgTree(path.join(agentGateNodeModules, dep), dep);
  }

  // 4. Write minimal independent third-application booking-model fixture
  writeFileSync(
    path.join(consumerDir, 'package.json'),
    JSON.stringify(
      {
        name: 'booking-third-app-fixture',
        private: true,
        type: 'module',
      },
      null,
      2,
    ),
  );

  writeFileSync(
    path.join(consumerDir, 'booking-model.ts'),
    `import type { TransitionSystemModel } from '@rulecanvas/core';

export const bookingModel: TransitionSystemModel = {
  id: 'room-booking',
  name: 'Room Booking Fixture',
  schema: {
    seats: { kind: 'int', min: 0, max: 2 },
    confirmed: { kind: 'boolean' },
  },
  initialState: { seats: 0, confirmed: false },
  rules: [
    {
      id: 'reserve',
      label: 'Reserve seat',
      guard: { op: 'lt', left: { op: 'var', name: 'seats' }, right: { op: 'lit', value: 2 } },
      updates: [
        { var: 'seats', value: { op: 'add', left: { op: 'var', name: 'seats' }, right: { op: 'lit', value: 1 } } },
        { var: 'confirmed', value: { op: 'lit', value: true } },
      ],
    },
  ],
  invariants: [
    { id: 'inv_cap', label: 'Capacity respected', holds: { op: 'lte', left: { op: 'var', name: 'seats' }, right: { op: 'lit', value: 2 } } },
  ],
  goal: { id: 'goal_confirmed', label: 'Booking confirmed', reached: { op: 'var', name: 'confirmed' } },
  assumptions: [
    { id: 'asm_booking', category: 'scope', statement: 'Single-room discrete capacity.', notModeled: 'Payment retries.' },
  ],
};
`,
  );

  writeFileSync(
    path.join(consumerDir, 'verify.entry.ts'),
    `import { installVerifyWorker, type VerifyWorkerPort } from '@rulecanvas/workbench/verify-worker';
installVerifyWorker(self as unknown as VerifyWorkerPort);
`,
  );

  writeFileSync(
    path.join(consumerDir, 'App.tsx'),
    `import { validateModel } from '@rulecanvas/core';
import { buildVerdictSummaryView } from '@rulecanvas/ui';
import { createModelJsonCodec } from '@rulecanvas/workbench/model-json';
import { createVerifyClient } from '@rulecanvas/workbench/verify';
import {
  AssumptionsList,
  VerdictSummary,
  useVerificationSnapshot,
} from '@rulecanvas/workbench-react';
import { bookingModel } from './booking-model.js';

const codec = createModelJsonCodec();
const createClient = () =>
  createVerifyClient({
    execution: {
      kind: 'app-worker',
      createWorker: () =>
        new Worker(new URL('./verify.entry.ts', import.meta.url), { type: 'module' }) as never,
      asyncStartupError: 'fallback',
    },
  });

export function BookingApp() {
  const verification = useVerificationSnapshot({
    initialRequest: {
      model: bookingModel,
      options: { maxStates: 100, maxDepth: 10 },
      label: bookingModel.name,
      revision: 0,
    },
    createClient,
  });
  const diagnostics = validateModel(bookingModel);
  const view =
    verification.snapshot !== null ? buildVerdictSummaryView(verification.snapshot.result) : null;
  const exported = codec.encode(bookingModel);
  return (
    <main data-export-ok={exported.ok ? 'true' : 'false'}>
      <h1>{bookingModel.name}</h1>
      <button
        type="button"
        disabled={diagnostics.length > 0}
        onClick={() =>
          verification.run({
            model: bookingModel,
            options: { maxStates: 100, maxDepth: 10 },
            label: bookingModel.name,
            revision: 1,
          })
        }
      >
        Verify Booking Model
      </button>
      {view !== null && <VerdictSummary view={view} stale={false} />}
      <AssumptionsList items={bookingModel.assumptions} scope="verification-snapshot" />
    </main>
  );
}
`,
  );

  writeFileSync(
    path.join(consumerDir, 'main.tsx'),
    `import { createRoot } from 'react-dom/client';
import { BookingApp } from './App.js';
createRoot(document.getElementById('root')!).render(<BookingApp />);
`,
  );

  writeFileSync(
    path.join(consumerDir, 'index.html'),
    `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Booking Fixture</title></head>
  <body><div id="root"></div><script type="module" src="/main.tsx"></script></body>
</html>
`,
  );

  writeFileSync(
    path.join(consumerDir, 'vite.config.mjs'),
    `export default {
  base: '/booking-demo/',
  esbuild: { jsx: 'automatic' },
  worker: { format: 'es' },
};
`,
  );

  // 5. Run isolated Node ESM smoke check against installed tarballs (no browser globals)
  writeFileSync(
    path.join(consumerDir, 'node-smoke.mjs'),
    `import { verifyModel } from '@rulecanvas/core';
import { createVerdictReplaySession, parseStrictIntegerDraft } from '@rulecanvas/ui';
import { createModelJsonCodec } from '@rulecanvas/workbench/model-json';
import { createVerifyClient } from '@rulecanvas/workbench/verify';
import { isSafeSameOriginNavigationHref } from '@rulecanvas/workbench-react';

const model = {
  id: 'room-booking',
  name: 'Room Booking Fixture',
  schema: { seats: { kind: 'int', min: 0, max: 2 }, confirmed: { kind: 'boolean' } },
  initialState: { seats: 0, confirmed: false },
  rules: [{
    id: 'reserve',
    label: 'Reserve seat',
    guard: { op: 'lt', left: { op: 'var', name: 'seats' }, right: { op: 'lit', value: 2 } },
    updates: [
      { var: 'seats', value: { op: 'add', left: { op: 'var', name: 'seats' }, right: { op: 'lit', value: 1 } } },
      { var: 'confirmed', value: { op: 'lit', value: true } },
    ],
  }],
  invariants: [{ id: 'inv_cap', label: 'Cap', holds: { op: 'lte', left: { op: 'var', name: 'seats' }, right: { op: 'lit', value: 2 } } }],
  goal: { id: 'goal_confirmed', label: 'Confirmed', reached: { op: 'var', name: 'confirmed' } },
  assumptions: [{ id: 'a1', category: 'scope', statement: 'Discrete.', notModeled: 'Timing.' }],
};

const codec = createModelJsonCodec();
const enc = codec.encode(model);
if (!enc.ok) throw new Error('encode failed');
const dec = codec.decode(enc.text);
if (!dec.ok) throw new Error('decode failed');
const client = createVerifyClient({ execution: { kind: 'main-thread' } });
const settled = await client.verify(dec.model, { maxStates: 100, maxDepth: 10 });
if (settled.kind !== 'result' || settled.result.status !== 'VERIFIED' || !settled.result.goalReachable) {
  throw new Error('unexpected verification result');
}
const replay = createVerdictReplaySession(dec.model, verifyModel(dec.model, { maxStates: 100, maxDepth: 10 }));
if (!replay.ok) throw new Error('replay init failed');
if (!parseStrictIntegerDraft('42').ok) throw new Error('integer parse failed');
if (!isSafeSameOriginNavigationHref('/booking-demo/', '/booking-demo/')) throw new Error('nav href check failed');
client.dispose();
console.log('Isolated tarball Node ESM smoke passed.');
`,
  );
  execFileSync(process.execPath, [path.join(consumerDir, 'node-smoke.mjs')], {
    cwd: consumerDir,
    stdio: 'inherit',
  });

  // 6. Verify TypeScript declarations under BOTH NodeNext and Bundler resolution
  const tscBin = path.join(REPO_ROOT, 'node_modules/.bin/tsc');
  for (const [label, opts] of [
    ['NodeNext', { module: 'NodeNext', moduleResolution: 'NodeNext' }],
    ['Bundler', { module: 'ESNext', moduleResolution: 'Bundler' }],
  ]) {
    const tsconfigPath = path.join(consumerDir, `tsconfig.${label.toLowerCase()}.json`);
    writeFileSync(
      tsconfigPath,
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          lib: ['ES2022', 'DOM'],
          jsx: 'react-jsx',
          strict: true,
          noEmit: true,
          skipLibCheck: false,
          ...opts,
        },
        include: ['booking-model.ts', 'verify.entry.ts', 'App.tsx', 'main.tsx'],
      }),
    );
    execFileSync(tscBin, ['--noEmit', '-p', tsconfigPath], {
      cwd: consumerDir,
      stdio: 'inherit',
    });
  }

  // 7. Production Vite build under subpath /booking-demo/ verifying worker emission
  const viteBin = path.join(REPO_ROOT, 'apps/agent-gate/node_modules/.bin/vite');
  execFileSync(viteBin, ['build'], { cwd: consumerDir, stdio: 'inherit' });
  const distAssets = readdirSync(path.join(consumerDir, 'dist/assets'));
  assert(
    distAssets.some((f) => f.includes('verify.entry') && f.endsWith('.js')),
    `expected emitted worker bundle in third-app dist/assets, got: ${distAssets.join(', ')}`,
  );

  console.log(
    `verify:pack passed: all 4 tarballs map-free & allowlisted, Node ESM smoke passed, NodeNext + Bundler tsc passed, and third-app Vite subpath worker build emitted (${distAssets.join(', ')}).`,
  );
} finally {
  rmSync(tmpRoot, { recursive: true, force: true });
  // Restore workspace dev builds
  execFileSync('pnpm', ['run', 'build:libs'], { cwd: REPO_ROOT, stdio: 'pipe' });
}
