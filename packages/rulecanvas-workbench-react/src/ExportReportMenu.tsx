import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import type { TransitionSystemModel, VerifyOptions, VerifyResult } from '@rulecanvas/core';
import {
  buildVerificationReportFromSnapshot,
  formatVerificationReportMarkdown,
  sanitizeReportFilename,
  serializeVerificationReportJson,
} from '@rulecanvas/ui';
import type { VerifyExecutionMode } from '@rulecanvas/workbench/verify';

export interface ExportReportSnapshot {
  readonly model: TransitionSystemModel;
  readonly options: VerifyOptions;
  readonly result: VerifyResult;
  readonly executionMode?: VerifyExecutionMode | undefined;
}

export interface ExportReportMenuProps {
  readonly snapshot: ExportReportSnapshot | null;
  readonly isRunning: boolean;
  readonly isStale: boolean;
  readonly className?: string | undefined;
  readonly triggerClassName?: string | undefined;
  readonly menuClassName?: string | undefined;
  readonly itemClassName?: string | undefined;
  readonly statusClassName?: string | undefined;
  readonly tooltipClassName?: string | undefined;
}

type ExportActionId = 'copy-markdown' | 'download-markdown' | 'download-json';

interface ExportMenuAction {
  readonly id: ExportActionId;
  readonly label: string;
  readonly detail: string;
}

const EXPORT_ACTIONS: readonly ExportMenuAction[] = [
  {
    id: 'copy-markdown',
    label: 'Copy Markdown',
    detail: 'PR-ready audit summary',
  },
  {
    id: 'download-markdown',
    label: 'Download Markdown',
    detail: '.md audit report',
  },
  {
    id: 'download-json',
    label: 'Download JSON',
    detail: '.json lossless record',
  },
];

const VIEWPORT_MARGIN = 8;
const MENU_GAP = 6;
const DISABLED_HINT_TEXT = 'Run Verify to export current edits.';

function positionMenu(trigger: HTMLElement, menu: HTMLElement): void {
  const doc = trigger.ownerDocument;
  const view = doc.defaultView;
  if (view === null) return;
  const rect = trigger.getBoundingClientRect();
  const vw = doc.documentElement.clientWidth || view.innerWidth;
  const vh = view.innerHeight;

  const menuWidth = menu.offsetWidth || 224;
  const menuHeight = menu.offsetHeight || 136;

  const idealLeft = rect.right - menuWidth;
  const left = Math.round(
    Math.max(VIEWPORT_MARGIN, Math.min(idealLeft, vw - VIEWPORT_MARGIN - menuWidth)),
  );
  const spaceBelow = vh - rect.bottom - MENU_GAP - VIEWPORT_MARGIN;
  const spaceAbove = rect.top - MENU_GAP - VIEWPORT_MARGIN;
  const placement = menuHeight <= spaceBelow || spaceBelow >= spaceAbove ? 'bottom' : 'top';
  const top = Math.round(
    Math.max(
      VIEWPORT_MARGIN,
      placement === 'bottom' ? rect.bottom + MENU_GAP : rect.top - MENU_GAP - menuHeight,
    ),
  );

  menu.style.position = 'fixed';
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.style.right = 'auto';
  menu.dataset['placement'] = placement;
}

function ExportIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
      <path
        d="M8 2.5v7.25M5.25 5.25 8 2.5l2.75 2.75M3 10.5v2.25A1.25 1.25 0 0 0 4.25 14h7.5A1.25 1.25 0 0 0 13 12.75V10.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true" focusable="false">
      <path
        d="M2.25 3.75 5 6.5l2.75-2.75"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Accessible WAI-ARIA APG menu button for exporting deterministic verification
 * audit reports (Copy Markdown, Download Markdown, Download JSON).
 * Disabled whenever no fresh committed verification snapshot exists.
 */
