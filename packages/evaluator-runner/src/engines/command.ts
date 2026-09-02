import path from 'node:path';

import {
  type EvaluatorContext,
  EvaluatorResultEnvelopeSchema,
  type EvaluatorRunPayload,
  type EvaluatorRunStatus,
  type EvaluatorVerdict,
  type ResolvedEvaluator,
} from '@orcaops/evaluator-protocol';
import {
  scrubEvaluatorDiagnostic,
  scrubEvaluatorDiagnosticAndBound,
  scrubEvaluatorOutput,
  scrubEvaluatorOutputInValue,
} from '@orcaops/evaluator-protocol/secrets';

import { buildSubprocessEnv, runSubprocess, type SubprocessResult } from './subprocess.js';

/**
 * Structured-error codes used by the command engine. Open as
 * `string` so the LLM engine can introduce its own codes
 * (NO_VERDICT_LINE) without forcing a schema bump, but the command
 * engine sticks to this set.
 */
export type CommandEngineErrorCode =
  | 'TIMEOUT'
  | 'EXIT_CODE'
  | 'JSON_PARSE'
  | 'ENVELOPE_INVALID'
  | 'RAW_SCHEMA_INVALID'
  | 'OUTPUT_TOO_LARGE'
  | 'CANCELED'
  | 'SPAWN_ERROR';

const MAX_PERSISTED_ERROR_MESSAGE_CHARS = 4096;

export interface RunCommandEngineOptions {
  /** The resolved evaluator (engine.kind must be `command`). */
  evaluator: ResolvedEvaluator;
  /** Context handed to the subprocess via stdin + temp file. */
  context: EvaluatorContext;
  /** Caller-supplied run_id (UUIDv7). Threaded through the env contract. */
  run_id: string;
  /**
   * Optional cancellation signal — aborted = subprocess gets
   * SIGTERM → SIGKILL with `killed_reason: 'canceled'`.
   */
  signal?: AbortSignal;
  /** Override parent env (test injection). Defaults to process.env. */
  parentEnv?: NodeJS.ProcessEnv;
  /**
   * Optional JSON Schema validator for the envelope's `raw` field.
   * When omitted, raw-schema validation is skipped (callers that
   * want it inject an ajv-backed validator — typically the same
   * one created via `createParamsValidator`).
   */
  validateRaw?: (raw: unknown, schema: Record<string, unknown>) => void;
}

/**
 * Dispatch a single command-engine evaluator and produce an
 * `EvaluatorRunPayload`. Never throws — every failure mode maps to
 * `run_status: 'error'` with a structured `error.code`.
 *
 * Outcome model:
 *   - exit 0 + valid envelope                → run_status: completed
 *   - exit 0 + valid envelope, raw fails     → run_status: error, RAW_SCHEMA_INVALID
 *     output_schema validation
 *   - exit 0 + non-JSON stdout               → run_status: error, JSON_PARSE
 *   - exit 0 + JSON not matching envelope    → run_status: error, ENVELOPE_INVALID
 *   - non-zero exit                          → run_status: error, EXIT_CODE
 *   - timeout                                → run_status: error, TIMEOUT
 *   - output too large                       → run_status: error, OUTPUT_TOO_LARGE
 *   - parent aborted                         → run_status: error, CANCELED
 *   - spawn error (e.g. ENOENT)              → run_status: error, SPAWN_ERROR
 */
