import {
  verifyModel,
  type TransitionSystemModel,
  type ValidationError,
  type VerifyOptions,
  type VerifyResult,
} from '@rulecanvas/core';
import {
  captureVerificationRequest,
  deepFreeze,
  sanitizeAndFreezeVerifyResult,
} from './capture.js';
import {
  VERIFY_PROTOCOL_VERSION,
  type VerifyWorkerRequestMessage,
  type VerifyWorkerResponseMessage,
} from './verify-worker.js';

export { VERIFY_PROTOCOL_VERSION, captureVerificationRequest, deepFreeze, sanitizeAndFreezeVerifyResult };
export type { VerifyWorkerRequestMessage, VerifyWorkerResponseMessage };

export type VerifyExecutionMode = 'worker' | 'main-thread';

export interface VerifyWorkerErrorEvent {
  readonly message?: unknown;
}

export interface VerifyWorkerInstance {
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onerror: ((event: VerifyWorkerErrorEvent) => void) | null;
  onmessageerror?: ((event: unknown) => void) | null;
  postMessage(message: unknown): void;
  terminate(): void;
}

export type VerifyExecutionPolicy =
  | { readonly kind: 'main-thread' }
  | {
      readonly kind: 'app-worker';
      readonly createWorker: () => VerifyWorkerInstance;
      readonly asyncStartupError: 'report' | 'fallback';
    }
  | {
      readonly kind: 'injected-worker';
      readonly createWorker: () => VerifyWorkerInstance;
    };

export interface VerifyRunOptions {
  readonly restartWorker?: boolean | undefined;
}

export type VerifySettlement =
  | {
      readonly kind: 'result';
      readonly result: VerifyResult;
      readonly executionMode: VerifyExecutionMode;
      readonly requestId: number;
      readonly capturedModel: TransitionSystemModel;
      readonly capturedOptions: VerifyOptions;
    }
  | {
      readonly kind: 'cancelled';
      readonly requestId: number;
    }
  | {
      readonly kind: 'error';
      readonly code: 'WORKER_ERROR' | 'INTEGRITY_ERROR' | 'CAPTURE_ERROR' | 'DISPOSED';
      readonly message: string;
      readonly requestId: number;
      readonly errors?: readonly ValidationError[] | undefined;
    };

const FACTORY_CLIENTS = new WeakSet<VerifyClient>();

function readOwnDataProperty(
  target: object,
  key: string,
): { readonly present: true; readonly value: unknown } | { readonly present: false } {
  const desc = Object.getOwnPropertyDescriptor(target, key);
  if (desc === undefined) return { present: false };
  if (
    Object.hasOwn(desc, 'get') ||
    Object.hasOwn(desc, 'set') ||
    desc.get !== undefined ||
    desc.set !== undefined
  ) {
    throw new TypeError(`Worker envelope property "${key}" must not be an accessor.`);
  }
  return { present: true, value: desc.value };
}

export interface VerifyClient {
  verify(
    model: unknown,
    options: VerifyOptions,
    runOptions?: VerifyRunOptions,
  ): Promise<VerifySettlement>;
  cancel(): void;
  dispose(): void;
  getExecutionMode(): VerifyExecutionMode;
}

export function isFactoryVerifyClient(value: unknown): value is VerifyClient {
  return typeof value === 'object' && value !== null && FACTORY_CLIENTS.has(value as VerifyClient);
}

export function isWebWorkerSupported(): boolean {
  return typeof (globalThis as { Worker?: unknown }).Worker === 'function';
}

export interface LegacyWorkerLike {
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onerror: ((event: { readonly message?: unknown }) => void) | null;
  onmessageerror?: ((event: unknown) => void) | null;
  postMessage(message: unknown): void;
  terminate(): void;
}

/**
 * Bridges an app-level legacy `{ type, requestId, model, options }` WorkerLike
 * to the versioned protocol without trusting envelope fields from the legacy peer.
 */
