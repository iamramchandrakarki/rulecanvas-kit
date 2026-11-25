# @rulecanvas/core

Pure ES2022 finite-state transition system model checker, bounded BFS verifier, deterministic evaluator, and trace replay engine for RuleCanvasKit (`v0.1.0`).

## Purity & Dependency Contract

- **Zero runtime dependencies**: `dependencies`, `peerDependencies`, and `optionalDependencies` are empty.
- **Pure ES2022**: Compiles with `"lib": ["ES2022"]` and `"types": []` and uses zero host-coupled globals (`Date`, `performance`, `setTimeout`, `setInterval`, `Math.random`, `eval`, `Function`), `node:*` built-ins, or browser/DOM APIs.
- **Total untrusted-input handling**: All public functions accept `unknown` inputs, inspect `Reflect.ownKeys` and `Object.getOwnPropertyDescriptor` without invoking ordinary own/inherited accessors or user coercion methods, reject reserved prototype keys (`__proto__`, `constructor`, `prototype`), and catch exotic `Proxy` trap errors into structured `ValidationError` diagnostics.

## Package Exports (`"."`)

Built entry point: `./dist/index.js` (`./dist/index.d.ts`).

### Functions

- `validateModel(model: unknown): ValidationError[]`
- `validateOptions(options: unknown): ValidationError[]`
- `verifyModel(model: unknown, options: unknown): VerifyResult`
- `getInitialState(model: unknown): InitialStateResult`
- `getEnabledTransitions(model: unknown, state: unknown): EnabledTransitionsResult`
- `stepModel(model: unknown, state: unknown, ruleId: unknown): StepResult`
- `replayTrace(model: unknown, ruleIds: unknown): ReplayResult`

### Types

- Model & expressions: `VarDef`, `StateSchema`, `StateValue`, `StateSnapshot`, `ValueExpr`, `BoolExpr`, `UpdateAssignment`, `TransitionRule`, `Invariant`, `Goal`, `ModelAssumption`, `TransitionSystemModel`
- Verification & diagnostics: `VerifyOptions`, `VerifyStats`, `TraceStep`, `ValidationError`, `VerifyResult`
- Replay & stepping: `EnabledTransition`, `InitialStateResult`, `EnabledTransitionsResult`, `StepResult`, `ReplayResult`

## Quick Start

```ts
import { verifyModel, replayTrace, type TransitionSystemModel } from '@rulecanvas/core';

const model: TransitionSystemModel = {
  id: 'counter-check',
  name: 'Bounded Counter',
  schema: { count: { kind: 'int', min: 0, max: 2 } },
  initialState: { count: 0 },
  rules: [
    {
      id: 'inc',
      label: 'Increment',
      guard: { op: 'lt', left: { op: 'var', name: 'count' }, right: { op: 'lit', value: 2 } },
      updates: [{ var: 'count', value: { op: 'add', left: { op: 'var', name: 'count' }, right: { op: 'lit', value: 1 } } }],
    },
  ],
  invariants: [
    { id: 'below-two', label: 'Count stays below 2', holds: { op: 'lt', left: { op: 'var', name: 'count' }, right: { op: 'lit', value: 2 } } },
  ],
  assumptions: [
    { id: 'single-step', category: 'execution', statement: 'Transitions execute one step at a time.', notModeled: 'Concurrent updates.' },
  ],
};

const result = verifyModel(model, { maxStates: 100, maxDepth: 10 });
if (result.status === 'VIOLATED') {
  const replay = replayTrace(model, result.trace.map((step) => step.ruleId));
  console.log(result.violatedInvariantIds, replay);
}
```

## Verification Bounds & Limitations

- Structural and AST bounds: `1..64` schema variables, `1..256` enum values (`1..128` chars), safe integer `min <= max` with span `<= 1_000_000n`, `0..256` rules, `0..64` updates per rule, `1..64` invariants, `1..64` assumptions, `1..64` `and`/`or` arguments, `0..256` `in` values, AST `depth <= 32`, and un-deduplicated AST `visits <= 256`.
- Search bounds: `VerifyOptions.maxStates` in `[1, 100_000]` and `VerifyOptions.maxDepth` in `[0, 10_000]`. Exceeding either bound returns `INCONCLUSIVE` with `completedDepth` and `frontierRemaining` rather than approximating a proof.
- Results apply strictly to the declared finite-state model and its `assumptions`. See [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) for full semantics.
