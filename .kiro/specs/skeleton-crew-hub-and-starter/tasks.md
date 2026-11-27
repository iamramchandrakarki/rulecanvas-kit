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

- [ ] 1. Write this spec
  - _Requirements: all_
- [ ] 2. Add `WorkbenchBrandLink` and wire the return link in both workbenches
  - Export it from `@rulecanvas/workbench-react`, add unit tests, and confirm the `verify-boundaries` file-save hook runs
  - _Requirements: 2.1, 2.2, 2.3, 2.4_
- [ ] 3. Build the static Hub under `site/` and `tests/site-hub.test.ts`
  - _Requirements: 1.1 to 1.9_
- [ ] 4. Create `templates/workbench-starter/`
  - _Requirements: 3.1 to 3.5_
- [ ] 5. Switch `scripts/verify-pack.mjs` to the template and add the Hub and starter journeys to the Browser_Gate
  - _Requirements: 4.1 to 4.4_
- [ ] 6. Extend the release preflight for `site-static.tar.gz`
  - _Requirements: 5.3, 5.4_
- [ ] 7. Extend the boundary and hygiene gates, CI archives, and Kiro tracking
  - _Requirements: 5.1, 5.2, 6.1, 6.2, 6.3_
- [ ] 8. Run the full verification suite and the `boundary-auditor` agent
  - `pnpm build`, `pnpm typecheck`, `pnpm verify:exports`, `pnpm verify:pack`, `pnpm test`, `pnpm verify:boundaries`, `pnpm verify:hygiene`, `pnpm test:release:preflight`, `pnpm test:browser`
  - _Requirements: all_

## Notes

- Spec 1 must not add or reference `report.ts`, `delta.ts`, `check-model.mjs`, `pnpm check:model`, or report export.
- Do not push, merge, tag, or deploy.
