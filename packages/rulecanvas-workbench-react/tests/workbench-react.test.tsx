import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildVerdictSummaryView } from '@rulecanvas/ui';
import { describe, expect, it, vi } from 'vitest';
import {
  AssumptionsList,
  StrictIntegerInput,
  VerdictSummary,
  WorkbenchNavigation,
  buildCanonicalPresetUrl,
  createWorkbenchHistoryController,
  isSafeSameOriginNavigationHref,
  matchesDraftPrefix,
  readPresetFromSearch,
  useWorkbenchRoute,
  type HistoryHostLike,
  type PendingDiscardPrompt,
} from '../src/index.js';

type TestPreset = 'a' | 'b' | 'c';

interface FakeEntry {
  key: string;
  url: string;
  state: unknown;
}

function createFakeHistoryHost(
  initialUrl: string,
  withNavigationApi: boolean,
): {
  readonly host: HistoryHostLike;
  readonly entries: FakeEntry[];
  readonly getCursor: () => number;
  readonly navigateToIndex: (index: number, emit?: boolean) => void;
  readonly pushFragment: (hash: string) => void;
  readonly emitPopstate: () => void;
  readonly flushTraversals: () => void;
  readonly triggerBeforeUnload: () => { defaultPrevented: boolean; returnValue: string | undefined };
  readonly assignedUrls: string[];
  readonly traverseCalls: string[];
} {
  let keySeq = 1;
  const entries: FakeEntry[] = [{ key: `nav-${keySeq++}`, url: initialUrl, state: null }];
  let cursor = 0;
  const listeners: Record<string, Set<(event: unknown) => void>> = {
    popstate: new Set(),
    beforeunload: new Set(),
  };
  const assignedUrls: string[] = [];
  const traverseCalls: string[] = [];

  const emitPopstate = () => {
    for (const fn of listeners['popstate']!) {
      fn({});
    }
  };

  const resolveUrl = (url: string | URL | null | undefined): string => {
    if (url === null || url === undefined) return entries[cursor]!.url;
    return new URL(String(url), entries[cursor]!.url).href;
  };

  const pendingTraversals: Array<() => void> = [];

  const host: HistoryHostLike = {
    location: {
      get href() {
        return entries[cursor]!.url;
      },
      get search() {
        return new URL(entries[cursor]!.url).search;
      },
      get hash() {
        return new URL(entries[cursor]!.url).hash;
      },
      assign(url: string) {
        assignedUrls.push(url);
      },
    },
    history: {
      get state() {
        return entries[cursor]!.state;
      },
      pushState(data, _unused, url) {
        entries.splice(cursor + 1);
        entries.push({ key: `nav-${keySeq++}`, url: resolveUrl(url), state: data });
        cursor = entries.length - 1;
      },
      replaceState(data, _unused, url) {
        entries[cursor] = {
          key: entries[cursor]!.key,
          url: resolveUrl(url),
          state: data,
        };
      },
    },
    ...(withNavigationApi
      ? {
          navigation: {
            get currentEntry() {
              return { key: entries[cursor]!.key };
            },
            entries() {
              return entries.map((e) => ({ key: e.key }));
            },
            traverseTo(key: string) {
              traverseCalls.push(key);
              const targetIdx = entries.findIndex((e) => e.key === key);
              if (targetIdx < 0) {
                return { finished: Promise.reject(new Error('Key not found')) };
              }
              if (targetIdx === cursor) {
                return { finished: Promise.resolve() };
              }
              let resolveFinished!: () => void;
              const finished = new Promise<void>((resolve) => {
                resolveFinished = resolve;
              });
              pendingTraversals.push(() => {
                cursor = targetIdx;
                emitPopstate();
                resolveFinished();
              });
              return { finished };
            },
          },
        }
      : {}),
    addEventListener(type, listener) {
      listeners[type]!.add(listener);
    },
    removeEventListener(type, listener) {
      listeners[type]!.delete(listener);
    },
  };

  return {
    host,
    entries,
    getCursor: () => cursor,
    navigateToIndex(index: number, emit = true) {
      cursor = index;
      if (emit) emitPopstate();
    },
    pushFragment(hash: string) {
      const nextUrl = new URL(hash, entries[cursor]!.url).href;
      entries.splice(cursor + 1);
      entries.push({ key: `nav-${keySeq++}`, url: nextUrl, state: null });
      cursor = entries.length - 1;
      emitPopstate();
    },
    emitPopstate,
    flushTraversals() {
      while (pendingTraversals.length > 0) {
        const fn = pendingTraversals.shift()!;
        fn();
      }
    },
    triggerBeforeUnload() {
      const event = {
        defaultPrevented: false,
        returnValue: undefined as string | undefined,
        preventDefault() {
          this.defaultPrevented = true;
        },
      };
      for (const listener of listeners['beforeunload'] ?? []) {
        listener(event);
      }
      return event;
    },
    assignedUrls,
    traverseCalls,
  };
}

