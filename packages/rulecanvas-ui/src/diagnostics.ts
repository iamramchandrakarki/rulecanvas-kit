import type { ValidationError } from '@rulecanvas/core';

export type StrictIntegerParseResult =
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false; readonly message: string };

export type DiagnosticSection =
  | 'general'
  | 'schema'
  | 'rules'
  | 'invariants'
  | 'goal'
  | 'assumptions';

export interface ModelDiagnosticsIndex {
  readonly all: readonly ValidationError[];
  readonly byPath: Readonly<Record<string, readonly ValidationError[]>>;
  readonly sections: Readonly<Record<DiagnosticSection, readonly ValidationError[]>>;
}

export function parseStrictIntegerDraft(raw: string): StrictIntegerParseResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, message: 'Integer value is required.' };
  }
  if (!/^-?\d+$/.test(trimmed)) {
    return {
      ok: false,
      message: `Invalid integer "${raw}": enter a whole base-10 integer without decimals or extra characters.`,
    };
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) {
    return {
      ok: false,
      message: `Integer "${trimmed}" exceeds safe integer bounds.`,
    };
  }
  return { ok: true, value: Object.is(parsed, -0) ? 0 : parsed };
}

function classifyErrorSection(path: string): DiagnosticSection {
  if (path.startsWith('schema') || path.startsWith('initialState')) {
    return 'schema';
  }
  if (path.startsWith('rules')) {
    return 'rules';
  }
  if (path.startsWith('invariants')) {
    return 'invariants';
  }
  if (path.startsWith('goal')) {
    return 'goal';
  }
  if (path.startsWith('assumptions')) {
    return 'assumptions';
  }
  return 'general';
}

export function indexModelDiagnostics(errors: readonly ValidationError[]): ModelDiagnosticsIndex {
  const byPath = Object.create(null) as Record<string, ValidationError[]>;
  const sections: Record<DiagnosticSection, ValidationError[]> = {
    general: [],
    schema: [],
    rules: [],
    invariants: [],
    goal: [],
    assumptions: [],
  };

  for (const error of errors) {
    const existing = Object.hasOwn(byPath, error.path) ? byPath[error.path] : undefined;
    if (existing !== undefined) {
      existing.push(error);
    } else {
      Object.defineProperty(byPath, error.path, {
        value: [error],
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    const section = classifyErrorSection(error.path);
    sections[section].push(error);
  }

  return {
    all: [...errors],
    byPath,
    sections,
  };
}

export function getErrorsForPathPrefix(
  index: ModelDiagnosticsIndex,
  prefix: string,
): readonly ValidationError[] {
  return index.all.filter(
    (err) =>
      err.path === prefix ||
      err.path.startsWith(`${prefix}.`) ||
      err.path.startsWith(`${prefix}[`),
  );
}
