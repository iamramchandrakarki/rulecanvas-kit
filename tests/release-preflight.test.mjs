import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'release-preflight.mjs');
const BROWSER_TIMEOUT_MS = 300_000;
const RUN_TIMEOUT_MS = 240_000;

const PY_BUILDER = `
import sys, json, io, gzip, tarfile

def read_src(e):
    if 'src' in e:
        with open(e['src'], 'rb') as f:
            data = f.read()
    elif 'zeros' in e:
        data = bytes(e['zeros'])
    else:
        data = e.get('text', '').encode()
    if 'inject' in e:
        marker = b'<head>'
        i = data.index(marker) + len(marker)
        data = data[:i] + e['inject'].encode() + data[i:]
    return data

def build(spec):
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode='w') as tf:
        for e in spec['entries']:
            kind = e.get('type', 'file')
            ti = tarfile.TarInfo(e['name'])
            ti.mtime = 0
            if kind == 'dir':
                ti.type = tarfile.DIRTYPE
                ti.mode = 0o755
                tf.addfile(ti)
            elif kind == 'file':
                data = read_src(e)
                ti.size = len(data)
                ti.mode = 0o644
                tf.addfile(ti, io.BytesIO(data))
            else:
                ti.type = {'symlink': tarfile.SYMTYPE, 'hardlink': tarfile.LNKTYPE, 'chr': tarfile.CHRTYPE}[kind]
                ti.linkname = e.get('linkname', '')
                ti.mode = 0o644
                tf.addfile(ti)
    raw = buf.getvalue()
    if spec.get('trailing'):
        raw += b'X' * 512
    out = io.BytesIO()
    with gzip.GzipFile(fileobj=out, mode='wb', mtime=0) as gz:
        gz.write(raw)
    data = out.getvalue()
    if spec.get('truncate'):
        data = data[: len(data) // 2]
    with open(spec['out'], 'wb') as f:
        f.write(data)

for s in json.load(sys.stdin):
    build(s)
`;

const versions = Object.fromEntries(
  ['core', 'ui', 'workbench', 'workbench-react'].map((name) => [
    name,
    JSON.parse(readFileSync(path.join(REPO_ROOT, 'packages', `rulecanvas-${name}`, 'package.json'), 'utf8')).version,
  ]),
);
const LIB_NAMES = ['core', 'ui', 'workbench', 'workbench-react'].map(
  (name) => `rulecanvas-${name}-${versions[name]}.tgz`,
);
const STATIC_NAMES = ['agent-gate-static.tar.gz', 'interlock-sim-static.tar.gz'];
const ARCHIVE_NAMES = [...LIB_NAMES, ...STATIC_NAMES];
const MANIFEST = 'SHA256SUMS.txt';

