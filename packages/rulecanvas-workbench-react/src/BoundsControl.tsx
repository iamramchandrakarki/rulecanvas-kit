import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

export type VerificationBoundKind = 'maxStates' | 'maxDepth';

export interface VerificationBoundsControlProps {
  /** Raw text drafts; parsing and validation stay with the host app. */
  readonly maxStatesText: string;
  readonly maxDepthText: string;
  readonly maxStatesInvalid?: boolean | undefined;
  readonly maxDepthInvalid?: boolean | undefined;
  readonly onEdit: (kind: VerificationBoundKind, rawValue: string) => void;
  /** Input element ids; defaults keep existing `#max-states-input` / `#max-depth-input` hooks. */
  readonly maxStatesInputId?: string | undefined;
  readonly maxDepthInputId?: string | undefined;
  readonly className?: string | undefined;
  readonly triggerClassName?: string | undefined;
  readonly panelClassName?: string | undefined;
  readonly fieldClassName?: string | undefined;
  readonly inputClassName?: string | undefined;
  readonly hintClassName?: string | undefined;
  /** Class that hides text visually but keeps it in the accessible name. */
  readonly visuallyHiddenClassName?: string | undefined;
  /** Optional extra content rendered at the end of the panel. */
  readonly children?: ReactNode;
}

/**
 * Disclosure popover for bounded-exploration limits.
 *
 * The trigger always shows the current bound values so they stay visible while the
 * panel is closed. The panel is forced open while either draft is invalid so a
 * validation error is never hidden. Escape and outside clicks close the panel.
 */
export function VerificationBoundsControl({
  maxStatesText,
  maxDepthText,
  maxStatesInvalid = false,
  maxDepthInvalid = false,
  onEdit,
  maxStatesInputId = 'max-states-input',
  maxDepthInputId = 'max-depth-input',
  className,
  triggerClassName,
  panelClassName,
  fieldClassName,
  inputClassName,
  hintClassName,
  visuallyHiddenClassName,
  children,
}: VerificationBoundsControlProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelId = `${useId()}-bounds-panel`;
  const invalid = maxStatesInvalid || maxDepthInvalid;
  const expanded = open || invalid;

  useEffect(() => {
    if (!open) return;
    const doc = rootRef.current?.ownerDocument;
    if (doc === undefined) return;
    const handlePointerDown = (event: PointerEvent) => {
      const root = rootRef.current;
      if (root !== null && event.target instanceof Node && !root.contains(event.target)) {
        setOpen(false);
      }
    };
    doc.addEventListener('pointerdown', handlePointerDown);
    return () => doc.removeEventListener('pointerdown', handlePointerDown);
  }, [open]);

  return (
    <div
      ref={rootRef}
      className={className}
      data-open={expanded ? 'true' : 'false'}
      data-invalid={invalid ? 'true' : undefined}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          triggerRef.current?.focus();
        }
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className={triggerClassName}
        aria-expanded={expanded}
        aria-controls={panelId}
        title="Bounded exploration limits (maxStates / maxDepth)"
        onClick={() => setOpen((prev) => !prev)}
      >
        <span>Bounds</span>
        <span data-bounds-summary="true">
          {maxStatesText || '?'} / {maxDepthText || '?'}
        </span>
        {visuallyHiddenClassName !== undefined && (
          <span className={visuallyHiddenClassName}>
            {invalid ? ' (maxStates / maxDepth, invalid)' : ' (maxStates / maxDepth)'}
          </span>
        )}
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
          <path
            d="M2 3.5l3 3 3-3"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      <div
        id={panelId}
        className={panelClassName}
        role="group"
        aria-label="Verification bounds"
        hidden={!expanded}
      >
        <div className={fieldClassName}>
          <label htmlFor={maxStatesInputId}>maxStates</label>
          <input
            id={maxStatesInputId}
            type="text"
            inputMode="numeric"
            className={inputClassName}
            aria-invalid={maxStatesInvalid ? 'true' : undefined}
            autoComplete="off"
            value={maxStatesText}
            onChange={(e) => onEdit('maxStates', e.target.value)}
          />
        </div>
        <div className={fieldClassName}>
          <label htmlFor={maxDepthInputId}>maxDepth</label>
          <input
            id={maxDepthInputId}
            type="text"
            inputMode="numeric"
            className={inputClassName}
            aria-invalid={maxDepthInvalid ? 'true' : undefined}
            autoComplete="off"
            value={maxDepthText}
            onChange={(e) => onEdit('maxDepth', e.target.value)}
          />
        </div>
        <p className={hintClassName}>
          Exploration stops at these limits and reports INCONCLUSIVE instead of a verdict.
        </p>
        {children}
      </div>
    </div>
  );
}
