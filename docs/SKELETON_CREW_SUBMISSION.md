# Kiroween 2026 Skeleton Crew submission draft

## Project description

RuleCanvasKit is a TypeScript foundation for checking how rules interact over multiple steps. Give it a finite state schema, guarded transitions, invariants, a goal, and explicit assumptions. It exhaustively explores reachable states within the declared bounds, reports when exploration is incomplete, and replays the shortest counterexample it finds.

The same foundation powers two browser workbenches in separate folders. [AgentGate](../apps/agent-gate/) compares approval-policy models and shows when a repair preserves a legitimate release workflow. [InterlockSim](../apps/interlock-sim/) is an educational airlock model with a schematic, an operator console, guard explanations, and a guided repair. Both workbenches support preset links, model JSON, and interactive replay.

The verification core uses exact integer arithmetic and atomic transitions. Shared packages provide replay, model transport, and React bindings. A clean consumer built from the project tarballs verifies a third domain, a booking model. Model verdicts apply within the declared assumptions and exploration bounds.

## How we built it

The root [Kiro workspace](../.kiro/) tracks architectural steering, engine rules, and a save-hook definition for core checks. Kiro reviewed the shared workbench integration and caught a compatibility defect in the legacy worker protocol. We fixed it and added a regression check. A separate Kiro CLI session loaded the tracked architecture steering and explained the design boundary it enforces. The [tooling disclosure](./TOOL_ATTRIBUTION.md) describes the recorded activities and how the checks were run.

The core uses differential property-based tests against an independent reference evaluator. The package and browser gates check the exported packages and both workbenches outside the development server.

## Demo outline

1. Show AgentGate reporting a violation and replay a five-step counterexample.
2. Open the preset comparison. Show the difference between the goal-unreachable fix and the repair that leaves the goal reachable.
3. Navigate to InterlockSim. Step backward and forward in its six-step trace, apply the guided repair, and verify again.
4. Point to the shared package layout and the third-app verification gate. Close with the scope of the models and the Kiro work described in the accompanying write-up.

## Submission checklist

- [ ] Confirm entrant eligibility, project ownership, registration, and any required disclosure of pre-existing work.
- [ ] Provide both functional app URLs. Confirm that judges can access them without logging in and that hosting remains available through January 29, 2027.
- [ ] Link the public MIT-licensed [GitHub repository](https://github.com/iamramchandrakarki/rulecanvas-kit). Confirm that both app folders and the root `.kiro/` directory are visible at the reviewed revision.
- [ ] Include the English project description, select Skeleton Crew, and attach a factual Kiro usage write-up.
- [ ] Upload the demo to YouTube with public visibility. Use English captions and original or authorized media. Keep the runtime under three minutes and test the URL signed out.
- [ ] Obtain maintainer approval and submit by December 4, 2026 at 2:00 p.m. Pacific time.

[Official Kiroween 2026 rules](https://kiroween.devpost.com/rules)
