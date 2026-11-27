import {
  verifyModel,
  type BoolExpr,
  type Goal,
  type Invariant,
  type TransitionRule,
  type TransitionSystemModel,
  type VerifyOptions,
  type VerifyResult,
  type ValueExpr,
} from '@rulecanvas/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  buildVerificationReportFromSnapshot,
  formatVerificationReportMarkdown,
  isTrustedVerificationReport,
  sanitizeReportFilename,
  serializeVerificationReportJson,
  verifyAndBuildReport,
  type VerificationReport,
} from '../src/index.js';

declare const process: {
  readonly env: { readonly [key: string]: string | undefined };
};

function resolveSeed(): number {
  const raw = process.env['FC_SEED'];
  if (raw !== undefined && raw.trim().length > 0) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return 20261127;
}

const SEED = resolveSeed();

const VAR_X = { op: 'var', name: 'x' } as const;

function boolLit(value: boolean): BoolExpr {
  return { op: 'lit', value };
}

function intLit(value: number): { readonly op: 'lit'; readonly value: number } {
  return { op: 'lit', value };
}

function valueLit(value: boolean): ValueExpr {
  return { op: 'lit', value };
}

interface SnapshotShape {
  model: TransitionSystemModel;
  options: VerifyOptions;
  result: VerifyResult;
  provenance?: string;
  stale?: boolean;
}

function snapshotOf(
  model: TransitionSystemModel,
  options: VerifyOptions = { maxStates: 100, maxDepth: 10 },
): SnapshotShape {
  return { model, options, result: verifyModel(model, options) };
}

function cloneSnapshot(snapshot: SnapshotShape): SnapshotShape {
  return JSON.parse(JSON.stringify(snapshot)) as SnapshotShape;
}

function incrementRule(label = 'Increment', guard: BoolExpr = boolLit(true)): TransitionRule {
  return {
    id: 'inc',
    label,
    guard,
    updates: [{ var: 'x', value: { op: 'add', left: VAR_X, right: intLit(1) } }],
  };
}

function atMostInvariant(n: number, label = `x at most ${n}`): Invariant {
  return { id: 'inv', label, holds: { op: 'lte', left: VAR_X, right: intLit(n) } };
}

const SIMPLE_ASSUMPTIONS = [
  { id: 'a1', category: 'scope', statement: 'Finite declared model.', notModeled: 'Physical system.' },
] as const;

function violatingModel(overrides?: {
  readonly ruleLabel?: string;
  readonly invariantLabel?: string;
  readonly name?: string;
  readonly goal?: Goal;
  readonly max?: number;
}): TransitionSystemModel {
  return {
    id: 'report-violating',
    name: overrides?.name ?? 'Violating model',
    schema: { x: { kind: 'int', min: 0, max: overrides?.max ?? 2 } },
    initialState: { x: 0 },
    rules: [incrementRule(overrides?.ruleLabel ?? 'Increment')],
    invariants: [atMostInvariant(1, overrides?.invariantLabel ?? 'x at most 1')],
    ...(overrides?.goal !== undefined ? { goal: overrides.goal } : {}),
    assumptions: SIMPLE_ASSUMPTIONS.map((entry) => ({ ...entry })),
  };
}

function runtimeModel(): TransitionSystemModel {
  return {
    id: 'report-runtime',
    name: 'Runtime model',
    schema: { x: { kind: 'int', min: 0, max: 2 } },
    initialState: { x: 0 },
    rules: [incrementRule()],
    invariants: [{ id: 'inv', label: 'Always true', holds: boolLit(true) }],
    assumptions: SIMPLE_ASSUMPTIONS.map((entry) => ({ ...entry })),
  };
}

function vacuousModel(): TransitionSystemModel {
  return {
    id: 'report-vacuous',
    name: 'Vacuous model',
    schema: { x: { kind: 'int', min: 0, max: 1 } },
    initialState: { x: 0 },
    rules: [incrementRule('Increment', { op: 'lt', left: VAR_X, right: intLit(1) })],
    invariants: [{ id: 'inv', label: 'Always true', holds: boolLit(true) }],
    goal: { id: 'goal', label: 'Below zero', reached: { op: 'lt', left: VAR_X, right: intLit(0) } },
    assumptions: SIMPLE_ASSUMPTIONS.map((entry) => ({ ...entry })),
  };
}

