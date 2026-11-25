import { verifyModel, type TransitionSystemModel, type VerifyOptions, type VerifyResult } from '@rulecanvas/core';

export const VERIFY_PROTOCOL_VERSION = 1 as const;

export interface VerifyWorkerRequestMessage {
  readonly protocolVersion: typeof VERIFY_PROTOCOL_VERSION;
  readonly generation: number;
  readonly requestId: number;
  readonly type: 'verify';
  readonly model: TransitionSystemModel;
  readonly options: VerifyOptions;
}

export type VerifyWorkerResponseMessage =
  | {
      readonly protocolVersion: typeof VERIFY_PROTOCOL_VERSION;
      readonly generation: number;
      readonly requestId: number;
      readonly type: 'result';
      readonly result: VerifyResult;
    }
  | {
      readonly protocolVersion: typeof VERIFY_PROTOCOL_VERSION;
      readonly generation: number;
      readonly requestId: number;
      readonly type: 'error';
      readonly message: string;
    };

export interface VerifyWorkerMessageEvent {
  readonly data: unknown;
}

export interface VerifyWorkerPort {
  onmessage: ((event: VerifyWorkerMessageEvent) => void) | null;
  postMessage(message: VerifyWorkerResponseMessage): void;
}

function isVerifyRequestMessage(data: unknown): data is VerifyWorkerRequestMessage {
  if (typeof data !== 'object' || data === null) return false;
  const rec = data as Record<string, unknown>;
  return (
    rec['protocolVersion'] === VERIFY_PROTOCOL_VERSION &&
    typeof rec['generation'] === 'number' &&
    Number.isSafeInteger(rec['generation']) &&
    rec['generation'] >= 1 &&
    typeof rec['requestId'] === 'number' &&
    Number.isSafeInteger(rec['requestId']) &&
    rec['requestId'] >= 1 &&
    rec['type'] === 'verify'
  );
}

/**
 * Registers the versioned RuleCanvasKit verification handler on a structural worker port.
 * Does not touch global `self` on module import.
 */
export function installVerifyWorker(port: VerifyWorkerPort): () => void {
  const handler = (event: VerifyWorkerMessageEvent): void => {
    const data = event?.data;
    if (!isVerifyRequestMessage(data)) {
      return;
    }
    try {
      const result = verifyModel(data.model, data.options);
      port.postMessage({
        protocolVersion: VERIFY_PROTOCOL_VERSION,
        generation: data.generation,
        requestId: data.requestId,
        type: 'result',
        result,
      });
    } catch (err) {
      port.postMessage({
        protocolVersion: VERIFY_PROTOCOL_VERSION,
        generation: data.generation,
        requestId: data.requestId,
        type: 'error',
        message: err instanceof Error ? err.message : 'Unexpected verification worker error.',
      });
    }
  };

  port.onmessage = handler;
  return () => {
    if (port.onmessage === handler) {
      port.onmessage = null;
    }
  };
}
