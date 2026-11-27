---
name: RuleCanvasKit
description: Deterministic finite-state verification and simulation workbench design system
colors:
  paper-light: "oklch(98.4% 0.004 250)"
  surface-light: "oklch(99.4% 0.002 250)"
  surface-subtle-light: "oklch(96.4% 0.006 250)"
  ink-light: "oklch(19.5% 0.018 255)"
  ink-secondary-light: "oklch(38.5% 0.018 254)"
  ink-muted-light: "oklch(50% 0.016 252)"
  rule-light: "oklch(88.5% 0.010 250)"
  control-border-light: "oklch(59% 0.025 252)"
  paper-dark: "oklch(15.5% 0.010 255)"
  surface-dark: "oklch(18.5% 0.012 255)"
  surface-subtle-dark: "oklch(21.5% 0.013 255)"
  ink-dark: "oklch(94.5% 0.006 250)"
  ink-secondary-dark: "oklch(79% 0.010 252)"
  ink-muted-dark: "oklch(67% 0.012 252)"
  rule-dark: "oklch(28.5% 0.014 255)"
  control-border-dark: "oklch(48% 0.018 254)"
  accent-cobalt: "oklch(48% 0.175 256)"
  accent-cobalt-dark: "oklch(71% 0.145 252)"
  verdict-verified: "oklch(44% 0.135 152)"
  verdict-verified-dark: "oklch(75% 0.135 152)"
  verdict-warning: "oklch(50% 0.14 72)"
  verdict-warning-dark: "oklch(78% 0.14 75)"
  verdict-violated: "oklch(49% 0.185 25)"
  verdict-violated-dark: "oklch(71% 0.165 25)"
typography:
  display:
    fontFamily: "'IBM Plex Sans', 'IBM Plex Sans Fallback', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.015em"
  headline:
    fontFamily: "'IBM Plex Sans', 'IBM Plex Sans Fallback', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 600
    lineHeight: 1.35
    letterSpacing: "-0.01em"
  title:
    fontFamily: "'IBM Plex Sans', 'IBM Plex Sans Fallback', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "0.84375rem"
    fontWeight: 600
    lineHeight: 1.35
  body:
    fontFamily: "'IBM Plex Sans', 'IBM Plex Sans Fallback', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "0.84375rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "'IBM Plex Mono', 'IBM Plex Mono Fallback', ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: 1.4
rounded:
  xs: "2px"
  sm: "3px"
  md: "4px"
spacing:
  "1": "4px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
  "5": "20px"
  "6": "24px"
  "8": "32px"
components:
  button-primary:
    backgroundColor: "{colors.accent-cobalt}"
    textColor: "{colors.surface-light}"
    rounded: "{rounded.sm}"
    padding: "6px 12px"
    height: "32px"
  button-secondary:
    backgroundColor: "{colors.surface-light}"
    textColor: "{colors.ink-light}"
    rounded: "{rounded.sm}"
    padding: "6px 12px"
    height: "32px"
  input-field:
    backgroundColor: "{colors.surface-light}"
    textColor: "{colors.ink-light}"
    rounded: "{rounded.sm}"
    padding: "5px 8px"
    height: "32px"
---

# Design System: RuleCanvasKit

## Overview

**Creative North Star: "The Formal Specification Bench"**

RuleCanvasKit is an engineering verification suite for discrete finite-state transition systems. Its visual language combines a high-density functional workbench architecture with restrained editorial typography, thin `1px` structural rules, mathematical proposition clarity, and domain-honest state visualization. Every pixel exists to help an engineer locate a violated invariant, trace the exact transition sequence that caused it, inspect or repair the governing guard predicate, and confirm whether the declared reachability goal remains witnessed.

Both applications share one visual foundation, command shell, semantic verdict vocabulary, and `System` / `Light` / `Dark` theme architecture while expressing distinct domain identities:

