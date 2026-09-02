import { spawn } from 'node:child_process';

import { cutTruncatedSecretTail } from './secrets.js';

/**
 * The one bounded-subprocess primitive, shared
 * by the evaluator runner's command engine and the evaluator SDK's fixture
 * harness so both get identical lifecycle guarantees.
 *
 * It lives in `@orcaops/evaluator-protocol` because that is the only package
 * both adopters already depend on, and it has no workspace dependencies of
 * its own — so nothing can import back into it and close a cycle. It is
 * exposed on the `./subprocess` subpath rather than the package barrel,
 * keeping `node:child_process` out of what pack runtimes import.
 *
 * Guarantees:
 *   - The overall timeout runs from SPAWN.
 *   - The SIGKILL escalation timer arms when SIGTERM is FIRST SENT — by
 *     timeout, cancellation, or output overflow alike — never at spawn. An
 *     escalation anchored to the timeout deadline gives a cancelled
 *     five-minute evaluator no escalation at all.
 *   - `hard_killed` reports a SIGKILL we actually delivered, not one we
 *     merely attempted.
 *   - When we terminate a process, the promise does not resolve until the
 *     process group has actually drained — the caller is never told the work
 *     stopped while a descendant of it is still running. Bounded by the grace
 *     plus a short post-SIGKILL confirmation; if that bound expires the
 *     result says so via `termination_confirmed: false` rather than
 *     presenting an unverified kill as a clean one.
 *   - Descendants die when WE terminate the process: on POSIX the child
 *     leads its own process group and signals go to the group; after the
 *     leader exits we wait for the group to drain and SIGKILL whatever is
 *     left at the end of the grace. A child that exits on its OWN is never
 *     swept — a runtime that deliberately daemonizes is not something we
 *     killed.
 *   - Settlement never waits for stream CLOSURE. A killed child whose
 *     grandchild inherited the pipes would otherwise keep the promise
 *     pending forever.
 *
 * Windows is best-effort: there is no process-group kill, so only the direct
 * child is signalled and descendants may survive. Job-object verification is
 * out of scope (see docs/evaluator-authoring.md).
 */

const IS_WINDOWS = process.platform === 'win32';

/** Grace between SIGTERM and SIGKILL, measured from the SIGTERM. */
const DEFAULT_KILL_GRACE_MS = 1000;

/**
 * How long after `exit` we allow the output streams to finish delivering
 * before settling anyway. `close` normally follows `exit` within a tick;
 * this bound only matters when a surviving descendant holds the pipes.
 */
const STREAM_DRAIN_GRACE_MS = 200;

/** How often to re-check whether a killed process group has drained. */
const GROUP_DRAIN_POLL_MS = 25;

/**
 * After the hard SIGKILL, how long to keep confirming the group actually
 * drained. SIGKILL is asynchronous and uncatchable: this covers teardown
 * latency without letting an unreapable process hang the caller.
 */
const KILL_CONFIRM_MS = 500;

export type SubprocessKillReason = 'timeout' | 'output-too-large' | 'canceled' | 'spawn-error';

/**
 * Does a failed `kill(pgid, 0)` probe prove the group is gone? ONLY ESRCH
 * does. EPERM in particular means the group exists but is not ours to
 * signal — treating it as gone would report a completed termination over
 * something still running.
 */
function probeErrorMeansGroupGone(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'ESRCH';
}

export interface BoundedSubprocessRequest {
  argv: readonly string[];
  cwd: string;
  env: Record<string, string>;
  /** Stdin contents (UTF-8). Omit to give the child no stdin. */
  stdin?: string;
  /** Hard timeout in milliseconds, measured from spawn. */
  timeoutMs: number;
  /** Output cap in BYTES, applied to stdout and stderr independently. */
  maxOutputBytes: number;
  /** Cancellation. SIGTERM fires immediately on abort, then escalates. */
  signal?: AbortSignal;
  /**
   * Override the SIGTERM→SIGKILL grace. Exists for tests, which need it in
   * BOTH directions: a grace far shorter than the timeout to observe that
   * escalation is anchored to the SIGTERM rather than to spawn, and a grace
   * long enough to outlast the run to observe that the sweep survives
   * settlement. Every production caller takes the default.
   */
  killGraceMs?: number;
}

