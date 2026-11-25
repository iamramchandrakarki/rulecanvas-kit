import {
  verifyModel,
  type TransitionSystemModel,
  type VerifyOptions,
  type VerifyResult,
} from '@rulecanvas/core';

export interface VerifyWorkerRequest {
  readonly type: 'verify';
  readonly requestId: number;
  readonly model: TransitionSystemModel;
  readonly options: VerifyOptions;
}

export type VerifyWorkerResponse =
  | {
      readonly type: 'result';
      readonly requestId: number;
      readonly result: VerifyResult;
    }
  | {
      readonly type: 'error';
      readonly requestId: number;
      readonly message: string;
    };

interface WorkerGlobalLike {
  onmessage: ((event: { readonly data: VerifyWorkerRequest }) => void) | null;
  postMessage(message: VerifyWorkerResponse): void;
}

const workerScope = self as unknown as WorkerGlobalLike;

workerScope.onmessage = (event) => {
  const payload = event.data;
  if (payload === undefined || payload === null || payload.type !== 'verify') {
    return;
  }

  try {
    const result = verifyModel(payload.model, payload.options);
    workerScope.postMessage({
      type: 'result',
      requestId: payload.requestId,
      result,
    });
  } catch (err) {
    const message =
      err instanceof Error && err.message.length > 0
        ? err.message
        : 'Unexpected worker failure during model verification.';
    workerScope.postMessage({
      type: 'error',
      requestId: payload.requestId,
      message,
    });
  }
};