- **AgentGate** operates as a **policy verification IDE**: structured rule navigation, clean boolean/value AST editing, chronological counterexample trace inspection, `before -> after` state diffs, and vacuous-fix detection.
- **InterlockSim** operates as a **discrete-state engineering simulator**: P&ID/CAD-inspired containment schematic, synchronized step-level sensor telemetry, operator transition actuators, guard-blocking explanations, and permanent non-certification scope disclosures.

The system explicitly rejects AI-generated SaaS dashboard clichés: nested cards inside cards, pill badges on non-status labels, tracked-out uppercase eyebrows, decorative gradients or neon glows, oversized rounded corners, ASCII pseudo-icons, and competing hero-metric tiles.

**Key Characteristics:**
- Hairline-delimited panes (`1px solid`) instead of floating card stacks.
- Self-hosted **IBM Plex Sans** for interface prose and **IBM Plex Mono** (`tabular-nums`) strictly for identifiers, expressions, state values, step counters, and bounds.
- Semantic color reserved for primary verification actions and formal engine verdicts (`VERIFIED`, `VERIFIED (GOAL UNREACHABLE)`, `VIOLATED`, `INCONCLUSIVE`, `INVALID`, `OUTDATED`).
- Persistent `System` default theme (with `Light` fallback when OS preference is unset) plus explicit `Light` and `Dark` overrides synchronized across workbenches.

## Colors

The palette is anchored in cool, low-chroma slate neutrals in OKLCH so semantic verification states command immediate, unambiguous visual priority in both Light and Dark themes.

### Primary
- **Precision Cobalt** (`oklch(48% 0.175 256)` in Light; `oklch(71% 0.145 252)` in Dark): Reserved for the primary `Verify` command, active selection indicators, keyboard `:focus-visible` outlines, and modified-variable highlights on the active replay step.

### Secondary
- **Verified Emerald** (`oklch(44% 0.135 152)` in Light; `oklch(75% 0.135 152)` in Dark): Signals exhaustive `VERIFIED` status with reachable goal, satisfied invariants (`PASS`), and engine-authorized transition actuators (`READY`).
- **Caution Amber** (`oklch(50% 0.14 72)` in Light; `oklch(78% 0.14 75)` in Dark): Signals `OUTDATED` snapshots after unverified edits, `VERIFIED (GOAL UNREACHABLE)` vacuous fixes, `INCONCLUSIVE` bounded truncations, and guard-locked interlock rules.
- **Violation Crimson** (`oklch(49% 0.185 25)` in Light; `oklch(71% 0.165 25)` in Dark): Signals `VIOLATED` counterexamples, `INVALID` schema/AST/JSON diagnostics, containment breach indicators, and destructive row actions on hover/focus.

### Neutral
- **Bench Paper** (`oklch(98.4% 0.004 250)` Light / `oklch(15.5% 0.010 255)` Dark): Primary workspace canvas behind inspection docks and schematic stages.
- **Instrument Surface** (`oklch(99.4% 0.002 250)` Light / `oklch(18.5% 0.012 255)` Dark): Primary editing panes, command bar, tables, and form controls; tinted off-white rather than pure `#ffffff` to reduce glare during extended inspection.
- **Recessed Well** (`oklch(96.4% 0.006 250)` Light / `oklch(21.5% 0.013 255)` Dark): Subtle structural grouping for proposition strips, table headers, and schematic wells.
- **Primary & Secondary Ink** (`oklch(19.5% 0.018 255)` and `oklch(38.5% 0.018 254)` Light; `oklch(94.5% 0.006 250)` and `oklch(79% 0.010 252)` Dark): Calibrated to exceed WCAG 2.2 AA `4.5:1` contrast across all surfaces.
- **Hairline & Control Borders** (`oklch(88.5% 0.010 250)` structural rule and `oklch(59% 0.025 252)` interactive control border in Light; `oklch(28.5% 0.014 255)` and `oklch(48% 0.018 254)` in Dark): Interactive borders maintain `>= 3:1` WCAG 2.2 non-text contrast against adjacent surfaces.

