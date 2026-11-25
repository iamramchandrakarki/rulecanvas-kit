# RuleCanvasKit Strategy

## Vision

<!-- vision: author-approved 2026-11-24 -->

`RuleCanvasKit` exists so that engineers can prove how multi-step rule interactions fail before those rules ever reach deployment.
It serves engineers modeling AI agent permissions, approval workflows, and discrete safety interlocks as a reusable deterministic finite-state verification toolkit.
It owns exactly one thing: design-time finite-state verification, deterministic simulation, counterexample replay, and domain-agnostic inspection primitives for bounded Guarded Transition Systems.

### Exact verification and honest verdicts

The default pure ES2022 breadth-first search engine evaluates identical models and exploration bounds reproducibly into verdicts, shortest counterexamples, and step-by-step replay traces.
The verifier evaluates integer arithmetic with exact arbitrary precision, applies rule updates atomically against the pre-state, and rejects out-of-domain transitions instead of silently clamping values.
A `VERIFIED` verdict requires either complete explicit-state exploration or a sound proof under independently validated verification semantics.
An unresolved run terminated by a state, depth, or resource limit returns `INCONCLUSIVE` rather than claiming a proof, preserving exact truncation metadata where supported by the selected engine.
Verification checks both invariant safety and declared goal reachability to catch vacuous fixes, recognizing that goal reachability is not always decided when exploration terminates early.
Wall-clock timeouts, nondeterministic heuristics, and silent state-space pruning do not belong in the verification contract.
Interactive step simulation and counterexample replay reuse the exact validator, compiler, and evaluator as verification so traces never diverge from verdicts.
Optional symbolic verification backends may be isolated outside the default pure BFS engine when demonstrated user models exceed practical explicit-state limits.
Any optional solver backend must be independently validated for semantic correctness, distinguish its capabilities and guarantees clearly, claim shortest counterexamples only when established, and report inconclusive or unknown outcomes honestly.

### Pure core and layered boundaries

The mathematical verification core compiles as pure ES2022 with zero runtime dependencies and no host clocks, randomness, DOM, browser, React, or external service dependencies.
Shared domain-neutral UI primitives preserve framework-independent formatters, inspection contracts, and replay controllers backed solely by the core engine, escaping untrusted text and conveying verdicts through explicit status labels and semantic structure rather than color alone.
Optional React components, hooks, accessible dialogs, visual editors, and animations are welcome in application or appropriate UI layers, extracting a dedicated React adapter package only when real reuse justifies it, and must never duplicate validation, transition evaluation, or counterexample semantics.
AgentGate is the flagship application with the greatest intended commercial potential, while InterlockSim remains an educational discrete-state workbench welcoming additional discrete scenarios as proof of cross-domain reuse.
Core and shared inspection packages must never collapse into AgentGate or leak domain terminology, with automated AST boundary checks enforcing independent package boundaries.

### Untrusted input safety by construction

Every untrusted-input entry point of the mathematical core accepts arbitrary unknown inputs, catches unexpected runtime errors including Proxy traps that execute or throw, and returns structured diagnostics rather than throwing uncaught exceptions.
Validation inspects own-property snapshots and rejects own getters, setters, symbol keys, and reserved prototype names without calling accessor functions or user coercion methods, documenting exact property-access and exception-handling guarantees instead of claiming arbitrary JavaScript inputs can never run caller code.
Expressions run exclusively inside a closed, bounded, deterministic AST interpreter with zero dynamic code execution and no caller-provided predicate functions.
New declarative expression operators are welcome only when their semantics are formally specified, bounded, deterministic, independently tested, and compatible with untrusted-input hardening.
Verification verdicts, replay sessions, and validation diagnostics are returned as isolated fresh results and guarded by unit, regression, and differential property-based tests against an independent oracle.

### Guarded optional extensions

Optional AI-assisted policy modeling may live outside the pure verification core as an opt-in capability while keeping deterministic verification independent of AI providers and protecting confidential user data.
Generated models are treated as untrusted drafts that must pass validation and explicit review of assumptions, rules, invariants, and goals, and are never confused with proof that natural-language requirements were translated completely or correctly.
Optional domain-layer importers for manifests, IAM configurations, or CI workflows must document supported constructs, translate deterministically where possible, include independent translation and regression tests, and record unsupported semantics and assumptions without silently discarding security-relevant behavior.
Partial translations require explicit user review and must be distinguished from complete supported translations, and a verified abstraction must never be presented as proof that the original production configuration is secure.
Automated policy repair candidates must be checked by the deterministic verification engine and display their changes and behavioral consequences, where candidates with `INCONCLUSIVE` results may appear only as unverified suggestions and never as verified repairs.
Verified repairs must satisfy all declared invariants and required goal reachability, require explicit human approval without automatic deployment, explain model and assumption limits, never claim global minimality unless mathematically established, and remain suggestions rather than real-world security guarantees.
Local-first libraries, static web workbenches, and portable JSON models remain the baseline with Git-based workflows preferred, so using the toolkit never requires a hosted service.
Optional team collaboration services, versioned policy registries, or organizational review workflows may be added when genuine user demand justifies them, provided the verification engine stays independent of servers, databases, and authentication and appropriate security, privacy, and access controls are upheld.

### Explicit assumptions and honest claims

Every valid model declares explicit assumptions stating both what the discrete abstraction captures and what it leaves unmodeled.
Verification verdicts hold strictly within the declared finite model and its explicit assumptions, never claiming real-world security guarantees, complete production configuration safety, or physical safety certification.
Documentation, specifications, and workspace records stay truthful about what was actually executed and verified, never fabricating specification execution, test evidence, or human approval.
Human maintainer ownership governs every architectural contract and merge decision alongside transparent development attribution and genuine Kiro workspace usage.

### Scope

RuleCanvasKit is not a live runtime policy firewall, an MCP interception or security proxy, a prompt-injection filter, or a production enforcement service, even when an external runtime system consumes its verification engine.
It is not a continuous physics simulator, a probabilistic hardware failure model, a PLC code generator, or a certified physical safety controller, and InterlockSim must never distort the reusable engine toward physical control requirements.
This vision defines permanent product principles and acceptance gates rather than a temporary release scope or feature backlog.
The repository holds itself to its own verification standard through strict ES2022 type checks, unit and differential property tests, automated boundary enforcement, and anti-skip test hygiene on every change.

A change aligns when it strengthens deterministic finite-state verification, hardens untrusted-input or replay fidelity, advances AgentGate, InterlockSim, or domain-agnostic inspection layers, or adds guarded optional extensions that preserve core purity, explicit assumptions, and honest verification semantics.
A change should be resisted when it introduces nondeterminism, runtime or UI framework dependencies in the core, arbitrary executable predicates, domain collapse into shared packages, live production enforcement, automatic policy deployment, inflated verification or build guarantees, or unverified claims of real-world security or physical safety.
