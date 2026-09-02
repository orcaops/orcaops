import { AsyncLocalStorage } from 'node:async_hooks';

import type { SearchType } from '@orcaops/evaluator-protocol/search-types';

import { inputFile, withIdempotencyKey } from './agent-helpers.js';
import type {
  BlockAcknowledgeOk,
  BlockDismissOk,
  CaptureCheckpointOk,
  CapturePlanOk,
  CapturePrePrCheckOk,
  CaptureSummaryOk,
  CliResult,
  DigestOk,
  ErrorEnvelope,
  EvalListOk,
  InitOk,
  ListOk,
  OkEnvelope,
  ResumeOk,
  SearchOk,
  ShowOk,
  StatusOk,
  SyntheticEvaluatorFiresAt,
  UpdateOk,
  WhyOk,
} from './agent-types.js';

// Re-export so callers only need to import from this module.
export type {
  BlockAcknowledgeOk,
  BlockDismissOk,
  CaptureCheckpointOk,
  CapturePlanOk,
  CapturePrePrCheckOk,
  CaptureSummaryOk,
  DigestOk,
  EvalListOk,
  InitOk,
  ListOk,
  ResumeOk,
  SearchOk,
  ShowOk,
  StatusOk,
  SyntheticEvaluatorFiresAt,
  UpdateOk,
  WhyOk,
};

/**
 * Per-call capture state, threaded through AsyncLocalStorage so concurrent
 * calls on DIFFERENT agents don't share stdout/stderr buffers. (Same-agent
 * concurrency is also serialized by a per-agent mutex; the ALS scoping
 * makes inter-agent parallelism safe.)
 */
interface CallFrame {
  stdoutChunks: string[];
  stderrChunks: string[];
}

const captureAls = new AsyncLocalStorage<CallFrame>();

/**
 * Patches `process.stdout.write`, `process.stderr.write`, and
 * `process.exit` to route through `captureAls` when a call is in flight.
 * When no frame is active (e.g., outside InProcessAgent), the patches
 * fall through to the originals so other test code is unaffected.
 *
 * The `process.exit` patch is a **defense-in-depth fuse**: no CLI source
 * calls `process.exit` directly, and an ESLint rule keeps it that way.
 * But a rogue exit deeper in `node_modules` (effection, simple-git, ora,
 * etc.) would otherwise terminate the entire vitest worker mid-test —
 * the fuse catches it and surfaces a clear error instead.
 */
let patchesInstalled = false;
const origStdoutWrite = process.stdout.write.bind(process.stdout);
const origStderrWrite = process.stderr.write.bind(process.stderr);
const origExit = process.exit.bind(process);

function installPatches(): void {
  if (patchesInstalled) return;
  patchesInstalled = true;

  function makeCaptureWrite(
    orig: typeof origStdoutWrite,
    pickBuf: (f: CallFrame) => string[]
  ): typeof origStdoutWrite {
    return ((data: unknown, ...rest: unknown[]) => {
      const frame = captureAls.getStore();
      if (frame) {
        const text =
          typeof data === 'string' ? data : Buffer.from(data as Uint8Array).toString('utf8');
        pickBuf(frame).push(text);
        // Honor any trailing callback (Node signature variant) so writers
        // that supply one don't dangle.
        const cb = rest.find((arg) => typeof arg === 'function') as
          | ((err?: Error | null) => void)
          | undefined;
        if (cb) cb(null);
        return true;
      }
      // No frame → delegate to the real write.
      return (orig as (...a: unknown[]) => boolean)(data, ...rest);
    }) as typeof origStdoutWrite;
  }

  process.stdout.write = makeCaptureWrite(origStdoutWrite, (f) => f.stdoutChunks);
  process.stderr.write = makeCaptureWrite(origStderrWrite, (f) => f.stderrChunks);

  process.exit = ((code?: number) => {
    const frame = captureAls.getStore();
    if (frame) {
      const err = new Error(`InProcessAgent fuse: process.exit(${code ?? 0}) intercepted`);
      (err as Error & { name: string }).name = 'InProcessFuse';
      (err as unknown as { code: number }).code = code ?? 0;
      throw err;
    }
    return origExit(code);
  }) as typeof process.exit;
}