### Named Rules
**The One-Signal Verdict Rule.** Semantic green, amber, and crimson appear only when tied to an engine-derived verification verdict, invariant evaluation, transition guard state, or validation error. Static section headings and metadata never wear status badge colors.

**The Non-Competing Witness Rule.** When a `VIOLATED` verdict also witnesses `goalReachable: true` on a valid prefix state, present the goal witness as neutral/secondary metadata rather than a green success badge competing with `VIOLATED`.

## Typography

**Display & Interface Font:** `IBM Plex Sans` (`400`, `500`, `600` self-hosted Latin WOFF2 subsets, with metric-calibrated platform sans fallback)
**Technical & Proposition Font:** `IBM Plex Mono` (`400`, `500`, `600` self-hosted Latin WOFF2 subsets, with metric-calibrated monospace fallback)

**Character:** Engineered, legible, and calm. `IBM Plex Sans` carries UI navigation, labels, explanations, and scope disclosures in natural sentence case; `IBM Plex Mono` distinguishes formal model identifiers (`publish_release_notes`, `inv_containment_seal`), boolean propositions, state values, and numeric bounds.

### Hierarchy
- **Workbench Identity** (`600`, `0.9375rem` / `15px`, `line-height: 1.25`, `-0.015em`): Top-bar suite and application title.
- **Pane Heading** (`600`, `0.9375rem` / `15px`, `line-height: 1.35`, `-0.01em`): Primary workspace column headings (`text-wrap: balance`).
- **Section Title** (`600`, `0.8125rem` / `13px`, `line-height: 1.35`): Hairline-separated subsections within editors and verification docks.
- **Interface Body** (`400`, `0.84375rem` / `13.5px`, `line-height: 1.5`, measure `<= 72ch`): Descriptions, assumption statements, and diagnostic guidance (`text-wrap: pretty`).
- **Technical Proposition & Data** (`IBM Plex Mono` `400`–`600`, `0.75rem`–`0.8125rem` / `12px`–`13px`, `line-height: 1.45`, `font-variant-numeric: tabular-nums`): Guard AST formulas, `when / then` summaries, state tables, step counters, and exploration metrics.

### Named Rules
**The Monospace Discipline Rule.** Use `IBM Plex Mono` exclusively for formal identifiers, expressions, state values, numeric bounds, and step indices. Never set ordinary prose, button labels, or section titles in monospace as decoration.

**The Sentence-Case Heading Rule.** Write headings, tabs, and field labels in clear sentence or title case without tracked-out uppercase eyebrow labels above headings. Reserve uppercase strictly for canonical engine verdict tokens (`VERIFIED`, `VIOLATED`, `INCONCLUSIVE`, `INVALID`, `OUTDATED`) and compact schematic state readouts (`OPEN`, `CLOSED`).

## Layout

RuleCanvasKit uses a `4px` spatial base unit (`4px`, `8px`, `12px`, `16px`, `20px`, `24px`, `32px`) and full-bleed hairline-divided panes rather than padded card grids.

