# Specifications Directory

This directory (`.kiro/specs/`) holds specification artifacts generated and executed in Kiro Spec mode through the IDE or CLI.

Specification execution history and task checklists are never fabricated or pre-populated here.

For repository-level architecture, formal core specifications (`docs/specs/01-gts-verification-core/`), and tooling disclosure, see:
- [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md)
- [`docs/TOOL_ATTRIBUTION.md`](../../docs/TOOL_ATTRIBUTION.md)
- [`docs/specs/01-gts-verification-core/requirements.md`](../../docs/specs/01-gts-verification-core/requirements.md)
- [`docs/specs/01-gts-verification-core/design.md`](../../docs/specs/01-gts-verification-core/design.md)
- [`docs/specs/01-gts-verification-core/tasks.md`](../../docs/specs/01-gts-verification-core/tasks.md)

## Status
- `release-artifact-preflight/`: all tasks complete. Tasks 1 and 2.1 were completed in Kiro Spec mode, and `tasks.meta.json` records them. Tasks 2, 2.2, 3, and 4 were verified in a Kiro IDE 1.5.49 session against the `v0.7.0` CI baseline (run `45972124919`). The verification record is at the end of [`tasks.md`](./release-artifact-preflight/tasks.md).
