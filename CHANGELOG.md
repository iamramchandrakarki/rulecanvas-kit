# Changelog

All notable changes to RuleCanvasKit will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- A shared workbench shell, persistent System, Light, and Dark themes, and self-hosted IBM Plex fonts for AgentGate and InterlockSim.
- A three-pane AgentGate workspace with a persistent rule navigator, focused guard and update editor, and tabbed verification inspector.
- An InterlockSim workspace that pairs the discrete airlock schematic and operator console with tabbed trace, state, and guard inspection.
- Browser screenshots and illustrative walkthroughs for both workbenches.

### Fixed

- Stale replay steps display the verified snapshot guard and identify actions that open the current draft. Trace-to-editor jumps move focus, respect reduced motion, and preserve numeric guard drafts.
- Discard dialogs contain keyboard focus in both directions. Dark-theme destructive actions retain readable text on hover.
- Custom InterlockSim readouts scope goal and invariant evaluations to the displayed step. The sensor readouts fill each row at narrow and wide widths.

## [0.5.0] - 2026-11-26

See [docs/releases/workbench-integration.md](./docs/releases/workbench-integration.md) and the [`v0.5.0`](https://github.com/iamramchandrakarki/rulecanvas-kit/releases/tag/v0.5.0) GitHub Release for full release notes and live deployment links.

### Added

- **`@rulecanvas/workbench` (`v0.5.0`, private) (`packages/rulecanvas-workbench`)**:
  - Framework-independent verification transport (`@rulecanvas/workbench/verify`, `@rulecanvas/workbench/verify-worker`) featuring `VERIFY_PROTOCOL_VERSION = 1`, frozen factory clients backed by `WeakSet` provenance (`createVerifyClient`, `isFactoryVerifyClient`), `createLegacyWorkerAdapter`, early `(requestId, generation)` correlation, descriptor-safe detached capture (`captureVerificationRequest`), schema-checked deep-frozen results (`sanitizeAndFreezeVerifyResult`), and worker installation with zero DOM globals at import time (`installVerifyWorker`).
  - Strict portable JSON codec (`@rulecanvas/workbench/model-json`) with `createModelJsonCodec`, `DEFAULT_MODEL_JSON_LIMITS` (512,000 UTF-16 code units, 10,000 nodes, depth 64, raw container nesting 256), `HARD_CEILING_MODEL_JSON_LIMITS` (2,000,000 UTF-16 code units, 50,000 nodes, depth 64, raw container nesting 256), pre-parse duplicate decoded key scanning (`duplicateKeys: 'reject' | 'last-value'`), RFC 8259 integer checking, and `@rulecanvas/core` validation.
- **`@rulecanvas/workbench-react` (`v0.5.0`, private) (`packages/rulecanvas-workbench-react`)**:
  - React 19 peer-only adapters (`StrictIntegerInput`, `useIntegerDraftStore`, `matchesDraftPrefix`, `useVerificationSnapshot`, `VerdictSummary`, `AssumptionsList`) eliminating duplicated verification-state and integer-draft plumbing across workbenches.
  - Reciprocal same-origin workbench navigation (`WorkbenchNavigation`, `isSafeSameOriginNavigationHref` with segment-boundary `allowedPrefix` checks) and race-safe `?preset=...` URL routing (`createWorkbenchHistoryController`, `useWorkbenchRoute`, `readPresetFromSearch`, `buildCanonicalPresetUrl`) using Navigation API `traverseTo` with a synchronous `history.replaceState` recovery fallback.
- **Packaging, Export, and Browser Regression Gates**:
  - `pnpm verify:exports` (`scripts/verify-exports.mjs`) validating all 4 library packages, 6 public ESM entry points, and plain Node/`tsx` SSR imports of both `apps/*/src/App.tsx` modules without DOM globals.
  - `pnpm verify:pack` (`scripts/verify-pack.mjs`) verifying map-free `build:pack` tarballs against a positive archive allowlist (`package.json`, `README.md`, `LICENSE`, `dist/**/*.{js,d.ts,d.mts}`), rewritten `workspace:*` dependencies, offline pinned installation into an isolated third-app booking consumer, strict `tsc --noEmit` (`NodeNext` and `Bundler`), and Vite subpath (`/booking-demo/`) worker bundling.
  - `pnpm test:browser` runs both production workbenches and the packed booking worker in Chromium. It checks domain replay, keyboard operation, WCAG A/AA axe rules, and responsive layout down to 375 CSS pixels.
- **Documentation**:
  - Updated `README.md`, `CONTRIBUTING.md`, `docs/ARCHITECTURE.md`, and all four package `README.md` files with exact package exports, integrated workbench workflows, limitations, and build/pack/browser verification commands; added an honest Devpost Skeleton Crew draft, live deployment links, and sub-three-minute demo script in [docs/SKELETON_CREW_SUBMISSION.md](./docs/SKELETON_CREW_SUBMISSION.md).
- **Release Artifact Preflight (`.kiro/specs/release-artifact-preflight/`)**:
  - Added `pnpm verify:release:preflight` (`scripts/release-preflight.mjs`, `scripts/release-preflight-archive.py`, `scripts/release-preflight-browser.mjs`) and 25 regression tests (`pnpm test:release:preflight`, `tests/release-preflight.test.mjs`) to validate `SHA256SUMS.txt`, bounded tar/gzip safety, and Chromium `Background Web Worker` execution under `/` and `/rulecanvas-kit/` before atomic output publication.

### Changed

- **`@rulecanvas/ui` (`packages/rulecanvas-ui`)**:
  - Extracted `parseStrictIntegerDraft`, `indexModelDiagnostics` (null-prototype diagnostic map), and `getErrorsForPathPrefix` into `packages/rulecanvas-ui/src/diagnostics.ts`.
- **`apps/agent-gate` & `apps/interlock-sim`**:
  - Migrated both workbenches onto `@rulecanvas/workbench` and `@rulecanvas/workbench-react`, adding reciprocal `WorkbenchNavigation` (with SSR-safe `VITE_INTERLOCK_SIM_URL` / `VITE_AGENT_GATE_URL` env reads), `?preset=...` URL routing, dirty-editor and comparison-panel preset discard confirmations with focus restoration, and 512k strict export with legacy duplicate-key import compatibility (plus InterlockSim's clean 0-invariant draft export exception and AgentGate's clipboard-fallback dirty reset).
- **Boundaries & CI (`.github/workflows/ci.yml`, `packages/rulecanvas-core/tests/boundaries.test.ts`)**:
  - Extended AST boundary and manifest DAG checks across all four libraries and both apps, and updated CI with strict per-library `tsc --noEmit`, `pnpm verify:exports`, `pnpm verify:pack`, `pnpm test:browser`, and commit-scoped `SHA256SUMS.txt` archive/screenshot artifacts.

### Fixed

- Legacy browser worker adapters now preserve caller request IDs while exchanging valid versioned envelopes. Result validation rejects inconsistent depth and goal metadata.
- Preset routing preserves drafts during fragment visits, distinguishes browser history from previous document loads, and dismisses stale prompts when the routing controller is replaced.
- Cross-workbench links share the same URL validation as preset history controls. A confirmed switch supersedes pending history restoration.
- Both workbenches mark out-of-range verification fields as invalid for assistive technology. The verification client returns core option diagnostics before dispatch.
- AgentGate applies its JSON export size limit to invalid drafts.
- Both workbenches expose keyboard-focusable scroll regions and support Escape on discard prompts. Narrow layouts keep controls and long diagnostics within the viewport.
- `scripts/verify-pack.mjs` now packs `vite`, `typescript`, and their transitive consumer dependencies as local tarballs so offline third-app verification succeeds on cold pnpm metadata caches.

## [0.4.0] - 2026-11-25

See [docs/releases/v0.4.0.md](./docs/releases/v0.4.0.md) for usage, verification limits, and the release checks.

### Added

- InterlockSim browser workbench with an accessible airlock schematic, operator console, and three presets for comparing a violation, a repair, and a lockout that makes the model's goal unreachable.
- Shortest counterexample replay, enabled-action simulation, predicate-level guard explanations, a rule inspector, and a guided repair for the built-in broken preset.
- Bounded verification in a Web Worker with a main-thread fallback. Results are tied to the model snapshot, bounds, and assumptions used at the time of verification.
- Strict JSON import and export with integer and structural validation, plus ten workbench tests that bring the workspace suite to 131 tests.

### Changed

- CI now builds the InterlockSim production bundle in addition to the AgentGate bundle and shared packages.

## [0.3.0] - 2026-11-25

See [docs/releases/v0.3.0.md](./docs/releases/v0.3.0.md) and the [`v0.3.0`](https://github.com/iamramchandrakarki/rulecanvas-kit/releases/tag/v0.3.0) GitHub Release for full release notes.

### Added

- **`@rulecanvas/agent-gate` (`v0.3.0`) Interactive Policy & Verification Workbench (`apps/agent-gate`)**:
  - Structured policy and schema editor (`PolicyEditorPane`, `ExprEditor`, `StrictIntegerInput`) supporting schema variable CRUD (`boolean`, `enum`, `int`), collision-free numeric-key variable renames that preserve visual order while rewriting rules/invariants/goal references, transition rule and atomic-update editing, quick-append guard clause helpers with pre-wrap draft pruning, invariant and declared goal editing, and explicit modeling assumptions (`ModelAssumption[]`).
  - Portable JSON import/export hardening (`exportModelToJson`, `importModelFromJson`, `validateImportedModelValue`) featuring raw RFC 8259 number pre-validation before `JSON.parse` (rejecting non-integer decimals/exponents and out-of-range integers before IEEE-754 rounding loss), own-descriptor/symbol/reserved-key inspection, `MAX_IMPORT_DEPTH = 64` supporting core-valid 32-level ASTs, and graceful `JSON_EXPORT_ERROR` UI handling so over-budget models remain repairable.
  - Deterministic non-blocking Web Worker verification client (`VerifyWorkerClient`, `verify.worker.ts`) with monotonic run-ID tracking, automatic cancellation on policy/bound edits, automatic synchronous main-thread fallback when Web Workers are unavailable, and snapshot-bound `OUTDATED:` assumption disclosure isolating verified assumptions from unverified pending edits.
  - Integrated `@rulecanvas/ui` counterexample replay, manual transition stepping, history branching, and state-diff inspection (`VerificationWorkbenchPane`), plus a reactive 5-preset approval-laundering comparison matrix (`Broken Policy`, `Naive Patch A`, `Naive Patch B`, `Vacuous Fix`, `Principled Fix`).
  - Accessible navigation and styling (`tokens.css`, `workbench.css`) with roving keyboard tab focus, bidirectional `<label for>` associations across all form controls, `role="tabpanel"` synchronization, WCAG 2.2 `>= 3:1` unfocused control border contrast, inline SVG favicon, and responsive desktop/tablet/mobile layouts.
  - 22 automated workbench tests (`apps/agent-gate/tests/workbench.test.ts`), bringing the workspace suite to 121 passing tests across 10 files while preserving all prior `@rulecanvas/agent-gate` exports and the 6 baseline `approval-laundering.test.ts` checks.

### Changed

- **CI & Workspace Checks**:
  - Added `@rulecanvas/agent-gate` Vite production build verification (`pnpm --filter @rulecanvas/agent-gate build`) to `.github/workflows/ci.yml`, added `"version": "0.3.0"` to `apps/agent-gate/package.json`, and updated `README.md` with workbench usage and build instructions.

## [0.2.0] - 2026-11-25

See [docs/releases/v0.2.0.md](./docs/releases/v0.2.0.md) and the [`v0.2.0`](https://github.com/iamramchandrakarki/rulecanvas-kit/releases/tag/v0.2.0) GitHub Release for full release notes.

### Added

- **Project Strategy & Approved Vision (`STRATEGY.md`)**:
  - Recorded the author-approved Vision (`2026-11-24`) defining RuleCanvasKit's permanent product principles: exact deterministic verification, honest verdicts (`VERIFIED`, `VIOLATED`, `INCONCLUSIVE`, `INVALID`) and vacuous-fix detection, pure ES2022 core and domain-neutral UI layering, untrusted-input safety by construction, guarded optional extensions, and explicit modeling assumptions.
- **`@rulecanvas/ui` (`packages/rulecanvas-ui`)**:
  - Pure ES2022 shared UI foundation package (`"lib": ["ES2022"]`, `"types": []`) depending solely on `@rulecanvas/core` (`workspace:*`) with zero external npm runtime dependencies.
  - Deterministic expression, value, domain, update, and rule formatters (`formatStateValue`, `formatVarDef`, `formatValueExpr`, `formatBoolExpr`, `formatUpdateAssignment`, `formatRuleSummary`) featuring unambiguous backtick quoting for reserved keywords and non-identifier variable names, JSON-quoted enum members, `-0` normalization, minimal precedence parenthesization, and bounded AST traversal.
  - Core-backed immutable counterexample replay and manual step-simulation controller (`createTraceReplaySession`, `createVerdictReplaySession`, `createManualSimulationSession`, `stepReplayForward`, `stepReplayBackward`, `jumpReplayToStep`, `resetReplaySession`, `applyManualStep`) delegating execution to `@rulecanvas/core` (`validateModel`, `getInitialState`, `getEnabledTransitions`, `stepModel`, `replayTrace`), validating `VIOLATED`/`VERIFIED`/`INCONCLUSIVE`/`INVALID` verdicts against the model (`VERDICT_MODEL_MISMATCH`), supporting `startAt: 'initial' | 'terminal'`, rejecting out-of-range or non-safe-integer cursors (`INVALID_STEP_INDEX`), and handling step-back history branching.
  - Accessible, XSS-safe view models and semantic HTML renderers (`escapeHtml`, `buildVerdictSummaryView`, `renderVerdictSummaryHtml`, `buildStateTableView`, `renderStateTableHtml`, `buildInvariantsPanelView`, `renderInvariantsPanelHtml`, `renderReplayTimelineHtml`, `renderAssumptionsPanelHtml`, `renderValidationErrorsHtml`) with ARIA roles and live regions, `aria-current="step"`, semantic table headers, explicit status badges/symbols (never color alone), and explicit vacuous-fix warnings (`VERIFIED (GOAL UNREACHABLE)` and `data-vacuous-goal="true"`).
  - Untrusted-input and security hardening via internal `safe-input.ts` own-descriptor inspection (avoiding ordinary own and inherited property getters while catching thrown `Proxy` trap exceptions in public entrypoints), symbol-key rejection on snapshots, model schemas, and core `validateModel` checks, sparse/accessor/out-of-bounds array rejection, inherited `Object.prototype` pollution defense, fail-closed invalidation (`INVALID`/alert markup or `<invalid>`/empty-row fallbacks without fabricating `PASS`, `REACHED`, or `Unchanged`), and full HTML content/attribute escaping.
- **UI Regression Tests & Release Documentation**:
  - 47 `@rulecanvas/ui` unit, replay-parity, security, and XSS-safety tests (`packages/rulecanvas-ui/tests/{format,replay-controller,components}.test.ts`), bringing the workspace total to 99 passing tests across 9 files.
  - Release notes in [docs/releases/v0.2.0.md](./docs/releases/v0.2.0.md).

### Changed

- **Architecture Boundary & CI Enforcement**:
  - Extended `packages/rulecanvas-core/tests/boundaries.test.ts` with 4 `@rulecanvas/ui` AST boundary checks enforcing sole `@rulecanvas/core` dependency, banning `node:*`, `apps/*`, dynamic `import()`, external bare specifiers, non-deterministic/host-coupled globals, and domain terminology leaks (9 boundary checks total).
  - Added strict ES2022 `@rulecanvas/ui` typecheck (`pnpm --filter @rulecanvas/ui exec tsc --noEmit -p tsconfig.json`) to `.github/workflows/ci.yml` and updated `package.json`, `README.md`, `docs/ARCHITECTURE.md`, `docs/TOOL_ATTRIBUTION.md`, and `.kiro/` workspace configuration.

## [0.1.0] - 2026-11-25

### Added

- **`@rulecanvas/core` (`v0.1.0`)**:
  - Pure ES2022, zero-dependency Guarded Transition System (GTS) verification engine (`validateModel`, `validateOptions`, `verifyModel`, `getInitialState`, `getEnabledTransitions`, `stepModel`, `replayTrace`).
  - Dense numeric tuple encoding, exact `bigint` integer evaluation, atomic pre-state updates, `-0` normalization, and strict `OUT_OF_DOMAIN_TRANSITION` rejection without clamping.
  - Deterministic index-based BFS verifier returning `VERIFIED`, `VIOLATED` (shortest counterexample), `INCONCLUSIVE` (`MAX_STATES` / `MAX_DEPTH` with `completedDepth` and `frontierRemaining`), or `INVALID`.
  - Input hardening against accessor properties (`INVALID_ACCESSOR_PROPERTY`), uncoercible objects in validation messages, inherited `Object.prototype.goal`, reserved prototype keys, shared-reference AST DAG bombs, and hostile `Proxy` traps (`UNEXPECTED_INPUT_ERROR`).
- **Verification & Test Suites**:
  - Unit, edge-case, and regression test suite (`packages/rulecanvas-core/tests/verify.test.ts`).
  - Six-stratum `fast-check` property-based differential oracle test suite (`packages/rulecanvas-core/tests/properties.test.ts`) with `FC_SEED` reproducibility.
  - Architecture and boundary enforcement suite (`packages/rulecanvas-core/tests/boundaries.test.ts`).
  - Domain-generality third-domain test (`packages/rulecanvas-core/tests/third-domain.test.ts`).
- **Reference Domain Applications**:
  - `@rulecanvas/agent-gate`: Synthetic approval-laundering scenario family (broken, naive patch A, naive patch B, principled fix, vacuous fix) and tests.
  - `@rulecanvas/interlock-sim`: Educational BSL-3 airlock scenario family (broken, fixed, vacuous fix) and tests.
- **Benchmarks, CI, and Documentation**:
  - Deterministic benchmark suite (`packages/rulecanvas-core/bench/run-bench.ts`) covering all flagship scenarios and synthetic 4K / 20K / 25K-cap counter grids.
  - GitHub Actions CI workflow (`.github/workflows/ci.yml`) running build, strict ES2022 typecheck, tests, seeded PBT, boundary checks, anti-skip hygiene, tracked workspace config verification, and benchmarks.
  - Open-source documentation and repository templates (`README.md`, `docs/ARCHITECTURE.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CHANGELOG.md`, GitHub issue and pull request templates).

[Unreleased]: https://github.com/iamramchandrakarki/rulecanvas-kit/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/iamramchandrakarki/rulecanvas-kit/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/iamramchandrakarki/rulecanvas-kit/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/iamramchandrakarki/rulecanvas-kit/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/iamramchandrakarki/rulecanvas-kit/releases/tag/v0.1.0