function longTraceModel(): TransitionSystemModel {
  return {
    id: 'report-long-trace',
    name: 'Long trace model',
    schema: { x: { kind: 'int', min: 0, max: 20 } },
    initialState: { x: 0 },
    rules: [incrementRule()],
    invariants: [atMostInvariant(10)],
    assumptions: SIMPLE_ASSUMPTIONS.map((entry) => ({ ...entry })),
  };
}

function pbtModel(args: {
  readonly name: string;
  readonly ruleLabel: string;
  readonly invariantLabel: string;
  readonly flag: boolean;
  readonly mode: string;
  readonly level: number;
  readonly hasGoal: boolean;
  readonly goalHolds: boolean;
}): TransitionSystemModel {
  return {
    id: 'pbt-report',
    name: args.name,
    schema: {
      flag: { kind: 'boolean' },
      mode: { kind: 'enum', values: ['a', 'b', 'c'] },
      level: { kind: 'int', min: -2, max: 2 },
    },
    initialState: { flag: args.flag, mode: args.mode, level: args.level },
    rules: [
      {
        id: 'r1',
        label: args.ruleLabel,
        guard: boolLit(true),
        updates: [{ var: 'flag', value: valueLit(!args.flag) }],
      },
    ],
    invariants: [{ id: 'inv1', label: args.invariantLabel, holds: boolLit(true) }],
    ...(args.hasGoal
      ? { goal: { id: 'goal1', label: args.name, reached: boolLit(args.goalHolds) } }
      : {}),
    assumptions: [
      {
        id: 'a1',
        category: args.name,
        statement: args.invariantLabel,
        notModeled: args.ruleLabel,
      },
    ],
  };
}

const HOSTILE_CHARS = [
  'a',
  'B',
  '0',
  ' ',
  '|',
  '<',
  '>',
  '&',
  '"',
  "'",
  '`',
  '*',
  '_',
  '[',
  ']',
  '(',
  ')',
  '!',
  '#',
  '~',
  '\\',
  '\n',
  '\r',
  '\t',
  '\u001b',
  '\u009b',
  '\u202e',
  '=',
  '+',
  '-',
  '@',
  ';',
  ':',
  '/',
  '.',
  '\u0000',
] as const;

const arbText = fc
  .array(fc.constantFrom(...HOSTILE_CHARS), { minLength: 1, maxLength: 24 })
  .map((chars) => chars.join(''))
  .map((text) => (text.trim().length > 0 ? text : `x${text}`));

const HOSTILE_PAYLOADS = [
  '<script>alert(1)</script>',
  '![beacon](https://example.invalid/x.png)',
  '[click](javascript:alert(1))',
  'a|b|c',
  '\n## VIOLATED\n# Fake heading',
  '\n## VERIFIED',
  '\u001b[31mred\u001b[0m',
  '\u009b31m',
  '\u0000\u0007\u007f',
  '\u202e\u2066text\u2069\u200f',
  '=1+1',
  '+1+1',
  '-1+1',
  '@SUM(A1:A2)',
  '   =hidden',
  '`````',
] as const;

const RESERVED_STEMS = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
]);

function hostileReport(payload: string): VerificationReport {
  const model: TransitionSystemModel = {
    ...violatingModel({
      name: payload,
      ruleLabel: payload,
      invariantLabel: payload,
      goal: { id: 'goal', label: payload, reached: boolLit(false) },
    }),
    assumptions: [
      { id: 'a1', category: payload, statement: payload, notModeled: payload },
    ],
  };
  const built = buildVerificationReportFromSnapshot(snapshotOf(model));
  if (!built.ok) {
    throw new Error('Expected the hostile model snapshot to validate.');
  }
  return built.report;
}

