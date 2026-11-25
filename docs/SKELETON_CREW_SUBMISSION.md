# Skeleton Crew Submission Draft & Demo Script

This document prepares an honest Devpost submission draft and sub-three-minute (`< 3:00`) video walkthrough script for the **Kiroween — Skeleton Crew** track, grounded in Devpost's Skeleton Crew guidelines (a lean, clear foundational skeleton proven across **two distinct applications**) and what actually exists in this repository.

> **Maintainer / Lead Pre-Submission Checklist (Do Not Fabricate)**
>
> Before submitting to Devpost, the repository maintainer must supply and verify the remaining operational evidence outside this text draft:
>
> - [ ] Capture authentic screenshots of both workbenches (`apps/agent-gate` and `apps/interlock-sim`) and integrate them into `README.md` and Devpost.
> - [ ] Record and upload a `< 3:00` walkthrough video (YouTube or Vimeo, public or unlisted, verified in an incognito browser window).
> - [ ] Confirm the public GitHub repository URL and note whether any static preview deployment URL exists (none is claimed here).
> - [ ] Attach only genuine Kiro IDE / CLI operational evidence (never claim `.kiro/specs/` execution history that did not occur; see [docs/TOOL_ATTRIBUTION.md](./TOOL_ATTRIBUTION.md)).

---

## Devpost Submission Draft (Skeleton Crew)

### Project Name

**RuleCanvasKit** — *Verify your rules before deployment.*

### Track / Category

**Skeleton Crew**

### Elevator Pitch

A lean, zero-dependency TypeScript Guarded Transition System (GTS) verification skeleton (`@rulecanvas/core`, `@rulecanvas/ui`, `@rulecanvas/workbench`, `@rulecanvas/workbench-react`) proven across two distinct browser workbenches: **AgentGate** (AI agent approval policy verification) and **InterlockSim** (educational BSL-3 airlock interlock simulation).

### Inspiration

Rule-heavy systems—whether AI agent permission gates or physical safety interlocks—often look safe when each transition rule is read in isolation, yet fail when multiple permitted actions compose across 5–7 steps. Patches also fail in two recurring ways: blocking one attack trace while leaving a second multi-step bypass open, or clamping a guard so hard that legitimate users can no longer reach the intended goal (a vacuous fix). We wanted a minimal, deterministic verification skeleton that surfaces shortest counterexamples and vacuous fixes before deployment, and adapts cleanly across unrelated domains.

### What It Does

RuleCanvasKit separates a domain-agnostic formal verification skeleton from domain applications:

1. **The Lean Skeleton (`packages/*`)**:
   - **`@rulecanvas/core`**: Pure ES2022, zero-dependency bounded BFS model checker and deterministic trace replayer with exact `bigint` integer evaluation, atomic pre-state updates, total `unknown`-input validation, and four explicit verdicts (`VERIFIED`, `VIOLATED`, `INCONCLUSIVE`, `INVALID`).
   - **`@rulecanvas/ui`**: Pure ES2022 expression/rule formatters, core-backed replay and manual step-simulation controller, strict integer draft parsing, null-prototype diagnostic indexing, and XSS-safe semantic HTML renderers.
   - **`@rulecanvas/workbench`** *(workspace private)*: Pure ES2022 Web Worker / main-thread verification transport with detached snapshot capture, deep-frozen validated results, and a strict portable model JSON codec.
   - **`@rulecanvas/workbench-react`** *(workspace private)*: React 19 peer adapters for controlled integer inputs, snapshot-bound verification state (`OUTDATED:` stale-result isolation), accessible verdict/assumption disclosures, reciprocal same-origin navigation, and race-safe `?preset=...` URL routing.
2. **Application 1 — AgentGate (`apps/agent-gate`)**:
   - Models AI agent approval-laundering policies (`Broken Policy`, `Naive Patch A`, `Naive Patch B`, `Vacuous Fix`, and `Principled Fix`).
   - Provides a structured policy and AST guard editor, 5-preset comparison matrix, Web Worker verification, and step-by-step counterexample replay showing how stale approvals can be laundered in 5–7 steps—and how a vacuous fix passes safety invariants while making the clean release goal unreachable.
