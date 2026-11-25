# Workbench integration release candidate

RuleCanvasKit now shares a portable model codec, verification transport, React snapshot controls, and preset navigation across AgentGate and InterlockSim. The verifier remains a pure ES2022 library. Each workbench still has its own model, production bundle, and module worker.

## Preview the static builds

Install the locked workspace with the Node and pnpm versions listed in the [README](../../README.md).

```bash
pnpm install --frozen-lockfile
pnpm build
preview_root=$(mktemp -d)
cp -R apps/agent-gate/dist "$preview_root/agent-gate"
cp -R apps/interlock-sim/dist "$preview_root/interlock-sim"
python3 -m http.server 4178 --bind 127.0.0.1 --directory "$preview_root"
```

Open [AgentGate](http://127.0.0.1:4178/agent-gate/) or [InterlockSim](http://127.0.0.1:4178/interlock-sim/). Try both navigation links and verify a preset in each app. The two sibling paths let relative navigation and module worker URLs resolve under the same origin, including when hosted under a repository subpath.

For an approved deployment, copy the same directory tree to the static host. Keep trailing-slash entry URLs so relative assets resolve correctly. Load each public URL in a clean browser session and verify the worker verdict, preset deep links, and reciprocal navigation.

## Release evidence

- Use the [verification commands](../../README.md#build-pack-and-verification-instructions) on the candidate commit. The CI run publishes commit-scoped screenshots, four library tarballs, two app archives, and a SHA-256 manifest.
- Check the release archives with `sha256sum -c SHA256SUMS.txt` on Linux or `shasum -a 256 -c SHA256SUMS.txt` on macOS.
- The two workbench adapter packages are workspace-private. The archive gate uses all four tarballs in a clean consumer to verify exports, TypeScript resolution, and browser worker bundling.
- After maintainer approval, tag the reviewed commit and use its own CI artifacts for the release. Restore the previous passing app artifacts at the same paths if a static deployment needs to be rolled back.