describe('@rulecanvas/ui verification report', () => {
  describe('provenance and replay integrity', () => {
    it('builds a validated-snapshot report from a verified snapshot', () => {
      const built = buildVerificationReportFromSnapshot(snapshotOf(vacuousModel()));
      expect(built.ok).toBe(true);
      if (!built.ok) return;
      expect(built.report.provenance).toBe('validated-snapshot');
      expect(built.report.verdict).toBe('VERIFIED');
      expect(built.report.goalStatus).toBe('UNREACHABLE');
      expect(built.report.vacuousGoalWarning).toBe(true);
      expect(built.report.stats?.theoreticalStates).toBe('2');
      expect(isTrustedVerificationReport(built.report)).toBe(true);
      expect(formatVerificationReportMarkdown(built.report)).toContain(
        '## Vacuous-goal warning',
      );
    });

    it('recomputes with core and marks provenance recomputed-core', () => {
      const built = verifyAndBuildReport(violatingModel(), { maxStates: 100, maxDepth: 10 });
      expect(built.ok).toBe(true);
      if (!built.ok) return;
      expect(built.report.provenance).toBe('recomputed-core');
      expect(built.report.verdict).toBe('VIOLATED');
      expect(built.report.trace?.length).toBe(2);
      expect(isTrustedVerificationReport(built.report)).toBe(true);
    });

    it('ignores a forged caller-supplied provenance field', () => {
      const snapshot = { ...snapshotOf(vacuousModel()), provenance: 'recomputed-core' };
      const built = buildVerificationReportFromSnapshot(snapshot);
      expect(built.ok).toBe(true);
      if (!built.ok) return;
      expect(built.report.provenance).toBe('validated-snapshot');
    });

    it('rejects forged or inconsistent violated traces', () => {
      const snapshot = snapshotOf(violatingModel());
      if (snapshot.result.status !== 'VIOLATED') {
        throw new Error('Expected a violated snapshot.');
      }
      const baseTrace = snapshot.result.trace;

      const forgedState = {
        ...snapshot,
        result: {
          ...snapshot.result,
          trace: baseTrace.map((step, index) =>
            index === 0 ? { ...step, stateAfter: { x: 999 } } : step,
          ),
        },
      };
      expect(buildVerificationReportFromSnapshot(forgedState).ok).toBe(false);

      const forgedRule = {
        ...snapshot,
        result: {
          ...snapshot.result,
          trace: baseTrace.map((step, index) =>
            index === 0 ? { ...step, ruleId: 'missing-rule' } : step,
          ),
        },
      };
      expect(buildVerificationReportFromSnapshot(forgedRule).ok).toBe(false);

      const forgedTerminal = {
        ...snapshot,
        result: { ...snapshot.result, terminalState: { x: 0 } },
      };
      expect(buildVerificationReportFromSnapshot(forgedTerminal).ok).toBe(false);

      const forgedViolations = {
        ...snapshot,
        result: { ...snapshot.result, violatedInvariantIds: ['other'] },
      };
      expect(buildVerificationReportFromSnapshot(forgedViolations).ok).toBe(false);
    });

    it('validates runtime out-of-domain INVALID prefixes and rejects mismatches', () => {
      const snapshot = snapshotOf(runtimeModel());
      if (snapshot.result.status !== 'INVALID') {
        throw new Error('Expected an invalid snapshot.');
      }
      const built = buildVerificationReportFromSnapshot(snapshot);
      expect(built.ok).toBe(true);
      if (!built.ok) return;
      expect(built.report.invalidKind).toBe('runtime-out-of-domain');
      expect(built.report.trace?.length).toBe(2);
      expect(built.report.errors[0]?.code).toBe('OUT_OF_DOMAIN_TRANSITION');
      expect(formatVerificationReportMarkdown(built.report)).toContain(
        '### Runtime out-of-domain prefix trace',
      );

      const forgedDiagnostic = {
        ...snapshot,
        result: {
          ...snapshot.result,
          errors: snapshot.result.errors.map((entry) => ({
            ...entry,
            path: 'rules.missing.updates.x',
          })),
        },
      };
      expect(buildVerificationReportFromSnapshot(forgedDiagnostic).ok).toBe(false);

      const forgedStats = {
        ...snapshot,
        result: {
          ...snapshot.result,
          stats: { ...snapshot.result.stats!, theoreticalStates: '999' },
        },
      };
      expect(buildVerificationReportFromSnapshot(forgedStats).ok).toBe(false);
    });

    it('rejects a structurally identical but forged report object', () => {
      const built = buildVerificationReportFromSnapshot(snapshotOf(vacuousModel()));
      if (!built.ok) throw new Error('Expected a built report.');
      const forged = JSON.parse(
        serializeVerificationReportJson(built.report),
      ) as VerificationReport;
      expect(isTrustedVerificationReport(forged)).toBe(false);
      expect(() => serializeVerificationReportJson(forged)).toThrow(TypeError);
      expect(() => formatVerificationReportMarkdown(forged)).toThrow(TypeError);
    });

    it('maps goal status without treating an omitted flag as false', () => {
      const witnessed = buildVerificationReportFromSnapshot(
        snapshotOf(
          violatingModel({
            goal: {
              id: 'goal',
              label: 'Reach one',
              reached: { op: 'gte', left: VAR_X, right: intLit(1) },
            },
          }),
        ),
      );
      expect(witnessed.ok).toBe(true);
      if (witnessed.ok) {
        expect(witnessed.report.goalStatus).toBe('WITNESSED_ON_PREFIX');
      }

      const notEvaluated = buildVerificationReportFromSnapshot(snapshotOf(violatingModel()));
      expect(notEvaluated.ok).toBe(true);
      if (notEvaluated.ok) {
        expect(notEvaluated.report.goalStatus).toBe('NO_GOAL_DECLARED');
      }
    });
  });

  describe('markdown rendering', () => {
    it('renders fixed renderer-owned sections for a counterexample', () => {
      const built = buildVerificationReportFromSnapshot(snapshotOf(violatingModel()));
      if (!built.ok) throw new Error('Expected a built report.');
      const markdown = formatVerificationReportMarkdown(built.report);
      expect(markdown).toContain('# Verification Audit Report');
      expect(markdown).toContain('## Verdict');
      expect(markdown).toContain('## Provenance and execution mode');
      expect(markdown).toContain('## Proof scope');
      expect(markdown).toContain('## Bounds and statistics');
      expect(markdown).toContain('## Violated invariants');
      expect(markdown).toContain('## Counterexample trace');
      expect(markdown).toContain('## Declared assumptions');
      expect(markdown).toContain('## What is not modeled');
      expect(markdown).toContain('## Scope disclaimer');
    });

    it('wraps traces longer than eight steps in a details element', () => {
      const built = buildVerificationReportFromSnapshot(
        snapshotOf(longTraceModel(), { maxStates: 100, maxDepth: 20 }),
      );
      if (!built.ok) throw new Error('Expected a built report.');
      const markdown = formatVerificationReportMarkdown(built.report);
      expect(built.report.trace?.length).toBe(11);
      expect(markdown).toContain('<details>');
      expect(markdown).toContain('<summary>Counterexample trace (11 steps)</summary>');
      expect(markdown).toContain('</details>');
    });
  });

  describe('filename safety', () => {
    it('sanitizes model ids deterministically', () => {
      expect(sanitizeReportFilename('My Model!!', 'md')).toBe('my-model.md');
      expect(sanitizeReportFilename('UPPER_case-1', '.json')).toBe('upper_case-1.json');
      expect(sanitizeReportFilename('../CON', 'md')).toBe('rulecanvas-model.md');
      expect(sanitizeReportFilename(42, 'md')).toBe('rulecanvas-model.md');
      expect(sanitizeReportFilename('a'.repeat(100), 'json')).toBe(`${'a'.repeat(64)}.json`);
      expect(() => sanitizeReportFilename('model', 'txt')).toThrow(TypeError);
      expect(() => sanitizeReportFilename('model', 1)).toThrow(TypeError);
    });
  });

  describe('PBT-RPT-1: determinism', () => {
    it('produces byte-identical JSON and Markdown across repeated builds', () => {
      fc.assert(
        fc.property(
          arbText,
          arbText,
          arbText,
          fc.boolean(),
          fc.constantFrom('a', 'b', 'c'),
          fc.integer({ min: -2, max: 2 }),
          fc.boolean(),
          fc.boolean(),
          (name, ruleLabel, invariantLabel, flag, mode, level, hasGoal, goalHolds) => {
            const model = pbtModel({
              name,
              ruleLabel,
              invariantLabel,
              flag,
              mode,
              level,
              hasGoal,
              goalHolds,
            });
            const snapshot = snapshotOf(model, { maxStates: 50, maxDepth: 8 });
            const first = buildVerificationReportFromSnapshot(snapshot);
            const second = buildVerificationReportFromSnapshot(snapshot);
            expect(first.ok).toBe(true);
            expect(second.ok).toBe(true);
            if (!first.ok || !second.ok) return;

            expect(serializeVerificationReportJson(first.report)).toBe(
              serializeVerificationReportJson(second.report),
            );
            expect(formatVerificationReportMarkdown(first.report)).toBe(
              formatVerificationReportMarkdown(second.report),
            );
            expect(isTrustedVerificationReport(first.report)).toBe(true);
            expect(first.report.provenance).toBe('validated-snapshot');
          },
        ),
        { seed: SEED, numRuns: 80 },
      );
    }, 30_000);
  });

  describe('PBT-RPT-2: provenance and replay integrity', () => {
    it('rejects every forged trace mutation and never trusts forged provenance', () => {
      const tamperKind = fc.constantFrom(
        'stateAfter',
        'ruleId',
        'dropStep',
        'violatedIds',
        'terminalState',
      );

      fc.assert(
        fc.property(tamperKind, fc.integer({ min: 0, max: 1 }), (kind, index) => {
          const snapshot = snapshotOf(violatingModel());
          if (snapshot.result.status !== 'VIOLATED') {
            throw new Error('Expected a violated snapshot.');
          }
          const tampered = cloneSnapshot(snapshot);
          if (tampered.result.status !== 'VIOLATED') {
            throw new Error('Expected a violated clone.');
          }
          const result = tampered.result;
          const trace = result.trace;
          const target = trace[index];
          if (target === undefined) return;

          if (kind === 'stateAfter') {
            tampered.result = {
              ...result,
              trace: trace.map((step, stepIndex) =>
                stepIndex === index ? { ...step, stateAfter: { x: 999 } } : step,
              ),
            };
          } else if (kind === 'ruleId') {
            tampered.result = {
              ...result,
              trace: trace.map((step, stepIndex) =>
                stepIndex === index ? { ...step, ruleId: 'missing-rule' } : step,
              ),
            };
          } else if (kind === 'dropStep') {
            tampered.result = { ...result, trace: trace.slice(0, -1) };
          } else if (kind === 'violatedIds') {
            tampered.result = { ...result, violatedInvariantIds: ['other'] };
          } else {
            tampered.result = { ...result, terminalState: { x: 0 } };
          }

          expect(buildVerificationReportFromSnapshot(tampered).ok).toBe(false);
        }),
        { seed: SEED, numRuns: 60 },
      );

      const forgedProvenance = {
        ...snapshotOf(vacuousModel()),
        provenance: 'recomputed-core',
      };
      const built = buildVerificationReportFromSnapshot(forgedProvenance);
      expect(built.ok).toBe(true);
      if (built.ok) {
        expect(built.report.provenance).toBe('validated-snapshot');
      }
    }, 30_000);
  });

  describe('PBT-RPT-3: hostile content', () => {
    it('neutralizes scripts, beacons, links, pipes, headings, controls, bidi, formulas, and fences', () => {
      fc.assert(
        fc.property(fc.constantFrom(...HOSTILE_PAYLOADS), (payload) => {
          const report = hostileReport(payload);
          const markdown = formatVerificationReportMarkdown(report);

          expect(markdown).not.toMatch(/[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f-\u009f]/);
          expect(markdown).not.toMatch(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/);
          expect(markdown).not.toMatch(/<script/i);
          expect(markdown).not.toContain('![');
          expect(markdown).not.toContain('](javascript:');
          expect(markdown).not.toContain('\n## VIOLATED');
          expect(markdown).not.toContain('\n## VERIFIED');
          expect(markdown).not.toContain('\n# Fake heading');

          if (payload === 'a|b|c') {
            expect(markdown).toContain('a\\|b\\|c');
          }
          if (payload.includes('\u001b')) {
            expect(markdown).toContain('\\u001B');
          }
          if (payload.includes('\u009b')) {
            expect(markdown).toContain('\\u009B');
          }
          if (payload.includes('\u0000')) {
            expect(markdown).toContain('\\u0000');
          }
          if (payload.includes('\u007f')) {
            expect(markdown).toContain('\\u007F');
          }
          if (payload.includes('\u202e')) {
            expect(markdown).toContain('\\u202E');
          }
          if (payload === '=1+1') {
            expect(markdown).toContain("'=1+1");
          }
          if (payload === '   =hidden') {
            expect(markdown).toContain("'   =hidden");
          }
          if (payload === '@SUM(A1:A2)') {
            expect(markdown).toContain("'@SUM");
          }
          if (payload === '`````') {
            expect(markdown).toContain('``````text');
          }
        }),
        { seed: SEED, numRuns: 80 },
      );
    }, 30_000);
  });

  describe('PBT-RPT-4: filename safety', () => {
    it('always yields a safe deterministic stem and extension', () => {
      fc.assert(
        fc.property(
          fc.string({ maxLength: 120 }),
          fc.constantFrom('md', 'json', '.md', '.json'),
          (modelId, ext) => {
            const filename = sanitizeReportFilename(modelId, ext);
            const cleanExt = ext.startsWith('.') ? ext.slice(1) : ext;
            expect(filename.endsWith(`.${cleanExt}`)).toBe(true);
            const stem = filename.slice(0, filename.length - cleanExt.length - 1);
            expect(stem).toMatch(/^[a-z0-9_-]+$/);
            expect(stem.length).toBeLessThanOrEqual(64);
            expect(stem.startsWith('-')).toBe(false);
            expect(stem.startsWith('_')).toBe(false);
            expect(stem.endsWith('-')).toBe(false);
            expect(stem.endsWith('_')).toBe(false);
            expect(RESERVED_STEMS.has(stem)).toBe(false);
            expect(sanitizeReportFilename(modelId, ext)).toBe(filename);
          },
        ),
        { seed: SEED, numRuns: 150 },
      );
    }, 30_000);

    it('rejects every extension outside the allowlist', () => {
      fc.assert(
        fc.property(fc.string({ maxLength: 40 }), fc.string({ maxLength: 8 }), (modelId, ext) => {
          if (ext === 'md' || ext === 'json' || ext === '.md' || ext === '.json') {
            return;
          }
          expect(() => sanitizeReportFilename(modelId, ext)).toThrow(TypeError);
        }),
        { seed: SEED, numRuns: 100 },
      );
    }, 30_000);
  });

  describe('Snapshot bounds alignment with worker transport validation', () => {
    it('rejects VIOLATED trace length mismatches, runtime prefix overflows, excess deadlocks, and zero-frontier INCONCLUSIVE', () => {
      const violatedModel = longTraceModel();
      const violatedOpts = { maxStates: 500, maxDepth: 20 };
      const violatedRes = verifyModel(violatedModel, violatedOpts);
      expect(violatedRes.status).toBe('VIOLATED');
      if (violatedRes.status !== 'VIOLATED') return;

      const mismatchDepth = buildVerificationReportFromSnapshot({
        model: violatedModel,
        options: violatedOpts,
        result: {
          ...violatedRes,
          stats: { ...violatedRes.stats, maxDepthReached: violatedRes.trace.length + 1 },
        },
      });
      expect(mismatchDepth.ok).toBe(false);

      const excessDeadlocks = buildVerificationReportFromSnapshot({
        model: violatedModel,
        options: violatedOpts,
        result: {
          ...violatedRes,
          stats: {
            ...violatedRes.stats,
            deadlockStatesFound: violatedRes.stats.statesExplored + 1,
          },
        },
      });
      expect(excessDeadlocks.ok).toBe(false);

      const oodModel = runtimeModel();
      const oodOpts = { maxStates: 100, maxDepth: 20 };
      const oodRes = verifyModel(oodModel, oodOpts);
      expect(oodRes.status).toBe('INVALID');
      if (oodRes.status !== 'INVALID' || oodRes.stats === undefined || oodRes.trace === undefined) return;
      expect(oodRes.trace.length).toBeGreaterThan(0);
      const oodOverflow = buildVerificationReportFromSnapshot({
        model: oodModel,
        options: oodOpts,
        result: {
          ...oodRes,
          stats: { ...oodRes.stats, maxDepthReached: oodRes.trace.length - 1 },
        },
      });
      expect(oodOverflow.ok).toBe(false);

      const incOpts = { maxStates: 3, maxDepth: 20 };
      const incRes = verifyModel(violatedModel, incOpts);
      expect(incRes.status).toBe('INCONCLUSIVE');
      if (incRes.status !== 'INCONCLUSIVE') return;

      const zeroFrontier = buildVerificationReportFromSnapshot({
        model: violatedModel,
        options: incOpts,
        result: { ...incRes, frontierRemaining: 0 },
      });
      expect(zeroFrontier.ok).toBe(false);

      const badCompletedDepth = buildVerificationReportFromSnapshot({
        model: violatedModel,
        options: incOpts,
        result: { ...incRes, completedDepth: incRes.stats.maxDepthReached },
      });
      expect(badCompletedDepth.ok).toBe(false);
    });
  });
});
