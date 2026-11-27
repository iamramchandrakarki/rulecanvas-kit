# Design Document

## Overview

Spec 1 adds three deliverables and extends four gates. No `@rulecanvas/core` or `@rulecanvas/ui` source changes. One additive export in `@rulecanvas/workbench-react`.

| Deliverable | Location | Workspace member |
|---|---|---|
| Hub | `site/` | No |
| Return link | `WorkbenchShell.tsx` (`WorkbenchBrandLink`), both `App.tsx` files | Existing packages |
| Starter_Template | `templates/workbench-starter/` | No |

## Static site layout

The release site places the Hub at the root and each app in a sibling directory. Every Hub link is relative, so the same files work under `/` and `/rulecanvas-kit/`:

```
<base>/index.html            Hub
<base>/styles.css, hub.js, fonts/
<base>/agent-gate/           apps/agent-gate/dist
<base>/interlock-sim/        apps/interlock-sim/dist
```

Each app already builds with `base: './'`, so `../` from an app resolves to the Hub.

## Hub

- **Theme.** An inline blocking script in `<head>` mirrors the existing app script. It maps the stored value through a fixed allowlist and writes only the literals `light` or `dark` to `data-theme`. `hub.js` (deferred) wires the System / Light / Dark buttons, writes `rulecanvas-theme`, and follows `prefers-color-scheme` and `storage` events, matching `useWorkbenchTheme`. The apps read the same key on the same origin, so moving between the Hub and an app does not flash the wrong theme.
- **Tokens.** `site/styles.css` copies the token block from `apps/*/src/styles/tokens.css`, with font URLs rewritten to `./fonts/`. Only cobalt accent and neutral ink are used. Following the One-Signal Verdict Rule, the Hub shows no green, amber, or crimson, because it renders no live engine verdict.
- **First viewport.** A 48px header holds the brand, the GitHub link, and the theme switch. Below it come the problem statement as `h1` and one supporting line. Then two equal panels sit in a two-column grid (stacked below 880px). Each panel holds a name, a scenario sentence, a counterexample rail, a primary "Open Broken Scenario" link, and two quiet preset links. Each preset link carries its verdict as plain mono text.
- **Counterexample rail.** This is the signature element. It shows the rule ids of the broken preset's shortest counterexample, from `s0` to the violated invariant id. When the panel is hovered or focused, a cobalt line draws across the rail over 280ms with `--ease-out`, using `clip-path`. The text is visible before and during the motion. Under reduced motion the rail stays static.
- **Below the first viewport.** These sections follow: the package layers (four rows in one hairline table), the starter quick start (copyable shell block), "What a verdict means" (model scope), and "What RuleCanvasKit is not" (non-certification).
- **Claim check.** `site/index.html` carries `data-preset`, `data-expected-status`, `data-expected-goal`, and `data-trace` attributes. `tests/site-hub.test.ts` runs `verifyModel` on each app preset and compares the results with those attributes.

## Return link

`WorkbenchBrandLink({ href, allowedPrefix, className, title, onNavigate, children })` renders `<a>` when `isSafeSameOriginNavigationHref(href, allowedPrefix)` is true. Otherwise it renders `<span>` with the same children. In each app, the `<h1>` keeps its visually hidden workbench name outside the link. The click handler calls `requestLinkNavigation(HUB_HREF, 'RuleCanvasKit hub')` when the editor is dirty. That reuses the existing discard prompt, its `beforeunload` bypass, and its focus handling.

`HUB_HREF` is `import.meta.env.VITE_HUB_URL` when it is a string, and `../` otherwise. The same guarded `import.meta` access is used for the sibling URL variables.

## Starter_Template

```
templates/workbench-starter/
  package.json            name rulecanvas-workbench-starter, engines node >=22.18
  README.md               copy, pack, install, test, build
  index.html  vite.config.mjs  tsconfig.json (Bundler)  tsconfig.nodenext.json
  src/release-gate.ts     brokenReleaseGate, principledReleaseGate
  src/verify.worker.ts    installVerifyWorker(self)
  src/App.tsx             variant nav, JSON editor, verification panel
  src/main.tsx  src/styles.css
  tests/model.test.mjs    node --test; imports ../src/release-gate.ts via Node type stripping
```

Model (stage `draft | staging | prod`, `reviewed`, `hotfixBypass`, `retries` 0..1):

| Rule | Guard | Updates |
|---|---|---|
| `promote-staging` | `stage == draft` | `stage := staging` |
| `complete-review` | `stage == staging && !reviewed` | `reviewed := true` |
| `retry-build` | `stage == staging && retries < 1` | `stage := draft`, `retries += 1`, `reviewed := false` |
| `open-hotfix-bypass` | `stage == staging && retries == 1 && !hotfixBypass` | `hotfixBypass := true` |
| `promote-prod` (broken) | `stage == staging && (reviewed \|\| hotfixBypass)` | `stage := prod` |
| `promote-prod` (principled) | `stage == staging && reviewed` | `stage := prod` |

The invariant `prod-requires-review` is `stage != prod || reviewed`, and the goal `reach-prod` is `stage == prod`. The broken variant is `VIOLATED` with a 5-step shortest counterexample. The principled fix is `VERIFIED` with the goal reachable.

The app decodes the JSON editor text with `createModelJsonCodec(undefined, { duplicateKeys: 'reject' })`. The first argument is the limits override, so the options object goes second. If decoding succeeds, the app runs the worker client. If it fails, the app lists the codec errors. `WorkbenchNavigation` switches between `?variant=broken` and `?variant=principled`.

## Pack_Gate

The gate copies the template into the temporary consumer directory, skipping `node_modules` and `dist`. It then:

1. Checks that the template's `package.json` declares the four libraries and the toolchain dependencies.
2. Rewrites those specs to `file:` tarballs in the copy only.
3. Writes the `overrides` workspace file.
4. Installs offline.
5. Runs the Node ESM smoke test, `node --test tests/`, `tsc -p tsconfig.json` (Bundler), `tsc -p tsconfig.nodenext.json`, and `vite build`.
6. Copies `dist/` to `STARTER_FIXTURE_DIST`, or to `BOOKING_FIXTURE_DIST` for compatibility.

## Preflight

- **Archive helper.** It gains two options. `--dest-may-exist-empty` accepts an existing empty directory that is not a symlink. `--reject-top-level NAME`, which may be repeated, rejects a first path segment that matches NAME case-insensitively. The orchestrator first extracts `site-static.tar.gz` into the staging root, with `--require-index` and both reject flags. It then extracts each app into its own new subdirectory.
- **Browser helper.** For each Base_Path, it loads the Hub and requires HTTP 200 and an `h1`. It requires the six preset links to resolve under the Base_Path. It follows each "Open Broken Scenario" link to a `VIOLATED` verdict, then follows the brand link back to the Hub. Errors go through the existing console, `weberror`, `requestfailed`, HTTP, and other-origin detectors.

## Testing

- `packages/rulecanvas-workbench-react/tests`: `WorkbenchBrandLink` safe and unsafe rendering.
- `tests/site-hub.test.ts` (vitest): checks that the Hub's verdict claims and trace ids match `verifyModel`, that links are relative, that the theme script uses an allowlist, and that there is no Spec 2 advertising.
- `packages/rulecanvas-core/tests/boundaries.test.ts`: the extended overclaim scan, `site/` path portability, exactly two apps, and the workspace globs.
- `tests/release-preflight.test.mjs`: the seven-archive success path, a missing site archive, top-level collision with case folding, a site without `index.html`, and a Hub browser error.
- `tests/browser/workbench-e2e.mjs`: the Hub and Starter_Template journeys.