export async function runCommandEngine(
  opts: RunCommandEngineOptions
): Promise<EvaluatorRunPayload> {
  const { evaluator, context, run_id } = opts;
  if (evaluator.engine.kind !== 'command') {
    throw new Error(
      `runCommandEngine called with engine.kind="${evaluator.engine.kind}" — expected "command"`
    );
  }
  const engine = evaluator.engine;
  const ts = new Date().toISOString();

  const cwd = engine.cwd === 'package' ? evaluator.package_root : context.repo.root;

  const orcaopsVars: Record<string, string> = {
    ORCAOPS_RUN_ID: run_id,
    ORCAOPS_PHASE: context.phase,
    ORCAOPS_ARTIFACT_ID: context.artifact_id,
    ORCAOPS_REPO_ROOT: context.repo.root,
    ORCAOPS_PACKAGE_ROOT: evaluator.package_root,
    ORCAOPS_EVALUATOR_REF: evaluator.ref,
  };
  if (context.checkpoint_n !== null) {
    orcaopsVars.ORCAOPS_CHECKPOINT_N = String(context.checkpoint_n);
  }

  const env = buildSubprocessEnv({
    parentEnv: opts.parentEnv,
    inherit: engine.env.inherit,
    set: engine.env.set,
    orcaopsVars,
  });

  // Write the context JSON. Compact serialization keeps the
  // payload smaller for scripts that re-read it from the temp
  // file (rare; most parse stdin instead).
  const contextJson = JSON.stringify(context);
  // Pre-create the context temp file here so its path can be
  // injected into the env before the spawn. `runSubprocess` then runs
  // with stdin only (`attachContextFile: false`) and this function
  // owns the cleanup.
  const { tempDir, contextPath } = await preCreateContextFile(contextJson);
  env.ORCAOPS_CONTEXT_PATH = contextPath;
  env.ORCAOPS_INPUT_PATH = contextPath;

  let result: SubprocessResult;
  try {
    result = await runSubprocess({
      argv: engine.command,
      cwd,
      env,
      stdin: contextJson,
      attachContextFile: false,
      timeoutMs: engine.timeout_ms,
      maxOutputBytes: engine.max_output_bytes,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
  } finally {
    await cleanupTempDir(tempDir);
  }

  // A kill we could not confirm is worth saying out loud: the evaluator may
  // still be running even though this run reports it stopped.
  const unconfirmed =
    result.killed_reason !== null &&
    result.killed_reason !== 'spawn-error' &&
    !result.termination_confirmed
      ? ' (termination NOT confirmed — the process may still be running)'
      : '';

  // Map subprocess outcome → EvaluatorRunPayload.
  if (result.killed_reason === 'timeout') {
    return makeErrorRun({
      evaluator,
      run_id,
      context,
      ts,
      code: 'TIMEOUT',
      message: `engine.timeout_ms (${engine.timeout_ms}ms) exceeded${unconfirmed}`,
      result,
    });
  }
  if (result.killed_reason === 'output-too-large') {
    return makeErrorRun({
      evaluator,
      run_id,
      context,
      ts,
      code: 'OUTPUT_TOO_LARGE',
      message: `engine.max_output_bytes (${engine.max_output_bytes}) exceeded${unconfirmed}`,
      result,
    });
  }
  if (result.killed_reason === 'canceled') {
    return makeErrorRun({
      evaluator,
      run_id,
      context,
      ts,
      code: 'CANCELED',
      message: `evaluator canceled by parent${unconfirmed}`,
      result,
    });
  }
  if (result.killed_reason === 'spawn-error') {
    return makeErrorRun({
      evaluator,
      run_id,
      context,
      ts,
      code: 'SPAWN_ERROR',
      message: result.spawn_error?.message ?? 'subprocess spawn failed',
      result,
    });
  }
  if (result.exit_code !== 0) {
    return makeErrorRun({
      evaluator,
      run_id,
      context,
      ts,
      code: 'EXIT_CODE',
      message: `non-zero exit code ${result.exit_code ?? 'null'}`,
      result,
    });
  }

  // exit 0 — parse stdout as the envelope.
  let parsedEnvelope: unknown;
  try {
    parsedEnvelope = JSON.parse(result.stdout);
  } catch (err) {
    return makeErrorRun({
      evaluator,
      run_id,
      context,
      ts,
      code: 'JSON_PARSE',
      message:
        (err instanceof Error ? err.message : String(err)) +
        ` — stdout was: ${truncate(scrubEvaluatorOutput(result.stdout), 256)}`,
      result,
    });
  }
  const envelopeResult = EvaluatorResultEnvelopeSchema.safeParse(parsedEnvelope);
  if (!envelopeResult.success) {
    const issue = envelopeResult.error.issues[0];
    return makeErrorRun({
      evaluator,
      run_id,
      context,
      ts,
      code: 'ENVELOPE_INVALID',
      message: `${issue.path.join('.') || '<root>'}: ${issue.message}`,
      result,
    });
  }
  const envelope = envelopeResult.data;

  if (opts.validateRaw && engine.output_schema && envelope.raw !== undefined) {
    try {
      opts.validateRaw(envelope.raw, engine.output_schema);
    } catch (err) {
      return makeErrorRun({
        evaluator,
        run_id,
        context,
        ts,
        code: 'RAW_SCHEMA_INVALID',
        message: err instanceof Error ? err.message : String(err),
        result,
      });
    }
  }

  return packCompletedRun({
    evaluator,
    run_id,
    context,
    ts,
    envelope,
    result,
  });
}

// ── helpers ────────────────────────────────────────────────────────

async function preCreateContextFile(contextJson: string): Promise<{
  tempDir: string;
  contextPath: string;
}> {
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const tempDir = await mkdtemp(path.join(tmpdir(), 'orcaops-cmd-'));
  const contextPath = path.join(tempDir, 'context.json');
  await writeFile(contextPath, contextJson, 'utf8');
  return { tempDir, contextPath };
}

async function cleanupTempDir(tempDir: string): Promise<void> {
  const { rm } = await import('node:fs/promises');
  await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
}

interface RunFields {
  evaluator: ResolvedEvaluator;
  run_id: string;
  context: EvaluatorContext;
  ts: string;
  result: SubprocessResult;
}

function commonFields(
  opts: RunFields
): Pick<
  EvaluatorRunPayload,
  | 'schema'
  | 'run_id'
  | 'artifact_id'
  | 'evaluator_ref'
  | 'package_id'
  | 'evaluator_id'
  | 'phase'
  | 'severity'
  | 'duration_ms'
  | 'ts'
> {
  return {
    schema: 'orcaops.evaluator_run/v1',
    run_id: opts.run_id,
    artifact_id: opts.context.artifact_id,
    evaluator_ref: opts.evaluator.ref,
    package_id: opts.evaluator.package_id,
    evaluator_id: opts.evaluator.evaluator_id,
    phase: opts.context.phase,
    severity: opts.evaluator.severity,
    duration_ms: opts.result.duration_ms,
    ts: opts.ts,
  };
}

function packCompletedRun(
  opts: RunFields & {
    envelope: {
      verdict: EvaluatorVerdict;
      body: string;
      raw?: unknown;
      metrics?: Record<string, number>;
    };
  }
): EvaluatorRunPayload {
  const payload: EvaluatorRunPayload = {
    ...commonFields(opts),
    run_status: 'completed' as EvaluatorRunStatus,
    verdict: opts.envelope.verdict,
    body: scrubEvaluatorOutput(opts.envelope.body),
    ...(opts.envelope.raw !== undefined
      ? { raw: scrubEvaluatorOutputInValue(opts.envelope.raw) }
      : {}),
    ...(opts.envelope.metrics !== undefined
      ? { metrics: scrubEvaluatorOutputInValue(opts.envelope.metrics) }
      : {}),
    ...(opts.context.checkpoint_n !== null ? { checkpoint_n: opts.context.checkpoint_n } : {}),
  };
  return payload;
}

function makeErrorRun(
  opts: RunFields & {
    code: CommandEngineErrorCode;
    message: string;
  }
): EvaluatorRunPayload {
  // Body folds in stderr + a tail of stdout for diagnostics. Both are RAW
  // evaluator output — a stack trace, an env dump, an upstream error body —
  // and this body is PERSISTED into the artifact and shown to reviewers, so
  // it is redacted before it lands. Redact BEFORE trimming: a secret
  // straddling the cut would otherwise survive as an unmatched prefix.
  //
  // max_output_bytes bounds the bytes read from the subprocess, which is a
  // different quantity from the size of the envelope persisted here — so this
  // trim is still needed. The fragment a max_output_bytes cut can sever is
  // handled at that cut, inside the bounded collector.
  const tail = [
    opts.result.stderr
      ? `STDERR:\n${tailOf(scrubEvaluatorDiagnostic(opts.result.stderr), 2048)}`
      : '',
    opts.result.stdout
      ? `STDOUT (last 256 chars):\n${tailOf(scrubEvaluatorDiagnostic(opts.result.stdout), 256)}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  const message = scrubEvaluatorDiagnosticAndBound(opts.message, MAX_PERSISTED_ERROR_MESSAGE_CHARS);
  return {
    ...commonFields(opts),
    run_status: 'error',
    verdict: null,
    body: `ERROR (${opts.code})\n\n${message}${tail ? `\n\n${tail}` : ''}`,
    error: { code: opts.code, message },
    ...(opts.context.checkpoint_n !== null ? { checkpoint_n: opts.context.checkpoint_n } : {}),
  };
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n)}…[${s.length - n} more]`;
}

/**
 * The LAST `n` characters. The body labels this slice "last 256 chars" and
 * it previously took the head — which is also the less useful half, since a
 * failing runtime's diagnosis is usually at the end of its output.
 */
function tailOf(s: string, n: number): string {
  if (s.length <= n) return s;
  return `…[${s.length - n} more]${s.slice(s.length - n)}`;
}
