# Implementation Plan

## Overview

Small Conventional Commits on `feat/v0.8.0-kiroween-skeleton-crew`. Waves 1 and 2 are independent of each other; wave 3 depends on both.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1"] },
    { "id": 1, "tasks": ["2", "3", "4"] },
    { "id": 2, "tasks": ["5", "6", "7"] },
    { "id": 3, "tasks": ["8"] }
  ]
}
```

## Tasks

- [x] 1. Write this spec
  - _Requirements: all_
- [x] 2. Add `WorkbenchBrandLink` and wire the return link in both workbenches
  - Export it from `@rulecanvas/workbench-react` and add unit tests
  - _Requirements: 2.1, 2.2, 2.3, 2.4_
  - [ ] 2.1 Confirm that the `verify-boundaries` file-save hook runs (see the verification record)
- [x] 3. Build the static Hub under `site/` and `tests/site-hub.test.ts`
  - _Requirements: 1.1 to 1.9_
- [x] 4. Create `templates/workbench-starter/`
  - _Requirements: 3.1 to 3.5_
- [x] 5. Switch `scripts/verify-pack.mjs` to the template and add the Hub and starter journeys to the Browser_Gate
  - _Requirements: 4.1 to 4.4_
- [x] 6. Extend the release preflight for `site-static.tar.gz`
  - _Requirements: 5.3, 5.4_
- [x] 7. Extend the boundary and hygiene gates, CI archives, and Kiro tracking
  - _Requirements: 5.1, 5.2, 6.1, 6.2, 6.3_
- [x] 8. Run the full verification suite and the `boundary-auditor` agent
  - `pnpm build`, `pnpm typecheck`, `pnpm verify:exports`, `pnpm verify:pack`, `pnpm test`, `pnpm verify:boundaries`, `pnpm verify:hygiene`, `pnpm test:release:preflight`, `pnpm test:browser`
  - _Requirements: all_

## Notes

- Spec 1 must not add or reference `report.ts`, `delta.ts`, `check-model.mjs`, `pnpm check:model`, or report export.
- Do not push, merge, tag, or deploy.

## Verification record (Kiro IDE 1.5.49, branch `feat/v0.8.0-kiroween-skeleton-crew`)

This spec was written and executed in a Kiro IDE agent session, not through Spec-mode task execution, so `tasks.meta.json` was not created. Tasks were checked only after the commands below ran in that session, on the commit in `evidence/.../spec1-final/COMMIT`. All exited 0.

| Command | Result |
|---|---|
| `pnpm build` | 4 libraries and both apps built |
| `pnpm typecheck` | all workspaces pass |
| `pnpm verify:exports` | 4 packages, 6 entry points |
| `pnpm verify:pack` | starter copied from `templates/workbench-starter`, offline tarball install, Node smoke, `node --test` 5/5, `tsc` under Bundler and NodeNext, Vite worker bundle emitted |
| `pnpm test` | 20 files, 193 tests |
| `pnpm verify:boundaries` | 14/14 |
| `pnpm verify:hygiene` | 24 test files, 0 skipped, focused, or pending |
| `pnpm test:release:preflight` | 32/32, including 7 new hub-archive cases |
| `pnpm test:browser` | PASS: hub under `/` and `/rulecanvas-kit/`, starter in worker mode, 0 axe critical or serious violations, 0 console, HTTP, or external-request errors |

- The README workflow for the template (`pnpm run pack:local`, copy outside the repository, `pnpm install`, `pnpm test`, `pnpm run typecheck`, `pnpm build`) was run in a temporary directory outside the repository and passed. The root `pnpm-lock.yaml` is unchanged.
- The `boundary-auditor` agent ran read-only and reported PASS in all five areas, and NOT PRESENT for report provenance because Spec 2 files do not exist. It also reported no Spec 2 artifacts or advertising. Two of its notes were applied: the starter goal label and the wording of the site origin rule.
- Task 2.1 is not confirmed. This IDE session loaded its v2 hooks at session start (12:59Z in `~/.kiro/logs`), and `.kiro/hooks/verify-boundaries.json` was created later (13:14Z). Agent edits to `packages/*/src` in this session produced no hook output. A fresh `kiro-cli` 3.5.0 session and a fresh sub-agent each saved `packages/rulecanvas-ui/src/format.ts`, and neither showed hook output or a log entry. To confirm the hook, start a new Kiro IDE session, have the agent save a file under `packages/*/src`, and check for `pnpm verify:boundaries` output.
