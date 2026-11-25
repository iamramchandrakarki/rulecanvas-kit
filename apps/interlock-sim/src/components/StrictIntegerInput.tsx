import { useMemo } from 'react';
import {
  StrictIntegerInput as SharedStrictIntegerInput,
  type LiftedIntDraftStore,
} from '@rulecanvas/workbench-react';

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
  className = 'is-input is-input-num',
  ariaLabel,
  resetKey,
  fieldKey,
  externalDraft,
  externalError,
  onDraftChange,
  onValidityChange,
}: StrictIntegerInputProps) {
  const draftStore = useMemo<LiftedIntDraftStore | undefined>(() => {
    if (fieldKey === undefined || onDraftChange === undefined) return undefined;
    return {
      draftValues: externalDraft !== undefined ? { [fieldKey]: externalDraft } : {},
      draftErrors: externalError !== undefined ? { [fieldKey]: externalError } : {},
      onDraftChange,
      onPruneDrafts: () => {},
    };
  }, [fieldKey, externalDraft, externalError, onDraftChange]);

  return (
    <SharedStrictIntegerInput
      id={id}
      value={value}
      ariaLabel={ariaLabel}
      className={className}
      wrapperClassName="is-strict-int-wrap"
      errorClassName="is-field-error"
      resetKey={resetKey}
      fieldKey={fieldKey}
      draftStore={draftStore}
      onCommit={onCommit}
      onValidationErrorChange={
        fieldKey !== undefined && onValidityChange !== undefined
          ? (err) => onValidityChange(fieldKey, err)
          : undefined
      }
    />
  );
}
