export {
  APPROVAL_LAUNDERING_ASSUMPTIONS,
  APPROVAL_LAUNDERING_GOAL,
  APPROVAL_LAUNDERING_INITIAL_STATE,
  APPROVAL_LAUNDERING_INVARIANTS,
  APPROVAL_LAUNDERING_SCHEMA,
  approvalLaunderingBrokenModel,
  approvalLaunderingNaivePatchAModel,
  approvalLaunderingNaivePatchBModel,
  approvalLaunderingPrincipledFixModel,
  approvalLaunderingVacuousFixModel,
  createApprovalLaunderingModel,
  type ApprovalLaunderingVariant,
} from './scenarios/approval-laundering.js';

export {
  AGENT_GATE_PRESETS,
  getPresetDescriptor,
  loadPresetModel,
  type PresetDescriptor,
} from './presets.js';

export {
  addAssumption,
  addInvariant,
  addRule,
  addRuleUpdate,
  addSchemaVariable,
  appendGuardClause,
  appendRuleGuardClause,
  createDefaultBoolExpr,
  createDefaultRule,
  createDefaultValueExpr,
  defaultValueForVarDef,
  exportModelToJson,
  firstVariableOfKind,
  getErrorsForPathPrefix,
  importModelFromJson,
  indexModelDiagnostics,
  isValueCompatibleWithVarDef,
  moveRule,
  parseStrictIntegerDraft,
  removeAssumption,
  removeInvariant,
  removeRule,
  removeRuleUpdate,
  removeSchemaVariable,
  setGoalEnabled,
  setInitialStateValue,
  updateAssumption,
  updateGoal,
  updateInvariant,
  updateModelMetadata,
  updateRule,
  updateRuleUpdate,
  updateSchemaVariable,
  validateImportedModelValue,
  type DiagnosticSection,
  type JsonImportResult,
  type ModelDiagnosticsIndex,
  type StrictIntegerParseResult,
} from './model-editor.js';

export {
  DEFAULT_VERIFY_OPTIONS,
  runPresetComparison,
  type PresetComparisonRow,
} from './comparison.js';

export {
  VerifyWorkerClient,
  createBrowserVerifyWorker,
  createSynchronousWorkerFactory,
  isWebWorkerSupported,
  type VerifyClientOptions,
  type VerifyClientOutcome,
  type VerifyExecutionMode,
  type WorkerFactory,
  type WorkerLike,
} from './verify-client.js';

export type { VerifyWorkerRequest, VerifyWorkerResponse } from './verify.worker.js';