const tempRoots = [];
after(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function distEntries(app, inject) {
  const dist = path.join(REPO_ROOT, 'apps', app, 'dist');
  if (!existsSync(path.join(dist, 'index.html'))) {
    assert.fail(`apps/${app}/dist is missing; run "pnpm build" before pnpm test:release:preflight`);
  }
  const entries = [{ name: '.', type: 'dir' }];
  const walk = (rel) => {
    for (const child of readdirSync(path.join(dist, rel)).sort()) {
      const childRel = rel === '' ? child : `${rel}/${child}`;
      const full = path.join(dist, childRel);
      if (lstatSync(full).isDirectory()) {
        entries.push({ name: `./${childRel}`, type: 'dir' });
        walk(childRel);
      } else {
        const entry = { name: `./${childRel}`, type: 'file', src: full };
        if (inject && childRel === 'index.html') entry.inject = inject;
        entries.push(entry);
      }
    }
  };
  walk('');
  return entries;
}

function buildArchives(specs) {
  const result = spawnSync('python3', ['-c', PY_BUILDER], {
    input: JSON.stringify(specs),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(result.status, 0, `python3 fixture builder failed: ${result.stderr}`);
}

function writeManifest(archiveDir, { extraLines = [], names = ARCHIVE_NAMES } = {}) {
  const lines = names.map((name) => `${sha256(readFileSync(path.join(archiveDir, name)))}  ${name}`);
  writeFileSync(path.join(archiveDir, MANIFEST), `${[...lines, ...extraLines].join('\n')}\n`);
}

/**
 * Creates an isolated sandbox with a valid archive directory and an empty parent for the output.
 * `staticEntries` maps an app to a function that rewrites its entry list.
 */
function createFixture({ agentEntries, interlockEntries, agentOptions = {}, agentInject, interlockInject } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'rulecanvas-preflight-'));
  tempRoots.push(root);
  const archiveDir = path.join(root, 'archives');
  const parent = path.join(root, 'parent');
  mkdirSync(archiveDir);
  mkdirSync(parent);
  const specs = LIB_NAMES.map((name) => ({
    out: path.join(archiveDir, name),
    entries: [
      { name: 'package', type: 'dir' },
      { name: 'package/package.json', type: 'file', text: JSON.stringify({ name, version: '0.0.0' }) },
    ],
  }));
  specs.push({
    out: path.join(archiveDir, 'agent-gate-static.tar.gz'),
    entries: agentEntries ?? distEntries('agent-gate', agentInject),
    ...agentOptions,
  });
  specs.push({
    out: path.join(archiveDir, 'interlock-sim-static.tar.gz'),
    entries: interlockEntries ?? distEntries('interlock-sim', interlockInject),
  });
  buildArchives(specs);
  writeManifest(archiveDir);
  return { root, archiveDir, parent, output: path.join(parent, 'published') };
}

function snapshot(dir) {
  return readdirSync(dir)
    .sort()
    .map((name) => {
      const full = path.join(dir, name);
      const st = lstatSync(full);
      const digest = st.isSymbolicLink()
        ? `link:${readlinkSync(full)}`
        : st.isFile()
          ? sha256(readFileSync(full))
          : 'non-file';
      return { name, size: st.size, mode: st.mode, mtimeMs: st.mtimeMs, digest };
    });
}

function runPreflight(args, env = process.env) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8',
    timeout: RUN_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });
}

function runFixture(fixture, env) {
  const before = snapshot(fixture.archiveDir);
  const result = runPreflight(['--archive-dir', fixture.archiveDir, '--output', fixture.output], env);
  return { result, before };
}

function assertFailure(fixture, run, check, artifacts, { expectedParent = [] } = {}) {
  const { result, before } = run;
  assert.notEqual(result.status, 0, `expected nonzero exit; stdout=${result.stdout} stderr=${result.stderr}`);
  assert.ok(
    result.stderr.includes(`preflight FAILED [${check}]`),
    `stderr should contain "preflight FAILED [${check}]" but was: ${result.stderr}`,
  );
  for (const artifact of artifacts) {
    assert.ok(result.stderr.includes(artifact), `stderr should name "${artifact}" but was: ${result.stderr}`);
  }
  assert.deepEqual(readdirSync(fixture.parent).sort(), expectedParent, 'parent directory must hold no staging or output entries');
  assert.deepEqual(snapshot(fixture.archiveDir), before, 'archive directory must be unchanged');
}

describe('release preflight: success', () => {
  test('publishes exactly agent-gate/ and interlock-sim/ after a clean run', { timeout: BROWSER_TIMEOUT_MS }, () => {
    const fixture = createFixture();
    const { result, before } = runFixture(fixture);
    assert.equal(result.status, 0, `stdout=${result.stdout} stderr=${result.stderr}`);
    assert.ok(result.stdout.includes(fixture.output), `stdout should name the output path: ${result.stdout}`);
    assert.deepEqual(readdirSync(fixture.output).sort(), ['agent-gate', 'interlock-sim']);
    for (const app of ['agent-gate', 'interlock-sim']) {
      assert.ok(lstatSync(path.join(fixture.output, app, 'index.html')).isFile());
    }
    assert.deepEqual(readdirSync(fixture.parent), ['published']);
    assert.deepEqual(snapshot(fixture.archiveDir), before);
  });
});

