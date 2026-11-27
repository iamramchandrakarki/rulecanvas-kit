import { useEffect } from 'react';

/** Root attribute set while hover/focus tooltips are dismissed with Escape. */
export const WORKBENCH_TOOLTIP_DISMISSED_ATTRIBUTE = 'data-rc-tooltips-dismissed';

/**
 * Makes CSS hover/focus tooltips dismissible (WCAG 2.2 SC 1.4.13).
 *
 * Tooltips in the workbenches are decorative `aria-hidden` labels that repeat a
 * control's accessible name or shortcut; they appear on `:hover` / `:focus-visible`.
 * Escape hides every visible tooltip without moving pointer or focus; the next
 * pointer move onto another element or focus change shows them again.
 */
export function useWorkbenchTooltipDismissal(): void {
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    const hostOf = (target: EventTarget | null) =>
      target instanceof Element ? target.closest('[data-rc-tip-host]') : null;
    let hoveredHost: Element | null = null;
    let dismissed: { pointerHost: Element | null; focused: Element | null } | null = null;
    const show = () => {
      dismissed = null;
      root.removeAttribute(WORKBENCH_TOOLTIP_DISMISSED_ATTRIBUTE);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        dismissed = { pointerHost: hoveredHost, focused: document.activeElement };
        root.setAttribute(WORKBENCH_TOOLTIP_DISMISSED_ATTRIBUTE, 'true');
      }
    };
    const handlePointerOver = (event: Event) => {
      hoveredHost = hostOf(event.target);
      if (dismissed !== null && hoveredHost !== dismissed.pointerHost) show();
    };
    const handleFocusIn = (event: Event) => {
      if (dismissed !== null && event.target !== dismissed.focused) show();
    };
    document.addEventListener('keydown', handleKeyDown, true);
    document.addEventListener('pointerover', handlePointerOver, true);
    document.addEventListener('focusin', handleFocusIn, true);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      document.removeEventListener('pointerover', handlePointerOver, true);
      document.removeEventListener('focusin', handleFocusIn, true);
      root.removeAttribute(WORKBENCH_TOOLTIP_DISMISSED_ATTRIBUTE);
    };
  }, []);
}
