# Contributing to RuleCanvasKit

Thank you for your interest in contributing to RuleCanvasKit. This guide covers local setup, workflow conventions, verification requirements, and architectural invariants across the four shared libraries and two domain applications.

## Prerequisites

- Node.js `^22.12.0 || ^24.0.0 || >=26.0.0` (Node 24 LTS recommended; CI runs Node 24)
- `pnpm` (`12.21.0`, matching `packageManager` in `package.json`)

Install dependencies and build all libraries and applications:

```bash
pnpm install
pnpm build
```

## Development Workflow

1. Create a focused feature or fix branch from `main`.
2. Write clear, small commits following [Conventional Commits](https://www.conventionalcommits.org/) (for example: `feat(core): ...`, `fix(workbench): ...`, `test(ui): ...`, `docs: ...`, `ci: ...`).
3. Add unit, regression, or property-based tests for every behavior change or bug fix.
4. Ensure no `.skip`, `.only`, `.todo`, `xit`, `xdescribe`, `fit`, `fdescribe`, `xtest`, `ftest`, `skipIf`, `runIf`, or empty pending test bodies remain in test files (`pnpm verify:hygiene`).

## Local Verification Commands

Run the complete local verification suite before opening or updating a pull request:

```bash
# Build all 4 libraries and both Vite workbench apps
pnpm build

# Typecheck workspace and strict library configurations
pnpm typecheck
pnpm --filter @rulecanvas/core exec tsc --noEmit -p tsconfig.json
pnpm --filter @rulecanvas/ui exec tsc --noEmit -p tsconfig.json
pnpm --filter @rulecanvas/workbench exec tsc --noEmit -p tsconfig.json
pnpm --filter @rulecanvas/workbench-react exec tsc --noEmit -p tsconfig.json

# Verify all 6 library export entry points and SSR-safe app module imports
pnpm verify:exports

# Pack map-free tarballs, check positive allowlists, and test offline third-app consumption
pnpm verify:pack

# Run unit, property, replay, workbench, and scenario tests
pnpm test
FC_SEED=918273645 pnpm --filter @rulecanvas/core exec vitest run tests/properties.test.ts

# Verify architecture, DAG layering, and anti-skip test hygiene
pnpm verify:boundaries
pnpm verify:hygiene

# Run deterministic benchmarks
pnpm bench
```

When Playwright and Chromium are installed locally, also run the browser regression suite (optionally sharing `BOOKING_FIXTURE_DIST` with `pnpm verify:pack`):

```bash
BOOKING_FIXTURE_DIST=/tmp/rulecanvas-booking-demo pnpm verify:pack
BOOKING_FIXTURE_DIST=/tmp/rulecanvas-booking-demo pnpm test:browser
```

## Workspace Layering & Packaging Invariants

Changes across `packages/*` and `apps/*` must preserve the following invariants enforced by `packages/rulecanvas-core/tests/boundaries.test.ts` and `scripts/verify-pack.mjs`:

- **Acyclic 4-library DAG**:
  - `@rulecanvas/core`: zero runtime, `peerDependencies`, or `optionalDependencies`.
  - `@rulecanvas/ui`: depends solely on `@rulecanvas/core` (`workspace:*`).
  - `@rulecanvas/workbench`: depends solely on `@rulecanvas/core` (`workspace:*`).
  - `@rulecanvas/workbench-react`: depends only on `@rulecanvas/core`, `@rulecanvas/ui`, and `@rulecanvas/workbench` (`workspace:*`), with `react` (`^19.0.0`) strictly in `peerDependencies` and zero `react-dom` runtime dependency.
  - `apps/agent-gate` and `apps/interlock-sim`: may depend on workspace libraries, never on each other; libraries may never import from `apps/*` or deep internal paths outside declared `exports`.
- **Pure ES2022 compilation & determinism (`core`, `ui`, `workbench`)**: Source files under `packages/rulecanvas-core/src/`, `packages/rulecanvas-ui/src/`, and `packages/rulecanvas-workbench/src/` must compile under `"lib": ["ES2022"]` and `"types": []` using explicit `.js` relative import specifiers, without `node:*`, third-party npm packages, dynamic `import()`, or host-coupled globals (`Date`, `performance`, `setTimeout`, `setInterval`, `Math.random`, `eval`, `Function`).
- **Domain neutrality**: Keep `packages/*` free of domain-specific scenario logic or terminology (`agent-gate`, `interlock-sim`, airlock, approval laundering). Domain models belong under `apps/*`.
- **Archive hygiene**: Each library's `build:pack` / `prepack` script must emit map-free `dist/**/*.{js,d.ts,d.mts}` artifacts matching the positive tarball allowlist (`package.json`, `README.md`, `LICENSE`, `dist/**`) with rewritten `workspace:*` dependencies.

## Core Engine Invariants

Changes under `packages/rulecanvas-core/` must preserve the following engine semantics:

- **Total validation**: Public entry points accept `unknown` inputs, reject own accessor properties, symbol properties, and reserved prototype keys (`__proto__`, `constructor`, `prototype`) safely, avoid user coercion methods on untrusted values, and return structured errors rather than throwing uncaught exceptions.
- **Exact arithmetic and BFS semantics**: Preserve `bigint` integer evaluation, `-0` normalization, atomic pre-state updates, `OUT_OF_DOMAIN_TRANSITION` rejection without clamping, shortest counterexample ordering, and exact `INCONCLUSIVE` truncation metadata (`completedDepth`, `frontierRemaining`).

## Workspace Configuration (`.kiro/`)

This repository tracks `.kiro/` configuration files (`.kiro/hooks/`, `.kiro/specs/README.md`, and `.kiro/steering/`) to keep workspace steering rules and verification hooks versioned in git.

- Do not add `.kiro/` to `.gitignore`.
- Do not fabricate spec execution history or pre-checked task lists under `.kiro/specs/`.
- Keep architectural documentation under `docs/`.
