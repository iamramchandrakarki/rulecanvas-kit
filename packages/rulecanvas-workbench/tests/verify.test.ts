import { verifyModel, type TransitionSystemModel, type VerifyOptions } from '@rulecanvas/core';
import { describe, expect, it, vi } from 'vitest';
import {
  VERIFY_PROTOCOL_VERSION,
  createLegacyWorkerAdapter,
  createVerifyClient,
  isFactoryVerifyClient,
  sanitizeAndFreezeVerifyResult,
  type LegacyWorkerLike,
  type VerifyWorkerInstance,
} from '../src/verify.js';
import { installVerifyWorker, type VerifyWorkerPort } from '../src/verify-worker.js';

const counterModel: TransitionSystemModel = {
  id: 'counter-probe',
  name: 'Counter Probe',
  schema: { x: { kind: 'int', min: 0, max: 6 } },
  initialState: { x: 0 },
  rules: [
    {
      id: 'inc',
      label: 'Increment',
      guard: { op: 'lt', left: { op: 'var', name: 'x' }, right: { op: 'lit', value: 6 } },
      updates: [
        {
          var: 'x',
          value: { op: 'add', left: { op: 'var', name: 'x' }, right: { op: 'lit', value: 1 } },
        },
      ],
    },
  ],
  invariants: [{ id: 'inv_ok', label: 'Always ok', holds: { op: 'lit', value: true } }],
  goal: {
    id: 'goal_six',
    label: 'Reach six',
    reached: { op: 'eq', left: { op: 'var', name: 'x' }, right: { op: 'lit', value: 6 } },
  },
  assumptions: [
    { id: 'asm_1', category: 'scope', statement: 'Discrete increments only.', notModeled: 'Timing.' },
  ],
};

function createPairedWorker(): {
  readonly worker: VerifyWorkerInstance;
  readonly triggerError: (message: string) => void;
  readonly triggerMessageError: () => void;
  readonly postRaw: (data: unknown) => void;
} {
  let worker!: VerifyWorkerInstance;
  const port: VerifyWorkerPort = {
    onmessage: null,
    postMessage(msg) {
      queueMicrotask(() => worker.onmessage?.({ data: msg }));
    },
  };
  installVerifyWorker(port);
  worker = {
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    postMessage(message) {
      queueMicrotask(() => port.onmessage?.({ data: message }));
    },
    terminate() {
      port.onmessage = null;
    },
  };
  return {
    worker,
    triggerError(message) {
      worker.onerror?.({ message });
    },
    triggerMessageError() {
      worker.onmessageerror?.({});
    },
    postRaw(data) {
      worker.onmessage?.({ data });
    },
  };
}

