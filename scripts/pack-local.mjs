#!/usr/bin/env node
// Packs the four shared libraries into a local tarball directory for the starter template.
// usage: node scripts/pack-local.mjs [--out DIR]   (default: ../rulecanvas-tarballs next to the repo)
//
// Publication contract:
//   1. All four archives are built, cleaned, preflight-validated, and allowlist-checked in a
//      temporary staging directory before the destination directory is modified.
//   2. `pack:local` assumes exclusive access to workspace `packages/*/dist` outputs and `outDir`
//      (concurrent writers or builds are unsupported). Because publication spans multiple
//      `renameSync` calls, it is not filesystem-wide atomic: concurrent readers of `outDir` may
//      briefly observe missing or mixed-version archives. Unrelated files and foreign `.tmp-*`/`.bak-*`
//      files are untouched.
//   3. Validated bytes are written to unique temporary files in `outDir`, existing target archives
//      are moved to sibling backup paths, and the four new archives are renamed into place.
//      If any write, backup, or rename fails in-process before all four archives are committed,
//      best-effort rollback removes committed files, restores backups in reverse order, deletes
//      temporary files owned by this invocation, and removes a freshly created empty `outDir`.
//   4. Limitations:
//      - Rollback is not unconditional: if rollback encounters OS/filesystem errors (e.g., EACCES,
//        EPERM, EIO), un-restored `.bak-<pid>-<token>-<file>` backups remain in `outDir` and are
//        named in the error message so an operator can manually rename them back to `<file>`.
//      - If post-commit backup cleanup fails after all four new archives are committed, the new
//        package set is preserved, cleanup continues across remaining backups, and the process
//        exits nonzero naming the leftover `.bak-*` paths for manual deletion.
//      - Abrupt process termination (e.g., SIGKILL or power loss) cannot run in-process cleanup
//        and may leave `.tmp-*`/`.bak-*` files or a partially updated set; inspect `.bak-*` files
//        to recover prior archives or remove stale `.tmp-*`/`.bak-*` files and re-run `pnpm run pack:local`.
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

function lstatOrNull(ops, target) {
  try {
    return ops.lstatSync(target);
  } catch (err) {
    if (err && typeof err === 'object' && err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Publishes a pre-validated set of `{ fileName, bytes }` archives into `outDir` with
 * pre-commit backup and best-effort reverse-order rollback on pre-commit errors.
 *
 * Once all four archives are committed, post-commit backup cleanup runs independently for
 * each backup without rolling back the published set; any cleanup failure exits nonzero
 * with every leftover backup path named for manual deletion.
 */
export function publishPackageSet(outDir, stagedTarballs, fsOps = DEFAULT_FS_OPS) {
  const ops = { ...DEFAULT_FS_OPS, ...fsOps };
  const outStat = lstatOrNull(ops, outDir);
  const dirExistedBefore = outStat !== null;
  if (dirExistedBefore) {
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

  // Pre-check that no target path is a directory and no run-scoped temp/backup path exists.
  if (dirExistedBefore) {
    for (const item of plan) {
      if (lstatOrNull(ops, item.finalDest)?.isDirectory()) {
        throw new Error(
          `pack:local failed: destination "${item.finalDest}" is a directory, not a regular file`,
        );
      }
      if (lstatOrNull(ops, item.tmpDest) !== null) {
        throw new Error(`pack:local failed: temporary path "${item.tmpDest}" already exists`);
      }
      if (lstatOrNull(ops, item.backupDest) !== null) {
        throw new Error(`pack:local failed: backup path "${item.backupDest}" already exists`);
      }
    }
  }

  const ownedTemps = [];
  const backedUp = [];
  const committed = [];

  try {
    // Phase 1: record ownership before writing so partial files from failed writes are cleaned up.
    for (const item of plan) {
      ownedTemps.push(item);
      ops.writeFileSync(item.tmpDest, item.bytes, { mode: 0o644, flag: 'wx' });
    }

    // Phase 2: move any existing target archives to sibling backups before placing new files.
    for (const item of plan) {
      if (lstatOrNull(ops, item.finalDest) !== null) {
        ops.renameSync(item.finalDest, item.backupDest);
        backedUp.push(item);
      }
    }

    // Phase 3: move all new temp archives into their final paths.
    for (const item of plan) {
      ops.renameSync(item.tmpDest, item.finalDest);
      const idx = ownedTemps.indexOf(item);
      if (idx !== -1) ownedTemps.splice(idx, 1);
      committed.push(item);
    }
  } catch (publishError) {
    const rollbackErrors = [];
    const preservedBackups = [];

    // Remove newly placed archives in reverse order.
    for (let i = committed.length - 1; i >= 0; i -= 1) {
      const item = committed[i];
      try {
        ops.rmSync(item.finalDest, { force: true });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        rollbackErrors.push(`remove ${item.finalDest}: ${msg}`);
      }
    }

    // Restore original archives from sibling backups in reverse order.
    for (let i = backedUp.length - 1; i >= 0; i -= 1) {
      const item = backedUp[i];
      try {
        ops.renameSync(item.backupDest, item.finalDest);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        preservedBackups.push(item.backupDest);
        rollbackErrors.push(
          `restore ${item.finalDest} from preserved backup ${item.backupDest}: ${msg}`,
        );
      }
    }

    // Remove only temporary files owned by this invocation.
    for (let i = ownedTemps.length - 1; i >= 0; i -= 1) {
      const item = ownedTemps[i];
      try {
        ops.rmSync(item.tmpDest, { force: true });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        rollbackErrors.push(`cleanup ${item.tmpDest}: ${msg}`);
      }
    }

    // If outDir was freshly created and is now empty, remove it.
    if (!dirExistedBefore) {
      try {
        if (lstatOrNull(ops, outDir) !== null) {
          const remaining = ops.readdirSync(outDir);
          if (remaining.length === 0) {
            ops.rmdirSync(outDir);
          } else if (rollbackErrors.length === 0) {
            rollbackErrors.push(
              `cleanup destination directory ${outDir}: directory not empty (${remaining.join(', ')})`,
            );
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        rollbackErrors.push(`cleanup destination directory ${outDir}: ${msg}`);
      }
    }

    const detail = publishError instanceof Error ? publishError.message : String(publishError);
    if (rollbackErrors.length > 0) {
      const preservedNote =
        preservedBackups.length > 0
          ? `; preserved backup(s) for manual recovery: ${preservedBackups.join(', ')}`
          : '';
      throw new Error(
        `pack:local publication failed (${detail}); rollback encountered errors: ${rollbackErrors.join('; ')}${preservedNote}`,
      );
    }
    if (dirExistedBefore) {
      throw new Error(
        `pack:local publication failed (${detail}); existing destination state was restored`,
      );
    }
    throw new Error(
      `pack:local publication failed (${detail}); newly created destination directory was removed`,
    );
  }

  // Phase 4: remove backups independently after all four archives are in place.
  const backupCleanupErrors = [];
  for (const item of backedUp) {
    try {
      ops.rmSync(item.backupDest, { force: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      backupCleanupErrors.push(`${item.backupDest}: ${msg}`);
    }
  }

  if (backupCleanupErrors.length > 0) {
    throw new Error(
      `pack:local publication succeeded (all ${plan.length} archives published to "${outDir}"), but backup cleanup failed for ${backupCleanupErrors.length} backup file(s): ${backupCleanupErrors.join('; ')}`,
    );
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
