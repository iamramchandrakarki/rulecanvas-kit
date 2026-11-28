#!/usr/bin/env node
// Packs the four shared libraries into a local tarball directory for the starter template.
// usage: node scripts/pack-local.mjs [--out DIR]   (default: ../rulecanvas-tarballs next to the repo)
//
// Publication contract:
//   1. All four archives are built, cleaned, preflight-validated, and allowlist-checked in a
//      temporary staging directory before the destination directory is modified.
//   2. Validated bytes are written to unique temporary files in the destination directory,
//      existing target archives are moved to sibling backup paths, and the four new archives
//      are renamed into place. Unrelated files in the destination directory are untouched.
//   3. If any write, backup, or rename operation fails in-process, committed archives are
//      removed, backed-up targets are restored in reverse order, temporary files are deleted,
//      and the process exits nonzero with an actionable error message.
//   Limitation: Multi-file rename with in-process rollback is not crash-atomic; abrupt
//   process termination (e.g., SIGKILL or power loss) mid-publication can leave temporary
//   or backup files or a partially updated set that requires re-running `pnpm run pack:local`.
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
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

const DEFAULT_FS_OPS = {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
};

/**
 * Publishes a pre-validated set of `{ fileName, bytes }` archives into `outDir` with
 * pre-commit backup and reverse-order rollback on any in-process publication error.
 */
export function publishPackageSet(outDir, stagedTarballs, fsOps = DEFAULT_FS_OPS) {
  const ops = { ...DEFAULT_FS_OPS, ...fsOps };
  const dirExistedBefore = ops.existsSync(outDir);
  if (dirExistedBefore) {
    const outStat = ops.lstatSync(outDir);
    if (!outStat.isDirectory()) {
      throw new Error(`pack:local failed: destination "${outDir}" exists and is not a directory`);
    }
  } else {
    ops.mkdirSync(outDir, { recursive: true });
  }

  const runToken = `${process.pid}-${randomBytes(4).toString('hex')}`;
  const plan = stagedTarballs.map(({ fileName, bytes }) => ({
    fileName,
    bytes,
    tmpDest: path.join(outDir, `.tmp-${runToken}-${fileName}`),
    backupDest: path.join(outDir, `.bak-${runToken}-${fileName}`),
    finalDest: path.join(outDir, fileName),
  }));

  // Pre-check that no target path is a directory before mutating anything.
  for (const item of plan) {
    if (ops.existsSync(item.finalDest)) {
      const st = ops.lstatSync(item.finalDest);
      if (st.isDirectory()) {
        throw new Error(
          `pack:local failed: destination "${item.finalDest}" is a directory, not a regular file`,
        );
      }
    }
  }

  const writtenTemps = [];
  const backedUp = [];
  const committed = [];

  try {
    // Phase 1: write all validated archives into unique temp files in outDir.
    for (const item of plan) {
      ops.writeFileSync(item.tmpDest, item.bytes, { mode: 0o644 });
      writtenTemps.push(item);
    }

    // Phase 2: move any existing target archives to sibling backups before placing new files.
    for (const item of plan) {
      if (ops.existsSync(item.finalDest)) {
        ops.renameSync(item.finalDest, item.backupDest);
        backedUp.push(item);
      }
    }

    // Phase 3: move all new temp archives into their final paths.
    for (const item of plan) {
      ops.renameSync(item.tmpDest, item.finalDest);
      committed.push(item);
    }
  } catch (publishError) {
    const rollbackErrors = [];

    // Remove newly placed archives in reverse order.
    for (let i = committed.length - 1; i >= 0; i -= 1) {
      const item = committed[i];
      try {
        ops.rmSync(item.finalDest, { force: true });
      } catch (err) {
        rollbackErrors.push(`remove ${item.fileName}: ${err.message}`);
      }
    }

    // Restore original archives from sibling backups in reverse order.
    for (let i = backedUp.length - 1; i >= 0; i -= 1) {
      const item = backedUp[i];
      try {
        ops.renameSync(item.backupDest, item.finalDest);
      } catch (err) {
        rollbackErrors.push(`restore ${item.fileName}: ${err.message}`);
      }
    }

    // Remove any remaining temporary files.
    for (const item of writtenTemps) {
      try {
        ops.rmSync(item.tmpDest, { force: true });
      } catch (err) {
        rollbackErrors.push(`cleanup ${path.basename(item.tmpDest)}: ${err.message}`);
      }
    }

    // If outDir was freshly created and is now empty, remove it.
    if (!dirExistedBefore) {
      try {
        if (ops.existsSync(outDir) && ops.readdirSync(outDir).length === 0) {
          ops.rmdirSync(outDir);
        }
      } catch {
        // Best-effort cleanup of empty freshly created directory.
      }
    }

    const detail = publishError instanceof Error ? publishError.message : String(publishError);
    if (rollbackErrors.length > 0) {
      throw new Error(
        `pack:local publication failed (${detail}); rollback encountered errors: ${rollbackErrors.join('; ')}`,
      );
    }
    throw new Error(
      `pack:local publication failed (${detail}); existing destination state was restored`,
    );
  }

  // Phase 4: remove backups only after all four archives are in place.
  for (const item of backedUp) {
    ops.rmSync(item.backupDest, { force: true });
  }

  return plan.map((item) => item.finalDest);
}

function main() {
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

    const publishedPaths = publishPackageSet(out, stagedTarballs);
    for (const publishedPath of publishedPaths) {
      process.stdout.write(`${publishedPath}\n`);
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
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
