# Requirements Document

## Introduction

RuleCanvasKit v0.8.0 Spec 1 adds a static landing page (the Hub) that links into both showcase workbenches, a return link from each workbench to the Hub, and an independently installable starter template. It also extends CI, the release preflight, and the boundary gates to cover the new files. It keeps every v0.7.0 behavior, the `DESIGN.md` tokens, the core engine semantics, and the acyclic four-library package graph.

Spec 1 must build and pass on its own. It does not add, import, or advertise `report.ts`, `delta.ts`, `check-model.mjs`, `pnpm check:model`, or report export. Those belong to Spec 2.

## Glossary

- **Hub**: the static landing page under `site/`, deployed at the root of the static site.
- **Workbench**: one of the two showcase apps, `apps/agent-gate` or `apps/interlock-sim`.
- **Starter_Template**: `templates/workbench-starter/`, the RuleCanvasKit Skeleton Crew Starter Template. It is not a third app and not a pnpm workspace package.
- **Base_Path**: the URL prefix that the static site is served under, either `/` or `/rulecanvas-kit/`.
- **Pack_Gate**: `scripts/verify-pack.mjs`.
- **Browser_Gate**: `tests/browser/workbench-e2e.mjs`, run by `pnpm test:browser`.
- **Preflight**: `scripts/release-preflight.mjs` with its archive and browser helpers.

## Requirements

### Requirement 1: Static Hub

**User Story:** As a visitor, I want one page that states the problem and opens either workbench at a chosen preset, so that I can reach a counterexample in one click.

#### Acceptance Criteria

1. THE Hub SHALL consist of static files under `site/` (`index.html`, `styles.css`, one script file, self-hosted IBM Plex Sans and IBM Plex Mono Latin WOFF2 files for weights 400, 500, and 600, and `fonts/OFL.txt`) and SHALL make zero requests to other origins.
2. THE `site/` directory SHALL NOT be listed in `pnpm-workspace.yaml`, and `apps/` SHALL contain only `agent-gate` and `interlock-sim`.
3. THE Hub SHALL use `DESIGN.md` tokens: OKLCH colors with Light, Dark, and System themes, 1px hairline panes, 2 to 4px radii, and motion durations from 90 to 280ms. Motion SHALL stop under `prefers-reduced-motion: reduce`.
4. THE Hub SHALL apply the stored theme from a blocking `<head>` script. The script SHALL read `localStorage.getItem('rulecanvas-theme')`, accept only `system`, `light`, or `dark`, and write only fixed attribute values, never interpolating the stored string into the DOM.
5. WHEN the Hub is shown at 1280x720 or 1440x900, THE first viewport SHALL contain the one-sentence problem statement, the System / Light / Dark switch, and two side-by-side panels for AgentGate and InterlockSim. Each panel SHALL have one primary link "Open Broken Scenario" and two quiet links "Vacuous Fix" and "Principled Fix".
6. THE preset links SHALL be relative: `./agent-gate/?preset=broken`, `./agent-gate/?preset=vacuous-fix`, `./agent-gate/?preset=principled-fix`, `./interlock-sim/?preset=broken`, `./interlock-sim/?preset=vacuous`, `./interlock-sim/?preset=fixed`. The same bytes SHALL work under both Base_Paths.
7. Below the first viewport, THE Hub SHALL show the four-layer package summary, a starter template quick start, a model-scope disclosure, a non-certification disclosure that claims neither runtime firewalling nor IEC 61508 or SIL certification, and a GitHub link with `rel="noopener noreferrer"`.
8. THE Hub SHALL NOT advertise features that Spec 1 does not ship, including `pnpm check:model` and report export.
9. Every verdict statement on the Hub SHALL match the result of running `verifyModel` on the named preset. A test SHALL check this.

### Requirement 2: Return navigation from both workbenches

**User Story:** As a workbench user, I want the RuleCanvasKit brand mark to take me back to the Hub, without losing unsaved edits by accident.

#### Acceptance Criteria

