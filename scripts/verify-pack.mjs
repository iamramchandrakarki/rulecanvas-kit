import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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

let verificationFailed = false;
try {
  // 1. Build map-free artifacts in dependency order and pack all 4 library tarballs
  const packedTarballs = new Map();
  for (const lib of LIB_PACKAGES) {
    const pkgDir = path.join(REPO_ROOT, lib.dir);
    execFileSync('pnpm', ['run', 'build:pack'], { cwd: pkgDir, stdio: 'inherit' });
    execFileSync('pnpm', ['pack', '--pack-destination', tarDir], { cwd: pkgDir, stdio: 'pipe' });
    const { version } = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    const fileName = `${lib.name.replace(/^@/, '').replace('/', '-')}-${version}.tgz`;
    const tgzPath = path.join(tarDir, fileName);
    assert(existsSync(tgzPath), `packed tarball missing: ${fileName}`);
    packedTarballs.set(lib.name, tgzPath);

    // 2. Inspect tarball contents against a positive archive allowlist
    const tarEntries = execFileSync('tar', ['-tzf', tgzPath], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter(Boolean);

    const fileEntries = tarEntries.filter((entry) => !entry.endsWith('/'));
    assert(fileEntries.includes('package/package.json'), `${lib.name}: missing package.json in tarball`);
    assert(fileEntries.includes('package/README.md'), `${lib.name}: missing README.md in tarball`);
    assert(fileEntries.includes('package/LICENSE'), `${lib.name}: missing LICENSE in tarball`);

    let builtJsCount = 0;
    let builtDtsCount = 0;
    for (const entry of fileEntries) {
      const inAllowlist =
        entry === 'package/package.json' ||
        entry === 'package/README.md' ||
        entry === 'package/LICENSE' ||
        /^package\/dist\/.+\.(?:js|d\.ts|d\.mts)$/.test(entry);
      assert(inAllowlist, `${lib.name}: unexpected archive entry outside allowlist (${entry})`);
      if (/^package\/dist\/.+\.js$/.test(entry)) builtJsCount += 1;
      if (/^package\/dist\/.+\.d\.(?:ts|mts)$/.test(entry)) builtDtsCount += 1;
    }
    assert(builtJsCount > 0 && builtDtsCount > 0, `${lib.name}: missing dist JS or .d.ts files in tarball`);

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

  function collectPinnedConsumerDepTarballs() {
    const depSpecs = {};
    const stageDirAsTarball = (entryPath) => {
      if (!existsSync(entryPath)) return;
      const realDir = realpathSync(entryPath);
      const pkgJsonPath = path.join(realDir, 'package.json');
      if (!existsSync(pkgJsonPath)) return;
      const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
      const pkgName = pkg.name;
      const pkgVersion = pkg.version;
      if (typeof pkgName !== 'string' || typeof pkgVersion !== 'string') return;
      if (Object.hasOwn(depSpecs, pkgName)) return;

      const safeKey = pkgName.replace(/^@/, '').replaceAll('/', '-');
      const stageParent = path.join(tmpRoot, 'dep-stage', safeKey);
      const stagePkgDir = path.join(stageParent, 'package');
      const depTarDir = path.join(tmpRoot, 'dep-tarballs');
      mkdirSync(stageParent, { recursive: true });
      mkdirSync(depTarDir, { recursive: true });
      cpSync(realDir, stagePkgDir, { recursive: true, dereference: true });

      const tgzPath = path.join(depTarDir, `${safeKey}-${pkgVersion}.tgz`);
      execFileSync('tar', ['-czf', tgzPath, '-C', stageParent, 'package']);
      depSpecs[pkgName] = `file:${tgzPath}`;
    };

    // Pack pinned React 19 peer, react-dom, TypeScript types, and transitive peers from the locked repo store
    const agentGateNm = path.join(REPO_ROOT, 'apps/agent-gate/node_modules');
    for (const depName of ['react', 'react-dom', '@types/react', '@types/react-dom']) {
      const linkPath = path.join(agentGateNm, ...depName.split('/'));
      stageDirAsTarball(linkPath);
      if (existsSync(linkPath)) {
        const realDep = realpathSync(linkPath);
        const siblingNm = depName.startsWith('@')
          ? path.resolve(realDep, '../..')
          : path.resolve(realDep, '..');
        for (const sibling of ['scheduler', 'csstype']) {
          const sibPath = path.join(siblingNm, sibling);
          if (existsSync(sibPath)) {
            stageDirAsTarball(sibPath);
          }
        }
      }
    }

    // Pack host-platform native optional packages from the frozen pnpm virtual store
    const virtualStore = path.join(REPO_ROOT, 'node_modules/.pnpm');
    if (existsSync(virtualStore)) {
      for (const entry of readdirSync(virtualStore)) {
        if (entry.startsWith('rolldown@')) {
          const scopeDir = path.join(virtualStore, entry, 'node_modules/@rolldown');
          if (existsSync(scopeDir)) {
            for (const sub of readdirSync(scopeDir)) {
              if (sub.startsWith('binding-')) {
                stageDirAsTarball(path.join(scopeDir, sub));
              }
            }
          }
        } else if (entry.startsWith('lightningcss@')) {
          const modDir = path.join(virtualStore, entry, 'node_modules');
          if (existsSync(modDir)) {
            for (const sub of readdirSync(modDir)) {
              if (sub.startsWith('lightningcss-')) {
                stageDirAsTarball(path.join(modDir, sub));
              }
            }
          }
        } else if (entry.startsWith('typescript@')) {
          const scopeDir = path.join(virtualStore, entry, 'node_modules/@typescript');
          if (existsSync(scopeDir)) {
            for (const sub of readdirSync(scopeDir)) {
              if (sub.startsWith('typescript-')) {
                stageDirAsTarball(path.join(scopeDir, sub));
              }
            }
          }
        }
      }
    }
    return depSpecs;
  }

  // 3. Read exact installed versions and pack pinned offline tarballs (zero workspace symlinks)
  const readInstalledVersion = (pkgJsonPath) =>
    JSON.parse(readFileSync(pkgJsonPath, 'utf8')).version;
  const reactVer = readInstalledVersion(
    path.join(REPO_ROOT, 'apps/agent-gate/node_modules/react/package.json'),
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
  const pinnedConsumerDeps = collectPinnedConsumerDepTarballs();
  const {
    react: pinnedReactSpec,
    'react-dom': pinnedReactDomSpec,
    '@types/react': pinnedTypesReactSpec,
    '@types/react-dom': pinnedTypesReactDomSpec,
    ...pinnedTransitiveSpecs
  } = pinnedConsumerDeps;
  assert(
    typeof pinnedReactSpec === 'string' && typeof pinnedReactDomSpec === 'string',
    'Missing pinned React 19 tarballs from locked workspace store',
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
          react: pinnedReactSpec,
          'react-dom': pinnedReactDomSpec,
        },
        devDependencies: {
          '@types/react': pinnedTypesReactSpec,
          '@types/react-dom': pinnedTypesReactDomSpec,
          typescript: tsVer,
          vite: viteVer,
          ...pinnedTransitiveSpecs,
        },
      },
      null,
      2,
    ),
  );
  const allOverrideSpecs = {
    ...tarballSpecs,
    ...pinnedConsumerDeps,
  };
  const overrideLines = Object.entries(allOverrideSpecs)
    .map(([name, spec]) => `  "${name}": "${spec}"`)
    .join('\n');
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
  for (const pkgName of [...LIB_PACKAGES.map((l) => l.name), 'react', 'react-dom']) {
    const installedPath = path.join(consumerDir, 'node_modules', ...pkgName.split('/'));
    assert(existsSync(installedPath), `${pkgName}: missing in isolated consumer node_modules`);
    assert(
      !realpathSync(installedPath).startsWith(REPO_ROOT),
      `${pkgName}: resolved via workspace symlink instead of packed tarball`,
    );
  }
  assert(
    readInstalledVersion(path.join(consumerDir, 'node_modules/react/package.json')) === reactVer,
    'Installed React version does not match pinned workspace lockfile version',
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
} catch (error) {
  verificationFailed = true;
  throw error;
} finally {
  rmSync(tmpRoot, { recursive: true, force: true });
  try {
    execFileSync('pnpm', ['run', 'build:libs'], { cwd: REPO_ROOT, stdio: 'pipe' });
  } catch (error) {
    if (!verificationFailed) throw error;
    console.error('Workspace build restoration also failed:', error.message);
  }
}
