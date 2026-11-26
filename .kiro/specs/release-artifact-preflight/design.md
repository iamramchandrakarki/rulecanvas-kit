# Design Document

## Overview

A Node orchestrator coordinates a Python 3 archive helper and a Playwright browser helper. No tar parser is hand-written: Python's `gzip` and `tarfile` do all archive parsing. There are no new dependencies and nothing under `packages/` or `apps/` changes.

| File | Role |
| --- | --- |
| `scripts/release-preflight.mjs` | CLI: arguments, directory and manifest checks, staging, orchestration, publication, cleanup |
| `scripts/release-preflight-archive.py` | Bounded validate and extract of a `.tar.gz` read from stdin |
| `scripts/release-preflight-browser.mjs` | Loopback server and Playwright checks over the Staging_Directory |
| `tests/release-preflight.test.mjs` | Regression tests (`node:test`), fixtures generated at test time |

`package.json` gains `verify:release:preflight` (`node scripts/release-preflight.mjs`) and `test:release:preflight` (`node --test tests/release-preflight.test.mjs`).

## Architecture

The orchestrator is the only process that touches the Archive_Directory and the Output_Path. It runs the steps below in order.

1. Parse `--archive-dir` and `--output`. On missing arguments, print usage and exit 2 without touching disk.
2. `lstat` the Output_Path (must not exist) and its parent (must be a directory).
3. Load Playwright from `PLAYWRIGHT_MODULE`, then `playwright`, then the Homebrew fallback (same order as `tests/browser/workbench-e2e.mjs`).
4. `lstat` the Archive_Directory and each member. Compare names to the expected set, with versions read from the four package manifests.
5. Read `SHA256SUMS.txt` and parse it strictly. Read each archive once with `O_NOFOLLOW` into a Buffer (at most 64 MiB), hash that Buffer, and compare it with the manifest.
6. Pipe each verified Buffer to the Python helper on stdin. The helper re-checks the digest passed as an argument, so validation and extraction use the bytes that were hashed. Library tarballs are validated only. Static archives are extracted into `<staging>/agent-gate` or `<staging>/interlock-sim`.
7. Run the browser checks against the Staging_Directory.
8. `chmod 755` the Staging_Directory and `rename` it to the Output_Path. Print the Output_Path.
9. A `finally` block removes the Staging_Directory on any failure. Failures print `preflight FAILED [check] artifact: detail` to standard error and exit 1.

## Components and Interfaces

### Archive helper

Invocation: `python3 release-preflight-archive.py --name N --sha256 H [--dest DIR --require-index] < bytes`.

- Read at most 64 MiB plus one byte from stdin, then compare the SHA-256 digest.
- Decompress with `gzip.GzipFile` in chunks. Reject when the output exceeds 128 MiB plus 8 MiB of tar overhead. Truncation and malformed data raise `EOFError`, `BadGzipFile`, `zlib.error`, or `tarfile.TarError`, and become a rejection.
- Open the decompressed bytes with `tarfile.open(mode="r:")`. Pass 1 iterates the members without writing and enforces: type is `REGTYPE`, `AREGTYPE`, or `DIRTYPE`; path rules (no leading `/`, `\`, NUL, or `..`; at most 240 bytes and 16 segments); case-folded duplicate and file/directory conflicts; at most 2,000 members; at most 16 MiB per file and 128 MiB in total; `offset_data + size` within the stream. After the last member, the remaining bytes from `tf.offset` must be all zero and at least 1,024 long.
- Pass 2 (only with `--dest`): `os.mkdir(dest)` fails if it exists. Directories are created with 0755. Files are created with `os.open(O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW, 0o644)` and filled from `extractfile` in chunks. Owner, mode, and mtime from the archive are ignored. A final check requires a regular `index.html` at the destination root with `--require-index`.
- Exit 0 on success. On rejection, print one line to standard error and exit 1.

### Browser helper

`runBrowserChecks({ chromium, stagingDir })` starts one `http.createServer` on `127.0.0.1:0`. The server maps `/` and `/rulecanvas-kit/` prefixes onto the Staging_Directory, resolves paths with a containment check (403 or 404 otherwise, recorded as an error), and sets MIME types. For each Base_Path, it opens a fresh browser context that:

- aborts and records any request whose origin is not the harness origin (via `context.route`);
- records `console` errors, `weberror`, `requestfailed`, and responses with status 400 or higher;
- records `page.on("worker")` URLs.

Per app and preset, the helper loads `<origin><base><app>/?preset=<id>` and waits up to 30 seconds for `section.ag-verdict` or `section.is-verdict` with the expected `data-status`. It asserts the step text, the invariant name or "Goal reachable: Yes", the text `Execution: Background Web Worker`, and a worker URL under `<origin><base>`. On the broken page it asserts that the `nav a` href resolves to the sibling entry URL, clicks it (accepting a discard dialog if one appears), and waits for the sibling verdict section. After all pages, it fails if any error was recorded. Browser and server are closed in `finally`.

## Data Models

- Expected set: six archive names plus `SHA256SUMS.txt`, built from four `version` fields.
- Manifest entry: `{ digest: 64 lowercase hex, name }`, one per archive.
- Limits: 64 MiB compressed, 128 MiB uncompressed, 16 MiB per file, 2,000 members, 240 bytes and 16 levels per path.
- Browser error record: `{ basePath, app, url, text }`.

## Error Handling

Every failure carries a check name (`usage`, `output-path`, `playwright`, `archive-listing`, `manifest`, `checksum`, `archive`, `browser`) and an artifact. The orchestrator removes the Staging_Directory in `finally` and publishes only after the browser stage passes.

## Testing strategy

`node:test` with fixtures generated at test time: a small Python snippet builds archives with `tarfile` (hostile entries are added with `addfile`), and Node writes the manifest. Static fixtures are built from the existing `apps/*/dist` output, with optional HTML injection for failure cases (`delete Worker`, `console.error`). Failure tests assert exit status, stderr, no staging or output remnants, and unchanged input snapshots. Browser tests (success, main-thread fallback, Browser_Error) run Chromium. The CI baseline archive is run manually through `verify:release:preflight`, and the evidence is saved outside tracked paths.

## Traceability

Requirements 1 and 4 map to the orchestrator, 2 to the orchestrator checks, 3 to the archive helper, 5 to the browser helper, and 6 to the test file.
