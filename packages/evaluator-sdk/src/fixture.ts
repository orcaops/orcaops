import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  type EvaluatorContext,
  type EvaluatorResultEnvelope,
  EvaluatorResultEnvelopeSchema,
} from '@orcaops/evaluator-protocol';
import { runBoundedSubprocess } from '@orcaops/evaluator-protocol/subprocess';

import { ORCAOPS_CONTEXT_PATH_ENV } from './context.js';

const DEFAULT_TIMEOUT_MS = 30_000;
/**
 * Output cap per stream. Deliberately the SAME default the command-engine
 * schema applies to `max_output_bytes`: a fixture that passes here must not
 * be killed for overflow in production, which a more generous cap would
 * allow. Pass `maxOutputBytes` explicitly to mirror a spec that overrides it.
 */
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

export interface RunFixtureOptions {
  /**
   * Engine.command as declared in the spec (e.g.,
   * `['node', './runtime/plan-mentions.js']`). The first entry must be
   * resolvable from PATH or be an absolute path; later entries that
   * look like relative paths are resolved against `cwd`.
   */
  command: readonly string[];
  /**
   * Pack root the command runs in. Relative entries in `command`
   * resolve against this; usually the absolute path returned by the
   * resolver (`dist/packs/<id>/` for first-party packs).
   */
  cwd: string;
  /**
   * The fixture's `EvaluatorContext`. Written to a temp file and
   * pointed at via `ORCAOPS_CONTEXT_PATH`. The runtime reads it via
   * `readEvaluatorContext()` from this same package.
   */
  context: EvaluatorContext;
  /**
   * Extra env vars to pass through. The harness always sets
   * `ORCAOPS_CONTEXT_PATH`; user-supplied env merges on top (but
   * cannot override that key).
   */
  env?: NodeJS.ProcessEnv;
  /** Hard timeout. Defaults to 30s. Enforced by SIGTERM then SIGKILL. */
  timeoutMs?: number;
  /**
   * Per-stream output cap in bytes. Defaults to the command engine's own
   * default (1 MiB); set it to your spec's `max_output_bytes` when that
   * differs, so the fixture and production agree.
   */
  maxOutputBytes?: number;
  /** Cancellation, matching production dispatch. */
  signal?: AbortSignal;
}

export interface RunFixtureResult {
  /** Parsed + schema-validated envelope from the subprocess stdout. */
  envelope: EvaluatorResultEnvelope;
  /** Raw stdout the subprocess produced (for debugging). */
  stdout: string;
  /** Raw stderr. */
  stderr: string;
  /** Exit code; `null` if the process was killed. */
  exitCode: number | null;
  /** Wall-clock duration of the subprocess. */
  durationMs: number;
}

export class RunFixtureError extends Error {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  constructor(message: string, opts: { stdout: string; stderr: string; exitCode: number | null }) {
    super(message);
    this.name = 'RunFixtureError';
    this.stdout = opts.stdout;
    this.stderr = opts.stderr;
    this.exitCode = opts.exitCode;
  }
}

/**
 * Run an evaluator runtime against a fixture context via the same
 * subprocess code path production dispatch uses. No in-process fast
 * path: the fixture's behavior matches the deployed behavior including
 * subprocess startup, cwd resolution, env var contract, and stdout
 * envelope parsing.
 *
 * Pack authors call this from their package tests to assert pass /
 * violation / skip verdicts against curated context fixtures. First-
 * party fixture tests use this exclusively.
 */
export async function runFixture(opts: RunFixtureOptions): Promise<RunFixtureResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const scratchDir = await mkdtemp(path.join(tmpdir(), 'orcaops-fixture-'));
  const contextPath = path.join(scratchDir, 'context.json');
  await writeFile(contextPath, JSON.stringify(opts.context), 'utf8');

  const [bin, ...args] = opts.command;
  if (!bin) {
    await rm(scratchDir, { recursive: true, force: true });
    throw new Error('runFixture: command must be non-empty');
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(opts.env ?? {}),
    // Set AFTER user env so the path the runtime reads is always the
    // one we wrote to. Otherwise a stray env entry could redirect the
    // subprocess to a stale fixture.
    [ORCAOPS_CONTEXT_PATH_ENV]: contextPath,
  };

  const result = await runBoundedSubprocess({
    argv: [bin, ...args],
    cwd: opts.cwd,
    env: env as Record<string, string>,
    timeoutMs,
    maxOutputBytes: opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  });
  await rm(scratchDir, { recursive: true, force: true }).catch(() => undefined);

  const { stdout, stderr, exit_code: exitCode } = result;
  // Explicitly annotated on the BINDING, not just the return type: TS only
  // treats a call as never-returning (and narrows past it) for a const with
  // an explicit type annotation.
  const fail: (message: string) => never = (message) => {
    throw new RunFixtureError(message, { stdout, stderr, exitCode });
  };

  if (result.killed_reason === 'spawn-error') {
    fail(`runFixture spawn failed: ${result.spawn_error?.message ?? 'unknown spawn error'}`);
  }
  // A killed process reports exit_code null, which would otherwise fall
  // through to the "no stdout" branch and blame the runtime for a timeout.
  // Every kill reason can end unconfirmed, so the wording is derived once
  // rather than claiming "was terminated" and then contradicting it.
  const stopped = result.termination_confirmed
    ? 'was terminated'
    : 'could NOT be confirmed stopped and may still be running';
  const escalated = result.hard_killed ? ' (SIGTERM ignored; escalated to SIGKILL)' : '';
  if (result.killed_reason === 'timeout') {
    fail(
      `runFixture subprocess exceeded its ${timeoutMs}ms timeout and ${stopped}${escalated}; ` +
        `stderr: ${truncate(stderr, 256)}`
    );
  }
  if (result.killed_reason === 'output-too-large') {
    fail(`runFixture subprocess exceeded its output cap and ${stopped}${escalated}`);
  }
  if (result.killed_reason === 'canceled') {
    fail(`runFixture subprocess was canceled and ${stopped}${escalated}`);
  }
  if (exitCode !== 0 && exitCode !== null) {
    fail(`runFixture subprocess exited with code ${exitCode}; stderr: ${truncate(stderr, 256)}`);
  }

  const trimmed = stdout.trim();
  if (!trimmed) {
    fail('runFixture subprocess produced no stdout (envelope missing)');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    fail(
      `runFixture stdout is not valid JSON: ${(err as Error).message}; got: ${truncate(trimmed, 256)}`
    );
  }
  const parseResult = EvaluatorResultEnvelopeSchema.safeParse(parsed);
  if (!parseResult.success) {
    const issue = parseResult.error.issues[0];
    fail(
      `runFixture envelope failed schema validation: ${issue.path.join('.') || '<root>'}: ${issue.message}`
    );
  }
  return {
    envelope: parseResult.data,
    stdout,
    stderr,
    exitCode,
    durationMs: result.duration_ms,
  };
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n)}…[${s.length - n} more]`;
}