3. **Application 2 — InterlockSim (`apps/interlock-sim`)**:
   - Models an educational discrete BSL-3 airlock interlock (`Broken Override`, `Principled Fix`, and `Vacuous Lockout`).
   - Pairs an accessible airlock schematic and operator console with predicate-level guard explanations, shortest counterexample replay, guided repair for the built-in broken preset, and JSON import/export—all backed by the exact same core verifier and shared workbench packages.

*(Note: Packaging verification via `pnpm verify:pack` also builds and verifies a minimal third-domain booking fixture in an isolated offline consumer to ensure the libraries remain domain-neutral.)*

### How We Built It

- **Strict Acyclic Layering**: Enforced via automated AST and package-manifest boundary tests (`packages/rulecanvas-core/tests/boundaries.test.ts`): `core` has zero runtime dependencies, `ui` and `workbench` depend solely on `core` with zero host globals or domain terminology, `workbench-react` adds React 19 strictly as a peer dependency, and `apps/*` never import from one another.
- **Correctness & Hardening**: Differential `fast-check` property-based testing against an independent oracle (`FC_SEED=918273645`), untrusted JSON raw-number pre-scanning before `JSON.parse`, anti-skip test hygiene enforcement (`pnpm verify:hygiene`), map-free tarball packing (`pnpm verify:pack`), and headless Chromium Playwright regression tests across desktop, tablet, and mobile viewports (`pnpm test:browser`).
- **Kiro Workspace Configuration**: Tracked `.kiro/steering/` rules (`architecture-boundaries.md`, `engine-correctness.md`) and `.kiro/hooks/verify-core.json` keep architectural boundaries and verification commands versioned alongside the codebase, alongside formal core specs in `docs/specs/01-gts-verification-core/`. *(No fabricated Kiro IDE spec execution history is claimed.)*

### Challenges We Ran Into

- Keeping worker responses, browser URL preset routing (`?preset=...`), and dirty JSON/editor discard confirmation dialogs race-free across rapid user switches and Navigation API fallbacks.
- Preserving strict JSON numeric and duplicate-key safety (`512,000` char portable codec) while keeping legacy v0.4.0 JSON import compatibility and zero-invariant draft export repairable in the UI.
- Proving packaging integrity outside workspace symlinks by testing map-free tarballs and pinned React peer dependencies in an isolated offline consumer (`pnpm verify:pack`).

### Accomplishments That We're Proud Of

- Zero duplicated transition semantics between verification, counterexample replay, manual stepping, and React UI components.
- Honest verdict reporting (`VERIFIED (GOAL UNREACHABLE)` for vacuous fixes, `INCONCLUSIVE` with exact `completedDepth` and `frontierRemaining` on bounded truncation, and explicit `ModelAssumption[]` scoping).
- Two genuinely different applications—AI agent policy modeling and physical-style discrete interlock simulation—sharing one tested, domain-neutral verification skeleton.

### What We Learned

- Separating a pure ES2022 mathematical kernel from transport and React adapters forces clean contracts and makes deterministic testing, worker execution, and packaging verification dramatically easier.
- Guarding against vacuous fixes (checking goal reachability alongside invariants) is just as important as finding counterexamples.

### What's Next

- Publishing `@rulecanvas/core` and `@rulecanvas/ui` (and evaluating whether `@rulecanvas/workbench` / `@rulecanvas/workbench-react` should become public packages).
- Adding additional domain presets and optional external solver backends isolated behind the same independent validation contract.

### Built With

TypeScript, ES2022, React 19, Vite, Vitest, fast-check, Playwright, Node.js, pnpm, Kiro workspace steering & hooks.

---

## Sub-Three-Minute Demo Script (`2:50` Target)

> **Devpost Video Checklist**: Keep total runtime strictly **under 3:00**, show working software within the first **30 seconds**, use clear narration without loud background music, and test the final YouTube/Vimeo link in an incognito window.

### `[0:00 – 0:25]` Hook, Problem & Live Product Preview

