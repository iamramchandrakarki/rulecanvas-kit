# Requirements Document

## Introduction

CI (`.github/workflows/ci.yml`) uploads a flat directory of release artifacts: four library tarballs, two static app archives, and `SHA256SUMS.txt`. This feature adds a local, release-only command, `pnpm verify:release:preflight --archive-dir DIR --output DIR`. It validates that exact directory, safely extracts the two static archives into a staging directory, exercises the extracted files in Chromium under two base paths, and publishes an upload directory only after every check passes. It never deploys and contacts only a loopback server it starts. It changes no library, app, or CI source.

## Glossary

- **Preflight**: The tool behind `verify:release:preflight`.
- **Archive_Directory**: The flat input directory. It holds exactly the Expected_Artifact_Set.
- **Expected_Artifact_Set**: `rulecanvas-core-<v>.tgz`, `rulecanvas-ui-<v>.tgz`, `rulecanvas-workbench-<v>.tgz`, `rulecanvas-workbench-react-<v>.tgz`, `agent-gate-static.tar.gz`, `interlock-sim-static.tar.gz`, and `SHA256SUMS.txt`. Each `<v>` is the `version` in the matching `packages/*/package.json`.
- **Manifest**: `SHA256SUMS.txt`, in `sha256sum` format, with exactly one line per archive (six lines).
- **Static_Archive**: `agent-gate-static.tar.gz` or `interlock-sim-static.tar.gz`.
- **Staging_Directory**: A fresh directory beside the Output_Path that holds `agent-gate/` and `interlock-sim/` until publication.
- **Output_Path**: The published Upload_Directory, whose only children are `agent-gate/` and `interlock-sim/`.
- **Base_Path**: `/` or `/rulecanvas-kit/`, the URL prefix under which the Staging_Directory is served.
- **Browser_Error**: A console error, uncaught page error, failed request, HTTP status 400 or higher, or any request to a non-loopback origin.
- **Test_Suite**: The regression tests run by `pnpm test:release:preflight`.

## Requirements

### Requirement 1: Command and Scope

**User Story:** As a release maintainer, I want one command that preflights the CI artifacts, so that I confirm the exact bytes before any deployment.

#### Acceptance Criteria

1. THE root `package.json` SHALL define `verify:release:preflight` and `test:release:preflight`.
2. IF `--archive-dir` or `--output` is missing, THEN THE Preflight SHALL print a usage message naming both to standard error and exit nonzero before reading or writing anything.
3. WHEN every check passes, THE Preflight SHALL exit 0 and print the Output_Path.
4. IF any check fails, THEN THE Preflight SHALL exit nonzero and print the failed check and the failing artifact or entry to standard error.
5. THE Preflight SHALL NOT deploy, commit, push, or contact any host other than its loopback server.
6. THE Preflight SHALL use only Node.js, Python 3 standard-library `gzip` and `tarfile`, and the installed Playwright module, and SHALL add no dependency, change no lockfile, and leave `packages/`, `apps/`, and `.github/` unchanged.

### Requirement 2: Directory, Manifest, and Checksums

**User Story:** As a release maintainer, I want missing, corrupt, extra, or substituted files caught first, so that only the intended artifacts are staged.

#### Acceptance Criteria

1. THE Preflight SHALL inspect each Archive_Directory member with `lstat` and fail naming any subdirectory, symbolic link, or other non-regular entry.
2. IF an Expected_Artifact_Set member is missing, or a file outside the set is present (including `rulecanvas-static-site.tar.gz`), THEN THE Preflight SHALL fail naming each such file.
3. THE Preflight SHALL reject a Manifest that is empty, lacks a final LF, has a malformed line (`<64 lowercase hex>`, two spaces, name), names a path-like or dot-leading file, repeats a file, names a file outside the set, or omits an archive, and SHALL name the line or file.
4. IF a computed SHA-256 digest differs from the Manifest digest, THEN THE Preflight SHALL fail naming the archive and both digests.
5. THE Preflight SHALL read each archive from disk once, and SHALL validate and extract the same captured bytes whose digest it verified.

### Requirement 3: Safe Bounded Extraction

**User Story:** As a release maintainer, I want the static archives extracted only as ordinary files inside their own destination, so that a hostile archive cannot write elsewhere.

#### Acceptance Criteria

