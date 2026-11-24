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
- `apps/*` (`@rulecanvas/agent-gate`, `@rulecanvas/interlock-sim`): domain models, scenarios, and domain tests consuming `@rulecanvas/core` via `workspace:*`.
- Never import from `apps/*` into `packages/rulecanvas-core`.

## Verification & Honesty Discipline
- Never fabricate spec execution history or completed checkboxes in `.kiro/specs/`.
- Keep architectural and core engine specifications under `docs/ARCHITECTURE.md` and `docs/specs/`.
- Any change to `packages/rulecanvas-core` must pass `pnpm build`, `pnpm typecheck`, and `pnpm verify:boundaries`.
