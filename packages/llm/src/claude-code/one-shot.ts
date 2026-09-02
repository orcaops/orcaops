import { action, type Operation } from 'effection';
import { execa } from 'execa';
import { randomUUID } from 'node:crypto';

import type { EvaluateError, EvaluateOptions, EvaluateResult } from '../types.js';
import { buildClaudeArgs, buildClaudeEnv } from './args.js';
import {
  type ClaudeResultEvent,
  eventToEvaluateError,
  LineBuffer,
  parseClaudeStreamLine,
} from './stream-parser.js';

const DEFAULT_TIMEOUT_MS = 30_000;

export interface OneShotConfig {
  /** Path to the `claude` binary; defaults to PATH lookup. Override via env for tests. */
  binPath?: string;
  /** Per-call defaults applied when EvaluateOptions omits the value. */
  defaultModel?: string | null;
  defaultEffort?: import('../types.js').Effort;
  defaultMaxBudgetUsd?: number;
  defaultTimeoutMs?: number;
  /**
   * Env override for `ORCAOPS_CLAUDE_PATH` lookup. Defaults to
   * `process.env`. The CLI threads its invocation-context env here so
   * concurrent in-process tests can pin distinct binary paths per agent.
   */
  env?: NodeJS.ProcessEnv;
}

/**
 * Execute one Claude `--print` invocation and resolve to an EvaluateResult.
 * Never throws on user-correctable errors — failures are returned as
 * structured EvaluateResult.error envelopes with a synthesized body.
 */
export function evaluateOneShot(
  cfg: OneShotConfig,
  opts: EvaluateOptions
): Operation<EvaluateResult> {
  return runOneShot(cfg, opts);
}

