import { useEffect, useId, useRef, useState } from 'react';
import { parseStrictIntegerDraft } from '@rulecanvas/ui';
import type { LiftedIntDraftStore } from './draft-store.js';

export interface StrictIntegerInputProps {
  readonly id?: string | undefined;
  readonly value: number;
  readonly ariaLabel?: string | undefined;
  readonly className?: string | undefined;
  readonly wrapperClassName?: string | undefined;
  readonly errorClassName?: string | undefined;
  readonly resetKey?: string | number | undefined;
  readonly fieldKey?: string | undefined;
  readonly draftStore?: LiftedIntDraftStore | undefined;
  readonly onCommit: (nextValue: number) => void;
  readonly onValidationErrorChange?: ((errorMessage: string | null) => void) | undefined;
}

export function StrictIntegerInput({
  id,
  value,
  ariaLabel,
  className,
  wrapperClassName,
  errorClassName,
  resetKey,
  fieldKey,
  draftStore,
  onCommit,
  onValidationErrorChange,
}: StrictIntegerInputProps) {
  const autoId = useId();
  const inputId = id ?? `rc-int-${autoId}`;
  const errorId = `${inputId}-error`;
  const isLifted = draftStore !== undefined && fieldKey !== undefined;

  const [localDraft, setLocalDraft] = useState<string>(String(value));
  const [localError, setLocalError] = useState<string | null>(null);
  const prevValueRef = useRef<number>(value);
  const prevResetKeyRef = useRef<string | number | undefined>(resetKey);
  const onValidationErrorChangeRef = useRef(onValidationErrorChange);
  onValidationErrorChangeRef.current = onValidationErrorChange;

  useEffect(() => {
    if (isLifted) {
      prevValueRef.current = value;
      prevResetKeyRef.current = resetKey;
      return;
    }
    if (prevValueRef.current !== value || prevResetKeyRef.current !== resetKey) {
      prevValueRef.current = value;
      prevResetKeyRef.current = resetKey;
      setLocalDraft(String(value));
      setLocalError(null);
      onValidationErrorChangeRef.current?.(null);
    }
  }, [value, resetKey, isLifted]);

  const displayedDraft = isLifted
    ? Object.hasOwn(draftStore.draftValues, fieldKey)
      ? draftStore.draftValues[fieldKey]!
      : String(value)
    : localDraft;

  const displayedError = isLifted
    ? Object.hasOwn(draftStore.draftErrors, fieldKey)
      ? draftStore.draftErrors[fieldKey]!
      : null
    : localError;

  const handleChange = (raw: string) => {
    const parsed = parseStrictIntegerDraft(raw);
    if (!parsed.ok) {
      if (isLifted) {
        draftStore.onDraftChange(fieldKey, raw, parsed.message);
      } else {
        setLocalDraft(raw);
        setLocalError(parsed.message);
        onValidationErrorChangeRef.current?.(parsed.message);
      }
      return;
    }

    if (isLifted) {
      draftStore.onDraftChange(fieldKey, raw, null);
    } else {
      setLocalDraft(raw);
      setLocalError(null);
      onValidationErrorChangeRef.current?.(null);
    }
    if (parsed.value !== value) {
      onCommit(parsed.value);
    }
  };

  return (
    <span className={wrapperClassName}>
      <input
        id={inputId}
        type="text"
        inputMode="numeric"
        className={className}
        aria-label={ariaLabel}
        aria-invalid={displayedError !== null ? 'true' : undefined}
        aria-describedby={displayedError !== null ? errorId : undefined}
        value={displayedDraft}
        onChange={(e) => handleChange(e.target.value)}
      />
      {displayedError !== null && (
        <span id={errorId} className={errorClassName} role="alert">
          {displayedError}
        </span>
      )}
    </span>
  );
}