describe('release preflight: directory and manifest failures', () => {
  test('missing archive', () => {
    const fixture = createFixture();
    const missing = LIB_NAMES[1];
    rmSync(path.join(fixture.archiveDir, missing));
    assertFailure(fixture, runFixture(fixture), 'archive-listing', [missing]);
  });

  test('digest mismatch', () => {
    const fixture = createFixture();
    const victim = LIB_NAMES[2];
    buildArchives([
      {
        out: path.join(fixture.archiveDir, victim),
        entries: [{ name: 'package/package.json', type: 'file', text: '{"changed":true}' }],
      },
    ]);
    assertFailure(fixture, runFixture(fixture), 'checksum', [victim]);
  });

  test('extra file including rulecanvas-static-site.tar.gz', () => {
    const fixture = createFixture();
    writeFileSync(path.join(fixture.archiveDir, 'rulecanvas-static-site.tar.gz'), 'stale');
    assertFailure(fixture, runFixture(fixture), 'archive-listing', ['rulecanvas-static-site.tar.gz']);
  });

  test('duplicate manifest entry', () => {
    const fixture = createFixture();
    const dup = STATIC_NAMES[0];
    writeManifest(fixture.archiveDir, {
      extraLines: [`${sha256(readFileSync(path.join(fixture.archiveDir, dup)))}  ${dup}`],
    });
    assertFailure(fixture, runFixture(fixture), 'manifest', [dup]);
  });

  test('manifest entry outside the expected set', () => {
    const fixture = createFixture();
    writeManifest(fixture.archiveDir, { extraLines: [`${sha256('x')}  unexpected-artifact.tgz`] });
    assertFailure(fixture, runFixture(fixture), 'manifest', ['unexpected-artifact.tgz']);
  });

  test('symbolic-link archive', () => {
    const fixture = createFixture();
    const victim = LIB_NAMES[0];
    const target = path.join(fixture.root, 'real-target.tgz');
    writeFileSync(target, readFileSync(path.join(fixture.archiveDir, victim)));
    rmSync(path.join(fixture.archiveDir, victim));
    symlinkSync(target, path.join(fixture.archiveDir, victim));
    assertFailure(fixture, runFixture(fixture), 'archive-listing', [victim]);
  });

  test('subdirectory in the archive directory', () => {
    const fixture = createFixture();
    mkdirSync(path.join(fixture.archiveDir, 'nested-dir'));
    assertFailure(fixture, runFixture(fixture), 'archive-listing', ['nested-dir']);
  });

  test('existing output path is left unmodified', () => {
    const fixture = createFixture();
    writeFileSync(fixture.output, 'precious');
    const before = lstatSync(fixture.output);
    assertFailure(fixture, runFixture(fixture), 'output-path', [fixture.output], { expectedParent: ['published'] });
    assert.equal(readFileSync(fixture.output, 'utf8'), 'precious');
    const after = lstatSync(fixture.output);
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.equal(after.size, before.size);
  });

  for (const missingFlag of ['--archive-dir', '--output']) {
    test(`missing ${missingFlag} prints usage and creates nothing`, () => {
      const fixture = createFixture();
      const before = snapshot(fixture.archiveDir);
      const args =
        missingFlag === '--archive-dir'
          ? ['--output', fixture.output]
          : ['--archive-dir', fixture.archiveDir];
      const result = runPreflight(args);
      assert.notEqual(result.status, 0);
      assert.ok(result.stderr.includes('preflight FAILED [usage]'), result.stderr);
      assert.ok(result.stderr.includes('--archive-dir') && result.stderr.includes('--output'), result.stderr);
      assert.equal(existsSync(fixture.output), false);
      assert.deepEqual(readdirSync(fixture.parent), []);
      assert.deepEqual(snapshot(fixture.archiveDir), before);
    });
  }

  test('unloadable PLAYWRIGHT_MODULE fails before any staging', () => {
    // Fixture is missing an archive so that, if a fallback Playwright loads on this machine,
    // the run still fails deterministically at the listing check instead of launching Chromium.
    const fixture = createFixture();
    rmSync(path.join(fixture.archiveDir, LIB_NAMES[0]));
    const run = runFixture(fixture, { ...process.env, PLAYWRIGHT_MODULE: '/nonexistent/playwright/index.mjs' });
    if (run.result.stderr.includes('preflight FAILED [playwright]')) {
      assertFailure(fixture, run, 'playwright', ['PLAYWRIGHT_MODULE']);
    } else {
      assertFailure(fixture, run, 'archive-listing', [LIB_NAMES[0]]);
    }
  });
});

