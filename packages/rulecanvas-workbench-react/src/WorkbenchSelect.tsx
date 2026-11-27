import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type Ref,
} from 'react';
import {
  EMPTY_TYPEAHEAD,
  SELECT_PAGE_SIZE,
  edgeEnabledIndex,
  isTypeaheadActive,
  isTypeaheadKey,
  resolveTypeahead,
  stepEnabledIndex,
  type SelectTypeaheadState,
} from './select-navigation.js';

export interface WorkbenchSelectOption<V extends string = string> {
  readonly value: V;
  /** Text shown in the trigger and the menu; also the type-ahead target. */
  readonly label: string;
  /** Optional secondary line shown in the menu only. */
  readonly description?: string | undefined;
  readonly disabled?: boolean | undefined;
}

export interface WorkbenchSelectOptionGroup<V extends string = string> {
  readonly group: string;
  readonly options: readonly WorkbenchSelectOption<V>[];
}

export type WorkbenchSelectItem<V extends string = string> =
  | WorkbenchSelectOption<V>
  | WorkbenchSelectOptionGroup<V>;

export interface WorkbenchSelectProps<V extends string = string> {
  /** Trigger id; pair it with `<label htmlFor>` exactly like a native select. */
  readonly id?: string | undefined;
  readonly value: V;
  readonly options: readonly WorkbenchSelectItem<V>[];
  /** Called only when the committed value differs from `value`. */
  readonly onChange: (next: V) => void;
  readonly ariaLabel?: string | undefined;
  readonly ariaLabelledBy?: string | undefined;
  readonly ariaDescribedBy?: string | undefined;
  readonly invalid?: boolean | undefined;
  readonly disabled?: boolean | undefined;
  readonly title?: string | undefined;
  /** Extra trigger classes (the trigger always carries `rc-select-trigger`). */
  readonly className?: string | undefined;
  /** Extra menu classes (the menu always carries `rc-select-menu`). */
  readonly menuClassName?: string | undefined;
  /** Render option labels in the monospace identifier face. */
  readonly mono?: boolean | undefined;
  /** `compact` tightens menu rows for dense editors. */
  readonly density?: 'default' | 'compact' | undefined;
  /** Text shown when `value` matches no option. */
  readonly placeholder?: string | undefined;
  readonly triggerRef?: Ref<HTMLButtonElement> | undefined;
  /** Extra `data-*` attributes for the trigger, e.g. `{ 'data-op': 'and' }`. */
  readonly triggerData?: Readonly<Record<`data-${string}`, string | undefined>> | undefined;
}

type Phase = 'closed' | 'open' | 'closing';

const VIEWPORT_MARGIN = 8;
const TRIGGER_GAP = 4;
const MENU_MAX_HEIGHT = 320;

function isGroup<V extends string>(item: WorkbenchSelectItem<V>): item is WorkbenchSelectOptionGroup<V> {
  return 'group' in item;
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (typeof ref === 'function') ref(value);
  else if (ref !== null && ref !== undefined) (ref as { current: T | null }).current = value;
}

/** Nearest ancestor that scrolls vertically; the menu closes when the trigger leaves it. */
function scrollParentOf(el: HTMLElement): HTMLElement | null {
  const view = el.ownerDocument.defaultView;
  for (let node = el.parentElement; node !== null; node = node.parentElement) {
    const overflowY = view?.getComputedStyle(node).overflowY;
    if (overflowY === 'auto' || overflowY === 'scroll') return node;
  }
  return null;
}

/** True when the trigger is scrolled out of its pane or hidden under a sticky bar. */
function isTriggerObscured(trigger: HTMLElement, menu: HTMLElement, scroller: HTMLElement | null): boolean {
  const view = trigger.ownerDocument.defaultView;
  if (view === null) return false;
  const rect = trigger.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return true;
  if (rect.bottom < 0 || rect.top > view.innerHeight) return true;
  if (scroller !== null) {
    const bounds = scroller.getBoundingClientRect();
    if (rect.bottom <= bounds.top || rect.top >= bounds.bottom) return true;
  }
  const x = Math.min(Math.max(rect.left + rect.width / 2, 0), view.innerWidth - 1);
  const y = Math.min(Math.max(rect.top + rect.height / 2, 0), view.innerHeight - 1);
  const hit = trigger.ownerDocument.elementFromPoint(x, y);
  return hit !== null && !trigger.contains(hit) && !menu.contains(hit);
}

