# RuleCanvasKit Architecture

This document describes the technical architecture of `@rulecanvas/core` (`packages/rulecanvas-core`), `@rulecanvas/ui` (`packages/rulecanvas-ui`), `@rulecanvas/workbench` (`packages/rulecanvas-workbench`), `@rulecanvas/workbench-react` (`packages/rulecanvas-workbench-react`), and the dependency boundaries across the RuleCanvasKit monorepo.

## Workspace Layering

```text
packages/rulecanvas-core   (@rulecanvas/core — zero runtime dependencies, pure ES2022)
   ^                ^
   |                +---- packages/rulecanvas-workbench        (@rulecanvas/workbench — core only, pure ES2022)
   |                |                ^
   +---- packages/rulecanvas-ui (@rulecanvas/ui — core only, pure ES2022)
                    ^                |
                    +----------------+---- packages/rulecanvas-workbench-react (@rulecanvas/workbench-react — React 19 peer)
                                                   ^
                                                   +---- apps/agent-gate     (@rulecanvas/agent-gate)
                                                   +---- apps/interlock-sim  (@rulecanvas/interlock-sim)
```

- `packages/rulecanvas-core` contains only domain-agnostic formal model validation, compilation, BFS exploration, and deterministic trace replay.
- `packages/rulecanvas-ui` contains domain-agnostic AST expression/rule formatters, an immutable counterexample replay and manual step-simulation controller backed by `@rulecanvas/core`, accessible XSS-safe view models and semantic HTML renderers, and strict integer draft / null-prototype diagnostic indexing helpers.
- `packages/rulecanvas-workbench` contains framework-independent verification worker/main-thread transport (`@rulecanvas/workbench/verify`, `@rulecanvas/workbench/verify-worker`) with detached capture/deep-freeze sanitization, plus a strict portable model JSON codec (`@rulecanvas/workbench/model-json`).
- `packages/rulecanvas-workbench-react` provides reusable React 19 workbench controls (`StrictIntegerInput`, `useIntegerDraftStore`, `useVerificationSnapshot`, `VerdictSummary`, `AssumptionsList`, `WorkbenchNavigation`, race-safe preset URL routing via `createWorkbenchHistoryController` / `useWorkbenchRoute`, and SSR-safe theme/shell primitives via `useWorkbenchTheme`, `WorkbenchThemeSwitch`, `WorkbenchBrandMark`, and `WorkbenchDiscardDialog`).
- `apps/*` packages define domain-specific schemas, rules, invariants, goals, assumptions, visual styling (aligned with `DESIGN.md` and self-hosted IBM Plex Sans / IBM Plex Mono WOFF2 fonts), and scenario tests.
- Every workspace library is strictly acyclic and enforces explicit dependency allowlists: no library may import from `apps/*`, `apps/*` may never import from each other, and `packages/rulecanvas-core`, `packages/rulecanvas-ui`, and `packages/rulecanvas-workbench` never import `node:*`, third-party npm packages, or host-coupled globals (`Date`, `performance`, `setTimeout`, `setInterval`, `Math.random`, `eval`, `Function`). These rules are enforced automatically by `packages/rulecanvas-core/tests/boundaries.test.ts`.

## Core Module Layout

`packages/rulecanvas-core/src/` has six ES2022 modules with unidirectional imports:

```text
types.ts  <--  validate.ts  <--  eval.ts  <--  verify.ts
                                          <--  replay.ts
index.ts  -->  public exports from types.ts, validate.ts, verify.ts, replay.ts
```

Internal compilation and evaluation helpers in `eval.ts` are intentionally unexported from `src/index.ts`.

## State Schema and Validation Caps

`validateModel(model: unknown)` and `validateOptions(options: unknown)` are total functions: they inspect arbitrary untrusted inputs and return structured `ValidationError[]` without throwing.

### Structural and AST Caps

| Constraint | Bound | Error Code |
| --- | --- | --- |
| Schema variables | `1..64` | `SCHEMA_EMPTY`, `SCHEMA_TOO_LARGE` |
| Enum values per variable | `1..256`, unique, `1..128` chars | `INVALID_ENUM_VALUES`, `INVALID_ENUM_VALUE`, `DUPLICATE_ENUM_VALUE` |
| Integer variable bounds | Safe integers, `min <= max`, `BigInt(max) - BigInt(min) <= 1_000_000n` | `INVALID_INT_BOUNDS`, `INT_SPAN_TOO_LARGE` |
| Rules | `0..256` | `TOO_MANY_RULES` |
| Updates per rule | `0..64`, unique target vars | `TOO_MANY_UPDATES`, `DUPLICATE_UPDATE_VAR` |
| Invariants | `1..64` | `INVALID_INVARIANTS_COUNT` |
| Assumptions | `1..64` | `INVALID_ASSUMPTIONS_COUNT` |
| Boolean `and`/`or` arguments | `1..64` | `INVALID_EXPR_ARGS` |
| `in` literal list length | `0..256` | `INVALID_IN_VALUES` |
| Expression AST traversal | `depth <= 32`, `visits <= 256` (un-deduplicated) | `AST_COMPLEXITY_EXCEEDED` |
| `VerifyOptions.maxStates` | Safe integer in `[1, 100_000]` | `INVALID_OPTIONS` |
| `VerifyOptions.maxDepth` | Safe integer in `[0, 10_000]` | `INVALID_OPTIONS` |

