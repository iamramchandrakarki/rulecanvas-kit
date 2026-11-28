# Kiroween 2026 release plan

## Freeze the candidate

The `v0.8.0` candidate on branch `feat/v0.8.0-kiroween-skeleton-crew` is currently **unreleased and not yet deployed** (pending maintainer approval, merge to `main`, exact-SHA GitHub Actions CI verification, and static deployment). Once approved and merged, record the exact submission SHA and passing GitHub Actions CI run ID here. The freeze covers the verifier, model format, verification report and delta contracts, CLI gate, UI, presets, static hub, starter template, and runtime dependencies. Keep the existing branches, tags, and evidence. If the selected source revision changes, record its exact SHA and use the passing evidence for that revision.

## Audit the submission

| Official requirement | Evidence and remaining action |
| --- | --- |
| Register and submit during the contest window | Entrant must confirm Devpost registration and submit by December 4, 2026 at 2:00 p.m. Pacific. |
| Eligible individual, team, or organization | Entrant must confirm age of majority, residence or domicile, team size of at most three where applicable, representative authorization, and any applicable regional or legal restrictions. Confirm sponsor, organizer, judge, household and affiliation exclusions or conflicts where applicable. |
| New work created during the submission period | The earliest visible commit is November 24, after the October 30 opening. Confirm when development actually started and disclose any incorporated pre-existing work beyond standard development resources. |
| Entrant ownership, rights, and third-party permissions | MIT license and repository source are present. Entrant must confirm original work, ownership and permission for dependencies, assets and demo media, and absence of disqualifying financial or preferential support. |
| Skeleton Crew category and two distinct app folders | AgentGate and InterlockSim live under `apps/agent-gate` and `apps/interlock-sim`. Both use the same model checker. Select Skeleton Crew in the form. Leave optional categories blank unless the entrant can provide the required evidence. |
| Working project on its intended platform | Unreleased `v0.8.0` candidate (static hub, both browser apps with `Background Web Worker` execution, and standalone starter template) passed local verification gates and the seven-archive preflight smoke test at `/` and `/rulecanvas-kit/`. Exact-SHA GitHub Actions CI verification for the final candidate revision is pending. |
| Functional app URLs and free judge access | **Pending `v0.8.0` deployment and signed-out verification.** Historical Cloudflare Pages deployment (`rulecanvaskit` project, prior `v0.7.0` deployment `https://d100be44.rulecanvaskit.pages.dev`) currently serves pre-`v0.8.0` bundles at https://rulecanvaskit.pages.dev/agent-gate/ and https://rulecanvaskit.pages.dev/interlock-sim/ without the `v0.8.0` static hub (`/` returns HTTP 404). Deploying the verified `v0.8.0` seven-archive staging output and verifying signed-out HTTPS access to `/`, `/agent-gate/`, and `/interlock-sim/` with matching bundles, `Background Web Worker` execution, preset deep links, and reciprocal navigation remain pending maintainer approval. Keep hosting available through January 29, 2027 at 1:00 p.m. Pacific. |
| Public GitHub source, instructions, assets and detectable open-source license | GitHub reports PUBLIC and MIT. The `v0.8.0` candidate on branch `feat/v0.8.0-kiroween-skeleton-crew` contains source, assets, and setup and build instructions, pending PR merge, exact-SHA CI verification, and recording of the final public source SHA. At submission, use a public repository link plus a direct link to the source revision matching the live apps. |
| Visible, tracked root `.kiro/` | Candidate tracks steering (`.kiro/steering/`), `boundary-auditor` agent (`.kiro/agents/`), hook definitions (`.kiro/hooks/`), `.kiro/specs/README.md`, `.kiro/specs/release-artifact-preflight/`, and `.kiro/specs/skeleton-crew-hub-and-starter/`. Preserve these paths and verify them on the submitted revision. |
| Working project built using Kiro and a factual usage write-up | Recorded Kiro review influenced the legacy worker fix and regression test, a separate CLI session loaded tracked steering, `.kiro/specs/release-artifact-preflight/` executed the release preflight spec in Kiro Spec mode, and `.kiro/specs/skeleton-crew-hub-and-starter/` was executed in a Kiro IDE agent session (with Task 2.1 hook confirmation open). The [write-up](../TOOL_ATTRIBUTION.md) describes all recorded activities. The judge decides whether the evidence establishes sufficient use. |
| Features and functionality described in English | Copy the [submission description](../SKELETON_CREW_SUBMISSION.md#project-description) and Kiro section into Devpost. Keep testing instructions and all other materials in English, or supply English translations. |
| Working demo footage, under three minutes, public on YouTube, with media rights | The staged 64-second recording shows both apps running, with English narration and captions. The entrant must confirm media rights, approve public upload, and verify signed-out playback and captions. Add the YouTube watch URL to Devpost. |

Complete all required form fields. If claiming an optional bonus, check its separate rule. Startup requires founder and profile information. Student requires eligibility and enrollment details for all members. Ghost of Kiroween Past requires prior registration. Kiro Crew App requires its own write-up and public repository. Blog and Social Blitz require qualifying public posts during the submission period. The Best Demo bonus uses the judging criteria. [Official rules](https://kiroween.devpost.com/rules)

## Stage the candidate build

To preflight and stage the hosted candidate from a passing GitHub Actions CI run (`<ci_run_id>`), download the CI artifact while it remains available. Use Node.js, Python 3, and the installed Playwright Chromium used by the [browser gate](../../README.md#build-pack-and-verification-instructions). Set `PLAYWRIGHT_MODULE` if Playwright is outside the default search paths.

```bash
set -e
: "${ci_run_id:?Set the passing CI run ID for the selected revision}"
download="$(mktemp -d)"
gh run download "$ci_run_id" --repo iamramchandrakarki/rulecanvas-kit --dir "$download"
manifest="$(find "$download" -name SHA256SUMS.txt -type f -print)"
test -f "$manifest"
archives="$(dirname "$manifest")"
(cd "$archives" && shasum -a 256 -c SHA256SUMS.txt)
site="$(mktemp -d)/site"
pnpm verify:release:preflight --archive-dir "$archives" --output "$site"
printf 'Upload directory: %s\n' "$site"
```

On Linux, replace `shasum -a 256 -c` with `sha256sum -c`. `pnpm verify:release:preflight` extracts `site-static.tar.gz`, `agent-gate-static.tar.gz`, and `interlock-sim-static.tar.gz` into `$site` and runs the same-origin root (`/`) and `/rulecanvas-kit/` Chromium smoke checks before atomic output placement.

## Deploy after approval

Use one free Cloudflare Pages Direct Upload project. Upload the directory in `$site`, which contains the static hub at the root (`index.html` and assets) with `agent-gate/` and `interlock-sim/` as immediate subdirectories. Configuration is static assets with no remote build, no Functions, no custom domain, no access policy, and no navigation environment overrides. Both Vite builds use `base: './'` and link to `../` and sibling directories. Give judges the hub URL and the two app URLs, including the trailing slashes. Cloudflare assigns the actual hostname. [Cloudflare Direct Upload](https://developers.cloudflare.com/pages/get-started/direct-upload/) · [Free plan limits](https://developers.cloudflare.com/pages/platform/limits/)

For a dashboard deployment, open **Workers & Pages → Create application → Drag and drop your files**. Set the project name to `rulecanvaskit` if available, upload `$site`, and deploy. The following CLI sequence is an equivalent option for an authorized Cloudflare account. Run project creation once.

```bash
npx --yes wrangler login
npx --yes wrangler pages project create rulecanvaskit --production-branch main
npx --yes wrangler pages deploy "$site" --project-name rulecanvaskit --branch main
```

For a GitHub Pages fallback, choose **Settings → Pages → Source → GitHub Actions** after approval. A manually triggered workflow should stage all three verified static archives from the seven-archive CI bundle (`site-static.tar.gz` at the staging root, with `agent-gate-static.tar.gz` and `interlock-sim-static.tar.gz` extracted into `agent-gate/` and `interlock-sim/` beside it), run `actions/configure-pages@v5`, and upload that directory with `actions/upload-pages-artifact@v4`. Deploy the uploaded artifact through `actions/deploy-pages@v4` in the `github-pages` environment with `pages: write` and `id-token: write`. Keep relative assets and sibling links. The expected base is `https://iamramchandrakarki.github.io/rulecanvas-kit`. [GitHub Pages workflow documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)

### Verify the public deployment

Replace the example base with the actual Pages URL. Include `/rulecanvas-kit` in the base for GitHub Pages.

```bash
base='https://rulecanvaskit.pages.dev'
curl -fsSL -o /dev/null -w '%{http_code} %{url_effective}\n' "$base/"
curl -fsSL -o /dev/null -w '%{http_code} %{url_effective}\n' "$base/agent-gate/?preset=broken"
curl -fsSL -o /dev/null -w '%{http_code} %{url_effective}\n' "$base/interlock-sim/?preset=broken"
```

1. Open `"$base/"` and each app URL in a signed-out browser. Confirm HTTPS, the expected paths and presets, and working navigation between the static hub and both apps on the same origin (and under the repository prefix for GitHub Pages).
2. Run both verification actions. Confirm **Execution: Background Web Worker**, AgentGate's five-step violation, and InterlockSim's six-step violation. Inspect the worker request for HTTP 200 and a JavaScript content type. Check for uncaught errors and failed requests.
3. Open `/agent-gate/?preset=principled-fix` and `/interlock-sim/?preset=fixed` under the same base. Both should show `VERIFIED` and **Goal reachable: Yes**. Reload the pages and confirm the preset remains selected. Check at least one narrow layout.
4. Record the source SHA, CI run, site deployment ID, direct links, and smoke-test results. If a later deployment fails, restore the previous passing Pages deployment or re-upload its verified directory to the same project, then repeat the smoke test.

## Release artifact preflight spec

**Release artifact preflight.** [`.kiro/specs/release-artifact-preflight/`](../../.kiro/specs/release-artifact-preflight/requirements.md) specifies the local release command (`pnpm verify:release:preflight`) and regression suite (`pnpm test:release:preflight`) implemented in `scripts/release-preflight.mjs`, `scripts/release-preflight-archive.py`, `scripts/release-preflight-browser.mjs`, and `tests/release-preflight.test.mjs`.

- Validates directory membership, `SHA256SUMS.txt`, and bounded tar/gzip safety before extracting `site-static.tar.gz` into the staging root alongside `agent-gate-static.tar.gz` and `interlock-sim-static.tar.gz` into `agent-gate/` and `interlock-sim/` subdirectories.
- Serves the staged output on loopback at `/` and `/rulecanvas-kit/` and verifies the static hub and both workbenches in Chromium with `Background Web Worker` execution, preset verdicts, and reciprocal navigation before publishing the output directory via atomic rename.

[Kiro requirements-first spec workflow](https://kiro.dev/docs/specs/feature-specs/requirements-first/)

## Review as a judge

| Criterion | Best evidence and open concern |
| --- | --- |
| Potential impact | AgentGate shows why a permitted approval sequence can still violate a policy, and the goal column makes overblocking visible. Lead with release and workflow reviewers. The airlock example shows abstraction reuse in education. |
| Technological implementation | The exact BFS, replay, seeded differential tests, deterministic audit reports and delta comparison, `pnpm check:model` CLI gate, and standalone CI/CD release-gate starter template (`templates/workbench-starter/`) verified offline from packed tarballs show engineering depth. For the Kiro-specific criterion, show the review finding, its regression test, what the CLI steering actually enforced, and both `.kiro/specs/release-artifact-preflight/` and `.kiro/specs/skeleton-crew-hub-and-starter/` (noting Task 2.1 save-hook confirmation remains open). |
| Design | The flows go from preset to verdict to replay and repair. Direct links and an explanation of “goal reachable” give judges a quick starting point. The static hub, both workbenches, and the starter template passed local headless Chromium verification; signed-out HTTPS verification of the live `v0.8.0` deployment (hub plus both apps) is pending deployment approval. |
| Innovation | The distinguishing idea is a small shared foundation that exposes both shortest counterexamples and goal reachability in two domains. The standalone CI/CD release-gate starter template is concrete reuse evidence. |
| Presentation | The 64-second demo shows both apps end to end and explains a vacuous fix. Pair the video with two direct links and state that proof applies to the declared models and bounds. |

The rules use a pass/fail check for category fit and tool use before five equally weighted judging criteria. Public links and demonstrated Kiro contribution are the highest remaining judging risks. [Official judging criteria](https://kiroween.devpost.com/rules)

## Approval order

Confirm entrant attestations and the exact source revision. Obtain approval for the PR merge and static deployment, then verify the public URLs. Obtain approval for the public YouTube upload and verify playback. Approve any GitHub tag and release separately using the [release notes](v0.8.0.md). Fill in the [submission checklist](../SKELETON_CREW_SUBMISSION.md#submission-checklist) and obtain Devpost submission approval before the deadline.

After approval for a GitHub release, set `release_tag`, `release_sha`, and `release_archives` to the approved tag, verified post-merge revision, and its archive directory. If the merge produces a new SHA, use its passing CI and artifacts. Keep the published tag separate from the Devpost entry deadline.

```bash
set -e
: "${release_tag:?Set the approved release tag}"
: "${release_sha:?Set the verified source SHA}"
: "${release_archives:?Set the verified archive directory}"
(cd "$release_archives" && shasum -a 256 -c SHA256SUMS.txt)
git fetch origin main --tags
git merge-base --is-ancestor "$release_sha" origin/main
git tag -a "$release_tag" "$release_sha" -m "RuleCanvasKit $release_tag"
git push origin "refs/tags/$release_tag"
gh release create "$release_tag" \
  --repo iamramchandrakarki/rulecanvas-kit \
  --verify-tag \
  --notes-file docs/releases/v0.8.0.md \
  "$release_archives"/*.tar.gz \
  "$release_archives"/*.tgz \
  "$release_archives/SHA256SUMS.txt"
```
