## Summary

Describe the problem solved and the concrete changes in this pull request.

Closes #

## Changes

-
-

## Verification

Confirm that all required checks pass locally:

- [ ] `pnpm build`
- [ ] `pnpm typecheck`
- [ ] `pnpm --filter @rulecanvas/core exec tsc --noEmit -p tsconfig.json`
- [ ] `pnpm test`
- [ ] `pnpm verify:boundaries`
- [ ] `FC_SEED=918273645 pnpm --filter @rulecanvas/core exec vitest run tests/properties.test.ts`
- [ ] `pnpm bench`

## Core Engine Checklist (if modifying `packages/rulecanvas-core`)

- [ ] Zero runtime dependencies in `packages/rulecanvas-core/package.json`
- [ ] Strict ES2022 compatibility (`"lib": ["ES2022"]`, `"types": []`) and `.js` relative import specifiers
- [ ] No host-coupled APIs (`Date`, `performance`, `Math.random`, `globalThis`, `eval`, `Function`)
- [ ] Total validation for untrusted inputs (no uncaught exceptions, no accessor invocation)
- [ ] Unit, regression, or property-based tests added for all new or changed behavior
