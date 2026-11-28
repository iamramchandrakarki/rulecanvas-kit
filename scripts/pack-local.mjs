#!/usr/bin/env node
// Packs the four shared libraries into a local tarball directory for the starter template.
// usage: node scripts/pack-local.mjs [--out DIR]   (default: ../rulecanvas-tarballs next to the repo)
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CREATE_ARCHIVE_SCRIPT = path.join(REPO_ROOT, 'scripts', 'create-release-archive.py');
const LIBS = ['core', 'ui', 'workbench', 'workbench-react'];

function parseOut(argv) {
  if (argv.length === 0) return path.resolve(REPO_ROOT, '..', 'rulecanvas-tarballs');
  if (argv.length === 2 && argv[0] === '--out' && argv[1] !== '') return path.resolve(argv[1]);
  process.stderr.write('usage: node scripts/pack-local.mjs [--out DIR]\n');
  process.exit(2);
}

const out = parseOut(process.argv.slice(2));
mkdirSync(out, { recursive: true });

let failed = false;
try {
  for (const lib of LIBS) {
    const dir = path.join(REPO_ROOT, 'packages', `rulecanvas-${lib}`);
    const { version } = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
    // build:pack emits map-free output matching the published file allowlist.
    execFileSync('pnpm', ['run', 'build:pack'], { cwd: dir, stdio: 'inherit' });
    execFileSync('pnpm', ['pack', '--pack-destination', out], {
      cwd: dir,
      stdio: 'pipe',
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    });
    const tarball = path.join(out, `rulecanvas-${lib}-${version}.tgz`);
    if (!existsSync(tarball)) throw new Error(`expected ${tarball} after pnpm pack`);
    execFileSync('python3', [CREATE_ARCHIVE_SCRIPT, 'clean-tgz', '--input', tarball], {
      stdio: 'inherit',
    });
    process.stdout.write(`${tarball}\n`);
  }
} catch (error) {
  failed = true;
  throw error;
} finally {
  // Restore the regular workspace builds (with source maps) that build:pack replaced.
  try {
    execFileSync('pnpm', ['run', 'build:libs'], { cwd: REPO_ROOT, stdio: 'pipe' });
  } catch (error) {
    if (!failed) throw error;
    process.stderr.write(`workspace build restoration also failed: ${error.message}\n`);
  }
}
