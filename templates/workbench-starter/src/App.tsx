import { useCallback, useMemo, useRef, useState } from 'react';
import type { TraceStep, ValidationError } from '@rulecanvas/core';
import {
  buildVerdictSummaryView,
  buildVerificationReportFromSnapshot,
  formatVerificationReportMarkdown,
  sanitizeReportFilename,
  serializeVerificationReportJson,
} from '@rulecanvas/ui';
import { createModelJsonCodec } from '@rulecanvas/workbench/model-json';
import { createVerifyClient } from '@rulecanvas/workbench/verify';
import {
  AssumptionsList,
  VerdictSummary,
  WorkbenchNavigation,
  useVerificationSnapshot,
  type WorkbenchNavLink,
} from '@rulecanvas/workbench-react';
import {
  RELEASE_GATE_LABELS,
  RELEASE_GATE_MODELS,
  RELEASE_GATE_VARIANTS,
  VERIFY_OPTIONS,
  isReleaseGateVariant,
  type ReleaseGateVariant,
} from './release-gate.js';

// Strict codec: the first argument overrides size limits, the second sets parsing policy.
// Duplicate object keys are rejected instead of silently keeping the last value.
const codec = createModelJsonCodec(undefined, { duplicateKeys: 'reject' });

const createClient = () =>
  createVerifyClient({
    execution: {
      kind: 'app-worker',
      createWorker: () =>
        // The worker URL must stay a literal `new URL(..., import.meta.url)` so Vite bundles it.
        new Worker(new URL('./verify.worker.ts', import.meta.url), { type: 'module' }) as never,
      asyncStartupError: 'fallback',
    },
  });

const NAV_LINKS: readonly WorkbenchNavLink[] = RELEASE_GATE_VARIANTS.map((variant) => ({
  id: variant,
  label: RELEASE_GATE_LABELS[variant].label,
  href: `./?variant=${variant}`,
  description: RELEASE_GATE_LABELS[variant].summary,
}));

function readVariant(search: string): ReleaseGateVariant {
  const values = new URLSearchParams(search).getAll('variant');
  const [only] = values;
  return values.length === 1 && isReleaseGateVariant(only) ? only : 'broken';
}

function formatValue(value: unknown): string {
  return typeof value === 'string' ? `"${value}"` : String(value);
}

function downloadText(filename: string, mimeType: string, text: string): void {
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  requestAnimationFrame(() => {
    URL.revokeObjectURL(url);
  });
}

function TraceList({ steps }: { readonly steps: readonly TraceStep[] }) {
  return (
    <ol className="trace">
      {steps.map((step, index) => (
        <li key={`${index}-${step.ruleId}`}>
          <code className="trace-rule">{step.ruleId}</code>
          <span className="trace-changes">
            {step.changedVars
              .map((name) => `${name}: ${formatValue(step.stateBefore[name])} → ${formatValue(step.stateAfter[name])}`)
              .join(', ')}
          </span>
        </li>
      ))}
    </ol>
  );
}

