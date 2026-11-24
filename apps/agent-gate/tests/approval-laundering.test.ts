import {
  getEnabledTransitions,
  getInitialState,
  replayTrace,
  stepModel,
  validateModel,
  verifyModel,
  type StateSnapshot,
  type TransitionSystemModel,
  type VerifyOptions,
} from '@rulecanvas/core';
import { describe, expect, it } from 'vitest';
import {
  approvalLaunderingBrokenModel,
  approvalLaunderingNaivePatchAModel,
  approvalLaunderingNaivePatchBModel,
  approvalLaunderingPrincipledFixModel,
  approvalLaunderingVacuousFixModel,
  createApprovalLaunderingModel,
  type ApprovalLaunderingVariant,
} from '../src/index.js';

const VERIFY_OPTIONS: VerifyOptions = {
  maxStates: 10_000,
  maxDepth: 50,
};

function stateKey(state: StateSnapshot): string {
  return JSON.stringify([
    state['stage'],
    state['revision'],
    state['secretInContext'],
    state['stagedSecretNote'],
    state['draftConfidential'],
    state['approvalValid'],
    state['modifiedSinceApproval'],
  ]);
}

function enumerateReachableStates(model: TransitionSystemModel): readonly StateSnapshot[] {
  const init = getInitialState(model);
  if (!init.ok) {
    throw new Error(`Failed to get initial state: ${JSON.stringify(init.errors)}`);
  }

  const visited = new Map<string, StateSnapshot>([[stateKey(init.state), init.state]]);
  const queue: StateSnapshot[] = [init.state];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const enabled = getEnabledTransitions(model, current);
    if (!enabled.ok) {
      throw new Error(`Failed to get enabled transitions: ${JSON.stringify(enabled.errors)}`);
    }

    for (const ruleId of enabled.enabledRuleIds) {
      const stepped = stepModel(model, current, ruleId);
      if (!stepped.ok) {
        throw new Error(`Failed to step rule "${ruleId}": ${JSON.stringify(stepped.error)}`);
      }
      const next = stepped.step.stateAfter;
      const key = stateKey(next);
      if (!visited.has(key)) {
        visited.set(key, next);
        queue.push(next);
      }
    }
  }

  return [...visited.values()];
}