1. THE Preflight SHALL validate every member of a Static_Archive before writing any byte, and SHALL also validate the structure of each library tarball without extracting it.
2. THE Preflight SHALL accept only regular-file and directory members, and SHALL reject links, devices, FIFOs, and every other type, naming the entry and its type.
3. THE Preflight SHALL reject absolute paths, `..` segments, backslashes, NUL bytes, duplicate paths, paths differing only by case, and paths that conflict as file and directory.
4. THE Preflight SHALL reject an archive with more than 2,000 members, a file above 16 MiB, total uncompressed content above 128 MiB, compressed input above 64 MiB, a path above 240 bytes or 16 levels, a truncated or malformed gzip or tar stream, a member whose declared size exceeds the data supplied, or trailing bytes that are not end-of-archive zero blocks.
5. THE Preflight SHALL create each file with exclusive-create, no-follow semantics and mode 0644, ignoring the mode, owner, and timestamp stored in the archive.
6. IF an extracted app lacks a regular `index.html` at its root, THEN THE Preflight SHALL fail naming the app.
7. THE limits SHALL accept both Static_Archives from the CI baseline run unchanged.

### Requirement 4: Staging and Publication

**User Story:** As a release maintainer, I want the upload directory published only after the browser checks pass and my inputs untouched.

#### Acceptance Criteria

1. IF the Output_Path exists in any form (including a symbolic link), or its parent does not exist, THEN THE Preflight SHALL fail before reading any archive and leave the path unmodified.
2. THE Preflight SHALL write only inside a fresh, uniquely named Staging_Directory beside the Output_Path until all checks pass, and SHALL then publish it with one rename.
3. WHEN a run fails, THE Preflight SHALL remove the Staging_Directory and any other temporary path it created, and SHALL NOT create the Output_Path.
4. THE Preflight SHALL leave every Archive_Directory member identical in name, size, mode, modification time, and SHA-256 digest after every run.

### Requirement 5: Browser Verification

**User Story:** As a release maintainer, I want the extracted apps exercised through real worker verification under both base paths, so that broken paths, links, or workers are caught.

#### Acceptance Criteria

1. THE Preflight SHALL serve only files from the Staging_Directory, bound to loopback on an ephemeral port, at both Base_Paths (entry URLs `<Base_Path>agent-gate/` and `<Base_Path>interlock-sim/`), with `text/javascript` for scripts, and SHALL close the browser and server on every exit path.
2. THE Preflight SHALL load Playwright through `PLAYWRIGHT_MODULE` with the same candidate order as `tests/browser/workbench-e2e.mjs`, and SHALL fail naming `PLAYWRIGHT_MODULE` before creating the Staging_Directory if it cannot.
3. UNDER each Base_Path, THE Preflight SHALL assert that each app's navigation link resolves to the sibling entry URL under the same Base_Path, and that following it renders the sibling workbench.
4. UNDER each Base_Path, THE Preflight SHALL assert for AgentGate `?preset=broken` a `VIOLATED` verdict with "Step 5 of 5" and `inv_no_confidential_publish`, and for `?preset=principled-fix` a `VERIFIED` verdict with "Goal reachable: Yes".
5. UNDER each Base_Path, THE Preflight SHALL assert for InterlockSim `?preset=broken` a `VIOLATED` verdict with "Step 6 of 6" and `inv_containment_seal`, and for `?preset=fixed` a `VERIFIED` verdict with "Goal reachable: Yes".
6. EACH verdict SHALL show the "Background Web Worker" execution mode, and Playwright SHALL observe a Worker whose URL lies under the page's Base_Path on the harness origin; a main-thread fallback SHALL fail.
7. THE Preflight SHALL record every Browser_Error, and any Browser_Error SHALL fail the run and be printed with its Base_Path, app, and URL.
8. A verdict that does not render within 30 seconds SHALL fail naming the Base_Path, app, and preset.

### Requirement 6: Regression Tests

**User Story:** As a maintainer, I want tests written first and shown to fail, then pass.

#### Acceptance Criteria

1. THE Test_Suite SHALL generate its fixtures at test time and SHALL NOT read the CI baseline directory.
2. THE Test_Suite SHALL cover a successful run and one failing case each for: a missing archive, a digest mismatch, an extra file, a duplicate Manifest entry, a Manifest entry outside the set, a symbolic-link archive, a subdirectory, an existing Output_Path, and a missing usage argument.
3. THE Test_Suite SHALL cover one failing case each for these Static_Archive defects: symbolic-link, hard-link, device, absolute path, `..` path, duplicate path, entry count above the limit, oversize file, truncated gzip, trailing garbage, and missing `index.html`.
4. THE Test_Suite SHALL assert, for failures, that no Staging_Directory or Output_Path remains and that inputs are unchanged.
5. THE Test_Suite SHALL cover a main-thread fallback and a Browser_Error each preventing publication, and SHALL fail rather than skip when Playwright cannot be loaded.
6. THE Test_Suite SHALL pass `pnpm verify:hygiene`.
7. THE failing run against the unimplemented Preflight SHALL be recorded before the implementation, and the passing run after it.
