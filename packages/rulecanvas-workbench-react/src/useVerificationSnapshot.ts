import { useCallback, useEffect, useRef, useState } from 'react';
import {
  verifyModel,
  type TransitionSystemModel,
  type VerifyOptions,
  type VerifyResult,
} from '@rulecanvas/core';
import { createVerdictReplaySession, type ReplaySession } from '@rulecanvas/ui';
import {
  captureVerificationRequest,
  deepFreeze,
  isFactoryVerifyClient,
  sanitizeAndFreezeVerifyResult,
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
  readonly isPending: () => boolean;
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
  const init = createVerdictReplaySession(model, result, { startAt: 'terminal' });
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
  const captured = captureVerificationRequest(initialRequest.model, initialRequest.options);
  if (!captured.ok) {
    return {
      snapshot: null,
      replaySession: null,
      transportError: captured.message,
    };
  }
  const rawResult = verifyModel(captured.model, captured.options);
  const checked = sanitizeAndFreezeVerifyResult(rawResult, captured.model, captured.options);
  if (!checked.ok) {
    return {
      snapshot: null,
      replaySession: null,
      transportError: checked.message,
    };
  }
  const replay = buildReplayForResult(captured.model, checked.result);
  if (!replay.ok) {
    return {
      snapshot: null,
      replaySession: null,
      transportError: replay.message,
    };
  }
  return {
    snapshot: deepFreeze({
      model: captured.model,
      modelLabel: String(initialRequest.label),
      options: captured.options,
      revision: Number(initialRequest.revision),
      result: checked.result,
      executionMode: 'main-thread' as const,
    }),
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

  const [{ snapshot, replaySession }, setCommitted] = useState(() => ({
    snapshot: initialStateRef.current!.snapshot,
    replaySession: initialStateRef.current!.replaySession,
  }));
  const setReplaySession = useCallback((next: ReplaySession | null) => {
    setCommitted((previous) => ({ ...previous, replaySession: next }));
  }, []);
  const [isRunning, setIsRunning] = useState(false);
  const pendingRef = useRef(false);
  const isPending = useCallback(() => pendingRef.current, []);
  const setPending = useCallback((pending: boolean) => {
    pendingRef.current = pending;
    setIsRunning(pending);
  }, []);
  const [runningExecutionMode, setRunningExecutionMode] =
    useState<VerifyExecutionMode>('main-thread');
  const [transportError, setTransportError] = useState<string | null>(
    () => initialStateRef.current!.transportError,
  );
  const [cancelledNotice, setCancelledNotice] = useState<string | null>(null);

  const clientRef = useRef<VerifyClient | null>(null);

  const activeGenRef = useRef<number>(0);
  const mountedRef = useRef<boolean>(false);

  useEffect(() => {
    mountedRef.current = true;
    setPending(false);
    activeGenRef.current += 1;
    const client = createClient();
    if (!isFactoryVerifyClient(client)) {
      throw new TypeError(
        'useVerificationSnapshot requires a VerifyClient created by createVerifyClient().',
      );
    }
    clientRef.current = client;
    setRunningExecutionMode(client.getExecutionMode());

    return () => {
      mountedRef.current = false;
      pendingRef.current = false;
      activeGenRef.current += 1;
      client.dispose();
      if (clientRef.current === client) {
        clientRef.current = null;
      }
    };
  }, [createClient, setPending]);

  const invalidatePending = useCallback(() => {
    activeGenRef.current += 1;
    clientRef.current?.cancel();
    setPending(false);
  }, [setPending]);

  const cancel = useCallback(() => {
    activeGenRef.current += 1;
    clientRef.current?.cancel();
    setPending(false);
    setCancelledNotice('Verification cancelled. Previous verified snapshot (if any) remains shown.');
  }, [setPending]);

  const clear = useCallback(() => {
    activeGenRef.current += 1;
    clientRef.current?.cancel();
    setPending(false);
    setCommitted({ snapshot: null, replaySession: null });
    setTransportError(null);
    setCancelledNotice(null);
  }, [setPending]);

  const run = useCallback((request: VerificationRunRequest) => {
    activeGenRef.current += 1;
    const gen = activeGenRef.current;
    const capturedLabel = String(request.label);
    const capturedRevision = Number(request.revision);

    const client = clientRef.current;
    setCancelledNotice(null);
    setTransportError(null);

    if (client === null) {
      const captured = captureVerificationRequest(request.model, request.options);
      setPending(false);
      if (!captured.ok) {
        setTransportError(captured.message);
        return;
      }
      const rawResult = verifyModel(captured.model, captured.options);
      const checked = sanitizeAndFreezeVerifyResult(rawResult, captured.model, captured.options);
      if (!checked.ok) {
        setTransportError(checked.message);
        return;
      }
      const replay = buildReplayForResult(captured.model, checked.result);
      if (!replay.ok) {
        setTransportError(replay.message);
        return;
      }
      setCommitted({
        snapshot: deepFreeze({
            model: captured.model,
            modelLabel: capturedLabel,
            options: captured.options,
            revision: capturedRevision,
            result: checked.result,
            executionMode: 'main-thread' as const,
        }),
        replaySession: replay.session,
      });
      return;
    }

    setPending(true);
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
        setPending(false);

        if (settlement.kind === 'cancelled') {
          return;
        }

        if (settlement.kind === 'error') {
          setTransportError(settlement.message);
          return;
        }

        const replay = buildReplayForResult(settlement.capturedModel, settlement.result);
        if (!replay.ok) {
          setTransportError(replay.message);
          return;
        }

        setRunningExecutionMode(settlement.executionMode);
        setCommitted({
          snapshot: deepFreeze({
              model: settlement.capturedModel,
              modelLabel: capturedLabel,
              options: settlement.capturedOptions,
              revision: capturedRevision,
              result: settlement.result,
              executionMode: settlement.executionMode,
          }),
          replaySession: replay.session,
        });
      });
  }, [setPending]);

  return {
    isRunning,
    isPending,
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
