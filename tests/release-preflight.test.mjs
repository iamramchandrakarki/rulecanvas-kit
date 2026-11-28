import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { publishPackageSet } from '../scripts/pack-local.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'release-preflight.mjs');
const CREATE_ARCHIVE_SCRIPT = path.join(REPO_ROOT, 'scripts', 'create-release-archive.py');
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
const STATIC_NAMES = ['agent-gate-static.tar.gz', 'interlock-sim-static.tar.gz', 'site-static.tar.gz'];
const SITE_DIR = path.join(REPO_ROOT, 'site');
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
  return treeEntries(dist, inject);
}

function treeEntries(dist, inject) {
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
function createFixture({
  agentEntries,
  interlockEntries,
  siteEntries,
  agentOptions = {},
  agentInject,
  interlockInject,
  siteInject,
} = {}) {
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
  specs.push({
    out: path.join(archiveDir, 'site-static.tar.gz'),
    entries: siteEntries ?? treeEntries(SITE_DIR, siteInject),
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
  test('publishes the hub at the root with agent-gate/ and interlock-sim/ beside it', { timeout: BROWSER_TIMEOUT_MS }, () => {
    const fixture = createFixture();
    const { result, before } = runFixture(fixture);
    assert.equal(result.status, 0, `stdout=${result.stdout} stderr=${result.stderr}`);
    assert.ok(result.stdout.includes(fixture.output), `stdout should name the output path: ${result.stdout}`);
    assert.deepEqual(
      readdirSync(fixture.output).sort(),
      [...readdirSync(SITE_DIR), 'agent-gate', 'interlock-sim'].sort(),
    );
    assert.equal(readFileSync(path.join(fixture.output, 'index.html'), 'utf8'), readFileSync(path.join(SITE_DIR, 'index.html'), 'utf8'));
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

describe('release preflight: hub archive', () => {
  test('missing site-static.tar.gz', () => {
    const fixture = createFixture();
    rmSync(path.join(fixture.archiveDir, 'site-static.tar.gz'));
    writeManifest(fixture.archiveDir, { names: ARCHIVE_NAMES.filter((name) => name !== 'site-static.tar.gz') });
    assertFailure(fixture, runFixture(fixture), 'archive-listing', ['site-static.tar.gz']);
  });

  const collisions = [
    { title: 'top-level agent-gate/ directory', entries: [{ name: 'agent-gate', type: 'dir' }] },
    { title: 'top-level interlock-sim file', entries: [{ name: './interlock-sim', type: 'file', text: 'x' }] },
    {
      title: 'case-folded Interlock-Sim/ member',
      entries: [{ name: 'Interlock-Sim/index.html', type: 'file', text: '<!doctype html>' }],
    },
  ];
  for (const { title, entries } of collisions) {
    test(`rejects a ${title} in the hub archive`, () => {
      const fixture = createFixture({
        siteEntries: [...treeEntries(SITE_DIR), ...entries],
      });
      assertFailure(fixture, runFixture(fixture), 'archive', ['site-static.tar.gz', 'collides with a reserved directory']);
    });
  }

  test('hub archive without index.html', () => {
    const fixture = createFixture({
      siteEntries: treeEntries(SITE_DIR).filter((entry) => entry.name !== './index.html'),
    });
    assertFailure(fixture, runFixture(fixture), 'archive', ['site-static.tar.gz', 'missing index.html']);
  });

  test('Browser_Error on the hub (console.error) prevents publication', { timeout: BROWSER_TIMEOUT_MS }, () => {
    const fixture = createFixture({ siteInject: `<script>console.error('preflight-hub-error')</script>` });
    assertFailure(fixture, runFixture(fixture), 'browser', ['app=hub', 'preflight-hub-error']);
    assert.equal(existsSync(fixture.output), false);
  });

  test('hub request to another origin prevents publication', { timeout: BROWSER_TIMEOUT_MS }, () => {
    const fixture = createFixture({
      siteInject: `<link rel="stylesheet" href="https://cdn.example.invalid/x.css">`,
    });
    assertFailure(fixture, runFixture(fixture), 'browser', ['cdn.example.invalid']);
    assert.equal(existsSync(fixture.output), false);
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

describe('release preflight: filesystem metadata artifacts', () => {
  const metadataMembers = [
    { title: 'root .DS_Store', entry: { name: './.DS_Store', type: 'file', text: 'junk' } },
    { title: 'nested .DS_Store', entry: { name: './assets/.DS_Store', type: 'file', text: 'junk' } },
    { title: 'lowercase .ds_store', entry: { name: './.ds_store', type: 'file', text: 'junk' } },
    { title: 'mixed-case .Ds_StOrE', entry: { name: './.Ds_StOrE', type: 'file', text: 'junk' } },
    { title: '__MACOSX directory', entry: { name: './__MACOSX', type: 'dir' } },
    { title: 'lowercase __macosx directory', entry: { name: './__macosx', type: 'dir' } },
    { title: '__MACOSX AppleDouble entry', entry: { name: './__MACOSX/._index.html', type: 'file', text: 'junk' } },
    { title: 'mixed-case __MacOSX AppleDouble entry', entry: { name: './__MacOSX/._INDEX.HTML', type: 'file', text: 'junk' } },
    { title: 'root AppleDouble ._index.html', entry: { name: './._index.html', type: 'file', text: 'junk' } },
    { title: 'uppercase AppleDouble ._INDEX.HTML', entry: { name: './._INDEX.HTML', type: 'file', text: 'junk' } },
    { title: 'Thumbs.db', entry: { name: './Thumbs.db', type: 'file', text: 'junk' } },
    { title: 'nested uppercase THUMBS.DB', entry: { name: './nested/THUMBS.DB', type: 'file', text: 'junk' } },
    { title: 'mixed-case ThUmBs.Db', entry: { name: './ThUmBs.Db', type: 'file', text: 'junk' } },
    { title: 'Desktop.ini', entry: { name: './Desktop.ini', type: 'file', text: 'junk' } },
    { title: 'uppercase DESKTOP.INI', entry: { name: './nested/DESKTOP.INI', type: 'file', text: 'junk' } },
  ];

  for (const { title, entry } of metadataMembers) {
    test(`rejects ${title} in agent-gate-static.tar.gz`, () => {
      const fixture = createFixture({ agentEntries: [...distEntries('agent-gate'), entry] });
      assertFailure(fixture, runFixture(fixture), 'archive', [
        'agent-gate-static.tar.gz',
        'unintended filesystem metadata artifact',
      ]);
    });

    test(`rejects ${title} in site-static.tar.gz`, () => {
      const fixture = createFixture({ siteEntries: [...treeEntries(SITE_DIR), entry] });
      assertFailure(fixture, runFixture(fixture), 'archive', [
        'site-static.tar.gz',
        'unintended filesystem metadata artifact',
      ]);
    });
  }

  for (const { title, entry } of metadataMembers) {
    test(`rejects ${title} in library .tgz`, () => {
      const fixture = createFixture();
      const libName = LIB_NAMES[0];
      const pkgEntry =
        entry.type === 'dir'
          ? { name: `package/${entry.name.replace(/^\.\//, '')}`, type: 'dir' }
          : { name: `package/${entry.name.replace(/^\.\//, '')}`, type: 'file', text: entry.text };
      buildArchives([
        {
          out: path.join(fixture.archiveDir, libName),
          entries: [
            { name: 'package', type: 'dir' },
            { name: 'package/package.json', type: 'file', text: JSON.stringify({ name: libName, version: '0.0.0' }) },
            pkgEntry,
          ],
        },
      ]);
      writeManifest(fixture.archiveDir);
      assertFailure(fixture, runFixture(fixture), 'archive', [
        libName,
        'unintended filesystem metadata artifact',
      ]);
    });
  }
});

describe('release preflight: archive creation and metadata exclusion integration', () => {
  const METADATA_NAMES = new Set(['.ds_store', '__macosx', 'thumbs.db', 'desktop.ini']);

  function hasMetadataSegment(memberName) {
    return memberName
      .split('/')
      .some((seg) => seg !== '' && (METADATA_NAMES.has(seg.toLowerCase()) || seg.startsWith('._')));
  }

  function addMixedCaseMetadata(dir) {
    const nestedDir = path.join(dir, 'nested');
    mkdirSync(nestedDir, { recursive: true });
    for (const rel of [
      '.DS_Store',
      '.ds_store',
      '.Ds_StOrE',
      'Thumbs.db',
      'THUMBS.DB',
      'nested/THUMBS.DB',
      'nested/ThUmBs.Db',
      'Desktop.ini',
      'DESKTOP.INI',
      'nested/deSkTop.InI',
      '__MACOSX/._index.html',
      '__macosx/junk.txt',
      'nested/__MacOSX/file.txt',
      '._index.html',
      'nested/._ASSET.JS',
    ]) {
      const target = path.join(dir, rel);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, 'junk\n', 'utf8');
    }
  }

  function listTreeNames(rootDir) {
    const out = [];
    const walk = (rel) => {
      for (const name of readdirSync(path.join(rootDir, rel))) {
        const childRel = rel === '' ? name : `${rel}/${name}`;
        out.push(childRel);
        if (lstatSync(path.join(rootDir, childRel)).isDirectory()) {
          walk(childRel);
        }
      }
    };
    walk('');
    return out;
  }

  test('strips mixed-case metadata from all seven archives and passes full preflight', { timeout: BROWSER_TIMEOUT_MS }, () => {
    const root = mkdtempSync(path.join(tmpdir(), 'rulecanvas-archive-create-'));
    tempRoots.push(root);
    const srcRoot = path.join(root, 'sources');
    const archiveDir = path.join(root, 'archives');
    const parent = path.join(root, 'parent');
    mkdirSync(srcRoot);
    mkdirSync(archiveDir);
    mkdirSync(parent);

    const staticSources = [
      { src: path.join(REPO_ROOT, 'apps', 'agent-gate', 'dist'), name: 'agent-gate-static.tar.gz', dir: 'agent-gate' },
      { src: path.join(REPO_ROOT, 'apps', 'interlock-sim', 'dist'), name: 'interlock-sim-static.tar.gz', dir: 'interlock-sim' },
      { src: SITE_DIR, name: 'site-static.tar.gz', dir: 'site' },
    ];
    for (const item of staticSources) {
      if (!existsSync(path.join(item.src, 'index.html'))) {
        assert.fail(`${item.src}/index.html is missing; run "pnpm build" before pnpm test:release:preflight`);
      }
      const dirtyDir = path.join(srcRoot, item.dir);
      cpSync(item.src, dirtyDir, { recursive: true });
      addMixedCaseMetadata(dirtyDir);

      const created = spawnSync(
        'python3',
        [CREATE_ARCHIVE_SCRIPT, 'static', '--source', dirtyDir, '--output', path.join(archiveDir, item.name)],
        { cwd: REPO_ROOT, encoding: 'utf8' },
      );
      assert.equal(created.status, 0, `create static failed for ${item.name}: ${created.stderr}`);
    }

    const dirtyLibs = LIB_NAMES.map((name) => ({
      out: path.join(archiveDir, name),
      entries: [
        { name: 'package', type: 'dir' },
        { name: 'package/package.json', type: 'file', text: JSON.stringify({ name, version: '0.0.0' }) },
        { name: 'package/dist', type: 'dir' },
        { name: 'package/dist/index.js', type: 'file', text: 'export const ok = true;\n' },
        { name: 'package/.Ds_StOrE', type: 'file', text: 'junk' },
        { name: 'package/DESKTOP.INI', type: 'file', text: 'junk' },
        { name: 'package/dist/THUMBS.DB', type: 'file', text: 'junk' },
        { name: 'package/dist/._index.js', type: 'file', text: 'junk' },
        { name: 'package/__macosx', type: 'dir' },
        { name: 'package/__macosx/junk.txt', type: 'file', text: 'junk' },
        { name: 'package/dist/__MacOSX/index.js', type: 'file', text: 'junk' },
      ],
    }));
    buildArchives(dirtyLibs);
    for (const name of LIB_NAMES) {
      const cleaned = spawnSync(
        'python3',
        [CREATE_ARCHIVE_SCRIPT, 'clean-tgz', '--input', path.join(archiveDir, name)],
        { cwd: REPO_ROOT, encoding: 'utf8' },
      );
      assert.equal(cleaned.status, 0, `clean-tgz failed for ${name}: ${cleaned.stderr}`);
    }

    for (const name of ARCHIVE_NAMES) {
      const listing = spawnSync('tar', ['-tzf', path.join(archiveDir, name)], { encoding: 'utf8' });
      assert.equal(listing.status, 0, listing.stderr);
      const members = listing.stdout.trim().split('\n').filter(Boolean);
      assert.equal(
        members.some((m) => hasMetadataSegment(m)),
        false,
        `${name} retained metadata members: ${members.filter(hasMetadataSegment).join(', ')}`,
      );
      if (LIB_NAMES.includes(name)) {
        assert.ok(members.includes('package/dist/index.js'), `${name} lost legitimate dist/index.js`);
      } else {
        assert.ok(members.includes('./index.html'), `${name} lost legitimate ./index.html`);
      }
    }

    writeManifest(archiveDir);
    const output = path.join(parent, 'published');
    const preflight = runPreflight(['--archive-dir', archiveDir, '--output', output]);
    assert.equal(preflight.status, 0, `stdout=${preflight.stdout} stderr=${preflight.stderr}`);
    const publishedEntries = listTreeNames(output);
    assert.equal(
      publishedEntries.some((entry) => hasMetadataSegment(entry)),
      false,
      `published directory contains metadata entries: ${publishedEntries.filter(hasMetadataSegment).join(', ')}`,
    );
  });

  test('preserves archive security checks while creating or cleaning archives', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'rulecanvas-archive-sec-'));
    tempRoots.push(root);

    const symlinkDir = path.join(root, 'symlink-src');
    mkdirSync(symlinkDir);
    writeFileSync(path.join(symlinkDir, 'index.html'), '<!doctype html>', 'utf8');
    symlinkSync('/etc/passwd', path.join(symlinkDir, 'leak.txt'));
    const staticRes = spawnSync(
      'python3',
      [CREATE_ARCHIVE_SCRIPT, 'static', '--source', symlinkDir, '--output', path.join(root, 'out.tar.gz')],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    assert.notEqual(staticRes.status, 0, 'create-release-archive static must reject symlinks');

    const badTgz = path.join(root, 'bad-symlink.tgz');
    const traversalTgz = path.join(root, 'bad-traversal.tgz');
    buildArchives([
      {
        out: badTgz,
        entries: [
          { name: 'package/package.json', type: 'file', text: '{}' },
          { name: 'package/link', type: 'symlink', linkname: '/etc/passwd' },
        ],
      },
      {
        out: traversalTgz,
        entries: [
          { name: 'package/package.json', type: 'file', text: '{}' },
          { name: '../escape.txt', type: 'file', text: 'evil' },
        ],
      },
    ]);
    for (const candidate of [badTgz, traversalTgz]) {
      const cleanRes = spawnSync('python3', [CREATE_ARCHIVE_SCRIPT, 'clean-tgz', '--input', candidate], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      });
      assert.notEqual(cleanRes.status, 0, `clean-tgz must reject security defect in ${candidate}`);
    }
  });

  test('clean-tgz rejects duplicate paths, oversized/aggregate metadata, and malformed metadata without writing partial output', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'rulecanvas-clean-tgz-'));
    tempRoots.push(root);
    const helperPath = path.join(REPO_ROOT, 'scripts', 'release-preflight-archive.py');
    const outDir = path.join(root, 'outputs');
    mkdirSync(outDir);

    const existingValidPath = path.join(outDir, 'existing-valid.tgz');
    buildArchives([
      {
        out: existingValidPath,
        entries: [
          { name: 'package', type: 'dir' },
          { name: 'package/package.json', type: 'file', text: '{"name":"valid","version":"0.1.0"}' },
          { name: 'package/dist/index.js', type: 'file', text: 'export const ok = true;\n' },
        ],
      },
    ]);
    const existingBytesBefore = readFileSync(existingValidPath);
    const existingShaBefore = sha256(existingBytesBefore);

    const malformedCases = [
      {
        name: 'exact-dup.tgz',
        expectStderr: 'duplicate path',
        entries: [
          { name: 'package/package.json', type: 'file', text: '{}' },
          { name: 'package/dist/index.js', type: 'file', text: 'export const a = 1;\n' },
          { name: 'package/dist/index.js', type: 'file', text: 'export const a = 2;\n' },
        ],
      },
      {
        name: 'case-dup.tgz',
        expectStderr: 'duplicate path',
        entries: [
          { name: 'package/package.json', type: 'file', text: '{}' },
          { name: 'package/dist/index.js', type: 'file', text: 'export const a = 1;\n' },
          { name: 'package/dist/INDEX.js', type: 'file', text: 'export const a = 2;\n' },
        ],
      },
      {
        name: 'oversize-metadata.tgz',
        expectStderr: 'file larger than 16 MiB',
        entries: [
          { name: 'package/package.json', type: 'file', text: '{}' },
          { name: 'package/dist/index.js', type: 'file', text: 'export const a = 1;\n' },
          { name: 'package/THUMBS.DB', type: 'file', zeros: 16 * 1024 * 1024 + 1 },
        ],
      },
      {
        name: 'aggregate-total-metadata.tgz',
        expectStderr: 'total content exceeds 128 MiB',
        entries: [
          { name: 'package/package.json', type: 'file', text: '{}' },
          { name: 'package/dist/index.js', type: 'file', text: 'export const a = 1;\n' },
          ...Array.from({ length: 9 }, (_, i) => ({
            name: `package/._pad${i}.bin`,
            type: 'file',
            zeros: 15 * 1024 * 1024,
          })),
        ],
      },
      {
        name: 'member-count-metadata.tgz',
        expectStderr: 'more than 2000 members',
        entries: [
          { name: 'package/package.json', type: 'file', text: '{}' },
          ...Array.from({ length: 2000 }, (_, i) => ({
            name: `package/._m${i}.txt`,
            type: 'file',
            text: 'x',
          })),
        ],
      },
      {
        name: 'traversal-metadata.tgz',
        expectStderr: "'..' path segment",
        entries: [
          { name: 'package/package.json', type: 'file', text: '{}' },
          { name: '../.DS_Store', type: 'file', text: 'junk' },
        ],
      },
      {
        name: 'absolute-metadata.tgz',
        expectStderr: 'absolute path',
        entries: [
          { name: 'package/package.json', type: 'file', text: '{}' },
          { name: '/tmp/.DS_Store', type: 'file', text: 'junk' },
        ],
      },
      {
        name: 'backslash-metadata.tgz',
        expectStderr: 'backslash in path',
        entries: [
          { name: 'package/package.json', type: 'file', text: '{}' },
          { name: 'package\\THUMBS.DB', type: 'file', text: 'junk' },
        ],
      },
      {
        name: 'symlink-metadata.tgz',
        expectStderr: 'not a regular file or directory',
        entries: [
          { name: 'package/package.json', type: 'file', text: '{}' },
          { name: 'package/.DS_Store', type: 'symlink', linkname: '/etc/passwd' },
        ],
      },
      {
        name: 'hardlink-metadata.tgz',
        expectStderr: 'not a regular file or directory',
        entries: [
          { name: 'package/package.json', type: 'file', text: '{}' },
          { name: 'package/THUMBS.DB', type: 'hardlink', linkname: 'package/package.json' },
        ],
      },
      {
        name: 'device-metadata.tgz',
        expectStderr: 'not a regular file or directory',
        entries: [
          { name: 'package/package.json', type: 'file', text: '{}' },
          { name: 'package/._dev', type: 'chr' },
        ],
      },
    ];

    buildArchives(
      malformedCases.map((c) => ({
        out: path.join(root, c.name),
        entries: c.entries,
      })),
    );

    for (const c of malformedCases) {
      const inPath = path.join(root, c.name);
      const inShaBefore = sha256(readFileSync(inPath));
      const absentOut = path.join(outDir, `absent-${c.name}`);

      // Failure with new output path leaves no partial output or temp files.
      const resNew = spawnSync(
        'python3',
        [CREATE_ARCHIVE_SCRIPT, 'clean-tgz', '--input', inPath, '--output', absentOut],
        { cwd: REPO_ROOT, encoding: 'utf8' },
      );
      assert.notEqual(resNew.status, 0, `${c.name} must be rejected`);
      assert.ok(
        resNew.stderr.includes(c.expectStderr),
        `${c.name} stderr should include "${c.expectStderr}", got: ${resNew.stderr}`,
      );
      assert.equal(existsSync(absentOut), false, `${c.name} must not create output on failure`);

      // Failure targeting an existing valid archive preserves the existing output untouched.
      const resExisting = spawnSync(
        'python3',
        [CREATE_ARCHIVE_SCRIPT, 'clean-tgz', '--input', inPath, '--output', existingValidPath],
        { cwd: REPO_ROOT, encoding: 'utf8' },
      );
      assert.notEqual(resExisting.status, 0, `${c.name} must fail against existing output`);
      assert.equal(
        sha256(readFileSync(existingValidPath)),
        existingShaBefore,
        `${c.name} must preserve existing valid output on failure`,
      );

      // In-place failure preserves input untouched.
      const resInPlace = spawnSync(
        'python3',
        [CREATE_ARCHIVE_SCRIPT, 'clean-tgz', '--input', inPath],
        { cwd: REPO_ROOT, encoding: 'utf8' },
      );
      assert.notEqual(resInPlace.status, 0, `${c.name} must fail in-place`);
      assert.equal(sha256(readFileSync(inPath)), inShaBefore, `${c.name} must preserve input on in-place failure`);
    }

    assert.deepEqual(
      readdirSync(outDir),
      ['existing-valid.tgz'],
      'no partial output or temporary files should remain in output directory',
    );

    // Valid archive containing mixed-case metadata cleans cleanly and passes preflight.
    const validDirtyIn = path.join(root, 'valid-dirty.tgz');
    const validCleanOut = path.join(outDir, 'valid-clean.tgz');
    buildArchives([
      {
        out: validDirtyIn,
        entries: [
          { name: 'package', type: 'dir' },
          { name: 'package/package.json', type: 'file', text: '{"name":"clean-test","version":"0.1.0"}' },
          { name: 'package/README.md', type: 'file', text: '# Clean Test\n' },
          { name: 'package/dist', type: 'dir' },
          { name: 'package/dist/index.js', type: 'file', text: 'export const ok = true;\n' },
          { name: 'package/.Ds_StOrE', type: 'file', text: 'junk' },
          { name: 'package/DESKTOP.INI', type: 'file', text: 'junk' },
          { name: 'package/dist/THUMBS.DB', type: 'file', text: 'junk' },
          { name: 'package/dist/._index.js', type: 'file', text: 'junk' },
          { name: 'package/__MacOSX', type: 'dir' },
          { name: 'package/__MacOSX/._index.js', type: 'file', text: 'junk' },
        ],
      },
    ]);
    const cleanValid = spawnSync(
      'python3',
      [CREATE_ARCHIVE_SCRIPT, 'clean-tgz', '--input', validDirtyIn, '--output', validCleanOut],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    assert.equal(cleanValid.status, 0, `valid dirty archive failed clean-tgz: ${cleanValid.stderr}`);
    const cleanedBytes = readFileSync(validCleanOut);
    const pf = spawnSync(
      'python3',
      ['-B', helperPath, '--name', 'valid-clean.tgz', '--sha256', sha256(cleanedBytes)],
      { cwd: REPO_ROOT, input: cleanedBytes },
    );
    assert.equal(pf.status, 0, `cleaned archive failed preflight: ${pf.stderr.toString('utf8')}`);
    const members = spawnSync('tar', ['-tzf', validCleanOut], { encoding: 'utf8' })
      .stdout.trim()
      .split('\n')
      .filter(Boolean);
    assert.equal(members.some(hasMetadataSegment), false, 'cleaned archive must contain no metadata');
    assert.ok(members.includes('package/package.json'));
    assert.ok(members.includes('package/README.md'));
    assert.ok(members.includes('package/dist/index.js'));
  });

  test('pack:local publishes four preflight-validated library tarballs with no leftover temp files', { timeout: RUN_TIMEOUT_MS }, () => {
    const root = mkdtempSync(path.join(tmpdir(), 'rulecanvas-pack-local-test-'));
    tempRoots.push(root);
    const outDir = path.join(root, 'tarballs');
    const helperPath = path.join(REPO_ROOT, 'scripts', 'release-preflight-archive.py');
    const packScript = path.join(REPO_ROOT, 'scripts', 'pack-local.mjs');

    const res = spawnSync(process.execPath, [packScript, '--out', outDir], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: RUN_TIMEOUT_MS,
    });
    assert.equal(res.status, 0, `pack-local.mjs failed: stdout=${res.stdout} stderr=${res.stderr}`);
    assert.deepEqual(readdirSync(outDir).sort(), [...LIB_NAMES].sort());

    for (const libName of LIB_NAMES) {
      const tgzPath = path.join(outDir, libName);
      const bytes = readFileSync(tgzPath);
      const pf = spawnSync(
        'python3',
        ['-B', helperPath, '--name', libName, '--sha256', sha256(bytes)],
        { cwd: REPO_ROOT, input: bytes },
      );
      assert.equal(pf.status, 0, `${libName} failed preflight: ${pf.stderr.toString('utf8')}`);
      const members = spawnSync('tar', ['-tzf', tgzPath], { encoding: 'utf8' })
        .stdout.trim()
        .split('\n')
        .filter(Boolean);
      assert.equal(members.some(hasMetadataSegment), false, `${libName} contains metadata`);
      assert.ok(members.includes('package/package.json'), `${libName} missing package.json`);
      assert.ok(members.includes('package/README.md'), `${libName} missing README.md`);
      assert.ok(members.includes('package/LICENSE'), `${libName} missing LICENSE`);
    }
  });

  test('validates single root directory and rejects duplicate or non-directory root entries in clean-tgz and preflight', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'rulecanvas-root-dir-'));
    tempRoots.push(root);
    const helperPath = path.join(REPO_ROOT, 'scripts', 'release-preflight-archive.py');

    // Single valid root directory passes both clean-tgz and strict preflight.
    const singleRootIn = path.join(root, 'single-root.tgz');
    const singleRootOut = path.join(root, 'single-root-clean.tgz');
    buildArchives([
      {
        out: singleRootIn,
        entries: [
          { name: '.', type: 'dir' },
          { name: './index.html', type: 'file', text: '<!doctype html><title>ok</title>\n' },
        ],
      },
    ]);
    const cleanSingle = spawnSync(
      'python3',
      [CREATE_ARCHIVE_SCRIPT, 'clean-tgz', '--input', singleRootIn, '--output', singleRootOut],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    assert.equal(cleanSingle.status, 0, `single root failed clean-tgz: ${cleanSingle.stderr}`);
    const singleBytes = readFileSync(singleRootOut);
    const pfSingle = spawnSync(
      'python3',
      ['-B', helperPath, '--name', 'single-root.tgz', '--sha256', sha256(singleBytes)],
      { cwd: REPO_ROOT, input: singleBytes },
    );
    assert.equal(pfSingle.status, 0, `single root failed preflight: ${pfSingle.stderr.toString('utf8')}`);

    // Duplicate root directories (exact and normalized variants) and non-directory root entries fail both.
    const badRootCases = [
      {
        name: 'dup-dot.tgz',
        expectStderr: 'duplicate root directory',
        entries: [
          { name: '.', type: 'dir' },
          { name: '.', type: 'dir' },
          { name: './index.html', type: 'file', text: 'ok' },
        ],
      },
      {
        name: 'dup-dot-slash.tgz',
        expectStderr: 'duplicate root directory',
        entries: [
          { name: '.', type: 'dir' },
          { name: './', type: 'dir' },
          { name: './index.html', type: 'file', text: 'ok' },
        ],
      },
      {
        name: 'dup-dot-dot-slash.tgz',
        expectStderr: 'duplicate root directory',
        entries: [
          { name: './', type: 'dir' },
          { name: './.', type: 'dir' },
          { name: './index.html', type: 'file', text: 'ok' },
        ],
      },
      {
        name: 'dup-double-slash-dot.tgz',
        expectStderr: 'duplicate root directory',
        entries: [
          { name: '.', type: 'dir' },
          { name: './/.', type: 'dir' },
          { name: './index.html', type: 'file', text: 'ok' },
        ],
      },
      {
        name: 'file-empty-root.tgz',
        expectStderr: 'file with empty path',
        entries: [{ name: '.', type: 'file', text: 'bad' }],
      },
      {
        name: 'symlink-root.tgz',
        expectStderr: 'not a regular file or directory',
        entries: [{ name: '.', type: 'symlink', linkname: '/etc' }],
      },
    ];

    buildArchives(badRootCases.map((c) => ({ out: path.join(root, c.name), entries: c.entries })));
    for (const c of badRootCases) {
      const archivePath = path.join(root, c.name);
      const outPath = path.join(root, `out-${c.name}`);
      const rawBytes = readFileSync(archivePath);

      const pf = spawnSync(
        'python3',
        ['-B', helperPath, '--name', c.name, '--sha256', sha256(rawBytes)],
        { cwd: REPO_ROOT, input: rawBytes },
      );
      assert.notEqual(pf.status, 0, `preflight must reject ${c.name}`);
      assert.ok(
        pf.stderr.toString('utf8').includes(c.expectStderr),
        `preflight ${c.name} stderr should include "${c.expectStderr}", got: ${pf.stderr.toString('utf8')}`,
      );

      const clean = spawnSync(
        'python3',
        [CREATE_ARCHIVE_SCRIPT, 'clean-tgz', '--input', archivePath, '--output', outPath],
        { cwd: REPO_ROOT, encoding: 'utf8' },
      );
      assert.notEqual(clean.status, 0, `clean-tgz must reject ${c.name}`);
      assert.ok(
        clean.stderr.includes(c.expectStderr),
        `clean-tgz ${c.name} stderr should include "${c.expectStderr}", got: ${clean.stderr}`,
      );
      assert.equal(existsSync(outPath), false, `clean-tgz must not create output for ${c.name}`);
    }
  });

  test('publishPackageSet preserves existing checksums, unrelated files, and cleans temp files on failure at any commit step', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'rulecanvas-publish-set-'));
    tempRoots.push(root);

    const newSet = LIB_NAMES.map((fileName, idx) => ({
      fileName,
      bytes: Buffer.from(`NEW-PACKAGE-${idx}-${fileName}\n`, 'utf8'),
    }));

    // 1. Fresh/non-existent destination: failure on 1st..4th commit rename leaves no partial files or temp remnants.
    for (let failStep = 1; failStep <= LIB_NAMES.length; failStep += 1) {
      const freshOut = path.join(root, `fresh-fail-${failStep}`);
      let renameCalls = 0;
      assert.throws(
        () =>
          publishPackageSet(freshOut, newSet, {
            renameSync(src, dst) {
              renameCalls += 1;
              if (renameCalls === failStep) {
                const err = new Error(`injected commit failure at step ${failStep}`);
                err.code = 'EPERM';
                throw err;
              }
              return renameSync(src, dst);
            },
          }),
        /pack:local publication failed/,
      );
      assert.equal(existsSync(freshOut), false, `fresh destination should be cleaned up on failure step ${failStep}`);
    }

    // 2. Fresh destination succeeds cleanly and writes all four packages.
    const createdOut = path.join(root, 'fresh-success');
    const publishedFresh = publishPackageSet(createdOut, newSet);
    assert.equal(publishedFresh.length, 4);
    assert.deepEqual(readdirSync(createdOut).sort(), [...LIB_NAMES].sort());
    for (const item of newSet) {
      assert.equal(sha256(readFileSync(path.join(createdOut, item.fileName))), sha256(item.bytes));
    }

    // 3. Existing destination with 4 prior packages + unrelated file: failure at every commit step (1..4) and backup step (3) restores all 4 prior checksums and preserves unrelated file.
    for (const mode of ['backup-3', 'commit-1', 'commit-2', 'commit-3', 'commit-4']) {
      const existingOut = path.join(root, `existing-${mode}`);
      mkdirSync(existingOut);
      const priorChecksums = new Map();
      for (const fileName of LIB_NAMES) {
        const oldBytes = Buffer.from(`OLD-${mode}-${fileName}\n`, 'utf8');
        writeFileSync(path.join(existingOut, fileName), oldBytes);
        priorChecksums.set(fileName, sha256(oldBytes));
      }
      const unrelatedPath = path.join(existingOut, 'keep-notes.txt');
      writeFileSync(unrelatedPath, 'do-not-touch\n', 'utf8');
      const unrelatedSha = sha256(readFileSync(unrelatedPath));

      let backupCount = 0;
      let commitCount = 0;
      assert.throws(
        () =>
          publishPackageSet(existingOut, newSet, {
            renameSync(src, dst) {
              const srcBase = path.basename(src);
              const dstBase = path.basename(dst);
              if (dstBase.startsWith('.bak-')) {
                backupCount += 1;
                if (mode === `backup-${backupCount}`) {
                  const err = new Error(`injected backup EPERM at ${backupCount}`);
                  err.code = 'EPERM';
                  throw err;
                }
              } else if (srcBase.startsWith('.tmp-')) {
                commitCount += 1;
                if (mode === `commit-${commitCount}`) {
                  const err = new Error(`injected commit EPERM at ${commitCount}`);
                  err.code = 'EPERM';
                  throw err;
                }
              }
              return renameSync(src, dst);
            },
          }),
        /existing destination state was restored/,
      );

      assert.deepEqual(
        readdirSync(existingOut).sort(),
        [...LIB_NAMES, 'keep-notes.txt'].sort(),
        `${mode}: no temp or backup files should remain`,
      );
      for (const fileName of LIB_NAMES) {
        assert.equal(
          sha256(readFileSync(path.join(existingOut, fileName))),
          priorChecksums.get(fileName),
          `${mode}: ${fileName} checksum must match prior value`,
        );
      }
      assert.equal(sha256(readFileSync(unrelatedPath)), unrelatedSha, `${mode}: unrelated file must be preserved`);
    }

    // 4. Existing destination replacement succeeds cleanly while preserving unrelated file.
    const replaceOut = path.join(root, 'existing-success');
    mkdirSync(replaceOut);
    for (const fileName of LIB_NAMES) {
      writeFileSync(path.join(replaceOut, fileName), `OLD-${fileName}\n`);
    }
    writeFileSync(path.join(replaceOut, 'keep-notes.txt'), 'still-here\n');
    publishPackageSet(replaceOut, newSet);
    assert.deepEqual(readdirSync(replaceOut).sort(), [...LIB_NAMES, 'keep-notes.txt'].sort());
    for (const item of newSet) {
      assert.equal(sha256(readFileSync(path.join(replaceOut, item.fileName))), sha256(item.bytes));
    }
    assert.equal(readFileSync(path.join(replaceOut, 'keep-notes.txt'), 'utf8'), 'still-here\n');
  });

  test('pack:local preserves entire existing package set and unrelated files when third destination is immutable', { timeout: RUN_TIMEOUT_MS }, () => {
    const root = mkdtempSync(path.join(tmpdir(), 'rulecanvas-pack-local-immutable-'));
    tempRoots.push(root);
    const outDir = path.join(root, 'tarballs');
    const packScript = path.join(REPO_ROOT, 'scripts', 'pack-local.mjs');

    // Seed with four real valid tarballs, then replace with distinct sentinel tarballs so checksum changes are unambiguous.
    mkdirSync(outDir);
    const beforeChecksums = new Map();
    for (const libName of LIB_NAMES) {
      const target = path.join(outDir, libName);
      const sentinel = Buffer.from(`PRIOR-VALID-${libName}\n`, 'utf8');
      writeFileSync(target, sentinel);
      beforeChecksums.set(libName, sha256(sentinel));
    }
    const unrelatedFile = path.join(outDir, 'unrelated.txt');
    writeFileSync(unrelatedFile, 'preserve-me\n', 'utf8');
    const unrelatedSha = sha256(readFileSync(unrelatedFile));

    const thirdTarget = path.join(outDir, LIB_NAMES[2]);
    let usedImmutableFlag = false;
    if (process.platform === 'darwin') {
      const flagRes = spawnSync('chflags', ['uchg', thirdTarget], { encoding: 'utf8' });
      usedImmutableFlag = flagRes.status === 0;
    }

    try {
      if (!usedImmutableFlag) {
        // Portable fallback on non-macOS hosts: replace 3rd target with a directory so publication fails deterministically.
        rmSync(thirdTarget);
        mkdirSync(thirdTarget);
      }

      const res = spawnSync(process.execPath, [packScript, '--out', outDir], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        timeout: RUN_TIMEOUT_MS,
      });
      assert.notEqual(res.status, 0, 'pack:local must fail when third destination cannot be replaced');
      assert.ok(
        res.stderr.includes('pack:local'),
        `stderr should include actionable pack:local error, got: ${res.stderr}`,
      );

      assert.deepEqual(
        readdirSync(outDir).sort(),
        [...LIB_NAMES, 'unrelated.txt'].sort(),
        'no temp or backup files should remain in destination directory',
      );
      assert.equal(sha256(readFileSync(unrelatedFile)), unrelatedSha, 'unrelated file must remain unchanged');
      for (const libName of LIB_NAMES) {
        if (!usedImmutableFlag && libName === LIB_NAMES[2]) continue;
        assert.equal(
          sha256(readFileSync(path.join(outDir, libName))),
          beforeChecksums.get(libName),
          `${libName} must retain its exact prior checksum after failed publication`,
        );
      }
    } finally {
      if (usedImmutableFlag) {
        spawnSync('chflags', ['nouchg', thirdTarget], { encoding: 'utf8' });
      }
    }
  });
});
