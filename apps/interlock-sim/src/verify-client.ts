import {
  verifyModel,
  type TransitionSystemModel,
  type VerifyOptions,
  type VerifyResult,
} from '@rulecanvas/core';
import {
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
    }
  | { readonly status: 'cancelled'; readonly requestId: number }
  | { readonly status: 'error'; readonly requestId: number; readonly message: string };

export function createBrowserVerifyWorker(): VerifyWorkerInstance {
  return new Worker(new URL('./verify.worker.ts', import.meta.url), {
    type: 'module',
  }) as unknown as VerifyWorkerInstance;
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

export class VerifyWorkerClient {
  private readonly inner: VerifyClient;
  private readonly restartOnSupersede: boolean;
  private running = false;
  private activeToken = 0;

  constructor(options?: VerifyClientOptions) {
    this.restartOnSupersede = options?.restartOnSupersede ?? false;
    if (options?.workerFactory !== undefined) {
      const legacyFactory = options.workerFactory;
      this.inner = createVerifyClient({
        execution: {
          kind: 'injected-worker',
          createWorker: createLegacyWorkerAdapter(
            () => legacyFactory() as unknown as LegacyWorkerLike,
          ),
        },
      });
    } else {
      this.inner = createVerifyClient({
        execution: {
          kind: 'app-worker',
          createWorker: createBrowserVerifyWorker,
          asyncStartupError: 'fallback',
        },
      });
    }
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
