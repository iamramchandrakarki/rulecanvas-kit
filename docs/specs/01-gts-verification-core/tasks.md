# Implementation Tasks: Guarded Transition System (GTS) Verification Core (`@rulecanvas/core`)

Engineering task checklist for specification `01-gts-verification-core`, corresponding to [`requirements.md`](./requirements.md) and [`design.md`](./design.md).

## 1. Workspace & Package Configuration

- [x] Initialize repository metadata and workspace tooling (`LICENSE`, `.gitignore`, `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.config.ts`).
- [x] Configure `@rulecanvas/core` (`packages/rulecanvas-core/package.json`, `tsconfig.json`, `tsconfig.test.json`) with zero runtime dependencies, `"lib": ["ES2022"]`, `"types": []`, strict TypeScript settings, and `NodeNext` ESM output.
- [x] Track Kiro workspace steering rules, verification hook, and `.kiro/specs/README.md` under `.kiro/`.

## 2. `@rulecanvas/core` Pure ES2022 Modules

- [x] Implement immutable public TypeScript data contracts in `packages/rulecanvas-core/src/types.ts`.
- [x] Implement total structural, schema, domain, enum-literal, and un-deduplicated AST complexity validation (`validateModel`, `validateOptions`, internal `validateStateSnapshot`) in `packages/rulecanvas-core/src/validate.ts`.
- [x] Implement internal dense-tuple model compilation, exact `bigint` integer evaluation, `-0` normalization, atomic pre-state updates, and strict `OUT_OF_DOMAIN_TRANSITION` rejection in `packages/rulecanvas-core/src/eval.ts`.
- [x] Implement deterministic index-based FIFO BFS verification (`verifyModel`) with shortest counterexample reconstruction, `goalReachable` soundness, deadlock counting, and exact `INCONCLUSIVE` truncation metadata in `packages/rulecanvas-core/src/verify.ts`.
- [x] Implement deterministic execution and replay APIs (`getInitialState`, `getEnabledTransitions`, `stepModel`, `replayTrace`) in `packages/rulecanvas-core/src/replay.ts`.
- [x] Export only the public API surface from `packages/rulecanvas-core/src/index.ts` while keeping compiled internal structures unexported.

## 3. Input Totality & Prototype-Isolation Hardening

- [x] Inspect untrusted objects and arrays via `readOwnDataProperty` (`Object.getOwnPropertyDescriptor`), reject getter/setter accessors (`INVALID_ACCESSOR_PROPERTY`), own symbol properties (`INVALID_SYMBOL_PROPERTY`), sparse arrays (`INVALID_SPARSE_ARRAY`), and non-plain prototypes without invoking getters or iterators.
- [x] Enforce single-pass parse-don't-validate snapshot isolation (`parseModel`, `parseOptions`, `parseStateSnapshot`, `parseRuleIds`) so compilation, verification, and replay operate exclusively on freshly parsed snapshots using indexed loops immune to TOCTOU and `Symbol.iterator` tampering.
- [x] Format unknown values in validation messages safely via `formatUnknownForMessage` without calling user `.toString()`, `.valueOf()`, or `Symbol.toPrimitive`.
- [x] Guard optional `goal` presence with `Object.hasOwn(model, 'goal')` across validation, compilation, verification, and replay to prevent inherited `Object.prototype.goal` leakage.
- [x] Reject reserved prototype keys (`__proto__`, `constructor`, `prototype`), support ordinary property names via `Map` and `Object.defineProperty`, and wrap all public entry points in defensive `try/catch` guards returning `UNEXPECTED_INPUT_ERROR` on exotic `Proxy` traps.

## 4. Verification & Test Suites

- [x] Add comprehensive unit, edge-case, hardening, and regression tests in `packages/rulecanvas-core/tests/verify.test.ts`.
- [x] Add 6-stratum `fast-check` differential property-based oracle tests with deterministic `FC_SEED` support in `packages/rulecanvas-core/tests/properties.test.ts`.
- [x] Add automated package-boundary, zero-dependency, ES2022 purity, and domain-neutrality checks in `packages/rulecanvas-core/tests/boundaries.test.ts`.
- [x] Add third-domain generality verification tests in `packages/rulecanvas-core/tests/third-domain.test.ts`.

## 5. Reference Domain Packages & Deterministic Benchmarks

- [x] Implement `@rulecanvas/agent-gate` (`apps/agent-gate`) approval-laundering scenario family (broken, naive patch A, naive patch B, principled fix, vacuous fix) and scenario test suite.
- [x] Implement `@rulecanvas/interlock-sim` (`apps/interlock-sim`) educational BSL-3 airlock scenario family (broken, fixed, vacuous fix) and scenario test suite.
- [x] Implement deterministic benchmark harness (`packages/rulecanvas-core/bench/run-bench.ts`) covering all flagship scenarios and synthetic 4K / 20K / 25K-cap counter grids.

## 6. CI Pipeline & Open-Source Documentation

- [x] Configure GitHub Actions CI (`.github/workflows/ci.yml`) covering build, workspace and strict ES2022 typecheck, full test suite, seeded PBT, boundary checks, anti-skip hygiene, `.kiro/` tracking verification, and benchmarks.
- [x] Publish repository documentation and templates (`README.md`, `docs/ARCHITECTURE.md`, `docs/TOOL_ATTRIBUTION.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CHANGELOG.md`, `.github/ISSUE_TEMPLATE/*`, `.github/PULL_REQUEST_TEMPLATE.md`).
