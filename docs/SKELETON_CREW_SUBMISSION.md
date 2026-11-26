# Kiroween 2026 Skeleton Crew submission draft

## Project description

**Tagline** · Find where rules fail together, replay the shortest counterexample, and check that a repair preserves the intended workflow.

RuleCanvasKit is a TypeScript foundation for checking how rules interact over multiple steps. Give it a finite state schema, guarded transitions, invariants, a goal, and explicit assumptions. It exhaustively explores reachable states within the declared bounds, reports when exploration is incomplete, and replays the shortest counterexample it finds.

The same foundation powers two browser workbenches in separate folders. [AgentGate](../apps/agent-gate/) compares approval-policy models and shows when a repair preserves a legitimate release workflow. [InterlockSim](../apps/interlock-sim/) is an educational airlock model with a schematic, an operator console, guard explanations, and a guided repair. Both workbenches support preset links, model JSON, and interactive replay.

The verification core uses exact integer arithmetic and atomic transitions. Shared packages provide replay, model transport, and React bindings. A clean consumer built from the project tarballs verifies a third domain, a booking model. Model verdicts apply within the declared assumptions and exploration bounds.

## How we built it

The root [Kiro workspace](../.kiro/) tracks architectural steering, engine rules, and a save-hook definition for core checks. Kiro reviewed the shared workbench integration and caught a compatibility defect in the legacy worker protocol. We fixed it and added a regression check. A separate Kiro CLI session loaded the tracked architecture steering and explained the design boundary it enforces. The [tooling disclosure](./TOOL_ATTRIBUTION.md) describes the recorded activities and how the checks were run.

The core uses differential property-based tests against an independent reference evaluator. The package and browser gates check the exported packages and both workbenches outside the development server.

## Demo video script

The timestamps follow the captioned recording. Both workbenches can be run from the [same-origin static preview](./releases/workbench-integration.md#preview-the-static-builds).

| Time | On screen | Narration |
| --- | --- | --- |
| 0:00–0:09 | Open AgentGate on **Broken Policy** and show `VIOLATED`. | RuleCanvasKit runs the same finite-state verifier in two different browser workbenches. AgentGate starts with a policy whose rules can combine into a failed safety check. |
| 0:09–0:19 | Replay the five-step counterexample and show the changed state and violated invariant. | Replay the shortest counterexample and inspect how the state changes after each transition. The final state violates the modeled invariant. |
| 0:19–0:32 | Open **Compare All 5 Presets**. Highlight the goal column for **Vacuous Fix** and **Principled Fix**. | The comparison shows why a passing invariant alone can be misleading. The vacuous fix makes the goal unreachable. The principled fix preserves safety and still reaches the goal. |
| 0:32–0:43 | Follow the **InterlockSim** link and show the schematic and six-step trace. | InterlockSim uses the same verification core for a different domain, an educational discrete airlock model. The operator console shows the counterexample and the state of both doors. |
| 0:43–0:54 | Select **Apply Principled Repair**, then **Verify Interlock Model**. Show `VERIFIED` and **Goal reachable: Yes**. | Apply the modeled repair and verify again. The reachable states satisfy the invariant and the goal remains reachable. Both results apply within each model and its stated assumptions. |
| 0:54–1:04 | Show the shared package layout and Kiro steering. | The shared foundation contains the verifier, replay helpers, worker transport, and React adapters. Kiro steering keeps the package boundaries explicit. |

## Submission checklist

- [ ] Confirm entrant eligibility, project ownership, and registration. Confirm that the project began after October 30, 2026 at 9:00 a.m. Pacific time and disclose any incorporated pre-existing work as required.
- [ ] Provide both functional app URLs. Confirm that judges can access them without logging in and that hosting remains available through January 29, 2027.
- [ ] Link the public MIT-licensed [GitHub repository](https://github.com/iamramchandrakarki/rulecanvas-kit). Confirm that both app folders and the root `.kiro/` directory are visible at the reviewed revision.
- [ ] Include the English project description, select Skeleton Crew, and attach a factual Kiro usage write-up.
- [ ] Upload the demo to YouTube with public visibility. Use English captions and original or authorized media. Keep the runtime under three minutes and test the URL signed out.
- [ ] Obtain maintainer approval and submit by December 4, 2026 at 2:00 p.m. Pacific time.

[Official Kiroween 2026 rules](https://kiroween.devpost.com/rules)
