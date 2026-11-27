import { readFileSync } from 'node:fs';
import {
  formatVerificationReportMarkdown,
  serializeVerificationReportJson,
  verifyAndBuildReport,
} from '../packages/rulecanvas-ui/dist/index.js';
import {
  createModelJsonCodec,
  DEFAULT_MODEL_JSON_LIMITS,
} from '../packages/rulecanvas-workbench/dist/model-json.js';

const DEFAULT_MAX_STATES = 10_000;
const MIN_MAX_STATES = 1;
const MAX_MAX_STATES = 100_000;

const DEFAULT_MAX_DEPTH = 100;
const MIN_MAX_DEPTH = 0;
const MAX_MAX_DEPTH = 10_000;

const USAGE = `Usage: pnpm check:model <model.json> [options]

Options:
  --markdown             Output PR-ready Markdown report instead of JSON
  --max-states <int>     Max states bound (${MIN_MAX_STATES}..${MAX_MAX_STATES}, default ${DEFAULT_MAX_STATES})
  --max-depth <int>      Max depth bound (${MIN_MAX_DEPTH}..${MAX_MAX_DEPTH}, default ${DEFAULT_MAX_DEPTH})
  --allow-vacuous        Exit 0 when VERIFIED has vacuousGoalWarning=true (never overrides VIOLATED/INCONCLUSIVE/INVALID)
  -h, --help             Show this help message and exit 0

Exit codes:
  0  VERIFIED (and goal reachable or no goal declared, unless --allow-vacuous is set)
  1  VIOLATED, INCONCLUSIVE, INVALID (runtime), or vacuous VERIFIED without --allow-vacuous
  2  CLI usage error, unreadable file, or invalid model JSON/schema
`;

function writeStream(stream, text) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      stream.removeListener('error', onError);
    };
    const onError = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    stream.once('error', onError);
    try {
      stream.write(text, 'utf8', (err) => {
        if (settled) return;
        settled = true;
        if (err) {
          // Defer listener removal past nextTick so Node's emitErrorNT has a handler.
          const timer = setImmediate(cleanup);
          if (typeof timer.unref === 'function') timer.unref();
          reject(err);
        } else {
          cleanup();
          resolve();
        }
      });
    } catch (err) {
      onError(err);
    }
  });
}

async function writeError(code, message, errors) {
  const payload = {
    ok: false,
    code,
    message,
    ...(errors !== undefined ? { errors } : {}),
  };
  await writeStream(process.stderr, `${JSON.stringify(payload, null, 2)}\n`);
}

function parseBoundInt(raw, flagName, min, max) {
  if (!/^-?[0-9]+$/.test(raw)) {
    return {
      ok: false,
      code: 'INVALID_BOUND',
      message: `${flagName} requires an integer value; received "${raw}".`,
    };
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    return {
      ok: false,
      code: 'INVALID_BOUND',
      message: `${flagName} must be between ${min} and ${max}; received ${raw}.`,
    };
  }
  return { ok: true, value };
}

