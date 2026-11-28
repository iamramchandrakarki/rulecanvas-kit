# Security Policy

## Scope and Threat Boundary

RuleCanvasKit (`@rulecanvas/core`) is a design-time finite-state model checker for Guarded Transition Systems (GTS).

- **What `@rulecanvas/core` guarantees**: Given a finite-state model and exploration bounds, `verifyModel` exhaustively checks reachable states within those bounds and reports `VERIFIED`, `VIOLATED` (with a shortest counterexample trace), `INCONCLUSIVE` (when `maxStates` or `maxDepth` is reached), or `INVALID` (on malformed inputs or out-of-domain transitions).
- **What RuleCanvasKit is not**: RuleCanvasKit is not a runtime policy enforcement engine, production firewall, prompt-injection filter, or physical safety controller. Verification verdicts hold strictly for the declared finite model under its explicit `ModelAssumption[]` list.

## Untrusted Input Hardening

`@rulecanvas/core` is designed to accept untrusted JSON-like model and option payloads safely:

- **No dynamic code execution**: Expressions are evaluated via a closed AST interpreter with zero `eval` or `Function` usage.
- **Bounded traversal**: Un-deduplicated AST walks enforce `depth <= 32` and `visits <= 256` (`AST_COMPLEXITY_EXCEEDED`) to prevent stack overflow and shared-reference DAG bombs.
- **Bounded state-space exploration**: `validateOptions` caps `maxStates <= 100,000` and `maxDepth <= 10,000`; schema validation caps variable count, enum cardinality/length, integer spans, rule counts, invariant counts, and assumption counts.
- **Prototype and accessor safety**: Validation captures a single `Reflect.ownKeys` snapshot per inspected object or array, rejects any own symbol property (`INVALID_SYMBOL_PROPERTY`), rejects own getter/setter accessors (`INVALID_ACCESSOR_PROPERTY`) across string and symbol keys without invoking accessor functions, rejects non-enumerable or undeclared own keys on schemas and state snapshots, ignores inherited properties such as `Object.prototype.goal`, rejects reserved prototype keys (`__proto__`, `constructor`, `prototype`), and formats untrusted values without invoking user `.toString()` or `Symbol.toPrimitive`.
- **Total error handling**: Top-level public functions catch exotic `Proxy` trap exceptions and other unexpected runtime errors, returning fresh, frozen structured `INVALID` / `{ ok: false }` results with `UNEXPECTED_INPUT_ERROR`.

## Browser workbenches

- The workbenches process models and results in the browser. The module worker runs the same verifier as direct execution, and `@rulecanvas/workbench/verify` reconstructs `VerifyResult` replies from allowlisted fields before deep-freezing.
- Verification clients correlate a reply with the active request, validate its shape and bounds, and bind replay to the captured model. Only supply worker factories you trust. Protocol correlation and replay checks do not establish that an arbitrary worker ran the engine.
- The portable codec checks structural and size budgets before accepting model JSON. Both workbenches and the shared codec reject duplicate keys (`duplicateKeys: 'reject'`) by default (the codec also exposes an opt-in `'last-value'` mode for explicit legacy callers).

## Reporting a Vulnerability

If you discover a security issue in RuleCanvasKit — such as an uncaught exception on untrusted input, a validator bypass, an AST complexity DoS, a soundness bug that produces a false `VERIFIED` verdict, or a prototype-pollution vector — please report it responsibly:

1. **Do not** open a public issue with exploit details before the issue has been triaged.
2. Report the vulnerability privately via GitHub Security Advisories for `iamramchandrakarki/rulecanvas-kit` (under the repository's **Security -> Advisories** tab).
3. Include a minimal reproduction payload or model JSON, the expected vs. actual verdict or behavior, and your Node.js version.

We aim to acknowledge reports within 5 business days and coordinate a fix and regression test before public disclosure.
