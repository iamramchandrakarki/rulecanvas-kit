#!/usr/bin/env node
// Release-only preflight: validates the CI artifact directory, extracts the static
// archives into a staging directory, runs Chromium checks, then publishes with one rename.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runBrowserChecks } from './release-preflight-browser.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const HELPER = path.join(SCRIPT_DIR, 'release-preflight-archive.py');
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MANIFEST = 'SHA256SUMS.txt';
const STATIC_APPS = [
  { app: 'agent-gate', file: 'agent-gate-static.tar.gz' },
  { app: 'interlock-sim', file: 'interlock-sim-static.tar.gz' },
];
const USAGE = 'usage: node scripts/release-preflight.mjs --archive-dir DIR --output DIR';

class PreflightError extends Error {
  constructor(check, artifact, detail) {
    super(detail);
    this.check = check;
    this.artifact = artifact;
  }
}

function parseArgs(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if ((flag !== '--archive-dir' && flag !== '--output') || value === undefined || value === '' || flag in values) {
      throw new PreflightError('usage', '-', `invalid arguments. ${USAGE}`);
    }
    values[flag] = value;
  }
  if (!values['--archive-dir'] || !values['--output']) {
    throw new PreflightError('usage', '-', `--archive-dir and --output are both required. ${USAGE}`);
  }
  return { archiveDir: path.resolve(values['--archive-dir']), output: path.resolve(values['--output']) };
}