function parseCliArgs(argv) {
  let help = false;
  let markdown = false;
  let allowVacuous = false;
  let maxStates = DEFAULT_MAX_STATES;
  let maxDepth = DEFAULT_MAX_DEPTH;
  let seenHelp = false;
  let seenMarkdown = false;
  let seenAllowVacuous = false;
  let seenMaxStates = false;
  let seenMaxDepth = false;
  let endOfOptions = false;
  const positionals = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!endOfOptions && arg === '--') {
      endOfOptions = true;
      continue;
    }
    if (!endOfOptions && (arg === '--help' || arg === '-h')) {
      if (seenHelp) {
        return { ok: false, code: 'DUPLICATE_FLAG', message: `Duplicate flag: ${arg}.` };
      }
      seenHelp = true;
      help = true;
      continue;
    }
    if (!endOfOptions && arg === '--markdown') {
      if (seenMarkdown) {
        return { ok: false, code: 'DUPLICATE_FLAG', message: 'Duplicate flag: --markdown.' };
      }
      seenMarkdown = true;
      markdown = true;
      continue;
    }
    if (!endOfOptions && arg === '--allow-vacuous') {
      if (seenAllowVacuous) {
        return { ok: false, code: 'DUPLICATE_FLAG', message: 'Duplicate flag: --allow-vacuous.' };
      }
      seenAllowVacuous = true;
      allowVacuous = true;
      continue;
    }
    if (!endOfOptions && (arg === '--max-states' || arg.startsWith('--max-states='))) {
      if (seenMaxStates) {
        return { ok: false, code: 'DUPLICATE_FLAG', message: 'Duplicate flag: --max-states.' };
      }
      seenMaxStates = true;
      let rawValue;
      if (arg === '--max-states') {
        if (i + 1 >= argv.length) {
          return { ok: false, code: 'MISSING_FLAG_VALUE', message: 'Missing integer value for --max-states.' };
        }
        rawValue = argv[++i];
      } else {
        rawValue = arg.slice('--max-states='.length);
        if (rawValue.length === 0) {
          return { ok: false, code: 'MISSING_FLAG_VALUE', message: 'Missing integer value for --max-states.' };
        }
      }
      const parsed = parseBoundInt(rawValue, '--max-states', MIN_MAX_STATES, MAX_MAX_STATES);
      if (!parsed.ok) return parsed;
      maxStates = parsed.value;
      continue;
    }
    if (!endOfOptions && (arg === '--max-depth' || arg.startsWith('--max-depth='))) {
      if (seenMaxDepth) {
        return { ok: false, code: 'DUPLICATE_FLAG', message: 'Duplicate flag: --max-depth.' };
      }
      seenMaxDepth = true;
      let rawValue;
      if (arg === '--max-depth') {
        if (i + 1 >= argv.length) {
          return { ok: false, code: 'MISSING_FLAG_VALUE', message: 'Missing integer value for --max-depth.' };
        }
        rawValue = argv[++i];
      } else {
        rawValue = arg.slice('--max-depth='.length);
        if (rawValue.length === 0) {
          return { ok: false, code: 'MISSING_FLAG_VALUE', message: 'Missing integer value for --max-depth.' };
        }
      }
      const parsed = parseBoundInt(rawValue, '--max-depth', MIN_MAX_DEPTH, MAX_MAX_DEPTH);
      if (!parsed.ok) return parsed;
      maxDepth = parsed.value;
      continue;
    }
    if (!endOfOptions && arg.startsWith('-') && arg.length > 1) {
      return { ok: false, code: 'UNKNOWN_FLAG', message: `Unknown flag: ${arg}.` };
    }
    positionals.push(arg);
  }

  if (help) {
    return { ok: true, help: true };
  }
  if (positionals.length === 0) {
    return { ok: false, code: 'MISSING_MODEL_PATH', message: 'Missing required <model.json> file path.' };
  }
  if (positionals.length > 1) {
    return {
      ok: false,
      code: 'EXTRA_POSITIONAL_ARGS',
      message: `Unexpected extra positional argument(s): ${positionals.slice(1).join(', ')}.`,
    };
  }

  return {
    ok: true,
    help: false,
    modelPath: positionals[0],
    markdown,
    allowVacuous,
    maxStates,
    maxDepth,
  };
}

async function safeWriteError(code, message, errors) {
  try {
    await writeError(code, message, errors);
  } catch {
    // Best-effort stderr diagnostic; ignore secondary stderr write errors.
  }
}

async function main() {
  const cli = parseCliArgs(process.argv.slice(2));
  if (!cli.ok) {
    await safeWriteError(cli.code, cli.message);
    process.exitCode = 2;
    return;
  }
  if (cli.help) {
    try {
      await writeStream(process.stdout, USAGE);
    } catch (err) {
      const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : 'WRITE_ERROR';
      const detail = err instanceof Error ? err.message : String(err);
      await safeWriteError('STDOUT_WRITE_FAILED', `Unable to write usage to stdout (${code}): ${detail}`);
      process.exitCode = 2;
      return;
    }
    process.exitCode = 0;
    return;
  }

  let rawText;
  try {
    rawText = readFileSync(cli.modelPath, 'utf8');
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : 'READ_ERROR';
    const detail = err instanceof Error ? err.message : String(err);
    await safeWriteError('UNREADABLE_MODEL_FILE', `Unable to read "${cli.modelPath}" (${code}): ${detail}`);
    process.exitCode = 2;
    return;
  }

  const codec = createModelJsonCodec(DEFAULT_MODEL_JSON_LIMITS, { duplicateKeys: 'reject' });
  const decoded = codec.decode(rawText);
  if (!decoded.ok) {
    await safeWriteError(
      'MODEL_DECODE_FAILED',
      `Model JSON validation failed with ${decoded.errors.length} error(s).`,
      decoded.errors,
    );
    process.exitCode = 2;
    return;
  }

  const built = verifyAndBuildReport(decoded.model, {
    maxStates: cli.maxStates,
    maxDepth: cli.maxDepth,
  });
  if (!built.ok) {
    await safeWriteError(
      'REPORT_BUILD_FAILED',
      `Verification report failed with ${built.errors.length} error(s).`,
      built.errors,
    );
    process.exitCode = 2;
    return;
  }

  const { report } = built;
  const output = cli.markdown
    ? formatVerificationReportMarkdown(report)
    : serializeVerificationReportJson(report);
  const line = output.endsWith('\n') ? output : `${output}\n`;
  try {
    await writeStream(process.stdout, line);
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : 'WRITE_ERROR';
    const detail = err instanceof Error ? err.message : String(err);
    await safeWriteError('STDOUT_WRITE_FAILED', `Unable to write report to stdout (${code}): ${detail}`);
    process.exitCode = 2;
    return;
  }

  const passed = report.verdict === 'VERIFIED' && (!report.vacuousGoalWarning || cli.allowVacuous);
  process.exitCode = passed ? 0 : 1;
}

main().catch(async (err) => {
  const detail = err instanceof Error ? err.message : String(err);
  await safeWriteError('INTERNAL_ERROR', detail);
  process.exitCode = 2;
});