describe('release preflight: static archive defects', () => {
  const base = () => distEntries('agent-gate');
  const cases = [
    {
      title: 'symbolic-link member',
      token: 'preflight-evil-link',
      entries: () => [...base(), { name: './assets/preflight-evil-link', type: 'symlink', linkname: '/etc/passwd' }],
    },
    {
      title: 'hard-link member',
      token: 'preflight-evil-hardlink',
      entries: () => [...base(), { name: './assets/preflight-evil-hardlink', type: 'hardlink', linkname: './index.html' }],
    },
    {
      title: 'device member',
      token: 'preflight-evil-device',
      entries: () => [...base(), { name: './assets/preflight-evil-device', type: 'chr' }],
    },
    {
      title: 'absolute path',
      token: 'preflight-evil-abs',
      entries: () => [...base(), { name: '/tmp/preflight-evil-abs.txt', type: 'file', text: 'x' }],
    },
    {
      title: 'parent traversal path',
      token: 'preflight-evil-traversal',
      entries: () => [...base(), { name: '../preflight-evil-traversal.txt', type: 'file', text: 'x' }],
    },
    {
      title: 'duplicate path',
      token: 'preflight-dup.txt',
      entries: () => [
        ...base(),
        { name: './preflight-dup.txt', type: 'file', text: 'a' },
        { name: './preflight-dup.txt', type: 'file', text: 'b' },
      ],
    },
    {
      title: 'entry count of 2001',
      entries: () => [
        ...base().filter((e) => e.name === '.' || e.name === './index.html'),
        ...Array.from({ length: 1999 }, (_, i) => ({ name: `./many/f${i}.txt`, type: 'file', text: 'x' })),
      ],
    },
    {
      title: 'oversize file (16 MiB + 1)',
      entries: () => [...base(), { name: './assets/preflight-big.bin', type: 'file', zeros: 16 * 1024 * 1024 + 1 }],
    },
    {
      title: 'truncated gzip',
      options: { truncate: true },
      entries: () => base(),
    },
    {
      title: 'trailing garbage after end blocks',
      options: { trailing: true },
      entries: () => base(),
    },
    {
      title: 'missing index.html',
      entries: () => base().filter((e) => e.name !== './index.html'),
    },
  ];

  for (const { title, token, entries, options } of cases) {
    test(title, () => {
      const fixture = createFixture({ agentEntries: entries(), agentOptions: options });
      const artifacts = ['agent-gate-static.tar.gz'];
      if (token) artifacts.push(token);
      assertFailure(fixture, runFixture(fixture), 'archive', artifacts);
    });
  }
});

describe('release preflight: browser-stage failures', () => {
  const injections = [
    {
      title: 'main-thread fallback (Worker removed) prevents publication',
      script: `<script>Object.defineProperty(window,'Worker',{value:undefined})</script>`,
      artifacts: [],
    },
    {
      title: 'Browser_Error (console.error) prevents publication',
      script: `<script>console.error('preflight-fixture-error')</script>`,
      artifacts: [],
    },
  ];

  for (const { title, script, artifacts } of injections) {
    test(title, { timeout: BROWSER_TIMEOUT_MS }, () => {
      const fixture = createFixture({ agentInject: script, interlockInject: script });
      assertFailure(fixture, runFixture(fixture), 'browser', artifacts);
      assert.equal(existsSync(fixture.output), false);
    });
  }
});
