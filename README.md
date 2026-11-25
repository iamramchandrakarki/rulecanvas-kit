# RuleCanvasKit

Verify your rules before deployment.

## Project Overview

RuleCanvasKit is a TypeScript finite-state verification toolkit for Guarded Transition Systems (GTS). You declare a bounded state schema, guarded transition rules, invariants, an optional goal predicate, and explicit modeling assumptions (`ModelAssumption[]`). The core engine explores the reachable state space deterministically via breadth-first search, returning either the shortest counterexample trace to an invariant violation or confirmation that every reachable state within the declared model satisfies all invariants.

## Real-World Problems Solved

Access policies, approval workflows, and discrete interlock logic often look sound when each rule is reviewed in isolation, yet break when several permitted transitions compose across multiple steps:

- **Multi-step approval bypasses**: A tool-approval workflow may grant approval on a clean draft, allow reading sensitive data, permit staging or mutating the draft, and execute an external action while reusing a stale approval token.
- **Incomplete or vacuous fixes**: Ad-hoc patches often block one known attack path while leaving an alternate multi-step path open, or disable a transition so aggressively that legitimate workflows can no longer reach their intended goal.
- **Interlock override hazards**: Discrete safety controllers can allow maintenance overrides, bypass flags, and state transitions to combine into a hazardous configuration that violates mutual-exclusion invariants.

RuleCanvasKit surfaces shortest-path multi-step counterexamples before deployment, replays traces deterministically step by step, and verifies both invariant preservation and goal reachability for candidate rule fixes.

## Key Features

- **Zero-dependency pure ES2022 verification core (`@rulecanvas/core`)**: Compiles cleanly under strict TypeScript (`"lib": ["ES2022"]`, `"types": []`) with zero runtime dependencies and no host-coupled APIs, clocks, randomness, or `eval`.
- **Total untrusted-input validation**: `validateModel`, `validateOptions`, `verifyModel`, and all replay APIs accept `unknown` inputs, enforce structural and AST complexity budgets, reject own getter/setter accessors without invoking accessor functions, reject reserved prototype keys, and catch exotic `Proxy` trap exceptions to return structured `UNEXPECTED_INPUT_ERROR` diagnostics instead of throwing.
- **Exact transition semantics**: Integer expressions and comparisons evaluate with exact `bigint` precision, rule updates apply atomically against the pre-state, `-0` normalizes to `0`, and out-of-domain assignments return `OUT_OF_DOMAIN_TRANSITION` rather than silently clamping.
- **Four explicit verification verdicts**:
  - `VERIFIED`: Every reachable state satisfies all declared invariants (reporting `goalReachable` when a goal is defined).
  - `VIOLATED`: Returns the shortest counterexample trace (`s0 -> ... -> v`), terminal state, and all violated invariant IDs in declaration order.
  - `INCONCLUSIVE`: Returned when `maxStates` or `maxDepth` limits are reached, with exact `completedDepth` and `frontierRemaining` counts.
  - `INVALID`: Returned with structured `ValidationError` diagnostics for malformed inputs, invalid options, or reachable out-of-domain transitions.
- **Deterministic step and trace replay**: `getInitialState`, `getEnabledTransitions`, `stepModel`, and `replayTrace` share the exact validator, compiler, and evaluator used by `verifyModel`.
- **Shared domain-agnostic UI foundation (`@rulecanvas/ui`)**: Pure ES2022 deterministic AST expression and rule formatters, an immutable counterexample replay and manual step-simulation controller backed by `@rulecanvas/core`, and accessible, XSS-safe view models and semantic HTML renderers with zero external npm runtime dependencies.

## Architecture

RuleCanvasKit separates its domain-agnostic verification engine from domain applications and workspace automation:

```text
.github/                 # CI workflow, issue templates, and pull request template
.kiro/                   # Versioned architecture steering rules and local verification hooks
packages/
  rulecanvas-core/       # @rulecanvas/core: pure ES2022 validator, compiler, BFS verifier, replay APIs
  rulecanvas-ui/         # @rulecanvas/ui: shared AST formatters, interactive replay controller, and accessible HTML renderers
apps/
  agent-gate/            # @rulecanvas/agent-gate: policy modeling suite for AI agent permissions and approvals
  interlock-sim/         # @rulecanvas/interlock-sim: educational discrete-state safety interlock simulator
docs/
  ARCHITECTURE.md        # Engine design, tuple encoding, BFS semantics, and dependency rules
  TOOL_ATTRIBUTION.md    # Development tooling disclosure and specification policy
  specs/                 # Formal requirements, design, and task specifications for @rulecanvas/core
```

Boundary tests automatically enforce that `packages/rulecanvas-core` and `packages/rulecanvas-ui` never import from `apps/*`, `node:*`, third-party npm packages, or non-deterministic host globals (`@rulecanvas/ui` depends solely on `@rulecanvas/core`). See [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for full details on validation caps, dense tuple encoding, BFS semantics, shared UI layering, and package boundaries.

## Installation and Quick Start

Prerequisites: Node.js `^22.12.0 || ^24.0.0 || >=26.0.0` (Node 24 LTS recommended; CI runs Node 24) and `pnpm`.

```bash
git clone https://github.com/iamramchandrakarki/rulecanvas-kit.git
cd rulecanvas-kit
pnpm install
pnpm build
pnpm test
```

## Usage Examples

Define a bounded model with a schema, transition rules, invariants, an optional goal, and explicit assumptions, then run `verifyModel` and replay any counterexample with `replayTrace`:

```ts
import {
  replayTrace,
  verifyModel,
  type TransitionSystemModel,
} from '@rulecanvas/core';

const model: TransitionSystemModel = {
  id: 'release-gate',
  name: 'Two-Step Release Gate',
  schema: {
    reviewed: { kind: 'boolean' },
    stage: { kind: 'enum', values: ['draft', 'staging', 'prod'] },
    retries: { kind: 'int', min: 0, max: 3 },
  },
  initialState: {
    reviewed: false,
    stage: 'draft',
    retries: 0,
  },
  rules: [
    {
      id: 'promote-staging',
      label: 'Promote draft to staging',
      guard: { op: 'eq', left: { op: 'var', name: 'stage' }, right: { op: 'lit', value: 'draft' } },
      updates: [{ var: 'stage', value: { op: 'lit', value: 'staging' } }],
    },
    {
      id: 'promote-prod',
      label: 'Promote staging to prod',
      guard: { op: 'eq', left: { op: 'var', name: 'stage' }, right: { op: 'lit', value: 'staging' } },
      updates: [{ var: 'stage', value: { op: 'lit', value: 'prod' } }],
    },
    {
      id: 'complete-review',
      label: 'Mark change reviewed',
      guard: { op: 'not', arg: { op: 'var', name: 'reviewed' } },
      updates: [{ var: 'reviewed', value: { op: 'lit', value: true } }],
    },
  ],
  invariants: [
    {
      id: 'prod-requires-review',
      label: 'Production deployments must be reviewed',
      holds: {
        op: 'or',
        args: [
          { op: 'neq', left: { op: 'var', name: 'stage' }, right: { op: 'lit', value: 'prod' } },
          { op: 'var', name: 'reviewed' },
        ],
      },
    },
  ],
  goal: {
    id: 'reach-prod',
    label: 'Reach production safely',
    reached: { op: 'eq', left: { op: 'var', name: 'stage' }, right: { op: 'lit', value: 'prod' } },
  },
  assumptions: [
    {
      id: 'atomic-transitions',
      category: 'execution',
      statement: 'Each rule executes atomically against the current discrete state.',
      notModeled: 'Out-of-band manual changes or concurrent pipeline races.',
    },
  ],
};

const result = verifyModel(model, { maxStates: 1_000, maxDepth: 20 });

if (result.status === 'VIOLATED') {
  const ruleIds = result.trace.map((step) => step.ruleId);
  const replayed = replayTrace(model, ruleIds);
  console.log('Shortest counterexample:', ruleIds, replayed);
}
```

## Applications

RuleCanvasKit powers two domain-separated applications built on `@rulecanvas/core`.

### AgentGate (`apps/agent-gate`)

AgentGate is the primary commercially relevant application in RuleCanvasKit for verifying AI agent permissions, security policies, and approval workflows before rollout. As of `v0.3.0`, `@rulecanvas/agent-gate` provides both executable TypeScript policy models (`broken`, `naive-patch-a`, `naive-patch-b`, `principled-fix`, and `vacuous-fix`) and an interactive React + Vite verification workbench (`pnpm --filter @rulecanvas/agent-gate dev` / `build` / `preview`) featuring a structured policy and AST guard editor, strict integer draft and raw JSON number pre-validation, non-blocking Web Worker verification with main-thread fallback, `@rulecanvas/ui` counterexample replay, and a reactive 5-preset comparison matrix.

### InterlockSim (`apps/interlock-sim`)

InterlockSim is an educational browser workbench for exploring discrete airlock interlocks. Compare the broken, repaired, and vacuous-lockout presets, replay a counterexample, and step through enabled operator actions. The guard inspector explains blocked actions and offers a guided repair for the built-in broken preset. The workbench also supports JSON import and export for custom finite-state models.

After installing workspace dependencies, build the shared packages and launch the workbench:

```bash
pnpm build
pnpm --filter @rulecanvas/interlock-sim dev
```

For a production build, use `pnpm --filter @rulecanvas/interlock-sim build`. See the [v0.4.0 release notes](docs/releases/v0.4.0.md) for a walkthrough and verification limits.

## Screenshots

Repository screenshot documentation is planned for the `v1.0.0` milestone.

## Testing Instructions

Run the full build, typecheck, test, boundary, hygiene, and benchmark suite locally:

```bash
# Build @rulecanvas/core and @rulecanvas/ui
pnpm build

# Build the AgentGate interactive browser workbench
pnpm --filter @rulecanvas/agent-gate build
pnpm --filter @rulecanvas/interlock-sim build

# Typecheck all workspace packages and strict ES2022 core/UI configs
pnpm typecheck
pnpm --filter @rulecanvas/core exec tsc --noEmit -p tsconfig.json
pnpm --filter @rulecanvas/ui exec tsc --noEmit -p tsconfig.json

# Run all unit, property-based, boundary, and application scenario tests
pnpm test

# Run architecture and boundary enforcement checks
pnpm verify:boundaries

# Check test hygiene (no skipped or focused tests)
pnpm verify:hygiene

# Run the property-based differential oracle with an explicit seed
FC_SEED=918273645 pnpm --filter @rulecanvas/core exec vitest run tests/properties.test.ts

# Run the deterministic benchmark suite
pnpm bench
```

## Known Limitations

- **Model-scoped verification only**: Verification results apply strictly to declared mathematical models under their explicit `ModelAssumption[]` assumptions. RuleCanvasKit does not provide real-world security guarantees, live runtime enforcement, or industrial safety certification.
- **Design-time policy modeling (`AgentGate`)**: `@rulecanvas/agent-gate` evaluates discrete permission and approval state machines at design time. It is not a live runtime firewall, prompt-injection classifier, or production configuration scanner.
- **Educational interlock modeling (`InterlockSim`)**: `@rulecanvas/interlock-sim` models discrete interlock logic for educational exploration only. It does not model continuous physics, sensor failures, or hardware timing and must not be used for real-world physical containment or SIL / IEC 61508 engineering.
- **Bounded finite-state exploration**: Exploration is bounded by `maxStates` (`<= 100,000`) and `maxDepth` (`<= 10,000`). Models whose reachable state space exceeds these limits return `INCONCLUSIVE` rather than approximating a verdict.

## Contribution Guidelines

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development prerequisites, commit conventions, required checks, and core engine invariants. For vulnerability reporting and threat-boundary details, see [SECURITY.md](./SECURITY.md). For development tooling disclosure and specification practices, see [docs/TOOL_ATTRIBUTION.md](./docs/TOOL_ATTRIBUTION.md).

## License

MIT. See [LICENSE](./LICENSE).