- **Unified Top Command Shell:** Single sticky top bar containing the geometric `RuleCanvasKit` mark (`WorkbenchBrandLink` returning to the static hub `../`), active workbench switcher (`AgentGate` / `InterlockSim`), active scenario preset selector, `maxStates` and `maxDepth` inputs, live verification status indicator, primary `Verify` / `Cancel` button (`Ctrl/Cmd + Enter`), preset comparison toggle (`Compare (5)` / `Compare (3)`), `Guide` & glossary popover, and `System / Light / Dark` theme control. At small-laptop widths (`1024px`–`1279px`), the `Guide` label collapses to its icon while remaining visible at `1280px` and `1440px`.
- **Context & Scope Strip:** Compact hairline strip immediately beneath the command bar displaying the active preset summary and, in `InterlockSim`, the permanent non-certification scope notice (`Not IEC 61508 / SIL Certified`).
- **Desktop Multi-Pane Workspaces (`>= 1024px`):**
  - **AgentGate:** Split master-detail policy workspace (`Policy & Schema Editor` on the left with compact rule list annotated by active counterexample steps + focused active rule/AST inspector; `Verification & Counterexample Workbench` on the right with co-located verdict, trace timeline, `Inspect rule` jump action, and tabbed/structured inspection for State & Diff, Invariants & Goal, Manual Step, and Assumptions).
  - **InterlockSim:** Two-column engineering simulator (`Discrete BSL-3 Airlock Schematic` + 7-variable sensor readout strip + `Operator Simulation Console` on the left; `Verification Verdict & Trace Analysis` + `Interlock Guard Inspector & Model` with surfaced Guided Repair on the right).
- **Tablet & Mobile Adaptation (`360px`–`1023px`):**
  - Compact wrapping command header with zero horizontal page overflow (`documentElement.scrollWidth <= innerWidth`) and `>= 40px` touch target heights on coarse/narrow viewports.
  - Explicit mobile workspace mode switch (`Verify & Trace` vs. `Model Editor` in AgentGate; `Simulate & Schematic` vs. `Verdict & Guard` in InterlockSim) paired with a persistent compact verdict bar so running verification or stepping a trace provides immediate feedback without multi-screen scrolling.
  - Adaptive schematic presentation below `640px` so containment zones, doors, and sensor states remain crisp and readable above `11px` CSS size.

## Elevation & Depth

RuleCanvasKit is **flat-by-default**, conveying hierarchy through surface luminance steps (`--color-paper` -> `--color-surface` -> `--color-surface-subtle`) and crisp `1px` borders rather than drop shadows.

### Shadow Vocabulary
- **Modal Dialog Elevation** (`0 12px 32px -4px oklch(12% 0.02 255 / 0.24)` in Light; `0 16px 40px -4px oklch(0% 0 0 / 0.55)` in Dark): Applied solely to interrupting overlays such as the unsaved-edits `alertdialog` modal over a translucent scrim.

### Named Rules
**The Zero-Card-Nesting Rule.** Never place a bordered, shadowed card inside another bordered card. Separate peer sections inside a pane with `1px solid var(--color-rule)` hairlines and whitespace.

## Shapes

- **Engineering Radii:** Controls, badges, inputs, and dialogs use crisp `2px`–`4px` corners (`--radius-xs: 2px`, `--radius-sm: 3px`, `--radius-md: 4px`). Pill radii (`9999px`) and large consumer radii (`>= 10px`) are prohibited.
- **Schematic Geometry (`InterlockSim`):** The airlock schematic uses subtle CAD/P&ID conventions: `1px`–`2px` vector bulkheads, geometric seal indicators, airflow direction chevrons, segmented HEPA cycle bars, and clean vector sensor glyphs (never ASCII approximations like `[||]` or `***`).
- **Browser Surfaces:** Scrollbars (`scrollbar-color`), text selection (`::selection`), carets (`caret-color`), and `:focus-visible` rings are themed directly from semantic tokens in both Light and Dark modes.

## Components

Every interactive component implements all eight states: `default`, `hover`, `active`, `focus-visible`, `selected`, `disabled`, `loading`, and `error`.

### Buttons
- **Shape & Sizing:** `3px` radius (`--radius-sm`), `min-height: 32px` (`36px`–`40px` on mobile viewports), `1px` solid border, `500` weight `IBM Plex Sans`.
- **Primary (`Verify`):** `--color-accent` fill with high-contrast `--color-accent-ink` text; while `isRunning` is true, the primary button reflects the in-flight state and pairs directly with `Cancel Verification` to prevent duplicate dispatches.
- **Secondary & Compact Actions:** `--color-surface` fill with `--color-control-border` (`>= 3:1` contrast); subtle surface shift on `:hover` (`@media (hover: hover)`) and `transform: scale(0.985)` tactile press on `:active:not(:disabled)`.
- **Danger (`Remove` / `Cancel Verification`):** Quiet `--color-danger` text with `--color-danger-border` at rest, escalating to solid danger fill only on hover/active.

