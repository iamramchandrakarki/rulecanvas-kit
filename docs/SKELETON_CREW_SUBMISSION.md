# Kiroween 2026 Skeleton Crew submission draft

## Project description

**Tagline** · Find where rules fail together, replay the shortest counterexample, and check that a repair preserves the intended workflow.

Approval and safety rules can each look reasonable in isolation and still combine into a failure. RuleCanvasKit helps engineers and workflow reviewers find those failures before rollout. Describe a finite state model, the rules that change it, the invariants that must hold, the goal, and the assumptions. The verifier explores reachable states deterministically. It replays the shortest counterexample it finds and reports an inconclusive result when exploration stops at a bound.

One TypeScript foundation powers two browser workbenches in separate folders. [AgentGate](../apps/agent-gate/) replays a five-step approval-policy failure and compares candidate fixes. The comparison makes it clear when a fix blocks legitimate releases along with the violation. [InterlockSim](../apps/interlock-sim/) shows a six-step violation in an educational airlock model. You can inspect the schematic, try a guided repair, and verify that the modeled goal remains reachable. Both workbenches support preset links, model JSON, and interactive replay.

The verification core uses exact integer arithmetic and atomic transitions. Shared packages provide replay, model transport, and React bindings. A clean consumer built from the project tarballs verifies a third domain, a booking model. Model verdicts apply within the declared assumptions and exploration bounds.

## How we built it

The root [Kiro workspace](../.kiro/) tracks architectural steering, engine rules, a save-hook definition for core checks, and the [release artifact preflight spec](../.kiro/specs/release-artifact-preflight/requirements.md). Kiro reviewed the shared workbench integration and caught a compatibility defect in the legacy worker protocol, which we fixed with a regression test. A separate Kiro CLI session loaded the tracked architecture steering and explained the design boundary it enforces, and Kiro Spec mode generated and executed the release artifact preflight specification. The [tooling disclosure](./TOOL_ATTRIBUTION.md) describes all recorded activities and how checks were run.

The core uses differential property-based tests against an independent reference evaluator. The package and browser gates check the exported packages and both workbenches outside the development server.

## YouTube upload copy

**Title** · RuleCanvasKit | One Verifier, Two Workbenches | Kiroween 2026

**Description**

RuleCanvasKit finds sequences of rule changes that violate a model's invariants and replays the shortest counterexample. This 64-second demo follows an approval-policy failure in AgentGate, compares fixes that behave differently, and verifies a guided repair in the educational InterlockSim workbench.

- 0:00 AgentGate and the broken approval policy
- 0:09 Replay the shortest counterexample
- 0:19 Compare repairs and goal reachability
- 0:32 InterlockSim and the airlock trace
- 0:43 Apply the guided repair and verify again
- 0:54 The shared TypeScript foundation

Try AgentGate at `[approved AgentGate URL]`. Try InterlockSim at `[approved InterlockSim URL]`.

Submitted for Skeleton Crew at Kiroween 2026. Model verdicts apply to the declared models and assumptions. [Source, install instructions, and Kiro usage write-up](https://github.com/iamramchandrakarki/rulecanvas-kit)

## Demo video script

The timestamps follow the captioned recording. Both workbenches can be run from the [same-origin static preview](./releases/workbench-integration.md#preview-the-static-builds).

| Time | On screen | Narration |
| --- | --- | --- |
| 0:00–0:09 | Open AgentGate on **Broken Policy** and show `VIOLATED`. | RuleCanvasKit runs the same finite-state verifier in two different browser workbenches. AgentGate starts with a policy whose rules can combine into a failed safety check. |
| 0:09–0:19 | Replay the five-step counterexample and show the changed state and violated invariant. | Replay the shortest counterexample and inspect how the state changes after each transition. The final state violates the modeled invariant. |
| 0:19–0:32 | Open **Compare All 5 Presets**. Highlight the goal column for **Vacuous Fix** and **Principled Fix**. | The comparison shows why a passing invariant alone can be misleading. The vacuous fix makes the goal unreachable. The principled fix preserves safety and still reaches the goal. |
| 0:32–0:43 | Follow the **InterlockSim** link and show the schematic and six-step trace. | InterlockSim uses the same verification core for a different domain, an educational discrete airlock model. The operator console shows the counterexample and the state of both doors. |
| 0:43–0:54 | Select **Apply Principled Repair**, then **Verify Interlock Model**. Show `VERIFIED` and **Goal reachable: Yes**. | Apply the modeled repair and verify again. The reachable states satisfy the invariant and the goal remains reachable. Both results apply within each model and its stated assumptions. |
| 0:54–1:04 | Show the closing card with the shared layers and repository link. | The shared foundation contains the verifier, replay helpers, worker transport, and React adapters. Kiro steering keeps the package boundaries explicit. |

## Submission checklist

- [ ] Confirm entrant eligibility, project ownership, and registration. Confirm that the project began after October 30, 2026 at 9:00 a.m. Pacific time and disclose any incorporated pre-existing work as required.
- [ ] Provide both functional app URLs. Confirm that judges can access them without logging in and that hosting remains available through January 29, 2027.
- [ ] Link the public MIT-licensed [GitHub repository](https://github.com/iamramchandrakarki/rulecanvas-kit). Confirm that both app folders and the root `.kiro/` directory are visible at the reviewed revision.
- [ ] Include the English project description, select Skeleton Crew, and attach a factual Kiro usage write-up.
- [ ] Replace the app URL placeholders in the video description. Verify signed-out access and ensure the public apps match the source revision linked from Devpost.
- [ ] Upload the demo to YouTube with public visibility. Use English captions and original or authorized media. Keep the runtime under three minutes and test the URL signed out.
- [ ] Obtain maintainer approval and submit by December 4, 2026 at 2:00 p.m. Pacific time.

[Official Kiroween 2026 rules](https://kiroween.devpost.com/rules)
