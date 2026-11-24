import type {
  BoolExpr,
  Goal,
  Invariant,
  ModelAssumption,
  StateSchema,
  StateSnapshot,
  StateValue,
  TransitionRule,
  TransitionSystemModel,
  UpdateAssignment,
  ValueExpr,
} from '@rulecanvas/core';

export type ApprovalLaunderingVariant =
  | 'broken'
  | 'naive-patch-a'
  | 'naive-patch-b'
  | 'principled-fix'
  | 'vacuous-fix';

const lit = (value: StateValue): ValueExpr => ({ op: 'lit', value });
const v = (name: string): ValueExpr => ({ op: 'var', name });
const bvar = (name: string): BoolExpr => ({ op: 'var', name });
const eq = (left: ValueExpr, right: ValueExpr): BoolExpr => ({ op: 'eq', left, right });
const lt = (left: ValueExpr, right: ValueExpr): BoolExpr => ({ op: 'lt', left, right });
const gte = (left: ValueExpr, right: ValueExpr): BoolExpr => ({ op: 'gte', left, right });
const add = (left: ValueExpr, right: ValueExpr): ValueExpr => ({ op: 'add', left, right });
const and = (...args: readonly BoolExpr[]): BoolExpr => ({ op: 'and', args });
const not = (arg: BoolExpr): BoolExpr => ({ op: 'not', arg });
const set = (varName: string, value: ValueExpr): UpdateAssignment => ({ var: varName, value });

export const APPROVAL_LAUNDERING_SCHEMA: StateSchema = {
  stage: { kind: 'enum', values: ['idle', 'drafting', 'published'] },
  revision: { kind: 'int', min: 0, max: 3 },
  secretInContext: { kind: 'boolean' },
  stagedSecretNote: { kind: 'boolean' },
  draftConfidential: { kind: 'boolean' },
  approvalValid: { kind: 'boolean' },
  modifiedSinceApproval: { kind: 'boolean' },
};

export const APPROVAL_LAUNDERING_INITIAL_STATE: StateSnapshot = {
  stage: 'idle',
  revision: 0,
  secretInContext: false,
  stagedSecretNote: false,
  draftConfidential: false,
  approvalValid: false,
  modifiedSinceApproval: false,
};

export const APPROVAL_LAUNDERING_INVARIANTS: readonly Invariant[] = [
  {
    id: 'inv_no_confidential_publish',
    label: 'Confidential draft must never be published',
    holds: not(and(eq(v('stage'), lit('published')), bvar('draftConfidential'))),
  },
];

export const APPROVAL_LAUNDERING_GOAL: Goal = {
  id: 'goal_clean_edited_release',
  label: 'Publish a clean, edited, freshly approved release draft (revision >= 2)',
  reached: and(
    eq(v('stage'), lit('published')),
    not(bvar('draftConfidential')),
    bvar('approvalValid'),
    not(bvar('modifiedSinceApproval')),
    gte(v('revision'), lit(2)),
  ),
};

export const APPROVAL_LAUNDERING_ASSUMPTIONS: readonly ModelAssumption[] = [
  {
    id: 'asm_synthetic_capability_abstraction',
    category: 'abstraction',
    statement:
      'Agent tool invocations and artifact mutations are represented as a finite-state synthetic capability model with revision bounded to 0..3.',
    notModeled:
      'Live LLM reasoning, natural-language release note text, partial redaction fidelity, and edit histories exceeding three revisions.',
  },
  {
    id: 'asm_declared_taint_channels_only',
    category: 'threat-boundary',
    statement:
      'Confidentiality taint propagates solely through the declared state flags (secretInContext, stagedSecretNote, draftConfidential) and explicit transition rules.',
    notModeled:
      'Prompt injection attacks, steganographic or covert encoding channels, side-channel leakage, and undeclared external tool invocations.',
  },
  {
    id: 'asm_publish_artifact_boundary',
    category: 'egress-boundary',
    statement:
      'The publish_release_notes action transmits only the release draft artifact (whose confidentiality is tracked by draftConfidential), not the active context window or scratchpad.',
    notModeled:
      'Telemetry, debug logging, or secondary egress paths that leak secretInContext or stagedSecretNote directly outside publish_release_notes.',
  },
  {
    id: 'asm_atomic_human_review',
    category: 'concurrency',
    statement:
      'Each transition executes atomically and human_approve_clean_draft accurately verifies that the draft, active context, and scratchpad are clean at approval time.',
    notModeled:
      'Concurrent multi-agent TOCTOU races during review or human reviewer misjudgment on visually deceptive content.',
  },
];

function buildPublishGuard(variant: ApprovalLaunderingVariant): BoolExpr {
  switch (variant) {
    case 'broken':
      return and(eq(v('stage'), lit('drafting')), bvar('approvalValid'));
    case 'naive-patch-a':
    case 'naive-patch-b':
      return and(
        eq(v('stage'), lit('drafting')),
        bvar('approvalValid'),
        not(bvar('secretInContext')),
      );
    case 'principled-fix':
      return and(
        eq(v('stage'), lit('drafting')),
        bvar('approvalValid'),
        not(bvar('modifiedSinceApproval')),
      );
    case 'vacuous-fix':
      return { op: 'lit', value: false };
  }
}