### Status Badges
- **Style:** `2px` radius, `1px` semantic border, soft semantic tint background, leading `aria-hidden="true"` symbol (`✓`, `✗`, `!`, `…`, `○`) paired with explicit status text so color is never the sole channel.
- **Usage:** Restricted to verification verdicts, invariant/goal outcomes, state-change markers (`Modified` / `Unchanged`), and actuator readiness (`READY` / `LOCKED`).

### Inputs / Fields
- **Style:** `3px` radius, `min-height: 32px`, `1px solid var(--color-control-border)`, paired bidirectionally with an explicit `<label for="...">`.
- **Focus & Error:** Fields and select triggers draw one `2px solid var(--color-focus)` ring over their `1px` border (`outline-offset: -1px`), so there is no gap and no second outline. Buttons keep a `2px` ring with a `2px` offset so the ring stays visible on filled primary buttons. Inside AST operand units (`[kind | value]`), the unit border turns focus-coloured and the focused half gets an inset `2px` underline. `aria-invalid="true"` switches the border, and the focus ring, to `--color-error` and binds inline `role="alert"` recovery copy via `aria-describedby`.
- **Numeric Bounds & AST Literals:** Always rendered as `type="text" inputMode="numeric"` in `IBM Plex Mono` (`tabular-nums`), preserving raw drafts across tab switches without browser spinner coercion.

### Select Menus (`WorkbenchSelect`)
- **Pattern:** WAI-ARIA select-only combobox. The trigger is a `<button role="combobox">` paired with the same `<label for>` a native select used; focus stays on the trigger and the highlighted option is exposed through `aria-activedescendant`, so Escape, selection and outside clicks restore focus without extra work.
- **Keyboard:** `ArrowUp` / `ArrowDown` / `Home` / `End` / `PageUp` / `PageDown` move the highlight without wrapping, `Enter` / `Space` / `Alt+ArrowUp` commit, `Tab` commits and moves on, `Escape` dismisses without change. Typing on a closed trigger selects the matching option directly, like a native select; typing while open moves the highlight, and repeating a character cycles through matches.
- **Placement:** The listbox uses `popover="manual"` in the browser top layer with fixed positioning when supported, so independently scrolling or `overflow: hidden` panes never clip it. When a browser lacks Popover API support, `WorkbenchSelect` removes the `popover` attribute and compensates for any transformed ancestor containing block. In both modes, it opens below the trigger, flips above when there is more room there, clamps to an `8px` viewport margin, and caps at `320px` before scrolling.
- **States:** Highlighted option: `--color-accent-soft` row with a `1px` `--color-accent-border` inset ring. Selected option: check mark, `600` weight and accent label. Disabled option: muted ink, skipped by navigation and type-ahead. Scenario pickers and AST pickers add one muted hint line (or a right-aligned hint in `compact` density) explaining each option.

### Compact Schema Table (`AgentGate`)
- **Layout:** One `28px` row per variable under shared `Variable / Type / Domain / Initial` headings. Domain configuration stays inline: `true | false` for booleans, comma-separated values for enums, `min .. max` for integers. The add-variable form is the table's last row and defaults the initial value (`false`, first enum value, or `min`).
- **Readability & Responsiveness:** Long identifiers keep the widest column and expose the full name in the field `title`. Below a `480px` container width each row stacks into a two-line card with visible per-field labels.
- **Destructive Action:** Removing a variable is a quiet icon button that turns crimson on hover or focus. The last variable cannot be removed, and the reason is stated in its tooltip and in an associated hint.

