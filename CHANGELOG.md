# Changelog

All notable changes to RuleCanvasKit will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`@rulecanvas/ui` (`v0.2.0`)**:
  - Pure ES2022 shared UI foundation package (`packages/rulecanvas-ui`) depending solely on `@rulecanvas/core` with zero external npm runtime dependencies.
  - Deterministic AST expression, state value, domain, update, and rule formatters (`formatStateValue`, `formatVarDef`, `formatValueExpr`, `formatBoolExpr`, `formatUpdateAssignment`, `formatRuleSummary`) with exact minimal precedence parenthesization and `-0` normalization.
  - Immutable counterexample replay and manual step-simulation controller (`createTraceReplaySession`, `createVerdictReplaySession`, `createManualSimulationSession`, `stepReplayForward`, `stepReplayBackward`, `jumpReplayToStep`, `resetReplaySession`, `applyManualStep`) backed strictly by `@rulecanvas/core`.
  - Accessible, XSS-safe view models and semantic HTML renderers (`escapeHtml`, `buildVerdictSummaryView`, `renderVerdictSummaryHtml`, `buildStateTableView`, `renderStateTableHtml`, `buildInvariantsPanelView`, `renderInvariantsPanelHtml`, `renderReplayTimelineHtml`, `renderAssumptionsPanelHtml`, `renderValidationErrorsHtml`) with explicit vacuous-fix warnings (`VERIFIED (GOAL UNREACHABLE)`).
  - Unit, replay-parity, and XSS-safety test suites (`packages/rulecanvas-ui/tests/{format,replay-controller,components}.test.ts`), strict ES2022 UI typecheck in CI, and extended boundary enforcement in `packages/rulecanvas-core/tests/boundaries.test.ts`.
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
