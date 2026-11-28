# RuleCanvasKit Skeleton Crew Starter Template

A small React workbench that you copy out of the RuleCanvasKit repository and grow into your own. It models a CI/CD production release gate and uses all four RuleCanvasKit packages. The template is a starting point, not a third showcase app, and it is not part of the repository's pnpm workspace.

## The model

`src/release-gate.ts` defines two variants of the same pipeline. Both use the vocabulary of the release-gate example in the root `README.md`.

| Variable | Domain | Meaning |
|---|---|---|
| `stage` | `draft`, `staging`, `prod` | Where the artifact is |
| `reviewed` | boolean | The staged artifact has a recorded review |
| `hotfixBypass` | boolean | On-call opened the hotfix lane |
| `retries` | 0 to 1 | Rebuilds after a failed staging check |

The invariant `prod-requires-review` says that `stage == "prod"` implies `reviewed`. The goal `reach-prod` is `stage == "prod"`.

- **Broken gate** (`?variant=broken`). `retry-build` rebuilds the artifact and clears its review. `open-hotfix-bypass` opens the hotfix lane once the retry budget is spent. `promote-prod` accepts either a review or the hotfix lane. Each rule looks reasonable on its own. Together they give a 5-step path to prod with `reviewed: false`, so the verdict is `VIOLATED`.
- **Principled fix** (`?variant=principled`). `promote-prod` requires `reviewed` whatever the hotfix lane says. The verdict is `VERIFIED`, and the goal is still reachable.

A `VERIFIED` verdict covers this finite model within its state and depth bounds. It says nothing about your real pipeline beyond what the model and its assumptions describe.

## What the app wires together

| Package | Used for |
|---|---|
| `@rulecanvas/core` | Model types; `verifyModel` and `replayTrace` in the tests |
| `@rulecanvas/ui` | `buildVerdictSummaryView`, `buildVerificationReportFromSnapshot`, `formatVerificationReportMarkdown`, `serializeVerificationReportJson`, `sanitizeReportFilename`; `verifyAndBuildReport` in the tests |
| `@rulecanvas/workbench/model-json` | `createModelJsonCodec(undefined, { duplicateKeys: 'reject' })` decodes the editable JSON. The first argument overrides size limits, and the second sets the parsing policy. |
| `@rulecanvas/workbench/verify` | `createVerifyClient` with a module worker and main-thread fallback |
| `@rulecanvas/workbench/verify-worker` | `installVerifyWorker` in `src/verify.worker.ts` |
| `@rulecanvas/workbench-react` | `useVerificationSnapshot`, `VerdictSummary`, `AssumptionsList`, and `WorkbenchNavigation` for the variant links |

`src/styles.css` is a standalone stylesheet. It uses only the `className` props that you pass to the components, so you can replace it without depending on RuleCanvasKit's internal CSS.

## Use it outside the repository

The `@rulecanvas/*` packages are not published to npm. You install them from local tarballs.

Requirements:
- **Running and consuming existing tarballs:** Node.js 22.18 or later (`node --test` runs the TypeScript model through Node's built-in type stripping) and `pnpm`.
- **Packing the libraries from source (`pnpm run pack:local`):** also requires Python 3 (`python3`, standard library only) for archive normalization and preflight validation.

1. Clone the repository and pack the four libraries. `pack:local` writes the tarballs to `../rulecanvas-tarballs/`, next to the repository.

   ```bash
   git clone https://github.com/iamramchandrakarki/rulecanvas-kit.git
   cd rulecanvas-kit
   pnpm install
   pnpm run pack:local
   ```

2. Copy the template next to the tarball directory and install it. `package.json` and `pnpm-workspace.yaml` point at `../rulecanvas-tarballs/`. The `overrides` block also resolves the dependencies between the packages, such as `@rulecanvas/ui` depending on `@rulecanvas/core`, to those same tarballs.

   ```bash
   cp -R templates/workbench-starter ../my-workbench
   cd ../my-workbench
   pnpm install
   ```

3. Test, typecheck, and build.

   ```bash
   pnpm test          # node --test "tests/**/*.test.mjs"
   pnpm run typecheck # tsc under Bundler and NodeNext resolution
   pnpm build         # vite build into dist/
   pnpm preview       # serve dist/ locally
   ```

   `vite.config.mjs` uses `base: './'`, so `dist/` works from any subpath.

If you keep the tarballs somewhere else, update the four `file:` paths in both `package.json` and `pnpm-workspace.yaml`. When you upgrade RuleCanvasKit, run `pnpm run pack:local` again and update the version numbers in those paths.

## How the repository checks this template

`pnpm verify:pack` in the RuleCanvasKit repository copies this directory into a temporary folder. It installs the freshly packed tarballs offline, runs `node --test`, `tsc` under `NodeNext` and `Bundler`, and `vite build`, and checks that the worker bundle is emitted. The browser gate then serves the built `dist/` under a subpath and checks both variants in a real browser.

## Report export and CLI checks

The Verdict pane includes **Copy Markdown**, **Download Markdown**, and **Download JSON** actions built from the current non-stale committed snapshot (`validated-snapshot` provenance; disabled while running or when the JSON draft has unverified edits).

From the RuleCanvasKit repository root, you can also verify any saved model JSON directly with core verification (`recomputed-core` provenance):

```bash
pnpm check:model model.json
pnpm check:model model.json --markdown
pnpm check:model model.json --allow-vacuous
```

`pnpm check:model` exits `0` only on `VERIFIED` with a reachable goal (or no declared goal, unless `--allow-vacuous` is passed for a vacuous `VERIFIED` result). `VIOLATED`, `INCONCLUSIVE`, and runtime `INVALID` exit `1`; CLI or JSON decode errors exit `2`.

## Make it yours

- Change `src/release-gate.ts`, or paste a model into the JSON editor and select **Verify model**. The strict codec rejects duplicate keys and malformed values, and the app lists each error with its path.
- Keep a test in `tests/model.test.mjs` for every variant: the expected verdict and, for a failing model, the expected counterexample.
- Each assumption's `notModeled` text belongs next to the verdict. Do not hide it.
