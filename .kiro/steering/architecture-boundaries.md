---
inclusion: always
---

# RuleCanvasKit Architecture Boundaries

## Core Engine Purity (`packages/rulecanvas-core`)
- `@rulecanvas/core` is a pure, deterministic ES2022 Guarded Transition System (GTS) verification engine.
- Zero runtime `dependencies`, `peerDependencies`, or `optionalDependencies` in `packages/rulecanvas-core/package.json`.
- `packages/rulecanvas-core/src/*.ts` MUST compile with `"lib": ["ES2022"]` and `"types": []`.
- Relative imports in `src/` MUST use explicit `.js` extensions (`NodeNext` resolution).
- Forbidden inside `packages/rulecanvas-core/src/`:
  - Bare module specifiers, `node:*` imports, and dynamic `import()`.
  - Non-deterministic or host-coupled APIs: `Date`, `performance`, `setTimeout`, `setInterval`, `Math.random`, `globalThis`, `eval`, `Function`.
  - Domain-specific terminology or scenario logic (e.g., agent/secret/webhook/approval/MCP or airlock/autoclave/BSL/valve/door/interlock/steril).
  - UI, DOM, SVG, CSS, HTML, Web Worker, or LLM code.

## Workspace Layering
- `packages/rulecanvas-core`: domain-agnostic formal model validation, exact BFS verification, and deterministic step/trace replay.
- `packages/rulecanvas-ui` (`@rulecanvas/ui`): pure ES2022 domain-neutral formatters, replay controller, and inspection renderers with `@rulecanvas/core` (`workspace:*`) as its sole runtime dependency; no `apps/*` imports, host clocks, randomness, DOM/React, or domain terminology.
- `packages/rulecanvas-workbench`: framework-independent JSON and verification transport. Delegate model semantics to the core. Keep browser worker construction in the apps and use structural ports for transport.
- `packages/rulecanvas-workbench-react`: domain-neutral React adapters for editing, verification snapshots, and navigation. Keep React a peer dependency and use explicit subpath imports into the transport package.
- `apps/*` (`@rulecanvas/agent-gate`, `@rulecanvas/interlock-sim`): domain models, scenario presets, and static browser workbenches. Both apps consume the shared packages via `workspace:*`.
- Shared packages never import apps. Apps stay independently buildable and do not import one another.

## Verification & Honesty Discipline
- Never fabricate spec execution history or completed checkboxes in `.kiro/specs/`.
- Keep architectural and core engine specifications under `docs/ARCHITECTURE.md` and `docs/specs/`.
- Any change to `packages/rulecanvas-core` or `packages/rulecanvas-ui` must pass `pnpm build`, `pnpm typecheck`, and `pnpm verify:boundaries`.
- For shared package export or packaging changes, also run `pnpm verify:exports` and `pnpm verify:pack`. For changes to app routing or verification journeys, run the production browser gate with the packed consumer fixture.
