# Kiroween 2026 release plan

## Freeze the candidate

Use [draft PR #17](https://github.com/iamramchandrakarki/rulecanvas-kit/pull/17) (`feat/phase6-workbench-integration`) as the release candidate, and record its final reviewed head SHA and passing CI run ID before deployment or tagging. (Prior tested app and library baseline before adding release-preflight tooling: `634435e152faca6dfd70aed3abcee768d033568a`, [CI run 45767754874](https://github.com/iamramchandrakarki/rulecanvas-kit/actions/runs/45767754874).) The freeze covers the verifier, model format, UI, presets, and runtime dependencies. Keep the existing branches, tags, and evidence. If the selected source revision changes, record its exact SHA and use the passing evidence for that revision.

## Audit the submission

| Official requirement | Evidence and remaining action |
| --- | --- |
| Register and submit during the contest window | Entrant must confirm Devpost registration and submit by December 4, 2026 at 2:00 p.m. Pacific. |
| Eligible individual, team, or organization | Entrant must confirm age of majority, residence or domicile, team size of at most three where applicable, representative authorization, and any applicable regional or legal restrictions. Confirm sponsor, organizer, judge, household and affiliation exclusions or conflicts where applicable. |
| New work created during the submission period | The earliest visible commit is November 24, after the October 30 opening. Confirm when development actually started and disclose any incorporated pre-existing work beyond standard development resources. |
| Entrant ownership, rights, and third-party permissions | MIT license and repository source are present. Entrant must confirm original work, ownership and permission for dependencies, assets and demo media, and absence of disqualifying financial or preferential support. |
| Skeleton Crew category and two distinct app folders | AgentGate and InterlockSim live under `apps/agent-gate` and `apps/interlock-sim`. Both use the same model checker. Select Skeleton Crew in the form. Leave optional categories blank unless the entrant can provide the required evidence. |
| Working project on its intended platform | Both browser apps and their workers passed the local and CI gates. The staged archives passed a fresh same-origin smoke test at both a root and a repository subpath. |
| Functional app URLs and free judge access | Pending deployment. Provide direct URLs for both apps and keep them publicly accessible through the end of judging on January 29, 2027 at 1:00 p.m. Pacific. Verify signed out. |
| Public GitHub source, instructions, assets and detectable open-source license | GitHub reports PUBLIC and MIT. The candidate contains source, assets, and setup and build instructions. At submission, use a public repository link plus a direct link to the source revision matching the live apps. |
| Visible, tracked root `.kiro/` | Candidate tracks steering, the hook definition, the specs directory README, and `.kiro/specs/release-artifact-preflight/`. Preserve these paths and verify them on the submitted revision. |
| Working project built using Kiro and a factual usage write-up | Recorded Kiro review influenced the legacy worker fix and regression test, a separate CLI session loaded tracked steering, and `.kiro/specs/release-artifact-preflight/` executed the release preflight spec. The [write-up](../TOOL_ATTRIBUTION.md) describes all three activities. The judge decides whether the evidence establishes sufficient use. |
| Features and functionality described in English | Copy the [submission description](../SKELETON_CREW_SUBMISSION.md#project-description) and Kiro section into Devpost. Keep testing instructions and all other materials in English, or supply English translations. |
| Working demo footage, under three minutes, public on YouTube, with media rights | The staged 64-second recording shows both apps running, with English narration and captions. The entrant must confirm media rights, approve public upload, and verify signed-out playback and captions. Add the YouTube watch URL to Devpost. |

Complete all required form fields. If claiming an optional bonus, check its separate rule. Startup requires founder and profile information. Student requires eligibility and enrollment details for all members. Ghost of Kiroween Past requires prior registration. Kiro Crew App requires its own write-up and public repository. Blog and Social Blitz require qualifying public posts during the submission period. The Best Demo bonus uses the judging criteria. [Official rules](https://kiroween.devpost.com/rules)

## Stage the frozen build

Run these commands from the repository root on macOS with the locally staged, checksum-verified release evidence. On Linux, replace `shasum -a 256 -c` with `sha256sum -c`. Preserve the archive and manifest outside the host so a later rollback can reuse the same bytes.

```bash
set -e
candidate=634435e152faca6dfd70aed3abcee768d033568a
evidence="$PWD/.planning/2026-11-24-rulecanvaskit-development/evidence/634435e"
test "$(cat "$evidence/COMMIT")" = "$candidate"
(
  cd "$evidence/archives"
  shasum -a 256 -c SHA256SUMS.txt
)
site="$(mktemp -d)"
tar -xzf "$evidence/archives/rulecanvas-static-site.tar.gz" -C "$site"
test -f "$site/agent-gate/index.html"
test -f "$site/interlock-sim/index.html"
printf 'Upload directory: %s\n' "$site"
```

To preflight the hosted candidate from a passing GitHub Actions CI run (`<ci_run_id>`), download the CI artifact while it remains available. Use Node.js, Python 3, and the installed Playwright Chromium used by the [browser gate](../../README.md#build-pack-and-verification-instructions). Set `PLAYWRIGHT_MODULE` if Playwright is outside the default search paths.

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

The local and hosted archive commands produced identical app files. To repeat the origin-root smoke test, run `python3 -m http.server 4189 --bind 127.0.0.1 --directory "$site"`. For a repository-subpath test, copy both app directories under a `rulecanvas-kit` directory inside the server root and rerun the same checks with the `/rulecanvas-kit` prefix. Both placements passed on the extracted candidate with background workers and reciprocal navigation.

## Deploy after approval

Use one free Cloudflare Pages Direct Upload project. Upload the directory in `$site`, whose immediate children are the two app directories. Configuration is static assets with no remote build, no Functions, no custom domain, no access policy, and no navigation environment overrides. Both Vite builds use `base: './'` and link to the sibling directories. Give judges the two app URLs, including the trailing slashes. Cloudflare assigns the actual hostname. [Cloudflare Direct Upload](https://developers.cloudflare.com/pages/get-started/direct-upload/) · [Free plan limits](https://developers.cloudflare.com/pages/platform/limits/)

For a dashboard deployment, open **Workers & Pages → Create application → Drag and drop your files**. Set the project name to `rulecanvaskit` if available, upload `$site`, and deploy. The following CLI sequence is an equivalent option for an authorized Cloudflare account. Run project creation once.

```bash
npx --yes wrangler login
npx --yes wrangler pages project create rulecanvaskit --production-branch main
npx --yes wrangler pages deploy "$site" --project-name rulecanvaskit --branch main
```

For a GitHub Pages fallback, choose **Settings → Pages → Source → GitHub Actions** after approval. A manually triggered workflow should stage both verified archives in one directory, run `actions/configure-pages@v5`, and upload that directory with `actions/upload-pages-artifact@v4`. Deploy the uploaded artifact through `actions/deploy-pages@v4` in the `github-pages` environment with `pages: write` and `id-token: write`. Keep relative assets and sibling links. The expected base is `https://iamramchandrakarki.github.io/rulecanvas-kit`. [GitHub Pages workflow documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)

### Verify the public deployment

Replace the example base with the actual Pages URL. Include `/rulecanvas-kit` in the base for GitHub Pages.

```bash
base='https://<assigned-project>.pages.dev'
curl -fsSL -o /dev/null -w '%{http_code} %{url_effective}\n' "$base/agent-gate/?preset=broken"
curl -fsSL -o /dev/null -w '%{http_code} %{url_effective}\n' "$base/interlock-sim/?preset=broken"
```

1. Open each URL in a signed-out browser. Confirm HTTPS and the expected path and preset. Follow the two navigation links and confirm they stay on the same origin and, for GitHub Pages, under the repository prefix.
2. Run both verification actions. Confirm **Execution: Background Web Worker**, AgentGate's five-step violation, and InterlockSim's six-step violation. Inspect the worker request for HTTP 200 and a JavaScript content type. Check for uncaught errors and failed requests.
3. Open `/agent-gate/?preset=principled-fix` and `/interlock-sim/?preset=fixed` under the same base. Both should show `VERIFIED` and **Goal reachable: Yes**. Reload the pages and confirm the preset remains selected. Check at least one narrow layout.
4. Record the source SHA, CI run, site deployment ID, direct links, and smoke-test results. If a later deployment fails, restore the previous passing Pages deployment or re-upload its verified directory to the same project, then repeat the smoke test.

## Release artifact preflight spec

**Release artifact preflight.** [`.kiro/specs/release-artifact-preflight/`](../../.kiro/specs/release-artifact-preflight/requirements.md) specifies the local release command (`pnpm verify:release:preflight`) and regression suite (`pnpm test:release:preflight`) implemented in `scripts/release-preflight.mjs`, `scripts/release-preflight-archive.py`, `scripts/release-preflight-browser.mjs`, and `tests/release-preflight.test.mjs`.

- Validates directory membership, `SHA256SUMS.txt`, and bounded tar/gzip safety before extracting `agent-gate-static.tar.gz` and `interlock-sim-static.tar.gz` into a staging directory.
- Serves the staged output on loopback at `/` and `/rulecanvas-kit/` and verifies both workbenches in Chromium with `Background Web Worker` execution, preset verdicts, and reciprocal navigation before publishing the output directory via atomic rename.

[Kiro requirements-first spec workflow](https://kiro.dev/docs/specs/feature-specs/requirements-first/)

## Review as a judge

| Criterion | Best evidence and open concern |
| --- | --- |
| Potential impact | AgentGate shows why a permitted approval sequence can still violate a policy, and the goal column makes overblocking visible. Lead with release and workflow reviewers. The airlock example shows abstraction reuse in education. |
| Technological implementation | The exact BFS, replay, seeded differential tests and offline booking consumer show engineering depth. For the Kiro-specific criterion, show the review finding, its regression test, what the CLI steering actually enforced, and the executed release artifact preflight spec tracing requirements to tests. |
| Design | The flows go from preset to verdict to replay and repair. Direct links and an explanation of “goal reachable” give judges a quick starting point. Signed-out hosted checks remain open. |
| Innovation | The distinguishing idea is a small shared foundation that exposes both shortest counterexamples and goal reachability in two domains. The third-domain consumer is concrete reuse evidence. |
| Presentation | The 64-second demo shows both apps end to end and explains a vacuous fix. Pair the video with two direct links and state that proof applies to the declared models and bounds. |

The rules use a pass/fail check for category fit and tool use before five equally weighted judging criteria. Public links and demonstrated Kiro contribution are the highest remaining judging risks. [Official judging criteria](https://kiroween.devpost.com/rules)

## Approval order

Confirm entrant attestations and the exact source revision. Obtain approval for the PR merge and static deployment, then verify the public URLs. Obtain approval for the public YouTube upload and verify playback. Approve any GitHub tag and release separately using the [release notes](workbench-integration.md). Fill in the [submission checklist](../SKELETON_CREW_SUBMISSION.md#submission-checklist) and obtain Devpost submission approval before the deadline.

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
  --notes-file docs/releases/workbench-integration.md \
  "$release_archives"/*.tar.gz \
  "$release_archives"/*.tgz \
  "$release_archives/SHA256SUMS.txt"
```
