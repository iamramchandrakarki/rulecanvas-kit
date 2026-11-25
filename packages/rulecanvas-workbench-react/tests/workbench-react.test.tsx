import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildVerdictSummaryView } from '@rulecanvas/ui';
import { describe, expect, it } from 'vitest';
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
  readonly navigateToIndex: (index: number) => void;
  readonly flushTraversals: () => void;
  readonly triggerBeforeUnload: () => { defaultPrevented: boolean; returnValue: string | undefined };
  readonly assignedUrls: string[];
} {
  let keySeq = 1;
  const entries: FakeEntry[] = [{ key: `nav-${keySeq++}`, url: initialUrl, state: null }];
  let cursor = 0;
  const listeners: Record<string, Set<(event: unknown) => void>> = {
    popstate: new Set(),
    beforeunload: new Set(),
  };
  const assignedUrls: string[] = [];

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
    navigateToIndex(index: number) {
      cursor = index;
      emitPopstate();
    },
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
});
