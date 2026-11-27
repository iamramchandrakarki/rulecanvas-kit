/**
 * Pure keyboard-navigation helpers for {@link WorkbenchSelect}.
 *
 * Kept free of DOM and React so the listbox behaviour (disabled-option skipping,
 * page jumps, native-style type-ahead) can be reasoned about and tested in isolation.
 * Time is always passed in (the keyboard event's `timeStamp`), never read from a clock.
 */

export interface SelectNavigationItem {
  readonly label: string;
  readonly disabled?: boolean | undefined;
}

/** Milliseconds after which a new keystroke starts a fresh type-ahead search. */
export const SELECT_TYPEAHEAD_TIMEOUT_MS = 500;

/** Number of options skipped by PageUp / PageDown. */
export const SELECT_PAGE_SIZE = 10;

const isEnabled = (item: SelectNavigationItem | undefined): boolean =>
  item !== undefined && item.disabled !== true;

/** First or last enabled index, or -1 when every option is disabled. */
export function edgeEnabledIndex(
  items: readonly SelectNavigationItem[],
  edge: 'first' | 'last',
): number {
  if (edge === 'first') {
    for (let i = 0; i < items.length; i += 1) if (isEnabled(items[i])) return i;
  } else {
    for (let i = items.length - 1; i >= 0; i -= 1) if (isEnabled(items[i])) return i;
  }
  return -1;
}

/**
 * Moves `delta` positions from `from` without wrapping (native listbox behaviour),
 * landing on the nearest enabled option in the direction of travel. Returns `from`
 * when no enabled option lies in that direction.
 */
export function stepEnabledIndex(
  items: readonly SelectNavigationItem[],
  from: number,
  delta: number,
): number {
  if (items.length === 0 || delta === 0) return from;
  if (from < 0) return edgeEnabledIndex(items, delta > 0 ? 'first' : 'last');
  const direction = delta > 0 ? 1 : -1;
  let target = Math.max(0, Math.min(items.length - 1, from + delta));
  while (target >= 0 && target < items.length && !isEnabled(items[target])) target += direction;
  if (target >= 0 && target < items.length) return target;
  // Overshot past the last enabled option: settle on the furthest enabled one.
  const edge = edgeEnabledIndex(items, direction > 0 ? 'last' : 'first');
  if (edge === -1) return from;
  return direction > 0 ? Math.max(from, edge) : Math.min(from, edge);
}

export interface SelectTypeaheadState {
  readonly buffer: string;
  readonly lastTime: number;
}

export const EMPTY_TYPEAHEAD: SelectTypeaheadState = { buffer: '', lastTime: -Infinity };

/** True while a type-ahead search is still collecting characters. */
export function isTypeaheadActive(state: SelectTypeaheadState, time: number): boolean {
  return state.buffer.length > 0 && time - state.lastTime <= SELECT_TYPEAHEAD_TIMEOUT_MS;
}

/**
 * Native-style type-ahead: characters typed within the timeout extend the search
 * string; repeating one character cycles through options starting with it.
 * Returns the next state and the matched index (-1 when nothing matches).
 */
export function resolveTypeahead(
  items: readonly SelectNavigationItem[],
  state: SelectTypeaheadState,
  key: string,
  time: number,
  from: number,
): { readonly state: SelectTypeaheadState; readonly index: number } {
  const char = key.toLowerCase();
  const buffer = (isTypeaheadActive(state, time) ? state.buffer : '') + char;
  const next: SelectTypeaheadState = { buffer, lastTime: time };
  const repeated = [...buffer].every((c) => c === char);
  const needle = repeated ? char : buffer;
  // A fresh or repeated character searches after the current option; a longer
  // string keeps the current option when it still matches.
  const start = repeated ? from + 1 : Math.max(from, 0);
  for (let offset = 0; offset < items.length; offset += 1) {
    const index = (((start + offset) % items.length) + items.length) % items.length;
    const item = items[index];
    if (isEnabled(item) && item!.label.trim().toLowerCase().startsWith(needle)) {
      return { state: next, index };
    }
  }
  return { state: next, index: -1 };
}

/** Printable single characters start or extend a type-ahead search. */
export function isTypeaheadKey(event: {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
}): boolean {
  return event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
}