export function createLegacyWorkerAdapter(
  createLegacyWorker: () => LegacyWorkerLike,
): () => VerifyWorkerInstance {
  return () => {
    const inner = createLegacyWorker();
    let activeTuple: { readonly generation: number; readonly requestId: number } | null = null;

    const adapter: VerifyWorkerInstance = {
      onmessage: null,
      onerror: null,
      onmessageerror: null,
      postMessage(message: unknown): void {
        if (typeof message !== 'object' || message === null) {
          throw new TypeError('Invalid worker request message.');
        }
        const req = message as VerifyWorkerRequestMessage;
        activeTuple = { generation: req.generation, requestId: req.requestId };
        inner.postMessage({
          type: 'verify',
          requestId: req.requestId,
          model: req.model,
          options: req.options,
        });
      },
      terminate(): void {
        activeTuple = null;
        inner.onmessage = null;
        inner.onerror = null;
        if ('onmessageerror' in inner) {
          inner.onmessageerror = null;
        }
        inner.terminate();
      },
    };

    inner.onmessage = (event) => {
      const tuple = activeTuple;
      if (tuple === null) return;
      const raw = event?.data;
      if (typeof raw !== 'object' || raw === null) {
        return;
      }
      let reqIdField: { readonly present: boolean; readonly value?: unknown };
      let msgTypeField: { readonly present: boolean; readonly value?: unknown };
      let resultField: { readonly present: boolean; readonly value?: unknown };
      let messageField: { readonly present: boolean; readonly value?: unknown };
      try {
        reqIdField = readOwnDataProperty(raw, 'requestId');
        msgTypeField = readOwnDataProperty(raw, 'type');
        resultField = readOwnDataProperty(raw, 'result');
        messageField = readOwnDataProperty(raw, 'message');
      } catch {
        adapter.onmessage?.({
          data: {
            protocolVersion: VERIFY_PROTOCOL_VERSION,
            generation: tuple.generation,
            requestId: tuple.requestId,
            type: '__invalid_accessor__',
          },
        });
        return;
      }
      if (!reqIdField.present || reqIdField.value !== tuple.requestId) {
        return;
      }
      const msgType = msgTypeField.present ? msgTypeField.value : undefined;
      if (msgType === 'result') {
        adapter.onmessage?.({
          data: {
            protocolVersion: VERIFY_PROTOCOL_VERSION,
            generation: tuple.generation,
            requestId: tuple.requestId,
            type: 'result',
            result: resultField.present ? resultField.value : undefined,
          },
        });
      } else if (msgType === 'error') {
        adapter.onmessage?.({
          data: {
            protocolVersion: VERIFY_PROTOCOL_VERSION,
            generation: tuple.generation,
            requestId: tuple.requestId,
            type: 'error',
            message:
              messageField.present && typeof messageField.value === 'string'
                ? messageField.value
                : 'Verification worker error.',
          },
        });
      } else {
        // Forward unknown reply shape with attached tuple so client flags integrity error
        adapter.onmessage?.({
          data: {
            protocolVersion: VERIFY_PROTOCOL_VERSION,
            generation: tuple.generation,
            requestId: tuple.requestId,
            type: msgType,
          },
        });
      }
    };

    inner.onerror = (event) => {
      adapter.onerror?.(event);
    };
    if ('onmessageerror' in inner) {
      inner.onmessageerror = (event) => {
        adapter.onmessageerror?.(event);
      };
    }

    return adapter;
  };
}

interface PendingRequest {
  readonly requestId: number;
  readonly generation: number;
  readonly capturedModel: TransitionSystemModel;
  readonly capturedOptions: VerifyOptions;
  settled: boolean;
  resolve(settlement: VerifySettlement): void;
}