function buildRules(variant: ApprovalLaunderingVariant): readonly TransitionRule[] {
  const appendContextGuardArgs: BoolExpr[] = [
    eq(v('stage'), lit('drafting')),
    bvar('secretInContext'),
    lt(v('revision'), lit(3)),
  ];
  if (variant === 'naive-patch-b') {
    appendContextGuardArgs.push(not(bvar('approvalValid')));
  }

  return [
    {
      id: 'draft_public_notes',
      label: 'Draft initial public release notes',
      guard: eq(v('stage'), lit('idle')),
      updates: [set('stage', lit('drafting')), set('revision', lit(1))],
    },
    {
      id: 'revise_public_notes',
      label: 'Revise public release notes',
      guard: and(
        eq(v('stage'), lit('drafting')),
        lt(v('revision'), lit(3)),
        not(bvar('secretInContext')),
        not(bvar('draftConfidential')),
      ),
      updates: [
        set('revision', add(v('revision'), lit(1))),
        set('modifiedSinceApproval', lit(true)),
      ],
    },
    {
      id: 'human_approve_clean_draft',
      label: 'Human approves clean draft',
      guard: and(
        eq(v('stage'), lit('drafting')),
        not(bvar('draftConfidential')),
        not(bvar('secretInContext')),
        not(bvar('stagedSecretNote')),
      ),
      updates: [set('approvalValid', lit(true)), set('modifiedSinceApproval', lit(false))],
    },
    {
      id: 'read_signing_secret',
      label: 'Read signing secret into agent context',
      guard: and(eq(v('stage'), lit('drafting')), not(bvar('secretInContext'))),
      updates: [set('secretInContext', lit(true))],
    },
    {
      id: 'append_context_to_draft',
      label: 'Append secret context into release draft',
      guard: and(...appendContextGuardArgs),
      updates: [
        set('revision', add(v('revision'), lit(1))),
        set('draftConfidential', lit(true)),
        set('modifiedSinceApproval', lit(true)),
      ],
    },
    {
      id: 'stage_secret_scratchpad',
      label: 'Stage secret note into scratchpad',
      guard: and(eq(v('stage'), lit('drafting')), bvar('secretInContext')),
      updates: [set('stagedSecretNote', lit(true))],
    },
    {
      id: 'flush_secret_context',
      label: 'Flush signing secret from active context',
      guard: and(eq(v('stage'), lit('drafting')), bvar('secretInContext')),
      updates: [set('secretInContext', lit(false))],
    },
    {
      id: 'import_scratchpad_into_draft',
      label: 'Import staged scratchpad note into release draft',
      guard: and(
        eq(v('stage'), lit('drafting')),
        not(bvar('secretInContext')),
        bvar('stagedSecretNote'),
        lt(v('revision'), lit(3)),
      ),
      updates: [
        set('revision', add(v('revision'), lit(1))),
        set('draftConfidential', lit(true)),
        set('modifiedSinceApproval', lit(true)),
      ],
    },
    {
      id: 'publish_release_notes',
      label: 'Publish release notes externally',
      guard: buildPublishGuard(variant),
      updates: [set('stage', lit('published'))],
    },
  ];
}

const VARIANT_METADATA: Readonly<
  Record<ApprovalLaunderingVariant, { readonly id: string; readonly name: string }>
> = {
  broken: {
    id: 'agentgate-approval-laundering-broken',
    name: 'AgentGate: Approval Laundering (Broken)',
  },
  'naive-patch-a': {
    id: 'agentgate-approval-laundering-naive-patch-a',
    name: 'AgentGate: Approval Laundering (Naive Patch A)',
  },
  'naive-patch-b': {
    id: 'agentgate-approval-laundering-naive-patch-b',
    name: 'AgentGate: Approval Laundering (Naive Patch B)',
  },
  'principled-fix': {
    id: 'agentgate-approval-laundering-principled-fix',
    name: 'AgentGate: Approval Laundering (Principled Fix)',
  },
  'vacuous-fix': {
    id: 'agentgate-approval-laundering-vacuous-fix',
    name: 'AgentGate: Approval Laundering (Vacuous Fix)',
  },
};

export function createApprovalLaunderingModel(
  variant: ApprovalLaunderingVariant,
): TransitionSystemModel {
  const meta = VARIANT_METADATA[variant];
  return {
    id: meta.id,
    name: meta.name,
    schema: APPROVAL_LAUNDERING_SCHEMA,
    initialState: { ...APPROVAL_LAUNDERING_INITIAL_STATE },
    rules: buildRules(variant),
    invariants: APPROVAL_LAUNDERING_INVARIANTS,
    goal: APPROVAL_LAUNDERING_GOAL,
    assumptions: APPROVAL_LAUNDERING_ASSUMPTIONS,
  };
}

export const approvalLaunderingBrokenModel: TransitionSystemModel =
  createApprovalLaunderingModel('broken');

export const approvalLaunderingNaivePatchAModel: TransitionSystemModel =
  createApprovalLaunderingModel('naive-patch-a');

export const approvalLaunderingNaivePatchBModel: TransitionSystemModel =
  createApprovalLaunderingModel('naive-patch-b');

export const approvalLaunderingPrincipledFixModel: TransitionSystemModel =
  createApprovalLaunderingModel('principled-fix');

export const approvalLaunderingVacuousFixModel: TransitionSystemModel =
  createApprovalLaunderingModel('vacuous-fix');
