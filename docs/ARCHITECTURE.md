# RuleCanvasKit Architecture

This document describes the technical architecture of `@rulecanvas/core` (`packages/rulecanvas-core`) and the dependency boundaries across the RuleCanvasKit monorepo.

## Workspace Layering

```text
packages/rulecanvas-core   (@rulecanvas/core — zero runtime dependencies, pure ES2022)
        ^
        | workspace:*
        +---- apps/agent-gate     (@rulecanvas/agent-gate)
        +---- apps/interlock-sim  (@rulecanvas/interlock-sim)
```

- `packages/rulecanvas-core` contains only domain-agnostic formal model validation, compilation, BFS exploration, and deterministic trace replay.
- `apps/*` packages define domain-specific schemas, rules, invariants, goals, assumptions, and scenario tests.
- `packages/rulecanvas-core` must never import from `apps/*`, `node:*`, bare npm packages, or host-coupled APIs (`Date`, `performance`, `setTimeout`, `setInterval`, `Math.random`, `globalThis`, `eval`, `Function`). These rules are enforced automatically by `packages/rulecanvas-core/tests/boundaries.test.ts`.

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