export function App() {
  const [variant] = useState<ReleaseGateVariant>(() =>
    typeof window === 'undefined' ? 'broken' : readVariant(window.location.search),
  );
  const initialModel = RELEASE_GATE_MODELS[variant];
  const [initialExport] = useState(() => codec.encode(initialModel));
  const [draftText, setDraftText] = useState<string>(initialExport.ok ? initialExport.text : '');
  const [decodeErrors, setDecodeErrors] = useState<readonly ValidationError[]>([]);
  const [exportStatus, setExportStatus] = useState<string>('');
  const revisionRef = useRef(0);
  const textByRevisionRef = useRef<Map<number, string>>(new Map([[0, draftText]]));

  const verification = useVerificationSnapshot({
    initialRequest: { model: initialModel, options: VERIFY_OPTIONS, label: initialModel.name, revision: 0 },
    createClient,
  });
  const { snapshot, isRunning, transportError } = verification;

  const verifyDraft = useCallback(() => {
    setExportStatus('');
    const decoded = codec.decode(draftText);
    if (!decoded.ok) {
      setDecodeErrors(decoded.errors);
      return;
    }
    setDecodeErrors([]);
    revisionRef.current += 1;
    textByRevisionRef.current.set(revisionRef.current, draftText);
    verification.run({
      model: decoded.model,
      options: VERIFY_OPTIONS,
      label: decoded.model.name,
      revision: revisionRef.current,
    });
  }, [draftText, verification]);

  const stale = snapshot !== null && textByRevisionRef.current.get(snapshot.revision) !== draftText;
  const view = snapshot !== null ? buildVerdictSummaryView(snapshot.result) : null;
  const result = snapshot?.result ?? null;
  const reportBuild = useMemo(
    () => (snapshot !== null && !stale ? buildVerificationReportFromSnapshot(snapshot) : null),
    [snapshot, stale],
  );
  const report = reportBuild !== null && reportBuild.ok ? reportBuild.report : null;
  const exportDisabled = isRunning || stale || report === null;

  const copyMarkdown = useCallback(() => {
    if (report === null || isRunning || stale) return;
    const markdown = formatVerificationReportMarkdown(report);
    if (
      typeof navigator === 'undefined' ||
      navigator.clipboard === undefined ||
      typeof navigator.clipboard.writeText !== 'function'
    ) {
      setExportStatus('Clipboard unavailable; use Download Markdown instead.');
      return;
    }
    void navigator.clipboard.writeText(markdown).then(
      () => setExportStatus('Copied Markdown report.'),
      () => setExportStatus('Clipboard copy failed; use Download Markdown instead.'),
    );
  }, [report, isRunning, stale]);

  const downloadMarkdown = useCallback(() => {
    if (report === null || isRunning || stale) return;
    const markdown = formatVerificationReportMarkdown(report);
    const filename = sanitizeReportFilename(report.model.id, 'md');
    downloadText(filename, 'text/markdown;charset=utf-8', markdown);
    setExportStatus(`Downloaded ${filename}.`);
  }, [report, isRunning, stale]);

  const downloadJson = useCallback(() => {
    if (report === null || isRunning || stale) return;
    const json = serializeVerificationReportJson(report);
    const filename = sanitizeReportFilename(report.model.id, 'json');
    downloadText(filename, 'application/json;charset=utf-8', json);
    setExportStatus(`Downloaded ${filename}.`);
  }, [report, isRunning, stale]);

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-name">Release gate workbench</span>
          <span className="brand-note">RuleCanvasKit Skeleton Crew Starter Template</span>
        </div>
        <WorkbenchNavigation
          current={variant}
          links={NAV_LINKS}
          ariaLabel="Model variants"
          className="variant-nav"
          listClassName="variant-nav-list"
          linkClassName="variant-nav-link"
          activeLinkClassName="variant-nav-link-active"
        />
      </header>

      <main
        className="workspace"
        data-variant={variant}
        data-export-ok={initialExport.ok ? 'true' : 'false'}
        data-execution-mode={snapshot?.executionMode}
        data-verification-revision={snapshot?.revision}
      >
        <section className="pane" aria-labelledby="model-title">
          <h1 id="model-title">{initialModel.name}</h1>
          <p className="pane-note">{RELEASE_GATE_LABELS[variant].summary}</p>
          <label className="field-label" htmlFor="model-json">
            Model JSON
          </label>
          <textarea
            id="model-json"
            className="model-json"
            spellCheck={false}
            value={draftText}
            aria-invalid={decodeErrors.length > 0}
            aria-describedby={decodeErrors.length > 0 ? 'model-json-errors' : undefined}
            onChange={(event) => {
              setExportStatus('');
              setDraftText(event.target.value);
            }}
          />
          {decodeErrors.length > 0 && (
            <ul id="model-json-errors" className="errors" role="alert">
              {decodeErrors.map((error, index) => (
                <li key={`${error.code}-${index}`}>
                  <code>{error.code}</code> at <code>{error.path || '(root)'}</code>: {error.message}
                </li>
              ))}
            </ul>
          )}
          <div className="actions">
            <button type="button" className="btn" onClick={verifyDraft} disabled={isRunning}>
              {isRunning ? 'Verifying…' : 'Verify model'}
            </button>
            <span className="hint">
              Bounds: {VERIFY_OPTIONS.maxStates} states, depth {VERIFY_OPTIONS.maxDepth}
            </span>
          </div>
        </section>

        <section className="pane" aria-labelledby="verdict-title" aria-live="polite">
          <h2 id="verdict-title">Verdict</h2>
          {transportError !== null && <p className="errors">{transportError}</p>}
          {view !== null && snapshot !== null ? (
            <>
              <VerdictSummary
                view={view}
                stale={stale}
                className="verdict"
                headerClassName="verdict-header"
                badgeClassName="badge"
                headlineClassName="verdict-headline"
                detailClassName="verdict-detail"
              />
              <p className="hint">
                Execution: {snapshot.executionMode === 'worker' ? 'Web Worker' : 'main thread'}
                {stale ? '. The JSON changed since this run; verify again.' : ''}
              </p>
              <div className="report-actions" role="group" aria-label="Report export">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={copyMarkdown}
                  disabled={exportDisabled}
                >
                  Copy Markdown
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={downloadMarkdown}
                  disabled={exportDisabled}
                >
                  Download Markdown
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={downloadJson}
                  disabled={exportDisabled}
                >
                  Download JSON
                </button>
              </div>
              {exportStatus !== '' && (
                <p className="hint" role="status" aria-live="polite">
                  {exportStatus}
                </p>
              )}
              {result !== null && result.status === 'VIOLATED' && (
                <>
                  <h3>
                    Shortest counterexample breaks{' '}
                    {result.violatedInvariantIds.map((id) => (
                      <code key={id}>{id}</code>
                    ))}
                  </h3>
                  <TraceList steps={result.trace} />
                </>
              )}
              <h3>Assumptions</h3>
              <AssumptionsList
                items={snapshot.model.assumptions}
                scope="verification-snapshot"
                listClassName="assumptions"
              />
            </>
          ) : (
            <p className="hint">{isRunning ? 'Verifying…' : 'No verification has run yet.'}</p>
          )}
        </section>
      </main>
    </div>
  );
}