function supportsPopover(el: HTMLElement): boolean {
  return typeof (el as HTMLElement & { showPopover?: unknown }).showPopover === 'function';
}

/** Places the menu below (or, when cramped, above) the trigger inside the viewport. */
function positionMenu(trigger: HTMLElement, menu: HTMLElement): void {
  const doc = trigger.ownerDocument;
  const view = doc.defaultView;
  if (view === null) return;
  const rect = trigger.getBoundingClientRect();
  const vw = doc.documentElement.clientWidth;
  const vh = view.innerHeight;

  menu.style.minWidth = `${Math.round(Math.min(rect.width, vw - VIEWPORT_MARGIN * 2))}px`;
  menu.style.maxHeight = '';
  const natural = Math.min(menu.scrollHeight + 2, MENU_MAX_HEIGHT);
  const below = vh - rect.bottom - TRIGGER_GAP - VIEWPORT_MARGIN;
  const above = rect.top - TRIGGER_GAP - VIEWPORT_MARGIN;
  const placement = natural <= below || below >= above ? 'bottom' : 'top';
  const available = Math.max(96, placement === 'bottom' ? below : above);
  const height = Math.min(natural, available);
  menu.style.maxHeight = `${Math.floor(Math.min(MENU_MAX_HEIGHT, available))}px`;

  const width = menu.offsetWidth;
  const left = Math.min(Math.max(rect.left, VIEWPORT_MARGIN), vw - VIEWPORT_MARGIN - width);
  const top = placement === 'bottom' ? rect.bottom + TRIGGER_GAP : rect.top - TRIGGER_GAP - height;
  menu.style.left = `${Math.round(Math.max(VIEWPORT_MARGIN, left))}px`;
  menu.style.top = `${Math.round(Math.max(VIEWPORT_MARGIN, top))}px`;
  menu.dataset['placement'] = placement;
}

