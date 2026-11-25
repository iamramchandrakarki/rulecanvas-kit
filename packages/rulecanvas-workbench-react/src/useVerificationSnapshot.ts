import { useCallback, useEffect, useRef, useState } from 'react';
import {
  verifyModel,
  type TransitionSystemModel,
  type VerifyOptions,
  type VerifyResult,
} from '@rulecanvas/core';
import { createVerdictReplaySession, type ReplaySession } from '@rulecanvas/ui';
import {
  isFactoryVerifyClient,
  type VerifyClient,
  type VerifyExecutionMode,
} from '@rulecanvas/workbench/verify';

export interface VerificationRunRequest {
  readonly model: TransitionSystemModel;
  readonly options: VerifyOptions;
  readonly label: string;
  readonly revision: number;
  readonly restartWorker?: boolean | undefined;
}

export interface CommittedVerificationSnapshot {
  readonly model: TransitionSystemModel;
  readonly modelLabel: string;
  readonly options: VerifyOptions;
  readonly revision: number;
  readonly result: VerifyResult;
  readonly executionMode: VerifyExecutionMode;
}

export interface UseVerificationSnapshotOptions {
  readonly initialRequest?: VerificationRunRequest | undefined;
  readonly createClient: () => VerifyClient;
}

export interface VerificationSnapshotController {
  readonly isRunning: boolean;
  readonly runningExecutionMode: VerifyExecutionMode;
  readonly snapshot: CommittedVerificationSnapshot | null;
  readonly replaySession: ReplaySession | null;
  readonly transportError: string | null;
  readonly cancelledNotice: string | null;
  readonly run: (request: VerificationRunRequest) => void;
  readonly cancel: () => void;
  readonly invalidatePending: () => void;
  readonly clear: () => void;
  readonly setReplaySession: (next: ReplaySession | null) => void;
}

function buildReplayForResult(
  model: TransitionSystemModel,
  result: VerifyResult,
): { readonly ok: true; readonly session: ReplaySession | null } | { readonly ok: false; readonly message: string } {
  if (result.status === 'INVALID') {
    return { ok: true, session: null };
  }
  const init = createVerdictReplaySession(model, result);
  if (!init.ok) {
    return {
      ok: false,
      message: init.errors[0]?.message ?? 'Verification result failed replay consistency check.',
    };
  }
  return { ok: true, session: init.session };
}

function computeInitialState(initialRequest: VerificationRunRequest | undefined): {
  readonly snapshot: CommittedVerificationSnapshot | null;
  readonly replaySession: ReplaySession | null;
  readonly transportError: string | null;
} {
  if (initialRequest === undefined) {
    return { snapshot: null, replaySession: null, transportError: null };
  }
  const capturedModel = structuredClone(initialRequest.model) as TransitionSystemModel;
  const capturedOptions: VerifyOptions = {
    maxStates: initialRequest.options.maxStates,
    maxDepth: initialRequest.options.maxDepth,
  };
  const result = verifyModel(capturedModel, capturedOptions);
  const replay = buildReplayForResult(capturedModel, result);
  if (!replay.ok) {
    return {
      snapshot: null,
      replaySession: null,
      transportError: replay.message,
    };
  }
  return {
    snapshot: {
      model: capturedModel,
      modelLabel: initialRequest.label,
      options: capturedOptions,
      revision: initialRequest.revision,
      result,
      executionMode: 'main-thread',
    },
    replaySession: replay.session,
    transportError: null,
  };
}

