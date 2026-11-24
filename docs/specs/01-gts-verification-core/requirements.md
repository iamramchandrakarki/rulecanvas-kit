# Requirements: Guarded Transition System (GTS) Verification Core (`@rulecanvas/core`)

## Overview
`@rulecanvas/core` is a pure, deterministic ES2022 TypeScript verification engine for bounded-state Guarded Transition Systems (GTS). It validates declarative models, performs exact deterministic Breadth-First Search (BFS) reachability and safety invariant verification, and provides deterministic single-step and trace replay APIs.

---

## Functional Requirements (EARS Notation)

### REQ-1: Pure & Domain-Agnostic Runtime
1. **THE** `@rulecanvas/core` package **SHALL** have zero runtime `dependencies`, `peerDependencies`, or `optionalDependencies`.
2. **THE** `@rulecanvas/core` source tree (`packages/rulecanvas-core/src/**/*.ts`) **SHALL** compile cleanly under TypeScript with `"lib": ["ES2022"]`, `"types": []`, `"strict": true`, `"noUncheckedIndexedAccess": true`, and `"exactOptionalPropertyTypes": true`.
3. **THE** `@rulecanvas/core` source tree **SHALL NOT** import bare packages, `node:*` modules, or dynamic imports, and **SHALL NOT** reference host clocks, timers, randomness, `globalThis`, `eval`, `Function`, or domain-specific terminology.
4. **THE** `@rulecanvas/core` verification contract **SHALL** remain strictly deterministic without wall-clock fields (`elapsedMs`, `maxTimeMs`, `MAX_TIME`, `now`).

### REQ-2: Total Model & Options Validation
1. **WHEN** `validateModel(model)` is called with any `unknown` input, **THE** validator **SHALL** return a `readonly ValidationError[]` without throwing an exception.
2. **THE** validator **SHALL** require `model` to be a plain object with non-blank `id` and `name`, a `schema` plain object with `1 <= vars <= 64`, `0 <= rules.length <= 256`, `1 <= invariants.length <= 64`, `1 <= assumptions.length <= 64`, and an optional `goal`.
3. **THE** validator **SHALL** reject empty/blank variable names and reserved prototype keys (`__proto__`, `constructor`, `prototype`), while permitting ordinary property names such as `toString` or `hasOwnProperty`.
4. **WHEN** a variable has `kind: 'enum'`, **THE** validator **SHALL** require `1 <= values.length <= 256` unique non-empty strings each `<= 128` characters.
5. **WHEN** a variable has `kind: 'int'`, **THE** validator **SHALL** require safe integers `min` and `max` such that `min <= max` and `BigInt(max) - BigInt(min) <= 1_000_000n`.
6. **THE** validator **SHALL** require `initialState` to be a plain object with the exact same own keys as `schema` and every value within its declared variable domain.
7. **THE** validator **SHALL** validate each rule for unique non-blank `id`, non-blank `label`, valid boolean `guard`, `0 <= updates.length <= 64`, unique target `var` names per rule, matching scalar kinds, and valid enum literals (`INVALID_ENUM_LITERAL`).
8. **WHEN** validating any `BoolExpr` or `ValueExpr`, **THE** validator **SHALL** perform an un-deduplicated walk and fail immediately with `AST_COMPLEXITY_EXCEEDED` if `depth > 32` or `visits > 256`.
9. **WHEN** `validateOptions(options)` is called with any `unknown` input, **THE** validator **SHALL** require a plain object with safe integers `1 <= maxStates <= 100_000` and `0 <= maxDepth <= 10_000`, returning `INVALID_OPTIONS` errors otherwise without throwing.

### REQ-3: Exact Expression Evaluation & Atomic Updates
1. **THE** evaluator **SHALL** evaluate all integer `add` and `sub` operations in both guards and updates using exact `bigint` arithmetic.
2. **THE** evaluator **SHALL** normalize `-0` to `0` for all integer state values.
3. **WHEN** applying a rule's `updates`, **THE** evaluator **SHALL** evaluate every assignment RHS against the immutable pre-state and commit all updates atomically.
4. **IF** an evaluated integer assignment falls outside `[min, max]` (or an enum assignment falls outside the target enum domain), **THE** evaluator **SHALL NOT** clamp the value and **SHALL** emit an `OUT_OF_DOMAIN_TRANSITION` error identifying the variable, rule ID, and computed value.

### REQ-4: Exact Deterministic Ordered BFS Verification (`verifyModel`)
1. **IF** `validateModel(model)` or `validateOptions(options)` produces errors, **THE** verifier **SHALL** return `{ status: 'INVALID', errors }`.
2. **THE** verifier **SHALL** compute `stats.theoreticalStates` as the exact decimal string of the `BigInt` product of all variable domain cardinalities.
3. **THE** verifier **SHALL** evaluate all invariants in declaration order on the initial state `s0` before enforcing exploration bounds. **IF** any invariant fails on `s0`, **THE** verifier **SHALL** return `status: 'VIOLATED'` with `trace: []`, `statesExplored: 1`, `transitionsEvaluated: 0`, `maxDepthReached: 0`, `deadlockStatesFound: 0`, and **SHALL NOT** set `goalReachable`.
4. **WHILE** exploring reachable states in FIFO BFS order, **THE** verifier **SHALL** test rules in declaration order (`0..R-1`).
5. **IF** an enabled rule triggers `OUT_OF_DOMAIN_TRANSITION`, **THE** verifier **SHALL** immediately return `status: 'INVALID'` with the error, current `stats`, and the prefix `trace` reaching the failing pre-state.
6. **WHEN** a novel successor state at depth `d + 1` exceeds `maxDepth`, **THE** verifier **SHALL** return `status: 'INCONCLUSIVE'`, `reason: 'MAX_DEPTH'`, `completedDepth: d - 1`, `frontierRemaining: states.length - head`, current `stats`, and `goalReachable: true` only if the goal was previously witnessed.
7. **WHEN** admitting a novel successor state would exceed `maxStates` (`states.length >= maxStates`), **THE** verifier **SHALL** return `status: 'INCONCLUSIVE'`, `reason: 'MAX_STATES'`, `completedDepth: d - 1`, `frontierRemaining: states.length - head`, current `stats`, and `goalReachable: true` only if the goal was previously witnessed.
8. **WHEN** a novel valid successor `v` violates one or more invariants, **THE** verifier **SHALL** immediately return `status: 'VIOLATED'` with the shortest counterexample `trace` (`s0 -> ... -> v`), `terminalState`, `violatedInvariantIds` in declaration order, current `stats`, and `goalReachable: true` only if the goal was witnessed on a valid state strictly prior to `v`.
9. **WHEN** a state has zero enabled rules after full rule evaluation, **THE** verifier **SHALL** increment `deadlockStatesFound`.
10. **WHEN** the BFS queue drains without violation, invalid transition, or bound hit, **THE** verifier **SHALL** return `status: 'VERIFIED'`, exact `stats`, `goalReachable` (when `model.goal` is defined), and `assumptions`.

### REQ-5: Deterministic Replay APIs
1. **THE** engine **SHALL** export `getInitialState(model)`, `getEnabledTransitions(model, state)`, `stepModel(model, state, ruleId)`, and `replayTrace(model, ruleIds)`.
2. **THE** replay APIs **SHALL** reuse the exact same validator, compiler, and evaluator as `verifyModel`, returning structured typed errors (`UNKNOWN_RULE`, `RULE_DISABLED`, `OUT_OF_DOMAIN_TRANSITION`, or validation errors) without throwing.
