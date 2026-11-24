# Design: Guarded Transition System (GTS) Verification Core (`@rulecanvas/core`)

## Module Decomposition

`packages/rulecanvas-core/src/` is structured into six focused ES2022 modules with strict unidirectional dependencies:

```
types.ts  <──  validate.ts  <──  eval.ts  <──  verify.ts
                                          <──  replay.ts
index.ts  ──>  re-exports public API from types, validate, verify, replay
```

- **`src/types.ts`**: Public immutable TypeScript data contracts for schemas, expressions, rules, invariants, goals, assumptions, options, verification results, validation errors, and replay results. Zero runtime code.
- **`src/validate.ts`**: Total structural and static type validation (`validateModel`, `validateOptions`, and internal `validateStateSnapshot`). Performs prototype-safe own-property checks (`Object.hasOwn`, `Map`, `Set`), domain checks, enum literal membership checks, and un-deduplicated AST complexity/cycle guarding (`depth <= 32`, `visits <= 256`).
- **`src/eval.ts`** *(internal — not exported from `index.ts`)*: Compiles a validated `TransitionSystemModel` into dense index-based representations:
  - Schema variables ordered by `Object.keys(schema)` into dense indices `0..N-1`.
  - State tuples encoded as `readonly number[]`: `boolean -> 0 | 1`, `enum -> 0..K-1`, `int -> safe number` with `-0` normalized to `0`.
  - Canonical state keys computed as `tuple.join(',')`, which is injective because every tuple slot holds only integer values (`0/1`, `0..K-1`, or safe integers).
  - Exact `bigint` evaluation for integer `ValueExpr` nodes (`lit`, `var`, `add`, `sub`), preventing IEEE-754 precision loss during intermediate arithmetic.
  - String-value comparison for enum equality (`eq`, `neq`, `in`) so two distinct enum variables with different value orderings compare semantically by value rather than by per-variable index.
  - Atomic rule application (`applyRule`) evaluating all assignment RHS expressions against the immutable pre-state before checking domain bounds and producing a new tuple.
  - Prototype-safe `toSnapshot` construction using `Object.defineProperty` on plain objects so ordinary variable names like `toString` or `hasOwnProperty` behave safely and match standard object equality.
- **`src/verify.ts`**: Exact deterministic ordered BFS (`verifyModel`).
  - Parallel array queue (`states`, `parentState`, `parentRule`, `depths`) indexed by monotonic `head` pointer (O(1) dequeue; avoids `Array.shift()`).
  - `visited: Map<string, number>` keyed by canonical tuple key.
  - Shortest counterexample reconstruction via parent pointer backtracking (`s0 -> ... -> target`).
  - Exact `changedVars` computation in schema declaration order where `after[i] !== before[i]`.
- **`src/replay.ts`**: Interactive/stepwise execution (`getInitialState`, `getEnabledTransitions`, `stepModel`, `replayTrace`) backed by `validateModel`, `validateStateSnapshot`, and `eval.ts`.
- **`src/index.ts`**: Public barrel exporting only public types and functions (`validateModel`, `validateOptions`, `verifyModel`, `getInitialState`, `getEnabledTransitions`, `stepModel`, `replayTrace`).

## Determinism & Soundness Guarantees
1. **No host side effects or clocks**: Identical `(model, options)` inputs always produce bit-for-bit identical results across machines and runs.
2. **Shortest counterexample**: Because BFS explores states in non-decreasing depth order and checks invariants immediately upon admitting each novel state `v` at `d + 1`, the first violation found is guaranteed to have minimal transition length, and tie-breaking is deterministic by `(parent BFS discovery order, rule declaration order)`.
3. **No false `goalReachable` witnesses**: `s0` is verified against invariants before checking `goal`, and every novel state `v` is checked against invariants before updating `goalWitnessed`.
4. **No silent overflow or clamping**: Integer expressions use `bigint` and range checks compare against `BigInt(min)` and `BigInt(max)` before converting back to `Number`.