/**
 * Structural shape for the commander `Command` returned by the CLI's
 * `buildProgram`. Declared inline so this package doesn't take a
 * runtime dep on `commander`.
 */
export interface ProgramLike {
  parseAsync(
    args: readonly string[],
    opts?: { from?: 'node' | 'electron' | 'user' }
  ): Promise<unknown>;
}

export interface InProcessAgentOptions {
  /** Working directory for the simulated CLI invocation (the test's temp repo). */
  cwd: string;
  /** Env override merged onto `process.env` for this agent's calls. */
  env?: Record<string, string>;
  /** Per-call timeout in ms (default 30s). */
  timeoutMs?: number;
  /**
   * Factory returning a fresh commander `Command` per call. The CLI's
   * `buildProgram` from `apps/orcaops-cli/src/cli/program.js`. A fresh
   * program per call avoids state bleed across invocations.
   */
  buildProgram: () => ProgramLike;
  /**
   * The CLI's `runInInvocationContext` from
   * `apps/orcaops-cli/src/lib/invocation-context.js`. Threads cwd/env
   * into the CLI's ALS so deep reads (buildContext, pin helpers,
   * cloud-sync, LLM env) see the per-call values.
   */
  runInInvocationContext: <T>(
    ctx: { cwd?: string; env?: NodeJS.ProcessEnv },
    fn: () => T | Promise<T>
  ) => Promise<T>;
}

/**
 * In-process CLI agent. Runs the CLI via `buildProgram().parseAsync(...)`
 * inside a `runInInvocationContext` frame instead of spawning
 * `bin/orcaops.js`. Eliminates the ~389ms Node cold-start tax per call.
 *
 * Two concurrency-safety mechanisms work together:
 *   - **Per-agent mutex**: calls on the same agent instance serialize so
 *     they don't race on the local install/restore of capture buffers.
 *   - **Global ALS-based capture routing**: writes to `process.stdout`
 *     by the in-process CLI are routed to the originating call's buffer
 *     via `captureAls.getStore()`. Two DIFFERENT agents running
 *     concurrently each see their own frame and don't interfere.
 *
 * The stdin form (`--input -`) and explicit `stdin` payloads are refused —
 * those tests stay on the spawn-based smoke suite where real pipes exist.
 */
export class InProcessAgent {
  private readonly cwd: string;
  private readonly env: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly buildProgram: () => ProgramLike;
  private readonly runInInvocationContext: <T>(
    ctx: { cwd?: string; env?: NodeJS.ProcessEnv },
    fn: () => T | Promise<T>
  ) => Promise<T>;
  /** Per-agent serialization. Calls on the same instance queue. */
  private mutex: Promise<unknown> = Promise.resolve();

  constructor(opts: InProcessAgentOptions) {
    installPatches();
    this.cwd = opts.cwd;
    // ORCAOPS_NO_SPINNER=1 prevents ora ANSI escapes from contaminating
    // captured output in human-text mode.
    this.env = {
      ...(process.env as Record<string, string>),
      ORCAOPS_NO_SPINNER: '1',
      ...(opts.env ?? {}),
    };
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.buildProgram = opts.buildProgram;
    this.runInInvocationContext = opts.runInInvocationContext;
  }