describe('@rulecanvas/workbench verification transport and ownership contracts', () => {
  it('returns structured diagnostics for out-of-range options before dispatch', async () => {
    const createWorker = vi.fn(() => createPairedWorker().worker);
    const client = createVerifyClient({
      execution: { kind: 'app-worker', createWorker, asyncStartupError: 'fallback' },
    });
    for (const maxStates of [0, 100_001]) {
      await expect(client.verify(counterModel, { maxStates, maxDepth: 10 })).resolves.toMatchObject({
        kind: 'error',
        code: 'CAPTURE_ERROR',
        errors: [{ code: 'INVALID_OPTIONS', path: 'maxStates' }],
      });
    }
    expect(createWorker).not.toHaveBeenCalled();
    client.dispose();
  });

  it('rejects inconsistent goal and trace metadata while keeping core verdicts admissible', () => {
    const model: TransitionSystemModel = {
      ...counterModel,
      invariants: [{ id: 'initial', label: 'Initial invariant', holds: { op: 'lit', value: false } }],
    };
    const options = { maxStates: 100, maxDepth: 10 };
    const result = verifyModel(model, options);
    if (result.status !== 'VIOLATED') throw new Error('Expected a depth-zero violation');

    expect(sanitizeAndFreezeVerifyResult(result, model, options).ok).toBe(true);
    expect(sanitizeAndFreezeVerifyResult({ ...result, goalReachable: true }, model, options).ok).toBe(false);
    expect(sanitizeAndFreezeVerifyResult({
      ...result,
      stats: { ...result.stats, maxDepthReached: 1 },
    }, model, options).ok).toBe(false);

    const { goal: _goal, ...withoutGoal } = counterModel;
    const shallowOptions = { maxStates: 100, maxDepth: 0 };
    const bounded = verifyModel(withoutGoal, shallowOptions);
    expect(bounded.status).toBe('INCONCLUSIVE');
    expect(sanitizeAndFreezeVerifyResult(bounded, withoutGoal, shallowOptions).ok).toBe(true);
    expect(sanitizeAndFreezeVerifyResult({
      ...bounded,
      goalReachable: true,
    }, withoutGoal, shallowOptions).ok).toBe(false);
  });

  it('validates factory brand, freezes owned results, and isolates caller mutations after dispatch', async () => {
    const client = createVerifyClient({
      execution: {
        kind: 'app-worker',
        createWorker: () => createPairedWorker().worker,
        asyncStartupError: 'fallback',
      },
    });
    expect(isFactoryVerifyClient(client)).toBe(true);
    expect(isFactoryVerifyClient({ verify: () => Promise.resolve(null) })).toBe(false);

    const mutableModel = structuredClone(counterModel) as unknown as {
      rules: { id: string; guard: { op: string; value?: boolean } }[];
      assumptions: { id: string; statement: string }[];
    };
    const promise = client.verify(mutableModel, { maxStates: 100, maxDepth: 10 });
    // Mutate caller references immediately after dispatch
    mutableModel.rules[0]!.guard = { op: 'lit', value: false };
    mutableModel.assumptions[0]!.statement = 'MUTATED';

    const settled = await promise;
    expect(settled.kind).toBe('result');
    if (settled.kind === 'result') {
      expect(settled.result.status).toBe('VERIFIED');
      if (settled.result.status === 'VERIFIED') {
        expect(settled.result.goalReachable).toBe(true);
        expect(settled.result.assumptions[0]?.statement).toBe('Discrete increments only.');
        expect(Object.isFrozen(settled.result)).toBe(true);
        expect(Object.isFrozen(settled.result.stats)).toBe(true);
        expect(Object.isFrozen(settled.result.assumptions)).toBe(true);
        expect(Object.isFrozen(settled.result.assumptions[0])).toBe(true);
      }
    }
    client.dispose();
  });

  it('materializes core-accepted non-enumerable dense array slots identically on worker, fallback, and direct paths', async () => {
    const nonEnumRules = [...counterModel.rules];
    Object.defineProperty(nonEnumRules, 0, {
      value: counterModel.rules[0],
      enumerable: false,
      configurable: true,
      writable: true,
    });
    const fixtureModel = { ...counterModel, rules: nonEnumRules } as TransitionSystemModel;

    const directClient = createVerifyClient({ execution: { kind: 'main-thread' } });
    const workerClient = createVerifyClient({
      execution: {
        kind: 'app-worker',
        createWorker: () => {
          const inner = createPairedWorker().worker;
          const origPost = inner.postMessage.bind(inner);
          inner.postMessage = (msg) => origPost(structuredClone(msg));
          return inner;
        },
        asyncStartupError: 'report',
      },
    });

    const opts: VerifyOptions = { maxStates: 50, maxDepth: 10 };
    const [directRes, workerRes] = await Promise.all([
      directClient.verify(fixtureModel, opts),
      workerClient.verify(fixtureModel, opts),
    ]);
    expect(directRes.kind).toBe('result');
    expect(workerRes.kind).toBe('result');
    if (directRes.kind === 'result' && workerRes.kind === 'result') {
      expect(workerRes.result).toEqual(directRes.result);
    }
    directClient.dispose();
    workerClient.dispose();
  });

  it('enforces exact MAX_DEPTH and MAX_STATES request-bound validation including valid depth-0 completedDepth=-1', async () => {
    const zeroDepth = verifyModel(counterModel, { maxStates: 10, maxDepth: 0 });
    expect(zeroDepth.status).toBe('INCONCLUSIVE');

    // Valid depth-0 request accepts completedDepth === -1
    const directClient = createVerifyClient({ execution: { kind: 'main-thread' } });
    const validZero = await directClient.verify(counterModel, { maxStates: 10, maxDepth: 0 });
    expect(validZero.kind).toBe('result');
    if (validZero.kind === 'result' && validZero.result.status === 'INCONCLUSIVE') {
      expect(validZero.result.reason).toBe('MAX_DEPTH');
      expect(validZero.result.completedDepth).toBe(-1);
    }

    // Mismatched depth-0 MAX_DEPTH report returned for a maxDepth: 5 request is rejected as INTEGRITY_ERROR
    const spoofedWorkerClient = createVerifyClient({
      execution: {
        kind: 'injected-worker',
        createWorker: () => {
          const w: VerifyWorkerInstance = {
            onmessage: null,
            onerror: null,
            onmessageerror: null,
            postMessage(msg) {
              const req = msg as { generation: number; requestId: number };
              queueMicrotask(() => {
                w.onmessage?.({
                  data: {
                    protocolVersion: VERIFY_PROTOCOL_VERSION,
                    generation: req.generation,
                    requestId: req.requestId,
                    type: 'result',
                    result: zeroDepth,
                  },
                });
              });
            },
            terminate() {},
          };
          return w;
        },
      },
    });

    const rejected = await spoofedWorkerClient.verify(counterModel, { maxStates: 10, maxDepth: 5 });
    expect(rejected.kind).toBe('error');
    if (rejected.kind === 'error') {
      expect(rejected.code).toBe('INTEGRITY_ERROR');
    }
    directClient.dispose();
    spoofedWorkerClient.dispose();
  });

  it('distinguishes app-worker fallback vs report policy, ignores stale/wrong-generation replies, and supports legacy WorkerLike bridge', async () => {
    // 1. app-worker asyncStartupError: 'fallback' falls back to sticky main-thread on pre-first-response error
    const fallbackClient = createVerifyClient({
      execution: {
        kind: 'app-worker',
        createWorker: () => {
          const w: VerifyWorkerInstance = {
            onmessage: null,
            onerror: null,
            onmessageerror: null,
            postMessage() {
              queueMicrotask(() => w.onerror?.({ message: 'Module load failed' }));
            },
            terminate() {},
          };
          return w;
        },
        asyncStartupError: 'fallback',
      },
    });
    const fbRes = await fallbackClient.verify(counterModel, { maxStates: 50, maxDepth: 10 });
    expect(fbRes.kind).toBe('result');
    if (fbRes.kind === 'result') {
      expect(fbRes.executionMode).toBe('main-thread');
    }
    expect(fallbackClient.getExecutionMode()).toBe('main-thread');
    fallbackClient.dispose();

    // 2. app-worker asyncStartupError: 'report' reports WORKER_ERROR without fallback
    const reportClient = createVerifyClient({
      execution: {
        kind: 'app-worker',
        createWorker: () => {
          const w: VerifyWorkerInstance = {
            onmessage: null,
            onerror: null,
            onmessageerror: null,
            postMessage() {
              queueMicrotask(() => w.onerror?.({ message: 'Startup error' }));
            },
            terminate() {},
          };
          return w;
        },
        asyncStartupError: 'report',
      },
    });
    const repRes = await reportClient.verify(counterModel, { maxStates: 50, maxDepth: 10 });
    expect(repRes.kind).toBe('error');
    if (repRes.kind === 'error') {
      expect(repRes.code).toBe('WORKER_ERROR');
    }
    reportClient.dispose();

    // 3. Legacy WorkerLike bridge isolates retired instances so late replies cannot satisfy new requests
    const createdLegacy: LegacyWorkerLike[] = [];
    const legacyClient = createVerifyClient({
      execution: {
        kind: 'injected-worker',
        createWorker: createLegacyWorkerAdapter(() => {
          const lw: LegacyWorkerLike = {
            onmessage: null,
            onerror: null,
            postMessage() {},
            terminate() {},
          };
          createdLegacy.push(lw);
          return lw;
        }),
      },
    });

    const p1 = legacyClient.verify(counterModel, { maxStates: 50, maxDepth: 10 });
    legacyClient.cancel();
    expect((await p1).kind).toBe('cancelled');

    const p2 = legacyClient.verify(counterModel, { maxStates: 50, maxDepth: 10 });
    // Late reply from retired worker 0 must be ignored
    createdLegacy[0]?.onmessage?.({
      data: { type: 'result', requestId: 2, result: verifyModel(counterModel, { maxStates: 50, maxDepth: 10 }) },
    });
    // Real reply from active worker 1 settles request 2
    createdLegacy[1]?.onmessage?.({
      data: { type: 'result', requestId: 2, result: verifyModel(counterModel, { maxStates: 50, maxDepth: 10 }) },
    });
    const res2 = await p2;
    expect(res2.kind).toBe('result');
    legacyClient.dispose();
  });

  it('freezes factory clients and ignores malformed/accessor replies from superseded request IDs', async () => {
    // 1. Native protocol worker: freeze check + superseded malformed reply ignored
    let nativeWorker!: VerifyWorkerInstance;
    const nativeClient = createVerifyClient({
      execution: {
        kind: 'injected-worker',
        createWorker: () => {
          nativeWorker = {
            onmessage: null,
            onerror: null,
            onmessageerror: null,
            postMessage() {},
            terminate() {},
          };
          return nativeWorker;
        },
      },
    });
    expect(Object.isFrozen(nativeClient)).toBe(true);
    expect(() => {
      (nativeClient as { verify: unknown }).verify = () => Promise.resolve(null);
    }).toThrow(TypeError);

    const n1 = nativeClient.verify(counterModel, { maxStates: 50, maxDepth: 10 });
    const n2 = nativeClient.verify(counterModel, { maxStates: 50, maxDepth: 10 });
    expect((await n1).kind).toBe('cancelled');

    const poisonedSuperseded = { requestId: 1, generation: 1, protocolVersion: VERIFY_PROTOCOL_VERSION };
    Object.defineProperty(poisonedSuperseded, 'type', {
      enumerable: true,
      get() {
        throw new Error('must not inspect payload of superseded request');
      },
    });
    nativeWorker.onmessage?.({ data: poisonedSuperseded });

    nativeWorker.onmessage?.({
      data: {
        protocolVersion: VERIFY_PROTOCOL_VERSION,
        generation: 1,
        requestId: 2,
        type: 'result',
        result: verifyModel(counterModel, { maxStates: 50, maxDepth: 10 }),
      },
    });
    const nativeRes2 = await n2;
    expect(nativeRes2.kind).toBe('result');
    nativeClient.dispose();

    // 2. Legacy WorkerLike adapter: superseded malformed reply ignored before reading payload accessors
    let legacyWorker!: LegacyWorkerLike;
    const legacyClient = createVerifyClient({
      execution: {
        kind: 'injected-worker',
        createWorker: createLegacyWorkerAdapter(() => {
          legacyWorker = {
            onmessage: null,
            onerror: null,
            postMessage() {},
            terminate() {},
          };
          return legacyWorker;
        }),
      },
    });

    const l1 = legacyClient.verify(counterModel, { maxStates: 50, maxDepth: 10 });
    const l2 = legacyClient.verify(counterModel, { maxStates: 50, maxDepth: 10 });
    expect((await l1).kind).toBe('cancelled');

    const legacyPoisonedSuperseded = { requestId: 1 };
    Object.defineProperty(legacyPoisonedSuperseded, 'type', {
      enumerable: true,
      get() {
        throw new Error('must not inspect payload of superseded legacy reply');
      },
    });
    legacyWorker.onmessage?.({ data: legacyPoisonedSuperseded });

    legacyWorker.onmessage?.({
      data: {
        type: 'result',
        requestId: 2,
        result: verifyModel(counterModel, { maxStates: 50, maxDepth: 10 }),
      },
    });
    const legacyRes2 = await l2;
    expect(legacyRes2.kind).toBe('result');
    legacyClient.dispose();
  });

  it('distinguishes worker construction failure from report-mode async startup failure', async () => {
    // App-worker constructor failure still degrades to a legitimate main-thread run.
    const constructorFallbackClient = createVerifyClient({
      execution: {
        kind: 'app-worker',
        createWorker: () => {
          throw new Error('Worker constructor unavailable');
        },
        asyncStartupError: 'report',
      },
    });
    const fallback = await constructorFallbackClient.verify(counterModel, {
      maxStates: 50,
      maxDepth: 10,
    });
    expect(fallback.kind).toBe('result');
    if (fallback.kind === 'result') {
      expect(fallback.executionMode).toBe('main-thread');
      expect(fallback.result.status).toBe('VERIFIED');
    }
    expect(constructorFallbackClient.getExecutionMode()).toBe('main-thread');
    constructorFallbackClient.dispose();

    // Report-mode async startup failure surfaces WORKER_ERROR and never claims a result.
    const startupFailureClient = createVerifyClient({
      execution: {
        kind: 'app-worker',
        createWorker: () => {
          const w: VerifyWorkerInstance = {
            onmessage: null,
            onerror: null,
            onmessageerror: null,
            postMessage() {
              queueMicrotask(() => w.onerror?.({ message: 'Worker module failed to load' }));
            },
            terminate() {},
          };
          return w;
        },
        asyncStartupError: 'report',
      },
    });
    const failed = await startupFailureClient.verify(counterModel, { maxStates: 50, maxDepth: 10 });
    expect(failed.kind).toBe('error');
    if (failed.kind === 'error') {
      expect(failed.code).toBe('WORKER_ERROR');
      expect(failed.message).toBe('Worker module failed to load');
    }
    startupFailureClient.dispose();

    // Injected-worker construction failure is reported rather than silently rerouted.
    const injectedFailureClient = createVerifyClient({
      execution: {
        kind: 'injected-worker',
        createWorker: () => {
          throw new Error('Injected worker unavailable');
        },
      },
    });
    const injectedFailure = await injectedFailureClient.verify(counterModel, {
      maxStates: 50,
      maxDepth: 10,
    });
    expect(injectedFailure.kind).toBe('error');
    if (injectedFailure.kind === 'error') {
      expect(injectedFailure.code).toBe('WORKER_ERROR');
    }
    injectedFailureClient.dispose();
  });

  it('rejects malformed envelopes and strips unexpected properties from valid replies', async () => {
    const options: VerifyOptions = { maxStates: 50, maxDepth: 10 };
    const genuine = verifyModel(counterModel, options);
    if (genuine.status !== 'VERIFIED') throw new Error('Expected a verified fixture');

    const decorate = (): unknown => ({
      ...genuine,
      unexpectedRoot: 'strip-me',
      stats: { ...genuine.stats, unexpectedStats: 'strip-me' },
      assumptions: genuine.assumptions.map((a) => ({ ...a, unexpectedAssumption: 'strip-me' })),
    });

    const direct = sanitizeAndFreezeVerifyResult(decorate(), counterModel, options);
    expect(direct.ok).toBe(true);
    if (direct.ok && direct.result.status === 'VERIFIED') {
      expect(Object.hasOwn(direct.result, 'unexpectedRoot')).toBe(false);
      expect(Object.hasOwn(direct.result.stats, 'unexpectedStats')).toBe(false);
      expect(Object.hasOwn(direct.result.assumptions[0]!, 'unexpectedAssumption')).toBe(false);
      expect(Object.isFrozen(direct.result)).toBe(true);
    }

    const runWithReply = async (reply: (req: { generation: number; requestId: number }) => unknown) => {
      const client = createVerifyClient({
        execution: {
          kind: 'injected-worker',
          createWorker: () => {
            let worker!: VerifyWorkerInstance;
            worker = {
              onmessage: null,
              onerror: null,
              onmessageerror: null,
              postMessage(msg) {
                const req = msg as { generation: number; requestId: number };
                queueMicrotask(() => worker.onmessage?.({ data: reply(req) }));
              },
              terminate() {},
            };
            return worker;
          },
        },
      });
      const settled = await client.verify(counterModel, options);
      client.dispose();
      return settled;
    };

    const nonObjectResult = await runWithReply((req) => ({
      protocolVersion: VERIFY_PROTOCOL_VERSION,
      generation: req.generation,
      requestId: req.requestId,
      type: 'result',
      result: 'not-an-object',
    }));
    expect(nonObjectResult.kind).toBe('error');
    if (nonObjectResult.kind === 'error') {
      expect(nonObjectResult.code).toBe('INTEGRITY_ERROR');
    }

    const unsupportedProtocol = await runWithReply((req) => ({
      protocolVersion: 'v0',
      generation: req.generation,
      requestId: req.requestId,
      type: 'result',
      result: genuine,
    }));
    expect(unsupportedProtocol.kind).toBe('error');
    if (unsupportedProtocol.kind === 'error') {
      expect(unsupportedProtocol.code).toBe('INTEGRITY_ERROR');
    }

    const unrecognizedType = await runWithReply((req) => ({
      protocolVersion: VERIFY_PROTOCOL_VERSION,
      generation: req.generation,
      requestId: req.requestId,
      type: 'unexpected',
    }));
    expect(unrecognizedType.kind).toBe('error');
    if (unrecognizedType.kind === 'error') {
      expect(unrecognizedType.code).toBe('INTEGRITY_ERROR');
    }

    const stripped = await runWithReply((req) => ({
      protocolVersion: VERIFY_PROTOCOL_VERSION,
      generation: req.generation,
      requestId: req.requestId,
      type: 'result',
      result: decorate(),
    }));
    expect(stripped.kind).toBe('result');
    if (stripped.kind === 'result' && stripped.result.status === 'VERIFIED') {
      expect(Object.hasOwn(stripped.result, 'unexpectedRoot')).toBe(false);
      expect(Object.hasOwn(stripped.result.stats, 'unexpectedStats')).toBe(false);
    }
  });

  it('rejects forged theoreticalStates against the exact BigInt schema product', async () => {
    const options: VerifyOptions = { maxStates: 50, maxDepth: 10 };
    const genuine = verifyModel(counterModel, options);
    if (genuine.status !== 'VERIFIED') throw new Error('Expected a verified fixture');
    const forged = { ...genuine, stats: { ...genuine.stats, theoreticalStates: '8' } };
    expect(genuine.stats.theoreticalStates).toBe('7');

    const direct = sanitizeAndFreezeVerifyResult(forged, counterModel, options);
    expect(direct.ok).toBe(false);

    const client = createVerifyClient({
      execution: {
        kind: 'injected-worker',
        createWorker: () => {
          let worker!: VerifyWorkerInstance;
          worker = {
            onmessage: null,
            onerror: null,
            onmessageerror: null,
            postMessage(msg) {
              const req = msg as { generation: number; requestId: number };
              queueMicrotask(() =>
                worker.onmessage?.({
                  data: {
                    protocolVersion: VERIFY_PROTOCOL_VERSION,
                    generation: req.generation,
                    requestId: req.requestId,
                    type: 'result',
                    result: forged,
                  },
                }),
              );
            },
            terminate() {},
          };
          return worker;
        },
      },
    });
    const settled = await client.verify(counterModel, options);
    expect(settled.kind).toBe('error');
    if (settled.kind === 'error') {
      expect(settled.code).toBe('INTEGRITY_ERROR');
    }
    client.dispose();
  });

  it('rejects forged VIOLATED traces that do not replay deterministically', async () => {
    const options: VerifyOptions = { maxStates: 100, maxDepth: 10 };
    const violatingModel: TransitionSystemModel = {
      ...counterModel,
      id: 'counter-violation',
      name: 'Counter Violation',
      rules: [
        ...counterModel.rules,
        {
          id: 'reset',
          label: 'Reset',
          guard: { op: 'lit', value: false },
          updates: [{ var: 'x', value: { op: 'lit', value: 0 } }],
        },
      ],
      invariants: [
        {
          id: 'inv_small',
          label: 'x stays small',
          holds: { op: 'lte', left: { op: 'var', name: 'x' }, right: { op: 'lit', value: 3 } },
        },
        {
          id: 'inv_nonneg',
          label: 'x stays non-negative',
          holds: { op: 'gte', left: { op: 'var', name: 'x' }, right: { op: 'lit', value: 0 } },
        },
      ],
    };

    const genuine = verifyModel(violatingModel, options);
    if (genuine.status !== 'VIOLATED') throw new Error('Expected a violated fixture');
    expect(genuine.trace.length).toBe(4);
    expect(genuine.terminalState['x']).toBe(4);
    expect(genuine.violatedInvariantIds).toEqual(['inv_small']);
    expect(sanitizeAndFreezeVerifyResult(genuine, violatingModel, options).ok).toBe(true);

    const lastStep = genuine.trace[3]!;
    const forgedVariants: readonly unknown[] = [
      {
        ...genuine,
        trace: genuine.trace.map((step, i) =>
          i === 3 ? { ...step, stateAfter: { ...step.stateAfter, x: 5 } } : step,
        ),
      },
      {
        ...genuine,
        trace: genuine.trace.map((step, i) => (i === 2 ? { ...step, changedVars: [] } : step)),
      },
      { ...genuine, terminalState: { ...genuine.terminalState, x: 5 } },
      { ...genuine, violatedInvariantIds: ['inv_nonneg'] },
      {
        ...genuine,
        trace: genuine.trace.map((step, i) => (i === 0 ? { ...step, ruleId: 'reset' } : step)),
      },
      {
        ...genuine,
        trace: genuine.trace.map((step, i) => (i === 0 ? { ...step, ruleId: 'missing_rule' } : step)),
      },
      { ...genuine, stats: { ...genuine.stats, maxDepthReached: 3 } },
      { ...genuine, stats: { ...genuine.stats, maxDepthReached: 9 } },
    ];
    for (const forged of forgedVariants) {
      expect(sanitizeAndFreezeVerifyResult(forged, violatingModel, options).ok).toBe(false);
    }

    // Empty traces are valid for initial-state violations and still replay-checked.
    const initialViolationModel: TransitionSystemModel = {
      ...violatingModel,
      invariants: [
        { id: 'inv_initial', label: 'Never true at start', holds: { op: 'lit', value: false } },
      ],
    };
    const initialViolation = verifyModel(initialViolationModel, options);
    if (initialViolation.status !== 'VIOLATED') throw new Error('Expected initial violation');
    expect(initialViolation.trace).toEqual([]);
    expect(sanitizeAndFreezeVerifyResult(initialViolation, initialViolationModel, options).ok).toBe(
      true,
    );
    expect(
      sanitizeAndFreezeVerifyResult(
        { ...initialViolation, terminalState: { x: 1 } },
        initialViolationModel,
        options,
      ).ok,
    ).toBe(false);

    // Client-level transport reports INTEGRITY_ERROR for a tampered trace.
    const client = createVerifyClient({
      execution: {
        kind: 'injected-worker',
        createWorker: () => {
          let worker!: VerifyWorkerInstance;
          worker = {
            onmessage: null,
            onerror: null,
            onmessageerror: null,
            postMessage(msg) {
              const req = msg as { generation: number; requestId: number };
              queueMicrotask(() =>
                worker.onmessage?.({
                  data: {
                    protocolVersion: VERIFY_PROTOCOL_VERSION,
                    generation: req.generation,
                    requestId: req.requestId,
                    type: 'result',
                    result: {
                      ...genuine,
                      trace: genuine.trace.map((step, i) =>
                        i === 3 ? { ...step, stateAfter: { ...step.stateAfter, x: 5 } } : step,
                      ),
                    },
                  },
                }),
              );
            },
            terminate() {},
          };
          return worker;
        },
      },
    });
    const settled = await client.verify(violatingModel, options);
    expect(settled.kind).toBe('error');
    if (settled.kind === 'error') {
      expect(settled.code).toBe('INTEGRITY_ERROR');
    }
    client.dispose();
    expect(lastStep.ruleId).toBe('inc');
  });

  it('accepts genuine INVALID prefix traces only when they reproduce the out-of-domain diagnostic', () => {
    const options: VerifyOptions = { maxStates: 50, maxDepth: 10 };
    const invalidModel: TransitionSystemModel = {
      id: 'invalid-step',
      name: 'Invalid step',
      schema: { x: { kind: 'int', min: 0, max: 1 } },
      initialState: { x: 0 },
      rules: [
        {
          id: 'to_one',
          label: 'Move to one',
          guard: { op: 'eq', left: { op: 'var', name: 'x' }, right: { op: 'lit', value: 0 } },
          updates: [{ var: 'x', value: { op: 'lit', value: 1 } }],
        },
        {
          id: 'overflow',
          label: 'Overflow',
          guard: { op: 'eq', left: { op: 'var', name: 'x' }, right: { op: 'lit', value: 1 } },
          updates: [
            {
              var: 'x',
              value: { op: 'add', left: { op: 'var', name: 'x' }, right: { op: 'lit', value: 1 } },
            },
          ],
        },
      ],
      invariants: [{ id: 'inv_x', label: 'Always holds', holds: { op: 'lit', value: true } }],
      assumptions: [
        { id: 'asm_1', category: 'scope', statement: 'Discrete.', notModeled: 'Timing.' },
      ],
    };

    const genuine = verifyModel(invalidModel, options);
    if (genuine.status !== 'INVALID') throw new Error('Expected an invalid fixture');
    expect(genuine.errors[0]?.code).toBe('OUT_OF_DOMAIN_TRANSITION');
    expect(genuine.trace).toHaveLength(1);
    expect(genuine.stats?.maxDepthReached).toBe(1);

    expect(sanitizeAndFreezeVerifyResult(genuine, invalidModel, options).ok).toBe(true);
    // Trace without paired stats is rejected outright.
    expect(
      sanitizeAndFreezeVerifyResult(
        { status: 'INVALID', errors: genuine.errors, trace: genuine.trace },
        invalidModel,
        options,
      ).ok,
    ).toBe(false);
    // Tampered prefix steps and diagnostics are rejected.
    expect(
      sanitizeAndFreezeVerifyResult(
        {
          ...genuine,
          trace: genuine.trace!.map((step) => ({ ...step, changedVars: [] })),
        },
        invalidModel,
        options,
      ).ok,
    ).toBe(false);
    expect(
      sanitizeAndFreezeVerifyResult(
        {
          ...genuine,
          errors: genuine.errors.map((err) => ({ ...err, message: 'forged diagnostic' })),
        },
        invalidModel,
        options,
      ).ok,
    ).toBe(false);
    // Runtime out-of-domain diagnostics without paired stats and trace are rejected.
    expect(
      sanitizeAndFreezeVerifyResult(
        { status: 'INVALID', errors: genuine.errors },
        invalidModel,
        options,
      ).ok,
    ).toBe(false);
    // A validation INVALID result needs no exploration stats or trace.
    expect(
      sanitizeAndFreezeVerifyResult(
        {
          status: 'INVALID',
          errors: [{ code: 'INVALID_MODEL', path: 'model', message: 'Model is malformed.' }],
        },
        invalidModel,
        options,
      ).ok,
    ).toBe(true);
  });

  it('rejects verdict-specific fields that are incompatible with each status', () => {
    const options: VerifyOptions = { maxStates: 50, maxDepth: 10 };
    const verified = verifyModel(counterModel, options);
    if (verified.status !== 'VERIFIED') throw new Error('Expected a verified fixture');
    const violating = verifyModel(
      {
        ...counterModel,
        invariants: [
          {
            id: 'inv_x',
            label: 'x stays below one',
            holds: { op: 'lt', left: { op: 'var', name: 'x' }, right: { op: 'lit', value: 1 } },
          },
        ],
      },
      options,
    );
    if (violating.status !== 'VIOLATED') throw new Error('Expected a violated fixture');
    const inconclusive = verifyModel(counterModel, { maxStates: 2, maxDepth: 10 });
    if (inconclusive.status !== 'INCONCLUSIVE') throw new Error('Expected an inconclusive fixture');

    const rejected = (result: unknown): boolean =>
      sanitizeAndFreezeVerifyResult(result, counterModel, options).ok === false;

    expect(rejected({ ...verified, trace: violating.trace })).toBe(true);
    expect(rejected({ ...verified, terminalState: violating.terminalState })).toBe(true);
    expect(rejected({ ...verified, violatedInvariantIds: ['inv_ok'] })).toBe(true);
    expect(rejected({ ...verified, reason: 'MAX_STATES' })).toBe(true);
    expect(rejected({ ...verified, completedDepth: 0 })).toBe(true);
    expect(rejected({ ...verified, frontierRemaining: 1 })).toBe(true);
    expect(rejected({ ...verified, errors: [{ code: 'X', path: 'p', message: 'm' }] })).toBe(true);

    expect(rejected({ ...violating, reason: 'MAX_STATES' })).toBe(true);
    expect(rejected({ ...violating, completedDepth: 0 })).toBe(true);
    expect(rejected({ ...violating, frontierRemaining: 1 })).toBe(true);
    expect(rejected({ ...violating, errors: [{ code: 'X', path: 'p', message: 'm' }] })).toBe(true);

    expect(rejected({ ...inconclusive, trace: violating.trace })).toBe(true);
    expect(rejected({ ...inconclusive, terminalState: violating.terminalState })).toBe(true);
    expect(rejected({ ...inconclusive, violatedInvariantIds: ['inv_ok'] })).toBe(true);
    expect(rejected({ ...inconclusive, errors: [{ code: 'X', path: 'p', message: 'm' }] })).toBe(
      true,
    );

    const validationInvalid = {
      status: 'INVALID' as const,
      errors: [{ code: 'INVALID_MODEL', path: 'model', message: 'Model is malformed.' }],
    };
    expect(rejected({ ...validationInvalid, assumptions: counterModel.assumptions })).toBe(true);
    expect(rejected({ ...validationInvalid, goalReachable: true })).toBe(true);
    expect(rejected({ ...validationInvalid, terminalState: violating.terminalState })).toBe(true);
    expect(rejected({ ...validationInvalid, violatedInvariantIds: ['inv_ok'] })).toBe(true);
    expect(rejected({ ...validationInvalid, reason: 'MAX_STATES' })).toBe(true);
    expect(rejected({ ...validationInvalid, completedDepth: 0 })).toBe(true);
    expect(rejected({ ...validationInvalid, frontierRemaining: 1 })).toBe(true);
    expect(rejected({ ...validationInvalid, stats: verified.stats })).toBe(true);
    expect(rejected({ ...validationInvalid, trace: violating.trace })).toBe(true);
  });

  it('rejects runtime INVALID results missing stats, trace, or a matching diagnostic', () => {
    const options: VerifyOptions = { maxStates: 50, maxDepth: 10 };
    const invalidModel: TransitionSystemModel = {
      id: 'invalid-step',
      name: 'Invalid step',
      schema: { x: { kind: 'int', min: 0, max: 1 } },
      initialState: { x: 0 },
      rules: [
        {
          id: 'to_one',
          label: 'Move to one',
          guard: { op: 'eq', left: { op: 'var', name: 'x' }, right: { op: 'lit', value: 0 } },
          updates: [{ var: 'x', value: { op: 'lit', value: 1 } }],
        },
        {
          id: 'overflow',
          label: 'Overflow',
          guard: { op: 'eq', left: { op: 'var', name: 'x' }, right: { op: 'lit', value: 1 } },
          updates: [
            {
              var: 'x',
              value: { op: 'add', left: { op: 'var', name: 'x' }, right: { op: 'lit', value: 1 } },
            },
          ],
        },
      ],
      invariants: [{ id: 'inv_x', label: 'Always holds', holds: { op: 'lit', value: true } }],
      assumptions: [
        { id: 'asm_1', category: 'scope', statement: 'Discrete.', notModeled: 'Timing.' },
      ],
    };
    const genuine = verifyModel(invalidModel, options);
    if (genuine.status !== 'INVALID') throw new Error('Expected an invalid fixture');

    const rejected = (result: unknown): boolean =>
      sanitizeAndFreezeVerifyResult(result, invalidModel, options).ok === false;

    expect(rejected({ status: 'INVALID', errors: genuine.errors })).toBe(true);
    expect(rejected({ status: 'INVALID', errors: genuine.errors, stats: genuine.stats })).toBe(true);
    expect(rejected({ status: 'INVALID', errors: genuine.errors, trace: genuine.trace })).toBe(true);
    expect(
      rejected({
        status: 'INVALID',
        errors: [
          ...genuine.errors,
          { code: 'INVALID_MODEL', path: 'model', message: 'Mixed validation error.' },
        ],
        stats: genuine.stats,
        trace: genuine.trace,
      }),
    ).toBe(true);
    expect(
      rejected({
        ...genuine,
        errors: genuine.errors.map((err) => ({ ...err, message: 'forged diagnostic' })),
      }),
    ).toBe(true);
    expect(
      rejected({
        ...genuine,
        assumptions: invalidModel.assumptions,
        goalReachable: true,
        terminalState: { x: 0 },
      }),
    ).toBe(true);
  });

  it('ignores stale replies and wrong-generation envelopes while settling the active request', async () => {
    const posted: Array<{ generation: number; requestId: number }> = [];
    let worker!: VerifyWorkerInstance;
    worker = {
      onmessage: null,
      onerror: null,
      onmessageerror: null,
      postMessage(msg) {
        posted.push(msg as { generation: number; requestId: number });
      },
      terminate() {},
    };
    const client = createVerifyClient({
      execution: { kind: 'injected-worker', createWorker: () => worker },
    });

    const first = client.verify(counterModel, { maxStates: 50, maxDepth: 10 });
    const second = client.verify(counterModel, { maxStates: 50, maxDepth: 10 });
    expect((await first).kind).toBe('cancelled');
    expect(posted).toHaveLength(2);

    const genuine = verifyModel(counterModel, { maxStates: 50, maxDepth: 10 });
    const active = posted[1]!;

    // Stale reply for the superseded request is ignored.
    worker.onmessage?.({
      data: {
        protocolVersion: VERIFY_PROTOCOL_VERSION,
        generation: posted[0]!.generation,
        requestId: posted[0]!.requestId,
        type: 'result',
        result: genuine,
      },
    });
    // Wrong generation for the active request is ignored.
    worker.onmessage?.({
      data: {
        protocolVersion: VERIFY_PROTOCOL_VERSION,
        generation: active.generation + 1,
        requestId: active.requestId,
        type: 'result',
        result: genuine,
      },
    });
    // Active, correctly correlated reply settles.
    worker.onmessage?.({
      data: {
        protocolVersion: VERIFY_PROTOCOL_VERSION,
        generation: active.generation,
        requestId: active.requestId,
        type: 'result',
        result: genuine,
      },
    });

    const settled = await second;
    expect(settled.kind).toBe('result');
    if (settled.kind === 'result') {
      expect(settled.requestId).toBe(active.requestId);
      expect(settled.result.status).toBe('VERIFIED');
    }
    client.dispose();
  });
});
