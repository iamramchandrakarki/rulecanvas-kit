import { useCallback, useEffect, useRef, useState } from 'react';

export interface HistoryStamp {
  readonly __rulecanvasRoute: true;
  readonly sessionId: string;
  readonly entryId: string;
  readonly index: number;
  readonly preset: string;
}

export interface NavigationEntryLike {
  readonly key: string;
}

export interface NavigationApiLike {
  readonly currentEntry?: NavigationEntryLike | null | undefined;
  entries?: (() => readonly NavigationEntryLike[]) | undefined;
  traverseTo?: ((key: string) => { readonly finished?: Promise<unknown> }) | undefined;
}

export interface HistoryHostLike {
  readonly location: {
    readonly href: string;
    readonly search: string;
    readonly hash: string;
    assign(url: string): void;
  };
  readonly history: {
    readonly state: unknown;
    pushState(data: unknown, unused: string, url?: string | URL | null): void;
    replaceState(data: unknown, unused: string, url?: string | URL | null): void;
  };
  readonly navigation?: NavigationApiLike | undefined;
  addEventListener(type: 'popstate' | 'beforeunload', listener: (event: unknown) => void): void;
  removeEventListener(type: 'popstate' | 'beforeunload', listener: (event: unknown) => void): void;
}

export interface PendingDiscardPrompt<TPreset extends string> {
  readonly kind: 'preset' | 'popstate' | 'link';
  readonly targetPreset?: TPreset | undefined;
  readonly targetHref?: string | undefined;
  readonly label: string;
}

export function readPresetFromSearch<TPreset extends string>(
  search: string,
  allowedPresets: readonly TPreset[],
  defaultPreset: TPreset,
): { readonly preset: TPreset; readonly isCanonical: boolean } {
  const params = new URLSearchParams(search);
  const allValues = params.getAll('preset');
  if (allValues.length !== 1) {
    return { preset: defaultPreset, isCanonical: false };
  }
  const value = allValues[0]!;
  if (allowedPresets.includes(value as TPreset)) {
    return { preset: value as TPreset, isCanonical: true };
  }
  return { preset: defaultPreset, isCanonical: false };
}

export function buildCanonicalPresetUrl(currentHref: string, preset: string): string {
  const url = new URL(currentHref);
  url.searchParams.set('preset', preset);
  return `${url.pathname}${url.search}${url.hash}`;
}

function isHistoryStamp(value: unknown): value is HistoryStamp {
  if (typeof value !== 'object' || value === null) return false;
  const rec = value as Record<string, unknown>;
  return (
    rec['__rulecanvasRoute'] === true &&
    typeof rec['sessionId'] === 'string' &&
    typeof rec['entryId'] === 'string' &&
    typeof rec['index'] === 'number' &&
    Number.isSafeInteger(rec['index']) &&
    typeof rec['preset'] === 'string'
  );
}

export interface WorkbenchHistoryControllerOptions<TPreset extends string> {
  readonly host: HistoryHostLike;
  readonly allowedPresets: readonly TPreset[];
  readonly defaultPreset: TPreset;
  readonly isDirty: () => boolean;
  readonly onCommitPreset: (preset: TPreset) => void;
  readonly onPromptChange: (prompt: PendingDiscardPrompt<TPreset> | null) => void;
  readonly formatPresetLabel?: ((preset: TPreset) => string) | undefined;
}

export interface WorkbenchHistoryController<TPreset extends string> {
  readonly getAcceptedStamp: () => HistoryStamp;
  readonly getAcceptedNavigationKey: () => string | null;
  readonly selectPreset: (preset: TPreset) => void;
  readonly requestLinkNavigation: (href: string, label: string) => void;
  readonly acceptPrompt: () => void;
  readonly declinePrompt: () => void;
  readonly dispose: () => void;
}

/**
 * Race-safe browser history controller implementing the Section 9 contract:
 * - Never issues ambiguous relative `history.go(delta)` on decline.
 * - Uses target-specific `window.navigation.traverseTo(acceptedKey)` when available
 *   (no-op if already at `acceptedKey`, guarded by session/entry/key identity).
 * - Falls back to synchronous fresh-session `history.replaceState` with a new
 *   app-session ID, new entry ID, and traversal index 0, leaving dirty editor untouched.
 */
