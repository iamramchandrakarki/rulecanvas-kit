# Implementation Plan

## Overview

Tests first (red), then the archive helper and orchestrator, then the browser helper, then green runs and the real CI baseline. Work serially.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1"] },
    { "id": 1, "tasks": ["2.1"] },
    { "id": 2, "tasks": ["2.2"] },
    { "id": 3, "tasks": ["3"] },
    { "id": 4, "tasks": ["4"] }
  ]
}
```

## Tasks

- [x] 1. Write the regression tests first and record the red run
  - Create `tests/release-preflight.test.mjs` using `node:test`, with fixtures generated at test time, and add `test:release:preflight` to `package.json`
  - Cover the success path and every failing case in Requirement 6, including the no-remnants and unchanged-inputs assertions
  - Run `pnpm test:release:preflight` before any implementation exists and save the command, output, and exit status under `$RULECANVAS_PREFLIGHT_EVIDENCE`
  - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.7_

- [x] 2. Implement the archive helper and the orchestrator
  - [x] 2.1 Create `scripts/release-preflight-archive.py` (bounded validate and extract with `gzip` and `tarfile`)
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_
  - [x] 2.2 Create `scripts/release-preflight.mjs` (arguments, directory and manifest checks, staging, publication, cleanup) and add `verify:release:preflight` to `package.json`
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 2.1, 2.2, 2.3, 2.4, 2.5, 4.1, 4.2, 4.3, 4.4_

- [x] 3. Implement the browser helper
  - Create `scripts/release-preflight-browser.mjs` and wire it into the orchestrator after extraction and before publication
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8_

- [x] 4. Run the Test_Suite green and run the real CI baseline
  - Run `pnpm test:release:preflight` and save the output and exit status as evidence
  - Run `pnpm verify:release:preflight --archive-dir "$RULECANVAS_PREFLIGHT_BASELINE" --output <new dir outside tracked paths>`, save the command, output, and exit status, and confirm that the baseline archives are unchanged
  - Run `pnpm verify:hygiene`, `pnpm verify:boundaries`, and `pnpm typecheck`, and confirm that `git status` shows no change to existing app, library, CI, or documentation files
  - _Requirements: 1.6, 3.7, 6.6, 6.7_

## Notes

- Keep existing app, library, CI, and release-document sources unchanged. Do not edit `docs/TOOL_ATTRIBUTION.md`, commit, or push.
- Evidence goes under `$RULECANVAS_PREFLIGHT_EVIDENCE`, which is outside tracked paths.

## Verification record (Kiro IDE 1.5.49, branch `feat/v0.8.0-kiroween-skeleton-crew`, base `8d664f1`)
Tasks 2, 2.2, 3, and 4 were marked complete after the following checks ran in this Kiro session. All exited 0. The logs are kept outside tracked paths.
- Tasks 2.2 and 3: `scripts/release-preflight.mjs` and `scripts/release-preflight-browser.mjs` exist. The orchestrator imports `runBrowserChecks`, which runs after extraction and before the publishing `renameSync`. The test suite covers both, including the browser-stage failure cases.
- `pnpm test:release:preflight`: 25 tests, 4 suites, 25 pass, 0 fail.
- `pnpm verify:release:preflight`, run against the real CI baseline from GitHub Actions run `45972124919` (commit `8d664f1`, tag `v0.7.0`): exit 0, and both apps were published to a new output directory outside the repository. `SHA256SUMS.txt` verified all six archives. The SHA-256 listings taken before and after the run are identical, and no staging directory was left behind.
- `pnpm verify:hygiene`: 21 test files, 0 skipped, focused, or pending tests.
- `pnpm verify:boundaries`: 11 of 11 tests pass.
- `pnpm typecheck`: every workspace passes.
- Before any `.kiro/` edits, `git status` was clean, so no existing app, library, CI, or documentation file had changed.
- `tasks.meta.json` was not edited. Kiro Spec mode records its execution history there, and this run was not a Spec-mode task execution.