### Prototype, Accessor, and Coercion Hardening

- **Plain-object enforcement**: Objects must have prototype `Object.prototype` or `null`.
- **Own data properties only**: Validation captures a single `Reflect.ownKeys` snapshot per inspected object or array, rejecting own symbol properties (`INVALID_SYMBOL_PROPERTY`) and rejecting own getter/setter accessors (`INVALID_ACCESSOR_PROPERTY`) across string and symbol keys via `Object.getOwnPropertyDescriptor` without invoking accessor functions, while `schema` and state snapshots enforce exact enumerable own-key membership.
- **No inherited property leakage**: Optional fields such as `model.goal` are checked with `Object.hasOwn` / own descriptors so properties defined on `Object.prototype` never affect validation, verification, or replay.
- **Reserved variable names**: `__proto__`, `constructor`, and `prototype` are rejected as schema variable names (`RESERVED_VAR_NAME`), while ordinary names such as `toString` and `hasOwnProperty` remain supported via `Map` lookups and `Object.defineProperty` snapshot materialization.
- **Safe message formatting**: Unknown values interpolated into error messages are formatted by `typeof` without calling user `.toString()`, `.valueOf()`, or `Symbol.toPrimitive`.
- **Exotic trap containment and immutable diagnostics**: Top-level entry points (`validateModel`, `validateOptions`, `verifyModel`, `getInitialState`, `getEnabledTransitions`, `stepModel`, `replayTrace`) catch exotic `Proxy` trap exceptions and return fresh, frozen `ValidationError` diagnostics (`UNEXPECTED_INPUT_ERROR`) so caller mutation cannot leak across calls.

## Dense Numeric Tuple Encoding

After validation succeeds, `compileModel` lowers the model into dense index-addressed structures:

- Variables are assigned indices `0..N-1` in `Object.keys(model.schema)` declaration order.
- Each state is encoded as `readonly number[]`:
  - `boolean`: `0` (`false`) or `1` (`true`)
  - `enum`: `0..K-1` index into the variable's value array
  - `int`: normalized safe integer (`-0` normalized to `0`)
- Canonical visited keys are computed as `tuple.join(',')`. Because every slot holds an integer, comma-separated joining is strictly injective even when enum value strings themselves contain commas, colons, or delimiters.
- `stats.theoreticalStates` is computed with exact `BigInt` multiplication across all variable domain sizes and serialized as a decimal string.

## Exact `bigint` Evaluation and Atomic Pre-State Updates

- Integer expressions (`lit`, `var`, `add`, `sub`) and integer comparisons (`eq`, `neq`, `lt`, `lte`, `gt`, `gte`, `in`) evaluate in exact `bigint` arithmetic, preventing IEEE-754 precision loss near `Number.MAX_SAFE_INTEGER`.
- Enum comparisons (`eq`, `neq`, `in`) compare enum string values rather than variable-local indices, keeping comparisons sound across distinct enum variables.
- `applyRule(rule, preTuple)` evaluates every update RHS against the immutable `preTuple` before writing any slot of the next tuple. Simultaneous swaps (such as `x := y; y := x`) execute atomically.
- Out-of-domain updates are never clamped: an integer result outside `[min, max]` or an enum result outside the target enum domain returns `{ ok: false, error: { code: 'OUT_OF_DOMAIN_TRANSITION', ... } }`.

## Deterministic BFS Semantics

`verifyModel(model, options)` executes an index-based FIFO Breadth-First Search (`head += 1`, avoiding `Array.shift()`):

1. **Initial state check**: All invariants are evaluated on `s0` in declaration order before limit checks. If `s0` violates any invariant, `verifyModel` returns `VIOLATED` with `trace: []`, `statesExplored: 1`, `transitionsEvaluated: 0`, `maxDepthReached: 0`, `deadlockStatesFound: 0`, and omits `goalReachable`.
2. **Rule order**: For each dequeued state `u` at depth `d`, rules are tested in declaration order `0..R-1`.
3. **Out-of-domain precedence**: Enabled rules are applied before visited deduplication and before `maxDepth` / `maxStates` checks. An `OUT_OF_DOMAIN_TRANSITION` returns `INVALID` immediately with the current stats and the shortest trace to `u`.
4. **Truncation check before admission**: For each novel successor `v` (not yet in `visited`), if `d + 1 > maxDepth` (`MAX_DEPTH`) or `states.length >= maxStates` (`MAX_STATES`), `verifyModel` returns `INCONCLUSIVE` with:
   - `completedDepth: d - 1` (the deepest depth layer completely expanded prior to truncation)
   - `frontierRemaining: states.length - head` (the number of queued states not yet completely expanded, including `u`)
   - `goalReachable: true` only if the goal was witnessed on an already-admitted valid state