export function createVerifyClient(config: {
  readonly execution: VerifyExecutionPolicy;
}): VerifyClient {
  const { execution } = config;
  let disposed = false;
  let stickyMainThread = execution.kind === 'main-thread';
  let worker: VerifyWorkerInstance | null = null;
  let workerGeneration = 0;
  let workerHasValidResponse = false;
  let nextRequestId = 0;
  let pending: PendingRequest | null = null;

  const settlePending = (target: PendingRequest, settlement: VerifySettlement): void => {
    if (target.settled) return;
    target.settled = true;
    if (pending === target) {
      pending = null;
    }
    target.resolve(settlement);
  };

  const discardWorker = (): void => {
    const current = worker;
    worker = null;
    workerHasValidResponse = false;
    if (current !== null) {
      current.onmessage = null;
      current.onerror = null;
      if ('onmessageerror' in current) {
        current.onmessageerror = null;
      }
      try {
        current.terminate();
      } catch {
        // ignore termination errors on already-failed workers
      }
    }
  };

  const runSynchronousFallback = (target: PendingRequest): void => {
    try {
      const rawResult = verifyModel(target.capturedModel, target.capturedOptions);
      const checked = sanitizeAndFreezeVerifyResult(
        rawResult,
        target.capturedModel,
        target.capturedOptions,
      );
      if (!checked.ok) {
        settlePending(target, {
          kind: 'error',
          code: 'INTEGRITY_ERROR',
          message: checked.message,
          requestId: target.requestId,
        });
        return;
      }
      settlePending(target, {
        kind: 'result',
        result: checked.result,
        executionMode: 'main-thread',
        requestId: target.requestId,
        capturedModel: target.capturedModel,
        capturedOptions: target.capturedOptions,
      });
    } catch (err) {
      settlePending(target, {
        kind: 'error',
        code: 'WORKER_ERROR',
        message: err instanceof Error ? err.message : 'Synchronous verification failed.',
        requestId: target.requestId,
      });
    }
  };

  const ensureWorker = ():
    | { readonly ok: true; readonly instance: VerifyWorkerInstance; readonly generation: number }
    | { readonly ok: false; readonly mode: 'fallback' }
    | { readonly ok: false; readonly mode: 'error'; readonly message: string } => {
    if (stickyMainThread || execution.kind === 'main-thread') {
      return { ok: false, mode: 'fallback' };
    }
    if (worker !== null) {
      return { ok: true, instance: worker, generation: workerGeneration };
    }
    try {
      const created = execution.createWorker();
      workerGeneration += 1;
      const gen = workerGeneration;
      worker = created;
      workerHasValidResponse = false;

      created.onmessage = (event) => {
        if (disposed || created !== worker) return;
        const active = pending;
        if (active === null || active.generation !== gen) return;

        const data = event?.data;
        if (typeof data !== 'object' || data === null) return;

        let reqIdField: { readonly present: boolean; readonly value?: unknown };
        let genField: { readonly present: boolean; readonly value?: unknown };
        let protoField: { readonly present: boolean; readonly value?: unknown };
        let typeField: { readonly present: boolean; readonly value?: unknown };
        let msgField: { readonly present: boolean; readonly value?: unknown };
        let resField: { readonly present: boolean; readonly value?: unknown };
        try {
          reqIdField = readOwnDataProperty(data, 'requestId');
          genField = readOwnDataProperty(data, 'generation');
          protoField = readOwnDataProperty(data, 'protocolVersion');
          typeField = readOwnDataProperty(data, 'type');
          msgField = readOwnDataProperty(data, 'message');
          resField = readOwnDataProperty(data, 'result');
        } catch {
          discardWorker();
          settlePending(active, {
            kind: 'error',
            code: 'INTEGRITY_ERROR',
            message: 'Verification worker envelope contained an accessor property.',
            requestId: active.requestId,
          });
          return;
        }

        // Must have usable correlation data matching the active request
        if (
          !reqIdField.present ||
          !genField.present ||
          reqIdField.value !== active.requestId ||
          genField.value !== gen
        ) {
          return;
        }
        if (!protoField.present || protoField.value !== VERIFY_PROTOCOL_VERSION) {
          discardWorker();
          settlePending(active, {
            kind: 'error',
            code: 'INTEGRITY_ERROR',
            message: 'Verification worker replied with an unsupported protocol version.',
            requestId: active.requestId,
          });
          return;
        }

        const msgType = typeField.present ? typeField.value : undefined;
        if (msgType === 'error') {
          if (!msgField.present || typeof msgField.value !== 'string') {
            discardWorker();
            settlePending(active, {
              kind: 'error',
              code: 'INTEGRITY_ERROR',
              message: 'Verification worker error payload was malformed.',
              requestId: active.requestId,
            });
            return;
          }
          workerHasValidResponse = true;
          settlePending(active, {
            kind: 'error',
            code: 'WORKER_ERROR',
            message: msgField.value,
            requestId: active.requestId,
          });
          return;
        }

        if (msgType === 'result') {
          const checked = sanitizeAndFreezeVerifyResult(
            resField.present ? resField.value : undefined,
            active.capturedModel,
            active.capturedOptions,
          );
          if (!checked.ok) {
            discardWorker();
            settlePending(active, {
              kind: 'error',
              code: 'INTEGRITY_ERROR',
              message: checked.message,
              requestId: active.requestId,
            });
            return;
          }
          workerHasValidResponse = true;
          settlePending(active, {
            kind: 'result',
            result: checked.result,
            executionMode: 'worker',
            requestId: active.requestId,
            capturedModel: active.capturedModel,
            capturedOptions: active.capturedOptions,
          });
          return;
        }

        discardWorker();
        settlePending(active, {
          kind: 'error',
          code: 'INTEGRITY_ERROR',
          message: 'Verification worker replied with an unrecognized message type.',
          requestId: active.requestId,
        });
      };

      created.onerror = (event) => {
        if (disposed || created !== worker) return;
        const active = pending;
        const beforeFirstResponse = !workerHasValidResponse;
        discardWorker();

        if (active === null || active.generation !== gen) {
          return;
        }
        if (
          beforeFirstResponse &&
          execution.kind === 'app-worker' &&
          execution.asyncStartupError === 'fallback'
        ) {
          stickyMainThread = true;
          runSynchronousFallback(active);
          return;
        }
        const detail =
          typeof event?.message === 'string' && event.message.length > 0
            ? event.message
            : 'Verification worker encountered a runtime error.';
        settlePending(active, {
          kind: 'error',
          code: 'WORKER_ERROR',
          message: detail,
          requestId: active.requestId,
        });
      };

      created.onmessageerror = () => {
        if (disposed || created !== worker) return;
        const active = pending;
        discardWorker();
        if (active === null || active.generation !== gen) return;
        settlePending(active, {
          kind: 'error',
          code: 'INTEGRITY_ERROR',
          message: 'Verification worker message could not be deserialized.',
          requestId: active.requestId,
        });
      };

      return { ok: true, instance: created, generation: gen };
    } catch (err) {
      discardWorker();
      if (execution.kind === 'app-worker') {
        stickyMainThread = true;
        return { ok: false, mode: 'fallback' };
      }
      return {
        ok: false,
        mode: 'error',
        message: err instanceof Error ? err.message : 'Unable to construct verification worker.',
      };
    }
  };

  const client: VerifyClient = {
    verify(model, options, runOptions) {
      nextRequestId += 1;
      const requestId = nextRequestId;

      if (disposed) {
        return Promise.resolve({
          kind: 'error',
          code: 'DISPOSED',
          message: 'Verification client has been disposed.',
          requestId,
        });
      }

      if (pending !== null) {
        const previous = pending;
        settlePending(previous, { kind: 'cancelled', requestId: previous.requestId });
        if (runOptions?.restartWorker) {
          discardWorker();
        }
      } else if (runOptions?.restartWorker) {
        discardWorker();
      }

      const captured = captureVerificationRequest(model, options);
      if (!captured.ok) {
        return Promise.resolve({
          kind: 'error',
          code: 'CAPTURE_ERROR',
          message: captured.message,
          requestId,
          ...(captured.errors !== undefined ? { errors: captured.errors } : {}),
        });
      }

      return new Promise<VerifySettlement>((resolve) => {
        const workerOutcome = ensureWorker();
        if (!workerOutcome.ok) {
          if (workerOutcome.mode === 'error') {
            resolve({
              kind: 'error',
              code: 'WORKER_ERROR',
              message: workerOutcome.message,
              requestId,
            });
            return;
          }
          const req: PendingRequest = {
            requestId,
            generation: 0,
            capturedModel: captured.model,
            capturedOptions: captured.options,
            settled: false,
            resolve,
          };
          pending = req;
          runSynchronousFallback(req);
          return;
        }

        const req: PendingRequest = {
          requestId,
          generation: workerOutcome.generation,
          capturedModel: captured.model,
          capturedOptions: captured.options,
          settled: false,
          resolve,
        };
        pending = req;

        const payload: VerifyWorkerRequestMessage = {
          protocolVersion: VERIFY_PROTOCOL_VERSION,
          generation: workerOutcome.generation,
          requestId,
          type: 'verify',
          model: captured.model,
          options: captured.options,
        };

        try {
          workerOutcome.instance.postMessage(payload);
        } catch (err) {
          discardWorker();
          settlePending(req, {
            kind: 'error',
            code: 'WORKER_ERROR',
            message: err instanceof Error ? err.message : 'Unable to post message to verification worker.',
            requestId,
          });
        }
      });
    },

    cancel() {
      if (pending !== null) {
        const current = pending;
        settlePending(current, { kind: 'cancelled', requestId: current.requestId });
      }
      discardWorker();
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      if (pending !== null) {
        const current = pending;
        settlePending(current, { kind: 'cancelled', requestId: current.requestId });
      }
      discardWorker();
    },

    getExecutionMode(): VerifyExecutionMode {
      if (stickyMainThread) return 'main-thread';
      if (execution.kind === 'app-worker' && worker === null && !isWebWorkerSupported()) {
        return 'main-thread';
      }
      return 'worker';
    },
  };

  FACTORY_CLIENTS.add(client);
  return client;
}