export function createWorkbenchHistoryController<TPreset extends string>(
  options: WorkbenchHistoryControllerOptions<TPreset>,
): WorkbenchHistoryController<TPreset> {
  const {
    host,
    allowedPresets,
    defaultPreset,
    isDirty,
    onCommitPreset,
    onPromptChange,
    formatPresetLabel = (p) => p,
  } = options;

  let sessionSeq = 1;
  let entrySeq = 1;
  const allocSessionId = (): string => `rc-sess-${sessionSeq++}`;
  const allocEntryId = (): string => `rc-entry-${entrySeq++}`;

  const currentNavKey = (): string | null => host.navigation?.currentEntry?.key ?? null;
  const hasNavKey = (key: string | null): boolean => {
    if (key === null || host.navigation?.entries === undefined) return false;
    try {
      return host.navigation.entries().some((entry) => entry.key === key);
    } catch {
      return false;
    }
  };

  // Initialize accepted entry from current URL
  const initialRead = readPresetFromSearch(host.location.search, allowedPresets, defaultPreset);
  let sessionId = allocSessionId();
  let acceptedStamp: HistoryStamp = {
    __rulecanvasRoute: true,
    sessionId,
    entryId: allocEntryId(),
    index: 0,
    preset: initialRead.preset,
  };
  let acceptedUrl = buildCanonicalPresetUrl(host.location.href, initialRead.preset);
  host.history.replaceState(acceptedStamp, '', acceptedUrl);
  let acceptedNavKey: string | null = currentNavKey();

  let activePrompt: PendingDiscardPrompt<TPreset> | null = null;
  let pendingPopstateCandidate: {
    readonly preset: TPreset;
    readonly stamp: HistoryStamp | null;
    readonly navKey: string | null;
    readonly url: string;
  } | null = null;

  let restorationToken: {
    readonly sessionId: string;
    readonly entryId: string;
    readonly navKey: string;
  } | null = null;

  let approvedUnloadHref: string | null = null;
  let historyUrlDiverged = false;

  const getLiveRelativeUrl = (): string => {
    const parsedUrl = new URL(host.location.href);
    return `${parsedUrl.pathname}${parsedUrl.search}${parsedUrl.hash}`;
  };

  const setPrompt = (next: PendingDiscardPrompt<TPreset> | null): void => {
    activePrompt = next;
    onPromptChange(next);
  };

  const applyFreshSessionReplaceRecovery = (): void => {
    restorationToken = null;
    pendingPopstateCandidate = null;
    historyUrlDiverged = false;
    if (activePrompt?.kind === 'popstate') {
      setPrompt(null);
    }

    sessionId = allocSessionId();
    acceptedStamp = {
      __rulecanvasRoute: true,
      sessionId,
      entryId: allocEntryId(),
      index: 0,
      preset: acceptedStamp.preset,
    };
    host.history.replaceState(acceptedStamp, '', acceptedUrl);
    acceptedNavKey = currentNavKey();
  };

  const restoreAcceptedUrl = (): void => {
    pendingPopstateCandidate = null;

    // Target-specific restoration via Navigation API traverseTo(acceptedKey) when available
    if (
      host.navigation?.traverseTo !== undefined &&
      acceptedNavKey !== null &&
      hasNavKey(acceptedNavKey)
    ) {
      if (currentNavKey() === acceptedNavKey) {
        const curState = host.history.state;
        if (
          isHistoryStamp(curState) &&
          curState.sessionId === acceptedStamp.sessionId &&
          curState.entryId === acceptedStamp.entryId
        ) {
          historyUrlDiverged = false;
          return;
        }
      }
      const token = {
        sessionId: acceptedStamp.sessionId,
        entryId: acceptedStamp.entryId,
        navKey: acceptedNavKey,
      };
      restorationToken = token;
      try {
        const navResult = host.navigation.traverseTo(acceptedNavKey);
        if (navResult?.finished !== undefined) {
          void navResult.finished.catch(() => {
            if (restorationToken === token) {
              applyFreshSessionReplaceRecovery();
            }
          });
        }
      } catch {
        applyFreshSessionReplaceRecovery();
      }
      return;
    }

    // Classic History API fallback: synchronous fresh-session replaceState (never relative history.go)
    applyFreshSessionReplaceRecovery();
  };

  const commitPresetWithPush = (nextPreset: TPreset): void => {
    restorationToken = null;
    historyUrlDiverged = false;
    pendingPopstateCandidate = null;
    const nextUrl = buildCanonicalPresetUrl(host.location.href, nextPreset);
    const nextStamp: HistoryStamp = {
      __rulecanvasRoute: true,
      sessionId,
      entryId: allocEntryId(),
      index: acceptedStamp.index + 1,
      preset: nextPreset,
    };
    if (nextUrl !== getLiveRelativeUrl()) {
      host.history.pushState(nextStamp, '', nextUrl);
      acceptedStamp = nextStamp;
      acceptedUrl = nextUrl;
      acceptedNavKey = currentNavKey();
    } else {
      acceptedStamp = { ...acceptedStamp, preset: nextPreset };
      acceptedUrl = nextUrl;
      acceptedNavKey = currentNavKey();
    }
    onCommitPreset(nextPreset);
  };

  const handlePopstate = (): void => {
    approvedUnloadHref = null;
    const rawState = host.history.state;
    const stamp = isHistoryStamp(rawState) ? rawState : null;
    const navKey = currentNavKey();

    // Active target-specific restoration guard
    if (restorationToken !== null) {
      const token = restorationToken;
      if (
        stamp !== null &&
        stamp.sessionId === token.sessionId &&
        stamp.entryId === token.entryId &&
        navKey === token.navKey
      ) {
        restorationToken = null;
        pendingPopstateCandidate = null;
        historyUrlDiverged = false;
        if (activePrompt?.kind === 'popstate') {
          setPrompt(null);
        }
        return;
      }
      // Unowned or superseding navigation while restoring -> fresh-session replaceState recovery
      applyFreshSessionReplaceRecovery();
      return;
    }

    const parsed = readPresetFromSearch(host.location.search, allowedPresets, defaultPreset);
    const canonicalUrl = buildCanonicalPresetUrl(host.location.href, parsed.preset);

    // If editor is dirty, never silently overwrite — open or update single discard prompt
    if (isDirty()) {
      historyUrlDiverged = true;
      pendingPopstateCandidate = {
        preset: parsed.preset,
        stamp,
        navKey,
        url: canonicalUrl,
      };
      setPrompt({
        kind: 'popstate',
        targetPreset: parsed.preset,
        label: `Switch to ${formatPresetLabel(parsed.preset)}`,
      });
      return;
    }

    // Clean editor: accept popstate transition without pushing new history
    historyUrlDiverged = false;
    if (stamp !== null && stamp.sessionId === sessionId) {
      acceptedStamp = { ...stamp, preset: parsed.preset };
      if (!parsed.isCanonical) {
        host.history.replaceState(acceptedStamp, '', canonicalUrl);
      }
      acceptedUrl = canonicalUrl;
      acceptedNavKey = navKey;
    } else {
      // External/old-session entry on clean editor: adopt cleanly under fresh session
      sessionId = allocSessionId();
      acceptedStamp = {
        __rulecanvasRoute: true,
        sessionId,
        entryId: allocEntryId(),
        index: 0,
        preset: parsed.preset,
      };
      host.history.replaceState(acceptedStamp, '', canonicalUrl);
      acceptedUrl = canonicalUrl;
      acceptedNavKey = currentNavKey();
    }
    onCommitPreset(parsed.preset);
  };

  const handleBeforeUnload = (event: unknown): void => {
    if (approvedUnloadHref !== null) return;
    if (!isDirty()) return;
    const ev = event as { preventDefault?: () => void; returnValue?: string };
    ev.preventDefault?.();
    ev.returnValue = '';
  };

  host.addEventListener('popstate', handlePopstate);
  host.addEventListener('beforeunload', handleBeforeUnload);

  return {
    getAcceptedStamp: () => acceptedStamp,
    getAcceptedNavigationKey: () => acceptedNavKey,

    selectPreset(nextPreset: TPreset) {
      approvedUnloadHref = null;
      if (isDirty()) {
        pendingPopstateCandidate = null;
        setPrompt({
          kind: 'preset',
          targetPreset: nextPreset,
          label: `Load ${formatPresetLabel(nextPreset)}`,
        });
        return;
      }
      commitPresetWithPush(nextPreset);
    },

    requestLinkNavigation(href: string, label: string) {
      approvedUnloadHref = null;
      if (isDirty()) {
        pendingPopstateCandidate = null;
        setPrompt({
          kind: 'link',
          targetHref: href,
          label: `Open ${label}`,
        });
        return;
      }
      host.location.assign(href);
    },

    acceptPrompt() {
      const prompt = activePrompt;
      if (prompt === null) return;
      setPrompt(null);

      if (prompt.kind === 'preset' && prompt.targetPreset !== undefined) {
        commitPresetWithPush(prompt.targetPreset);
        return;
      }

      if (prompt.kind === 'link' && prompt.targetHref !== undefined) {
        const targetHref = prompt.targetHref;
        approvedUnloadHref = targetHref;
        try {
          host.location.assign(targetHref);
        } finally {
          queueMicrotask(() => {
            if (approvedUnloadHref === targetHref) {
              approvedUnloadHref = null;
            }
          });
        }
        return;
      }

      if (prompt.kind === 'popstate' && pendingPopstateCandidate !== null) {
        const candidate = pendingPopstateCandidate;
        pendingPopstateCandidate = null;
        historyUrlDiverged = false;

        // Verify candidate currency against live location & Navigation API entry before committing
        const liveParsed = readPresetFromSearch(host.location.search, allowedPresets, defaultPreset);
        const liveUrl = buildCanonicalPresetUrl(host.location.href, liveParsed.preset);
        const liveNavKey = currentNavKey();
        const liveRawState = host.history.state;
        const liveStamp = isHistoryStamp(liveRawState) ? liveRawState : null;

        const isCurrent =
          liveUrl === candidate.url &&
          (candidate.navKey === null || liveNavKey === candidate.navKey);

        const effectivePreset = isCurrent ? candidate.preset : liveParsed.preset;
        const effectiveUrl = isCurrent ? candidate.url : liveUrl;
        const effectiveStamp = isCurrent ? candidate.stamp : liveStamp;
        const effectiveNavKey = isCurrent ? candidate.navKey : liveNavKey;

        if (effectiveStamp !== null && effectiveStamp.sessionId === sessionId) {
          acceptedStamp = { ...effectiveStamp, preset: effectivePreset };
          acceptedUrl = effectiveUrl;
          acceptedNavKey = effectiveNavKey;
        } else {
          sessionId = allocSessionId();
          acceptedStamp = {
            __rulecanvasRoute: true,
            sessionId,
            entryId: allocEntryId(),
            index: 0,
            preset: effectivePreset,
          };
          host.history.replaceState(acceptedStamp, '', effectiveUrl);
          acceptedUrl = effectiveUrl;
          acceptedNavKey = currentNavKey();
        }
        onCommitPreset(effectivePreset);
      }
    },

    declinePrompt() {
      const prompt = activePrompt;
      if (prompt === null) return;
      setPrompt(null);

      if (prompt.kind !== 'popstate' && !historyUrlDiverged) {
        return;
      }

      restoreAcceptedUrl();
    },

    dispose() {
      host.removeEventListener('popstate', handlePopstate);
      host.removeEventListener('beforeunload', handleBeforeUnload);
      restorationToken = null;
      pendingPopstateCandidate = null;
      historyUrlDiverged = false;
      approvedUnloadHref = null;
    },
  };
}

