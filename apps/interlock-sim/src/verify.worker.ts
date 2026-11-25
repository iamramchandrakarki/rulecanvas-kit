import type { TransitionSystemModel, VerifyOptions, VerifyResult } from '@rulecanvas/core';
import { installVerifyWorker, type VerifyWorkerPort } from '@rulecanvas/workbench/verify-worker';

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

installVerifyWorker(self as unknown as VerifyWorkerPort);
