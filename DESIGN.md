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

- **Unified Top Command Shell:** Single sticky top bar containing the geometric `RuleCanvasKit` mark, active workbench switcher (`AgentGate` / `InterlockSim`), active scenario preset selector, `maxStates` and `maxDepth` inputs, live verification status indicator, primary `Verify` / `Cancel` button, preset comparison toggle, and `System / Light / Dark` theme control.
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
- **Browser Surfaces:** Scrollbars (`scrollbar-color`), text selection (`::selection`), carets (`caret-color`), and `:focus-visible` rings (`2px solid var(--color-focus)` with `2px` offset) are themed directly from semantic tokens in both Light and Dark modes.

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
- **Focus & Error:** `2px solid var(--color-focus)` outline on `:focus-visible`; `aria-invalid="true"` switches border to `--color-error` and binds inline `role="alert"` recovery copy via `aria-describedby`.
- **Numeric Bounds & AST Literals:** Always rendered as `type="text" inputMode="numeric"` in `IBM Plex Mono` (`tabular-nums`), preserving raw drafts across tab switches without browser spinner coercion.

### Navigation & Workspace Tabs
- **Suite Switcher (`WorkbenchNavigation`):** Top-bar links with `aria-current="page"` indicator and race-safe unsaved-edits guard.
- **Section & Inspection Tabs:** WAI-ARIA `role="tablist"` with roving `tabIndex`, `ArrowLeft` / `ArrowRight` / `Home` / `End` keyboard support, `2px` active indicator bar, and mounted `[hidden]` inactive panels to preserve uncommitted drafts.

### Signature Components
- **Master-Detail Rule & Proposition Inspector (`AgentGate`):** Pairs a compact rule index (annotated with counterexample step markers when a violation trace is active) with a mathematical `when <guard> / then <updates>` summary strip and inline recursive AST clause editors.
- **Synchronized Containment Schematic (`InterlockSim`):** Renders outer corridor, airlock chamber, doors, differential pressure, UV-C lamp, occupancy, HEPA purge counter, and maintenance override directly from the replay session state, with explicit snapshot provenance (`Snapshot: ...`, `OUTDATED` warning when edits are pending, and step-scoped invariant labels).

### Motion
- **Purposeful Transitions:** Restrict transitions to `120ms`–`180ms` using `--ease-out: cubic-bezier(0.22, 1, 0.36, 1)` on `opacity`, `transform`, `background-color`, and `border-color`.
- **Reduced Motion:** `@media (prefers-reduced-motion: reduce)` disables all non-essential transitions and animations immediately.

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
