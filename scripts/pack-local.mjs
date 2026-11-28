#!/usr/bin/env node
// Packs the four shared libraries into a local tarball directory for the starter template.
// usage: node scripts/pack-local.mjs [--out DIR]   (default: ../rulecanvas-tarballs next to the repo)
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CREATE_ARCHIVE_SCRIPT = path.join(REPO_ROOT, 'scripts', 'create-release-archive.py');
const PREFLIGHT_ARCHIVE_SCRIPT = path.join(REPO_ROOT, 'scripts', 'release-preflight-archive.py');
const LIBS = ['core', 'ui', 'workbench', 'workbench-react'];
const FILESYSTEM_METADATA_NAMES = new Set(['.ds_store', '__macosx', 'thumbs.db', 'desktop.ini']);

function isFilesystemMetadataPath(entryPath) {
  return entryPath
    .split('/')
    .some((seg) => seg !== '' && (FILESYSTEM_METADATA_NAMES.has(seg.toLowerCase()) || seg.startsWith('._')));
}

function assert(cond, msg) {
  if (!cond) throw new Error(`pack:local failed: ${msg}`);
}

function parseOut(argv) {
  if (argv.length === 0) return path.resolve(REPO_ROOT, '..', 'rulecanvas-tarballs');
  if (argv.length === 2 && argv[0] === '--out' && argv[1] !== '') return path.resolve(argv[1]);
  process.stderr.write('usage: node scripts/pack-local.mjs [--out DIR]\n');
  process.exit(2);
}

const out = parseOut(process.argv.slice(2));
const stageDir = mkdtempSync(path.join(os.tmpdir(), 'rulecanvas-pack-local-'));

let failed = false;
try {
  const stagedTarballs = [];
  for (const lib of LIBS) {
    const pkgName = `@rulecanvas/${lib}`;
    const dir = path.join(REPO_ROOT, 'packages', `rulecanvas-${lib}`);
    const { version } = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const fileName = `rulecanvas-${lib}-${version}.tgz`;
    // build:pack emits map-free output matching the published file allowlist.
    execFileSync('pnpm', ['run', 'build:pack'], { cwd: dir, stdio: 'inherit' });
    execFileSync('pnpm', ['pack', '--pack-destination', stageDir], {
      cwd: dir,
      stdio: 'pipe',
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    });
    const stagedPath = path.join(stageDir, fileName);
    assert(existsSync(stagedPath), `expected ${fileName} after pnpm pack`);

    execFileSync('python3', [CREATE_ARCHIVE_SCRIPT, 'clean-tgz', '--input', stagedPath], {
      stdio: 'inherit',
    });

    const tgzBytes = readFileSync(stagedPath);
    const tgzSha256 = createHash('sha256').update(tgzBytes).digest('hex');
    execFileSync(
      'python3',
      [PREFLIGHT_ARCHIVE_SCRIPT, '--name', fileName, '--sha256', tgzSha256],
      { input: tgzBytes, stdio: ['pipe', 'inherit', 'inherit'] },
    );

    const tarEntries = execFileSync('tar', ['-tzf', stagedPath], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter(Boolean);
    for (const entry of tarEntries) {
      assert(!isFilesystemMetadataPath(entry), `${pkgName}: unintended filesystem metadata (${entry})`);
    }
    const fileEntries = tarEntries.filter((entry) => !entry.endsWith('/'));
    assert(fileEntries.includes('package/package.json'), `${pkgName}: missing package.json`);
    assert(fileEntries.includes('package/README.md'), `${pkgName}: missing README.md`);
    assert(fileEntries.includes('package/LICENSE'), `${pkgName}: missing LICENSE`);
    let builtJsCount = 0;
    let builtDtsCount = 0;
    for (const entry of fileEntries) {
      const inAllowlist =
        entry === 'package/package.json' ||
        entry === 'package/README.md' ||
        entry === 'package/LICENSE' ||
        /^package\/dist\/.+\.(?:js|d\.ts|d\.mts)$/.test(entry);
      assert(inAllowlist, `${pkgName}: unexpected archive entry outside allowlist (${entry})`);
      if (/^package\/dist\/.+\.js$/.test(entry)) builtJsCount += 1;
      if (/^package\/dist\/.+\.d\.(?:ts|mts)$/.test(entry)) builtDtsCount += 1;
    }
    assert(builtJsCount > 0 && builtDtsCount > 0, `${pkgName}: missing dist JS or .d.ts files`);

    stagedTarballs.push({ fileName, bytes: tgzBytes });
  }

  // Publish all four validated archives atomically only after every archive passes preflight.
  mkdirSync(out, { recursive: true });
  const tempOutputs = [];
  try {
    for (const { fileName, bytes } of stagedTarballs) {
      const tmpDest = path.join(out, `.tmp-${process.pid}-${fileName}`);
      writeFileSync(tmpDest, bytes, { mode: 0o644 });
      tempOutputs.push({ tmpDest, finalDest: path.join(out, fileName) });
    }
    for (const { tmpDest, finalDest } of tempOutputs) {
      renameSync(tmpDest, finalDest);
      process.stdout.write(`${finalDest}\n`);
    }
  } catch (error) {
    for (const { tmpDest } of tempOutputs) {
      rmSync(tmpDest, { force: true });
    }
    throw error;
  }
} catch (error) {
  failed = true;
  throw error;
} finally {
  rmSync(stageDir, { recursive: true, force: true });
  // Restore the regular workspace builds (with source maps) that build:pack replaced.
  try {
    execFileSync('pnpm', ['run', 'build:libs'], { cwd: REPO_ROOT, stdio: 'pipe' });
  } catch (error) {
    if (!failed) throw error;
    process.stderr.write(`workspace build restoration also failed: ${error.message}\n`);
  }
}
