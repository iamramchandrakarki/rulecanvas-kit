---
inclusion: always
---
# v0.8.0 Workbench UI and Report Rules

## Package placement
- `report.ts` and `delta.ts` live in `packages/rulecanvas-ui/src/` and are exported from `@rulecanvas/ui`.
- Both files are pure ES2022: no `Date`, `performance`, `setTimeout`, `setInterval`, `Math.random`, `globalThis`, `eval`, `Function`, DOM, React, or `node:*` imports. The only bare import allowed is `@rulecanvas/core`.
- Reports never generate timestamps or host data. If a report needs a time or environment label, the caller passes it in as plain data.
- Both files stay domain-neutral. Scenario words (agent, secret, webhook, approval, MCP, airlock, valve, door, interlock, and similar) belong in `apps/*` only.
- `@rulecanvas/workbench` keeps `@rulecanvas/core` as its only runtime dependency.
- `@rulecanvas/workbench-react` keeps `react` as its only peer dependency. `react-dom` may appear in `devDependencies` only, never in `dependencies`, `peerDependencies`, or `optionalDependencies`. Its runtime dependencies stay limited to `@rulecanvas/core`, `@rulecanvas/ui`, and `@rulecanvas/workbench` via `workspace:*`.

## Spec sequencing
- Spec 1 must build and pass on its own. It must not import, reference, or require `report.ts`, `delta.ts`, or `check-model.mjs`. Those files belong to Spec 2.
- Report export integration in the starter template is added during Spec 2 only.

## Report provenance
Every report carries exactly one provenance value, and the report text states which one applies:
- `validated-snapshot`: the report restates a verification result that was structurally validated but not re-run. The verdict is only as trustworthy as its source.
- `recomputed-core`: the report code itself called `@rulecanvas/core` verification on the validated model and options, and the verdict in the report is the result of that call.

Rules:
- Set `recomputed-core` only on the code path that actually ran core verification. Never copy a provenance label, verdict, or trace from caller input. Treat caller-supplied provenance as untrusted and ignore or reject it.
- If recomputation is skipped, fails validation, or returns a different verdict from the supplied snapshot, the report must not claim `recomputed-core` for the supplied result. Report the mismatch.
- Trace replay checks `VIOLATED` counterexample traces only: it confirms that the trace steps through the model and reaches the reported invariant violation. Trace replay does not prove `VERIFIED`, `INCONCLUSIVE`, or `INVALID` verdicts, and report text must not imply that it does.

## Design rules (`DESIGN.md`)
- One-Signal Verdict Rule: semantic green, amber, and crimson appear only when tied to an engine-derived verdict, invariant evaluation, transition guard state, or validation error. Headings and metadata never use status colors.
- Motion uses the token scale of five durations between `90ms` and `280ms` and the three documented curves. No overshoot or bounce.
- `@media (prefers-reduced-motion: reduce)` disables transitions and animations. Labels, badges, and functional cues stay identical.

## Apps and site
- `apps/` contains exactly two showcase apps: `apps/agent-gate` and `apps/interlock-sim`. Do not add a third workspace under `apps/`.
- Everything under `site/` uses relative paths for assets and internal links. No root-absolute (`/...`) or protocol-relative paths, so the site works from any subdirectory. The only other origin allowed is a plain link to `https://github.com/iamramchandrakarki/rulecanvas-kit` with `rel="noopener noreferrer"`. Nothing may be loaded from another origin.

## Claim language
- No overclaims in code, docs, reports, or UI copy. The boundary test rejects these phrases in claim-bearing files: `100% secure`, `unhackable`, `proven safe`, `formally proven by fast-check`, `certified safety software`, `audits production mcp.json`.
- `VERIFIED` means exhaustive exact BFS of the declared finite model found no invariant violation. It says nothing about the real system the model describes.
- `INCONCLUSIVE` means a depth or state bound was reached. Never present it as a pass.

## Required checks
- Changes to `packages/rulecanvas-ui` or `packages/rulecanvas-core`: `pnpm build`, `pnpm typecheck`, `pnpm verify:boundaries`.
- Export or packaging changes: also `pnpm verify:exports` and `pnpm verify:pack`.
- Test changes: `pnpm verify:hygiene`.
