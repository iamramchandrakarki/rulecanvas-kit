import type {
  BoolExpr,
  TransitionRule,
  TransitionSystemModel,
  ValueExpr,
  VerifyOptions,
} from '@rulecanvas/core';

// CI/CD production release gate. Each rule reads as a reasonable pipeline step on
// its own. In the broken variant they compose into a path that ships to prod
// without a review of the artifact that ships.

export const RELEASE_GATE_VARIANTS = ['broken', 'principled'] as const;
export type ReleaseGateVariant = (typeof RELEASE_GATE_VARIANTS)[number];

export const VERIFY_OPTIONS: VerifyOptions = { maxStates: 1_000, maxDepth: 20 };

export const PROD_REQUIRES_REVIEW = 'prod-requires-review';

const v = (name: string): ValueExpr & BoolExpr => ({ op: 'var', name });
const lit = (value: string | number): ValueExpr => ({ op: 'lit', value });
const stageIs = (stage: string): BoolExpr => ({ op: 'eq', left: v('stage'), right: lit(stage) });
const not = (arg: BoolExpr): BoolExpr => ({ op: 'not', arg });
const and = (...args: BoolExpr[]): BoolExpr => ({ op: 'and', args });
const or = (...args: BoolExpr[]): BoolExpr => ({ op: 'or', args });

const sharedRules: readonly TransitionRule[] = [
  {
    id: 'promote-staging',
    label: 'Promote the draft build to staging',
    guard: stageIs('draft'),
    updates: [{ var: 'stage', value: lit('staging') }],
  },
  {
    id: 'complete-review',
    label: 'Record a review of the staged artifact',
    guard: and(stageIs('staging'), not(v('reviewed'))),
    updates: [{ var: 'reviewed', value: { op: 'lit', value: true } }],
  },
  {
    id: 'retry-build',
    label: 'Rebuild after a failed staging check (the new artifact needs a new review)',
    guard: and(stageIs('staging'), { op: 'lt', left: v('retries'), right: lit(1) }),
    updates: [
      { var: 'stage', value: lit('draft') },
      { var: 'retries', value: { op: 'add', left: v('retries'), right: lit(1) } },
      { var: 'reviewed', value: { op: 'lit', value: false } },
    ],
  },
  {
    id: 'open-hotfix-bypass',
    label: 'Open the hotfix lane once the retry budget is spent',
    guard: and(stageIs('staging'), { op: 'eq', left: v('retries'), right: lit(1) }, not(v('hotfixBypass'))),
    updates: [{ var: 'hotfixBypass', value: { op: 'lit', value: true } }],
  },
];

function buildModel(variant: ReleaseGateVariant): TransitionSystemModel {
  const promoteProd: TransitionRule =
    variant === 'broken'
      ? {
          id: 'promote-prod',
          label: 'Promote staging to prod when reviewed or on the hotfix lane',
          guard: and(stageIs('staging'), or(v('reviewed'), v('hotfixBypass'))),
          updates: [{ var: 'stage', value: lit('prod') }],
        }
      : {
          id: 'promote-prod',
          label: 'Promote staging to prod only when the staged artifact is reviewed',
          guard: and(stageIs('staging'), v('reviewed')),
          updates: [{ var: 'stage', value: lit('prod') }],
        };

  return {
    id: `release-gate-${variant}`,
    name: 'CI/CD Production Release Gate',
    schema: {
      stage: { kind: 'enum', values: ['draft', 'staging', 'prod'] },
      reviewed: { kind: 'boolean' },
      hotfixBypass: { kind: 'boolean' },
      retries: { kind: 'int', min: 0, max: 1 },
    },
    initialState: { stage: 'draft', reviewed: false, hotfixBypass: false, retries: 0 },
    rules: [...sharedRules, promoteProd],
    invariants: [
      {
        id: PROD_REQUIRES_REVIEW,
        label: 'Production deployments must be reviewed',
        holds: or({ op: 'neq', left: v('stage'), right: lit('prod') }, v('reviewed')),
      },
    ],
    goal: { id: 'reach-prod', label: 'Reach production safely', reached: stageIs('prod') },
    assumptions: [
      {
        id: 'atomic-transitions',
        category: 'execution',
        statement: 'Each rule executes atomically against the current discrete state.',
        notModeled: 'Out-of-band manual changes or concurrent pipeline races.',
      },
      {
        id: 'single-artifact',
        category: 'scope',
        statement: 'One artifact moves through the pipeline at a time, with at most one retry.',
        notModeled: 'Parallel releases, rollbacks, and who is allowed to open the hotfix lane.',
      },
    ],
  };
}

export const RELEASE_GATE_MODELS: Readonly<Record<ReleaseGateVariant, TransitionSystemModel>> = {
  broken: buildModel('broken'),
  principled: buildModel('principled'),
};

export const RELEASE_GATE_LABELS: Readonly<Record<ReleaseGateVariant, { label: string; summary: string }>> = {
  broken: {
    label: 'Broken gate',
    summary: 'The hotfix lane can promote a rebuilt artifact that nobody reviewed.',
  },
  principled: {
    label: 'Principled fix',
    summary: 'The hotfix lane stays open, but promotion to prod always needs a review of the staged artifact.',
  },
};

export function isReleaseGateVariant(value: unknown): value is ReleaseGateVariant {
  return typeof value === 'string' && (RELEASE_GATE_VARIANTS as readonly string[]).includes(value);
}
