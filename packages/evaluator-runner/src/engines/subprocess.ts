import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  type BoundedSubprocessResult,
  runBoundedSubprocess,
  type SubprocessKillReason,
} from '@orcaops/evaluator-protocol/subprocess';

/**
 * One shared subprocess helper consumed by the command engine. Owns:
 *   - argv + cwd + env policy (allowlist inherit + explicit set)
 *   - stdin JSON delivery + temp-file fallback via `ORCAOPS_CONTEXT_PATH`
 *   - lifecycle (timeout, escalation, process-group kill, settlement),
 *     delegated to the shared `runBoundedSubprocess` primitive
 *   - max_output_bytes truncation that kills the process and surfaces
 *     OUTPUT_TOO_LARGE
 *   - stdout + stderr capture (both bounded by max_output_bytes)
 *   - CANCELED on parent abort via AbortSignal
 *
 * The helper never throws on a user-correctable failure — it returns
 * a `SubprocessResult` with a structured `killed_reason` so the
 * engine layer can map it to a structured EvaluatorRun error.
 */

export type { SubprocessKillReason };

export interface SubprocessRequest {
  argv: string[];
  cwd: string;
  /**
   * Final env passed to the child. Caller is responsible for
   * composing it via `buildSubprocessEnv` so the allowlist policy
   * + set + ORCAOPS_* contract are honored consistently.
   */
  env: Record<string, string>;
  /**
   * Stdin contents (UTF-8). The same string is ALSO written to a
   * temp file whose absolute path is exposed via the `contextPath`
   * env var if `attachContextPathEnv` is true.
   */
  stdin: string;
  /**
   * When true, write `stdin` to a temp file and expose the path via
   * `ORCAOPS_CONTEXT_PATH` + `ORCAOPS_INPUT_PATH` env vars (set by
   * the caller before invoking). The temp file is cleaned up after
   * the subprocess exits regardless of outcome.
   *
   * Default: true.
   */
  attachContextFile?: boolean;
  /** Hard timeout in milliseconds. */
  timeoutMs: number;
  /** Output cap in bytes (stdout + stderr counted separately). */
  maxOutputBytes: number;
  /** Optional cancellation signal. SIGTERM fires immediately on abort. */
  signal?: AbortSignal;
}

export interface SubprocessResult {
  exit_code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  duration_ms: number;
  /** Path to the context temp file that was created, or null when attachContextFile=false. */
  context_path: string | null;
  /**
   * When the process was killed by the helper (not by the parent
   * process or the OS), the reason. `null` when the process exited
   * naturally (with any exit code).
   */
  killed_reason: SubprocessKillReason | null;
  /**
   * False when the helper could not confirm that everything it tried to
   * terminate actually stopped. On POSIX that is the evaluator's whole
   * process group; on Windows only the evaluator itself, since descendants
   * there may survive by design. Surfaced in the run error so a reviewer is
   * never told an evaluator was terminated when it may still be running.
   */
  termination_confirmed: boolean;
  /**
   * Captured cause when `killed_reason === 'spawn-error'` (e.g.,
   * ENOENT on missing executable). Otherwise null.
   */
  spawn_error: { code?: string; message: string } | null;
}

/**
 * Run a single subprocess to completion. Always resolves — never
 * rejects — so callers can map every outcome (success, exit-code
 * failure, timeout, output overflow, cancellation, spawn error)
 * onto a structured EvaluatorRun.
 *
 * Lifecycle (timeout from spawn, SIGTERM→SIGKILL escalation armed at the
 * first SIGTERM, process-group kill, settlement that never waits for stream
 * closure) belongs to the shared primitive. What stays here is the runner's
 * own contract: the context temp file exposed via `ORCAOPS_CONTEXT_PATH`.
 */
export async function runSubprocess(req: SubprocessRequest): Promise<SubprocessResult> {
  const attachContext = req.attachContextFile !== false;

  let contextPath: string | null = null;
  let tempDir: string | null = null;
  if (attachContext) {
    tempDir = await mkdtemp(path.join(tmpdir(), 'orcaops-ctx-'));
    contextPath = path.join(tempDir, 'context.json');
    await writeFile(contextPath, req.stdin, 'utf8');
  }

  let bounded: BoundedSubprocessResult;
  try {
    bounded = await runBoundedSubprocess({
      argv: req.argv,
      cwd: req.cwd,
      env: req.env,
      stdin: req.stdin,
      timeoutMs: req.timeoutMs,
      maxOutputBytes: req.maxOutputBytes,
      ...(req.signal !== undefined ? { signal: req.signal } : {}),
    });
  } finally {
    // Best-effort cleanup of the temp dir.
    if (tempDir !== null) {
      void rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  return {
    exit_code: bounded.exit_code,
    signal: bounded.signal,
    stdout: bounded.stdout,
    stderr: bounded.stderr,
    duration_ms: bounded.duration_ms,
    context_path: contextPath,
    killed_reason: bounded.killed_reason,
    termination_confirmed: bounded.termination_confirmed,
    spawn_error: bounded.spawn_error,
  };
}

export interface BuildEnvOptions {
  /** Parent env to inherit from (defaults to process.env). */
  parentEnv?: NodeJS.ProcessEnv;
  /** Allowlist of variable names to inherit. */
  inherit: readonly string[];
  /** Explicit values that override / add to the inherited set. */
  set?: Readonly<Record<string, string>>;
  /** Orcaops contract vars (ORCAOPS_RUN_ID, ORCAOPS_PHASE, ...). */
  orcaopsVars: Readonly<Record<string, string>>;
}

/**
 * Compose the env for a subprocess. The
 * resulting env contains:
 *   1. Each key in `inherit` whose value is non-undefined in `parentEnv`.
 *   2. Every key in `set` (overrides inherited values).
 *   3. Every key in `orcaopsVars` (overrides BOTH of the above —
 *      the ORCAOPS_* contract wins so a pack author can't accidentally
 *      shadow it via `env.set`).
 *
 * Missing values in `parentEnv` are silently dropped — not an error
 * (e.g., HOME might be unset in a CI sandbox).
 */
export function buildSubprocessEnv(opts: BuildEnvOptions): Record<string, string> {
  const parent = opts.parentEnv ?? process.env;
  const env: Record<string, string> = {};
  for (const name of opts.inherit) {
    const value = parent[name];
    if (typeof value === 'string') env[name] = value;
  }
  if (opts.set) {
    for (const [k, v] of Object.entries(opts.set)) {
      env[k] = v;
    }
  }
  for (const [k, v] of Object.entries(opts.orcaopsVars)) {
    env[k] = v;
  }
  return env;
}