function* runOneShot(cfg: OneShotConfig, opts: EvaluateOptions): Operation<EvaluateResult> {
  const binPath = cfg.binPath ?? (cfg.env ?? process.env).ORCAOPS_CLAUDE_PATH ?? 'claude';
  const sessionId = randomUUID();
  const model = opts.model !== undefined ? opts.model : (cfg.defaultModel ?? null);
  const effort = opts.effort ?? cfg.defaultEffort;
  const maxBudgetUsd = opts.maxBudgetUsd ?? cfg.defaultMaxBudgetUsd;
  const timeoutMs = opts.timeoutMs ?? cfg.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Command-filtered mode scopes Claude's Read grant to the spawn cwd, so pass the
  // SAME cwd buildClaudeArgs sees here as execa uses below (`opts.cwd ??
  // process.cwd()`) — otherwise the Read(<dir>/**) scope won't match the
  // real working dir and reads are denied.
  const readGrantRoot = opts.cwd ?? process.cwd();
  const args = buildClaudeArgs({
    sessionId,
    model,
    effort,
    systemPrompt: opts.systemPrompt,
    maxBudgetUsd,
    outputSchema: opts.outputSchema ?? null,
    readGrantRoot,
    ...(opts.toolPolicy !== undefined ? { toolPolicy: opts.toolPolicy } : {}),
  });

  return yield* action<EvaluateResult>(function (resolve) {
    const startTime = Date.now();
    const buffer = new LineBuffer();
    let resultEvent: ClaudeResultEvent | null = null;
    let timedOut = false;
    let cancelled = false;
    let settled = false;

    // Pre-aborted: short-circuit before spawning. Saves the syscall and
    // the EAGAIN window where the process is alive but won't receive
    // the SIGTERM before we settle.
    if (opts.signal?.aborted) {
      resolve({
        body: 'ERROR\n\nCancelled',
        model: null,
        sessionId,
        durationMs: 0,
        error: { code: 'CANCELLED', message: 'Signal aborted before LLM call started' },
      });
      return () => {};
    }

    const proc = execa(binPath, args, {
      cwd: opts.cwd ?? process.cwd(),
      env: buildClaudeEnv(),
      reject: false,
    });

    // Send prompt on stdin and close it so claude knows the input is done.
    if (proc.stdin) {
      proc.stdin.write(opts.prompt);
      proc.stdin.end();
    }

    const timer = setTimeout(() => {
      timedOut = true;
      if (!proc.killed) {
        try {
          proc.kill('SIGTERM');
        } catch {
          /* may already have exited */
        }
      }
    }, timeoutMs);

    // Honor the per-call abort signal. Sets a flag the close handler
    // reads so the resolved error is CANCELLED (not TOOL_ERROR from the
    // SIGTERM exit code). { once: true } so re-aborts don't double-fire.
    const onAbort = (): void => {
      cancelled = true;
      if (!proc.killed) {
        try {
          proc.kill('SIGTERM');
        } catch {
          /* may already have exited */
        }
      }
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (final: ClaudeResultEvent | null, errorOverride?: EvaluateError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      const durationMs = Date.now() - startTime;
      if (errorOverride) {
        resolve({
          body: `ERROR\n\n${errorOverride.message}`,
          model: final?.model ?? null,
          sessionId,
          durationMs,
          error: errorOverride,
        });
        return;
      }

      if (!final) {
        resolve({
          body: 'ERROR\n\nClaude exited without emitting a result event',
          model: null,
          sessionId,
          durationMs,
          error: { code: 'TOOL_ERROR', message: 'No result event received' },
        });
        return;
      }

      const errorEnvelope = eventToEvaluateError(final);
      resolve({
        body: final.body || (errorEnvelope ? `ERROR\n\n${errorEnvelope.message}` : ''),
        model: final.model ?? null,
        sessionId,
        durationMs,
        ...(final.tokens ? { tokens: final.tokens } : {}),
        ...(final.cumulativeCostUsd !== undefined ? { costUsd: final.cumulativeCostUsd } : {}),
        ...(errorEnvelope ? { error: errorEnvelope } : {}),
      });
    };

    proc.stdout?.on('data', (data: Buffer) => {
      for (const line of buffer.push(data)) {
        const event = parseClaudeStreamLine(line);
        if (event) resultEvent = event;
      }
    });

    proc.on('close', (code) => {
      const remainder = buffer.flush();
      if (remainder.trim()) {
        const event = parseClaudeStreamLine(remainder);
        if (event) resultEvent = event;
      }

      // Cancellation takes priority over timeout / result event so a
      // signal abort that races with a timeout still surfaces as
      // CANCELLED (the more specific failure mode).
      if (cancelled) {
        finish(null, {
          code: 'CANCELLED',
          message: 'LLM call aborted via signal',
        });
        return;
      }
      if (timedOut) {
        finish(null, {
          code: 'TIMEOUT',
          message: `Claude timed out after ${timeoutMs}ms`,
        });
        return;
      }
      if (resultEvent) {
        finish(resultEvent);
        return;
      }
      finish(null, {
        code: 'TOOL_ERROR',
        message: `claude exited with code ${code ?? 'unknown'}`,
      });
    });

    proc.on('error', (err: NodeJS.ErrnoException) => {
      const code: EvaluateError['code'] = err.code === 'ENOENT' ? 'TOOL_NOT_FOUND' : 'TOOL_ERROR';
      finish(null, { code, message: err.message });
    });

    // Cleanup on scope teardown / cancellation (separate from signal
    // abort — Effection may tear down the scope without aborting our
    // signal, e.g. on a parent error).
    return () => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      if (!proc.killed) {
        try {
          proc.kill('SIGTERM');
        } catch {
          /* already exited */
        }
      }
      if (!settled) {
        settled = true;
        resolve({
          body: 'ERROR\n\nCancelled',
          model: null,
          sessionId,
          durationMs: Date.now() - startTime,
          error: { code: 'CANCELLED', message: 'Operation cancelled before completion' },
        });
      }
    };
  });
}
