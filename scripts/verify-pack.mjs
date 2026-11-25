import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
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

    // Inspect tarball contents in an isolated inspection dir (install happens via pnpm below)
    const inspectDir = path.join(tmpRoot, 'inspect', ...lib.name.split('/'));
    mkdirSync(inspectDir, { recursive: true });
    execFileSync('tar', ['-xzf', tgzPath, '--strip-components=1', '-C', inspectDir]);

    const packedPkg = JSON.parse(readFileSync(path.join(inspectDir, 'package.json'), 'utf8'));
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
      const jsFile = path.resolve(inspectDir, target.import);
      const dtsFile = path.resolve(inspectDir, target.types);
      assert(existsSync(jsFile), `${lib.name} ${subpath}: missing ${target.import} in tarball`);
      assert(existsSync(dtsFile), `${lib.name} ${subpath}: missing ${target.types} in tarball`);
    }

    for (const builtFile of walkFiles(path.join(inspectDir, 'dist'))) {
      const text = readFileSync(builtFile, 'utf8');
      assert(
        !text.includes('sourceMappingURL'),
        `${lib.name}: dangling sourceMappingURL in ${path.relative(inspectDir, builtFile)}`,
      );
    }
  }

  // Optional: copy packed tarballs + SHA-256 checksums for CI release evidence
  if (process.env.PACK_ARCHIVE_DIR) {
    mkdirSync(process.env.PACK_ARCHIVE_DIR, { recursive: true });
    const checksumLines = [];
    for (const lib of LIB_PACKAGES) {
      const tgzPath = packedTarballs.get(lib.name);
      const base = path.basename(tgzPath);
      const dst = path.join(process.env.PACK_ARCHIVE_DIR, base);
      cpSync(tgzPath, dst);
      const hash = createHash('sha256').update(readFileSync(dst)).digest('hex');
      checksumLines.push(`${hash}  ${base}`);
    }
    writeFileSync(
      path.join(process.env.PACK_ARCHIVE_DIR, 'SHA256SUMS.txt'),
      `${checksumLines.join('\n')}\n`,
    );
  }

  // 3. Read exact installed versions for offline pnpm consumer install (zero workspace symlinks)
  const readInstalledVersion = (pkgJsonPath) =>
    JSON.parse(readFileSync(pkgJsonPath, 'utf8')).version;
  const reactVer = readInstalledVersion(
    path.join(REPO_ROOT, 'apps/agent-gate/node_modules/react/package.json'),
  );
  const reactDomVer = readInstalledVersion(
    path.join(REPO_ROOT, 'apps/agent-gate/node_modules/react-dom/package.json'),
  );
  const typesReactVer = readInstalledVersion(
    path.join(REPO_ROOT, 'apps/agent-gate/node_modules/@types/react/package.json'),
  );
  const typesReactDomVer = readInstalledVersion(
    path.join(REPO_ROOT, 'apps/agent-gate/node_modules/@types/react-dom/package.json'),
  );
  const tsVer = readInstalledVersion(
    path.join(REPO_ROOT, 'node_modules/typescript/package.json'),
  );
  const viteVer = readInstalledVersion(
    path.join(REPO_ROOT, 'apps/agent-gate/node_modules/vite/package.json'),
  );

  const tarballSpecs = Object.fromEntries(
    LIB_PACKAGES.map((lib) => [lib.name, `file:${packedTarballs.get(lib.name)}`]),
  );

  // 4. Write minimal independent third-application booking-model fixture & install via pnpm --offline
  writeFileSync(
    path.join(consumerDir, 'package.json'),
    JSON.stringify(
      {
        name: 'booking-third-app-fixture',
        private: true,
        type: 'module',
        dependencies: {
          ...tarballSpecs,
          react: reactVer,
          'react-dom': reactDomVer,
        },
        devDependencies: {
          '@types/react': typesReactVer,
          '@types/react-dom': typesReactDomVer,
          typescript: tsVer,
          vite: viteVer,
        },
      },
      null,
      2,
    ),
  );
  const overrideLines = LIB_PACKAGES.map(
    (lib) => `  "${lib.name}": "file:${packedTarballs.get(lib.name)}"`,
  ).join('\n');
  writeFileSync(
    path.join(consumerDir, 'pnpm-workspace.yaml'),
    `overrides:\n${overrideLines}\n`,
  );
  execFileSync(
    'pnpm',
    ['install', '--offline', '--ignore-scripts', '--lockfile-only', '--no-frozen-lockfile'],
    { cwd: consumerDir, stdio: 'inherit' },
  );
  execFileSync('pnpm', ['install', '--offline', '--ignore-scripts', '--frozen-lockfile'], {
    cwd: consumerDir,
    stdio: 'inherit',
  });

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
    <main
      data-export-ok={exported.ok ? 'true' : 'false'}
      data-execution-mode={verification.snapshot?.executionMode}
      data-verification-revision={verification.snapshot?.revision}
    >
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

  // 6. Verify TypeScript declarations under BOTH NodeNext and Bundler resolution using consumer's installed tsc
  const tscBin = path.join(consumerDir, 'node_modules/.bin/tsc');
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

  // 7. Production Vite build under subpath /booking-demo/ using consumer's installed vite
  const viteBin = path.join(consumerDir, 'node_modules/.bin/vite');
  execFileSync(viteBin, ['build'], { cwd: consumerDir, stdio: 'inherit' });
  const distAssets = readdirSync(path.join(consumerDir, 'dist/assets'));
  assert(
    distAssets.some((f) => f.includes('verify.entry') && f.endsWith('.js')),
    `expected emitted worker bundle in third-app dist/assets, got: ${distAssets.join(', ')}`,
  );

  if (process.env.BOOKING_FIXTURE_DIST) {
    cpSync(path.join(consumerDir, 'dist'), process.env.BOOKING_FIXTURE_DIST, { recursive: true });
  }

  console.log(
    `verify:pack passed: all 4 tarballs map-free & allowlisted, Node ESM smoke passed, NodeNext + Bundler tsc passed, and third-app Vite subpath worker build emitted (${distAssets.join(', ')}).`,
  );
} finally {
  rmSync(tmpRoot, { recursive: true, force: true });
  // Restore workspace dev builds
  execFileSync('pnpm', ['run', 'build:libs'], { cwd: REPO_ROOT, stdio: 'pipe' });
}
