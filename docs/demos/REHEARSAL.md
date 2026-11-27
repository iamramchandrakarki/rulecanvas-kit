# Walkthrough Rehearsal Report

Rehearsal and motion-stability record for the illustrative walkthrough scenes in `docs/demos/stageshow/`.

## Summary

| Walkthrough | Gold Reference | Choreography | Capture Modes | `film.mjs --gate` | `jumps.mjs` (60fps scan) |
| --- | --- | --- | --- | --- | --- |
| `agent-gate-walkthrough` | `form-error` | 3-beat sequence + verified poster | `640x360` wide, `390px` compact, reduced-motion poster | Passed (6/6 passes) | `no-issues-detected` |
| `interlock-sim-walkthrough` | `form-error` | 3-beat sequence + verified poster | `640x360` wide, `390px` compact, reduced-motion poster | Passed (6/6 passes) | `no-issues-detected` |

## Choreographed Sequences

### `agent-gate-walkthrough`

1. **Beat 1 (`append`)**: Opens on the 5-step approval-laundering counterexample (`VIOLATED · 5 steps`), moves to the `publish_release_notes` guard rule action, and appends `!modifiedSinceApproval`, transitioning the snapshot status to `OUTDATED · Draft edited`.
2. **Beat 2 (`verify`)**: Moves to `Verify Policy`, triggers the worker verification run (`RUNNING · BFS worker`).
3. **Beat 3 (`verified`)**: Completes with `VERIFIED · Goal: Yes` across 61 reachable states and settles at the resting cursor position. Reduced-motion environments render the verified poster state directly.

### `interlock-sim-walkthrough`

1. **Beat 1 (`repair`)**: Opens on the 6-step BSL-3 override containment breach (`VIOLATED · Step 6 / 6`), moves to `Apply Principled Repair`, and applies the candidate repair, marking both the schematic and header `OUTDATED SNAPSHOT`.
2. **Beat 2 (`verify`)**: Moves to `Verify Interlock Model` and triggers bounded BFS exploration (`VERIFYING · BFS`).
3. **Beat 3 (`verified`)**: Completes with `VERIFIED · Goal: Yes` across 29 reachable states and settles at the resting cursor position. Reduced-motion environments render the verified poster state directly.

## Verification Gates

- **Viewports**: Rehearsed and captured at `640x360` (wide), `390px` (compact), and reduced-motion poster mode.
- **Film Gate (`film.mjs --gate`)**: Rehearsal passed across all 6 passes for both walkthroughs.
- **Frame-Jump Scan (`jumps.mjs`)**: 60fps scan reported `no-issues-detected` for both walkthroughs.
