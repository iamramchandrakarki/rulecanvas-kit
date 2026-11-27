import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI_SCRIPT = path.join(REPO_ROOT, 'scripts', 'check-model.mjs');

const tempDir = mkdtempSync(path.join(tmpdir(), 'rulecanvas-cli-test-'));
after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function writeFixture(name, content) {
  const filePath = path.join(tempDir, name);
  const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  writeFileSync(filePath, text, 'utf8');
  return filePath;
}

function runCli(args) {
  return spawnSync(process.execPath, [CLI_SCRIPT, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

const BASE_ASSUMPTIONS = [
  {
    id: 'finite-model',
    category: 'scope',
    statement: 'All variables remain within the declared finite domain.',
    notModeled: 'External side effects.',
  },
];

const VERIFIED_REACHABLE_MODEL = {
  id: 'verified-reachable',
  name: 'Verified Reachable Model',
  schema: {
    step: { kind: 'int', min: 0, max: 2 },
    ready: { kind: 'boolean' },
  },
  initialState: { step: 0, ready: false },
  rules: [
    {
      id: 'prepare',
      label: 'Prepare system',
      guard: { op: 'eq', left: { op: 'var', name: 'step' }, right: { op: 'lit', value: 0 } },
      updates: [
        { var: 'step', value: { op: 'lit', value: 1 } },
        { var: 'ready', value: { op: 'lit', value: true } },
      ],
    },
    {
      id: 'finish',
      label: 'Finish when ready',
      guard: {
        op: 'and',
        args: [
          { op: 'eq', left: { op: 'var', name: 'step' }, right: { op: 'lit', value: 1 } },
          { op: 'var', name: 'ready' },
        ],
      },
      updates: [{ var: 'step', value: { op: 'lit', value: 2 } }],
    },
  ],
  invariants: [
    {
      id: 'finish-requires-ready',
      label: 'Finish only when ready',
      holds: {
        op: 'or',
        args: [
          { op: 'neq', left: { op: 'var', name: 'step' }, right: { op: 'lit', value: 2 } },
          { op: 'var', name: 'ready' },
        ],
      },
    },
  ],
  goal: {
    id: 'reach-finish',
    label: 'Reach step 2',
    reached: { op: 'eq', left: { op: 'var', name: 'step' }, right: { op: 'lit', value: 2 } },
  },
  assumptions: BASE_ASSUMPTIONS,
};

const VERIFIED_VACUOUS_MODEL = {
  ...VERIFIED_REACHABLE_MODEL,
  id: 'verified-vacuous',
  name: 'Verified Vacuous Model',
  rules: [
    {
      id: 'noop-step-zero',
      label: 'Stay at step 0',
      guard: { op: 'eq', left: { op: 'var', name: 'step' }, right: { op: 'lit', value: 0 } },
      updates: [{ var: 'ready', value: { op: 'lit', value: true } }],
    },
  ],
};

const VIOLATED_MODEL = {
  ...VERIFIED_REACHABLE_MODEL,
  id: 'violated-model',
  name: 'Violated Model',
  rules: [
    {
      id: 'skip-ready',
      label: 'Jump directly to step 2 without becoming ready',
      guard: { op: 'eq', left: { op: 'var', name: 'step' }, right: { op: 'lit', value: 0 } },
      updates: [{ var: 'step', value: { op: 'lit', value: 2 } }],
    },
  ],
};

const RUNTIME_INVALID_MODEL = {
  id: 'runtime-out-of-domain',
  name: 'Runtime Out Of Domain Model',
  schema: {
    count: { kind: 'int', min: 0, max: 1 },
  },
  initialState: { count: 0 },
  rules: [
    {
      id: 'increment-unbounded',
      label: 'Increment count without checking upper bound',
      guard: { op: 'lit', value: true },
      updates: [
        {
          var: 'count',
          value: { op: 'add', left: { op: 'var', name: 'count' }, right: { op: 'lit', value: 1 } },
        },
      ],
    },
  ],
  invariants: [
    {
      id: 'non-negative',
      label: 'Count stays non-negative',
      holds: { op: 'gte', left: { op: 'var', name: 'count' }, right: { op: 'lit', value: 0 } },
    },
  ],
  assumptions: BASE_ASSUMPTIONS,
};

const COUNTEREXAMPLE_5000_MODEL = {
  id: 'counterexample-5000',
  name: '5000-Step Counterexample Model',
  schema: {
    x: { kind: 'int', min: 0, max: 5000 },
  },
  initialState: { x: 0 },
  rules: [
    {
      id: 'inc',
      label: 'Increment x while x < 5000',
      guard: { op: 'lt', left: { op: 'var', name: 'x' }, right: { op: 'lit', value: 5000 } },
      updates: [
        {
          var: 'x',
          value: { op: 'add', left: { op: 'var', name: 'x' }, right: { op: 'lit', value: 1 } },
        },
      ],
    },
  ],
  invariants: [
    {
      id: 'x-below-5000',
      label: 'x stays below 5000',
      holds: { op: 'lt', left: { op: 'var', name: 'x' }, right: { op: 'lit', value: 5000 } },
    },
  ],
  assumptions: BASE_ASSUMPTIONS,
};

describe('scripts/check-model.mjs CLI', () => {
  test('VERIFIED with reachable goal exits 0 and emits recomputed-core JSON', () => {
    const filePath = writeFixture('verified-reachable.json', VERIFIED_REACHABLE_MODEL);
    const res = runCli([filePath]);
    assert.equal(res.status, 0);
    assert.equal(res.stderr, '');
    const report = JSON.parse(res.stdout);
    assert.equal(report.verdict, 'VERIFIED');
    assert.equal(report.provenance, 'recomputed-core');
    assert.equal(report.goalStatus, 'REACHED');
    assert.equal(report.vacuousGoalWarning, false);
  });

  test('VERIFIED with unreachable goal exits 1 by default and 0 with --allow-vacuous', () => {
    const filePath = writeFixture('verified-vacuous.json', VERIFIED_VACUOUS_MODEL);

    const strictRes = runCli([filePath]);
    assert.equal(strictRes.status, 1);
    assert.equal(strictRes.stderr, '');
    const strictReport = JSON.parse(strictRes.stdout);
    assert.equal(strictReport.verdict, 'VERIFIED');
    assert.equal(strictReport.provenance, 'recomputed-core');
    assert.equal(strictReport.goalStatus, 'UNREACHABLE');
    assert.equal(strictReport.vacuousGoalWarning, true);

    const allowedRes = runCli([filePath, '--allow-vacuous']);
    assert.equal(allowedRes.status, 0);
    assert.equal(allowedRes.stderr, '');
    const allowedReport = JSON.parse(allowedRes.stdout);
    assert.equal(allowedReport.verdict, 'VERIFIED');
    assert.equal(allowedReport.vacuousGoalWarning, true);
  });

  test('VIOLATED exits 1 even with --allow-vacuous and includes trace and violatedInvariantIds', () => {
    const filePath = writeFixture('violated.json', VIOLATED_MODEL);

    for (const extraArgs of [[], ['--allow-vacuous']]) {
      const res = runCli([filePath, ...extraArgs]);
      assert.equal(res.status, 1);
      assert.equal(res.stderr, '');
      const report = JSON.parse(res.stdout);
      assert.equal(report.verdict, 'VIOLATED');
      assert.equal(report.provenance, 'recomputed-core');
      assert.deepEqual(report.violatedInvariantIds, ['finish-requires-ready']);
      assert.ok(Array.isArray(report.trace) && report.trace.length === 1);
      assert.equal(report.trace[0].ruleId, 'skip-ready');
    }
  });

  test('INCONCLUSIVE via --max-states or --max-depth exits 1 even with --allow-vacuous', () => {
    const filePath = writeFixture('inconclusive.json', VERIFIED_REACHABLE_MODEL);

    const statesRes = runCli([filePath, '--max-states=1', '--allow-vacuous']);
    assert.equal(statesRes.status, 1);
    assert.equal(statesRes.stderr, '');
    const statesReport = JSON.parse(statesRes.stdout);
    assert.equal(statesReport.verdict, 'INCONCLUSIVE');
    assert.equal(statesReport.provenance, 'recomputed-core');
    assert.equal(statesReport.inconclusive?.reason, 'MAX_STATES');

    const depthRes = runCli([filePath, '--max-depth', '0', '--allow-vacuous']);
    assert.equal(depthRes.status, 1);
    assert.equal(depthRes.stderr, '');
    const depthReport = JSON.parse(depthRes.stdout);
    assert.equal(depthReport.verdict, 'INCONCLUSIVE');
    assert.equal(depthReport.provenance, 'recomputed-core');
    assert.equal(depthReport.inconclusive?.reason, 'MAX_DEPTH');
  });

  test('INVALID runtime OUT_OF_DOMAIN_TRANSITION exits 1 even with --allow-vacuous', () => {
    const filePath = writeFixture('runtime-invalid.json', RUNTIME_INVALID_MODEL);

    for (const extraArgs of [[], ['--allow-vacuous']]) {
      const res = runCli([filePath, ...extraArgs]);
      assert.equal(res.status, 1);
      assert.equal(res.stderr, '');
      const report = JSON.parse(res.stdout);
      assert.equal(report.verdict, 'INVALID');
      assert.equal(report.provenance, 'recomputed-core');
      assert.equal(report.invalidKind, 'runtime-out-of-domain');
      assert.equal(report.errors[0]?.code, 'OUT_OF_DOMAIN_TRANSITION');
    }
  });

  test('--markdown writes PR-ready Markdown with recomputed-core provenance to stdout', () => {
    const filePath = writeFixture('markdown-violated.json', VIOLATED_MODEL);
    const res = runCli([filePath, '--markdown']);
    assert.equal(res.status, 1);
    assert.equal(res.stderr, '');
    assert.match(res.stdout, /^# Verification Audit Report/m);
    assert.match(res.stdout, /\*\*Provenance:\*\* recomputed-core/);
    assert.match(res.stdout, /\*\*VIOLATED\*\*/);
    assert.match(res.stdout, /skip-ready/);
  });

  test('--help and -h print usage and exit 0', () => {
    for (const flag of ['--help', '-h']) {
      const res = runCli([flag]);
      assert.equal(res.status, 0);
      assert.equal(res.stderr, '');
      assert.match(res.stdout, /Usage: pnpm check:model/);
    }
  });

  test('rejects invalid JSON, duplicate keys, invalid schema, bad flags, and unreadable paths with exit 2 and empty stdout', () => {
    const invalidJson = writeFixture('bad-syntax.json', '{ "id": ');
    const baseJsonText = JSON.stringify(VERIFIED_REACHABLE_MODEL, null, 2);
    const duplicateKeyText = baseJsonText.replace(
      '"id": "verified-reachable"',
      '"id": "dup", "id": "verified-reachable"',
    );
    assert.notEqual(duplicateKeyText, baseJsonText, 'duplicate key fixture replacement must apply');
    const duplicateKeyJson = writeFixture('dup-key.json', duplicateKeyText);
    const invalidSchemaJson = writeFixture('bad-schema.json', { id: 'broken-schema', name: 'Bad' });
    const validFile = writeFixture('valid-for-flags.json', VERIFIED_REACHABLE_MODEL);
    const subdir = path.join(tempDir, 'dir-not-file');
    mkdirSync(subdir, { recursive: true });

    const errorCases = [
      [invalidJson],
      [duplicateKeyJson],
      [invalidSchemaJson],
      [],
      [validFile, validFile],
      [path.join(tempDir, 'missing.json')],
      [subdir],
      [validFile, '--unknown-flag'],
      [validFile, '--markdown', '--markdown'],
      [validFile, '--allow-vacuous', '--allow-vacuous'],
      [validFile, '--max-states', '10', '--max-states=20'],
      [validFile, '--max-depth', '10', '--max-depth=20'],
      [validFile, '--max-states'],
      [validFile, '--max-states='],
      [validFile, '--max-depth'],
      [validFile, '--max-depth='],
      [validFile, '--max-states', '1.5'],
      [validFile, '--max-states', '0'],
      [validFile, '--max-states', '100001'],
      [validFile, '--max-depth', '-1'],
      [validFile, '--max-depth', '10001'],
      [validFile, '--max-depth', 'abc'],
    ];

    for (const args of errorCases) {
      const res = runCli(args);
      assert.equal(res.status, 2, `expected exit 2 for args ${JSON.stringify(args)}, got ${res.status}`);
      assert.equal(res.stdout, '', `expected empty stdout for args ${JSON.stringify(args)}`);
      assert.ok(res.stderr.trim().length > 0, `expected stderr diagnostic for args ${JSON.stringify(args)}`);
    }

    const dupRes = runCli([duplicateKeyJson]);
    assert.match(dupRes.stderr, /DUPLICATE_JSON_KEY/);
  });

  test('pipes full 5,000-step JSON output (>64 KiB) without truncation', () => {
    const filePath = writeFixture('counterexample-5000.json', COUNTEREXAMPLE_5000_MODEL);
    const res = runCli([filePath, '--max-states', '10000', '--max-depth', '6000']);
    assert.equal(res.status, 1);
    assert.equal(res.stderr, '');
    assert.ok(Buffer.byteLength(res.stdout, 'utf8') > 65536);
    const report = JSON.parse(res.stdout);
    assert.equal(report.verdict, 'VIOLATED');
    assert.equal(report.provenance, 'recomputed-core');
    assert.equal(report.trace.length, 5000);
    assert.equal(report.trace[0].stepIndex, 1);
    assert.equal(report.trace[4999].stepIndex, 5000);
    assert.equal(report.terminalState.x, 5000);
  });

  test('pipes full 5,000-step Markdown output (>64 KiB) without truncation', () => {
    const filePath = writeFixture('counterexample-5000-md.json', COUNTEREXAMPLE_5000_MODEL);
    const res = runCli([filePath, '--markdown', '--max-states', '10000', '--max-depth', '6000']);
    assert.equal(res.status, 1);
    assert.equal(res.stderr, '');
    assert.ok(Buffer.byteLength(res.stdout, 'utf8') > 65536);
    assert.ok(res.stdout.startsWith('# Verification Audit Report'));
    assert.ok(res.stdout.includes('Step 1:'));
    assert.ok(res.stdout.includes('Step 5000:'));
    assert.ok(res.stdout.includes('</details>'));
    assert.ok(res.stdout.includes('## Scope disclaimer'));
    assert.ok(res.stdout.indexOf('## Scope disclaimer') > res.stdout.indexOf('</details>'));
  });

  test('exits cleanly with nonzero status on broken stdout pipe without hanging', async () => {
    const filePath = writeFixture('counterexample-5000-epipe.json', COUNTEREXAMPLE_5000_MODEL);
    const result = await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [CLI_SCRIPT, filePath, '--max-states', '10000', '--max-depth', '6000'],
        { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      const stderrChunks = [];
      let destroyed = false;
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('CLI process hung on broken stdout pipe'));
      }, 15_000);

      child.stdout.on('data', () => {
        if (!destroyed) {
          destroyed = true;
          child.stdout.destroy();
        }
      });
      child.stdout.on('error', () => {
        // Ignore stream destruction error on test side.
      });
      child.stderr.on('data', (chunk) => {
        stderrChunks.push(chunk);
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal, stderr: Buffer.concat(stderrChunks).toString('utf8') });
      });
    });

    assert.equal(result.signal, null);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /STDOUT_WRITE_FAILED/);
  });
});