1. `@rulecanvas/workbench-react` SHALL export a domain-neutral `WorkbenchBrandLink` from `WorkbenchShell.tsx`. It SHALL render a link only when `isSafeSameOriginNavigationHref(href, allowedPrefix)` passes, and plain text otherwise.
2. Both workbenches SHALL wrap the brand mark and the "RuleCanvasKit" label in `WorkbenchBrandLink` with href `../`, overridable at build time by `VITE_HUB_URL`.
3. WHEN the editor has unsaved edits, activating the brand link SHALL open the existing `WorkbenchDiscardDialog` through `requestLinkNavigation`. "Stay Here" SHALL keep the edits. "Discard & Continue" SHALL navigate to the Hub.
4. The brand heading SHALL keep the visually hidden workbench name.

### Requirement 3: Starter_Template

**User Story:** As a developer, I want a small runnable template that I can copy out of the repository, install from local tarballs, test, and build.

#### Acceptance Criteria

1. THE Starter_Template SHALL live in `templates/workbench-starter/`, SHALL NOT be listed in `pnpm-workspace.yaml`, and SHALL describe itself as the RuleCanvasKit Skeleton Crew Starter Template.
2. THE Starter_Template SHALL model a CI/CD Production Release Gate with variables `stage`, `reviewed`, `hotfixBypass`, and `retries`, using the vocabulary of the `README.md` release-gate example. The broken variant SHALL violate `prod-requires-review`. The principled fix SHALL be `VERIFIED` with the `stage == "prod"` goal reachable.
3. THE Starter_Template SHALL use `createVerifyClient`, `installVerifyWorker`, `useVerificationSnapshot`, `VerdictSummary`, `AssumptionsList`, `WorkbenchNavigation`, and `createModelJsonCodec` with `{ duplicateKeys: 'reject' }`. Its stylesheet SHALL NOT depend on undocumented `rc-select-*` classes.
4. THE Starter_Template SHALL include `tests/model.test.mjs`, run with `node --test`.
5. THE Starter_Template `README.md` SHALL document a copy, local-tarball install, test, and Vite build workflow that runs outside the monorepo, and the root `pnpm-lock.yaml` SHALL stay unchanged.

### Requirement 4: Pack_Gate and Browser_Gate use the template

#### Acceptance Criteria

1. THE Pack_Gate SHALL copy `templates/workbench-starter/` as the only source of the consumer fixture, replacing the inline booking fixture.
2. THE Pack_Gate SHALL install the four packed tarballs offline, then run `node --test`, `tsc --noEmit` under both `NodeNext` and `Bundler`, and a Vite build.
3. WHEN `STARTER_FIXTURE_DIST` or `BOOKING_FIXTURE_DIST` is set, THE Pack_Gate SHALL copy the built template there, and THE Browser_Gate SHALL serve it under a subpath and check a worker-mode verdict for both variants.
4. THE Browser_Gate SHALL check the Hub under both Base_Paths: HTTP 200, no console errors, no requests to other origins, links that resolve under the Base_Path, Hub-to-workbench and workbench-to-Hub navigation, the discard guard, no theme flash, the first-viewport layout at 1280x720 and 1440x900, and axe-core WCAG A and AA in Light and Dark.

### Requirement 5: CI and Preflight

#### Acceptance Criteria

1. CI SHALL archive `site/` as `site-static.tar.gz` next to the two app archives and SHALL list all seven archives in `SHA256SUMS.txt`.
2. CI SHALL check that the three v0.8.0 Kiro workspace files are tracked and that `.kiro/agents` is not git-ignored.
3. THE Preflight SHALL require `site-static.tar.gz`, SHALL reject a top-level `agent-gate` or `interlock-sim` entry in it (compared case-insensitively), SHALL extract it into the staging root, and SHALL check under both Base_Paths that the Hub returns HTTP 200 with no console or network errors and that Hub-to-workbench and workbench-to-Hub navigation works.
4. `tests/release-preflight.test.mjs` SHALL cover the success path and the new failure cases.

### Requirement 6: Boundary gates

#### Acceptance Criteria

1. The overclaim test SHALL also scan `site/**`, `templates/**`, and `apps/*/index.html`, with case-insensitive patterns for "proves ... safe", "certified ... safety/interlock/verifier", "guaranteed safe/secure", "eliminates all", and "100% safe/secure".
2. `scripts/check-test-hygiene.mjs` SHALL scan `templates/`.
3. A boundary test SHALL fail if `site/` uses root-absolute asset or link paths, or references another origin other than the GitHub repository link.
