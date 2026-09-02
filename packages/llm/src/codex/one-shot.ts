import { action, type Operation } from 'effection';
import { execa } from 'execa';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { EvaluateError, EvaluateOptions, EvaluateResult } from '../types.js';
import { buildCodexArgs, buildCodexEnv } from './args.js';

const DEFAULT_TIMEOUT_MS = 30_000;

export interface OneShotConfig {
  binPath?: string;
  defaultModel?: string | null;
  defaultTimeoutMs?: number;
  /**
   * Env override for `ORCAOPS_CODEX_PATH` lookup. Defaults to
   * `process.env`. The CLI threads its invocation-context env here so
   * concurrent in-process tests can pin distinct binary paths per agent.
   */
  env?: NodeJS.ProcessEnv;
  /**
   * Parent directory for the per-call scratch dir (`--output-last-message`
   * file + optional output schema). Defaults to the OS tmpdir. Injectable so
   * tests OWN the scratch location and can assert its removal on every
   * settle path.
   */
  scratchParentDir?: string;
}

/**
 * One-shot Codex invocation. Captures the assistant body via Codex's
 * `--output-last-message <file>` so we never parse its JSONL event stream.
 *
 * Codex doesn't expose `--max-budget-usd`, `--effort`, `--system-prompt`,
 * or `--disallowed-tools`. The orcaops Codex provider is correspondingly
 * narrower — those EvaluateOptions are silently ignored. The full support
 * matrix is on the `createCodexCliClient` doc-comment.
 */
export function evaluateOneShot(
  cfg: OneShotConfig,
  opts: EvaluateOptions
): Operation<EvaluateResult> {
  return runOneShot(cfg, opts);
}

