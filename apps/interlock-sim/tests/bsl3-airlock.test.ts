import { describe, expect, it } from 'vitest';
import { getEnabledTransitions, replayTrace, validateModel, verifyModel } from '@rulecanvas/core';
import {
  bsl3AirlockAssumptions,
  bsl3AirlockBrokenModel,
  bsl3AirlockDefaultOptions,
  bsl3AirlockFixedModel,
  bsl3AirlockVacuousModel,
} from '../src/index.js';

describe('BSL-3 Bio-Containment Airlock & UV Decontamination scenario', () => {
  it('declares valid schemas and honest educational non-certification assumptions', () => {
    expect(validateModel(bsl3AirlockBrokenModel)).toEqual([]);
    expect(validateModel(bsl3AirlockFixedModel)).toEqual([]);
    expect(validateModel(bsl3AirlockVacuousModel)).toEqual([]);

    const combinedText = bsl3AirlockAssumptions
      .map((a) => `${a.statement} ${a.notModeled}`)
      .join(' ')
      .toLowerCase();

    expect(combinedText).toContain('educational');
    expect(combinedText).toContain('iec 61508');
    expect(combinedText).toContain('sil');
    expect(combinedText).toContain('continuous pressure decay');
    expect(combinedText).toContain('sensor faults');
    expect(combinedText).toContain('mechanical seal failure');
    expect(combinedText).not.toContain('certified safety software');
  });

  it('broken policy finds a >= 4-step containment violation verified by replayTrace', () => {
    const result = verifyModel(bsl3AirlockBrokenModel, bsl3AirlockDefaultOptions);

    expect(result.status).toBe('VIOLATED');
    if (result.status !== 'VIOLATED') return;

    expect(result.trace.length).toBeGreaterThanOrEqual(4);
    expect(result.violatedInvariantIds).toEqual(['inv_containment_seal']);
    expect(result.terminalState['innerDoor']).toBe('open');
    expect(result.terminalState['pressure']).toBe('equalized');
    expect(result.terminalState['maintenanceOverride']).toBe(true);

    const ruleIds = result.trace.map((step) => step.ruleId);
    const replayed = replayTrace(bsl3AirlockBrokenModel, ruleIds);
    expect(replayed.ok).toBe(true);
    if (!replayed.ok) return;

    expect(replayed.steps).toEqual(result.trace);
    expect(replayed.finalState).toEqual(result.terminalState);
    expect(replayed.violatedInvariantIds).toEqual(['inv_containment_seal']);
  });

  it('principled fix verifies all invariants, reaches goal, and explores >= 12 states', () => {
    const result = verifyModel(bsl3AirlockFixedModel, bsl3AirlockDefaultOptions);

    expect(result.status).toBe('VERIFIED');
    if (result.status !== 'VERIFIED') return;

    expect(result.goalReachable).toBe(true);
    expect(result.stats.statesExplored).toBeGreaterThanOrEqual(12);
    expect(result.stats.theoreticalStates).toBe('192');

    // Verify normal safe entry workflow reaches the goal with zero invariant violations
    const safeEntry = replayTrace(bsl3AirlockFixedModel, [
      'equalize_pressure',
      'open_outer_door',
      'enter_airlock',
      'close_outer_door',
      'establish_negative_pressure',
      'run_air_purge',
      'open_inner_door',
    ]);
    expect(safeEntry.ok).toBe(true);
    if (!safeEntry.ok) return;

    expect(safeEntry.violatedInvariantIds).toEqual([]);
    expect(safeEntry.goalReached).toBe(true);
    expect(safeEntry.finalState).toEqual({
      outerDoor: 'closed',
      innerDoor: 'open',
      pressure: 'negative',
      uvSterilizer: 'off',
      occupied: true,
      purgeCycles: 1,
      maintenanceOverride: false,
    });

    // Verify UV sterilizer cannot start while occupied
    const enabledWhileOccupied = getEnabledTransitions(bsl3AirlockFixedModel, safeEntry.finalState);
    expect(enabledWhileOccupied.ok).toBe(true);
    if (!enabledWhileOccupied.ok) return;
    expect(enabledWhileOccupied.enabledRuleIds).not.toContain('start_uv_sterilization');

    // Verify UV decontamination cycle works safely when airlock is empty and sealed
    const uvCycle = replayTrace(bsl3AirlockFixedModel, [
      'start_uv_sterilization',
      'stop_uv_sterilization',
    ]);
    expect(uvCycle.ok).toBe(true);
    if (!uvCycle.ok) return;
    expect(uvCycle.violatedInvariantIds).toEqual([]);
    expect(uvCycle.steps[0]?.stateAfter['uvSterilizer']).toBe('active');
    expect(uvCycle.finalState['uvSterilizer']).toBe('off');
  });

  it('vacuous fix passes invariants trivially while flagging goalReachable === false', () => {
    const result = verifyModel(bsl3AirlockVacuousModel, bsl3AirlockDefaultOptions);

    expect(result.status).toBe('VERIFIED');
    if (result.status !== 'VERIFIED') return;

    expect(result.goalReachable).toBe(false);
    expect(result.stats.statesExplored).toBeGreaterThanOrEqual(12);
  });
});
