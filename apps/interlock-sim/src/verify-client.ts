import {
  verifyModel,
  type TransitionSystemModel,
  type VerifyOptions,
  type VerifyResult,
} from '@rulecanvas/core';
import type { VerifyWorkerRequest, VerifyWorkerResponse } from './verify.worker.js';

export type VerifyExecutionMode = 'worker' | 'main-thread';

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

interface PendingRequest {
  readonly requestId: number;
  readonly model: TransitionSystemModel;
  readonly options: VerifyOptions;
  readonly resolve: (outcome: VerifyClientOutcome) => void;
}

export function isWebWorkerSupported(): boolean {
  return typeof globalThis !== 'undefined' && typeof globalThis.Worker === 'function';
}

export function createBrowserVerifyWorker(): WorkerLike {
  return new Worker(new URL('./verify.worker.ts', import.meta.url), {
    type: 'module',
  }) as unknown as WorkerLike;
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
  private readonly hasCustomFactory: boolean;
  private workerFactory: WorkerFactory;
  private readonly restartOnSupersede: boolean;
  private executionMode: VerifyExecutionMode;
  private worker: WorkerLike | null = null;
  private workerHasResponded = false;
  private nextRequestId = 0;
  private pending: PendingRequest | null = null;

  constructor(options?: VerifyClientOptions) {
    this.restartOnSupersede = options?.restartOnSupersede ?? false;
    if (options?.workerFactory !== undefined) {
      this.hasCustomFactory = true;
      this.workerFactory = options.workerFactory;
      this.executionMode = 'worker';
    } else {
      this.hasCustomFactory = false;
      if (isWebWorkerSupported()) {
        this.workerFactory = createBrowserVerifyWorker;
        this.executionMode = 'worker';
      } else {
        this.workerFactory = createSynchronousWorkerFactory();
        this.executionMode = 'main-thread';
      }
    }
  }

  public getExecutionMode(): VerifyExecutionMode {
    return this.executionMode;
  }

  public isRunning(): boolean {
    return this.pending !== null;
  }

  private instantiateWorker(): WorkerLike {
    if (this.hasCustomFactory) {
      return this.workerFactory();
    }

    if (this.executionMode === 'worker') {
      if (!isWebWorkerSupported()) {
        this.workerFactory = createSynchronousWorkerFactory();
        this.executionMode = 'main-thread';
        return this.workerFactory();
      }
      try {
        return this.workerFactory();
      } catch {
        this.workerFactory = createSynchronousWorkerFactory();
        this.executionMode = 'main-thread';
        return this.workerFactory();
      }
    }

    return this.workerFactory();
  }

  private ensureWorker(): WorkerLike {
    if (this.worker !== null) {
      return this.worker;
    }

    const instance = this.instantiateWorker();
    this.workerHasResponded = false;
    instance.onmessage = (event) => {
      if (this.worker !== instance) {
        return;
      }
      this.workerHasResponded = true;
      const response = event.data;
      if (response === undefined || response === null) {
        return;
      }
      if (this.pending === null || response.requestId !== this.pending.requestId) {
        return;
      }

      const current = this.pending;
      this.pending = null;
      if (response.type === 'result') {
        current.resolve({
          status: 'completed',
          requestId: response.requestId,
          result: response.result,
          executionMode: this.executionMode,
        });
      } else {
        current.resolve({
          status: 'error',
          requestId: response.requestId,
          message: response.message,
        });
      }
    };

    instance.onerror = (event) => {
      if (this.worker !== instance) {
        return;
      }
      const message =
        typeof event?.message === 'string' && event.message.length > 0
          ? event.message
          : 'Verification worker terminated unexpectedly.';
      const current = this.pending;
      const isStartupFailure =
        !this.hasCustomFactory && this.executionMode === 'worker' && !this.workerHasResponded;
      this.pending = null;
      this.disposeWorker();

      if (isStartupFailure && current !== null) {
        this.workerFactory = createSynchronousWorkerFactory();
        this.executionMode = 'main-thread';
        try {
          const result = verifyModel(current.model, current.options);
          current.resolve({
            status: 'completed',
            requestId: current.requestId,
            result,
            executionMode: 'main-thread',
          });
        } catch (err) {
          const fallbackMessage =
            err instanceof Error && err.message.length > 0 ? err.message : message;
          current.resolve({
            status: 'error',
            requestId: current.requestId,
            message: fallbackMessage,
          });
        }
        return;
      }

      if (current !== null) {
        current.resolve({
          status: 'error',
          requestId: current.requestId,
          message,
        });
      }
    };

    this.worker = instance;
    return instance;
  }

  private disposeWorker(): void {
    if (this.worker !== null) {
      this.worker.onmessage = null;
      this.worker.onerror = null;
      this.worker.terminate();
      this.worker = null;
      this.workerHasResponded = false;
    }
  }

  public cancel(): void {
    const current = this.pending;
    this.pending = null;
    this.disposeWorker();
    if (current !== null) {
      current.resolve({
        status: 'cancelled',
        requestId: current.requestId,
      });
    }
  }

  public dispose(): void {
    this.cancel();
  }

  public verify(
    model: TransitionSystemModel,
    options: VerifyOptions,
    callOptions?: { readonly restartWorker?: boolean },
  ): Promise<VerifyClientOutcome> {
    const shouldRestart = callOptions?.restartWorker ?? this.restartOnSupersede;

    if (this.pending !== null) {
      const superseded = this.pending;
      this.pending = null;
      if (shouldRestart) {
        this.disposeWorker();
      }
      superseded.resolve({
        status: 'cancelled',
        requestId: superseded.requestId,
      });
    }

    this.nextRequestId += 1;
    const requestId = this.nextRequestId;

    return new Promise<VerifyClientOutcome>((resolve) => {
      let worker: WorkerLike;
      try {
        worker = this.ensureWorker();
      } catch (err) {
        const message =
          err instanceof Error && err.message.length > 0
            ? err.message
            : 'Failed to initialize verification worker.';
        resolve({ status: 'error', requestId, message });
        return;
      }

      this.pending = { requestId, model, options, resolve };
      try {
        worker.postMessage({
          type: 'verify',
          requestId,
          model,
          options,
        });
      } catch (err) {
        if (this.pending?.requestId === requestId) {
          this.pending = null;
        }
        this.disposeWorker();
        const message =
          err instanceof Error && err.message.length > 0
            ? err.message
            : 'Failed to post model to verification worker.';
        resolve({ status: 'error', requestId, message });
      }
    });
  }
}