export interface BoundedSubprocessResult {
  exit_code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  duration_ms: number;
  /**
   * Why the helper killed the process, or `null` when it exited on its own
   * (with any exit code). First reason wins: an overflow kill that later
   * crosses the timeout still reports `output-too-large`.
   */
  killed_reason: SubprocessKillReason | null;
  spawn_error: { code?: string; message: string } | null;
  /**
   * True when a SIGKILL was actually delivered — either to a leader that
   * outlasted its grace, or to descendants still alive at the end of it.
   */
  hard_killed: boolean;
  /**
   * Whether everything WE tried to terminate was observed to stop before
   * this result was produced. A process that exited on its own is trivially
   * true — nothing was terminated, and by policy a descendant it
   * deliberately left running is not our business, so this does not claim
   * the group is empty. For a kill it means the group was observed to
   * drain. FALSE only when the bounded wait expired with the group still
   * listed; combined with `hard_killed: false` that means the SIGKILL could
   * not even be delivered and something may still be running.
   */
  termination_confirmed: boolean;
}

/**
 * Accumulate raw stream chunks up to `maxBytes` (byte-counted, not UTF-16
 * code units). `push` returns true exactly once, on the chunk that crosses
 * the cap. `text()` decodes the retained bytes; when the cap cut the final
 * chunk it trims backward over UTF-8 continuation bytes so a split multibyte
 * sequence is dropped instead of decoding to a replacement character.
 *
 * When the cap DID cut, the decoded text also has any secret fragment the cut
 * severed removed. Containment belongs here rather than in each consumer:
 * this is the only place that knows a cut happened, and consumers that redact
 * afterwards are matching patterns against text the cut has already made
 * unmatchable.
 */
function boundedUtf8Collector(maxBytes: number): {
  push(chunk: Buffer): boolean;
  text(): string;
} {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let overflowed = false;
  return {
    push(chunk: Buffer): boolean {
      if (overflowed) return false;
      if (bytes + chunk.length > maxBytes) {
        chunks.push(chunk.subarray(0, maxBytes - bytes));
        bytes = maxBytes;
        overflowed = true;
        return true;
      }
      chunks.push(chunk);
      bytes += chunk.length;
      return false;
    },
    text(): string {
      const joined = Buffer.concat(chunks);
      if (!overflowed) return joined.toString('utf8');
      return cutTruncatedSecretTail(trimSplitUtf8Tail(joined).toString('utf8'));
    },
  };
}

/** Drop a trailing incomplete UTF-8 sequence produced by a byte-cap cut. */
function trimSplitUtf8Tail(buf: Buffer): Buffer {
  let i = buf.length - 1;
  let continuations = 0;
  while (i >= 0 && continuations < 3 && (buf[i]! & 0b1100_0000) === 0b1000_0000) {
    continuations++;
    i--;
  }
  if (i < 0) return buf;
  const lead = buf[i]!;
  const expected = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  if (lead >= 0xc0 && continuations + 1 < expected) {
    return buf.subarray(0, i);
  }
  return buf;
}

/**
 * Run a subprocess under the guarantees documented above. Always resolves —
 * never rejects — so callers map every outcome (success, non-zero exit,
 * timeout, overflow, cancellation, spawn failure) onto their own structure.
 */
