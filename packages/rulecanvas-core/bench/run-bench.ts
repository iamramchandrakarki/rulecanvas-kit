import os from 'node:os';
import { performance } from 'node:perf_hooks';
import {
  validateModel,
  verifyModel,
  type StateSchema,
  type StateSnapshot,
  type TransitionRule,
  type TransitionSystemModel,
  type VerifyOptions,
  type VerifyResult,
} from '../src/index.js';

interface BenchmarkCase {
  readonly name: string;
  readonly model: TransitionSystemModel;
  readonly options: VerifyOptions;
  readonly assertResult?: (result: VerifyResult) => void;
}

interface BenchmarkMetrics {
  readonly name: string;
  readonly status: VerifyResult['status'];
  readonly detail: string;
  readonly statesExplored: number;
  readonly transitionsEvaluated: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly maxMs: number;
  readonly heapDeltaMb: number;
}

const WARMUP_RUNS = 5;
const MEASURED_RUNS = 30;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractModelsFromExports(mod: Record<string, unknown>): TransitionSystemModel[] {
  const found: TransitionSystemModel[] = [];
  const seenIds = new Set<string>();

  const tryAdd = (candidate: unknown): void => {
    if (!isRecord(candidate)) return;
    if (validateModel(candidate).length !== 0) return;
    const model = candidate as unknown as TransitionSystemModel;
    if (!seenIds.has(model.id)) {
      seenIds.add(model.id);
      found.push(model);
    }
  };

  for (const value of Object.values(mod)) {
    tryAdd(value);
    if (isRecord(value)) {
      for (const nested of Object.values(value)) {
        tryAdd(nested);
      }
    }
  }

  return found;
}

async function loadFlagshipModels(relativePath: string): Promise<TransitionSystemModel[]> {
  const moduleUrl = new URL(relativePath, import.meta.url).href;
  const mod: unknown = await import(moduleUrl);
  if (!isRecord(mod)) {
    throw new Error(`Expected module exports object from "${relativePath}".`);
  }
  return extractModelsFromExports(mod);
}

function buildCounterGridModel(
  id: string,
  name: string,
  dimensions: number,
  maxPerDim: number,
): TransitionSystemModel {
  const schema: Record<string, { readonly kind: 'int'; readonly min: number; readonly max: number }> = {};
  const initialState: StateSnapshot = {};
  const rules: TransitionRule[] = [];

  for (let i = 0; i < dimensions; i += 1) {
    const varName = `c${i}`;
    schema[varName] = { kind: 'int', min: 0, max: maxPerDim };
    initialState[varName] = 0;
    rules.push({
      id: `inc_${varName}`,
      label: `Increment ${varName}`,
      guard: { op: 'lt', left: { op: 'var', name: varName }, right: { op: 'lit', value: maxPerDim } },
      updates: [
        {
          var: varName,
          value: { op: 'add', left: { op: 'var', name: varName }, right: { op: 'lit', value: 1 } },
        },
      ],
    });
  }

  return {
    id,
    name,
    schema: schema as StateSchema,
    initialState,
    rules,
    invariants: [
      {
        id: 'inv_non_negative_c0',
        label: 'Primary counter remains non-negative',
        holds: { op: 'gte', left: { op: 'var', name: 'c0' }, right: { op: 'lit', value: 0 } },
      },
    ],
    assumptions: [
      {
        id: 'assumption_synthetic_grid',
        category: 'benchmark',
        statement: 'Synthetic bounded counter grid measuring exact BFS throughput and memory behavior.',
        notModeled: 'Domain-specific workflows or external I/O.',
      },
    ],
  };
}

function percentile(sorted: readonly number[], p: number): number {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? 0;
}

function runBenchmark(benchCase: BenchmarkCase): BenchmarkMetrics {
  for (let i = 0; i < WARMUP_RUNS; i += 1) {
    verifyModel(benchCase.model, benchCase.options);
  }

  const samples: number[] = [];
  let lastResult: VerifyResult | null = null;
  const heapBefore = process.memoryUsage().heapUsed;

  for (let i = 0; i < MEASURED_RUNS; i += 1) {
    const t0 = performance.now();
    lastResult = verifyModel(benchCase.model, benchCase.options);
    const t1 = performance.now();
    samples.push(t1 - t0);
  }

  const heapAfter = process.memoryUsage().heapUsed;
  const heapDeltaMb = (heapAfter - heapBefore) / (1024 * 1024);

  if (lastResult === null) {
    throw new Error(`Benchmark "${benchCase.name}" produced no result.`);
  }

  benchCase.assertResult?.(lastResult);

  const sorted = [...samples].sort((a, b) => a - b);
  const statesExplored = lastResult.stats?.statesExplored ?? 0;
  const transitionsEvaluated = lastResult.stats?.transitionsEvaluated ?? 0;
  const detail =
    lastResult.status === 'INCONCLUSIVE'
      ? lastResult.reason
      : lastResult.status === 'VERIFIED' && lastResult.goalReachable !== undefined
        ? `goal=${String(lastResult.goalReachable)}`
        : lastResult.status === 'VIOLATED'
          ? `trace=${lastResult.trace.length}`
          : '-';

  return {
    name: benchCase.name,
    status: lastResult.status,
    detail,
    statesExplored,
    transitionsEvaluated,
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    maxMs: sorted[sorted.length - 1] ?? 0,
    heapDeltaMb,
  };
}

