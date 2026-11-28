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
const CREATE_ARCHIVE_SCRIPT = path.join(REPO_ROOT, 'scripts', 'create-release-archive.py');
const PREFLIGHT_ARCHIVE_SCRIPT = path.join(REPO_ROOT, 'scripts', 'release-preflight-archive.py');
const FILESYSTEM_METADATA_NAMES = new Set(['.ds_store', '__macosx', 'thumbs.db', 'desktop.ini']);

function isFilesystemMetadataPath(entryPath) {
  return entryPath
    .split('/')
    .some((seg) => seg !== '' && (FILESYSTEM_METADATA_NAMES.has(seg.toLowerCase()) || seg.startsWith('._')));
}

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
const consumerDir = path.join(tmpRoot, 'starter-consumer');
mkdirSync(tarDir, { recursive: true });
mkdirSync(consumerDir, { recursive: true });

let verificationFailed = false;
try {
  // 1. Build map-free artifacts in dependency order and pack all 4 library tarballs
  const packedTarballs = new Map();
  for (const lib of LIB_PACKAGES) {
    const pkgDir = path.join(REPO_ROOT, lib.dir);
    execFileSync('pnpm', ['run', 'build:pack'], { cwd: pkgDir, stdio: 'inherit' });
    execFileSync('pnpm', ['pack', '--pack-destination', tarDir], {
      cwd: pkgDir,
      stdio: 'pipe',
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    });
    const { version } = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    const fileName = `${lib.name.replace(/^@/, '').replace('/', '-')}-${version}.tgz`;
    const tgzPath = path.join(tarDir, fileName);
    assert(existsSync(tgzPath), `packed tarball missing: ${fileName}`);
    execFileSync('python3', [CREATE_ARCHIVE_SCRIPT, 'clean-tgz', '--input', tgzPath], {
      stdio: 'inherit',
    });
    const tgzBytes = readFileSync(tgzPath);
    const tgzSha256 = createHash('sha256').update(tgzBytes).digest('hex');
    execFileSync(
      'python3',
      [PREFLIGHT_ARCHIVE_SCRIPT, '--name', fileName, '--sha256', tgzSha256],
      { input: tgzBytes, stdio: ['pipe', 'inherit', 'inherit'] },
    );
    packedTarballs.set(lib.name, tgzPath);

    // 2. Inspect tarball contents against a positive archive allowlist
    const tarEntries = execFileSync('tar', ['-tzf', tgzPath], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter(Boolean);

    for (const entry of tarEntries) {
      assert(
        !isFilesystemMetadataPath(entry),
        `${lib.name}: unintended filesystem metadata entry in tarball (${entry})`,
      );
    }

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
      cpSync(realDir, stagePkgDir, {
        recursive: true,
        dereference: true,
        filter: (src) => path.basename(src) !== 'node_modules',
      });

      const tgzPath = path.join(depTarDir, `${safeKey}-${pkgVersion}.tgz`);
      execFileSync('tar', ['-czf', tgzPath, '-C', stageParent, 'package'], {
        env: { ...process.env, COPYFILE_DISABLE: '1' },
      });
      depSpecs[pkgName] = `file:${tgzPath}`;

      const siblingNm = pkgName.startsWith('@')
        ? path.resolve(realDir, '../..')
        : path.resolve(realDir, '..');
      const childDeps = { ...(pkg.dependencies ?? {}), ...(pkg.optionalDependencies ?? {}) };
      for (const childName of Object.keys(childDeps)) {
        stageDirAsTarball(path.join(siblingNm, ...childName.split('/')));
      }
    };

    // Pack pinned React 19 peer, react-dom, TypeScript, Vite, and transitive deps from the locked repo store
    const agentGateNm = path.join(REPO_ROOT, 'apps/agent-gate/node_modules');
    for (const depName of ['react', 'react-dom', '@types/react', '@types/react-dom', 'vite']) {
      stageDirAsTarball(path.join(agentGateNm, ...depName.split('/')));
    }
    stageDirAsTarball(path.join(REPO_ROOT, 'node_modules/typescript'));

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
  const tarballSpecs = Object.fromEntries(
    LIB_PACKAGES.map((lib) => [lib.name, `file:${packedTarballs.get(lib.name)}`]),
  );
  const pinnedConsumerDeps = collectPinnedConsumerDepTarballs();
  const {
    react: pinnedReactSpec,
    'react-dom': pinnedReactDomSpec,
    '@types/react': pinnedTypesReactSpec,
    '@types/react-dom': pinnedTypesReactDomSpec,
    typescript: pinnedTsSpec,
    vite: pinnedViteSpec,
    ...pinnedTransitiveSpecs
  } = pinnedConsumerDeps;
  assert(
    typeof pinnedReactSpec === 'string' &&
      typeof pinnedReactDomSpec === 'string' &&
      typeof pinnedTsSpec === 'string' &&
      typeof pinnedViteSpec === 'string',
    'Missing pinned consumer tarballs from locked workspace store',
  );

  // 4. Copy the starter template (single source of truth for the consumer fixture), point its
  //    dependencies at the packed and pinned tarballs, and install via pnpm --offline.
  const STARTER_DIR = path.join(REPO_ROOT, 'templates', 'workbench-starter');
  assert(existsSync(path.join(STARTER_DIR, 'package.json')), 'templates/workbench-starter is missing');
  cpSync(STARTER_DIR, consumerDir, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(STARTER_DIR, src);
      const top = rel.split(path.sep)[0];
      return top !== 'node_modules' && top !== 'dist' && top !== 'pnpm-lock.yaml';
    },
  });
  const starterPkg = JSON.parse(readFileSync(path.join(consumerDir, 'package.json'), 'utf8'));
  for (const name of [...LIB_PACKAGES.map((lib) => lib.name), 'react', 'react-dom']) {
    assert(typeof starterPkg.dependencies?.[name] === 'string', `starter template must depend on ${name}`);
  }
  for (const name of ['@types/react', '@types/react-dom', 'typescript', 'vite']) {
    assert(typeof starterPkg.devDependencies?.[name] === 'string', `starter template must devDepend on ${name}`);
  }
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    assert(
      !JSON.stringify(starterPkg[field] ?? {}).includes('workspace:'),
      `starter template ${field} must not use workspace: ranges`,
    );
  }
  writeFileSync(
    path.join(consumerDir, 'package.json'),
    JSON.stringify(
      {
        ...starterPkg,
        dependencies: {
          ...starterPkg.dependencies,
          ...tarballSpecs,
          react: pinnedReactSpec,
          'react-dom': pinnedReactDomSpec,
        },
        devDependencies: {
          ...starterPkg.devDependencies,
          '@types/react': pinnedTypesReactSpec,
          '@types/react-dom': pinnedTypesReactDomSpec,
          typescript: pinnedTsSpec,
          vite: pinnedViteSpec,
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
  // Replaces the template's own pnpm-workspace.yaml (which points at ../rulecanvas-tarballs).
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

  // 5. Node ESM smoke check against installed tarballs (no browser globals), then the template's tests
  writeFileSync(
    path.join(consumerDir, 'node-smoke.mjs'),
    `import { verifyModel } from '@rulecanvas/core';
import { createVerdictReplaySession, parseStrictIntegerDraft } from '@rulecanvas/ui';
import { createModelJsonCodec } from '@rulecanvas/workbench/model-json';
import { createVerifyClient } from '@rulecanvas/workbench/verify';
import { isSafeSameOriginNavigationHref } from '@rulecanvas/workbench-react';
import { RELEASE_GATE_MODELS, VERIFY_OPTIONS } from './src/release-gate.ts';

const codec = createModelJsonCodec(undefined, { duplicateKeys: 'reject' });
const enc = codec.encode(RELEASE_GATE_MODELS.principled);
if (!enc.ok) throw new Error('encode failed');
const dec = codec.decode(enc.text);
if (!dec.ok) throw new Error('decode failed');
const client = createVerifyClient({ execution: { kind: 'main-thread' } });
const settled = await client.verify(dec.model, VERIFY_OPTIONS);
if (settled.kind !== 'result' || settled.result.status !== 'VERIFIED' || !settled.result.goalReachable) {
  throw new Error('unexpected verification result for the principled release gate');
}
const broken = verifyModel(RELEASE_GATE_MODELS.broken, VERIFY_OPTIONS);
const replay = createVerdictReplaySession(RELEASE_GATE_MODELS.broken, broken);
if (broken.status !== 'VIOLATED' || !replay.ok) throw new Error('broken release gate replay failed');
if (!parseStrictIntegerDraft('42').ok) throw new Error('integer parse failed');
if (!isSafeSameOriginNavigationHref('/starter/', '/starter/')) throw new Error('nav href check failed');
client.dispose();
console.log('Isolated tarball Node ESM smoke passed.');
`,
  );
  execFileSync(process.execPath, [path.join(consumerDir, 'node-smoke.mjs')], {
    cwd: consumerDir,
    stdio: 'inherit',
  });
  execFileSync(process.execPath, ['--test', 'tests/**/*.test.mjs'], { cwd: consumerDir, stdio: 'inherit' });

  // 6. Verify TypeScript declarations under BOTH NodeNext and Bundler resolution with the template's
  //    own tsconfig files (strict, skipLibCheck false) and the consumer's installed tsc
  const tscBin = path.join(consumerDir, 'node_modules/.bin/tsc');
  for (const tsconfig of ['tsconfig.json', 'tsconfig.nodenext.json']) {
    const shown = execFileSync(tscBin, ['--showConfig', '-p', tsconfig], { cwd: consumerDir, encoding: 'utf8' });
    const { compilerOptions } = JSON.parse(shown);
    const resolution = String(compilerOptions.moduleResolution).toLowerCase();
    assert(compilerOptions.strict === true, `${tsconfig}: strict must be enabled`);
    assert(compilerOptions.skipLibCheck !== true, `${tsconfig}: skipLibCheck must stay off`);
    assert(
      resolution === (tsconfig === 'tsconfig.json' ? 'bundler' : 'nodenext'),
      `${tsconfig}: unexpected moduleResolution ${compilerOptions.moduleResolution}`,
    );
    execFileSync(tscBin, ['--noEmit', '-p', tsconfig], { cwd: consumerDir, stdio: 'inherit' });
  }

  // 7. Production Vite build (relative base) using the consumer's installed vite
  const viteBin = path.join(consumerDir, 'node_modules/.bin/vite');
  execFileSync(viteBin, ['build'], { cwd: consumerDir, stdio: 'inherit' });
  const distAssets = readdirSync(path.join(consumerDir, 'dist/assets'));
  assert(
    distAssets.some((f) => f.includes('verify.worker') && f.endsWith('.js')),
    `expected emitted worker bundle in starter dist/assets, got: ${distAssets.join(', ')}`,
  );

  const starterDistTarget = process.env.STARTER_FIXTURE_DIST || process.env.BOOKING_FIXTURE_DIST;
  if (starterDistTarget) {
    cpSync(path.join(consumerDir, 'dist'), starterDistTarget, { recursive: true });
  }

  console.log(
    `verify:pack passed: all 4 tarballs map-free & allowlisted, Node ESM smoke passed, NodeNext + Bundler tsc passed, starter template node --test, and starter Vite worker build emitted (${distAssets.join(', ')}).`,
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
