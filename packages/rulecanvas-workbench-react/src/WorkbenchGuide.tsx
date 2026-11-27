import { useEffect, useId, useRef, useState } from 'react';

export interface WorkbenchGlossaryTerm {
  readonly term: string;
  readonly definition: string;
}

export interface WorkbenchWorkflowStep {
  readonly step: string;
  readonly title: string;
  readonly detail: string;
}

export const DEFAULT_WORKBENCH_WORKFLOW: readonly WorkbenchWorkflowStep[] = [
  {
    step: '1',
    title: 'Choose a scenario',
    detail: 'Pick a broken, vacuous, or repaired preset from the top bar.',
  },
  {
    step: '2',
    title: 'Run Verify',
    detail: 'Bounded BFS explores reachable states and checks every invariant (Ctrl/Cmd+Enter).',
  },
  {
    step: '3',
    title: 'Inspect evidence',
    detail: 'Step through the counterexample trace to see which rule and state values triggered it.',
  },
  {
    step: '4',
    title: 'Stage & re-verify',
    detail: 'Apply or edit a guard repair in the draft, then run Verify again to confirm.',
  },
];

export const DEFAULT_WORKBENCH_GLOSSARY: readonly WorkbenchGlossaryTerm[] = [
  {
    term: 'Invariant',
    definition: 'A safety property that must hold in every reachable state of the model.',
  },
  {
    term: 'Guard',
    definition: 'The boolean condition that must evaluate to true before a transition rule can fire.',
  },
  {
    term: 'Counterexample',
    definition: 'The shortest step-by-step transition sequence from the initial state to an invariant violation.',
  },
  {
    term: 'Reachable state',
    definition: 'Any combination of state variable values reachable by firing valid rules from the initial state.',
  },
  {
    term: 'Transition',
    definition: 'An atomic rule that checks its guard and applies all of its variable updates together.',
  },
  {
    term: 'Verification bounds',
    definition: 'Limits on explored states (maxStates) and trace depth (maxDepth); hitting a cap reports INCONCLUSIVE.',
  },
  {
    term: 'Vacuous verification',
    definition: 'Invariants hold only because the declared goal can never be reached (e.g. a rule blocks all progress).',
  },
];

export interface WorkbenchGuideControlProps {
  readonly appTitle: string;
  readonly appSummary: string;
  readonly workflow?: readonly WorkbenchWorkflowStep[] | undefined;
  readonly glossary?: readonly WorkbenchGlossaryTerm[] | undefined;
  readonly className?: string | undefined;
  readonly triggerClassName?: string | undefined;
  readonly panelClassName?: string | undefined;
  readonly visuallyHiddenClassName?: string | undefined;
  /** Renders an `aria-hidden` hover/focus tooltip with this class instead of a `title`. */
  readonly tooltipClassName?: string | undefined;
}

/**
 * Accessible disclosure popover providing a quick-start workflow and plain-language
 * formal verification glossary without occupying permanent workspace space.
 */
export function WorkbenchGuideControl({
  appTitle,
  appSummary,
  workflow = DEFAULT_WORKBENCH_WORKFLOW,
  glossary = DEFAULT_WORKBENCH_GLOSSARY,
  className,
  triggerClassName,
  panelClassName,
  visuallyHiddenClassName,
  tooltipClassName,
}: WorkbenchGuideControlProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelId = `${useId()}-guide-panel`;

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
      data-open={open ? 'true' : 'false'}
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
        aria-expanded={open}
        aria-controls={panelId}
        title={tooltipClassName === undefined ? 'Workflow guide and verification glossary' : undefined}
        data-rc-tip-host={tooltipClassName !== undefined ? 'true' : undefined}
        onClick={() => setOpen((prev) => !prev)}
      >
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
          <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.4" />
          <path
            d="M6.4 6.1a1.7 1.7 0 0 1 3.2.8c0 1-1.1 1.3-1.6 1.8-.2.2-.2.4-.2.8"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
          <circle cx="8" cy="11.6" r="0.85" fill="currentColor" />
        </svg>
        <span>Guide</span>
        {visuallyHiddenClassName !== undefined && (
          <span className={visuallyHiddenClassName}> and glossary</span>
        )}
        {tooltipClassName !== undefined && !open && (
          <span className={tooltipClassName} data-align="end" aria-hidden="true">
            Workflow guide and glossary
          </span>
        )}
      </button>

      <div
        id={panelId}
        className={panelClassName}
        role="region"
        aria-label={`${appTitle} workflow guide and verification glossary`}
        hidden={!open}
      >
        <div data-guide-section="intro">
          <div data-guide-head="true">
            <strong>How {appTitle} works</strong>
            <button
              type="button"
              data-guide-close="true"
              aria-label="Close guide"
              onClick={() => {
                setOpen(false);
                triggerRef.current?.focus();
              }}
            >
              ×
            </button>
          </div>
          <p data-guide-summary="true">{appSummary}</p>
        </div>

        <ol data-guide-workflow="true" aria-label="Verification workflow steps">
          {workflow.map((item) => (
            <li key={item.step}>
              <span data-guide-step-num="true" aria-hidden="true">
                {item.step}
              </span>
              <div>
                <strong>{item.title}</strong>
                <span>{item.detail}</span>
              </div>
            </li>
          ))}
        </ol>

        <div data-guide-section="glossary">
          <strong data-guide-subheading="true">Key terms</strong>
          <dl data-guide-glossary="true">
            {glossary.map((entry) => (
              <div key={entry.term} data-guide-term-row="true">
                <dt>{entry.term}</dt>
                <dd>{entry.definition}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </div>
  );
}