export function ExportReportMenu({
  snapshot,
  isRunning,
  isStale,
  className,
  triggerClassName,
  menuClassName,
  itemClassName,
  statusClassName,
  tooltipClassName,
}: ExportReportMenuProps) {
  const [open, setOpen] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{
    readonly text: string;
    readonly tone: 'success' | 'error';
  } | null>(null);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const pendingFocusIndexRef = useRef<number | null>(null);
  const activeObjectUrlsRef = useRef<Set<string>>(new Set());

  const baseId = useId();
  const menuId = `${baseId}-export-menu`;
  const disabledHintId = `${baseId}-export-disabled-hint`;

  const disabled = snapshot === null || isRunning || isStale;

  const revokeUrlSoon = useCallback((url: string, view: Window | null) => {
    activeObjectUrlsRef.current.add(url);
    const cleanup = () => {
      if (activeObjectUrlsRef.current.has(url)) {
        activeObjectUrlsRef.current.delete(url);
        try {
          URL.revokeObjectURL(url);
        } catch {
          // ignore revocation errors in minimal runtimes
        }
      }
    };
    if (view !== null && typeof view.requestAnimationFrame === 'function') {
      view.requestAnimationFrame(() => {
        view.requestAnimationFrame(cleanup);
      });
    } else if (typeof queueMicrotask === 'function') {
      queueMicrotask(cleanup);
    } else {
      cleanup();
    }
  }, []);

  useEffect(() => {
    const urls = activeObjectUrlsRef.current;
    return () => {
      for (const url of urls) {
        try {
          URL.revokeObjectURL(url);
        } catch {
          // ignore
        }
      }
      urls.clear();
    };
  }, []);

  useEffect(() => {
    if (disabled && open) {
      setOpen(false);
    }
  }, [disabled, open]);

  useEffect(() => {
    setStatusMessage(null);
  }, [snapshot, isStale]);

  useLayoutEffect(() => {
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (!open || trigger === null || menu === null) return;

    const view = menu.ownerDocument.defaultView;
    const updatePosition = () => positionMenu(trigger, menu);
    updatePosition();

    if (pendingFocusIndexRef.current !== null) {
      const idx = pendingFocusIndexRef.current;
      pendingFocusIndexRef.current = null;
      itemRefs.current[idx]?.focus();
    }

    if (view === null) return;
    view.addEventListener('resize', updatePosition);
    view.addEventListener('scroll', updatePosition, true);
    return () => {
      view.removeEventListener('resize', updatePosition);
      view.removeEventListener('scroll', updatePosition, true);
    };
  }, [open]);

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
    const handleFocusIn = (event: FocusEvent) => {
      const root = rootRef.current;
      if (root !== null && event.target instanceof Node && !root.contains(event.target)) {
        setOpen(false);
      }
    };
    doc.addEventListener('pointerdown', handlePointerDown, true);
    doc.addEventListener('focusin', handleFocusIn, true);
    return () => {
      doc.removeEventListener('pointerdown', handlePointerDown, true);
      doc.removeEventListener('focusin', handleFocusIn, true);
    };
  }, [open]);

  const closeMenu = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) {
      triggerRef.current?.focus();
    }
  }, []);

  const openMenuAt = useCallback(
    (focusIndex: number) => {
      if (disabled) return;
      pendingFocusIndexRef.current = focusIndex;
      setOpen(true);
    },
    [disabled],
  );

  const runAction = useCallback(
    async (actionId: ExportActionId) => {
      closeMenu(true);
      if (disabled || snapshot === null) {
        setStatusMessage({ text: DISABLED_HINT_TEXT, tone: 'error' });
        return;
      }

      const built = buildVerificationReportFromSnapshot({
        model: snapshot.model,
        options: snapshot.options,
        result: snapshot.result,
        ...(snapshot.executionMode !== undefined ? { executionMode: snapshot.executionMode } : {}),
      });
      if (!built.ok) {
        setStatusMessage({
          text: built.errors[0]?.message ?? 'Unable to build verification report.',
          tone: 'error',
        });
        return;
      }

      const report = built.report;
      if (actionId === 'copy-markdown') {
        try {
          const markdown = formatVerificationReportMarkdown(report);
          const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
          if (clipboard === undefined || typeof clipboard.writeText !== 'function') {
            setStatusMessage({
              text: 'Clipboard unavailable in this browser. Use Download Markdown instead.',
              tone: 'error',
            });
            return;
          }
          await clipboard.writeText(markdown);
          setStatusMessage({ text: 'Copied Markdown report to clipboard.', tone: 'success' });
        } catch {
          setStatusMessage({
            text: 'Unable to copy Markdown report. Use Download Markdown instead.',
            tone: 'error',
          });
        }
        return;
      }

      try {
        const isMarkdown = actionId === 'download-markdown';
        const content = isMarkdown
          ? formatVerificationReportMarkdown(report)
          : serializeVerificationReportJson(report);
        const mimeType = isMarkdown
          ? 'text/markdown;charset=utf-8'
          : 'application/json;charset=utf-8';
        const filename = sanitizeReportFilename(report.model.id, isMarkdown ? 'md' : 'json');

        const doc = rootRef.current?.ownerDocument ?? (typeof document !== 'undefined' ? document : null);
        if (doc === null || typeof Blob === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
          setStatusMessage({
            text: 'File download is unavailable in this environment.',
            tone: 'error',
          });
          return;
        }

        const blob = new Blob([content], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const link = doc.createElement('a');
        link.href = url;
        link.download = filename;
        link.rel = 'noopener';
        link.style.display = 'none';
        doc.body.appendChild(link);
        link.click();
        doc.body.removeChild(link);
        revokeUrlSoon(url, doc.defaultView);
        setStatusMessage({ text: `Downloaded ${filename}.`, tone: 'success' });
      } catch {
        setStatusMessage({ text: 'Unable to export verification report file.', tone: 'error' });
      }
    },
    [closeMenu, disabled, revokeUrlSoon, snapshot],
  );

  const handleTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    switch (event.key) {
      case 'ArrowDown':
      case 'Enter':
      case ' ':
        event.preventDefault();
        openMenuAt(0);
        break;
      case 'ArrowUp':
        event.preventDefault();
        openMenuAt(EXPORT_ACTIONS.length - 1);
        break;
      case 'Escape':
        if (open) {
          event.preventDefault();
          event.stopPropagation();
          closeMenu(true);
        }
        break;
      default:
        break;
    }
  };

  const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const activeEl = event.currentTarget.ownerDocument.activeElement;
    const currentIndex = itemRefs.current.findIndex((el) => el === activeEl);
    const count = EXPORT_ACTIONS.length;

    switch (event.key) {
      case 'ArrowDown': {
        event.preventDefault();
        const next = currentIndex < 0 ? 0 : (currentIndex + 1) % count;
        itemRefs.current[next]?.focus();
        break;
      }
      case 'ArrowUp': {
        event.preventDefault();
        const prev = currentIndex < 0 ? count - 1 : (currentIndex - 1 + count) % count;
        itemRefs.current[prev]?.focus();
        break;
      }
      case 'Home':
        event.preventDefault();
        itemRefs.current[0]?.focus();
        break;
      case 'End':
        event.preventDefault();
        itemRefs.current[count - 1]?.focus();
        break;
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        closeMenu(true);
        break;
      case 'Tab':
        setOpen(false);
        break;
      default:
        break;
    }
  };

  const rootClass = ['rc-export', className].filter(Boolean).join(' ');
  const buttonClass = ['rc-export-trigger', triggerClassName].filter(Boolean).join(' ');
  const panelClass = ['rc-export-menu', menuClassName].filter(Boolean).join(' ');
  const optionClass = ['rc-export-item', itemClassName].filter(Boolean).join(' ');
  const feedbackClass = ['rc-export-status', statusClassName].filter(Boolean).join(' ');

  return (
    <div ref={rootRef} className={rootClass} data-open={open ? 'true' : 'false'}>
      <button
        ref={triggerRef}
        type="button"
        className={buttonClass}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-describedby={disabled ? disabledHintId : undefined}
        disabled={disabled}
        title={disabled ? DISABLED_HINT_TEXT : 'Export verification audit report'}
        data-rc-tip-host={tooltipClassName !== undefined ? 'true' : undefined}
        onClick={() => {
          if (disabled) return;
          if (open) closeMenu(false);
          else openMenuAt(0);
        }}
        onKeyDown={handleTriggerKeyDown}
      >
        <ExportIcon />
        <span>Export report</span>
        <ChevronIcon />
        {tooltipClassName !== undefined && !open && (
          <span className={tooltipClassName} data-align="end" aria-hidden="true">
            {disabled ? DISABLED_HINT_TEXT : 'Copy or download audit report'}
          </span>
        )}
      </button>

      {disabled && (
        <span id={disabledHintId} className="rc-sr-only">
          {DISABLED_HINT_TEXT}
        </span>
      )}

      {open && !disabled && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label="Export verification report"
          className={panelClass}
          onKeyDown={handleMenuKeyDown}
        >
          {EXPORT_ACTIONS.map((action, index) => (
            <button
              key={action.id}
              ref={(el) => {
                itemRefs.current[index] = el;
              }}
              type="button"
              role="menuitem"
              className={optionClass}
              data-export-action={action.id}
              onClick={() => {
                void runAction(action.id);
              }}
            >
              <span className="rc-export-item-label">{action.label}</span>
              <span className="rc-export-item-detail">{action.detail}</span>
            </button>
          ))}
        </div>
      )}

      <span
        className={feedbackClass}
        role={statusMessage?.tone === 'error' ? 'alert' : 'status'}
        aria-live="polite"
        data-tone={statusMessage?.tone}
      >
        {statusMessage?.text ?? ''}
      </span>
    </div>
  );
}
