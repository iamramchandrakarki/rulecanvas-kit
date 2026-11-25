import {
  verifyModel,
  type TransitionSystemModel,
  type VerifyOptions,
  type VerifyResult,
} from '@rulecanvas/core';
import {
  VERIFY_PROTOCOL_VERSION,
  createLegacyWorkerAdapter,
  createVerifyClient,
  isWebWorkerSupported,
  type LegacyWorkerLike,
  type VerifyClient,
  type VerifyExecutionMode,
  type VerifyWorkerInstance,
} from '@rulecanvas/workbench/verify';
import type { VerifyWorkerRequest, VerifyWorkerResponse } from './verify.worker.js';

export { isWebWorkerSupported };
export type { VerifyExecutionMode };

export interface WorkerLike {
  onmessage: ((event: { readonly data: VerifyWorkerResponse }) => void) | null;
  onerror: ((event: { readonly message?: string }) => void) | null;
  postMessage(message: VerifyWorkerRequest): void;
  terminate(): void;
}

export type WorkerFactory = () => WorkerLike;

export type VerifyClientOutcome =
  | {
      readonly status: 'completed';
      readonly requestId: number;
      readonly result: VerifyResult;
      readonly executionMode: VerifyExecutionMode;
      readonly capturedModel?: TransitionSystemModel | undefined;
      readonly capturedOptions?: VerifyOptions | undefined;
    }
  | { readonly status: 'cancelled'; readonly requestId: number }
  | { readonly status: 'error'; readonly requestId: number; readonly message: string };

function createProtocolWorker(): VerifyWorkerInstance {
  return new Worker(new URL('./verify.worker.ts', import.meta.url), {
    type: 'module',
  }) as unknown as VerifyWorkerInstance;
}

export function createBrowserVerifyWorker(): WorkerLike {
  const worker = createProtocolWorker();
  const legacy: WorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage(message) {
      worker.postMessage({ ...message, protocolVersion: VERIFY_PROTOCOL_VERSION, generation: 0 });
    },
    terminate() {
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
    },
  };
  worker.onmessage = ({ data }) => {
    const message = data as import('@rulecanvas/workbench/verify').VerifyWorkerResponseMessage;
    if (message.protocolVersion !== VERIFY_PROTOCOL_VERSION || message.generation !== 0) return;
    const { type, requestId } = message;
    legacy.onmessage?.({
      data: type === 'result'
        ? { type, requestId, result: message.result }
        : { type, requestId, message: message.message },
    });
  };
  worker.onerror = (event) => {
    const message = event.message;
    legacy.onerror?.(typeof message === 'string' ? { message } : {});
  };
  return legacy;
}

export function createSynchronousWorkerFactory(): WorkerFactory {
  return () => {
    let terminated = false;
    const worker: WorkerLike = {
      onmessage: null,
      onerror: null,
      postMessage(message: VerifyWorkerRequest) {
        if (terminated) return;
        try {
          const result = verifyModel(message.model, message.options);
          worker.onmessage?.({
            data: {
              type: 'result',
              requestId: message.requestId,
              result,
            },
          });
        } catch (err) {
          const errorMessage =
            err instanceof Error && err.message.length > 0
              ? err.message
              : 'Verification worker error.';
          worker.onmessage?.({
            data: {
              type: 'error',
              requestId: message.requestId,
              message: errorMessage,
            },
          });
        }
      },
      terminate() {
        terminated = true;
      },
    };
    return worker;
  };
}

export interface VerifyClientOptions {
  readonly workerFactory?: WorkerFactory;
  readonly restartOnSupersede?: boolean;
}

export function createAppVerifyClient(workerFactory?: WorkerFactory): VerifyClient {
  return createVerifyClient({
    execution: workerFactory === undefined
      ? {
          kind: 'app-worker',
          createWorker: createProtocolWorker,
          asyncStartupError: 'report',
        }
      : {
          kind: 'injected-worker',
          createWorker: createLegacyWorkerAdapter(
            () => workerFactory() as unknown as LegacyWorkerLike,
          ),
        },
  });
}

export class VerifyWorkerClient {
  private readonly inner: VerifyClient;
  private readonly restartOnSupersede: boolean;
  private running = false;
  private activeToken = 0;

  constructor(options?: VerifyClientOptions) {
    this.restartOnSupersede = options?.restartOnSupersede ?? false;
    this.inner = createAppVerifyClient(options?.workerFactory);
  }

  public getExecutionMode(): VerifyExecutionMode {
    return this.inner.getExecutionMode();
  }

  public isRunning(): boolean {
    return this.running;
  }

  public verify(
    model: TransitionSystemModel,
    options: VerifyOptions,
    runOptions?: { readonly restartWorker?: boolean },
  ): Promise<VerifyClientOutcome> {
    const wasRunning = this.running;
    this.activeToken += 1;
    const token = this.activeToken;
    this.running = true;
    return this.inner
      .verify(model, options, {
        restartWorker: runOptions?.restartWorker ?? (wasRunning && this.restartOnSupersede),
      })
      .then((settlement): VerifyClientOutcome => {
        if (token === this.activeToken) {
          this.running = false;
        }
        if (settlement.kind === 'cancelled') {
          return { status: 'cancelled', requestId: settlement.requestId };
        }
        if (settlement.kind === 'error') {
          if (settlement.code === 'CAPTURE_ERROR' && settlement.errors !== undefined) {
            return {
              status: 'completed',
              requestId: settlement.requestId,
              result: { status: 'INVALID', errors: settlement.errors },
              executionMode: 'main-thread',
            };
          }
          return {
            status: 'error',
            requestId: settlement.requestId,
            message: settlement.message,
          };
        }
        return {
          status: 'completed',
          requestId: settlement.requestId,
          result: settlement.result,
          executionMode: settlement.executionMode,
          capturedModel: settlement.capturedModel,
          capturedOptions: settlement.capturedOptions,
        };
      });
  }

  public cancel(): void {
    this.activeToken += 1;
    this.running = false;
    this.inner.cancel();
  }

  public dispose(): void {
    this.activeToken += 1;
    this.running = false;
    this.inner.dispose();
  }
}
