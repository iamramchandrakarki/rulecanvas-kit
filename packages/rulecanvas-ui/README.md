# @rulecanvas/ui

Framework-independent ES2022 presentation view models, safe HTML renderers, core-backed replay/simulation controller, deterministic verification reports, verdict delta analysis, diagnostic indexing, and strict integer draft parsing for RuleCanvasKit (`v0.8.0`).

## Purity & Dependency Contract

- **Sole dependency**: `@rulecanvas/core` (`workspace:*`) with zero external npm runtime dependencies.
- **Pure ES2022**: Compiles with `"lib": ["ES2022"]` and `"types": []`, with zero DOM globals, `node:*` imports, host clocks, randomness, or domain-specific terminology.
- **Untrusted-input safety**: Internal descriptor-safe readers (`safe-input.ts`, intentionally unexported) avoid ordinary own/inherited getters, reject symbol keys and reserved prototype names, fail closed to `INVALID` / `<invalid>` markup without fabricating healthy statuses, and escape HTML strings via `escapeHtml`.

## Package Exports (`"."`)

Built entry point: `./dist/index.js` (`./dist/index.d.ts`).

### Formatters (`format.ts`)

- Functions: `formatStateValue`, `formatVarDef`, `formatValueExpr`, `formatBoolExpr`, `formatUpdateAssignment`, `formatRuleSummary`
- Types: `FormattedRuleSummary`

### Replay & Manual Simulation Controller (`replay-controller.ts`)

- Functions: `createTraceReplaySession`, `createVerdictReplaySession`, `createManualSimulationSession`, `stepReplayForward`, `stepReplayBackward`, `jumpReplayToStep`, `resetReplaySession`, `applyManualStep`
- Types: `ReplayMode`, `ReplaySession`, `ReplaySessionInitResult`, `ReplayStepNavResult`, `ManualStepResult`, `VerdictReplayOptions`

### Diagnostics & Strict Integer Parsing (`diagnostics.ts`)

- Functions: `parseStrictIntegerDraft`, `indexModelDiagnostics`, `getErrorsForPathPrefix`
- Types: `DiagnosticSection`, `ModelDiagnosticsIndex`, `StrictIntegerParseResult`

### View Models & Accessible HTML Renderers (`components.ts`)

- Functions: `escapeHtml`, `buildVerdictSummaryView`, `renderVerdictSummaryHtml`, `buildStateTableView`, `renderStateTableHtml`, `buildInvariantsPanelView`, `renderInvariantsPanelHtml`, `renderReplayTimelineHtml`, `renderAssumptionsPanelHtml`, `renderValidationErrorsHtml`
- Types: `VerdictTone`, `VerdictStatItem`, `VerdictSummaryView`, `StateTableRowView`, `StateTableView`, `InvariantRowView`, `GoalPanelView`, `InvariantsPanelView`

### Deterministic Verification Reports (`report.ts`)

- Constants & Functions: `VERIFICATION_REPORT_SCHEMA_VERSION`, `buildVerificationReportFromSnapshot`, `verifyAndBuildReport`, `formatVerificationReportMarkdown`, `serializeVerificationReportJson`, `sanitizeReportFilename`, `isTrustedVerificationReport`
- Types: `VerificationReport`, `VerificationReportProvenance`, `VerificationReportGoalStatus`, `VerificationReportModelSummary`, `VerificationReportGoalRef`, `VerificationReportInvariantRef`, `VerificationReportTraceDiff`, `VerificationReportTraceStep`, `VerificationReportInconclusive`, `ReportBuildResult`
- Distinguishes `'validated-snapshot'` reports (restating a structurally validated snapshot; trace replay checks `VIOLATED` and runtime `INVALID` prefix consistency without independently re-running exhaustive search) from `'recomputed-core'` reports (produced directly by `@rulecanvas/core` `verifyModel`), encodes `theoreticalStates` as decimal strings (`bigIntEncoding: 'decimal-string'`), and flags unreachable goals with `vacuousGoalWarning`.

### Verdict Delta Analysis (`delta.ts`)

- Functions: `computeVerdictDelta`
- Types: `VerdictDelta`, `VerdictDeltaResult`, `VerdictDeltaClassification`, `VerdictDeltaChangedSection`, `VerdictDeltaEndpoint`
- Compares two non-stale snapshots (`repaired`, `verified-with-spec-change`, `vacuous-lockout`, `inconclusive-after-violation`, `still-violated`, `regression`, `unchanged`, `other`) while separating rule edits from spec/bound changes.

## Quick Start

```ts
import { verifyModel } from '@rulecanvas/core';
import {
  createVerdictReplaySession,
  indexModelDiagnostics,
  parseStrictIntegerDraft,
  renderVerdictSummaryHtml,
} from '@rulecanvas/ui';

const parsed = parseStrictIntegerDraft('42'); // { ok: true, value: 42 }
const verdict = verifyModel(model, { maxStates: 1_000, maxDepth: 20 });
const html = renderVerdictSummaryHtml(verdict);
const session = createVerdictReplaySession(model, verdict, { startAt: 'terminal' });
const diagnostics = indexModelDiagnostics(verdict.status === 'INVALID' ? verdict.errors : []);
```

## Limitations

- Does not bundle CSS, DOM event wiring, or React components (see `@rulecanvas/workbench-react` and `apps/*` for interactive browser workbenches).
- Replay sessions enforce `MAX_REPLAY_STEPS = 10_000`, `MAX_SAFE_ARRAY_LENGTH = 100_000`, and bounded AST formatting (`MAX_FORMAT_DEPTH = 64`, `MAX_FORMAT_VISITS = 512`).
- While descriptor inspection avoids ordinary getters, exotic JavaScript `Proxy` traps can still execute or throw; public entrypoints catch thrown trap exceptions and fail closed.