  private withMutex<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.mutex.then(fn, fn);
    // Swallow rejection on the chained mutex so the next caller doesn't
    // inherit the prior error; the actual error reaches the caller via
    // `next`.
    this.mutex = next.catch(() => undefined);
    return next;
  }

  // ── Low-level entry points ─────────────────────────────────────────

  /**
   * Run the orcaops CLI with `args` in-process. Returns the raw result;
   * never throws on non-zero exit.
   */
  async runRaw(args: string[], opts: { stdin?: string } = {}): Promise<CliResult> {
    // `--input -` routes to stdin. In-process there is no real stdin to
    // read, so the stdin form would hang until the test timeout — reject it
    // up front with a clear message.
    const inputIdx = args.indexOf('--input');
    if (inputIdx >= 0 && args[inputIdx + 1] === '-') {
      throw new Error(
        'InProcessAgent: `--input -` (stdin) is not supported in-process. ' +
          'Pass a file via `--input <path>` (the `inputFile(payload)` helper writes one), ' +
          'or move this test to tests/smoke/.'
      );
    }
    if (opts.stdin !== undefined) {
      throw new Error(
        'InProcessAgent: stdin payload not supported in-process. ' +
          'Pass a file via `--input <path>` (the `inputFile(payload)` helper writes one).'
      );
    }

    return this.withMutex(async () => {
      const frame: CallFrame = { stdoutChunks: [], stderrChunks: [] };
      let exitCode = 0;

      let timer: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(
              `InProcessAgent: command timed out after ${this.timeoutMs}ms — orcaops ${args.join(' ')}`
            )
          );
        }, this.timeoutMs);
      });

      const runPromise = (async () => {
        await new Promise<void>((resolve, reject) => {
          captureAls.run(frame, () => {
            this.runInInvocationContext({ cwd: this.cwd, env: this.env }, async () => {
              try {
                await this.buildProgram().parseAsync(args, { from: 'user' });
              } catch (err) {
                if (err instanceof Error) {
                  if (err.name === 'CliExit') {
                    const code = (err as Error & { code?: number }).code;
                    exitCode = typeof code === 'number' ? code : 1;
                    return;
                  }
                  if (err.name === 'CommanderError') {
                    const code = (err as Error & { exitCode?: number }).exitCode;
                    exitCode = typeof code === 'number' ? code : 1;
                    return;
                  }
                  if (err.name === 'InProcessFuse') {
                    const code = (err as Error & { code?: number }).code;
                    exitCode = typeof code === 'number' ? code : 1;
                    throw new Error(
                      `InProcessAgent fuse fired: process.exit(${exitCode}) was called from inside the CLI. ` +
                        `Likely a rogue exit in node_modules or an unrefactored source path. ` +
                        `Original args: orcaops ${args.join(' ')}`
                    );
                  }
                }
                throw err;
              }
            }).then(resolve, reject);
          });
        });
      })();

      try {
        await Promise.race([runPromise, timeoutPromise]);
      } finally {
        if (timer) clearTimeout(timer);
      }

      return {
        stdout: frame.stdoutChunks.join(''),
        stderr: frame.stderrChunks.join(''),
        exitCode,
      };
    });
  }

  /**
   * Run the orcaops CLI, parse stdout as a JSON envelope, return it.
   * Throws if exitCode !== 0 or `ok: false` unless `allowFailure: true`.
   */
  async run<T extends OkEnvelope = OkEnvelope>(
    args: string[],
    opts: { stdin?: string; allowFailure?: boolean } = {}
  ): Promise<T | ErrorEnvelope> {
    const result = await this.runRaw(args, { stdin: opts.stdin });
    let parsed: OkEnvelope | ErrorEnvelope;
    try {
      parsed = JSON.parse(result.stdout) as OkEnvelope | ErrorEnvelope;
    } catch {
      throw new InProcessAgentError(
        `InProcessAgent: failed to parse JSON from \`orcaops ${args.join(' ')}\`. ` +
          `exitCode=${result.exitCode}, stdout=${JSON.stringify(result.stdout.slice(0, 200))}, ` +
          `stderr=${JSON.stringify(result.stderr.slice(0, 200))}`,
        result
      );
    }
    if (!opts.allowFailure && (result.exitCode !== 0 || parsed.ok === false)) {
      const env = parsed.ok === false ? parsed : undefined;
      const detail = env
        ? `${env.error.code}: ${env.error.message}`
        : `exitCode=${result.exitCode}`;
      throw new InProcessAgentError(
        `InProcessAgent: \`orcaops ${args.join(' ')}\` failed — ${detail}`,
        result,
        env
      );
    }
    return parsed as T | ErrorEnvelope;
  }

  async expectError(args: string[], opts: { stdin?: string } = {}): Promise<ErrorEnvelope> {
    const parsed = await this.run(args, { stdin: opts.stdin, allowFailure: true });
    if (parsed.ok !== false) {
      throw new Error(
        `InProcessAgent.expectError: \`orcaops ${args.join(' ')}\` succeeded but failure was expected.`
      );
    }
    return parsed;
  }

  // ── init / update ──────────────────────────────────────────────────

  /**
   * Fresh init defaults to PERSONAL scope (nothing tracked), so a test that
   * asserts on committed install artifacts must ask for `scope: 'project'`
   * rather than relying on the default.
   */
  async init(
    opts: {
      force?: boolean;
      noLlm?: boolean;
      scope?: 'project' | 'global' | 'personal';
      agentsMd?: boolean;
    } = {}
  ): Promise<InitOk> {
    const args = ['init', '--json'];
    if (opts.scope) args.push('--scope', opts.scope);
    if (opts.force) args.push('--force');
    if (opts.noLlm) args.push('--no-llm');
    if (opts.agentsMd) args.push('--agents-md');
    return (await this.run<InitOk>(args)) as InitOk;
  }

  async update(opts: { force?: boolean } = {}): Promise<UpdateOk> {
    const args = ['update', '--json'];
    if (opts.force) args.push('--force');
    return (await this.run<UpdateOk>(args)) as UpdateOk;
  }

  // ── status / list / show ───────────────────────────────────────────

  async status(opts: { branch?: string } = {}): Promise<StatusOk> {
    const args = ['status', '--json'];
    if (opts.branch) args.push('--branch', opts.branch);
    return (await this.run<StatusOk>(args)) as StatusOk;
  }

  async list(opts: { branch?: string } = {}): Promise<ListOk> {
    const args = ['list', '--json'];
    if (opts.branch) args.push('--branch', opts.branch);
    return (await this.run<ListOk>(args)) as ListOk;
  }

  async show(artifactId: string): Promise<ShowOk> {
    return (await this.run<ShowOk>(['show', artifactId, '--json'])) as ShowOk;
  }

  // ── capture ────────────────────────────────────────────────────────

  async capturePlan(
    input: Record<string, unknown>,
    opts: { noLlm?: boolean } = {}
  ): Promise<CapturePlanOk> {
    const args = ['capture', 'plan'];
    if (opts.noLlm) args.push('--no-llm');
    args.push('--input', inputFile(JSON.stringify(withIdempotencyKey(input))));
    return (await this.run<CapturePlanOk>(args)) as CapturePlanOk;
  }

  /**
   * Convenience wrapper: derives a declared scope, opens, then closes
   * with the same body.
   */
  async captureCheckpoint(
    input: Record<string, unknown>,
    opts: { noLlm?: boolean } = {}
  ): Promise<CaptureCheckpointOk> {
    const inputWithKey = withIdempotencyKey(input);
    const closeKey = inputWithKey.idempotency_key as string;
    const completed = (inputWithKey.completed_step_ids as string[] | undefined) ?? [];

    let declared = completed;
    if (declared.length === 0) {
      const artifactId = String(inputWithKey.artifact_id);
      const show = (await this.run(['show', artifactId, '--json'])) as {
        ok: true;
        artifact?: { plan?: { plan_steps?: Array<{ step_id: string }> } };
      };
      const firstStepId = show.artifact?.plan?.plan_steps?.[0]?.step_id;
      if (firstStepId) declared = [firstStepId];
    }
    if (declared.length === 0) {
      throw new Error(
        'captureCheckpoint convenience wrapper: cannot derive declared_step_ids — ' +
          'pass `completed_step_ids` explicitly or use captureCheckpointOpen/Close directly.'
      );
    }

    const opened = await this.captureCheckpointOpen(
      {
        artifact_id: inputWithKey.artifact_id,
        declared_step_ids: declared,
        idempotency_key: `${closeKey}-open`,
      },
      opts
    );
    if (!opened.ok) {
      throw new Error(
        `captureCheckpoint convenience wrapper: open failed — ${opened.error.code}: ${opened.error.message}`
      );
    }

    // Thread the open's server-assigned `n` into close (spread first, set
    // `n` last so it wins over any caller-supplied `n`). The wrapper always
    // closes the checkpoint it just opened, so the open's `n` is the source
    // of truth. Without this, close falls back to the omitted-`n` "single
    // open cp" resolution, which only holds while exactly one cp is open and
    // hits AMBIGUOUS_CHECKPOINT the moment a second checkpoint overlaps.
    // Callers can pass verification: [] to exercise the real missing-evidence rejection path.
    const closeInput =
      completed.length > 0 && inputWithKey.verification === undefined
        ? {
            ...inputWithKey,
            verification: [{ command: 'test fixture', exit_code: 0 }],
          }
        : inputWithKey;
    return this.captureCheckpointClose({ ...closeInput, n: opened.n }, opts);
  }

  async captureCheckpointOpen(
    input: Record<string, unknown>,
    opts: { noLlm?: boolean } = {}
  ): Promise<
    ({ ok: true; artifact_id: string; n: number } & Record<string, unknown>) | ErrorEnvelope
  > {
    const args = ['capture', 'checkpoint', 'open'];
    if (opts.noLlm) args.push('--no-llm');
    args.push('--input', inputFile(JSON.stringify(withIdempotencyKey(input))));
    return (await this.run(args)) as
      | ({ ok: true; artifact_id: string; n: number } & Record<string, unknown>)
      | ErrorEnvelope;
  }

  async captureCheckpointClose(
    input: Record<string, unknown>,
    opts: { noLlm?: boolean } = {}
  ): Promise<CaptureCheckpointOk> {
    const args = ['capture', 'checkpoint', 'close'];
    if (opts.noLlm) args.push('--no-llm');
    args.push('--input', inputFile(JSON.stringify(withIdempotencyKey(input))));
    return (await this.run<CaptureCheckpointOk>(args)) as CaptureCheckpointOk;
  }

  async captureCheckpointAbandon(
    input: Record<string, unknown>
  ): Promise<
    ({ ok: true; artifact_id: string; n: number } & Record<string, unknown>) | ErrorEnvelope
  > {
    const args = ['capture', 'checkpoint', 'abandon'];
    args.push('--input', inputFile(JSON.stringify(withIdempotencyKey(input))));
    return (await this.run(args)) as
      | ({ ok: true; artifact_id: string; n: number } & Record<string, unknown>)
      | ErrorEnvelope;
  }

  async captureSummary(input: Record<string, unknown>): Promise<CaptureSummaryOk> {
    return (await this.run<CaptureSummaryOk>([
      'capture',
      'summary',
      '--input',
      inputFile(JSON.stringify(withIdempotencyKey(input))),
    ])) as CaptureSummaryOk;
  }

  async capturePrePrCheck(
    input: Record<string, unknown>,
    opts: { noLlm?: boolean } = {}
  ): Promise<CapturePrePrCheckOk> {
    const args = ['capture', 'pre-pr-check'];
    if (opts.noLlm) args.push('--no-llm');
    args.push('--input', inputFile(JSON.stringify(withIdempotencyKey(input))));
    return (await this.run<CapturePrePrCheckOk>(args)) as CapturePrePrCheckOk;
  }

  async blockAcknowledge(input: {
    artifact: string;
    evaluator: string;
    reason: string;
    idempotencyKey?: string;
  }): Promise<BlockAcknowledgeOk> {
    const args = [
      'block',
      'acknowledge',
      '--artifact',
      input.artifact,
      '--evaluator',
      input.evaluator,
      '--reason',
      input.reason,
    ];
    if (input.idempotencyKey) args.push('--idempotency-key', input.idempotencyKey);
    return (await this.run<BlockAcknowledgeOk>(args)) as BlockAcknowledgeOk;
  }

  async blockDismiss(input: {
    artifact: string;
    evaluator: string;
    reason: string;
    idempotencyKey?: string;
  }): Promise<BlockDismissOk> {
    const args = [
      'block',
      'dismiss',
      '--artifact',
      input.artifact,
      '--evaluator',
      input.evaluator,
      '--reason',
      input.reason,
    ];
    if (input.idempotencyKey) args.push('--idempotency-key', input.idempotencyKey);
    return (await this.run<BlockDismissOk>(args)) as BlockDismissOk;
  }

  // ── eval ───────────────────────────────────────────────────────────

  async evalList(): Promise<EvalListOk> {
    return (await this.run<EvalListOk>(['eval', 'list', '--json'])) as EvalListOk;
  }

  // ── digest / why / resume / search ────────────────────────────────

  async digest(opts: { artifact?: string; branch?: string; out?: string } = {}): Promise<DigestOk> {
    const args = ['digest', '--json'];
    if (opts.artifact) args.push('--artifact', opts.artifact);
    if (opts.branch) args.push('--branch', opts.branch);
    if (opts.out) args.push('--out', opts.out);
    return (await this.run<DigestOk>(args)) as DigestOk;
  }

  async why(target: string, opts: { all?: boolean; branch?: string } = {}): Promise<WhyOk> {
    const args = ['why', target, '--json'];
    if (opts.all) args.push('--all');
    if (opts.branch) args.push('--branch', opts.branch);
    return (await this.run<WhyOk>(args)) as WhyOk;
  }

  async resume(
    opts: {
      artifact?: string;
      branch?: string;
      copy?: boolean;
      acceptDefault?: boolean;
      noPin?: boolean;
    } = {}
  ): Promise<ResumeOk> {
    const args = ['resume', '--json'];
    if (opts.artifact) args.push('--artifact', opts.artifact);
    if (opts.branch) args.push('--branch', opts.branch);
    if (opts.copy) args.push('--copy');
    if (opts.acceptDefault) args.push('--accept-default');
    if (opts.noPin) args.push('--no-pin');
    return (await this.run<ResumeOk>(args, { allowFailure: true })) as ResumeOk;
  }

  async search(
    query: string,
    opts: {
      branch?: string;
      type?: SearchType;
      limit?: number;
    } = {}
  ): Promise<SearchOk> {
    const args = ['search', query, '--json'];
    if (opts.branch) args.push('--branch', opts.branch);
    if (opts.type) args.push('--type', opts.type);
    if (opts.limit !== undefined) args.push('--limit', String(opts.limit));
    return (await this.run<SearchOk>(args)) as SearchOk;
  }
}

/**
 * Thrown when an InProcessAgent method expected `ok: true` but got an
 * error envelope (or a non-zero exit code, or unparseable stdout). The
 * full raw result is attached for inspection.
 */
export class InProcessAgentError extends Error {
  constructor(
    message: string,
    public readonly result: CliResult,
    public readonly envelope?: ErrorEnvelope
  ) {
    super(message);
    this.name = 'InProcessAgentError';
  }
}

/**
 * Test-only escape hatch: forcibly restore the original
 * `process.stdout.write` / `process.stderr.write` / `process.exit`.
 * Vitest's `afterAll` hooks can call this when a test file is the LAST
 * consumer in a worker. Production callers MUST NOT use this — the
 * fall-through behavior makes restoration unnecessary in normal runs.
 */
export function __unsafeRestoreProcessPatches(): void {
  if (!patchesInstalled) return;
  process.stdout.write = origStdoutWrite;
  process.stderr.write = origStderrWrite;
  process.exit = origExit;
  patchesInstalled = false;
}
