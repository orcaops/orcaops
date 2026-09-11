// The warm Node data-sidecar. Runs the history Watch engine — and therefore
// better-sqlite3 — under Node, driving ticks off fs.watch pushes plus a slow
// heartbeat, and streams each WatchSnapshot to stdout as one NDJSON line. The
// Bun UI spawns this and parses the stream; this file never touches OpenTUI.
import { reviewRuntimeDescriptorFromModule, runReview } from '@orcaops/review-engine';

import { FsWatch } from './fs-watch.js';
import { HistoryWatchEngine } from './history-engine.js';
import { DEFAULT_THRESHOLDS } from './liveness.js';
import type { WatchSnapshot } from './types.js';

const HEARTBEAT_MS = 10_000;
const FAST_MS = 2_000;

async function main(): Promise<void> {
  // ORCAOPS_ROOT selects the checkout whose registration names the current
  // project; the data root itself resolves from the environment.
  const rootOverride = process.env.ORCAOPS_ROOT;
  const cwd = rootOverride !== undefined && rootOverride.length > 0 ? rootOverride : undefined;

  // One-shot review verbs: `sidecar.js review data --branch <b> [--json]`.
  // Assembles the review floor and exits before the streaming engine spins up.
  // Set exitCode and RETURN (never process.exit) — exit() truncates a still-
  // draining stdout at the pipe buffer, silently cutting payloads over ~64KB.
  const argv = process.argv.slice(2);
  if (argv[0] === 'review') {
    const runtime = await reviewRuntimeDescriptorFromModule(import.meta.url);
    process.exitCode = await runReview(argv, process.env, undefined, runtime);
    return;
  }

  const engine = new HistoryWatchEngine({
    scope: { cwd, env: process.env },
    thresholds: DEFAULT_THRESHOLDS,
  });

  // One-shot mode: the poll / --probe fallback spawns THIS sidecar with --once
  // (it resolves the app's own dist/sidecar.js rather than the interactive
  // orcaops-watch bin). Take a single snapshot, print it as one NDJSON line, and exit —
  // by RETURNING, never process.exit(): a snapshot over the ~64KB pipe buffer
  // would be silently truncated mid-drain, and this is the degraded-mode path
  // where that corruption would surface as an empty cockpit.
  if (process.argv.includes('--once')) {
    try {
      await engine.start();
      process.stdout.write(`${JSON.stringify(engine.snapshot)}\n`);
    } finally {
      await engine.close();
    }
    return;
  }

  const watcher: { fs?: FsWatch } = {};
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = (exitCode: number): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    watcher.fs?.close();
    void engine.close();
    process.stdin.pause();
    process.exitCode = exitCode;
  };
  const fail = (error: unknown): void => {
    if (stopped) return;
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
    );
    stop(1);
  };
  const requestTick = (): void => {
    if (stopped) return;
    void engine.tick().catch(fail);
  };

  const setPoll = (ms: number): void => {
    if (stopped) return;
    clearInterval(timer);
    timer = setInterval(requestTick, ms);
    timer.unref?.();
  };

  // The parent can stop us at the first snapshot, before engine.start() returns.
  // Release handles and drain stdout naturally so the snapshot is not truncated.
  const shutdown = (): void => stop(0);
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // If the Bun parent dies, our stdout pipe breaks — exit rather than orphan.
  process.stdout.on('error', () => {
    if (!stopped) process.exit(0);
  });
  process.stdin.on('end', shutdown);
  process.stdin.resume();

  engine.on('snapshot', (snapshot: WatchSnapshot) => {
    process.stdout.write(`${JSON.stringify(snapshot)}\n`);
    // Scope changes can replace the database and log files after any tick.
    watcher.fs?.refresh(engine.getWatchFiles());
  });

  try {
    await engine.start();
  } catch (error) {
    fail(error);
    return;
  }
  if (stopped) return;

  watcher.fs = new FsWatch({
    roots: engine.getWatchRoots(),
    files: engine.getWatchFiles(),
    onTick: requestTick,
    onDegrade: () => setPoll(FAST_MS),
  });
  setPoll(watcher.fs.start() ? HEARTBEAT_MS : FAST_MS);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  );
  process.exitCode = 1;
});