export interface UseWorkbenchRouteOptions<TPreset extends string> {
  readonly allowedPresets: readonly TPreset[];
  readonly defaultPreset: TPreset;
  readonly isDirty: boolean;
  readonly onCommitPreset: (preset: TPreset) => void;
  readonly formatPresetLabel?: ((preset: TPreset) => string) | undefined;
}

export function useWorkbenchRoute<TPreset extends string>({
  allowedPresets,
  defaultPreset,
  isDirty,
  onCommitPreset,
  formatPresetLabel,
}: UseWorkbenchRouteOptions<TPreset>) {
  const [pendingPrompt, setPendingPrompt] = useState<PendingDiscardPrompt<TPreset> | null>(null);
  const controllerRef = useRef<WorkbenchHistoryController<TPreset> | null>(null);
  const isDirtyRef = useRef<boolean>(isDirty);
  isDirtyRef.current = isDirty;
  const onCommitRef = useRef(onCommitPreset);
  onCommitRef.current = onCommitPreset;
  const formatRef = useRef(formatPresetLabel);
  formatRef.current = formatPresetLabel;

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const ctrl = createWorkbenchHistoryController<TPreset>({
      host: window as unknown as HistoryHostLike,
      allowedPresets,
      defaultPreset,
      isDirty: () => isDirtyRef.current,
      onCommitPreset: (preset) => onCommitRef.current(preset),
      onPromptChange: setPendingPrompt,
      formatPresetLabel: (preset) => formatRef.current?.(preset) ?? preset,
    });
    controllerRef.current = ctrl;
    return () => {
      ctrl.dispose();
      if (controllerRef.current === ctrl) {
        controllerRef.current = null;
      }
    };
  }, [allowedPresets, defaultPreset]);

  const selectPreset = useCallback((preset: TPreset) => {
    if (controllerRef.current !== null) {
      controllerRef.current.selectPreset(preset);
    } else {
      onCommitRef.current(preset);
    }
  }, []);

  const requestLinkNavigation = useCallback((href: string, label: string) => {
    if (controllerRef.current !== null) {
      controllerRef.current.requestLinkNavigation(href, label);
    } else if (typeof window !== 'undefined') {
      window.location.assign(href);
    }
  }, []);

  const acceptPrompt = useCallback(() => {
    controllerRef.current?.acceptPrompt();
  }, []);

  const declinePrompt = useCallback(() => {
    controllerRef.current?.declinePrompt();
  }, []);

  return {
    pendingPrompt,
    selectPreset,
    requestLinkNavigation,
    acceptPrompt,
    declinePrompt,
  };
}
