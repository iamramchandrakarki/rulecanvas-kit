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
});