export function useVerificationSnapshot({
  initialRequest,
  createClient,
}: UseVerificationSnapshotOptions): VerificationSnapshotController {
  const initialStateRef = useRef<ReturnType<typeof computeInitialState> | null>(null);
  if (initialStateRef.current === null) {
    initialStateRef.current = computeInitialState(initialRequest);
  }

  const [snapshot, setSnapshot] = useState<CommittedVerificationSnapshot | null>(
    () => initialStateRef.current!.snapshot,
  );
  const [replaySession, setReplaySession] = useState<ReplaySession | null>(
    () => initialStateRef.current!.replaySession,
  );
  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [runningExecutionMode, setRunningExecutionMode] =
    useState<VerifyExecutionMode>('main-thread');
  const [transportError, setTransportError] = useState<string | null>(
    () => initialStateRef.current!.transportError,
  );
  const [cancelledNotice, setCancelledNotice] = useState<string | null>(null);

  const clientRef = useRef<VerifyClient | null>(null);
  const createClientRef = useRef(createClient);
  createClientRef.current = createClient;

  const activeGenRef = useRef<number>(0);
  const mountedRef = useRef<boolean>(false);

  useEffect(() => {
    mountedRef.current = true;
    const client = createClientRef.current();
    if (!isFactoryVerifyClient(client)) {
      throw new TypeError(
        'useVerificationSnapshot requires a VerifyClient created by createVerifyClient().',
      );
    }
    clientRef.current = client;
    setRunningExecutionMode(client.getExecutionMode());

    return () => {
      mountedRef.current = false;
      activeGenRef.current += 1;
      client.dispose();
      if (clientRef.current === client) {
        clientRef.current = null;
      }
    };
  }, []);

  const invalidatePending = useCallback(() => {
    activeGenRef.current += 1;
    clientRef.current?.cancel();
    setIsRunning(false);
  }, []);

  const cancel = useCallback(() => {
    activeGenRef.current += 1;
    clientRef.current?.cancel();
    setIsRunning(false);
    setCancelledNotice('Verification cancelled. Previous verified snapshot (if any) remains shown.');
  }, []);

  const clear = useCallback(() => {
    activeGenRef.current += 1;
    clientRef.current?.cancel();
    setIsRunning(false);
    setSnapshot(null);
    setReplaySession(null);
    setTransportError(null);
    setCancelledNotice(null);
  }, []);

  const run = useCallback((request: VerificationRunRequest) => {
    activeGenRef.current += 1;
    const gen = activeGenRef.current;

    const client = clientRef.current;
    setCancelledNotice(null);
    setTransportError(null);

    if (client === null) {
      const capturedModel = structuredClone(request.model) as TransitionSystemModel;
      const capturedOptions: VerifyOptions = {
        maxStates: request.options.maxStates,
        maxDepth: request.options.maxDepth,
      };
      const result = verifyModel(capturedModel, capturedOptions);
      const replay = buildReplayForResult(capturedModel, result);
      setIsRunning(false);
      if (!replay.ok) {
        setTransportError(replay.message);
        return;
      }
      setSnapshot({
        model: capturedModel,
        modelLabel: request.label,
        options: capturedOptions,
        revision: request.revision,
        result,
        executionMode: 'main-thread',
      });
      setReplaySession(replay.session);
      return;
    }

    setIsRunning(true);
    setRunningExecutionMode(client.getExecutionMode());

    void client
      .verify(
        request.model,
        request.options,
        request.restartWorker !== undefined ? { restartWorker: request.restartWorker } : undefined,
      )
      .then((settlement) => {
        if (!mountedRef.current || activeGenRef.current !== gen || clientRef.current !== client) {
          return;
        }
        setIsRunning(false);

        if (settlement.kind === 'cancelled') {
          return;
        }

        if (settlement.kind === 'error') {
          if (settlement.code === 'CAPTURE_ERROR' && settlement.errors !== undefined) {
            setSnapshot({
              model: request.model,
              modelLabel: request.label,
              options: request.options,
              revision: request.revision,
              result: { status: 'INVALID', errors: settlement.errors },
              executionMode: 'main-thread',
            });
            setReplaySession(null);
            return;
          }
          setTransportError(settlement.message);
          return;
        }

        const replay = buildReplayForResult(settlement.capturedModel, settlement.result);
        if (!replay.ok) {
          setTransportError(replay.message);
          return;
        }

        setRunningExecutionMode(settlement.executionMode);
        setSnapshot({
          model: settlement.capturedModel,
          modelLabel: request.label,
          options: settlement.capturedOptions,
          revision: request.revision,
          result: settlement.result,
          executionMode: settlement.executionMode,
        });
        setReplaySession(replay.session);
      });
  }, []);

  return {
    isRunning,
    runningExecutionMode,
    snapshot,
    replaySession,
    transportError,
    cancelledNotice,
    run,
    cancel,
    invalidatePending,
    clear,
    setReplaySession,
  };
}