- **Visual**: Title slide (`RuleCanvasKit — Verify your rules before deployment`) for 3 seconds, then immediately cut to **AgentGate** running in the browser (`?preset=broken`) showing the `VIOLATED` verdict and 5-step counterexample.
- **Narration**:
  > "Access policies and safety interlocks often look fine rule by rule, yet fail when actions combine across five or six steps—or break workflows when patched too aggressively. This is RuleCanvasKit, our Skeleton Crew submission: a lean TypeScript finite-state verification skeleton that finds shortest counterexamples and vacuous fixes before deployment, powering two completely distinct browser applications."

### `[0:25 – 1:10]` The Lean Skeleton & Architecture Boundaries

- **Visual**: Show the workspace layout (`packages/rulecanvas-core`, `rulecanvas-ui`, `rulecanvas-workbench`, `rulecanvas-workbench-react`), the acyclic layering diagram in `docs/ARCHITECTURE.md`, and a terminal run of `pnpm verify:boundaries` and `pnpm verify:exports`.
- **Narration**:
  > "Our skeleton is split into four strict, acyclic packages. `@rulecanvas/core` is pure ES2022 with zero runtime dependencies, exact bigint arithmetic, atomic updates, and deterministic BFS exploration. `@rulecanvas/ui` adds domain-neutral formatters, an immutable replay controller backed directly by core, and XSS-safe renderers. `@rulecanvas/workbench` handles detached Web Worker transport and strict portable JSON validation, and `@rulecanvas/workbench-react` provides React 19 adapters for snapshot-bound verdicts, same-origin navigation, and preset URL routing. Automated AST boundary tests ensure core, UI, and workbench never leak domain terms or host globals."

### `[1:10 – 1:55]` Application 1: AgentGate (`apps/agent-gate`)

- **Visual**: In **AgentGate**, step through the 5-step approval-laundering counterexample replay (`Broken Policy`), open the 5-preset comparison matrix (`Naive Patch A`, `Naive Patch B`, `Vacuous Fix`, `Principled Fix`), highlight `VERIFIED (GOAL UNREACHABLE)` on `Vacuous Fix`, and switch to `Principled Fix` showing `VERIFIED` across `61` states with the goal reachable.
- **Narration**:
  > "To prove the skeleton across distinct domains, our first application is AgentGate, a design-time workbench for AI agent tool-approval policies. On the broken policy, AgentGate's Web Worker finds and replays a five-step approval-laundering trace. In the comparison matrix, naive patches still fail in six or seven steps, a vacuous fix is flagged honestly as 'Verified, Goal Unreachable,' and the principled fix verifies all sixty-one reachable states with the release goal intact."

### `[1:55 – 2:30]` Application 2: InterlockSim (`apps/interlock-sim`)

- **Visual**: Click **InterlockSim** in the top `WorkbenchNavigation` bar (showing `?preset=` URL routing). Run/inspect the broken BSL-3 airlock override preset (`6`-step breach), click an action in the Operator Console and inspect a blocked guard explanation, apply the guided repair or switch to `Principled Fix` (`29` states verified), and briefly open the JSON import/export modal.
- **Narration**:
  > "From the shared navigation bar, we jump directly into our second application: InterlockSim, an educational discrete BSL-3 airlock simulator. It shares the exact same verification core, worker transport, replay controller, and URL router—yet renders an interactive airlock schematic, operator console, predicate-level guard explainer, and guided repair. Every verdict stays scoped to the verified snapshot and explicit modeling assumptions."

### `[2:30 – 2:50]` Verification Rigor, Kiro Tooling & Honest Wrap-Up

- **Visual**: Show `.kiro/steering/` and `.kiro/hooks/verify-core.json` briefly alongside a passing terminal run of `pnpm test` / `pnpm verify:pack` / `pnpm test:browser`, ending on a clean summary card with the GitHub repository link.
- **Narration**:
  > "We keep `.kiro` steering rules and verification hooks versioned in the repository and validate every change with property-based differential tests, offline tarball consumer packing, and headless Playwright browser checks. Check out the RuleCanvasKit repository linked on Devpost to explore both workbenches or build your own discrete-state tool on the skeleton. Thanks for watching."
