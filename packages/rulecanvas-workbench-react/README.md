# @rulecanvas/workbench-react

Reusable React 19 workbench controls, lifted integer draft store, snapshot-bound verification hook, verdict/assumption presentation components, accessible cross-workbench navigation, and race-safe preset URL routing for RuleCanvasKit (`v0.7.0`, `"private": true`).

## Dependency & Peer Contract

- **Workspace dependencies**: `@rulecanvas/core`, `@rulecanvas/ui`, and `@rulecanvas/workbench` (`workspace:*`).
- **React 19 peer dependency**: Declares `react` (`^19.0.0`) strictly under `peerDependencies` with zero `react-dom` runtime dependency.
- **SSR-safe**: Public hooks and components import cleanly in plain Node.js without `window` or `document` globals.

## Package Exports (`"."`)

Built entry point: `./dist/index.js` (`./dist/index.d.ts`).

### Integer Draft Editing

- `StrictIntegerInput`, `type StrictIntegerInputProps`
- `useIntegerDraftStore`, `matchesDraftPrefix`, `type LiftedIntDraftStore`, `type UseIntegerDraftStoreOptions`

### Snapshot-Bound Verification

- `useVerificationSnapshot`, `type CommittedVerificationSnapshot`, `type UseVerificationSnapshotOptions`, `type VerificationRunRequest`, `type VerificationSnapshotController`

### Accessible Verdict & Assumption Presentation

- `VerdictSummary`, `type VerdictSummaryProps`
- `AssumptionsList`, `type AssumptionsListProps`, `type AssumptionsScope`

### Cross-Workbench Navigation

- `WorkbenchNavigation`, `isSafeSameOriginNavigationHref`, `type WorkbenchNavLink`, `type WorkbenchNavigationProps`

### Race-Safe Preset URL Routing

- `useWorkbenchRoute`, `createWorkbenchHistoryController`, `readPresetFromSearch`, `buildCanonicalPresetUrl`
- Types: `HistoryHostLike`, `HistoryStamp`, `NavigationApiLike`, `NavigationEntryLike`, `PendingDiscardPrompt`, `UseWorkbenchRouteOptions`, `WorkbenchHistoryController`, `WorkbenchHistoryControllerOptions`

### SSR-Safe Theme & Shell Primitives

- Theme hooks & helpers: `useWorkbenchTheme`, `resolveWorkbenchTheme`, `applyDocumentTheme`, `readStoredThemePreference`, `writeStoredThemePreference`, `isThemePreference`, `WORKBENCH_THEME_STORAGE_KEY`
- Theme types: `ResolvedTheme`, `ThemePreference`, `ThemeStorageLike`, `UseWorkbenchThemeOptions`, `WorkbenchThemeController`
- Shell components: `WorkbenchThemeSwitch`, `WorkbenchBrandMark`, `WorkbenchDiscardDialog`, `VerificationBoundsControl`, `WorkbenchGuideControl`
- Shell types: `WorkbenchThemeSwitchProps`, `WorkbenchBrandMarkProps`, `WorkbenchDiscardDialogProps`, `VerificationBoundsControlProps`, `WorkbenchGuideControlProps`, `WorkbenchGuideGlossaryItem`

### Selection & Tooltips
- `WorkbenchSelect` (props `WorkbenchSelectProps`, items `WorkbenchSelectOption` / `WorkbenchSelectOptionGroup`): WAI-ARIA select-only combobox. Pair the trigger `id` with a `<label for>` as you would a native select. The listbox renders with `popover="manual"` in the top layer, so scrolling panes never clip it. Keyboard: arrows, `Home` / `End`, `PageUp` / `PageDown`, `Enter` / `Space`, `Tab`, `Escape`, and native-style type-ahead.
- Pure keyboard helpers: `stepEnabledIndex`, `edgeEnabledIndex`, `resolveTypeahead`, `isTypeaheadKey`, `isTypeaheadActive`, `EMPTY_TYPEAHEAD`, `SELECT_PAGE_SIZE`, `SELECT_TYPEAHEAD_TIMEOUT_MS`.
- `useWorkbenchTooltips`, `placeWorkbenchTooltip`, `WORKBENCH_TOOLTIP_HOST_ATTRIBUTE` and `WORKBENCH_TOOLTIP_DISMISSED_ATTRIBUTE`: keep `aria-hidden` hover/focus tooltips inside the viewport (horizontal clamp, flip above when needed) and make them dismissible with `Escape`. `WorkbenchThemeSwitch` and `WorkbenchGuideControl` accept `tooltipClassName` to use them instead of `title`.
- The package ships no CSS. The components emit stable `rc-select-*` and `rc-tip` class names; both workbench apps style them in `src/styles/controls.css`.

## Quick Start

```tsx
import {
  AssumptionsList,
  StrictIntegerInput,
  VerdictSummary,
  WorkbenchNavigation,
  useVerificationSnapshot,
} from '@rulecanvas/workbench-react';
import { createVerifyClient } from '@rulecanvas/workbench/verify';
```

- `useVerificationSnapshot` tracks monotonic run requests, invalidates stale results (`OUTDATED:`), and keeps the verified snapshot's `assumptions` separate from unverified pending edits (`AssumptionsList`).
- `WorkbenchNavigation` validates links with `isSafeSameOriginNavigationHref(href, allowedPrefix)` so only safe same-origin targets render active navigation links.
- `useWorkbenchRoute` / `createWorkbenchHistoryController` binds `?preset=...` transitions to dirty-state checks (`shouldPromptDiscard`), supporting `Navigation API traverseTo` when available and a synchronous `history.replaceState` fallback when absent.

## Limitations

- Marked `"private": true` for workspace use and verified via local tarball packing (`pnpm verify:pack`), not published to npm.
- Does not ship CSS stylesheets; consuming apps provide visual tokens, layout CSS, and domain-specific editors/schematics.
- Requires React `^19.0.0` in the host application.
