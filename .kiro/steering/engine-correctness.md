---
inclusion: fileMatch
fileMatch: "packages/rulecanvas-core/**"
---

# Core Engine Correctness Invariants

## Total Validation & Safety Caps
- `validateModel`, `validateOptions`, `verifyModel`, and replay entry points accept `unknown` and MUST NEVER throw.
- Inspect own properties with `Object.getOwnPropertyDescriptor`, `Object.hasOwn`, `Map`, and `Set`; reject accessor properties (`INVALID_ACCESSOR_PROPERTY`) without invoking getters, and never read inherited fields such as `Object.prototype.goal`.
- Format untrusted values in validation messages without invoking user `.toString()`, `.valueOf()`, or `Symbol.toPrimitive` methods.
- Reject reserved prototype keys (`__proto__`, `constructor`, `prototype`) in schema variable names while allowing ordinary names such as `toString` or `hasOwnProperty`.
- Enforce structural caps: `1..64` schema vars, `1..256` enum values (unique non-empty strings `<= 128` chars), safe-integer `int` bounds with `BigInt(max) - BigInt(min) <= 1_000_000n`, `0..256` rules, `0..64` updates/rule, `1..64` invariants, `1..64` assumptions.
- Validate every expression with an un-deduplicated AST walk capping `depth <= 32` and `visits <= 256` (`AST_COMPLEXITY_EXCEEDED`).
- Enforce `INVALID_ENUM_LITERAL` whenever an enum variable is compared against or assigned a string literal not in its declared domain.

## Arithmetic & Transition Semantics
- Evaluate all integer arithmetic (`add`, `sub`) in both guards and updates with exact `bigint` arithmetic.
- Apply rule updates atomically against the pre-state tuple; normalize `-0` to `0`.
- Never clamp out-of-range integer assignments; emit `OUT_OF_DOMAIN_TRANSITION` and return `INVALID` immediately.
- Compute `theoreticalStates` with exact `BigInt` multiplication serialized as a decimal string.

## Exact Deterministic BFS Semantics
- Never include wall-clock fields (`elapsedMs`, `maxTimeMs`, `MAX_TIME`, `now`) in the engine contract or options.
- Check initial state `s0` invariants before limit checks; never set `goalReachable` if `s0` is already violating.
- Explore states with an explicit index-based FIFO queue (`head++`, never `Array.shift()`), evaluating rules in declaration order (`0..R-1`) and invariants in declaration order (`0..I-1`).
- On `VIOLATED`, return the shortest counterexample trace `s0 -> ... -> v` and set `goalReachable: true` ONLY if the goal was witnessed on a valid state strictly prior to `v`.
- On `MAX_DEPTH` or `MAX_STATES`, return `INCONCLUSIVE` with `completedDepth: d - 1` and `frontierRemaining: states.length - head`.
- Keep compiled internal representations unexported from `src/index.ts`.
