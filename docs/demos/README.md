# Illustrative Product Walkthroughs

This directory contains authored illustrative product walkthrough assets for RuleCanvasKit, isolated outside production application bundles (`apps/*`) and distinct from live deterministic `@rulecanvas/core` verification runs.

## Assets

- [`agent-gate-walkthrough.png`](./agent-gate-walkthrough.png) — Verified poster frame for the AgentGate workflow: appending `!modifiedSinceApproval` to `publish_release_notes`, transitioning through `OUTDATED`, and reaching `VERIFIED · Goal: Yes`.
- [`agent-gate-storyboard.png`](./agent-gate-storyboard.png) — Contact-sheet storyboard of the 3-beat AgentGate walkthrough sequence (`append` → `verify` → `verified`) across wide (`640x360`), compact (`390px`), and reduced-motion poster captures.
- [`interlock-sim-walkthrough.png`](./interlock-sim-walkthrough.png) — Verified poster frame for the InterlockSim workflow: applying the candidate repair (`OUTDATED SNAPSHOT`) and re-verifying to `VERIFIED · Goal: Yes`.
- [`interlock-sim-storyboard.png`](./interlock-sim-storyboard.png) — Contact-sheet storyboard of the 3-beat InterlockSim walkthrough sequence (`repair` → `verify` → `verified`) across wide (`640x360`), compact (`390px`), and reduced-motion poster captures.
- [`stageshow/agent-gate-walkthrough/`](./stageshow/agent-gate-walkthrough/index.tsx) — Source TSX and CSS for the AgentGate walkthrough scene.
- [`stageshow/interlock-sim-walkthrough/`](./stageshow/interlock-sim-walkthrough/index.tsx) — Source TSX and CSS for the InterlockSim walkthrough scene.
- [`REHEARSAL.md`](./REHEARSAL.md) — Capture parameters, `film.mjs --gate` pass summary, and `jumps.mjs` 60fps stability report.
