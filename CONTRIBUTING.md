# Contributing to RuleCanvasKit

Thank you for your interest in contributing to RuleCanvasKit. This guide covers local setup, workflow conventions, verification requirements, and architectural invariants.

## Prerequisites

- Node.js `^22.12.0 || ^24.0.0 || >=26.0.0` (Node 24 LTS recommended; CI runs Node 24)
- `pnpm` (`12.x`, matching `packageManager` in `package.json`)

Install dependencies and build the core package:

```bash
pnpm install
pnpm build
```

## Development Workflow

1. Create a focused feature or fix branch from `main`.
2. Write clear, small commits following [Conventional Commits](https://www.conventionalcommits.org/) (for example: `feat(core): ...`, `fix(core): ...`, `test(core): ...`, `docs: ...`, `ci: ...`).
3. Add unit, regression, or property-based tests for every behavior change or bug fix.
4. Ensure no `.skip`, `.only`, `.todo`, `xit`, `xdescribe`, `fit`, or `fdescribe` calls remain in test files.

## Local Verification Commands

Run the complete local verification suite before opening or updating a pull request:

```bash
pnpm build
pnpm typecheck
pnpm --filter @rulecanvas/core exec tsc --noEmit -p tsconfig.json
pnpm test
pnpm verify:boundaries
FC_SEED=918273645 pnpm --filter @rulecanvas/core exec vitest run tests/properties.test.ts
pnpm bench
```

## Core Engine Invariants

Changes under `packages/rulecanvas-core/` must preserve the following invariants:

- **Zero runtime dependencies**: `packages/rulecanvas-core/package.json` must have no runtime `dependencies`, `peerDependencies`, or `optionalDependencies`.
- **Pure ES2022 compilation**: `packages/rulecanvas-core/src/**/*.ts` must compile with `"lib": ["ES2022"]` and `"types": []`, using explicit `.js` relative import specifiers.
- **Strict determinism**: Do not introduce wall-clock timing, randomness, or host-coupled APIs (`Date`, `performance`, `setTimeout`, `setInterval`, `Math.random`, `globalThis`, `eval`, `Function`).
- **Domain neutrality**: Keep `packages/rulecanvas-core/src/` free of domain-specific scenario logic or terminology. Domain models belong under `apps/*`.
- **Total validation**: Public entry points accept `unknown` inputs, reject accessor properties and reserved prototype keys safely, avoid user coercion methods on untrusted values, and return structured errors rather than throwing uncaught exceptions.
- **Exact arithmetic and BFS semantics**: Preserve `bigint` integer evaluation, atomic pre-state updates, `OUT_OF_DOMAIN_TRANSITION` rejection without clamping, shortest counterexample ordering, and exact `INCONCLUSIVE` truncation metadata.

## Workspace Configuration (`.kiro/`)

This repository tracks `.kiro/` configuration files (`.kiro/hooks/`, `.kiro/specs/README.md`, and `.kiro/steering/`) to keep workspace steering rules and verification hooks versioned in git.

- Do not add `.kiro/` to `.gitignore`.
- Do not fabricate spec execution history or pre-checked task lists under `.kiro/specs/`.
- Keep architectural documentation under `docs/`.
