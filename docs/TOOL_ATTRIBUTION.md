# Development & Tooling Disclosure

RuleCanvasKit is authored and maintained by Ramchandra Karki using AI-assisted software engineering tools for specification review, code implementation, testing, and verification, alongside Kiro workspace configuration files tracked under `.kiro/`.

## Engineering & Verification Practices

- **Maintainer ownership**: All architectural decisions, formal engine contracts, boundary rules, and merge approvals are owned and verified by the repository maintainer.
- **Reproducible verification**: Every change is validated deterministically via strict ES2022 TypeScript compilation, unit and regression tests, seeded property-based differential tests, package-boundary checks, and benchmarks (`pnpm test`, `pnpm verify:boundaries`, `pnpm verify:hygiene`, `pnpm bench`).
- **Kiro workspace configuration**: `.kiro/steering/`, `.kiro/agents/`, and `.kiro/hooks/` store versioned workspace rules (`architecture-boundaries.md`, `engine-correctness.md`, `workbench-ui-and-reports.md`), a read-only `boundary-auditor` agent definition, and `PostFileSave` hook definitions (`verify-core.json`, `verify-boundaries.json`). The underlying `@rulecanvas/core` build, boundary, and test commands are executed directly via `pnpm` locally and in GitHub Actions CI.
- **Kiro review**: Kiro independently reviewed the workbench integration against the package boundaries and verification contracts. It identified a legacy worker protocol mismatch and highlighted verdict metadata and preset-history cases that needed closer checks. Those findings guided the worker compatibility fix and regression tests.
- **Kiro CLI steering**: In a clean workspace containing the tracked Kiro configuration, Kiro CLI loaded the architecture steering and used it to explain why the verifier stays domain-neutral, deterministic, and separate from the browser workbenches.
- **Kiro Spec execution**: `.kiro/specs/release-artifact-preflight/` holds the requirements-first specification, design, and task plan executed in Kiro Spec mode for the local release artifact preflight (`scripts/release-preflight.mjs`, `scripts/release-preflight-archive.py`, `scripts/release-preflight-browser.mjs`, and `tests/release-preflight.test.mjs`; Tasks 1 and 2.1 recorded in `tasks.meta.json`, with remaining tasks verified in a Kiro IDE 1.5.49 session).
- **Kiro IDE agent session & boundary audit**: `.kiro/specs/skeleton-crew-hub-and-starter/` (`v0.8.0` Spec 1: static hub `site/`, `WorkbenchBrandLink`, and `templates/workbench-starter/`) was written and executed in a Kiro IDE 1.5.49 agent session rather than Spec-mode task execution (so no `tasks.meta.json` was generated). The read-only `boundary-auditor` agent audited the Spec 1 outputs across the five boundary areas, and Task 2.1 (confirming that `.kiro/hooks/verify-boundaries.json` triggers automatically on file save) remains open/unconfirmed; see [`.kiro/specs/README.md`](../.kiro/specs/README.md) and [`.kiro/specs/skeleton-crew-hub-and-starter/tasks.md`](../.kiro/specs/skeleton-crew-hub-and-starter/tasks.md).
- **Spec 2 implementation outside Kiro**: The `v0.8.0` Spec 2 deliverables (deterministic verification reports, verdict deltas, `pnpm check:model` CLI, transport/import hardening, and responsive UX polish) were implemented and verified in T3 Code following the tracked `.kiro/steering/` rules (`architecture-boundaries.md`, `engine-correctness.md`, `workbench-ui-and-reports.md`), without fabricating Kiro Spec-mode metadata.

## Specification Honesty Policy

- `.kiro/specs/` holds Kiro-authored specifications with factual execution disclosures (Spec-mode execution vs. Kiro IDE agent sessions).
- This repository contains no fabricated spec execution history, pre-populated Kiro task logs, or artificial human-only authorship claims.
- Repository-level architecture and formal core specifications live under [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md) and [`docs/specs/01-gts-verification-core/`](./specs/01-gts-verification-core/requirements.md):
  - [`requirements.md`](./specs/01-gts-verification-core/requirements.md)
  - [`design.md`](./specs/01-gts-verification-core/design.md)
  - [`tasks.md`](./specs/01-gts-verification-core/tasks.md)