function ChevronIcon() {
  return (
    <svg
      className="rc-select-chevron"
      width="10"
      height="10"
      viewBox="0 0 10 10"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M2.25 3.75 5 6.5l2.75-2.75"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <path
        d="M2.5 6.25 5 8.75l4.5-5.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Accessible select-only combobox (WAI-ARIA APG pattern) that replaces the native
 * `<select>` popup with a themed listbox.
 *
 * - Focus never leaves the trigger; the highlighted option is exposed through
 *   `aria-activedescendant`, so focus restoration after Escape, selection or
 *   outside clicks is automatic.
 * - The menu renders in the browser top layer (`popover="manual"`) with fixed
 *   positioning, so independently scrolling or `overflow: hidden` panes never clip
 *   it. It flips above the trigger and clamps horizontally at viewport edges.
 * - Keyboard: ArrowUp/Down, Home/End, PageUp/PageDown, Enter/Space, Alt+Arrow,
 *   Escape, Tab (commits the highlighted option). Typing while closed selects the
 *   matching option directly, like a native select; typing while open moves the
 *   highlight. Repeating a character cycles through matches.
 * - Opening and closing use CSS animations on `data-state`; the menu unmounts
 *   after its exit animation ends (immediately when animations are disabled).
 */
export function WorkbenchSelect<V extends string = string>({
  id,
  value,
  options,
  onChange,
  ariaLabel,
  ariaLabelledBy,
  ariaDescribedBy,
  invalid = false,
  disabled = false,
  title,
  className,
  menuClassName,
  mono = false,
  density = 'default',
  placeholder,
  triggerRef,
  triggerData,
}: WorkbenchSelectProps<V>) {
  const autoId = useId();
  const triggerId = id ?? `${autoId}-select`;
  const listboxId = `${triggerId}-listbox`;
  const optionId = (index: number) => `${listboxId}-option-${index}`;

  const [phase, setPhase] = useState<Phase>('closed');
  const [activeIndex, setActiveIndex] = useState(-1);
  const triggerEl = useRef<HTMLButtonElement | null>(null);
  const menuEl = useRef<HTMLDivElement | null>(null);
  const typeahead = useRef<SelectTypeaheadState>(EMPTY_TYPEAHEAD);

  const flat = useMemo(() => {
    const list: WorkbenchSelectOption<V>[] = [];
    for (const item of options) {
      if (isGroup(item)) list.push(...item.options);
      else list.push(item);
    }
    return list;
  }, [options]);

  const selectedIndex = flat.findIndex((option) => option.value === value);
  const selected = selectedIndex >= 0 ? flat[selectedIndex] : undefined;
  const isOpen = phase === 'open';

  const setTriggerRef = useCallback(
    (el: HTMLButtonElement | null) => {
      triggerEl.current = el;
      assignRef(triggerRef, el);
    },
    [triggerRef],
  );

  const open = (initial?: number) => {
    if (disabled) return;
    const fallback =
      selectedIndex >= 0 && flat[selectedIndex]?.disabled !== true
        ? selectedIndex
        : edgeEnabledIndex(flat, 'first');
    setActiveIndex(initial !== undefined && initial >= 0 ? initial : fallback);
    setPhase('open');
  };

  const close = () => {
    setPhase((current) => (current === 'open' ? 'closing' : current));
    typeahead.current = EMPTY_TYPEAHEAD;
  };

  const commit = (index: number, keepOpen = false) => {
    const option = flat[index];
    if (option === undefined || option.disabled === true) return;
    if (!keepOpen) close();
    if (option.value !== value) onChange(option.value);
  };

  // Show in the top layer and position before the first paint of the open menu.
  useLayoutEffect(() => {
    const menu = menuEl.current;
    const trigger = triggerEl.current;
    if (!isOpen || menu === null || trigger === null) return;
    if (supportsPopover(menu)) {
      try {
        if (!menu.matches(':popover-open')) menu.showPopover();
      } catch {
        // Already shown or unsupported selector; fixed positioning still applies.
      }
    }
    // Name the listbox after the trigger's own label (not its current value).
    if (ariaLabel === undefined && ariaLabelledBy === undefined) {
      const labelText = trigger.labels?.[0]?.textContent?.trim();
      if (labelText) menu.setAttribute('aria-label', labelText);
    }
    positionMenu(trigger, menu);
  }, [isOpen, options]);

  // Keep the highlighted option visible inside the scrollable menu.
  useLayoutEffect(() => {
    const menu = menuEl.current;
    if (!isOpen || menu === null || activeIndex < 0) return;
    const option = menu.ownerDocument.getElementById(optionId(activeIndex));
    if (option === null) return;
    const top = option.offsetTop;
    const bottom = top + option.offsetHeight;
    if (top < menu.scrollTop) menu.scrollTop = top - 4;
    else if (bottom > menu.scrollTop + menu.clientHeight) menu.scrollTop = bottom - menu.clientHeight + 4;
  }, [isOpen, activeIndex]);

  // Exit animation: unmount right away when no animation will run.
  useLayoutEffect(() => {
    const menu = menuEl.current;
    if (phase !== 'closing') return;
    if (menu === null) {
      setPhase('closed');
      return;
    }
    const style = menu.ownerDocument.defaultView?.getComputedStyle(menu);
    const duration = style === undefined ? 0 : parseFloat(style.animationDuration) || 0;
    if (style === undefined || style.animationName === 'none' || duration <= 0) {
      setPhase('closed');
      return;
    }
    // Cancelled or throttled animations never fire animationend; settle on `finished`.
    const settle = () => setPhase((current) => (current === 'closing' ? 'closed' : current));
    const animations = typeof menu.getAnimations === 'function' ? menu.getAnimations() : [];
    if (animations.length > 0) {
      Promise.all(animations.map((animation) => animation.finished)).then(settle, settle);
    }
  }, [phase]);

  // Outside clicks, viewport changes and scrolling of any ancestor pane.
  useEffect(() => {
    if (!isOpen) return;
    const trigger = triggerEl.current;
    const menu = menuEl.current;
    const doc = trigger?.ownerDocument;
    const view = doc?.defaultView;
    if (trigger == null || menu === null || doc === undefined || view == null) return;

    const scroller = scrollParentOf(trigger);
    // Labels delegate their click to the trigger, which toggles the menu itself.
    const inside = (target: EventTarget | null) =>
      target instanceof Node &&
      (trigger.contains(target) ||
        menu.contains(target) ||
        Array.from(trigger.labels ?? []).some((label) => label.contains(target)));
    const handlePointerDown = (event: PointerEvent) => {
      if (!inside(event.target)) close();
    };
    const reposition = (event?: Event) => {
      if (event !== undefined && event.target instanceof Node && menu.contains(event.target)) return;
      if (isTriggerObscured(trigger, menu, scroller)) {
        close();
        return;
      }
      positionMenu(trigger, menu);
    };
    doc.addEventListener('pointerdown', handlePointerDown, true);
    // Pressing a label must not blur the trigger (blur closes; the label click then toggles).
    const labels = Array.from(trigger.labels ?? []);
    const keepFocus = (event: MouseEvent) => event.preventDefault();
    for (const label of labels) label.addEventListener('mousedown', keepFocus);
    view.addEventListener('scroll', reposition, true);
    view.addEventListener('resize', reposition);
    return () => {
      doc.removeEventListener('pointerdown', handlePointerDown, true);
      for (const label of labels) label.removeEventListener('mousedown', keepFocus);
      view.removeEventListener('scroll', reposition, true);
      view.removeEventListener('resize', reposition);
    };
  }, [isOpen]);

  useEffect(() => {
    if (disabled && phase !== 'closed') setPhase('closed');
  }, [disabled, phase]);

  const handleTypeahead = (event: ReactKeyboardEvent<HTMLButtonElement>, from: number) => {
    const result = resolveTypeahead(flat, typeahead.current, event.key, event.timeStamp, from);
    typeahead.current = result.state;
    return result.index;
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    const { key } = event;

    if (event.altKey && (key === 'ArrowDown' || key === 'ArrowUp')) {
      event.preventDefault();
      if (!isOpen) open();
      else if (key === 'ArrowUp') commit(activeIndex);
      return;
    }

    if (!isOpen) {
      switch (key) {
        case 'ArrowDown':
        case 'ArrowUp':
        case 'Enter':
        case ' ':
          event.preventDefault();
          open();
          return;
        case 'Home':
          event.preventDefault();
          open(edgeEnabledIndex(flat, 'first'));
          return;
        case 'End':
          event.preventDefault();
          open(edgeEnabledIndex(flat, 'last'));
          return;
        default:
          if (isTypeaheadKey(event)) {
            event.preventDefault();
            const match = handleTypeahead(event, selectedIndex);
            if (match >= 0) commit(match, true);
          }
          return;
      }
    }

    switch (key) {
      case 'ArrowDown':
        event.preventDefault();
        setActiveIndex((current) => stepEnabledIndex(flat, current, 1));
        return;
      case 'ArrowUp':
        event.preventDefault();
        setActiveIndex((current) => stepEnabledIndex(flat, current, -1));
        return;
      case 'PageDown':
        event.preventDefault();
        setActiveIndex((current) => stepEnabledIndex(flat, current, SELECT_PAGE_SIZE));
        return;
      case 'PageUp':
        event.preventDefault();
        setActiveIndex((current) => stepEnabledIndex(flat, current, -SELECT_PAGE_SIZE));
        return;
      case 'Home':
        event.preventDefault();
        setActiveIndex(edgeEnabledIndex(flat, 'first'));
        return;
      case 'End':
        event.preventDefault();
        setActiveIndex(edgeEnabledIndex(flat, 'last'));
        return;
      case 'Enter':
        event.preventDefault();
        commit(activeIndex);
        return;
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        close();
        return;
      case 'Tab':
        commit(activeIndex);
        return;
      default:
        break;
    }

    if (key === ' ' && !isTypeaheadActive(typeahead.current, event.timeStamp)) {
      event.preventDefault();
      commit(activeIndex);
      return;
    }
    if (isTypeaheadKey(event)) {
      event.preventDefault();
      const match = handleTypeahead(event, activeIndex);
      if (match >= 0) setActiveIndex(match);
    }
  };

  const triggerClass = ['rc-select-trigger', className].filter(Boolean).join(' ');
  const menuClass = ['rc-select-menu', menuClassName].filter(Boolean).join(' ');
  const displayLabel = selected?.label ?? placeholder ?? value;

  let flatIndex = 0;
  const renderOption = (option: WorkbenchSelectOption<V>) => {
    const index = flatIndex;
    flatIndex += 1;
    const isSelected = index === selectedIndex;
    const isDisabled = option.disabled === true;
    return (
      <div
        key={`${index}-${option.value}`}
        id={optionId(index)}
        role="option"
        className="rc-select-option"
        aria-selected={isSelected}
        aria-disabled={isDisabled ? 'true' : undefined}
        data-value={option.value}
        data-active={index === activeIndex ? 'true' : undefined}
        onMouseMove={() => {
          if (!isDisabled && index !== activeIndex) setActiveIndex(index);
        }}
        onClick={() => commit(index)}
      >
        <span className="rc-select-check" aria-hidden="true">
          {isSelected ? <CheckIcon /> : null}
        </span>
        <span className="rc-select-option-label">{option.label}</span>
        {option.description !== undefined && (
          <span className="rc-select-option-desc">{option.description}</span>
        )}
      </div>
    );
  };

  return (
    <>
      <button
        ref={setTriggerRef}
        id={triggerId}
        type="button"
        role="combobox"
        className={triggerClass}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={isOpen ? listboxId : undefined}
        aria-activedescendant={isOpen && activeIndex >= 0 ? optionId(activeIndex) : undefined}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-describedby={ariaDescribedBy}
        aria-invalid={invalid ? 'true' : undefined}
        disabled={disabled}
        title={title}
        data-value={value}
        data-state={phase}
        {...triggerData}
        onClick={() => {
          if (isOpen) {
            close();
          } else {
            // Safari does not focus buttons on click; keyboard navigation needs focus.
            triggerEl.current?.focus({ preventScroll: true });
            open();
          }
        }}
        onKeyDown={handleKeyDown}
        onKeyUp={(event) => {
          // Stop Space from re-activating the button (and toggling the menu) on key up.
          if (event.key === ' ') event.preventDefault();
        }}
        onBlur={(event) => {
          // Focus can land on the menu (e.g. a scrollbar click); keep it open there.
          const next = event.relatedTarget;
          if (next instanceof Node && menuEl.current?.contains(next)) return;
          if (isOpen) close();
        }}
      >
        <span className="rc-select-value">{displayLabel}</span>
        <ChevronIcon />
      </button>
      {phase !== 'closed' && (
        <div
          ref={menuEl}
          id={listboxId}
          role="listbox"
          popover="manual"
          className={menuClass}
          aria-label={ariaLabel}
          aria-labelledby={ariaLabel === undefined ? ariaLabelledBy : undefined}
          data-state={phase}
          data-mono={mono ? 'true' : undefined}
          data-density={density === 'compact' ? 'compact' : undefined}
          tabIndex={-1}
          // Keep focus on the trigger while the pointer picks options. Presses on the
          // menu itself (its scrollbar) stay native so the scrollbar thumb can be dragged.
          onMouseDown={(event) => {
            if (event.target !== event.currentTarget) event.preventDefault();
          }}
          onFocus={(event) => {
            if (event.target === event.currentTarget) triggerEl.current?.focus({ preventScroll: true });
          }}
          onAnimationEnd={(event) => {
            if (event.target === event.currentTarget && phase === 'closing') setPhase('closed');
          }}
        >
          {options.map((item, groupIndex) =>
            isGroup(item) ? (
              <div
                key={`group-${groupIndex}-${item.group}`}
                role="group"
                className="rc-select-group"
                aria-labelledby={`${listboxId}-group-${groupIndex}`}
              >
                <div id={`${listboxId}-group-${groupIndex}`} className="rc-select-group-label">
                  {item.group}
                </div>
                {item.options.map(renderOption)}
              </div>
            ) : (
              <Fragment key={`item-${groupIndex}`}>{renderOption(item)}</Fragment>
            ),
          )}
        </div>
      )}
    </>
  );
}