export async function runBoundedSubprocess(
  req: BoundedSubprocessRequest
): Promise<BoundedSubprocessResult> {
  const startedAt = Date.now();
  const killGraceMs = req.killGraceMs ?? DEFAULT_KILL_GRACE_MS;

  return new Promise<BoundedSubprocessResult>((resolve) => {
    const stdoutCollector = boundedUtf8Collector(req.maxOutputBytes);
    const stderrCollector = boundedUtf8Collector(req.maxOutputBytes);
    let killedReason: SubprocessKillReason | null = null;
    let spawnError: BoundedSubprocessResult['spawn_error'] = null;
    let hardKilled = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | null = null;
    let drainTimer: NodeJS.Timeout | null = null;
    let pollTimer: NodeJS.Timeout | null = null;
    let killDeadlineMs = 0;
    let waitingForTermination = false;
    let lastExitCode: number | null = null;
    let lastExitSignal: NodeJS.Signals | null = null;
    let spawned = false;
    let pendingKillReason: SubprocessKillReason | null = null;
    // A process we never killed needs no confirmation; only the kill paths
    // flip this to false and then earn it back.
    let terminationConfirmed = true;

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(req.argv[0]!, req.argv.slice(1), {
        cwd: req.cwd,
        env: req.env,
        stdio: [req.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        windowsHide: true,
        // POSIX: the child leads its own process group, so a signal to -pid
        // reaches every descendant. Windows has no equivalent here.
        detached: !IS_WINDOWS,
      });
    } catch (err) {
      const spawnFailure = err as NodeJS.ErrnoException;
      resolve({
        exit_code: null,
        signal: null,
        stdout: '',
        stderr: '',
        duration_ms: Date.now() - startedAt,
        killed_reason: 'spawn-error',
        spawn_error: {
          ...(spawnFailure.code !== undefined ? { code: spawnFailure.code } : {}),
          message: err instanceof Error ? err.message : String(err),
        },
        hard_killed: false,
        termination_confirmed: true,
      });
      return;
    }
    /**
     * Signal the child's whole process group on POSIX, falling back to the
     * direct child if the group is already gone (or on Windows, which has
     * no group semantics). Returns whether a signal was actually delivered,
     * so callers do not report a kill they did not manage to perform.
     *
     * RESIDUAL — pid reuse. A pgid is only pinned while its group is
     * non-empty. Once the original group drains, the id can be recycled, and
     * neither signalling nor a liveness probe can tell a recycled group from
     * ours: `kill(2)` offers no identity. Waiting on group liveness does NOT
     * reduce this to a syscall gap — a group that drains between two probes
     * can be replaced by an unrelated one that the next probe then observes.
     * Closing it needs process handles (pidfd / kqueue EVFILT_PROC), which
     * are platform-specific and out of scope here; it is recorded as a named
     * residual instead of papered over.
     */
    const signalTree = (sig: NodeJS.Signals): boolean => {
      const pid = child.pid;
      if (!IS_WINDOWS && pid !== undefined) {
        try {
          process.kill(-pid, sig);
          return true;
        } catch {
          // Group already reaped, or we lost the race with exit.
        }
      }
      try {
        return child.kill(sig);
      } catch {
        return false;
      }
    };

    /**
     * Is the child's process group empty? Only ESRCH proves that. Any other
     * failure — EPERM above all, meaning the group exists but we may not
     * signal it — must NOT read as "gone", or we would report a completed
     * termination over a group that is still running.
     */
    const groupIsEmpty = (): boolean => {
      const pid = child.pid;
      if (pid === undefined) return true;
      if (IS_WINDOWS) {
        // No process groups here, so the only lifecycle we can observe is the
        // direct child's. Returning a flat `true` would report a live child as
        // terminated and skip its SIGKILL entirely — best-effort must still
        // mean fail-closed about the one process we CAN see.
        return child.exitCode !== null || child.signalCode !== null;
      }
      try {
        process.kill(-pid, 0);
        return false;
      } catch (err) {
        return probeErrorMeansGroupGone(err);
      }
    };

    const settle = (exit_code: number | null, sig: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      if (killTimer !== null) clearTimeout(killTimer);
      if (drainTimer !== null) clearTimeout(drainTimer);
      if (pollTimer !== null) clearTimeout(pollTimer);
      if (abortHandler) req.signal?.removeEventListener('abort', abortHandler);
      // Stop reading; a descendant holding the pipes must not keep this
      // process's event loop (or this promise) alive.
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({
        exit_code,
        signal: sig,
        stdout: stdoutCollector.text(),
        stderr: stderrCollector.text(),
        duration_ms: Date.now() - startedAt,
        killed_reason: killedReason,
        spawn_error: spawnError,
        hard_killed: hardKilled,
        termination_confirmed: terminationConfirmed,
      });
    };

    /**
     * The bounded wait for termination to actually complete. Entered from
     * EITHER side, which is the point: from the leader's exit (the common
     * case), or from the escalation timer when the leader is still alive.
     * If only the exit path could start it, a leader that survived both
     * SIGTERM and SIGKILL — delivery failing outright — would never fire an
     * exit event and the promise would hang forever, which is a worse
     * failure than the one this whole mechanism exists to prevent.
     *
     * Retries delivery on every poll, settles as soon as the group drains,
     * and is bounded whether or not any signal ever lands.
     */
    const awaitTermination = (): void => {
      if (settled || waitingForTermination) return;
      waitingForTermination = true;
      terminationConfirmed = false;
      if (killTimer !== null) {
        clearTimeout(killTimer);
        killTimer = null;
      }
      let confirmDeadlineMs = 0;
      const poll = (): void => {
        if (settled) return;
        if (groupIsEmpty()) {
          terminationConfirmed = true;
          settle(lastExitCode, lastExitSignal);
          return;
        }
        if (Date.now() >= killDeadlineMs && confirmDeadlineMs === 0) {
          // Retry delivery on every poll until it lands. A SIGKILL we failed
          // to deliver (EPERM on a group that dropped privileges) stops
          // nothing, so the confirmation window must not start until the
          // signal is actually on its way — otherwise "we waited 500ms"
          // would stand in for "we killed it".
          if (signalTree('SIGKILL')) {
            hardKilled = true;
            // SIGKILL is asynchronous: the group is not gone when the syscall
            // returns, so keep polling for the drain rather than settling on
            // the signal alone.
            confirmDeadlineMs = Date.now() + KILL_CONFIRM_MS;
          }
        }
        const hardDeadlineMs =
          confirmDeadlineMs !== 0 ? confirmDeadlineMs : killDeadlineMs + KILL_CONFIRM_MS;
        if (Date.now() >= hardDeadlineMs) {
          // Bounded either way, so nothing we cannot reap can hang the caller.
          // terminationConfirmed stays FALSE, and deliberately says nothing
          // more than "not observed to stop": `hard_killed` may be true
          // because only the direct-child fallback landed after the GROUP
          // signal failed, in which case descendants may still be executing
          // rather than tearing down. The caller is told that rather than
          // shown a clean result.
          settle(lastExitCode, lastExitSignal);
          return;
        }
        pollTimer = setTimeout(poll, GROUP_DRAIN_POLL_MS);
      };
      poll();
    };

    /**
     * The leader is gone. A child that exited on its OWN is not our
     * business: settle at once and leave anything it deliberately spawned
     * alone. When a kill is in flight, hand off to the bounded wait — the
     * caller acts on resolution (the runner deletes the context directory
     * and reports TIMEOUT), so it must not hear that the work stopped while
     * a descendant of a process we killed is still running.
     */
    const finalize = (exit_code: number | null, sig: NodeJS.Signals | null): void => {
      if (settled) return;
      lastExitCode = exit_code;
      lastExitSignal = sig;
      if (killedReason === null || killedReason === 'spawn-error') {
        settle(exit_code, sig);
        return;
      }
      awaitTermination();
    };

    /**
     * Send SIGTERM and set the hard-kill deadline FROM THIS MOMENT. Re-entry
     * (e.g. overflow then timeout) keeps the first reason and the first
     * deadline rather than pushing the escalation further out.
     */
    const escalate = (reason: SubprocessKillReason): void => {
      if (settled) return;
      const first = killedReason === null;
      if (first) killedReason = reason;
      signalTree('SIGTERM');
      if (first) {
        killDeadlineMs = Date.now() + killGraceMs;
        killTimer = setTimeout(() => {
          killTimer = null;
          // The leader outlasted its grace. Enter the bounded wait rather
          // than firing a single signal and hoping: if delivery fails there
          // is no exit event coming to rescue us.
          awaitTermination();
        }, killGraceMs);
      }
    };

    const requestEscalation = (reason: SubprocessKillReason): void => {
      if (spawned) {
        escalate(reason);
      } else if (pendingKillReason === null) {
        pendingKillReason = reason;
      }
    };

    child.once('spawn', () => {
      spawned = true;
      if (pendingKillReason !== null) {
        const reason = pendingKillReason;
        pendingKillReason = null;
        escalate(reason);
      }
    });

    const timeoutHandle = setTimeout(() => requestEscalation('timeout'), req.timeoutMs);

    const abortHandler = req.signal ? () => requestEscalation('canceled') : null;
    if (req.signal && abortHandler) {
      if (req.signal.aborted) {
        requestEscalation('canceled');
      } else {
        req.signal.addEventListener('abort', abortHandler, { once: true });
      }
    }

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (settled || spawned) return;
      spawnError = { code: err.code, message: err.message };
      killedReason = 'spawn-error';
      finalize(null, null);
    });

    // Raw Buffer chunks so the cap counts BYTES: with utf8-decoded strings,
    // `length` counts UTF-16 code units and multibyte output under-counts.
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdoutCollector.push(chunk)) requestEscalation('output-too-large');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrCollector.push(chunk)) requestEscalation('output-too-large');
    });

    // `close` (all stdio closed) is preferred because it means output is
    // complete — but it must NEVER be the only way out: an inheriting
    // descendant keeps the pipes open indefinitely. `exit` starts a short
    // drain window, after which we settle with what we have.
    child.on('close', (code, sig) => finalize(code, sig));
    child.on('exit', (code, sig) => {
      if (settled || drainTimer !== null) return;
      drainTimer = setTimeout(() => finalize(code, sig), STREAM_DRAIN_GRACE_MS);
      drainTimer.unref?.();
    });

    if (req.stdin !== undefined && child.stdin) {
      // Ignore EPIPE for children that never read stdin.
      child.stdin.on('error', () => undefined);
      child.stdin.end(req.stdin);
    }
  });
}
