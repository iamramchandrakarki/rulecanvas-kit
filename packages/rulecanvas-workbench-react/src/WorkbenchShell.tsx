import { forwardRef, useRef, type ReactNode } from 'react';
import type { ThemePreference } from './theme.js';

export interface WorkbenchThemeSwitchProps {
  readonly value: ThemePreference;
  readonly onChange: (next: ThemePreference) => void;
  readonly className?: string | undefined;
  readonly buttonClassName?: string | undefined;
  readonly activeButtonClassName?: string | undefined;
  /**
   * When set, each button renders an `aria-hidden` hover/focus tooltip with this
   * class instead of a native `title` (pair with `useWorkbenchTooltips`).
   */
  readonly tooltipClassName?: string | undefined;
}

const THEME_OPTIONS: readonly {
  readonly id: ThemePreference;
  readonly label: string;
  readonly title: string;
}[] = [
  { id: 'system', label: 'System', title: 'Follow system color scheme (Light fallback)' },
  { id: 'light', label: 'Light', title: 'Light precision workbench theme' },
  { id: 'dark', label: 'Dark', title: 'Dark precision workbench theme' },
];

function ThemeIcon({ kind }: { readonly kind: ThemePreference }) {
  if (kind === 'light') {
    return (
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="8" cy="8" r="3.2" stroke="currentColor" strokeWidth="1.5" />
        <path
          d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  if (kind === 'dark') {
    return (
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="M13.2 9.8A5.5 5.5 0 0 1 6.2 2.8a5.5 5.5 0 1 0 7 7Z"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2" y="3" width="12" height="8.5" rx="1" stroke="currentColor" strokeWidth="1.5" />
      <path d="M5.5 14h5M8 11.5V14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function WorkbenchThemeSwitch({
  value,
  onChange,
  className,
  buttonClassName,
  activeButtonClassName,
  tooltipClassName,
}: WorkbenchThemeSwitchProps) {
  return (
    <div className={className} role="group" aria-label="Color theme">
      {THEME_OPTIONS.map((opt) => {
        const isActive = value === opt.id;
        const btnClass = [buttonClassName, isActive ? activeButtonClassName : undefined]
          .filter(Boolean)
          .join(' ');
        return (
          <button
            key={opt.id}
            type="button"
            className={btnClass || undefined}
            aria-pressed={isActive}
            title={tooltipClassName === undefined ? opt.title : undefined}
            data-theme-option={opt.id}
            data-rc-tip-host={tooltipClassName !== undefined ? 'true' : undefined}
            onClick={() => onChange(opt.id)}
          >
            <ThemeIcon kind={opt.id} />
            <span>{opt.label}</span>
            {tooltipClassName !== undefined && (
              <span className={tooltipClassName} data-align="end" aria-hidden="true">
                {opt.title}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export interface WorkbenchBrandMarkProps {
  readonly className?: string | undefined;
}

export function WorkbenchBrandMark({ className }: WorkbenchBrandMarkProps) {
  return (
    <svg
      className={className}
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <rect x="1.5" y="1.5" width="13" height="13" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="5.25" cy="5.25" r="1.4" fill="currentColor" />
      <circle cx="10.75" cy="5.25" r="1.4" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="10.75" cy="10.75" r="1.4" fill="currentColor" />
      <path
        d="M6.65 5.25h2.7M10.75 6.65v2.7M6.25 6.25l3.5 3.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

export interface WorkbenchDiscardDialogProps {
  readonly idPrefix: string;
  readonly actionLabel: string;
  readonly onDecline: () => void;
  readonly onAccept: () => void;
  readonly backdropClassName?: string | undefined;
  readonly dialogClassName?: string | undefined;
  readonly titleClassName?: string | undefined;
  readonly descriptionClassName?: string | undefined;
  readonly actionsClassName?: string | undefined;
  readonly stayButtonClassName?: string | undefined;
  readonly acceptButtonClassName?: string | undefined;
}

function formatDiscardSentence(rawLabel: string): string {
  const switchMatch = rawLabel.match(/^Switch to (.+)$/);
  if (switchMatch !== null) {
    return `Switching to "${switchMatch[1]}" will discard your uncommitted model edits.`;
  }
  const loadMatch = rawLabel.match(/^Load (.+)$/);
  if (loadMatch !== null) {
    return `Loading "${loadMatch[1]}" will discard your uncommitted model edits.`;
  }
  const openMatch = rawLabel.match(/^Open (.+)$/);
  if (openMatch !== null) {
    return `Opening "${openMatch[1]}" will discard your uncommitted model edits.`;
  }
  return `${rawLabel} will discard your uncommitted model edits.`;
}

export const WorkbenchDiscardDialog = forwardRef<HTMLButtonElement, WorkbenchDiscardDialogProps>(
  function WorkbenchDiscardDialog(
    {
      idPrefix,
      actionLabel,
      onDecline,
      onAccept,
      backdropClassName,
      dialogClassName,
      titleClassName,
      descriptionClassName,
      actionsClassName,
      stayButtonClassName,
      acceptButtonClassName,
    },
    stayButtonRef,
  ): ReactNode {
    const titleId = `${idPrefix}-discard-title`;
    const descId = `${idPrefix}-discard-desc`;
    const dialogRef = useRef<HTMLDivElement | null>(null);

    return (
      <div
        className={backdropClassName}
        onClick={(event) => {
          if (event.target === event.currentTarget) {
            onDecline();
          }
        }}
      >
        <div
          ref={dialogRef}
          className={dialogClassName}
          role="alertdialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={descId}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              onDecline();
              return;
            }
            if (event.key === 'Tab' && dialogRef.current !== null) {
              const focusables = Array.from(
                dialogRef.current.querySelectorAll<HTMLElement>(
                  'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
                ),
              );
              if (focusables.length > 0) {
                const first = focusables[0]!;
                const last = focusables[focusables.length - 1]!;
                const active = dialogRef.current.ownerDocument?.activeElement ?? null;
                if (event.shiftKey) {
                  if (active === first || (active !== null && !dialogRef.current.contains(active))) {
                    event.preventDefault();
                    last.focus();
                  }
                } else if (
                  active === last ||
                  (active !== null && !dialogRef.current.contains(active))
                ) {
                  event.preventDefault();
                  first.focus();
                }
              }
            }
          }}
        >
          <div>
            <strong id={titleId} className={titleClassName}>
              Unsaved Custom Edits
            </strong>
            <p id={descId} className={descriptionClassName}>
              {formatDiscardSentence(actionLabel)}
            </p>
          </div>
          <div className={actionsClassName}>
            <button
              ref={stayButtonRef}
              type="button"
              className={stayButtonClassName}
              onClick={onDecline}
            >
              Stay Here
            </button>
            <button type="button" className={acceptButtonClassName} onClick={onAccept}>
              Discard &amp; Continue
            </button>
          </div>
        </div>
      </div>
    );
  },
);
