import { useEffect, useId, useRef, useState } from 'react';
import { parseStrictIntegerDraft } from '../model-editor.js';

export interface StrictIntegerInputProps {
  readonly id?: string | undefined;
  readonly value: number;
  readonly onCommit: (nextValue: number) => void;
  readonly className?: string | undefined;
  readonly ariaLabel?: string | undefined;
  readonly resetKey?: string | number | undefined;
  readonly fieldKey?: string | undefined;
  readonly externalDraft?: string | undefined;
  readonly externalError?: string | undefined;
  readonly onDraftChange?:
    | ((fieldKey: string, rawDraft: string, errorMessage: string | null) => void)
    | undefined;
  readonly onValidityChange?: ((fieldKey: string, errorMessage: string | null) => void) | undefined;
  readonly showInlineError?: boolean | undefined;
}

export function StrictIntegerInput({
  id,
  value,
  onCommit,
  className = 'ag-input ag-input-num',
  ariaLabel,
  resetKey,
  fieldKey,
  externalDraft,
  externalError,
  onDraftChange,
  onValidityChange,
  showInlineError = true,
}: StrictIntegerInputProps) {
  const autoErrorId = useId();
  const isControlled = fieldKey !== undefined && onDraftChange !== undefined;

  const [localDraft, setLocalDraft] = useState<string>(() => String(value));
  const [localError, setLocalError] = useState<string | null>(null);

  const prevValueRef = useRef<number>(value);
  const prevResetKeyRef = useRef<string | number | undefined>(resetKey);
  const onValidityChangeRef = useRef(onValidityChange);
  onValidityChangeRef.current = onValidityChange;
  const onDraftChangeRef = useRef(onDraftChange);
  onDraftChangeRef.current = onDraftChange;

  useEffect(() => {
    const resetChanged = prevResetKeyRef.current !== resetKey;
    const valueChanged = prevValueRef.current !== value;
    if (!resetChanged && !valueChanged) {
      return;
    }

    prevResetKeyRef.current = resetKey;
    prevValueRef.current = value;

    if (!isControlled) {
      setLocalDraft(String(value));
      setLocalError(null);
      if (fieldKey !== undefined) {
        onValidityChangeRef.current?.(fieldKey, null);
      }
    } else if (!resetChanged && valueChanged && externalDraft !== undefined && externalError === undefined) {
      // External model change while there is no active invalid draft: sync displayed value.
      onDraftChangeRef.current?.(fieldKey, String(value), null);
    }
  }, [value, resetKey, fieldKey, isControlled, externalDraft, externalError]);

  const displayedDraft = isControlled
    ? externalDraft !== undefined
      ? externalDraft
      : String(value)
    : localDraft;
  const displayedError = isControlled ? (externalError ?? null) : localError;

  const handleChange = (raw: string) => {
    const parsed = parseStrictIntegerDraft(raw);
    if (!parsed.ok) {
      if (isControlled) {
        onDraftChange(fieldKey, raw, parsed.message);
      } else {
        setLocalDraft(raw);
        setLocalError(parsed.message);
        if (fieldKey !== undefined) {
          onValidityChangeRef.current?.(fieldKey, parsed.message);
        }
      }
      return;
    }

    prevValueRef.current = parsed.value;
    if (isControlled) {
      onDraftChange(fieldKey, raw, null);
    } else {
      setLocalDraft(raw);
      setLocalError(null);
      if (fieldKey !== undefined) {
        onValidityChangeRef.current?.(fieldKey, null);
      }
    }
    if (parsed.value !== value) {
      onCommit(parsed.value);
    }
  };

  const errorId = `${autoErrorId}-err`;

  return (
    <span className="ag-strict-int-wrap">
      <input
        id={id}
        type="text"
        inputMode="numeric"
        className={className}
        aria-label={ariaLabel}
        aria-invalid={displayedError !== null ? 'true' : undefined}
        aria-describedby={displayedError !== null && showInlineError ? errorId : undefined}
        value={displayedDraft}
        onChange={(e) => handleChange(e.target.value)}
      />
      {displayedError !== null && showInlineError && (
        <span id={errorId} className="ag-field-error" role="alert">
          {displayedError}
        </span>
      )}
    </span>
  );
}
