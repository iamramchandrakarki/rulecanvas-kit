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
  onValidityChange,
  showInlineError = true,
}: StrictIntegerInputProps) {
  const autoErrorId = useId();
  const [draft, setDraft] = useState<string>(() => String(value));
  const [error, setError] = useState<string | null>(null);

  const prevValueRef = useRef<number>(value);
  const prevResetKeyRef = useRef<string | number | undefined>(resetKey);
  const onValidityChangeRef = useRef(onValidityChange);
  onValidityChangeRef.current = onValidityChange;

  useEffect(() => {
    if (prevResetKeyRef.current !== resetKey || prevValueRef.current !== value) {
      prevResetKeyRef.current = resetKey;
      prevValueRef.current = value;
      setDraft(String(value));
      setError(null);
      if (fieldKey !== undefined) {
        onValidityChangeRef.current?.(fieldKey, null);
      }
    }
  }, [value, resetKey, fieldKey]);

  useEffect(() => {
    return () => {
      if (fieldKey !== undefined) {
        onValidityChangeRef.current?.(fieldKey, null);
      }
    };
  }, [fieldKey]);

  const handleChange = (raw: string) => {
    setDraft(raw);
    const parsed = parseStrictIntegerDraft(raw);
    if (!parsed.ok) {
      setError(parsed.message);
      if (fieldKey !== undefined) {
        onValidityChangeRef.current?.(fieldKey, parsed.message);
      }
      return;
    }

    setError(null);
    if (fieldKey !== undefined) {
      onValidityChangeRef.current?.(fieldKey, null);
    }
    prevValueRef.current = parsed.value;
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
        aria-invalid={error !== null ? 'true' : undefined}
        aria-describedby={error !== null && showInlineError ? errorId : undefined}
        value={draft}
        onChange={(e) => handleChange(e.target.value)}
      />
      {error !== null && showInlineError && (
        <span id={errorId} className="ag-field-error" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