function lstatOrNull(target) {
  try {
    return lstatSync(target);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function checkOutputPath(output) {
  if (lstatOrNull(output) !== null) {
    throw new PreflightError('output-path', output, 'output path already exists');
  }
  const parent = path.dirname(output);
  const st = lstatOrNull(parent);
  if (st === null || !st.isDirectory()) {
    throw new PreflightError('output-path', parent, 'output parent directory does not exist');
  }
}

async function loadChromium() {
  const candidates = [
    process.env.PLAYWRIGHT_MODULE,
    'playwright',
    '/opt/homebrew/lib/node_modules/@playwright/cli/node_modules/playwright/index.mjs',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const spec = candidate.startsWith('/') ? pathToFileURL(candidate).href : candidate;
      const mod = await import(spec);
      const chromium = mod?.chromium ?? mod?.default?.chromium;
      if (chromium) return chromium;
    } catch {
      // try next candidate
    }
  }
  throw new PreflightError(
    'playwright',
    'PLAYWRIGHT_MODULE',
    'Playwright module not found. Set PLAYWRIGHT_MODULE or install playwright.',
  );
}

function expectedArchiveNames() {
  const libs = ['core', 'ui', 'workbench', 'workbench-react'].map((name) => {
    const manifestPath = path.join(REPO_ROOT, 'packages', `rulecanvas-${name}`, 'package.json');
    const { version } = JSON.parse(readFileSync(manifestPath, 'utf8'));
    return `rulecanvas-${name}-${version}.tgz`;
  });
  return { libs, all: [...libs, ...STATIC_APPS.map((s) => s.file)] };
}

function checkListing(archiveDir, archiveNames) {
  const expected = new Set([...archiveNames, MANIFEST]);
  const st = lstatOrNull(archiveDir);
  if (st === null || !st.isDirectory()) {
    throw new PreflightError('archive-listing', archiveDir, 'archive directory is missing or not a directory');
  }
  const present = readdirSync(archiveDir).sort();
  const problems = [];
  for (const name of present) {
    const entry = lstatSync(path.join(archiveDir, name));
    if (!entry.isFile()) {
      const kind = entry.isSymbolicLink() ? 'symbolic link' : entry.isDirectory() ? 'subdirectory' : 'non-regular entry';
      problems.push(`${name}: ${kind}`);
    } else if (!expected.has(name)) {
      problems.push(`${name}: unexpected file`);
    }
  }
  for (const name of expected) {
    if (!present.includes(name)) problems.push(`${name}: missing`);
  }
  if (problems.length > 0) {
    throw new PreflightError('archive-listing', problems.map((p) => p.split(':')[0]).join(', '), problems.join('; '));
  }
}

function parseManifest(archiveDir, archiveNames) {
  const text = readCaptured(path.join(archiveDir, MANIFEST), 1024 * 1024, MANIFEST).toString('utf8');
  if (text.length === 0) throw new PreflightError('manifest', MANIFEST, 'manifest is empty');
  if (!text.endsWith('\n')) throw new PreflightError('manifest', MANIFEST, 'manifest lacks a final LF');
  const lines = text.slice(0, -1).split('\n');
  const digests = new Map();
  lines.forEach((line, index) => {
    const label = `line ${index + 1}`;
    const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    if (!match) throw new PreflightError('manifest', MANIFEST, `${label} is malformed: ${JSON.stringify(line)}`);
    const [, digest, name] = match;
    if (name.includes('/') || name.includes('\\') || name.startsWith('.')) {
      throw new PreflightError('manifest', name, `${label} names a path-like or dot-leading file: ${name}`);
    }
    if (digests.has(name)) throw new PreflightError('manifest', name, `${label} repeats ${name}`);
    if (!archiveNames.includes(name)) {
      throw new PreflightError('manifest', name, `${label} names ${name}, which is outside the expected set`);
    }
    digests.set(name, digest);
  });
  const omitted = archiveNames.filter((name) => !digests.has(name));
  if (omitted.length > 0) {
    throw new PreflightError('manifest', omitted.join(', '), `manifest omits ${omitted.join(', ')}`);
  }
  return digests;
}

function readCaptured(file, limit, artifact) {
  let fd;
  try {
    fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const st = fstatSync(fd);
    if (!st.isFile()) throw new PreflightError('archive-listing', artifact, 'not a regular file');
    if (st.size > limit) throw new PreflightError('archive', artifact, `file exceeds ${limit} bytes`);
    const buffer = Buffer.alloc(st.size);
    let offset = 0;
    while (offset < st.size) {
      const n = readSync(fd, buffer, offset, st.size - offset, offset);
      if (n === 0) break;
      offset += n;
    }
    return buffer.subarray(0, offset);
  } catch (error) {
    if (error instanceof PreflightError) throw error;
    throw new PreflightError('archive-listing', artifact, `cannot read: ${error.code ?? error.message}`);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function runHelper(name, bytes, digest, dest) {
  const args = [HELPER, '--name', name, '--sha256', digest];
  if (dest) args.push('--dest', dest, '--require-index');
  return new Promise((resolve, reject) => {
    const child = spawn('python3', args, { stdio: ['pipe', 'ignore', 'pipe'] });
    const stderrChunks = [];
    let stderrBytes = 0;
    const maxStderr = 16 * 1024 * 1024;
    child.stderr.on('data', (chunk) => {
      if (stderrBytes < maxStderr) {
        stderrChunks.push(chunk);
        stderrBytes += chunk.length;
      }
    });
    child.stdin.on('error', (error) => {
      if (error.code !== 'EPIPE') {
        reject(new PreflightError('archive', name, `cannot write to python3: ${error.message}`));
      }
    });
    child.on('error', (error) => {
      reject(new PreflightError('archive', name, `cannot run python3: ${error.message}`));
    });
    child.on('close', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
      const detail = stderr || `helper exited with ${signal ? `signal ${signal}` : `status ${code}`}`;
      reject(new PreflightError('archive', name, detail));
    });
    child.stdin.end(bytes);
  });
}

async function main() {
  const { archiveDir, output } = parseArgs(process.argv.slice(2));
  checkOutputPath(output);
  const chromium = await loadChromium();
  const { libs, all } = expectedArchiveNames();
  checkListing(archiveDir, all);
  const manifest = parseManifest(archiveDir, all);

  const captured = new Map();
  for (const name of all) {
    const bytes = readCaptured(path.join(archiveDir, name), MAX_ARCHIVE_BYTES, name);
    const actual = createHash('sha256').update(bytes).digest('hex');
    const expected = manifest.get(name);
    if (actual !== expected) {
      throw new PreflightError('checksum', name, `expected ${expected}, computed ${actual}`);
    }
    captured.set(name, bytes);
  }

  let staging = null;
  let published = false;
  try {
    staging = mkdtempSync(path.join(path.dirname(output), '.release-preflight-staging-'));
    for (const name of libs) await runHelper(name, captured.get(name), manifest.get(name));
    for (const { app, file } of STATIC_APPS) {
      await runHelper(file, captured.get(file), manifest.get(file), path.join(staging, app));
    }
    try {
      await runBrowserChecks({ chromium, stagingDir: staging });
    } catch (error) {
      throw new PreflightError('browser', 'staged apps', error.message);
    }
    chmodSync(staging, 0o755);
    renameSync(staging, output);
    published = true;
  } finally {
    if (staging !== null && !published) rmSync(staging, { recursive: true, force: true });
  }
  process.stdout.write(`${output}\n`);
}

main().then(
  () => process.exit(0),
  (error) => {
    if (error instanceof PreflightError) {
      process.stderr.write(`preflight FAILED [${error.check}] ${error.artifact}: ${error.message}\n`);
      process.exit(error.check === 'usage' ? 2 : 1);
    }
    process.stderr.write(`preflight FAILED [internal] -: ${error?.stack ?? error}\n`);
    process.exit(1);
  },
);
