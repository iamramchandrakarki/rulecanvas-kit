import type { TransitionSystemModel } from '@rulecanvas/core';
import {
  createApprovalLaunderingModel,
  type ApprovalLaunderingVariant,
} from './scenarios/approval-laundering.js';

export interface PresetDescriptor {
  readonly variant: ApprovalLaunderingVariant;
  readonly shortLabel: string;
  readonly title: string;
  readonly summary: string;
  readonly policyNote: string;
}

export const AGENT_GATE_PRESETS: readonly PresetDescriptor[] = [
  {
    variant: 'broken',
    shortLabel: 'Broken Policy',
    title: 'Approval Laundering (Broken)',
    summary:
      'Checks stage == "drafting" && approvalValid before publish without invalidating stale approvals after draft edits.',
    policyNote: 'Vulnerable to a 5-step post-approval secret append sequence.',
  },
  {
    variant: 'naive-patch-a',
    shortLabel: 'Naive Patch A',
    title: 'Approval Laundering (Naive Patch A)',
    summary:
      'Adds !secretInContext to publish_release_notes, assuming active context cleanliness implies draft cleanliness.',
    policyNote: 'Bypassed in 6 steps by appending the secret and flushing context before publish.',
  },
  {
    variant: 'naive-patch-b',
    shortLabel: 'Naive Patch B',
    title: 'Approval Laundering (Naive Patch B)',
    summary:
      'Blocks direct secret append while approvalValid is true, in addition to checking !secretInContext on publish.',
    policyNote: 'Bypassed in 7 steps by staging the secret in the scratchpad, flushing context, then importing.',
  },
  {
    variant: 'vacuous-fix',
    shortLabel: 'Vacuous Fix',
    title: 'Approval Laundering (Vacuous Fix)',
    summary:
      'Sets the publish_release_notes guard to literal false so no draft can ever be published.',
    policyNote: 'Satisfies the safety invariant vacuously while making the declared release goal unreachable.',
  },
  {
    variant: 'principled-fix',
    shortLabel: 'Principled Fix',
    title: 'Approval Laundering (Principled Fix)',
    summary:
      'Requires !modifiedSinceApproval on publish_release_notes so any post-approval mutation demands fresh clean review.',
    policyNote: 'Verified across all 61 reachable states with the clean edited release goal reachable.',
  },
] as const;

export function getPresetDescriptor(variant: ApprovalLaunderingVariant): PresetDescriptor {
  const found = AGENT_GATE_PRESETS.find((item) => item.variant === variant);
  if (found !== undefined) {
    return found;
  }
  return AGENT_GATE_PRESETS[0]!;
}

export function loadPresetModel(variant: ApprovalLaunderingVariant): TransitionSystemModel {
  return createApprovalLaunderingModel(variant);
}
