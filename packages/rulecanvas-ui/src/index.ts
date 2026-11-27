export {
  formatBoolExpr,
  formatRuleSummary,
  formatStateValue,
  formatUpdateAssignment,
  formatValueExpr,
  formatVarDef,
  type FormattedRuleSummary,
} from './format.js';

export {
  applyManualStep,
  createManualSimulationSession,
  createTraceReplaySession,
  createVerdictReplaySession,
  jumpReplayToStep,
  resetReplaySession,
  stepReplayBackward,
  stepReplayForward,
  type ManualStepResult,
  type ReplayMode,
  type ReplaySession,
  type ReplaySessionInitResult,
  type ReplayStepNavResult,
  type VerdictReplayOptions,
} from './replay-controller.js';

export {
  getErrorsForPathPrefix,
  indexModelDiagnostics,
  parseStrictIntegerDraft,
  type DiagnosticSection,
  type ModelDiagnosticsIndex,
  type StrictIntegerParseResult,
} from './diagnostics.js';

export {
  buildInvariantsPanelView,
  buildStateTableView,
  buildVerdictSummaryView,
  escapeHtml,
  renderAssumptionsPanelHtml,
  renderInvariantsPanelHtml,
  renderReplayTimelineHtml,
  renderStateTableHtml,
  renderValidationErrorsHtml,
  renderVerdictSummaryHtml,
  type GoalPanelView,
  type InvariantRowView,
  type InvariantsPanelView,
  type StateTableRowView,
  type StateTableView,
  type VerdictStatItem,
  type VerdictSummaryView,
  type VerdictTone,
} from './components.js';

export {
  VERIFICATION_REPORT_SCHEMA_VERSION,
  buildVerificationReportFromSnapshot,
  formatVerificationReportMarkdown,
  isTrustedVerificationReport,
  sanitizeReportFilename,
  serializeVerificationReportJson,
  verifyAndBuildReport,
  type ReportBuildResult,
  type VerificationReport,
  type VerificationReportGoalRef,
  type VerificationReportGoalStatus,
  type VerificationReportInconclusive,
  type VerificationReportInvariantRef,
  type VerificationReportModelSummary,
  type VerificationReportProvenance,
  type VerificationReportTraceDiff,
  type VerificationReportTraceStep,
} from './report.js';

export {
  computeVerdictDelta,
  type VerdictDelta,
  type VerdictDeltaChangedSection,
  type VerdictDeltaClassification,
  type VerdictDeltaEndpoint,
  type VerdictDeltaResult,
} from './delta.js';