describe('AgentGate approval-laundering scenario', () => {
  it('validates all variants with sole safety invariant and explicit assumptions', () => {
    const variants: readonly ApprovalLaunderingVariant[] = [
      'broken',
      'naive-patch-a',
      'naive-patch-b',
      'principled-fix',
      'vacuous-fix',
    ];

    for (const variant of variants) {
      const model = createApprovalLaunderingModel(variant);
      expect(validateModel(model)).toEqual([]);
      expect(model.invariants).toHaveLength(1);
      expect(model.invariants[0]?.id).toBe('inv_no_confidential_publish');
      expect(model.goal?.id).toBe('goal_clean_edited_release');
      expect(model.assumptions.length).toBeGreaterThanOrEqual(3);
      expect(model.rules.map((rule) => rule.id)).toEqual([
        'draft_public_notes',
        'revise_public_notes',
        'human_approve_clean_draft',
        'read_signing_secret',
        'append_context_to_draft',
        'stage_secret_scratchpad',
        'flush_secret_context',
        'import_scratchpad_into_draft',
        'publish_release_notes',
      ]);
    }
  });

  it('1. Broken model is VIOLATED with a 5-step approval-laundering trace that replays cleanly', () => {
    const result = verifyModel(approvalLaunderingBrokenModel, VERIFY_OPTIONS);
    expect(result.status).toBe('VIOLATED');
    if (result.status !== 'VIOLATED') return;

    expect(result.violatedInvariantIds).toEqual(['inv_no_confidential_publish']);
    expect(result.trace).toHaveLength(5);

    const ruleSequence = result.trace.map((step) => step.ruleId);
    expect(ruleSequence).toEqual([
      'draft_public_notes',
      'human_approve_clean_draft',
      'read_signing_secret',
      'append_context_to_draft',
      'publish_release_notes',
    ]);

    const replayed = replayTrace(approvalLaunderingBrokenModel, ruleSequence);
    expect(replayed.ok).toBe(true);
    if (!replayed.ok) return;

    expect(replayed.steps).toEqual(result.trace);
    expect(replayed.finalState).toEqual(result.terminalState);
    expect(replayed.violatedInvariantIds).toEqual(['inv_no_confidential_publish']);
  });

  it('2. Naive Patch A is VIOLATED with a 6-step trace inserting flush_secret_context before publish', () => {
    const result = verifyModel(approvalLaunderingNaivePatchAModel, VERIFY_OPTIONS);
    expect(result.status).toBe('VIOLATED');
    if (result.status !== 'VIOLATED') return;

    expect(result.violatedInvariantIds).toEqual(['inv_no_confidential_publish']);
    expect(result.trace).toHaveLength(6);

    const ruleSequence = result.trace.map((step) => step.ruleId);
    expect(ruleSequence).toEqual([
      'draft_public_notes',
      'human_approve_clean_draft',
      'read_signing_secret',
      'append_context_to_draft',
      'flush_secret_context',
      'publish_release_notes',
    ]);

    const replayed = replayTrace(approvalLaunderingNaivePatchAModel, ruleSequence);
    expect(replayed.ok).toBe(true);
    if (!replayed.ok) return;

    expect(replayed.steps).toEqual(result.trace);
    expect(replayed.finalState).toEqual(result.terminalState);
    expect(replayed.violatedInvariantIds).toEqual(['inv_no_confidential_publish']);
  });

  it('3. Naive Patch B is VIOLATED with a 7-step scratchpad-laundering trace', () => {
    const result = verifyModel(approvalLaunderingNaivePatchBModel, VERIFY_OPTIONS);
    expect(result.status).toBe('VIOLATED');
    if (result.status !== 'VIOLATED') return;

    expect(result.violatedInvariantIds).toEqual(['inv_no_confidential_publish']);
    expect(result.trace).toHaveLength(7);

    const ruleSequence = result.trace.map((step) => step.ruleId);
    expect(ruleSequence).toEqual([
      'draft_public_notes',
      'human_approve_clean_draft',
      'read_signing_secret',
      'stage_secret_scratchpad',
      'flush_secret_context',
      'import_scratchpad_into_draft',
      'publish_release_notes',
    ]);

    const replayed = replayTrace(approvalLaunderingNaivePatchBModel, ruleSequence);
    expect(replayed.ok).toBe(true);
    if (!replayed.ok) return;

    expect(replayed.steps).toEqual(result.trace);
    expect(replayed.finalState).toEqual(result.terminalState);
    expect(replayed.violatedInvariantIds).toEqual(['inv_no_confidential_publish']);
  });

  it('4. Principled Fix is VERIFIED with exact stats, reachable-state guarantees, and clean goal trace', () => {
    const result = verifyModel(approvalLaunderingPrincipledFixModel, VERIFY_OPTIONS);
    expect(result.status).toBe('VERIFIED');
    if (result.status !== 'VERIFIED') return;

    expect(result.stats.theoreticalStates).toBe('384');
    expect(result.stats.statesExplored).toBe(61);
    expect(result.stats.deadlockStatesFound).toBe(12);
    expect(result.goalReachable).toBe(true);

    const reachableStates = enumerateReachableStates(approvalLaunderingPrincipledFixModel);
    expect(reachableStates).toHaveLength(61);

    const publishedStates = reachableStates.filter((state) => state['stage'] === 'published');
    expect(publishedStates).toHaveLength(12);
    for (const state of publishedStates) {
      expect(state['draftConfidential']).toBe(false);
      expect(state['approvalValid']).toBe(true);
      expect(state['modifiedSinceApproval']).toBe(false);
    }

    for (const state of reachableStates) {
      const enabled = getEnabledTransitions(approvalLaunderingPrincipledFixModel, state);
      expect(enabled.ok).toBe(true);
      if (!enabled.ok) continue;

      const tainted =
        state['draftConfidential'] === true ||
        state['secretInContext'] === true ||
        state['stagedSecretNote'] === true;

      if (tainted) {
        expect(enabled.enabledRuleIds).not.toContain('human_approve_clean_draft');
      }
    }

    const cleanGoalTrace = [
      'draft_public_notes',
      'revise_public_notes',
      'human_approve_clean_draft',
      'publish_release_notes',
    ];
    const replayedGoal = replayTrace(approvalLaunderingPrincipledFixModel, cleanGoalTrace);
    expect(replayedGoal.ok).toBe(true);
    if (!replayedGoal.ok) return;

    expect(replayedGoal.violatedInvariantIds).toEqual([]);
    expect(replayedGoal.goalReached).toBe(true);
    expect(replayedGoal.finalState['stage']).toBe('published');
    expect(replayedGoal.finalState['revision']).toBe(2);
    expect(replayedGoal.finalState['draftConfidential']).toBe(false);
    expect(replayedGoal.finalState['approvalValid']).toBe(true);
    expect(replayedGoal.finalState['modifiedSinceApproval']).toBe(false);
  });

  it('5. Vacuous Fix is VERIFIED with goalReachable === false', () => {
    const result = verifyModel(approvalLaunderingVacuousFixModel, VERIFY_OPTIONS);
    expect(result.status).toBe('VERIFIED');
    if (result.status !== 'VERIFIED') return;

    expect(result.goalReachable).toBe(false);
  });
});
