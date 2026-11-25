# Changelog

All notable changes to RuleCanvasKit will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

- Upcoming `v0.3.0` AgentGate workbench changes will be tracked here.

## [0.2.0] - 2026-11-25

> **Release status: Prepared** — Ready for maintainer tagging and release publication (`v0.2.0`); [`v0.1.0`](https://github.com/iamramchandrakarki/rulecanvas-kit/releases/tag/v0.1.0) is released. See [docs/releases/v0.2.0.md](./docs/releases/v0.2.0.md) for full release notes.

### Added

- **Project Strategy & Approved Vision (`STRATEGY.md`)**:
  - Recorded the author-approved Vision (`2026-11-24`) defining RuleCanvasKit's permanent product principles: exact deterministic verification, honest verdicts (`VERIFIED`, `VIOLATED`, `INCONCLUSIVE`, `INVALID`) and vacuous-fix detection, pure ES2022 core and domain-neutral UI layering, untrusted-input safety by construction, guarded optional extensions, and explicit modeling assumptions.
- **`@rulecanvas/ui` (`packages/rulecanvas-ui`)**:
  - Pure ES2022 shared UI foundation package (`"lib": ["ES2022"]`, `"types": []`) depending solely on `@rulecanvas/core` (`workspace:*`) with zero external npm runtime dependencies.
  - Deterministic expression, value, domain, update, and rule formatters (`formatStateValue`, `formatVarDef`, `formatValueExpr`, `formatBoolExpr`, `formatUpdateAssignment`, `formatRuleSummary`) featuring unambiguous backtick quoting for reserved keywords and non-identifier variable names, JSON-quoted enum members, `-0` normalization, minimal precedence parenthesization, and bounded AST traversal.
  - Core-backed immutable counterexample replay and manual step-simulation controller (`createTraceReplaySession`, `createVerdictReplaySession`, `createManualSimulationSession`, `stepReplayForward`, `stepReplayBackward`, `jumpReplayToStep`, `resetReplaySession`, `applyManualStep`) delegating execution to `@rulecanvas/core` (`validateModel`, `getInitialState`, `getEnabledTransitions`, `stepModel`, `replayTrace`), validating `VIOLATED`/`VERIFIED`/`INCONCLUSIVE`/`INVALID` verdicts against the model (`VERDICT_MODEL_MISMATCH`), supporting `startAt: 'initial' | 'terminal'`, rejecting out-of-range or non-safe-integer cursors (`INVALID_STEP_INDEX`), and handling step-back history branching.
  - Accessible, XSS-safe view models and semantic HTML renderers (`escapeHtml`, `buildVerdictSummaryView`, `renderVerdictSummaryHtml`, `buildStateTableView`, `renderStateTableHtml`, `buildInvariantsPanelView`, `renderInvariantsPanelHtml`, `renderReplayTimelineHtml`, `renderAssumptionsPanelHtml`, `renderValidationErrorsHtml`) with ARIA roles and live regions, `aria-current="step"`, semantic table headers, explicit status badges/symbols (never color alone), and explicit vacuous-fix warnings (`VERIFIED (GOAL UNREACHABLE)` and `data-vacuous-goal="true"`).
  - Untrusted-input and security hardening via internal `safe-input.ts` own-descriptor checks without invoking getters, symbol/sparse/accessor array rejection, inherited `Object.prototype` pollution defense, malformed expression/schema/violation invalidation (alert state without fabricating `PASS` or `REACHED`), and full HTML content/attribute escaping.
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

[Unreleased]: https://github.com/iamramchandrakarki/rulecanvas-kit/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/iamramchandrakarki/rulecanvas-kit/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/iamramchandrakarki/rulecanvas-kit/releases/tag/v0.1.0