### Tooltips
- **Decorative Only:** `.rc-tip` labels are `aria-hidden` and repeat a control's accessible name or shortcut (icon buttons, theme switch, guide, `Verify` with `Ctrl/Cmd + Enter` also exposed through `aria-keyshortcuts`). They show on keyboard focus immediately and on hover after `380ms`, stay inside the viewport (clamped horizontally, flipped above when there is no room below), and `Escape` hides them without moving pointer or focus (WCAG 2.2 SC 1.4.13).

### Navigation & Workspace Tabs
- **Suite Switcher (`WorkbenchNavigation`):** Top-bar links with `aria-current="page"` indicator and race-safe unsaved-edits guard.
- **Section & Inspection Tabs:** WAI-ARIA `role="tablist"` with roving `tabIndex`, `ArrowLeft` / `ArrowRight` / `Home` / `End` keyboard support, `2px` active indicator bar, and mounted `[hidden]` inactive panels to preserve uncommitted drafts.

### Signature Components
- **Master-Detail Rule & Proposition Inspector (`AgentGate`):** Pairs a compact rule index (annotated with counterexample step markers when a violation trace is active) with a mathematical `when <guard> / then <updates>` summary strip and inline recursive AST clause editors.
- **Synchronized Containment Schematic (`InterlockSim`):** Renders outer corridor, airlock chamber, doors, differential pressure, UV-C lamp, occupancy, HEPA purge counter, and maintenance override directly from the replay session state, with explicit snapshot provenance (`Snapshot: ...`, `OUTDATED` warning when edits are pending, and step-scoped invariant labels).

### Motion
- **Purposeful Motion Token Scale:** Every transition maps to one of five durations between `90ms` and `280ms` and three curves (`--ease-out: cubic-bezier(0.22, 1, 0.36, 1)` for entrances and state changes, `--ease-in: cubic-bezier(0.4, 0, 1, 1)` for exits, `--ease-in-out: cubic-bezier(0.45, 0, 0.25, 1)` for mechanical travel). No control overshoots or bounces.
  - `--dur-instant` (`90ms`): Press feedback, option highlight, menu exit.
  - `--dur-fast` (`140ms`): Hover and focus, menu entry, chevrons, rule and trace-step selection tints.
  - `--dur-base` (`200ms`): Popovers, dialogs, tab indicators, tab-panel and rule-detail reveals, AST group expansion, verdict updates.
  - `--dur-expand` (`260ms`): Comparison drawer and the changed-value cue on the active replay step.
  - `--dur-state` (`280ms`): InterlockSim schematic travel: door leaves, airflow chevrons, UV-C rays, occupancy silhouette, HEPA purge segments, override key rotation.
- **Shared Layer:** `controls.css` (byte-identical in both apps) owns select menu entry and exit, tab indicators, tab-panel settling, AST group expansion and the changed-value cue. Values whose replay step changed them re-mount with a short info-tint pulse, so the cue marks exactly the variables the step modified.
- **Honest Motion:** Animations are cosmetic. Verdicts, state values, door states and enabled actions render in their final state immediately; motion never delays verification or model execution.
- **Contrast-Safe Entrance Motion:** Reveal animations use GPU-composited `transform`, `clip-path`, and tinted background settling rather than fading text from `opacity: 0`, ensuring WCAG 2.2 AA contrast at every animation frame. Only the `90ms` menu exit fades out.
- **Reduced Motion:** `@media (prefers-reduced-motion: reduce)` disables transitions and animations, and select menus mount and unmount without animation. Changed values keep a static tint instead of a pulse, and all state labels, badges and functional cues stay identical.