describe('@rulecanvas/workbench-react components, navigation, and race-safe history', () => {
  it('validates same-origin navigation hrefs and renders accessible primitives without raw HTML', () => {
    expect(isSafeSameOriginNavigationHref('../interlock-sim/', '/')).toBe(true);
    expect(isSafeSameOriginNavigationHref('/app/interlock-sim/', '/app/')).toBe(true);
    expect(isSafeSameOriginNavigationHref('/suite/interlock-sim/', '/suite')).toBe(true);
    expect(isSafeSameOriginNavigationHref('/suite-other/interlock-sim/', '/suite')).toBe(false);
    expect(isSafeSameOriginNavigationHref('/other/', '/app/')).toBe(false);
    expect(isSafeSameOriginNavigationHref('https://evil.example/')).toBe(false);
    expect(isSafeSameOriginNavigationHref('//evil.example/')).toBe(false);
    expect(isSafeSameOriginNavigationHref('\\interlock-sim/')).toBe(false);
    expect(isSafeSameOriginNavigationHref('/interlock-\tsim/')).toBe(false);
    expect(isSafeSameOriginNavigationHref('javascript:alert(1)')).toBe(false);

    const navHtml = renderToStaticMarkup(
      createElement(WorkbenchNavigation, {
        current: 'agent-gate',
        links: [
          { id: 'agent-gate', label: 'AgentGate', href: '/agent-gate/' },
          { id: 'interlock-sim', label: 'InterlockSim', href: '/interlock-sim/' },
          { id: 'evil', label: 'Evil', href: 'https://evil.example/' },
        ],
      }),
    );
    expect(navHtml).toContain('aria-current="page"');
    expect(navHtml).toContain('AgentGate');
    expect(navHtml).toContain('InterlockSim');
    expect(navHtml).not.toContain('evil.example');

    const inputHtml = renderToStaticMarkup(
      createElement(StrictIntegerInput, {
        id: 'max-depth',
        value: 50,
        ariaLabel: 'Max depth',
        onCommit: () => {},
      }),
    );
    expect(inputHtml).toContain('inputMode="numeric"');
    expect(inputHtml).toContain('value="50"');

    const view = buildVerdictSummaryView({
      status: 'VERIFIED',
      stats: {
        theoreticalStates: '10',
        statesExplored: 10,
        transitionsEvaluated: 20,
        maxDepthReached: 4,
        deadlockStatesFound: 0,
      },
      goalReachable: true,
      assumptions: [],
    });
    const summaryHtml = renderToStaticMarkup(
      createElement(VerdictSummary, { view, stale: true }),
    );
    expect(summaryHtml).toContain('OUTDATED:');
    expect(summaryHtml).toContain('data-stale="true"');

    const asmHtml = renderToStaticMarkup(
      createElement(AssumptionsList, {
        scope: 'verification-snapshot',
        items: [
          {
            id: 'a1',
            category: 'scope',
            statement: '<script>alert(1)</script>',
            notModeled: 'timing',
          },
        ],
      }),
    );
    expect(asmHtml).toContain('data-assumption-scope="verification-snapshot"');
    expect(asmHtml).not.toContain('<script>');
    expect(matchesDraftPrefix('rule:open_inner.guard.x', 'rule')).toBe(true);
    expect(matchesDraftPrefix('rules[0]', 'rule')).toBe(false);
  });

  it('parses preset query parameters strictly and preserves unrelated params and hash', () => {
    expect(readPresetFromSearch('?preset=b&foo=1', ['a', 'b', 'c'], 'a')).toEqual({
      preset: 'b',
      isCanonical: true,
    });
    expect(readPresetFromSearch('?preset=b&preset=c', ['a', 'b', 'c'], 'a')).toEqual({
      preset: 'a',
      isCanonical: false,
    });
    expect(readPresetFromSearch('?preset=unknown', ['a', 'b', 'c'], 'a')).toEqual({
      preset: 'a',
      isCanonical: false,
    });
    expect(buildCanonicalPresetUrl('https://example.org/app/?foo=1#sec', 'b')).toBe(
      '/app/?foo=1&preset=b#sec',
    );
  });

  it('prevents A->B->C overshoot under async in-flight Navigation API traverseTo and restores URL on overlapping prompts', async () => {
    const fake = createFakeHistoryHost('https://example.org/app/?preset=a', true);
    let dirty = false;
    let committed: TestPreset = 'a';
    const box: { prompt: PendingDiscardPrompt<TestPreset> | null } = { prompt: null };

    const ctrl = createWorkbenchHistoryController<TestPreset>({
      host: fake.host,
      allowedPresets: ['a', 'b', 'c'],
      defaultPreset: 'a',
      isDirty: () => dirty,
      onCommitPreset: (p) => {
        committed = p;
      },
      onPromptChange: (p) => {
        box.prompt = p;
      },
    });

    // Build history A -> B -> C, then land cleanly on B
    ctrl.selectPreset('b');
    ctrl.selectPreset('c');
    fake.navigateToIndex(1); // back to B cleanly
    expect(committed).toBe('b');

    // Dirty editor at B, user presses Back to A, then clicks Decline -> starts async traverseTo(B)
    dirty = true;
    fake.navigateToIndex(0);
    expect(box.prompt?.kind).toBe('popstate');
    ctrl.declinePrompt();

    // While traverseTo(B) is still IN-FLIGHT, a queued Forward to C arrives!
    fake.navigateToIndex(2);
    // Restoration guard must detect superseding entry C and apply fresh-session replaceState back to B
    expect(new URL(fake.host.location.href).searchParams.get('preset')).toBe('b');
    expect(committed).toBe('b');
    expect(box.prompt).toBeNull();
    fake.flushTraversals();

    // Overlapping prompt case: dirty at B, Back to A, then user selects C while history prompt is open, then declines
    fake.navigateToIndex(0);
    expect(box.prompt?.kind).toBe('popstate');
    ctrl.selectPreset('c');
    expect(box.prompt?.kind).toBe('preset');
    ctrl.declinePrompt();
    fake.flushTraversals();
    expect(new URL(fake.host.location.href).searchParams.get('preset')).toBe('b');
    expect(committed).toBe('b');

    // Approved link navigation that returns without unloading must NOT permanently disable beforeunload
    ctrl.requestLinkNavigation('../interlock-sim/', 'InterlockSim');
    expect(box.prompt?.kind).toBe('link');
    ctrl.acceptPrompt();
    expect(fake.assignedUrls).toContain('../interlock-sim/');
    await Promise.resolve();
    const unloadEvent = fake.triggerBeforeUnload();
    expect(unloadEvent.defaultPrevented).toBe(true);

    ctrl.dispose();
  });

  it('uses fresh-session replaceState recovery without Navigation API so old physical entries never satisfy the new guard', () => {
    const fake = createFakeHistoryHost('https://example.org/app/?preset=a', false);
    let dirty = false;
    let committed: TestPreset = 'a';
    const box: { prompt: PendingDiscardPrompt<TestPreset> | null } = { prompt: null };

    const ctrl = createWorkbenchHistoryController<TestPreset>({
      host: fake.host,
      allowedPresets: ['a', 'b', 'c'],
      defaultPreset: 'a',
      isDirty: () => dirty,
      onCommitPreset: (p) => {
        committed = p;
      },
      onPromptChange: (p) => {
        box.prompt = p;
      },
    });

    ctrl.selectPreset('b');
    ctrl.selectPreset('c');
    fake.navigateToIndex(1); // clean at B
    const originalBStamp = ctrl.getAcceptedStamp();
    expect(committed).toBe('b');

    // Dirty at B, go Back to A, decline -> synchronous fresh-session replaceState on index 0
    dirty = true;
    fake.navigateToIndex(0);
    expect(box.prompt?.kind).toBe('popstate');
    ctrl.declinePrompt();

    const recoveredStamp = ctrl.getAcceptedStamp();
    expect(recoveredStamp.sessionId).not.toBe(originalBStamp.sessionId);
    expect(recoveredStamp.entryId).not.toBe(originalBStamp.entryId);
    expect(recoveredStamp.index).toBe(0);
    expect(fake.host.location.search).toContain('preset=b');
    expect(committed).toBe('b');
    expect(box.prompt).toBeNull();

    // Traversing forward to the old B entry (index 1) must NOT silently alter dirty editor
    fake.navigateToIndex(1);
    expect(box.prompt?.kind).toBe('popstate');
    expect(committed).toBe('b');
    ctrl.dispose();
  });

  it('pushes URL on same-preset reselect after Back and keeps selector prompt open when delayed traverseTo completes', () => {
    const fake = createFakeHistoryHost('https://example.org/app/?preset=a', true);
    let dirty = false;
    let committed: TestPreset = 'a';
    const box: { prompt: PendingDiscardPrompt<TestPreset> | null } = { prompt: null };

    const ctrl = createWorkbenchHistoryController<TestPreset>({
      host: fake.host,
      allowedPresets: ['a', 'b', 'c'],
      defaultPreset: 'a',
      isDirty: () => dirty,
      onCommitPreset: (p) => {
        committed = p;
      },
      onPromptChange: (p) => {
        box.prompt = p;
      },
    });

    // 1. Load b, edit dirty, go Back to a, select b again, approve discard -> live URL must be ?preset=b
    ctrl.selectPreset('b');
    expect(committed).toBe('b');
    dirty = true;
    fake.navigateToIndex(0);
    expect(new URL(fake.host.location.href).searchParams.get('preset')).toBe('a');
    expect(box.prompt?.kind).toBe('popstate');

    ctrl.selectPreset('b');
    expect(box.prompt?.kind).toBe('preset');
    dirty = false;
    ctrl.acceptPrompt();
    expect(committed).toBe('b');
    expect(new URL(fake.host.location.href).searchParams.get('preset')).toBe('b');

    // 2. Load b dirty, go Back to a, decline (delayed traverseTo in flight), open selector prompt for c,
    //    then settle delayed traverseTo -> selector prompt for c must NOT be erased
    dirty = true;
    fake.navigateToIndex(0);
    expect(box.prompt?.kind).toBe('popstate');
    ctrl.declinePrompt();
    ctrl.selectPreset('c');
    expect(box.prompt?.kind).toBe('preset');
    expect(box.prompt?.targetPreset).toBe('c');

    fake.flushTraversals();
    expect(new URL(fake.host.location.href).searchParams.get('preset')).toBe('b');
    expect(box.prompt?.kind).toBe('preset');
    expect(box.prompt?.targetPreset).toBe('c');

    ctrl.dispose();
  });

  it('adopts the live entry stamp when selecting the preset already in the live URL and allocates a fresh stamp for unowned live state', () => {
    const fake = createFakeHistoryHost('https://example.org/app/?preset=a', true);
    let dirty = false;
    let committed: TestPreset = 'a';
    const box: { prompt: PendingDiscardPrompt<TestPreset> | null } = { prompt: null };

    const ctrl = createWorkbenchHistoryController<TestPreset>({
      host: fake.host,
      allowedPresets: ['a', 'b', 'c'],
      defaultPreset: 'a',
      isDirty: () => dirty,
      onCommitPreset: (p) => {
        committed = p;
      },
      onPromptChange: (p) => {
        box.prompt = p;
      },
    });

    const initialAStamp = ctrl.getAcceptedStamp();
    ctrl.selectPreset('b');
    expect(committed).toBe('b');

    // Back while dirty onto live entry `a`, then select `a` (already in live URL) and approve discard
    dirty = true;
    fake.navigateToIndex(0);
    expect(new URL(fake.host.location.href).searchParams.get('preset')).toBe('a');
    ctrl.selectPreset('a');
    expect(box.prompt?.kind).toBe('preset');
    dirty = false;
    ctrl.acceptPrompt();
    expect(committed).toBe('a');

    // Accepted stamp must match live entry `a`, NOT stale entry `b`
    const adoptedStamp = ctrl.getAcceptedStamp();
    expect(adoptedStamp.sessionId).toBe(initialAStamp.sessionId);
    expect(adoptedStamp.entryId).toBe(initialAStamp.entryId);
    expect(adoptedStamp.index).toBe(initialAStamp.index);
    expect(adoptedStamp.preset).toBe('a');

    // Declining a Forward navigation from `a` -> `b` while dirty uses Navigation API traverseTo without falling back to a new session
    dirty = true;
    fake.navigateToIndex(1);
    expect(box.prompt?.kind).toBe('popstate');
    ctrl.declinePrompt();
    fake.flushTraversals();
    expect(ctrl.getAcceptedStamp().sessionId).toBe(initialAStamp.sessionId);
    expect(new URL(fake.host.location.href).searchParams.get('preset')).toBe('a');

    // If the live entry carries a foreign/stale session stamp when matching live URL, allocate a fresh session and replaceState it
    dirty = false;
    fake.entries[fake.getCursor()]!.state = {
      __rulecanvasRoute: true,
      sessionId: 'foreign-session',
      entryId: 'foreign-entry',
      index: 9,
      preset: 'b',
    };
    ctrl.selectPreset('a');
    const recovered = ctrl.getAcceptedStamp();
    expect(recovered.sessionId).not.toBe(initialAStamp.sessionId);
    expect(recovered.sessionId).not.toBe('foreign-session');
    expect(recovered.index).toBe(0);
    expect(recovered.preset).toBe('a');
    expect(fake.host.history.state).toEqual(recovered);

    ctrl.dispose();
  });

  it('allocates unique session stamps across document reloads so pre-reload entries never collide', () => {
    const fake = createFakeHistoryHost('https://example.org/app/?preset=a', true);
    let dirty = false;
    let committed: TestPreset = 'a';
    const box: { prompt: PendingDiscardPrompt<TestPreset> | null } = { prompt: null };

    // Initial load: A -> B -> C
    const firstCtrl = createWorkbenchHistoryController<TestPreset>({
      host: fake.host,
      allowedPresets: ['a', 'b', 'c'],
      defaultPreset: 'a',
      isDirty: () => dirty,
      onCommitPreset: (p) => {
        committed = p;
      },
      onPromptChange: (p) => {
        box.prompt = p;
      },
    });
    const preReloadAStamp = firstCtrl.getAcceptedStamp();
    firstCtrl.selectPreset('b');
    const preReloadBStamp = firstCtrl.getAcceptedStamp();
    firstCtrl.selectPreset('c');
    firstCtrl.dispose();

    // Document reload at C: entries 0 (a) and 1 (b) retain pre-reload stamps
    const reloadedCtrl = createWorkbenchHistoryController<TestPreset>({
      host: fake.host,
      allowedPresets: ['a', 'b', 'c'],
      defaultPreset: 'a',
      isDirty: () => dirty,
      onCommitPreset: (p) => {
        committed = p;
      },
      onPromptChange: (p) => {
        box.prompt = p;
      },
    });
    const postReloadCStamp = reloadedCtrl.getAcceptedStamp();
    expect(postReloadCStamp.sessionId).not.toBe(preReloadAStamp.sessionId);
    expect(postReloadCStamp.entryId).not.toBe(preReloadAStamp.entryId);

    // Clean Back traversal to pre-reload entry B must adopt under a fresh session, not pre-reload session
    fake.navigateToIndex(1);
    expect(committed).toBe('b');
    const adoptedB = reloadedCtrl.getAcceptedStamp();
    expect(adoptedB.sessionId).not.toBe(preReloadBStamp.sessionId);
    expect(adoptedB.sessionId).not.toBe(postReloadCStamp.sessionId);
    expect(adoptedB.index).toBe(0);

    // Dirty Back traversal to pre-reload entry A, then same-URL selectPreset('a') + accept must allocate a fresh session
    dirty = true;
    fake.navigateToIndex(0);
    expect(box.prompt?.kind).toBe('popstate');
    reloadedCtrl.selectPreset('a');
    expect(box.prompt?.kind).toBe('preset');
    dirty = false;
    reloadedCtrl.acceptPrompt();
    const adoptedA = reloadedCtrl.getAcceptedStamp();
    expect(committed).toBe('a');
    expect(adoptedA.sessionId).not.toBe(preReloadAStamp.sessionId);
    expect(adoptedA.index).toBe(0);

    reloadedCtrl.dispose();
  });

  it('preserves dirty state across hash-only same-preset traversals and exact-entry returns', () => {
    const fake = createFakeHistoryHost('https://example.org/app/?preset=a', true);
    let dirty = false;
    const commits: TestPreset[] = [];
    const box: { prompt: PendingDiscardPrompt<TestPreset> | null } = { prompt: null };

    const ctrl = createWorkbenchHistoryController<TestPreset>({
      host: fake.host,
      allowedPresets: ['a', 'b', 'c'],
      defaultPreset: 'a',
      isDirty: () => dirty,
      onCommitPreset: (p) => {
        commits.push(p);
      },
      onPromptChange: (p) => {
        box.prompt = p;
      },
    });

    ctrl.selectPreset('b');
    expect(commits).toEqual(['b']);

    // Edit preset b (dirty), then jump across fragment anchors on the same preset
    dirty = true;
    fake.pushFragment('#details');
    expect(commits).toEqual(['b']);
    expect(box.prompt).toBeNull();
    expect(fake.host.location.hash).toBe('#details');

    fake.pushFragment('#verdict');
    expect(commits).toEqual(['b']);
    expect(box.prompt).toBeNull();
    expect(fake.host.location.hash).toBe('#verdict');

    // Back across fragment entries on the same preset must not reset dirty state or prompt
    fake.navigateToIndex(2); // #details
    expect(commits).toEqual(['b']);
    expect(box.prompt).toBeNull();
    expect(fake.host.location.hash).toBe('#details');

    fake.navigateToIndex(1); // ?preset=b (empty hash)
    expect(commits).toEqual(['b']);
    expect(box.prompt).toBeNull();
    expect(fake.host.location.hash).toBe('');

    // Forward back to #details, then Back to a DIFFERENT preset (?preset=a) must prompt and restore #details on decline
    fake.navigateToIndex(2); // #details
    fake.navigateToIndex(0); // ?preset=a
    expect(box.prompt?.kind).toBe('popstate');
    expect(box.prompt?.targetPreset).toBe('a');
    ctrl.declinePrompt();
    fake.flushTraversals();
    expect(new URL(fake.host.location.href).searchParams.get('preset')).toBe('b');
    expect(fake.host.location.hash).toBe('#details');
    expect(commits).toEqual(['b']);

    // Back to ?preset=a while dirty opens popstate prompt; manual Forward back to exact accepted entry dismisses it cleanly
    fake.navigateToIndex(0);
    expect(box.prompt?.kind).toBe('popstate');
    fake.navigateToIndex(2); // exact accepted entry (?preset=b#details)
    expect(box.prompt).toBeNull();
    expect(commits).toEqual(['b']);

    fake.navigateToIndex(1);
    fake.pushFragment('#');
    fake.navigateToIndex(1);
    expect(box.prompt).toBeNull();
    expect(commits).toEqual(['b']);

    ctrl.dispose();
  });

  it('consumes both traversal promises and keeps the accepted stamp if settlement precedes popstate', async () => {
    const fake = createFakeHistoryHost('https://example.org/app/?preset=a', true);
    const baseNav = fake.host.navigation!;
    let abort = false;
    let rejectCommitted!: () => void;
    const committed = new Promise<void>((_, reject) => {
      rejectCommitted = () => reject(new DOMException('Traversal aborted', 'AbortError'));
    });
    const consumeCommitted = vi.spyOn(committed, 'catch');
    const host: HistoryHostLike = {
      ...fake.host,
      navigation: {
        get currentEntry() {
          return baseNav.currentEntry;
        },
        entries: () => baseNav.entries!(),
        traverseTo: (key) => {
          if (abort) {
            return {
              committed,
              finished: Promise.reject(new DOMException('Traversal aborted', 'AbortError')),
            };
          }
          fake.navigateToIndex(fake.entries.findIndex((entry) => entry.key === key), false);
          return { committed: Promise.resolve(), finished: Promise.resolve() };
        },
      },
    };
    let dirty = false;
    const onCommitPreset = vi.fn();
    const ctrl = createWorkbenchHistoryController<TestPreset>({
      host,
      allowedPresets: ['a', 'b', 'c'],
      defaultPreset: 'a',
      isDirty: () => dirty,
      onCommitPreset,
      onPromptChange: () => {},
    });

    ctrl.selectPreset('b');
    const original = ctrl.getAcceptedStamp();
    dirty = true;
    fake.navigateToIndex(0);
    ctrl.declinePrompt();
    await Promise.resolve();
    expect(ctrl.getAcceptedStamp()).toEqual(original);
    fake.emitPopstate();
    expect(onCommitPreset).toHaveBeenCalledExactlyOnceWith('b');

    abort = true;
    fake.navigateToIndex(0);
    ctrl.declinePrompt();
    expect(consumeCommitted).toHaveBeenCalledOnce();
    rejectCommitted();
    await Promise.resolve();
    expect(ctrl.getAcceptedStamp().preset).toBe('b');
    expect(onCommitPreset).toHaveBeenCalledExactlyOnceWith('b');
    ctrl.dispose();
  });

  it('ignores an aborted restoration after confirming navigation to the other workbench', async () => {
    const fake = createFakeHistoryHost('https://example.org/app/?preset=a', true);
    const baseNav = fake.host.navigation!;
    let abortRestoration!: () => void;
    const finished = new Promise<void>((_, reject) => {
      abortRestoration = () => reject(new DOMException('Traversal aborted', 'AbortError'));
    });
    const host: HistoryHostLike = {
      ...fake.host,
      navigation: {
        get currentEntry() { return baseNav.currentEntry; },
        entries: () => baseNav.entries!(),
        traverseTo: () => ({ finished }),
      },
    };
    let dirty = false;
    const ctrl = createWorkbenchHistoryController<TestPreset>({
      host, allowedPresets: ['a', 'b', 'c'], defaultPreset: 'a',
      isDirty: () => dirty, onCommitPreset: () => {}, onPromptChange: () => {},
    });
    ctrl.selectPreset('b');
    dirty = true;
    fake.navigateToIndex(0);
    ctrl.declinePrompt();
    ctrl.requestLinkNavigation('/interlock-sim/', 'InterlockSim');
    ctrl.acceptPrompt();
    abortRestoration();
    await Promise.resolve();
    expect(fake.assignedUrls).toEqual(['/interlock-sim/']);
    expect(host.location.search).toBe('?preset=a');
    ctrl.dispose();
  });

  it('recovers the accepted URL when the host provides no finished promise', () => {
    const fake = createFakeHistoryHost('https://example.org/app/?preset=a', true);
    const baseNav = fake.host.navigation!;
    const host: HistoryHostLike = {
      ...fake.host,
      navigation: {
        get currentEntry() { return baseNav.currentEntry; },
        entries: () => baseNav.entries!(),
        traverseTo: () => ({}),
      },
    };
    let dirty = false;
    const ctrl = createWorkbenchHistoryController<TestPreset>({
      host, allowedPresets: ['a', 'b', 'c'], defaultPreset: 'a',
      isDirty: () => dirty, onCommitPreset: () => {}, onPromptChange: () => {},
    });
    ctrl.selectPreset('b');
    dirty = true;
    fake.navigateToIndex(0);
    ctrl.declinePrompt();
    expect(host.location.search).toBe('?preset=b');
    ctrl.dispose();
  });

  it('repairs same-entry divergence synchronously without no-op traverseTo or leaked restorationToken', async () => {
    const fake = createFakeHistoryHost('https://example.org/app/?preset=a', true);
    let dirty = true;
    const commits: TestPreset[] = [];
    const box: { prompt: PendingDiscardPrompt<TestPreset> | null } = { prompt: null };

    const ctrl = createWorkbenchHistoryController<TestPreset>({
      host: fake.host,
      allowedPresets: ['a', 'b', 'c'],
      defaultPreset: 'a',
      isDirty: () => dirty,
      onCommitPreset: (p) => {
        commits.push(p);
      },
      onPromptChange: (p) => {
        box.prompt = p;
      },
    });

    const initialKey = ctrl.getAcceptedNavigationKey();
    const initialStamp = ctrl.getAcceptedStamp();

    // External same-entry mutation + popstate while remaining on the exact same Navigation API key
    fake.host.history.replaceState(null, '', '/app/?preset=b');
    fake.emitPopstate();
    expect(box.prompt?.kind).toBe('popstate');
    expect(fake.host.navigation?.currentEntry?.key).toBe(initialKey);

    const traverseCountBefore = fake.traverseCalls.length;
    ctrl.declinePrompt();
    // Must repair synchronously via fresh-session replaceState without calling no-op traverseTo(currentKey)
    expect(fake.traverseCalls.length).toBe(traverseCountBefore);
    expect(new URL(fake.host.location.href).searchParams.get('preset')).toBe('a');
    expect(ctrl.getAcceptedStamp().sessionId).not.toBe(initialStamp.sessionId);
    expect(box.prompt).toBeNull();

    // Subsequent normal navigation must NOT be swallowed by any leaked restorationToken
    dirty = false;
    ctrl.selectPreset('b');
    fake.navigateToIndex(0);
    expect(commits).toEqual(['b', 'a']);

    // Also verify silent no-op traverseTo resolution (finished resolves without firing popstate) recovers instead of leaking
    const silentNavFake = createFakeHistoryHost('https://example.org/app/?preset=a', true);
    const baseNav = silentNavFake.host.navigation!;
    const silentHost: HistoryHostLike = {
      ...silentNavFake.host,
      navigation: {
        get currentEntry() {
          return baseNav.currentEntry;
        },
        entries: () => baseNav.entries!(),
        traverseTo: () => ({ finished: Promise.resolve() }),
      },
    };
    let silentDirty = false;
    const silentBox: { prompt: PendingDiscardPrompt<TestPreset> | null } = { prompt: null };
    const silentCtrl = createWorkbenchHistoryController<TestPreset>({
      host: silentHost,
      allowedPresets: ['a', 'b', 'c'],
      defaultPreset: 'a',
      isDirty: () => silentDirty,
      onCommitPreset: () => {},
      onPromptChange: (p) => {
        silentBox.prompt = p;
      },
    });
    silentCtrl.selectPreset('b');
    silentDirty = true;
    silentNavFake.navigateToIndex(0);
    expect(silentBox.prompt?.kind).toBe('popstate');
    silentCtrl.declinePrompt();
    await Promise.resolve();
    expect(new URL(silentNavFake.host.location.href).searchParams.get('preset')).toBe('b');

    ctrl.dispose();
    silentCtrl.dispose();
  });

  it('rejects unsafe navigation hrefs in controller requestLinkNavigation when clean or dirty', () => {
    const fake = createFakeHistoryHost('https://example.org/app/?preset=a', true);
    let dirty = false;
    const box: { prompt: PendingDiscardPrompt<TestPreset> | null } = { prompt: null };

    const ctrl = createWorkbenchHistoryController<TestPreset>({
      host: fake.host,
      allowedPresets: ['a', 'b', 'c'],
      defaultPreset: 'a',
      isDirty: () => dirty,
      onCommitPreset: () => {},
      onPromptChange: (p) => {
        box.prompt = p;
      },
    });

    const unsafeHrefs = [
      '',
      '   ',
      'javascript:alert(1)',
      'java\tscript:alert(1)',
      'data:text/html,hi',
      'https://evil.example/',
      '//evil.example/',
      '\\evil.example/',
      '/\\evil.example/',
    ];

    for (const href of unsafeHrefs) {
      dirty = false;
      ctrl.requestLinkNavigation(href, 'Unsafe');
      expect(fake.assignedUrls).toEqual([]);
      expect(box.prompt).toBeNull();

      dirty = true;
      ctrl.requestLinkNavigation(href, 'Unsafe');
      expect(fake.assignedUrls).toEqual([]);
      expect(box.prompt).toBeNull();
    }

    // Safe relative same-origin href still works when clean and prompts when dirty
    dirty = false;
    ctrl.requestLinkNavigation('../other/', 'Other');
    expect(fake.assignedUrls).toEqual(['../other/']);

    dirty = true;
    ctrl.requestLinkNavigation('/app/next/?foo=1#top', 'Next');
    expect(box.prompt?.kind).toBe('link');
    ctrl.acceptPrompt();
    expect(fake.assignedUrls).toEqual(['../other/', '/app/next/?foo=1#top']);

    ctrl.dispose();
  });

  it('clears stale prompts on controller reconfiguration and blocks null-controller bypasses across React lifecycle and SSR', async () => {
    // 1. SSR safety: useWorkbenchRoute renders cleanly without window and does not bypass dirty checks when controller is null
    let ssrHandle: ReturnType<typeof useWorkbenchRoute<TestPreset>> | null = null;
    const ssrCommits: TestPreset[] = [];
    function SsrProbe() {
      ssrHandle = useWorkbenchRoute<TestPreset>({
        allowedPresets: ['a', 'b'],
        defaultPreset: 'a',
        isDirty: true,
        onCommitPreset: (p) => ssrCommits.push(p),
      });
      return createElement('div', null, ssrHandle.pendingPrompt?.label ?? 'none');
    }
    const ssrHtml = renderToStaticMarkup(createElement(SsrProbe));
    expect(ssrHtml).toBe('<div>none</div>');
    expect(ssrHandle).not.toBeNull();
    ssrHandle!.selectPreset('b');
    ssrHandle!.requestLinkNavigation('../other/', 'Other');
    expect(ssrCommits).toEqual([]);

    // 2. Mounted React 19 lifecycle: reconfiguration clears stale prompt; unmount blocks null-controller bypasses
    const fake = createFakeHistoryHost('https://example.org/app/?preset=a', true);
    const makeEl = (tag: string) => ({
      nodeType: 1,
      tagName: tag.toUpperCase(),
      childNodes: [] as unknown[],
      ownerDocument: null as unknown,
      appendChild(child: unknown) {
        this.childNodes.push(child);
        return child;
      },
      removeChild(child: unknown) {
        const idx = this.childNodes.indexOf(child);
        if (idx >= 0) this.childNodes.splice(idx, 1);
        return child;
      },
      insertBefore(child: unknown) {
        this.childNodes.push(child);
        return child;
      },
      addEventListener() {},
      removeEventListener() {},
    });

    class FakeIFrameElement {}
    const fakeWin = {
      location: fake.host.location,
      history: fake.host.history,
      navigation: fake.host.navigation,
      addEventListener: fake.host.addEventListener,
      removeEventListener: fake.host.removeEventListener,
      HTMLIFrameElement: FakeIFrameElement,
      navigator: {},
      document: null as unknown,
    };
    const fakeDoc = {
      nodeType: 9,
      defaultView: fakeWin,
      documentElement: makeEl('html'),
      body: makeEl('body'),
      activeElement: null,
      createElement: makeEl,
      createTextNode: (text: string) => ({ nodeType: 3, nodeValue: text }),
      addEventListener() {},
      removeEventListener() {},
    };
    fakeWin.document = fakeDoc;
    const container = makeEl('div');
    container.ownerDocument = fakeDoc;

    const g = globalThis as Record<string, unknown>;
    const prevWindow = g['window'];
    const prevDocument = g['document'];
    const prevActEnv = g['IS_REACT_ACT_ENVIRONMENT'];
    g['window'] = fakeWin;
    g['document'] = fakeDoc;
    g['IS_REACT_ACT_ENVIRONMENT'] = true;

    try {
      const commits: TestPreset[] = [];
      let latest!: ReturnType<typeof useWorkbenchRoute<TestPreset>>;

      function RouteHarness(props: {
        readonly allowedPresets: readonly TestPreset[];
        readonly defaultPreset: TestPreset;
        readonly isDirty: boolean;
      }) {
        latest = useWorkbenchRoute<TestPreset>({
          allowedPresets: props.allowedPresets,
          defaultPreset: props.defaultPreset,
          isDirty: props.isDirty,
          onCommitPreset: (p) => commits.push(p),
        });
        return null;
      }

      const root = createRoot(container as unknown as Element);

      await act(async () => {
        root.render(
          createElement(RouteHarness, {
            allowedPresets: ['a', 'b'],
            defaultPreset: 'a',
            isDirty: true,
          }),
        );
      });

      // Open discard prompt while dirty
      await act(async () => {
        latest.selectPreset('b');
      });
      expect(latest.pendingPrompt?.kind).toBe('preset');
      expect(latest.pendingPrompt?.targetPreset).toBe('b');

      // Re-rendering with a fresh array instance having identical presets must keep the prompt intact
      await act(async () => {
        root.render(
          createElement(RouteHarness, {
            allowedPresets: ['a', 'b'],
            defaultPreset: 'a',
            isDirty: true,
          }),
        );
      });
      expect(latest.pendingPrompt?.kind).toBe('preset');
      expect(latest.pendingPrompt?.targetPreset).toBe('b');

      // Reconfiguring controller (changed allowedPresets / defaultPreset) must clear the stale prompt
      await act(async () => {
        root.render(
          createElement(RouteHarness, {
            allowedPresets: ['a', 'b', 'c'],
            defaultPreset: 'b',
            isDirty: true,
          }),
        );
      });
      expect(latest.pendingPrompt).toBeNull();

      // New controller works cleanly after reconfiguration
      await act(async () => {
        latest.selectPreset('c');
      });
      expect(latest.pendingPrompt?.kind).toBe('preset');
      expect(latest.pendingPrompt?.targetPreset).toBe('c');

      const capturedSelect = latest.selectPreset;
      const capturedLink = latest.requestLinkNavigation;

      // Unmount disposes controller (controllerRef.current = null); invoking stale callbacks must NOT bypass dirty guard
      await act(async () => {
        root.unmount();
      });
      capturedSelect('b');
      capturedLink('../other/', 'Other');
      expect(commits).toEqual([]);
      expect(fake.assignedUrls).toEqual([]);
    } finally {
      if (prevWindow === undefined) delete g['window'];
      else g['window'] = prevWindow;
      if (prevDocument === undefined) delete g['document'];
      else g['document'] = prevDocument;
      if (prevActEnv === undefined) delete g['IS_REACT_ACT_ENVIRONMENT'];
      else g['IS_REACT_ACT_ENVIRONMENT'] = prevActEnv;
    }
  });
});