function formatMetricsTable(rows: readonly BenchmarkMetrics[]): string {
  const headers = [
    'Benchmark',
    'Status',
    'Detail',
    'States',
    'Transitions',
    'p50 (ms)',
    'p95 (ms)',
    'max (ms)',
    'Heap Δ (MB)',
  ];
  const formattedRows = rows.map((r) => [
    r.name,
    r.status,
    r.detail,
    String(r.statesExplored),
    String(r.transitionsEvaluated),
    r.p50Ms.toFixed(3),
    r.p95Ms.toFixed(3),
    r.maxMs.toFixed(3),
    r.heapDeltaMb.toFixed(2),
  ]);

  const widths = headers.map((h, idx) =>
    Math.max(h.length, ...formattedRows.map((row) => (row[idx] ?? '').length)),
  );
  const pad = (cells: readonly string[]): string =>
    cells.map((cell, idx) => cell.padEnd(widths[idx] ?? cell.length)).join('  ');

  const separator = widths.map((w) => '-'.repeat(w)).join('  ');
  return [pad(headers), separator, ...formattedRows.map(pad)].join('\n');
}

async function main(): Promise<void> {
  const cpuModel = os.cpus()[0]?.model ?? 'unknown';
  console.log(`RuleCanvasKit Deterministic Benchmark Suite`);
  console.log(`Node: ${process.version} | CPU: ${cpuModel} | Warmup: ${WARMUP_RUNS} | Measured: ${MEASURED_RUNS}`);
  console.log('');

  const cases: BenchmarkCase[] = [];

  const [interlockModels, agentGateModels] = await Promise.all([
    loadFlagshipModels('../../../apps/interlock-sim/src/index.ts'),
    loadFlagshipModels('../../../apps/agent-gate/src/index.ts'),
  ]);

  if (interlockModels.length < 3) {
    throw new Error(
      `Expected at least 3 interlock-sim benchmark models, loaded ${interlockModels.length}.`,
    );
  }
  if (agentGateModels.length < 5) {
    throw new Error(
      `Expected at least 5 agent-gate benchmark models, loaded ${agentGateModels.length}.`,
    );
  }

  for (const model of [...interlockModels, ...agentGateModels]) {
    cases.push({
      name: `small:${model.id}`,
      model,
      options: { maxStates: 10_000, maxDepth: 100 },
    });
  }

  cases.push(
    {
      name: 'medium:grid-16x16x16 (4,096)',
      model: buildCounterGridModel('bench-medium-4096', 'Medium 3D Counter Grid (16^3)', 3, 15),
      options: { maxStates: 10_000, maxDepth: 100 },
      assertResult: (result) => {
        if (result.status !== 'VERIFIED' || result.stats.statesExplored !== 4_096) {
          throw new Error(
            `Medium benchmark assertion failed: expected VERIFIED with 4096 states, got ${result.status} (${result.stats?.statesExplored ?? 0})`,
          );
        }
      },
    },
    {
      name: 'large:grid-12^4 (20,736)',
      model: buildCounterGridModel('bench-large-20736', 'Large 4D Counter Grid (12^4)', 4, 11),
      options: { maxStates: 30_000, maxDepth: 100 },
      assertResult: (result) => {
        if (result.status !== 'VERIFIED' || result.stats.statesExplored !== 20_736) {
          throw new Error(
            `Large benchmark assertion failed: expected VERIFIED with 20736 states, got ${result.status} (${result.stats?.statesExplored ?? 0})`,
          );
        }
      },
    },
    {
      name: 'overflow:grid-13^4 (cap 25,000)',
      model: buildCounterGridModel('bench-overflow-28561', 'Overflow 4D Counter Grid (13^4)', 4, 12),
      options: { maxStates: 25_000, maxDepth: 100 },
      assertResult: (result) => {
        if (
          result.status !== 'INCONCLUSIVE' ||
          result.reason !== 'MAX_STATES' ||
          result.stats.statesExplored !== 25_000
        ) {
          throw new Error(
            `Overflow benchmark assertion failed: expected INCONCLUSIVE/MAX_STATES with 25000 states, got ${result.status} (${result.status === 'INCONCLUSIVE' ? result.reason : 'n/a'}, states=${result.stats?.statesExplored ?? 0})`,
          );
        }
      },
    },
  );

  const metrics = cases.map(runBenchmark);
  console.log(formatMetricsTable(metrics));
}

await main();
