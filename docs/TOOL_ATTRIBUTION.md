# Development & Tooling Disclosure

RuleCanvasKit is authored and maintained by Ramchandra Karki using AI-assisted software engineering tools for specification review, code implementation, testing, and verification, alongside Kiro workspace configuration files tracked under `.kiro/`.

## Engineering & Verification Practices

- **Maintainer ownership**: All architectural decisions, formal engine contracts, boundary rules, and merge approvals are owned and verified by the repository maintainer.
- **Reproducible verification**: Every change is validated deterministically via strict ES2022 TypeScript compilation, unit and regression tests, seeded property-based differential tests, package-boundary checks, and benchmarks (`pnpm test`, `pnpm verify:boundaries`, `pnpm verify:hygiene`, `pnpm bench`).
- **Kiro workspace configuration**: `.kiro/steering/` and `.kiro/hooks/` store versioned workspace rules (`inclusion: always` and `fileMatchPattern`) and a `PostFileSave` command hook definition aligned with Kiro's `v1` hook schema. The underlying `@rulecanvas/core` build and test commands referenced by the hook are executed directly via `pnpm` locally and in GitHub Actions CI.

## Specification Honesty Policy

- `.kiro/specs/` is reserved strictly for specifications genuinely executed in Kiro IDE.
- This repository contains no fabricated spec execution history, pre-populated Kiro task logs, or artificial human-only authorship claims.
- Repository-level architecture and formal core specifications live under [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md) and [`docs/specs/01-gts-verification-core/`](./specs/01-gts-verification-core/requirements.md):
  - [`requirements.md`](./specs/01-gts-verification-core/requirements.md)
  - [`design.md`](./specs/01-gts-verification-core/design.md)
  - [`tasks.md`](./specs/01-gts-verification-core/tasks.md)
