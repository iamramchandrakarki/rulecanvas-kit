export {
  bsl3AirlockAssumptions,
  bsl3AirlockBrokenModel,
  bsl3AirlockDefaultOptions,
  bsl3AirlockFixedModel,
  bsl3AirlockGoal,
  bsl3AirlockInitialState,
  bsl3AirlockInvariants,
  bsl3AirlockSchema,
  bsl3AirlockVacuousModel,
} from './scenarios/bsl3-airlock.js';

export {
  INTERLOCK_SIM_PRESETS,
  getInterlockPresetDescriptor,
  loadInterlockPresetModel,
  type InterlockPresetDescriptor,
  type InterlockPresetVariant,
} from './presets.js';

export {
  explainRuleGuards,
  type GuardClauseExplanation,
  type GuardExplanationResult,
  type RuleGuardExplanation,
} from './guard-explainer.js';

export {
  addAssumption,
  appendGuardClause,
  applyPrincipledInterlockRepair,
  createDefaultBoolExpr,
  createDefaultValueExpr,
  defaultValueForVarDef,
  exportModelToJson,
  firstVariableOfKind,
  getErrorsForPathPrefix,
  importModelFromJson,
  indexModelDiagnostics,
  isPrincipledOpenInnerDoorGuard,
  parseStrictIntegerDraft,
  removeAssumption,
  tryExportModelJson,
  updateAssumption,
  updateRule,
  updateRuleGuard,
  validateImportedModelValue,
  type DiagnosticSection,
  type JsonExportResult,
  type JsonImportResult,
  type ModelDiagnosticsIndex,
  type StrictIntegerParseResult,
} from './model-inspector.js';

export {
  DEFAULT_VERIFY_OPTIONS,
  runInterlockPresetComparison,
  type InterlockPresetComparisonRow,
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
