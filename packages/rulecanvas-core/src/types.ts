export type VarDef =
  | { readonly kind: 'boolean' }
  | { readonly kind: 'enum'; readonly values: readonly string[] }
  | { readonly kind: 'int'; readonly min: number; readonly max: number };

export type StateSchema = Readonly<Record<string, VarDef>>;

export type StateValue = boolean | string | number;

export type StateSnapshot = Record<string, StateValue>;

export type ValueExpr =
  | { readonly op: 'lit'; readonly value: StateValue }
  | { readonly op: 'var'; readonly name: string }
  | { readonly op: 'add' | 'sub'; readonly left: ValueExpr; readonly right: ValueExpr };

export type BoolExpr =
  | { readonly op: 'lit'; readonly value: boolean }
  | { readonly op: 'var'; readonly name: string }
  | { readonly op: 'eq' | 'neq'; readonly left: ValueExpr; readonly right: ValueExpr }
  | { readonly op: 'lt' | 'lte' | 'gt' | 'gte'; readonly left: ValueExpr; readonly right: ValueExpr }
  | { readonly op: 'in'; readonly expr: ValueExpr; readonly values: readonly StateValue[] }
  | { readonly op: 'and' | 'or'; readonly args: readonly BoolExpr[] }
  | { readonly op: 'not'; readonly arg: BoolExpr };

export interface UpdateAssignment {
  readonly var: string;
  readonly value: ValueExpr;
}

export interface TransitionRule {
  readonly id: string;
  readonly label: string;
  readonly guard: BoolExpr;
  readonly updates: readonly UpdateAssignment[];
}

export interface Invariant {
  readonly id: string;
  readonly label: string;
  readonly holds: BoolExpr;
}

export interface Goal {
  readonly id: string;
  readonly label: string;
  readonly reached: BoolExpr;
}

export interface ModelAssumption {
  readonly id: string;
  readonly category: string;
  readonly statement: string;
  readonly notModeled: string;
}

export interface TransitionSystemModel {
  readonly id: string;
  readonly name: string;
  readonly schema: StateSchema;
  readonly initialState: StateSnapshot;
  readonly rules: readonly TransitionRule[];
  readonly invariants: readonly Invariant[];
  readonly goal?: Goal;
  readonly assumptions: readonly ModelAssumption[];
}

export interface VerifyOptions {
  readonly maxStates: number;
  readonly maxDepth: number;
}

export interface VerifyStats {
  readonly theoreticalStates: string;
  readonly statesExplored: number;
  readonly transitionsEvaluated: number;
  readonly maxDepthReached: number;
  readonly deadlockStatesFound: number;
}

export interface TraceStep {
  readonly ruleId: string;
  readonly stateBefore: StateSnapshot;
  readonly stateAfter: StateSnapshot;
  readonly changedVars: readonly string[];
}

export interface ValidationError {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export type VerifyResult =
  | {
      readonly status: 'VERIFIED';
      readonly stats: VerifyStats;
      readonly goalReachable?: boolean;
      readonly assumptions: readonly ModelAssumption[];
    }
  | {
      readonly status: 'VIOLATED';
      readonly trace: readonly TraceStep[];
      readonly terminalState: StateSnapshot;
      readonly violatedInvariantIds: readonly string[];
      readonly stats: VerifyStats;
      readonly goalReachable?: true;
      readonly assumptions: readonly ModelAssumption[];
    }
  | {
      readonly status: 'INCONCLUSIVE';
      readonly reason: 'MAX_STATES' | 'MAX_DEPTH';
      readonly completedDepth: number;
      readonly frontierRemaining: number;
      readonly stats: VerifyStats;
      readonly goalReachable?: true;
      readonly assumptions: readonly ModelAssumption[];
    }
  | {
      readonly status: 'INVALID';
      readonly errors: readonly ValidationError[];
      readonly stats?: VerifyStats;
      readonly trace?: readonly TraceStep[];
    };

export interface EnabledTransition {
  readonly ruleId: string;
  readonly label: string;
  readonly enabled: boolean;
}

export type InitialStateResult =
  | { readonly ok: true; readonly state: StateSnapshot }
  | { readonly ok: false; readonly errors: readonly ValidationError[] };

export type EnabledTransitionsResult =
  | {
      readonly ok: true;
      readonly transitions: readonly EnabledTransition[];
      readonly enabledRuleIds: readonly string[];
    }
  | { readonly ok: false; readonly errors: readonly ValidationError[] };

export type StepResult =
  | { readonly ok: true; readonly step: TraceStep }
  | {
      readonly ok: false;
      readonly error: ValidationError;
      readonly errors?: readonly ValidationError[];
    };

export type ReplayResult =
  | {
      readonly ok: true;
      readonly steps: readonly TraceStep[];
      readonly finalState: StateSnapshot;
      readonly violatedInvariantIds: readonly string[];
      readonly goalReached?: boolean;
    }
  | {
      readonly ok: false;
      readonly stepIndex: number;
      readonly error: ValidationError;
      readonly errors?: readonly ValidationError[];
      readonly steps: readonly TraceStep[];
    };
