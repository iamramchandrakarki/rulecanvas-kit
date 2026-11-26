import { useCallback, useEffect, useRef, useState } from 'react';
import { resolveSameOriginNavigationHref } from './navigation-href.js';

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
  traverseTo?: ((key: string) => {
    readonly committed?: Promise<unknown>;
    readonly finished?: Promise<unknown>;
  }) | undefined;
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

interface CanonicalRelativeUrl {
  readonly pathAndSearch: string;
  readonly hash: string;
  readonly relative: string;
}

function getUrlHash(url: URL): string {
  return url.hash || (url.href.endsWith('#') ? '#' : '');
}

function parseCanonicalPresetUrl(currentHref: string, preset: string): CanonicalRelativeUrl {
  const url = new URL(currentHref);
  url.searchParams.set('preset', preset);
  const pathAndSearch = `${url.pathname}${url.search}`;
  const hash = getUrlHash(url);
  return {
    pathAndSearch,
    hash,
    relative: `${pathAndSearch}${hash}`,
  };
}

export function buildCanonicalPresetUrl(currentHref: string, preset: string): string {
  return parseCanonicalPresetUrl(currentHref, preset).relative;
}

let controllerInstanceSeq = 0;

function allocateControllerNonce(existingStamp: HistoryStamp | null): string {
  const seq = ++controllerInstanceSeq;
  if (typeof crypto !== 'undefined') {
    if (typeof crypto.randomUUID === 'function') {
      return `${crypto.randomUUID()}-${seq}`;
    }
    if (typeof crypto.getRandomValues === 'function') {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      let hex = '';
      for (const byte of bytes) {
        hex += byte.toString(16).padStart(2, '0');
      }
      return `${hex}-${seq}`;
    }
  }
  const prevMatch = existingStamp?.sessionId.match(/^rc-sess-g(\d+)-/);
  const nextGen = prevMatch !== null && prevMatch !== undefined ? Number(prevMatch[1]) + 1 : 1;
  return `g${nextGen}-${seq}`;
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

  const existingInitialStamp = isHistoryStamp(host.history.state) ? host.history.state : null;
  const controllerNonce = allocateControllerNonce(existingInitialStamp);
  let sessionSeq = 1;
  let entrySeq = 1;
  const allocSessionId = (): string => `rc-sess-${controllerNonce}-${sessionSeq++}`;
  const allocEntryId = (): string => `rc-entry-${controllerNonce}-${entrySeq++}`;

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
  const initialCanonical = parseCanonicalPresetUrl(host.location.href, initialRead.preset);
  let sessionId = allocSessionId();
  let acceptedStamp: HistoryStamp = {
    __rulecanvasRoute: true,
    sessionId,
    entryId: allocEntryId(),
    index: 0,
    preset: initialRead.preset,
  };
  let acceptedUrl = initialCanonical.relative;
  let acceptedPathAndSearch = initialCanonical.pathAndSearch;
  let acceptedHash = initialCanonical.hash;
  host.history.replaceState(acceptedStamp, '', acceptedUrl);
  let acceptedNavKey: string | null = currentNavKey();

  let activePrompt: PendingDiscardPrompt<TPreset> | null = null;
  let pendingPopstateCandidate: {
    readonly preset: TPreset;
    readonly stamp: HistoryStamp | null;
    readonly navKey: string | null;
    readonly url: CanonicalRelativeUrl;
  } | null = null;

  let restorationToken: {
    readonly sessionId: string;
    readonly entryId: string;
    readonly navKey: string;
  } | null = null;

  let approvedUnloadHref: string | null = null;
  let historyUrlDiverged = false;
  let disposed = false;

  const setAcceptedUrl = (canonical: CanonicalRelativeUrl): void => {
    acceptedUrl = canonical.relative;
    acceptedPathAndSearch = canonical.pathAndSearch;
    acceptedHash = canonical.hash;
  };

  const getLiveRelativeUrl = (): string => {
    const parsedUrl = new URL(host.location.href);
    return `${parsedUrl.pathname}${parsedUrl.search}${getUrlHash(parsedUrl)}`;
  };

  const setPrompt = (next: PendingDiscardPrompt<TPreset> | null): void => {
    activePrompt = next;
    onPromptChange(next);
  };

  const clearRestoration = (): void => {
    restorationToken = null;
    pendingPopstateCandidate = null;
    historyUrlDiverged = false;
    if (activePrompt?.kind === 'popstate') {
      setPrompt(null);
    }
  };

  const applyFreshSessionReplaceRecovery = (): void => {
    if (disposed) return;
    clearRestoration();

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

  const settleRestoration = (token: NonNullable<typeof restorationToken>): void => {
    if (disposed || restorationToken !== token) return;
    const state = host.history.state;
    if (
      isHistoryStamp(state) &&
      state.sessionId === token.sessionId &&
      state.entryId === token.entryId &&
      currentNavKey() === token.navKey &&
      getLiveRelativeUrl() === acceptedUrl
    ) {
      clearRestoration();
      return;
    }
    applyFreshSessionReplaceRecovery();
  };

  const restoreAcceptedUrl = (): void => {
    if (disposed) return;
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
          curState.entryId === acceptedStamp.entryId &&
          getLiveRelativeUrl() === acceptedUrl
        ) {
          restorationToken = null;
          historyUrlDiverged = false;
          return;
        }
        // Already on acceptedNavKey with diverged state/URL: traverseTo(currentKey) is a no-op,
        // so repair synchronously via fresh-session replaceState instead of leaking restorationToken.
        applyFreshSessionReplaceRecovery();
        return;
      }
      const token = {
        sessionId: acceptedStamp.sessionId,
        entryId: acceptedStamp.entryId,
        navKey: acceptedNavKey,
      };
      restorationToken = token;
      try {
        const navResult = host.navigation.traverseTo(acceptedNavKey);
        // An aborted traversal can reject both promises. Recover once through finished.
        void navResult?.committed?.catch(() => {});
        const settle = () => settleRestoration(token);
        if (navResult?.finished === undefined) {
          settle();
        } else {
          void navResult.finished.then(settle, settle);
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
    if (disposed) return;
    restorationToken = null;
    historyUrlDiverged = false;
    pendingPopstateCandidate = null;
    const nextCanonical = parseCanonicalPresetUrl(host.location.href, nextPreset);
    const nextUrl = nextCanonical.relative;
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
      setAcceptedUrl(nextCanonical);
      acceptedNavKey = currentNavKey();
    } else {
      const liveRaw = host.history.state;
      const liveStamp = isHistoryStamp(liveRaw) ? liveRaw : null;
      if (liveStamp !== null && liveStamp.sessionId === sessionId) {
        acceptedStamp = { ...liveStamp, preset: nextPreset };
        if (liveStamp.preset !== nextPreset) {
          host.history.replaceState(acceptedStamp, '', nextUrl);
        }
      } else {
        sessionId = allocSessionId();
        acceptedStamp = {
          __rulecanvasRoute: true,
          sessionId,
          entryId: allocEntryId(),
          index: 0,
          preset: nextPreset,
        };
        host.history.replaceState(acceptedStamp, '', nextUrl);
      }
      setAcceptedUrl(nextCanonical);
      acceptedNavKey = currentNavKey();
    }
    onCommitPreset(nextPreset);
  };

  const handlePopstate = (): void => {
    if (disposed) return;
    approvedUnloadHref = null;
    if (restorationToken !== null) {
      settleRestoration(restorationToken);
      return;
    }

    const rawState = host.history.state;
    const stamp = isHistoryStamp(rawState) ? rawState : null;
    const navKey = currentNavKey();

    const parsed = readPresetFromSearch(host.location.search, allowedPresets, defaultPreset);
    const canonical = parseCanonicalPresetUrl(host.location.href, parsed.preset);

    // Returning to the exact currently-accepted entry leaves editor state untouched
    const isExactAcceptedEntry =
      stamp !== null &&
      stamp.sessionId === acceptedStamp.sessionId &&
      stamp.entryId === acceptedStamp.entryId &&
      (acceptedNavKey === null || navKey === acceptedNavKey) &&
      canonical.relative === acceptedUrl;

    if (isExactAcceptedEntry) {
      historyUrlDiverged = false;
      pendingPopstateCandidate = null;
      if (activePrompt?.kind === 'popstate') {
        setPrompt(null);
      }
      if (!parsed.isCanonical || getLiveRelativeUrl() !== acceptedUrl) {
        host.history.replaceState(acceptedStamp, '', acceptedUrl);
      }
      return;
    }

    // Hash-only traversal on the same preset must never reset dirty state or prompt for discard
    const isHashOnlySamePreset =
      parsed.preset === acceptedStamp.preset &&
      canonical.pathAndSearch === acceptedPathAndSearch &&
      canonical.hash !== acceptedHash;

    if (isHashOnlySamePreset) {
      historyUrlDiverged = false;
      pendingPopstateCandidate = null;
      if (activePrompt?.kind === 'popstate') {
        setPrompt(null);
      }
      if (stamp !== null && stamp.sessionId === sessionId) {
        acceptedStamp = { ...stamp, preset: acceptedStamp.preset };
        if (!parsed.isCanonical || stamp.preset !== acceptedStamp.preset) {
          host.history.replaceState(acceptedStamp, '', canonical.relative);
        }
        setAcceptedUrl(canonical);
        acceptedNavKey = navKey;
      } else if (stamp === null) {
        // Browser-pushed fragment entry (state === null): keep the current session intact
        acceptedStamp = {
          __rulecanvasRoute: true,
          sessionId,
          entryId: allocEntryId(),
          index: acceptedStamp.index + 1,
          preset: acceptedStamp.preset,
        };
        host.history.replaceState(acceptedStamp, '', canonical.relative);
        setAcceptedUrl(canonical);
        acceptedNavKey = currentNavKey();
      } else {
        // Foreign/old-session entry differing only in hash: isolate under a fresh session without resetting edits
        sessionId = allocSessionId();
        acceptedStamp = {
          __rulecanvasRoute: true,
          sessionId,
          entryId: allocEntryId(),
          index: 0,
          preset: acceptedStamp.preset,
        };
        host.history.replaceState(acceptedStamp, '', canonical.relative);
        setAcceptedUrl(canonical);
        acceptedNavKey = currentNavKey();
      }
      return;
    }

    // If editor is dirty, never silently overwrite — open or update single discard prompt
    if (isDirty()) {
      historyUrlDiverged = true;
      pendingPopstateCandidate = {
        preset: parsed.preset,
        stamp,
        navKey,
        url: canonical,
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
      if (!parsed.isCanonical || stamp.preset !== parsed.preset) {
        host.history.replaceState(acceptedStamp, '', canonical.relative);
      }
      setAcceptedUrl(canonical);
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
      host.history.replaceState(acceptedStamp, '', canonical.relative);
      setAcceptedUrl(canonical);
      acceptedNavKey = currentNavKey();
    }
    onCommitPreset(parsed.preset);
  };

  const handleBeforeUnload = (event: unknown): void => {
    if (disposed) return;
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
      if (disposed) return;
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
      if (disposed) return;
      const trimmedHref = href.trim();
      if (resolveSameOriginNavigationHref(trimmedHref, host.location.href) === null) {
        return;
      }
      approvedUnloadHref = null;
      if (isDirty()) {
        pendingPopstateCandidate = null;
        setPrompt({
          kind: 'link',
          targetHref: trimmedHref,
          label: `Open ${label}`,
        });
        return;
      }
      clearRestoration();
      host.location.assign(trimmedHref);
    },

    acceptPrompt() {
      if (disposed) return;
      const prompt = activePrompt;
      if (prompt === null) return;
      setPrompt(null);

      if (prompt.kind === 'preset' && prompt.targetPreset !== undefined) {
        commitPresetWithPush(prompt.targetPreset);
        return;
      }

      if (prompt.kind === 'link' && prompt.targetHref !== undefined) {
        const targetHref = prompt.targetHref;
        if (resolveSameOriginNavigationHref(targetHref, host.location.href) === null) {
          return;
        }
        clearRestoration();
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
        const liveCanonical = parseCanonicalPresetUrl(host.location.href, liveParsed.preset);
        const liveNavKey = currentNavKey();
        const liveRawState = host.history.state;
        const liveStamp = isHistoryStamp(liveRawState) ? liveRawState : null;

        const isCurrent =
          liveCanonical.relative === candidate.url.relative &&
          (candidate.navKey === null || liveNavKey === candidate.navKey);

        const effectivePreset = isCurrent ? candidate.preset : liveParsed.preset;
        const effectiveCanonical = isCurrent ? candidate.url : liveCanonical;
        const effectiveStamp = isCurrent ? candidate.stamp : liveStamp;
        const effectiveNavKey = isCurrent ? candidate.navKey : liveNavKey;

        if (effectiveStamp !== null && effectiveStamp.sessionId === sessionId) {
          acceptedStamp = { ...effectiveStamp, preset: effectivePreset };
          if (!liveParsed.isCanonical || effectiveStamp.preset !== effectivePreset) {
            host.history.replaceState(acceptedStamp, '', effectiveCanonical.relative);
          }
          setAcceptedUrl(effectiveCanonical);
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
          host.history.replaceState(acceptedStamp, '', effectiveCanonical.relative);
          setAcceptedUrl(effectiveCanonical);
          acceptedNavKey = currentNavKey();
        }
        onCommitPreset(effectivePreset);
      }
    },

    declinePrompt() {
      if (disposed) return;
      const prompt = activePrompt;
      if (prompt === null) return;
      setPrompt(null);

      if (prompt.kind !== 'popstate' && !historyUrlDiverged) {
        return;
      }

      restoreAcceptedUrl();
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      host.removeEventListener('popstate', handlePopstate);
      host.removeEventListener('beforeunload', handleBeforeUnload);
      restorationToken = null;
      pendingPopstateCandidate = null;
      historyUrlDiverged = false;
      approvedUnloadHref = null;
      if (activePrompt !== null) {
        setPrompt(null);
      }
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

  const stableAllowedPresetsRef = useRef<readonly TPreset[]>(allowedPresets);
  if (
    stableAllowedPresetsRef.current.length !== allowedPresets.length ||
    stableAllowedPresetsRef.current.some((preset, index) => preset !== allowedPresets[index])
  ) {
    stableAllowedPresetsRef.current = allowedPresets;
  }
  const stableAllowedPresets = stableAllowedPresetsRef.current;

  useEffect(() => {
    if (typeof window === 'undefined') return;
    setPendingPrompt(null);
    const ctrl = createWorkbenchHistoryController<TPreset>({
      host: window as unknown as HistoryHostLike,
      allowedPresets: stableAllowedPresets,
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
      setPendingPrompt(null);
    };
  }, [stableAllowedPresets, defaultPreset]);

  const selectPreset = useCallback((preset: TPreset) => {
    controllerRef.current?.selectPreset(preset);
  }, []);

  const requestLinkNavigation = useCallback((href: string, label: string) => {
    controllerRef.current?.requestLinkNavigation(href, label);
  }, []);

  const acceptPrompt = useCallback(() => {
    controllerRef.current?.acceptPrompt();
  }, []);

  const declinePrompt = useCallback(() => {
    if (controllerRef.current !== null) {
      controllerRef.current.declinePrompt();
    } else {
      setPendingPrompt(null);
    }
  }, []);

  return {
    pendingPrompt,
    selectPreset,
    requestLinkNavigation,
    acceptPrompt,
    declinePrompt,
  };
}