### Discoverability, Export, Delta & Replay Controls
- **Unified Header Grouping:** Subtle `1px` toolbar dividers separate Scenario/Bounds configuration, Live Verdict + single Primary `Verify` action, and secondary Utilities (`Compare (5)` / `Compare (3)`, `Guide` & glossary popover, `System / Light / Dark` theme switch).
- **On-Demand Workflow & Terminology (`WorkbenchGuideControl`):** Accessible `Guide` popover documents the 4-step workflow (`Choose scenario -> Run Verify -> Inspect evidence -> Stage & re-verify`) and plain-language definitions for `Invariant`, `Guard`, `Counterexample`, `Reachable state`, `Transition`, `Verification bounds`, and `Vacuous verification` without occupying permanent workspace space. The popover positions itself relative to the trigger within a `12px` viewport margin on resize/scroll, closes on outside pointer-down, `focusin`, or `Escape`, and gives its close button a `32×32px` hit target (`40×40px` on coarse pointers).
- **Audit Report Export (`ExportReportMenu`):** WAI-ARIA APG menu button in the Verification Inspector header offering `Copy Markdown`, `Download Markdown`, and `Download JSON` from the active non-stale `'validated-snapshot'` report. Disabled while verification is running or when pending edits make the snapshot stale.
- **Same-Model Verdict Delta (`VerdictDeltaRow`):** Hairline-separated strip beneath the verdict detail comparing the previous and current committed runs on the same model (`Before -> Now`, goal reachability, and changed model sections when re-verified after edits).
- **Replay Controls & Shortcuts:** Both workbenches support `[` (previous step) and `]` (next step) keyboard shortcuts whenever focus is outside editable fields, comboboxes, menus, or dialogs, alongside inline trace toolbars (`Reset`, `Previous`, `Next`, and `Restore Counterexample` in InterlockSim).
- **Comparison Matrix Scroll & Pinned Actions:** Wide comparison tables use `.rc-scroll-x` scroll-shadow cues and pin the final `Action` column to the right edge so `Load Preset` remains reachable on narrow viewports.
- **Semantic Repair Diffs & Staged Confirmation:** Candidate repairs highlight the exact added/relocated guard clause with semantic diff tokens (`--color-diff-add-bg` / `--color-diff-add-border` / `--color-diff-add-ink`), and staging a repair displays an explicit unverified-draft confirmation strip with a direct `Run Verification` trigger.
- **AST Group & Console-to-Schematic Coupling:** `and` (cobalt), `or` (amber caution), and `not` (danger accent) AST groups carry distinct operator tints and tree guide rails. In `InterlockSim`, hovering or focusing an enabled actuator highlights the affected schematic modules and telemetry cells in real time.

## Do's and Don'ts

### Do:
- **Do** self-host only the required Latin WOFF2 subsets (`400`, `500`, `600`) of `IBM Plex Sans` and `IBM Plex Mono` alongside `OFL.txt` with zero external CDN requests.
- **Do** pair every status color with an explicit symbol and text label (`✓ VERIFIED`, `✗ VIOLATED`, `! OUTDATED: ...`) and maintain `>= 4.5:1` text contrast and `>= 3:1` control border contrast in both Light and Dark themes.
- **Do** bind every displayed verdict, trace step, schematic readout, and assumption list strictly to its verified snapshot, clearly labeling pending unverified edits as `OUTDATED` or `UNVERIFIED DRAFT`.
- **Do** keep `snake_case` and `camelCase` identifiers intact inside action buttons and tables, using proper grid column tracks and scrollable `tabIndex={0}` regions rather than mid-word character breaks.

### Don't:
- **Don't** nest bordered cards inside cards, add decorative left-border accent stripes on rounded boxes, or use glowing shadows.
- **Don't** place tracked-out uppercase eyebrows above headings or wrap static subtitles in pill badges.
- **Don't** label an outdated replay snapshot as "Live" or conflate step-local invariant satisfaction (`Invariants hold at Step k`) with model-wide `VERIFIED` status.
- **Don't** hardcode verification telemetry, hide modeling assumptions or non-certification disclaimers, or use overclaim language (`100% secure`, `proven safe`, `certified safety software`).
