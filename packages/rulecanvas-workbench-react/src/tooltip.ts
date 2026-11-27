import { useEffect } from 'react';

/** Root attribute set while hover/focus tooltips are dismissed with Escape. */
export const WORKBENCH_TOOLTIP_DISMISSED_ATTRIBUTE = 'data-rc-tooltips-dismissed';

/** Attribute that marks an element whose direct `.rc-tip` child is its tooltip. */
export const WORKBENCH_TOOLTIP_HOST_ATTRIBUTE = 'data-rc-tip-host';

const VIEWPORT_MARGIN = 8;

/**
 * Keeps a host's tooltip inside the viewport: clamps it horizontally and flips it
 * above the host when there is no room below. Pure geometry; writes inline styles only.
 */
export function placeWorkbenchTooltip(host: Element): void {
  const tip = host.querySelector<HTMLElement>(':scope > .rc-tip');
  const view = host.ownerDocument.defaultView;
  if (tip === null || view === null) return;
  const vw = host.ownerDocument.documentElement.clientWidth;
  const vh = view.innerHeight;
  const hostRect = host.getBoundingClientRect();
  const width = tip.offsetWidth;
  const height = tip.offsetHeight;
  const align = tip.dataset['align'];
  const preferred =
    align === 'start'
      ? hostRect.left
      : align === 'end'
        ? hostRect.right - width
        : hostRect.left + hostRect.width / 2 - width / 2;
  const left = Math.max(VIEWPORT_MARGIN, Math.min(preferred, vw - VIEWPORT_MARGIN - width));
  tip.style.left = `${Math.round(left - hostRect.left)}px`;
  tip.style.right = 'auto';
  tip.style.setProperty('--rc-tip-x', '0%');
  const fitsBelow = hostRect.bottom + 6 + height <= vh - VIEWPORT_MARGIN;
  tip.dataset['side'] = fitsBelow || hostRect.top - 6 - height < VIEWPORT_MARGIN ? 'bottom' : 'top';
}

/**
 * Decorative hover/focus tooltips for the workbenches.
 *
 * Tooltips are `aria-hidden` `.rc-tip` children of a `[data-rc-tip-host]` element and
 * repeat the host's accessible name or shortcut; CSS shows them on `:hover` and
 * `:focus-visible`. This hook:
 * - positions each tooltip inside the viewport just before it can show, and
 * - makes them dismissible (WCAG 2.2 SC 1.4.13): Escape hides every visible tooltip
 *   without moving pointer or focus until the pointer reaches another host or focus moves.
 */
export function useWorkbenchTooltips(): void {
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    const hostOf = (target: EventTarget | null) =>
      target instanceof Element ? target.closest(`[${WORKBENCH_TOOLTIP_HOST_ATTRIBUTE}]`) : null;
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
      const host = hostOf(event.target);
      if (host !== null && host !== hoveredHost) placeWorkbenchTooltip(host);
      hoveredHost = host;
      if (dismissed !== null && hoveredHost !== dismissed.pointerHost) show();
    };
    const handleFocusIn = (event: Event) => {
      const host = hostOf(event.target);
      if (host !== null) placeWorkbenchTooltip(host);
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