function* runOneShot(cfg: OneShotConfig, opts: EvaluateOptions): Operation<EvaluateResult> {
  const binPath = cfg.binPath ?? (cfg.env ?? process.env).ORCAOPS_CODEX_PATH ?? 'codex';
  const sessionId = randomUUID();
  const model = opts.model !== undefined ? opts.model : (cfg.defaultModel ?? null);
  const timeoutMs = opts.timeoutMs ?? cfg.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;

  return yield* action<EvaluateResult>(function (resolve) {
    const startTime = Date.now();
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let scratchDir: string | null = null;
    let outputFile: string | null = null;
    // Hoisted out of the async closure so the abort handler and the
    // scope cleanup can both reach the proc reference once it exists.
    let activeProc: ReturnType<typeof execa> | null = null;
    // Kill the process GROUP, not just the immediate child: `binPath` may be
    // a shell script (and codex itself spawns children), and Linux `sh`
    // (dash) does not exec its tail command — SIGTERM to the shell alone
    // orphans the child, which keeps the inherited stdio pipes open and
    // delays `close` (and settlement) until the orphan exits. The spawn is
    // detached so the child owns its group and `kill(-pid)` reaches the
    // whole tree; the direct kill is the fallback when the group is gone.
    const terminate = (proc: ReturnType<typeof execa>): void => {
      try {
        if (process.platform !== 'win32' && proc.pid !== undefined) {
          process.kill(-proc.pid, 'SIGTERM');
        } else {
          proc.kill('SIGTERM');
        }
      } catch {
        try {
          proc.kill('SIGTERM');
        } catch {
          /* may have already exited */
        }
      }
    };
    // Hoisted for the same reason: the watch interval must be clearable from
    // EVERY settle path and from the Effection teardown — a child that never
    // emits error/close (SIGTERM ignored) must not leave it polling forever.
    let watchTimeout: ReturnType<typeof setInterval> | null = null;

    const finish = (body: string, errorOverride?: EvaluateError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (watchTimeout !== null) clearInterval(watchTimeout);
      opts.signal?.removeEventListener('abort', onAbort);
      const durationMs = Date.now() - startTime;
      // Best-effort cleanup; don't await (fire-and-forget).
      if (scratchDir) {
        rm(scratchDir, { recursive: true, force: true }).catch(() => undefined);
      }
      if (errorOverride) {
        resolve({
          body: body || `ERROR\n\n${errorOverride.message}`,
          model,
          sessionId,
          durationMs,
          error: errorOverride,
        });
        return;
      }
      resolve({
        body,
        model,
        sessionId,
        durationMs,
      });
    };

    // Pre-aborted: short-circuit before any subprocess setup.
    if (opts.signal?.aborted) {
      resolve({
        body: 'ERROR\n\nCancelled',
        model,
        sessionId,
        durationMs: 0,
        error: { code: 'CANCELLED', message: 'Signal aborted before LLM call started' },
      });
      return () => {};
    }

    const timer = setTimeout(() => {
      timedOut = true;
    }, timeoutMs);

    // Per-call abort: kills the proc once it exists. Set the flag
    // regardless so a fast abort (before activeProc is set) still
    // signals the spawn-then-kill path below via the early check.
    const onAbort = (): void => {
      cancelled = true;
      if (activeProc && !activeProc.killed) {
        terminate(activeProc);
      }
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    // Async setup: create temp dir, optional schema file, spawn process.
    // The Effection teardown can run WHILE this closure is suspended in an
    // await (settled flips true with activeProc/watchTimeout still null), so
    // every await is followed by a bail check — otherwise a late spawn would
    // create a child, an interval, and a scratch dir that nothing cleans.
    void (async () => {
      const bailIfSettled = (): boolean => {
        if (!settled) return false;
        if (scratchDir) {
          rm(scratchDir, { recursive: true, force: true }).catch(() => undefined);
        }
        return true;
      };
      try {
        scratchDir = await mkdtemp(path.join(cfg.scratchParentDir ?? tmpdir(), 'orcaops-codex-'));
        outputFile = path.join(scratchDir, 'last-message.txt');
        if (bailIfSettled()) return;

        let outputSchemaFile: string | undefined;
        if (opts.outputSchema) {
          outputSchemaFile = path.join(scratchDir, 'output-schema.json');
          await writeFile(outputSchemaFile, JSON.stringify(opts.outputSchema), 'utf8');
          if (bailIfSettled()) return;
        }

        // Forward the declared policy so buildCodexArgs can refuse one it
        // cannot enforce. Dropped here, a restricted evaluator runs with
        // unrestricted reads under a policy the caller believes is in force.
        const args = buildCodexArgs({
          model,
          outputLastMessageFile: outputFile,
          outputSchemaFile,
          ...(opts.toolPolicy !== undefined ? { toolPolicy: opts.toolPolicy } : {}),
        });

        const proc = execa(binPath, args, {
          cwd: opts.cwd ?? process.cwd(),
          env: buildCodexEnv(),
          reject: false,
          // Own process group so terminate() can kill the whole tree (POSIX).
          detached: process.platform !== 'win32',
        });
        activeProc = proc;

        // Torn down between the last await and the spawn: kill the child we
        // just created and clean up — no handler below will ever settle us.
        if (settled) {
          terminate(proc);
          bailIfSettled();
          return;
        }

        // Cancellation arrived during async setup, before the proc was
        // assigned — onAbort couldn't reach it. Kill now and let the
        // close handler emit CANCELLED.
        if (cancelled && !proc.killed) {
          terminate(proc);
        }

        // Send prompt on stdin and close.
        if (proc.stdin) {
          proc.stdin.write(opts.prompt);
          proc.stdin.end();
        }

        // Pipe stdout/stderr to /dev/null effectively — we don't parse them.
        proc.stdout?.on('data', () => undefined);
        proc.stderr?.on('data', () => undefined);

        watchTimeout = setInterval(() => {
          if (timedOut && !proc.killed) {
            try {
              proc.kill('SIGTERM');
            } catch {
              /* may have already exited */
            }
          }
        }, 100);

        proc.on('error', (err: NodeJS.ErrnoException) => {
          if (watchTimeout !== null) clearInterval(watchTimeout);
          const code: EvaluateError['code'] =
            err.code === 'ENOENT' ? 'TOOL_NOT_FOUND' : 'TOOL_ERROR';
          finish('', { code, message: err.message });
        });

        proc.on('close', async (exitCode) => {
          if (watchTimeout !== null) clearInterval(watchTimeout);
          // Cancellation takes priority over timeout / non-zero exit so
          // a signal abort doesn't get reported as a TOOL_ERROR.
          if (cancelled) {
            finish('', {
              code: 'CANCELLED',
              message: 'LLM call aborted via signal',
            });
            return;
          }
          if (timedOut) {
            finish('', {
              code: 'TIMEOUT',
              message: `Codex timed out after ${timeoutMs}ms`,
            });
            return;
          }
          let body = '';
          if (outputFile) {
            try {
              body = (await readFile(outputFile, 'utf8')).trim();
            } catch {
              // file missing — codex didn't produce output
            }
          }
          if (!body) {
            finish('', {
              code: 'TOOL_ERROR',
              message: `codex exited with code ${exitCode ?? 'unknown'} and produced no output`,
            });
            return;
          }
          finish(body);
        });
      } catch (err) {
        // A setup failure racing the teardown must still clean the scratch:
        // finish() no-ops once settled, so run the bail cleanup first.
        if (bailIfSettled()) return;
        finish('', {
          code: 'TOOL_ERROR',
          message: `Failed to set up codex invocation: ${(err as Error).message}`,
        });
      }
    })();

    // Cleanup on scope teardown / cancellation.
    return () => {
      clearTimeout(timer);
      if (watchTimeout !== null) clearInterval(watchTimeout);
      opts.signal?.removeEventListener('abort', onAbort);
      if (activeProc && !activeProc.killed) {
        terminate(activeProc);
      }
      if (!settled) {
        settled = true;
        if (scratchDir) {
          rm(scratchDir, { recursive: true, force: true }).catch(() => undefined);
        }
        resolve({
          body: 'ERROR\n\nCancelled',
          model,
          sessionId,
          durationMs: Date.now() - startTime,
          error: { code: 'CANCELLED', message: 'Operation cancelled before completion' },
        });
      }
    };
  });
}