5. **Check-on-admission**: Each admitted novel state `v` is checked against all invariants in declaration order immediately. On the first violation, `verifyModel` reconstructs the shortest trace `s0 -> ... -> v` via parent pointers and returns `VIOLATED`. `goalReachable: true` is included only if the goal was witnessed on a valid state strictly prior to `v`.
6. **Goal tracking and deadlocks**: If `v` satisfies all invariants and `compiled.goal !== null`, `goalWitnessed` is updated when `goal.reached` holds on `v`. If a state `u` has zero enabled rules, `deadlockStatesFound` is incremented.
7. **Exhaustive completion**: When the queue drains (`head === states.length`), `verifyModel` returns `VERIFIED`, including `goalReachable: goalWitnessed` if and only if `compiled.goal !== null`.

## Replay Contract

`packages/rulecanvas-core/src/replay.ts` exposes four deterministic execution functions backed by the same validator, compiler, and evaluator:

- `getInitialState(model)`: Validates `model` and returns the normalized initial `StateSnapshot`.
- `getEnabledTransitions(model, state)`: Validates `model` and `state`, then evaluates every rule guard in declaration order.
- `stepModel(model, state, ruleId)`: Validates `model` and `state`, checks that `ruleId` exists (`UNKNOWN_RULE`) and is enabled (`RULE_DISABLED`), applies updates atomically (`OUT_OF_DOMAIN_TRANSITION` if out of bounds), and returns a `TraceStep` with `stateBefore`, `stateAfter`, and `changedVars`.
- `replayTrace(model, ruleIds)`: Executes a sequence of rule IDs starting from `initialState`, stopping on the first error with `stepIndex` and prefix `steps`, or returning `steps`, `finalState`, `violatedInvariantIds`, and optional `goalReached`.

## Shared UI Foundation (`packages/rulecanvas-ui`)

`packages/rulecanvas-ui/src/` compiles under strict ES2022 (`"lib": ["ES2022"]`, `"types": []`) and contains five modules with unidirectional imports (`safe-input.ts` remains internal and unexported from `src/index.ts`):

```text
safe-input.ts         (internal descriptor-safe readers and deep freezing)
format.ts             (deterministic ValueExpr, BoolExpr, VarDef, update, and rule formatters)
replay-controller.ts  (immutable ReplaySession state, trace replay, manual stepping via @rulecanvas/core)
components.ts         (XSS-safe escapeHtml, view-model builders, and accessible semantic HTML renderers)
index.ts              (re-exports public modules from format.ts, replay-controller.ts, and components.ts while keeping safe-input.ts internal)
```

- All execution semantics in `replay-controller.ts` delegate directly to `@rulecanvas/core` (`validateModel`, `getInitialState`, `getEnabledTransitions`, `stepModel`, `replayTrace`), avoiding duplicated validation or evaluation logic.
- All replay session outputs (including canonical model, snapshots, and trace steps) and error payloads are deeply frozen, total on untrusted `unknown` inputs, enforce replay consistency between `currentState` and trace history, and reject out-of-range or non-safe-integer step indices with `INVALID_STEP_INDEX`.
- Every HTML renderer escapes all interpolated strings via `escapeHtml`, inspects untrusted payloads strictly via own data descriptors, pairs status badges/symbols with `data-status` attributes rather than relying on color alone, and explicitly flags vacuous fixes (`VERIFIED (GOAL UNREACHABLE)`).
- `diagnostics.ts` exports `parseStrictIntegerDraft`, `indexModelDiagnostics` (null-prototype diagnostic map), and `getErrorsForPathPrefix` for strict form validation without prototype pollution.

## Framework-Independent Workbench Transport & Codec (`packages/rulecanvas-workbench`)

`@rulecanvas/workbench` compiles under strict ES2022 (`"lib": ["ES2022"]`, `"types": []`) and exposes three explicit subpath entry points:

- `@rulecanvas/workbench/verify`: `createVerifyClient({ execution })` supporting `main-thread`, `app-worker`, and `injected-worker` execution policies (`asyncStartupError: 'report' | 'fallback'`), monotonic request-ID superseding, optional worker restart on supersede, `createLegacyWorkerAdapter`, `isFactoryVerifyClient`, and `isWebWorkerSupported`. All requests undergo descriptor-safe detached capture before execution, and all `VerifyResult` responses are sanitized against the `@rulecanvas/core` schema and deeply frozen before delivery.
- `@rulecanvas/workbench/verify-worker`: `VERIFY_PROTOCOL_VERSION` and `installVerifyWorker(port)` against a structural message port with zero DOM globals at import time.
- `@rulecanvas/workbench/model-json`: `createModelJsonCodec(limits?)` with `DEFAULT_MODEL_JSON_LIMITS` (512,000 UTF-16 code units / 10,000 nodes / structural depth 64 / raw container nesting 256) and `HARD_CEILING_MODEL_JSON_LIMITS` (2,000,000 UTF-16 code units / 50,000 nodes / structural depth 64 / raw container nesting 256). Performs pre-parse duplicate decoded key detection, RFC 8259 numeric literal scanning, recursive reserved-key/accessor/cycle/non-enumerable rejection, value-occurrence visit budgeting, and full `@rulecanvas/core` validation.

## React 19 Workbench Adapters (`packages/rulecanvas-workbench-react`)

`@rulecanvas/workbench-react` declares `react` (`^19.0.0`) strictly as a peer dependency (zero `react-dom` runtime dependency) and exports:

- `StrictIntegerInput`, `useIntegerDraftStore`, `matchesDraftPrefix` for controlled integer draft editing with immediate `aria-invalid` and inline error reporting.
- `useVerificationSnapshot` for stale-free reactive subscription to `@rulecanvas/workbench/verify` clients.
- `VerdictSummary` and `AssumptionsList` for accessible status badges and model assumption disclosure.
- `WorkbenchNavigation` and `isSafeSameOriginNavigationHref` for reciprocal same-origin navigation between RuleCanvasKit workbenches.
- `createWorkbenchHistoryController`, `useWorkbenchRoute`, `readPresetFromSearch`, and `buildCanonicalPresetUrl` for preset URL query routing (`?preset=...`) with race-safe dirty-editor discard confirmation (`Navigation API traverseTo` when available, with synchronous fresh-session `history.replaceState` recovery fallback).
- `useWorkbenchTheme`, `resolveWorkbenchTheme`, `applyDocumentTheme`, `readStoredThemePreference`, `writeStoredThemePreference`, `isThemePreference`, `WORKBENCH_THEME_STORAGE_KEY`, `WorkbenchThemeSwitch`, `WorkbenchBrandMark`, and `WorkbenchDiscardDialog` for SSR-safe persistent theme switching (`system` / `light` / `dark` with Light fallback), brand mark rendering, and accessible discard-confirmation dialogs.
- `WorkbenchSelect` (with pure keyboard helpers `stepEnabledIndex`, `edgeEnabledIndex`, `resolveTypeahead`) for an APG select-only combobox whose listbox renders in the browser top layer, and `useWorkbenchTooltips` for viewport-clamped, Escape-dismissible decorative tooltips. Styling lives in each app's byte-identical `src/styles/controls.css`; the package ships no CSS.

## Packaging and End-to-End Verification Gates

- `pnpm verify:exports`: Verifies all four library packages and six public ESM entry points import cleanly in pure Node.js without DOM globals.
- `pnpm verify:pack`: Builds map-free package archives (`build:pack`), checks archive allowlists (`dist/`, `README.md`, `LICENSE`), zero `.map` / `sourceMappingURL` / `src/` / `tests/` leakage, rewritten `workspace:*` ranges, installs packed tarballs offline with a frozen fixture lockfile into an isolated temporary consumer with a minimal third-application model, and validates pure Node ESM execution, strict `tsc --noEmit` (`skipLibCheck: false`) under both `NodeNext` and `Bundler`, and Vite subpath bundling.
- `pnpm test:browser`: Serves both production builds under same-origin subpaths (`/suite/agent-gate/` and `/suite/interlock-sim/`). Playwright checks keyboard focus, reduced-motion navigation, snapshot provenance, self-hosted font loading with zero external network requests, and layout across `360–1440` CSS pixels. Axe checks WCAG A/AA rules in both Light and Dark themes across the audited states. When `BOOKING_FIXTURE_DIST` points to the packed consumer build, the suite also verifies that its module worker returns a verdict under `/booking-demo/`.


The workbench apps publish separate static build directories. To check the packaged consumer with the browser suite locally, use the same scratch output path for both commands:

```bash
BOOKING_FIXTURE_DIST=/tmp/rulecanvas-booking-demo pnpm verify:pack
BOOKING_FIXTURE_DIST=/tmp/rulecanvas-booking-demo pnpm test:browser
```

Each successful CI build retains a checksummed archive for each app. To roll an app back, restore that app's last green archive to its existing static entry path and retain the counterpart's deployment. For a source rollback, revert the affected app's adoption and any app-specific follow-up changes, then build both apps and run their production smoke tests. The release tags identify immutable baselines.
