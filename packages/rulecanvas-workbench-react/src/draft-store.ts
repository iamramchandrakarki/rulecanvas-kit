import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { parseStrictIntegerDraft } from '@rulecanvas/ui';

export interface LiftedIntDraftStore {
  readonly draftValues: Readonly<Record<string, string>>;
  readonly draftErrors: Readonly<Record<string, string>>;
  readonly onDraftChange: (fieldKey: string, rawDraft: string, errorMessage: string | null) => void;
  readonly onPruneDrafts: (prefix: string) => void;
}

export interface UseIntegerDraftStoreOptions {
  readonly resetKey?: string | number | undefined;
  readonly onErrorChange?: ((fieldKey: string, errorMessage: string | null) => void) | undefined;
}

export function matchesDraftPrefix(fieldKey: string, prefix: string): boolean {
  return (
    fieldKey === prefix ||
    fieldKey.startsWith(`${prefix}.`) ||
    fieldKey.startsWith(`${prefix}:`)
  );
}

export function useIntegerDraftStore(
  options: UseIntegerDraftStoreOptions = {},
): LiftedIntDraftStore {
  const { resetKey = 0, onErrorChange } = options;
  const prevResetKeyRef = useRef<string | number>(resetKey);
  const onErrorChangeRef = useRef(onErrorChange);
  onErrorChangeRef.current = onErrorChange;

  const [draftValues, setDraftValues] = useState<Readonly<Record<string, string>>>({});
  const [draftErrors, setDraftErrors] = useState<Readonly<Record<string, string>>>({});
  const draftErrorsRef = useRef<Readonly<Record<string, string>>>({});

  const onDraftChange = useCallback(
    (fieldKey: string, rawDraft: string, errorMessage: string | null) => {
      setDraftValues((prev) => {
        if (errorMessage === null) {
          const parsed = parseStrictIntegerDraft(rawDraft);
          if (parsed.ok && rawDraft === String(parsed.value)) {
            if (!Object.hasOwn(prev, fieldKey)) return prev;
            const next = { ...prev };
            delete next[fieldKey];
            return next;
          }
        }
        if (prev[fieldKey] === rawDraft) return prev;
        return { ...prev, [fieldKey]: rawDraft };
      });

      setDraftErrors((prev) => {
        if (errorMessage === null) {
          if (!Object.hasOwn(prev, fieldKey)) return prev;
          const next = { ...prev };
          delete next[fieldKey];
          draftErrorsRef.current = next;
          return next;
        }
        if (prev[fieldKey] === errorMessage) return prev;
        const next = { ...prev, [fieldKey]: errorMessage };
        draftErrorsRef.current = next;
        return next;
      });

      onErrorChangeRef.current?.(fieldKey, errorMessage);
    },
    [],
  );

  const onPruneDrafts = useCallback((prefix: string) => {
    setDraftValues((prev) => {
      let changed = false;
      const next: Record<string, string> = {};
      for (const [k, v] of Object.entries(prev)) {
        if (matchesDraftPrefix(k, prefix)) {
          changed = true;
        } else {
          next[k] = v;
        }
      }
      return changed ? next : prev;
    });

    const removedErrorKeys: string[] = [];
    for (const k of Object.keys(draftErrorsRef.current)) {
      if (matchesDraftPrefix(k, prefix)) {
        removedErrorKeys.push(k);
      }
    }

    if (removedErrorKeys.length > 0) {
      setDraftErrors((prev) => {
        let changed = false;
        const next: Record<string, string> = {};
        for (const [k, v] of Object.entries(prev)) {
          if (matchesDraftPrefix(k, prefix)) {
            changed = true;
          } else {
            next[k] = v;
          }
        }
        if (changed) {
          draftErrorsRef.current = next;
          return next;
        }
        return prev;
      });
      for (const k of removedErrorKeys) {
        onErrorChangeRef.current?.(k, null);
      }
    }
  }, []);

  useEffect(() => {
    if (prevResetKeyRef.current !== resetKey) {
      prevResetKeyRef.current = resetKey;
      const prevErrKeys = Object.keys(draftErrorsRef.current);
      setDraftValues({});
      setDraftErrors({});
      draftErrorsRef.current = {};
      for (const k of prevErrKeys) {
        onErrorChangeRef.current?.(k, null);
      }
    }
  }, [resetKey]);

  return useMemo<LiftedIntDraftStore>(
    () => ({
      draftValues,
      draftErrors,
      onDraftChange,
      onPruneDrafts,
    }),
    [draftValues, draftErrors, onDraftChange, onPruneDrafts],
  );
}
