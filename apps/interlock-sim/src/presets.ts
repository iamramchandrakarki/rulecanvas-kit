import type { TransitionSystemModel } from '@rulecanvas/core';
import {
  bsl3AirlockBrokenModel,
  bsl3AirlockFixedModel,
  bsl3AirlockVacuousModel,
} from './scenarios/bsl3-airlock.js';

export type InterlockPresetVariant = 'broken' | 'fixed' | 'vacuous';

export interface InterlockPresetDescriptor {
  readonly variant: InterlockPresetVariant;
  readonly id: string;
  readonly shortLabel: string;
  readonly title: string;
  readonly summary: string;
  readonly interlockNote: string;
}

export const INTERLOCK_SIM_PRESETS: readonly InterlockPresetDescriptor[] = [
  {
    variant: 'broken',
    id: bsl3AirlockBrokenModel.id,
    shortLabel: 'Broken Override',
    title: 'BSL-3 Airlock (Broken Override Interlock)',
    summary:
      'Maintenance override bypasses both the purge cycle check and the negative-pressure interlock on open_inner_door.',
    interlockNote:
      'Permits a 6-step containment seal breach where the inner BSL-3 door opens under equalized pressure.',
  },
  {
    variant: 'fixed',
    id: bsl3AirlockFixedModel.id,
    shortLabel: 'Principled Fix',
    title: 'BSL-3 Airlock (Principled Interlock Fix)',
    summary:
      'Keeps negative pressure, closed outer door, occupancy, and UV-off mandatory while letting override waive only purge count.',
    interlockNote:
      'Verifies all 29 reachable states with both containment invariants intact and goal_safe_lab_entry reachable.',
  },
  {
    variant: 'vacuous',
    id: bsl3AirlockVacuousModel.id,
    shortLabel: 'Vacuous Lockout',
    title: 'BSL-3 Airlock (Vacuous Lockout Fix)',
    summary:
      'Sets the open_inner_door guard to literal false, permanently sealing the inner BSL-3 containment door.',
    interlockNote:
      'Passes safety invariants trivially across 23 states while making goal_safe_lab_entry permanently unreachable.',
  },
] as const;

export function getInterlockPresetDescriptor(
  variant: InterlockPresetVariant,
): InterlockPresetDescriptor {
  const found = INTERLOCK_SIM_PRESETS.find((item) => item.variant === variant);
  return found ?? INTERLOCK_SIM_PRESETS[0]!;
}

export function loadInterlockPresetModel(variant: InterlockPresetVariant): TransitionSystemModel {
  const source =
    variant === 'fixed'
      ? bsl3AirlockFixedModel
      : variant === 'vacuous'
        ? bsl3AirlockVacuousModel
        : bsl3AirlockBrokenModel;
  return structuredClone(source) as TransitionSystemModel;
}
