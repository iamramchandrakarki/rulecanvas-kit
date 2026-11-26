import { useCallback, useEffect, useState } from 'react';

export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

export const WORKBENCH_THEME_STORAGE_KEY = 'rulecanvas-theme';

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'system' || value === 'light' || value === 'dark';
}

export function resolveWorkbenchTheme(
  preference: ThemePreference,
  systemPrefersDark: boolean,
): ResolvedTheme {
  if (preference === 'dark') return 'dark';
  if (preference === 'light') return 'light';
  return systemPrefersDark ? 'dark' : 'light';
}

export interface ThemeStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function readStoredThemePreference(
  storage?: ThemeStorageLike | null,
  storageKey: string = WORKBENCH_THEME_STORAGE_KEY,
): ThemePreference {
  try {
    const target =
      storage !== undefined
        ? storage
        : typeof window !== 'undefined'
          ? window.localStorage
          : null;
    if (target === null || target === undefined) return 'system';
    const raw = target.getItem(storageKey);
    return isThemePreference(raw) ? raw : 'system';
  } catch {
    return 'system';
  }
}

export function writeStoredThemePreference(
  preference: ThemePreference,
  storage?: ThemeStorageLike | null,
  storageKey: string = WORKBENCH_THEME_STORAGE_KEY,
): void {
  try {
    const target =
      storage !== undefined
        ? storage
        : typeof window !== 'undefined'
          ? window.localStorage
          : null;
    if (target === null || target === undefined) return;
    target.setItem(storageKey, preference);
  } catch {
    // Ignore storage quota or sandbox errors
  }
}

function readSystemDarkPreference(): boolean {
  try {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return false;
    }
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
}

export function applyDocumentTheme(
  preference: ThemePreference,
  resolved: ResolvedTheme,
  doc?: Document | null,
): void {
  const targetDoc =
    doc !== undefined ? doc : typeof document !== 'undefined' ? document : null;
  if (targetDoc === null || targetDoc.documentElement === null) return;
  const root = targetDoc.documentElement;
  root.setAttribute('data-theme', resolved);
  root.setAttribute('data-theme-preference', preference);
  root.style.colorScheme = resolved;
}

export interface UseWorkbenchThemeOptions {
  readonly storageKey?: string | undefined;
  readonly defaultPreference?: ThemePreference | undefined;
}

export interface WorkbenchThemeController {
  readonly preference: ThemePreference;
  readonly resolvedTheme: ResolvedTheme;
  readonly setPreference: (next: ThemePreference) => void;
}

export function useWorkbenchTheme(
  options: UseWorkbenchThemeOptions = {},
): WorkbenchThemeController {
  const { storageKey = WORKBENCH_THEME_STORAGE_KEY, defaultPreference = 'system' } = options;

  const [preference, setPreferenceState] = useState<ThemePreference>(() => {
    if (typeof window === 'undefined') return defaultPreference;
    const stored = readStoredThemePreference(undefined, storageKey);
    return stored;
  });

  const [systemDark, setSystemDark] = useState<boolean>(() => readSystemDarkPreference());

  const resolvedTheme = resolveWorkbenchTheme(preference, systemDark);

  useEffect(() => {
    applyDocumentTheme(preference, resolvedTheme);
  }, [preference, resolvedTheme]);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    let mql: MediaQueryList | null = null;
    const handleMediaChange = (event: MediaQueryListEvent) => {
      setSystemDark(Boolean(event.matches));
    };

    try {
      if (typeof window.matchMedia === 'function') {
        mql = window.matchMedia('(prefers-color-scheme: dark)');
        setSystemDark(mql.matches);
        if (typeof mql.addEventListener === 'function') {
          mql.addEventListener('change', handleMediaChange);
        }
      }
    } catch {
      mql = null;
    }

    const handleStorage = (event: StorageEvent) => {
      if (event.key === storageKey) {
        setPreferenceState(isThemePreference(event.newValue) ? event.newValue : defaultPreference);
      }
    };
    window.addEventListener('storage', handleStorage);

    return () => {
      if (mql !== null && typeof mql.removeEventListener === 'function') {
        mql.removeEventListener('change', handleMediaChange);
      }
      window.removeEventListener('storage', handleStorage);
    };
  }, [storageKey, defaultPreference]);

  const setPreference = useCallback(
    (next: ThemePreference) => {
      if (!isThemePreference(next)) return;
      setPreferenceState(next);
      writeStoredThemePreference(next, undefined, storageKey);
      const nextResolved = resolveWorkbenchTheme(next, readSystemDarkPreference());
      applyDocumentTheme(next, nextResolved);
    },
    [storageKey],
  );

  return {
    preference,
    resolvedTheme,
    setPreference,
  };
}
