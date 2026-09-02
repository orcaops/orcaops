import type { Writable } from 'node:stream';

/**
 * Sentinel thrown by command actions and `emitError` to request a
 * specific CLI exit code without calling `process.exit` mid-stack.
 *
 * The top-level handler in `src/cli/index.ts` catches it and translates
 * it into the actual `process.exit(code)`. This indirection lets the
 * in-process test harness (`InProcessAgent`) observe the requested exit
 * code without the vitest worker actually exiting. The ESLint rule in
 * `apps/orcaops-cli/eslint.config.js` bans bare `process.exit` outside
 * `src/cli/index.ts` and this file to keep the invariant honest.
 */
export class CliExit extends Error {
  constructor(public readonly code: number) {
    super(`CliExit(${code})`);
    this.name = 'CliExit';
  }
}

/**
 * Treat a closed downstream reader as a successful end, not a crash.
 *
 * `orcaops … --json | head` closes the pipe once the reader has what it wants.
 * Node reports that as an `EPIPE` `'error'` event on the stream, and a stream
 * `'error'` with no listener is an uncaught exception — so a normal pipeline
 * ended in a stack trace. Agents pipe JSON into `head` constantly, so this is
 * a routine path. Any other stream error keeps its existing fate and is
 * rethrown.
 *
 * `exit` is injected so tests can observe the requested code without the
 * vitest worker exiting.
 */
export function installPipeErrorHandling(
  streams: readonly Writable[],
  exit: (code: number) => void
): void {
  for (const stream of streams) {
    stream.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') throw error;
      exit(0);
    });
  }
}

/**
 * How long to wait for buffered stdout/stderr to reach the reader before
 * exiting anyway. Bounded on purpose: a consumer that never reads (a paused
 * pipe, `| head -1`) must not turn into a hung CLI.
 */
const FLUSH_TIMEOUT_MS = 2000;

/**
 * Wait for stdout and stderr to drain before `process.exit`.
 *
 * `process.stdout.write` returns false once the pipe buffer is full — around
 * 64 KiB on Linux — and the rest sits in Node's internal queue. `process.exit`
 * does NOT flush that queue, so a large envelope followed by a non-zero exit
 * is silently truncated: `orcaops doctor --json` on a failing repo emits a
 * report far past that buffer and then exits 1, which is exactly the shape
 * that loses data when piped to a slow reader.
 *
 * Only the emit-then-exit paths need this. A command that returns normally is
 * already safe, because Node keeps the process alive for a pending write.
 */
export async function flushStdio(): Promise<void> {
  await Promise.all([flushWritable(process.stdout), flushWritable(process.stderr)]);
}

/**
 * Fence writes already accepted by a stream. `drain` is not sufficient here:
 * it is emitted only after a write returned false, while a smaller pending
 * write can leave `writableLength > 0` without ever arming that event.
 */
export function flushWritable(stream: Writable): Promise<void> {
  if (stream.writableLength === 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let settled = false;
    const done = (removeErrorListener: boolean): void => {
      if (settled) {
        if (removeErrorListener) stream.off('error', onError);
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (removeErrorListener) stream.off('error', onError);
      resolve();
    };
    const onError = (): void => done(false);
    stream.once('error', onError);
    // Keep this referenced: callers await the fence before process.exit, and
    // an unref'd timeout could let Node exit naturally with the wrong status.
    const timer = setTimeout(() => done(false), FLUSH_TIMEOUT_MS);
    try {
      // Writable callbacks run in queue order, so this empty write completes
      // only after the bytes already accepted by the stream.
      stream.write('', (error) => done(error == null));
    } catch {
      done(true);
    }
  });
}
